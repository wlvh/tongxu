import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runSandbox, validateDependencies, runtimeResources } from '../../src/sandbox.js';

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tongxu-sandbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work'), resultDirectory = join(root, 'result'); await mkdir(work); await mkdir(resultDirectory);
  return { root, work, resultDirectory, timeoutMs: 3000, maxBytes: 1024 * 1024 };
}
test('real sandbox cannot reach host files, a host listener or inherited token variables', { timeout: 10_000 }, async t => {
  const o = await setup(t); const sentinel = join(o.root, 'host-only'); await writeFile(sentinel, 'FAKE_TEST_SECRET');
  let calls = 0; const server = createServer(s => { calls++; s.end(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  process.env.TONGXU_TEST_PUBLISH_TOKEN = 'FAKE_TEST_SECRET';
  try {
    const script = `const fs=require('node:fs'),net=require('node:net');let out={host:fs.existsSync(${JSON.stringify(sentinel)}),token:process.env.TONGXU_TEST_PUBLISH_TOKEN??null,home:fs.readdirSync(process.env.HOME),connected:false};const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{out.connected=true;s.destroy()});s.on('error',()=>{});s.on('close',()=>console.log(JSON.stringify(out)));setTimeout(()=>s.destroy(),300);`;
    const r = await runSandbox({ ...o, argv: [process.execPath, '-e', script] });
    assert.equal(r.status, 'completed', r.stderr.toString()); assert.equal(r.exitCode, 0); assert.deepEqual(JSON.parse(r.stdout.toString()), { host: false, token: null, home: [], connected: false }); assert.equal(calls, 0);
  } finally { delete process.env.TONGXU_TEST_PUBLISH_TOKEN; }
});
test('timeout and output cap terminate the isolated process group and retain bounded output', { timeout: 10_000 }, async t => {
  const o = await setup(t);
  const timed = await runSandbox({ ...o, timeoutMs: 200, argv: [process.execPath, '-e', 'setInterval(()=>{},100)'] }); assert.equal(timed.status, 'timeout'); assert.notEqual(timed.exitCode, 0);
  const large = await runSandbox({ ...o, maxBytes: 200, argv: [process.execPath, '-e', "setInterval(()=>process.stdout.write('x'.repeat(10000)),1)"] }); assert.equal(large.status, 'output_limit'); assert.ok(large.stdout.length + large.stderr.length <= 200);
});
test('dependency mount accepts only explicit Node dependency directories', async () => {
  await assert.rejects(() => validateDependencies('/etc'), /invalid_dependency/);
  await assert.rejects(() => validateDependencies('/home'), /invalid_dependency/);
});

test('exact runtime resources preserve the npm command used by nested project scripts', { timeout: 10_000 }, async t => {
  const o = await setup(t); const runtime = await runtimeResources();
  assert.ok(runtime.npm, 'this supported test host must have npm installed');
  const result = await runSandbox({ ...o, argv: [process.execPath, '-e', "console.log(require('node:child_process').execFileSync('npm',['--version'],{encoding:'utf8'}).trim())"] });
  assert.equal(result.status, 'completed', result.stderr.toString()); assert.equal(result.stdout.toString().trim(), runtime.npmVersion);
});

test('flat Node installation exposes only the executable, not its ancestor filesystem', { timeout: 15_000 }, async t => {
  const o = await setup(t); const fake = join(o.root, 'fake-credential'); await writeFile(fake, 'FAKE_ONLY');
  const script = "import {runSandbox} from '/code/src/sandbox.js'; const r=await runSandbox({work:'/work',resultDirectory:'/result',timeoutMs:3000,maxBytes:1000,argv:[process.execPath,'-e',\"console.log(JSON.stringify({outside:require('node:fs').existsSync('/outside/fake-credential')}))\"]});console.log(JSON.stringify({status:r.status,exit:r.exitCode,output:r.stdout.toString(),error:r.stderr.toString()}));";
  const { stdout } = await promisify(execFile)('bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/tongxu', '--dir', '/work', '--dir', '/result', '--ro-bind', process.execPath, '/opt/node', '--ro-bind', fileURLToPath(new URL('../..', import.meta.url)), '/code', '--ro-bind', fake, '/outside/fake-credential', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '/opt/node', '--input-type=module', '-e', script], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const observed = JSON.parse(stdout); assert.equal(observed.status, 'completed', observed.error); assert.equal(observed.exit, 0); assert.deepEqual(JSON.parse(observed.output), { outside: false });
});
