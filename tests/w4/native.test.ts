import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InspectionRpc } from '../../src/native-rpc.js';
import { inspectNative, parseNativeArgs } from '../../src/native-inspection.js';
import { hash } from '../../src/snapshot.js';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../../src/native-cli.js', import.meta.url));
async function root(t: test.TestContext) { const path = await mkdtemp(join(tmpdir(), 'tongxu-native-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function rpcFixture(t: test.TestContext, handler: string, limits = { timeoutMs: 500, maxBytes: 16_384 }) {
  const dir = await root(t), paths = { stdin: join(dir, 'stdin'), stdout: join(dir, 'stdout'), stderr: join(dir, 'stderr') };
  for (const path of Object.values(paths)) await writeFile(path, '', { mode: 0o600 });
  const code = `const readline=require('node:readline');let saved=[];const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);${handler}});`;
  const child = spawn(process.execPath, ['-e', code], { env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new InspectionRpc(child, paths, limits); t.after(() => rpc.close()); return { rpc, paths };
}

test('native requests bind exact IDs across fragmented, out-of-order replies and persist before send', async t => {
  const f = await rpcFixture(t, `saved.push(m);if(saved.length===2){send({id:2,result:{name:'second'}});const line=JSON.stringify({id:1,result:{name:'first'}})+'\\n';process.stdout.write(line.slice(0,5));setTimeout(()=>process.stdout.write(line.slice(5)),20);}`);
  let registered = false;
  const a = f.rpc.request('initialize', {}, async id => { const lines = (await readFile(f.paths.stdin, 'utf8')).trim().split('\n').filter(Boolean).map(v => JSON.parse(v)); assert.equal(lines.some(m => m.id === id), false); registered = true; });
  const b = f.rpc.request('thread/read', {});
  const [first, second] = await Promise.all([a, b]); assert.equal(registered, true); assert.equal(first.result.name, 'first'); assert.equal(second.result.name, 'second');
  assert.equal(f.rpc.gaps.length, 0);
  const before = await readFile(f.paths.stdin); await assert.rejects(f.rpc.request('turn/start', {}), /native_method_not_registered/); assert.deepEqual(await readFile(f.paths.stdin), before);
});

for (const [name, handler, gap] of [
  ['wrong ID', `send({id:m.id+1,result:{}});`, 'unexpected_native_response_id'],
  ['wrong ID type', `send({id:String(m.id),result:{}});`, 'unexpected_native_response_id'],
  ['malformed JSON', `process.stdout.write('bad-json\\n');`, 'invalid_native_json'],
  ['ambiguous reply', `send({id:m.id,result:{},error:{code:1,message:'both'}});`, 'invalid_native_response'],
  ['disconnect', `process.exit(0);`, 'native_process_closed'],
  ['timeout', `void m;`, 'native_request_timeout'],
  ['output cap', `process.stdout.write('x'.repeat(32_768));`, 'native_output_limit']
] as const) test(`native ${name} preserves bounded evidence and cannot satisfy a new request`, async t => {
  const f = await rpcFixture(t, handler, { timeoutMs: 150, maxBytes: 1024 });
  await assert.rejects(f.rpc.request('initialize', {}), new RegExp(gap));
  await assert.rejects(f.rpc.request('thread/read', {}), new RegExp(gap));
  assert.ok(f.rpc.gaps.includes(gap)); assert.ok((await lstat(f.paths.stdout)).size + (await lstat(f.paths.stderr)).size <= 1024);
});

test('native tool/approval requests are explicitly denied without running supplied commands', async t => {
  const f = await rpcFixture(t, `if(m.method==='initialize'){saved.push(m);send({id:'approval',method:'item/commandExecution/requestApproval',params:{command:'DO_NOT_EXECUTE'}});}else if(m.id==='approval'){if(m.error?.code!==-32601)process.exit(2);send({id:saved[0].id,result:{userAgent:'fixture'}});}`);
  assert.equal((await f.rpc.request('initialize', {})).result.userAgent, 'fixture');
  assert.ok(f.rpc.gaps.includes('unexpected_native_request_denied'));
  const sent = (await readFile(f.paths.stdin, 'utf8')).trim().split('\n').map(v => JSON.parse(v)); assert.equal(sent[1].error.code, -32601); assert.equal(sent[1].result, undefined);
});

test('duplicate late responses fail the channel instead of becoming the next result', async t => {
  const f = await rpcFixture(t, `send({id:m.id,result:{}});send({id:m.id,result:{}});`);
  await f.rpc.request('initialize', {}); await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(f.rpc.request('thread/read', {}), /unexpected_native_response_id/);
});

test('closing preserves incomplete trailing protocol frames and nonzero native exit as gaps', async t => {
  const f = await rpcFixture(t, `send({id:m.id,result:{}});process.stdout.write('{"id":');process.stdin.on('end',()=>process.exit(42));`);
  await f.rpc.request('initialize', {}); await f.rpc.close();
  assert.ok(f.rpc.gaps.includes('incomplete_native_frame')); assert.ok(f.rpc.gaps.includes('native_nonzero_exit'));
  assert.ok((await readFile(f.paths.stdout, 'utf8')).endsWith('{"id":'));
});

async function nativeFixture(dir: string, mode = 'complete', port = 1) {
  const executable = join(dir, `native-${mode}`), canary = join(dir, 'private-host-canary'); await writeFile(canary, 'fake-test-secret', { mode: 0o600 });
  const code = `#!/usr/bin/python3
import sys,json,os,socket,time
if sys.argv[1:]==['--version']:
 print('codex-cli 0.0.0-fixture',flush=True)
 if ${JSON.stringify(mode)}=='version-stall':
  print('version-original-stderr',file=sys.stderr,flush=True);time.sleep(60)
 if ${JSON.stringify(mode)}=='version-flood':print('x'*200000,flush=True)
 sys.exit(23 if ${JSON.stringify(mode)}=='version-exit' else 0)
assert sys.argv[1:]==['app-server','--listen','stdio://']
assert 'TONGXU_NATIVE_FAKE_SECRET' not in os.environ
assert not os.path.exists(${JSON.stringify(canary)})
assert os.getcwd()=='/native-workspace'
probe=socket.socket();probe.settimeout(0.2)
assert probe.connect_ex(('127.0.0.1',${port}))!=0
probe.close()
thread={'id':'fixture-ephemeral','ephemeral':${JSON.stringify(mode)}!='not-ephemeral','cwd':'/native-workspace','turns':[],'status':{'type':'idle'}}
for line in sys.stdin:
 m=json.loads(line)
 if 'id' not in m:continue
 method=m.get('method')
 if ${JSON.stringify(mode)}=='exit':sys.exit(0)
 if ${JSON.stringify(mode)}=='stall':time.sleep(60)
 if method=='initialize':result={'userAgent':'fixture'}
 elif method=='thread/start':
  assert m['params']=={'cwd':'/native-workspace','sandbox':'read-only','approvalPolicy':'never','ephemeral':True}
  result={'thread':thread,'cwd':'/native-workspace','sandbox':{'type':'readOnly','networkAccess':False},'approvalPolicy':'never'}
 elif method=='thread/read':
  assert m['params']=={'threadId':thread['id'],'includeTurns':False}
  result={'thread':thread}
 elif method=='turn/steer':
  assert m['params']['expectedTurnId']=='tongxu-inspection-no-active-turn'
  print(json.dumps({'id':m['id'],'error':{'code':-32600,'message':'wrong error' if ${JSON.stringify(mode)}=='wrong-error' else 'no active turn to steer'}}),flush=True);continue
 else:raise Exception('unregistered method')
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
`;
  await writeFile(executable, code, { mode: 0o700 }); return executable;
}

test('production native CLI uses an isolated private protocol fixture, preserves hashes and exposes only a summary', { timeout: 20_000 }, async t => {
  const dir = await root(t), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const port = (server.address() as { port: number }).port, executable = await nativeFixture(dir, 'complete', port), output = join(dir, 'output');
  const result = await exec(process.execPath, [cli, 'inspect', '--codex', executable, '--output', output], { env: { PATH: '/usr/bin:/bin', TONGXU_NATIVE_FAKE_SECRET: 'fake-test-secret' } });
  const summary = JSON.parse(result.stdout), report = JSON.parse(await readFile(join(output, 'native-inspection.json'), 'utf8'));
  assert.equal(summary.status, 'complete'); assert.equal(summary.capabilities.productionActionAllowed, false); assert.equal(summary.capabilities.modelTurns, 'not_tested');
  assert.equal(result.stdout.includes('fixture-ephemeral'), false); assert.equal(result.stdout.includes(dir), false); assert.equal(result.stdout.includes('fake-test-secret'), false);
  assert.equal(report.observations.postSteerStatus, 'idle'); assert.equal(report.requests.length, 5); assert.equal(report.requests.filter((r: any) => r.method === 'thread/start').length, 1);
  assert.equal(report.requests.some((r: any) => r.method === 'turn/start'), false); assert.equal(report.requests.at(-2).status, 'native_error');
  assert.equal((await lstat(output)).mode & 0o077, 0);
  for (const a of report.artifacts) { const bytes = await readFile(join(output, a.path)); assert.equal(hash(bytes), a.sha256); assert.equal(bytes.length, a.bytes); assert.equal((await lstat(join(output, a.path))).mode & 0o077, 0); }
  const saved = await readFile(join(output, 'native-inspection.json'));
  await assert.rejects(inspectNative({ codex: executable, output }), /EEXIST/); assert.deepEqual(await readFile(join(output, 'native-inspection.json')), saved);
});

test('native disconnect preserves the original unknown request, and arbitrary -32600 cannot pass stale-turn inspection', { timeout: 20_000 }, async t => {
  const dir = await root(t);
  for (const mode of ['exit', 'wrong-error']) {
    const executable = await nativeFixture(dir, mode), output = join(dir, mode), result = await inspectNative({ codex: executable, output });
    assert.equal(result.exit, 2); assert.equal(result.report.status, 'partial'); assert.equal(result.report.capabilities.isolatedMetadata, 'not_tested');
    if (mode === 'exit') { assert.equal(result.report.requests[0].status, 'unknown'); assert.ok(result.report.gaps.includes('native_process_closed')); }
    else assert.ok(result.report.gaps.includes('native_stale_steer_rejection_unverified'));
    assert.ok(result.report.artifacts.length >= 5);
  }
});

test('version failure/cap retain partial original output, and a non-ephemeral session is rejected', { timeout: 20_000 }, async t => {
  const dir = await root(t);
  for (const mode of ['version-flood', 'version-exit', 'not-ephemeral']) {
    const executable = await nativeFixture(dir, mode), output = join(dir, mode), result = await inspectNative({ codex: executable, output });
    assert.equal(result.exit, 2); assert.equal(result.report.capabilities.isolatedMetadata, 'not_tested');
    const expected = mode === 'version-flood' ? 'native_version_output_limit' : mode === 'version-exit' ? 'native_version_exit_unverified' : 'native_session_boundary_unverified';
    assert.ok(result.report.gaps.includes(expected));
    assert.ok((await readFile(join(output, 'version.stdout'), 'utf8')).startsWith('codex-cli 0.0.0-fixture'));
    assert.ok((await lstat(join(output, 'version.stdout'))).size + (await lstat(join(output, 'version.stderr'))).size <= 128 * 1024);
  }
});

test('SIGKILL during version detection preserves already collected stdout/stderr before process completion', { timeout: 20_000 }, async t => {
  const dir = await root(t), executable = await nativeFixture(dir, 'version-stall'), output = join(dir, 'version-interrupted');
  const child = spawn(process.execPath, [cli, 'inspect', '--codex', executable, '--output', output], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false; const deadline = Date.now() + 8000;
  try {
    while (Date.now() < deadline) {
      try { ready = (await readFile(join(output, 'version.stdout'), 'utf8')).includes('codex-cli 0.0.0-fixture') && (await readFile(join(output, 'version.stderr'), 'utf8')).includes('version-original-stderr'); if (ready) break; } catch { /* wait for captured raw output */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const report = JSON.parse(await readFile(join(output, 'native-inspection.json'), 'utf8'));
    assert.equal(report.phase, 'version'); assert.equal(report.versionProcess.status, 'running_or_unknown');
    const before = await readFile(join(output, 'version.stdout')); assert.ok(before.length > 0);
    await assert.rejects(inspectNative({ codex: executable, output }), /EEXIST/); assert.deepEqual(await readFile(join(output, 'version.stdout')), before);
    assert.equal(await readFile(join(output, 'version.stderr'), 'utf8'), 'version-original-stderr\n');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('SIGKILL of the production CLI leaves registered original requests and refuses to overwrite their evidence', { timeout: 20_000 }, async t => {
  const dir = await root(t), executable = await nativeFixture(dir, 'stall'), output = join(dir, 'interrupted');
  const child = spawn(process.execPath, [cli, 'inspect', '--codex', executable, '--output', output], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let report: any; const deadline = Date.now() + 8000;
  try {
    while (Date.now() < deadline) {
      try { report = JSON.parse(await readFile(join(output, 'native-inspection.json'), 'utf8')); if (report.requests[0]?.status === 'sent_or_unknown') break; } catch { /* wait for durable registration */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(report?.requests[0]?.status, 'sent_or_unknown'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const saved = await readFile(join(output, 'native-inspection.json')); const after = JSON.parse(saved.toString());
    assert.equal(after.id, report.id); assert.equal(after.status, 'running'); assert.equal(after.requests[0].id, report.requests[0].id);
    await assert.rejects(inspectNative({ codex: executable, output }), /EEXIST/); assert.deepEqual(await readFile(join(output, 'native-inspection.json')), saved);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('native entry requires explicit normalized paths and rejects control modes or remote endpoints', () => {
  assert.deepEqual(parseNativeArgs(['inspect', '--codex', '/explicit/codex', '--output', '/private/new']), { codex: '/explicit/codex', output: '/private/new' });
  for (const args of [['inspect'], ['resume', '--codex', '/codex', '--output', '/new'], ['inspect', '--codex', 'codex', '--output', '/new'], ['inspect', '--codex', '/codex', '--output', '/new', '--endpoint', '/remote'], ['inspect', '--codex', '/codex', '--output', '/new', '--codex', '/other']]) assert.throws(() => parseNativeArgs(args));
});
