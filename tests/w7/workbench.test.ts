import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { setup } from '../w3/receiver-fixture.js';
import { runReception } from '../../src/receiver.js';
import { parseWorkbenchPlan, receptionStage, startWorkbench } from '../../src/workbench.js';

async function fixture(t: test.TestContext) {
  const f = await setup(t), result = await runReception(f.path);
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
