import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setup } from '../w3/receiver-fixture.js';
import { runReception } from '../../src/receiver.js';
import { parseWorkbenchPlan, receptionStage, startWorkbench } from '../../src/workbench.js';
import { publication } from '../../src/publisher.js';
import { hash } from '../../src/snapshot.js';

async function fixture(t: test.TestContext, nativeShapedFixture = false) {
  const f = await setup(t);
  if (nativeShapedFixture) await writeFile(f.path, JSON.stringify({ ...f.plan, executionKind: 'native_capture' }));
  const result = await runReception(f.path);
  const p = { schemaVersion: 1, kind: 'tongxu-local-workbench', title: '明确测试夹具', goal: '测试现有队列的只读呈现，不是真实模型或产品接收。', sources: [{ id: 'selected', title: '固定测试任务', store: f.store, item: f.item }] };
  const path = join(f.root, 'workbench.json'); await writeFile(path, JSON.stringify(p));
  const app = await startWorkbench(path); t.after(() => app.close()); const u = new URL(app.url), headers = { Authorization: 'Bearer ' + u.hash.slice(1) };
  return { ...f, result, p, path, app, base: u.origin, headers };
}
test('a real readonly HTTP view returns selected state and exact report without changing queue or starting another model', async t => {
  const f = await fixture(t), before = f.q.status(), trace = await readFile(f.trace);
  const response = await fetch(f.base + '/api/state', { headers: f.headers }); assert.equal(response.status, 200);
  const state = await response.json() as any; assert.equal(state.mode, 'read_only'); assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].candidate.H, f.H); assert.equal(state.tasks[0].operations[0].stage, 'returned'); assert.equal(state.modelCallsStartedByWorkbench, 0); assert.equal(state.remoteRechecked, false);
  const body = JSON.stringify(state); assert.ok(!body.includes(f.root)); assert.ok(!body.includes(f.result.receiver.judgment.report));
  const report = await (await fetch(f.base + '/api/report/selected/' + f.result.operation, { headers: f.headers })).json() as any;
  assert.equal(report.report, f.result.receiver.judgment.report); assert.equal(report.productionActionAllowed, false);
  await fetch(f.base + '/api/state', { headers: f.headers }); assert.deepEqual(f.q.status(), before); assert.deepEqual(await readFile(f.trace), trace);
});
test('viewer key, host and origin boundaries reject cross-site and unauthorized reads; all mutations are absent', async t => {
  const f = await fixture(t), before = f.q.status();
  for (const options of [{}, { headers: { Authorization: 'Bearer wrong' } }]) assert.equal((await fetch(f.base + '/api/state', options)).status, 401);
  assert.equal((await fetch(f.base + '/api/state', { headers: { ...f.headers, Origin: 'https://other.example' } })).status, 403);
  const rawHostStatus = await new Promise<number>((ok, reject) => { const req = request(f.base + '/api/state', { headers: { ...f.headers, Host: 'other.example' } }, res => { res.resume(); ok(res.statusCode!); }); req.on('error', reject); req.end(); });
  assert.equal(rawHostStatus, 403);
  assert.equal((await fetch(f.base + '/api/state', { method: 'POST', headers: f.headers, body: '{"merge":true}' })).status, 405);
  assert.equal((await fetch(f.base + '/api/state?path=/etc/passwd', { headers: f.headers })).status, 400);
  assert.equal((await fetch(f.base + '/api/execute', { headers: f.headers })).status, 404);
  const html = await fetch(f.base + '/'); assert.match(html.headers.get('content-security-policy')!, /default-src 'none'/); assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.q.status(), before); assert.equal(await f.count(), 1);
});
test('another operation in the same physical queue is not exposed by a guessed source or operation URL', async t => {
  const f = await fixture(t), other = await f.packet({ pr: 2, target: 'other-target' }), path = join(f.root, 'other-plan.json'); await writeFile(path, JSON.stringify({ ...f.plan, item: other.item }));
  const result = await runReception(path);
  assert.equal((await fetch(f.base + '/api/report/selected/' + result.operation, { headers: f.headers })).status, 404);
  assert.equal((await fetch(f.base + '/api/report/unselected/' + result.operation, { headers: f.headers })).status, 404);
  const state = await (await fetch(f.base + '/api/state', { headers: f.headers })).json() as any; assert.equal(state.tasks.length, 1); assert.ok(!JSON.stringify(state).includes(result.operation));
});
test('local completion, uncertain delivery and a historical judgment never render as a current returned reception', () => {
  assert.equal(receptionStage({ status: 'complete', result: { status: 'evaluated' } }), 'not_dispatched');
  assert.equal(receptionStage({ status: 'receiving', result: { receiver: { phase: 'dispatch_registered', controllerReturned: true } } }), 'submitted_or_unknown');
  assert.equal(receptionStage({ status: 'complete', result: { receiver: { phase: 'returned', currentMaterialMatches: false, judgment: { verdict: 'ACCEPT_WITHIN_SCOPE' } } } }), 'historical_result');
  assert.equal(receptionStage({ status: 'complete', result: { receiver: { phase: 'closed_unresolved' } } }), 'closed_unresolved');
});
test('a source becoming unreadable is explicit on the next read, with no empty-success or cached-state substitution', async t => {
  const f = await fixture(t), db = join(f.store, 'queue.sqlite'), moved = join(f.store, 'queue-retained.sqlite');
  await rename(db, moved);
  try { const s = await (await fetch(f.base + '/api/state', { headers: f.headers })).json() as any; assert.equal(s.tasks[0].available, false); assert.equal(s.tasks[0].operations, undefined); assert.equal(s.events.length, 0); }
  finally { await rename(moved, db); }
  const restored = await (await fetch(f.base + '/api/state', { headers: f.headers })).json() as any; assert.equal(restored.tasks[0].available, true);
});
test('a response treats report HTML as data and serves it only as authenticated JSON', async t => {
  const f = await setup(t), attack = '<img src="https://outside.example/leak"><script>globalThis.REPORT_EXECUTED=true</script>';
  await writeFile(f.plan.claudeExecutable, (await readFile(f.plan.claudeExecutable, 'utf8')).replace("report:'明确标注的模拟接收判断；没有真实模型或业务批准。'", 'report:' + JSON.stringify(attack)));
  const r = await runReception(f.path), plan = join(f.root, 'web.json'); await writeFile(plan, JSON.stringify({ schemaVersion: 1, kind: 'tongxu-local-workbench', title: '恶意文本夹具', goal: '只作为文本', sources: [{ id: 'task', title: 'task', store: f.store, item: f.item }] }));
  const app = await startWorkbench(plan); t.after(() => app.close()); const u = new URL(app.url);
  const response = await fetch(u.origin + '/api/report/task/' + r.operation, { headers: { Authorization: 'Bearer ' + u.hash.slice(1) } });
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal((await response.json() as any).report, attack);
});
test('configuration cannot silently alias task identities or accept an arbitrary relative store', async t => {
  const f = await fixture(t);
  for (const sources of [[...f.p.sources, ...f.p.sources], [{ ...f.p.sources[0], store: '../elsewhere' }], [{ ...f.p.sources[0], id: '../../etc' }]]) assert.throws(() => parseWorkbenchPlan(Buffer.from(JSON.stringify({ ...f.p, sources }))), /invalid_workbench_source/);
});
test('prepare-only publication exposes a planned value, never a remotely observed success', async t => {
  // Explicit native-shaped fixture: the executable remains the fake script.
  const f = await fixture(t, true), gh = join(f.root, 'never-call-gh.mjs');
  await writeFile(gh, '#!' + process.execPath + '\nthrow new Error("unexpected_external_call");\n', { mode: 0o700 });
  const path = join(f.root, 'prepare-only.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: 'tongxu-reception-publication', store: f.store, operation: f.result.operation, channel: 'commit-status', ghExecutable: gh, ghSha256: hash(await readFile(gh)), repositoryId: 71, actor: { id: 72, login: 'fixture-publisher' }, source: 'fixture:prepare-only' }));
  assert.equal((await publication(path, 'prepare')).status, 'prepared_not_sent');
  const before = f.q.status(), state = await (await fetch(f.base + '/api/state', { headers: f.headers })).json() as any, p = state.tasks[0].operations[0].publication;
  assert.equal(p.status, 'pending'); assert.equal(p.plannedGithubState, 'success'); assert.equal(p.recordedGithubState, null); assert.equal(p.githubState, undefined); assert.equal(p.remoteRechecked, false);
  assert.deepEqual(before.events.filter((e: any) => e.kind.startsWith('publication_')).map((e: any) => e.kind), ['publication_prepared']);
  assert.deepEqual(f.q.status(), before); assert.equal(await f.count(), 1);
});
test('execution version and session come from registered original blobs even when capture files are moved', async t => {
  const f = await fixture(t), before = f.q.status(), directory = f.result.receiver.directory, retained = directory + '-retained';
  await rename(directory, retained);
  const state = await (await fetch(f.base + '/api/state', { headers: f.headers })).json() as any;
  const report = await (await fetch(f.base + '/api/report/selected/' + f.result.operation, { headers: f.headers })).json() as any;
  const x = state.tasks[0].operations[0].nativeExecution;
  assert.equal(x.state, 'recorded'); assert.equal(x.executionKind, 'fixture'); assert.equal(x.version, '2.1.233'); assert.equal(x.session, 'fixture-receiver'); assert.equal(x.model, 'fixture');
  assert.equal(x.evidenceSha256, f.result.receiver.blobs['init.json'].sha256); assert.deepEqual(report.nativeExecution, x);
  assert.deepEqual(f.q.status(), before); assert.equal(before.operations[0].nativeExecution, undefined); assert.equal(await f.count(), 1);
});
test('missing or corrupt original metadata remains explicitly unknown without borrowing a current version', async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.store, 'queue.sqlite')); t.after(() => db.close());
  const sha = f.result.receiver.blobs['init.json'].sha256;
  for (const command of ['UPDATE blobs SET bytes=? WHERE hash=?', 'DELETE FROM blobs WHERE hash=?']) {
    if (command.startsWith('UPDATE')) db.prepare(command).run(Buffer.from('{"claude_code_version":"invented"}'), sha); else db.prepare(command).run(sha);
    const state = await (await fetch(f.base + '/api/state', { headers: f.headers })).json() as any, x = state.tasks[0].operations[0].nativeExecution;
    assert.equal(x.state, 'unavailable'); assert.equal(x.reason, 'original_metadata_unreadable_or_invalid'); assert.equal(x.version, undefined); assert.equal(await f.count(), 1);
  }
});
