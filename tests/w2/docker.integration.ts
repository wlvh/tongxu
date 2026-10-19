import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { DockerRuntime, parseDockerConfig, reconcileDocker } from '../../src/docker-sandbox.js';
import type { DockerConfig } from '../../src/docker-sandbox.js';

// This suite is explicitly selected by test:docker. A missing runtime is a
// failure, never a skipped success in the bubblewrap suite.
const configPath = process.env.TONGXU_TEST_DOCKER_CONFIG;
if (!configPath) throw new Error('TONGXU_TEST_DOCKER_CONFIG is required for the real Docker suite');
const config = parseDockerConfig(JSON.parse(await readFile(configPath, 'utf8')));
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-docker-')); t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work'), resultDirectory = join(root, 'result'); await mkdir(work, { mode: 0o700 }); await mkdir(resultDirectory, { mode: 0o700 });
  const runtime = await DockerRuntime.prepare(config, join(root, 'runtime'));
  return { root, work, resultDirectory, runtime };
}
test('trusted Docker configuration rejects mutable images, remote endpoints and extra privileges', () => {
  for (const v of [{ ...config, image: 'latest' }, { ...config, endpoint: 'tcp://remote:2375' }, { ...config, privileged: true }, { ...config, client: 'docker' }]) assert.throws(() => parseDockerConfig(v), /invalid_docker_executor/);
});
test('real Docker isolates host files, inherited tokens, listener, root and explicit dependency cache', { timeout: 30_000 }, async t => {
  const f = await setup(t), sentinel = join(f.root, 'host-only'), dependencies = join(f.root, 'node_modules');
  await writeFile(sentinel, 'FAKE_TEST_SECRET'); await mkdir(dependencies); await writeFile(join(dependencies, 'sentinel'), 'readonly dependency');
  const server = createServer(s => { s.end(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close()); const port = (server.address() as { port: number }).port;
  process.env.TONGXU_TEST_SECRET = 'FAKE_TEST_SECRET';
  try {
    const code = `const fs=require('node:fs'),net=require('node:net');let o={host:fs.existsSync(${JSON.stringify(sentinel)}),token:process.env.TONGXU_TEST_SECRET??null,home:fs.readdirSync(process.env.HOME),connected:false,socket:fs.existsSync('/var/run/docker.sock'),rootWrite:false,dependencyWrite:false,dependency:fs.readFileSync('/work/node_modules/sentinel','utf8')};for(const [p,k]of [['/etc/unallowed','rootWrite'],['/work/node_modules/sentinel','dependencyWrite']]){try{fs.writeFileSync(p,'bad');o[k]=true}catch{}}const s=net.connect(${port},'host.docker.internal');s.on('connect',()=>{o.connected=true;s.destroy()});s.on('error',()=>{});s.on('close',()=>console.log(JSON.stringify(o)));setTimeout(()=>s.destroy(),500);`;
    const r = await f.runtime.run({ ...f, dependencies, directory: join(f.root, 'execution'), argv: [config.node, '-e', code], timeoutMs: 5000, maxBytes: 4096 });
    assert.equal(r.status, 'completed', r.record.toString()); assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout.toString()), { host: false, token: null, home: [], connected: false, socket: false, rootWrite: false, dependencyWrite: false, dependency: 'readonly dependency' });
    const receipt = JSON.parse(r.record.toString()); assert.equal(receipt.cleanup, 'removed'); assert.equal(receipt.capture.complete, true);
    assert.equal(await readFile(join(dependencies, 'sentinel'), 'utf8'), 'readonly dependency');
    await assert.rejects(() => f.runtime.run({ ...f, directory: join(f.root, 'execution'), argv: [config.node, '-e', '0'], timeoutMs: 1000, maxBytes: 100 }), { code: 'EEXIST' });
    await assert.rejects(() => reconcileDocker(join(f.root, 'execution'), 'inspect', { ...config, image: 'sha256:' + 'a'.repeat(64) }), /docker_recovery_plan_mismatch/);
  } finally { delete process.env.TONGXU_TEST_SECRET; }
});
test('timeout and output limit terminate the exact container and retain bounded original output', { timeout: 30_000 }, async t => {
  const f = await setup(t);
  for (const [kind, code, timeoutMs, maxBytes] of [['timeout', "console.log('started');setInterval(()=>{},100)", 700, 4096], ['output_limit', "setInterval(()=>process.stdout.write('x'.repeat(10000)),1)", 5000, 200]] as const) {
    const r = await f.runtime.run({ ...f, directory: join(f.root, kind), argv: [config.node, '-e', code], timeoutMs, maxBytes });
    assert.equal(r.status, kind, r.record.toString()); assert.ok(r.stdout.length + r.stderr.length <= maxBytes);
    const receipt = JSON.parse(r.record.toString()); assert.equal(receipt.after.State.Running, false); assert.equal(receipt.cleanup, 'removed'); assert.equal(receipt.capture.complete, false);
  }
});
