import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Snapshot, hash } from '../../src/snapshot.js';
import { QueueStore } from '../../src/queue-store.js';
import { readPacket, candidateKey } from '../../src/queue-evidence.js';
import { queueMain } from '../../src/queue-cli.js';

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const exec = promisify(execFile);
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tongxu-w3-')); t.after(() => rm(root, { recursive: true, force: true })); let count = 0;
  const fixture = async (o: { pr?: number; target?: string; variant?: string; at?: string; context?: any; report?: (v: any) => void } = {}) => {
    const prefix = join(root, `input-${++count}`); await mkdir(prefix, { mode: 0o700 });
    const pr = o.pr ?? 1, at = o.at ?? '2026-10-18T10:00:00.000Z';
    const candidate = { repository: 'example/project', pr, H: hash(`H-${pr}`).slice(0, 40), B: 'b'.repeat(40), targetRef: o.target ?? 'main', mergeBase: 'b'.repeat(40), observedAt: at };
    const snapshot = join(prefix, 'snapshot'); const s = await Snapshot.create(snapshot, candidate.repository, pr, [], []);
    s.manifest.candidate = candidate;
    await s.artifact(JSON.stringify({ fixture: true, number: pr, head: candidate.H, material: o.variant ?? 'initial' }), { kind: 'pr', round: 1, retrievedAt: at, provenance: 'local_fixture', status: 200 });
    s.manifest.rounds.push({ number: 1, startedAt: at, finishedAt: at, coverage: {}, sources: [], notes: [], gaps: [], limitations: ['local_fixture_not_live_api'], current: true });
    await s.save(); await s.close(); const manifest = await readFile(join(snapshot, 'manifest.json'));
    const verification = join(prefix, 'verification'); await mkdir(verification, { mode: 0o700 }); await mkdir(join(verification, 'raw'), { mode: 0o700 });
    const blob = async (bytes: Buffer) => { const sha256 = hash(bytes); const path = `raw/${sha256}.bin`; await writeFile(join(verification, path), bytes, { mode: 0o600 }); return { path, sha256, bytes: bytes.length }; };
    const argv = ['/fixture/runner'];
    const output = await blob(Buffer.from('local fixture: no command executed')), plan = await blob(Buffer.from(JSON.stringify({ schemaVersion: 1, tools: [{ id: 'fixture', argv, timeoutMs: 1000 }] })));
    const stages = await Promise.all([candidate.B, candidate.H].map(async (head, index) => ({ index, inputHead: head, parent: candidate.B, head, tree: hash(`tree-${head}`).slice(0, 40), status: 'complete', gaps: [], comparisons: [], ...(index > 0 ? { mergeOutput: await blob(Buffer.from(hash(`tree-${head}`).slice(0, 40) + '\n')) } : {}), tools: [{ id: 'fixture', argv, status: 'completed', exitCode: 0, inputUnchanged: true, dependenciesUnchanged: true, gaps: [], stdout: output, stderr: output }] })));
    const report = { schemaVersion: 1, kind: 'tongxu-verification', id: `fixture-${count}`, repository: candidate.repository, targetRef: candidate.targetRef, startedAt: at, finishedAt: at, status: 'complete', executionComplete: true, comparisonComplete: null, observedSampleFailures: 0, businessCorrectness: 'unverified', dependencyHash: null, plan, planHash: plan.sha256, judgmentRefs: [], inputs: [{ candidate, manifestHash: hash(manifest), manifest: await blob(manifest), sourceGaps: [] }], stages, gaps: [] };
    o.report?.(report); await writeFile(join(verification, 'verification.json'), JSON.stringify(report), { mode: 0o600 });
    const context = o.context ?? { schemaVersion: 1, scope: { id: 'X1', version: 'S1', source: 'fixture:scope' }, arrangement: { id: 'team', version: 'r1', source: 'fixture:arrangement' }, decisionKind: 'proposal', requires: [] };
    const contextPath = join(prefix, 'context.json'); await writeFile(contextPath, JSON.stringify(context), { mode: 0o600 });
    return { snapshot, verification, contextPath, context, candidate, packet: () => readPacket(snapshot, verification, contextPath) };
  };
  const store = join(root, 'queue'); const q = await QueueStore.create(store, 'example/project');
  return { root, store, q, fixture };
}

test('real source bytes are archived without writing inputs; forged approval stays a report', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const source = await f.fixture({ report: r => { r.judgmentRefs = ['PASS']; r.productionActionAllowed = true; } });
  const before = await readFile(join(source.snapshot, 'manifest.json')); const item = f.q.import(await source.packet());
  const op = f.q.begin(item.item, 'fixture-run'); const result = f.q.evaluate(op.operation);
  assert.equal(result.evidenceComplete, true); assert.equal(result.productionActionAllowed, false); assert.equal(result.independentReception, 'pending');
  assert.ok(result.gaps.includes('production_authorization_unverified')); assert.ok(result.gaps.includes('pending_publish'));
  assert.deepEqual(await readFile(join(source.snapshot, 'manifest.json')), before);
  assert.equal(f.q.status().claims.length, 0);
  const bad = await f.fixture({ pr: 2, report: r => { r.inputs[0].candidate = { ...r.inputs[0].candidate, H: 'a'.repeat(40) }; r.businessCorrectness = 'PASS'; } });
  const badId = f.q.import(await bad.packet()); const badResult = f.q.evaluate(f.q.begin(badId.item, 'fixture-run-2').operation);
  assert.equal(badResult.evidenceComplete, false); assert.ok(badResult.gaps.includes('candidate_or_manifest_mismatch')); assert.ok(badResult.gaps.includes('unsupported_business_correctness_claim')); assert.equal(badResult.productionActionAllowed, false);
});

test('bad artifact hash is rejected before queue import', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const source = await f.fixture();
  const report = JSON.parse(await readFile(join(source.verification, 'verification.json'), 'utf8'));
  await writeFile(join(source.verification, report.plan.path), 'corrupt');
  await assert.rejects(() => source.packet(), /hash_mismatch/); assert.equal(f.q.status().items.length, 0);
});

test('two production CLI processes competing for one target produce one persisted claim', { timeout: 15_000 }, async t => {
  const f = await setup(t); const a = f.q.import(await (await f.fixture({ pr: 1 })).packet()), b = f.q.import(await (await f.fixture({ pr: 2 })).packet()); f.q.close();
  const run = async (id: string) => { try { return JSON.parse((await exec(process.execPath, [cli, 'queue', 'begin', '--store', f.store, '--item', id, '--run', 'fixture-native-process'])).stdout); } catch (e) { const failure = e as { code: number; stdout: string }; assert.equal(failure.code, 2); return JSON.parse(failure.stdout); } };
  const results = await Promise.all([run(a.item), run(b.item)]);
  assert.equal(results.filter(r => r.operation).length, 1); assert.equal(results.filter(r => r.blocked?.includes('target_occupied_or_unknown')).length, 1);
  const q = await QueueStore.open(f.store); t.after(() => q.close()); assert.equal(q.status().claims.length, 1); assert.equal(q.status().operations.length, 1);
});

test('waiting exact dependencies consume no seat; cycles and merge requirements stay blocked', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const parent = await f.fixture({ pr: 1 }); const parentKey = candidateKey(parent.candidate, parent.context);
  const context = { ...parent.context, requires: [{ item: parentKey, type: 'development', version: parent.candidate.H, blocks: 'shadow_review', source: 'fixture:A1', canContinue: 'read independent material' }] };
  const child = f.q.import(await (await f.fixture({ pr: 2, context })).packet());
  assert.ok(f.q.begin(child.item, 'child').blocked[0].startsWith('missing_dependency:')); assert.equal(f.q.status().claims.length, 0);
  const p = f.q.import(await parent.packet()); const op = f.q.begin(p.item, 'parent'); f.q.evaluate(op.operation);
  assert.ok(f.q.begin(child.item, 'child').operation);
  const mergedContext = { ...parent.context, requires: [{ ...context.requires[0], type: 'merge' }] };
  const future = f.q.import(await (await f.fixture({ pr: 3, target: 'future', context: mergedContext })).packet());
  assert.ok(f.q.begin(future.item, 'future').blocked.some((g: string) => g.startsWith('external_dependency_unverified:')));
  const a = await f.fixture({ pr: 4, target: 'a' }), b = await f.fixture({ pr: 5, target: 'b' });
  a.context.requires = [{ ...context.requires[0], item: candidateKey(b.candidate, b.context), version: b.candidate.H }];
  b.context.requires = [{ ...context.requires[0], item: candidateKey(a.candidate, a.context), version: a.candidate.H }];
  await writeFile(a.contextPath, JSON.stringify(a.context)); await writeFile(b.contextPath, JSON.stringify(b.context));
  const ca = f.q.import(await a.packet()); f.q.import(await b.packet()); assert.ok(f.q.begin(ca.item, 'cycle').blocked.includes('dependency_cycle'));
});

test('seat cap is enforced independently of target exclusion', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const items = []; for (const [pr, target] of [[1, 'main'], [2, 'release'], [3, 'preview']] as const) items.push(f.q.import(await (await f.fixture({ pr, target })).packet()));
  assert.ok(f.q.begin(items[0]!.item, 'one').operation); assert.ok(f.q.begin(items[1]!.item, 'two').operation);
  assert.deepEqual(f.q.begin(items[2]!.item, 'three').blocked, ['reception_seats_full']);
});

test('three controls persist independently and permit recovery without claiming external stop', async t => {
  const f = await setup(t); const item = f.q.import(await (await f.fixture()).packet());
  for (const kind of ['implementation', 'investment', 'merge']) { const control = f.q.control('X1', kind, 'stopped', 'fixture:operator'); assert.equal(control.externalControl, 'unverified'); }
  f.q.control('X1', 'implementation', 'open', 'fixture:resume-implementation'); f.q.close();
  const q = await QueueStore.open(f.store); t.after(() => q.close()); assert.deepEqual(q.begin(item.item, 'stopped').blocked, ['new_investment_stopped']);
  q.control('X1', 'investment', 'open', 'fixture:resume-investment'); const op = q.begin(item.item, 'review'); assert.ok(op.operation);
  q.control('X1', 'investment', 'stopped', 'fixture:stop-again'); const result = q.evaluate(op.operation); assert.equal(result.status, 'evaluated'); assert.equal(result.productionActionAllowed, false);
  const states = Object.fromEntries(q.status().controls.map((c: any) => [c.kind, c.stopped])); assert.deepEqual(states, { implementation: 0, investment: 1, merge: 1 });
});

test('process death after begin retains unknown original operation; stale completion cannot release a newer claim', { timeout: 15_000 }, async t => {
  const f = await setup(t); const input = await f.fixture(); const item = f.q.import(await input.packet()); f.q.close();
  const module = new URL('../../src/queue-cli.js', import.meta.url).href;
  const script = `const {queueMain}=await import(${JSON.stringify(module)});const r=await queueMain(${JSON.stringify(['begin', '--store', f.store, '--item', item.item, '--run', 'fixture-killed'])});process.stdout.write(JSON.stringify(r.result),()=>process.kill(process.pid,'SIGKILL'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', error = ''; child.stdout.on('data', b => { out += b.toString(); }); child.stderr.on('data', b => { error += b.toString(); }); const [code, signal] = await once(child, 'close'); assert.equal(code, null, error); assert.equal(signal, 'SIGKILL'); const original = JSON.parse(out);
  const q = await QueueStore.open(f.store); t.after(() => q.close()); const state = q.status(); assert.equal(state.claims.length, 1); assert.equal(state.operations[0].recovery, 'result_unknown_evaluate_original_operation');
  assert.equal(q.begin(item.item, 'replacement-not-started').operation, original.operation); assert.equal(q.status().operations.length, 1);
  q.evaluate(original.operation);
  const changed = await f.fixture({ variant: 'new substantive source', at: '2026-10-18T11:00:00.000Z' }); q.import(await changed.packet()); const next = q.begin(item.item, 'new-generation'); assert.equal(next.generation, 2);
  assert.equal(q.evaluate(original.operation).duplicate, true); assert.equal(q.status().claims[0].operation, next.operation);
});

test('duplicate runs and receipt times do not dispatch; new material triggers once and older replay cannot roll back', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const first = await f.fixture(); const a = f.q.import(await first.packet()); const op = f.q.begin(a.item, 'first'); f.q.evaluate(op.operation);
  const receiptOnly = await f.fixture({ at: '2026-10-18T11:00:00.000Z' }); const dup = f.q.import(await receiptOnly.packet()); assert.equal(dup.duplicate, true); assert.equal(f.q.begin(a.item, 'duplicate').operation, op.operation);
  const newer = await f.fixture({ variant: 'new discussion', at: '2026-10-18T12:00:00.000Z' }); const b = f.q.import(await newer.packet()); assert.equal(b.duplicate, false); assert.notEqual(b.currentPacket, a.currentPacket);
  assert.equal(f.q.import(await first.packet()).currentPacket, b.currentPacket);
  const unseenOld = await f.fixture({ variant: 'late old observation', at: '2026-10-18T09:00:00.000Z' }); const old = f.q.import(await unseenOld.packet()); assert.equal(old.archived, true); assert.equal(old.currentPacket, b.currentPacket);
  assert.equal(f.q.status().operations.length, 1);
});

test('stored corruption keeps the original operation unresolved and does not release its claim', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const packet = await (await f.fixture()).packet(); const item = f.q.import(packet), op = f.q.begin(item.item, 'corruption');
  const db = new DatabaseSync(join(f.store, 'queue.sqlite')); db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('bad'), packet.reportHash); db.close();
  assert.throws(() => f.q.evaluate(op.operation), /stored_evidence_hash_mismatch/); assert.equal(f.q.status().claims[0].operation, op.operation); assert.equal(f.q.status().operations[0].status, 'running');
});

test('changed failure or runner evidence is substantive even when source and test exit are unchanged', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const initial = f.q.import(await (await f.fixture()).packet()); f.q.evaluate(f.q.begin(initial.item, 'initial').operation);
  const failed = f.q.import(await (await f.fixture({ at: '2026-10-18T11:00:00.000Z', report: r => { r.observedSampleFailures = 1; r.comparisonComplete = false; } })).packet());
  assert.equal(failed.duplicate, false); const failure = f.q.evaluate(f.q.begin(initial.item, 'new-failure').operation);
  assert.equal(failure.evidenceComplete, false); assert.ok(failure.gaps.includes('sample_failure_or_incomplete_comparison'));
  const runner = f.q.import(await (await f.fixture({ at: '2026-10-18T12:00:00.000Z', report: r => { r.toolVersions = { runner_verification_sha256: 'f'.repeat(64) }; } })).packet());
  assert.equal(runner.duplicate, false); assert.notEqual(runner.currentPacket, failed.currentPacket);
});

test('a corrupted prerequisite blocks its dependent but not unrelated evidence', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const parent = await f.fixture(); const packet = await parent.packet(); const parentItem = f.q.import(packet);
  const context = { ...parent.context, requires: [{ item: parentItem.item, type: 'parent', version: parent.candidate.H, blocks: 'shadow_review', source: 'fixture:parent', canContinue: 'independent investigation' }] };
  const dependent = f.q.import(await (await f.fixture({ pr: 2, context })).packet());
  const unrelated = f.q.import(await (await f.fixture({ pr: 3 })).packet());
  const db = new DatabaseSync(join(f.store, 'queue.sqlite')); db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('bad'), packet.reportHash); db.close();
  assert.ok(f.q.begin(dependent.item, 'dependent').blocked.includes(`dependency_evidence_unreadable:${parentItem.item}`));
  assert.equal(f.q.status().claims.length, 0); assert.equal(f.q.evaluate(f.q.begin(unrelated.item, 'independent').operation).evidenceComplete, true);
});

test('unfinished W2 operation remains a reference, and CLI has no live execution mode', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const fixture = await f.fixture({ report: r => { r.status = 'running'; r.executionComplete = false; r.stages[1].tools[0].status = 'running'; r.stages[1].tools[0].pid = 123; } });
  const item = f.q.import(await fixture.packet()); const result = f.q.evaluate(f.q.begin(item.item, 'inspect-unknown').operation);
  assert.equal(result.evidenceComplete, false); assert.equal(result.originalOperations.length, 1); assert.equal(result.externalActionSent, false);
  await assert.rejects(() => queueMain(['merge', '--store', f.store]), /invalid_queue_command/);
  const forbidden = join(f.root, 'forbidden'); await assert.rejects(() => queueMain(['init', '--store', forbidden, '--repo', 'example/project', '--mode', 'delegated']), /invalid_queue_option/); await assert.rejects(() => access(forbidden));
});

test('missing original tool output cannot satisfy an exact local evidence prerequisite', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const bad = await f.fixture({ report: r => { for (const stage of r.stages) for (const tool of stage.tools) { delete tool.stdout; delete tool.stderr; } } });
  const packet = await bad.packet(); assert.equal(packet.summary.evidenceComplete, false); assert.ok(packet.summary.gaps.includes('original_tool_output_missing'));
  const parent = f.q.import(packet), context = { ...bad.context, requires: [{ item: parent.item, type: 'development', version: bad.candidate.H, blocks: 'shadow_review', source: 'fixture:A1', canContinue: 'independent work' }] };
  const child = f.q.import(await (await f.fixture({ pr: 2, context })).packet());
  assert.ok(f.q.begin(child.item, 'blocked-child').blocked.includes(`dependency_evidence_incomplete:${parent.item}`)); assert.equal(f.q.status().claims.length, 0);
});

test('stage tools must cover the original plan with the same arguments', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const source = await f.fixture();
  const path = join(source.verification, 'verification.json'), report = JSON.parse(await readFile(path, 'utf8'));
  const plan = JSON.parse(await readFile(join(source.verification, report.plan.path), 'utf8')); plan.tools.push({ ...plan.tools[0], id: 'omitted-required-check' });
  const bytes = Buffer.from(JSON.stringify(plan)), sha256 = hash(bytes); report.plan = { path: `raw/${sha256}.bin`, sha256, bytes: bytes.length }; report.planHash = sha256;
  await writeFile(join(source.verification, report.plan.path), bytes, { mode: 0o600 }); await writeFile(path, JSON.stringify(report));
  assert.ok((await source.packet()).summary.gaps.includes('planned_tool_coverage_mismatch'));
  const wrongArgv = await f.fixture({ report: r => { r.stages[1].tools[0].argv = ['/different/tool']; } });
  assert.ok((await wrongArgv.packet()).summary.gaps.includes('planned_tool_coverage_mismatch'));
});

test('reported stage tree and head must agree with original merge output and chain', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const source = await f.fixture({ report: r => { r.stages[1].tree = r.stages[0].tree; r.stages[1].head = r.stages[0].head; } });
  const packet = await source.packet(); assert.equal(packet.summary.evidenceComplete, false); assert.ok(packet.summary.gaps.includes('merge_tree_evidence_mismatch')); assert.ok(packet.summary.gaps.includes('stage_identity_chain_mismatch'));
});

test('sample summaries require matching raw results from the registered tool', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const source = await f.fixture();
  const path = join(source.verification, 'verification.json'), report = JSON.parse(await readFile(path, 'utf8'));
  const plan = JSON.parse(await readFile(join(source.verification, report.plan.path), 'utf8')); plan.tools[0].expectedSampleIds = ['sample'];
  const bytes = Buffer.from(JSON.stringify(plan)), sha256 = hash(bytes); report.plan = { path: `raw/${sha256}.bin`, sha256, bytes: bytes.length }; report.planHash = sha256;
  for (const stage of report.stages) stage.tools[0].sampleSet = { complete: true, samples: [{ id: 'sample', status: 'ok', content: 1, identity: 'fixture', source: 'fixture:claim', sideEffects: [] }], gaps: [] };
  report.comparisonComplete = true;
  await writeFile(join(source.verification, report.plan.path), bytes, { mode: 0o600 }); await writeFile(path, JSON.stringify(report));
  const packet = await source.packet(); assert.equal(packet.summary.evidenceComplete, false); assert.ok(packet.summary.gaps.includes('original_sample_result_missing_or_invalid')); assert.ok(packet.summary.gaps.includes('sample_result_evidence_mismatch'));
});

test('intact structured original results are accepted, while a forged summary is incomplete', async t => {
  const f = await setup(t); t.after(() => f.q.close()); const source = await f.fixture();
  const path = join(source.verification, 'verification.json'), report = JSON.parse(await readFile(path, 'utf8'));
  const blob = async (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)), sha256 = hash(bytes), path = `raw/${sha256}.bin`; await writeFile(join(source.verification, path), bytes, { mode: 0o600 }); return { path, sha256, bytes: bytes.length }; };
  const plan = JSON.parse(await readFile(join(source.verification, report.plan.path), 'utf8')); plan.tools[0].expectedSampleIds = ['sample']; report.plan = await blob(plan); report.planHash = report.plan.sha256;
  const rows = [{ id: 'sample', status: 'ok', content: { result: 1 }, identity: 'fixture', source: 'fixture:original-result', sideEffects: [] }], original = await blob({ samples: rows });
  for (const stage of report.stages) { stage.tools[0].result = original; stage.tools[0].sampleSet = { complete: true, samples: rows, gaps: [] }; stage.comparisons = [{ tool: 'fixture', results: [{ id: 'sample', result: stage.index === 0 ? 'NOT_COMPARED' : 'SAME_OK' }] }]; }
  report.comparisonComplete = true; await writeFile(path, JSON.stringify(report));
  assert.equal((await source.packet()).summary.evidenceComplete, true);
  report.stages[1].tools[0].sampleSet.samples = [{ ...rows[0], content: 'unsupported summary' }]; await writeFile(path, JSON.stringify(report));
  const altered = await source.packet(); assert.equal(altered.summary.evidenceComplete, false); assert.ok(altered.summary.gaps.includes('sample_result_evidence_mismatch'));
});

test('duplicate observations advance the watermark, and a newer return to historical content is reevaluated', async t => {
  const f = await setup(t); let q = f.q; t.after(() => q.close());
  const at = (time: string, fail = false) => (r: any) => { r.startedAt = `2026-10-18T${time}:00.000Z`; if (fail) { r.observedSampleFailures = 1; r.comparisonComplete = false; } };
  const first = q.import(await (await f.fixture({ report: at('15:55') })).packet()); const initial = q.begin(first.item, 'first'); q.evaluate(initial.operation);
  const failure = q.import(await (await f.fixture({ report: at('15:56', true) })).packet()); q.evaluate(q.begin(first.item, 'failure').operation);
  const repeat = q.import(await (await f.fixture({ report: at('15:58', true) })).packet()); assert.equal(repeat.duplicate, true);
  q.close(); q = await QueueStore.open(f.store);
  const old = q.import(await (await f.fixture({ report: at('15:57') })).packet()); assert.equal(old.archived, true); assert.equal(old.currentPacket, failure.currentPacket);
  assert.equal(q.status().items[0].summary.evidenceComplete, false); assert.equal(q.status().items[0].latestObservation, '2026-10-18T15:58:00.000Z');
  const recovered = q.import(await (await f.fixture({ report: at('15:59') })).packet()); assert.equal(recovered.duplicate, false); assert.notEqual(recovered.currentPacket, first.currentPacket);
  const next = q.begin(first.item, 'recovered'); assert.notEqual(next.operation, initial.operation); assert.equal(next.generation, 3); assert.equal(q.evaluate(next.operation).evidenceComplete, true);
});

test('all source/run order combinations preserve counter-observations instead of releasing dependencies', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const first = await f.fixture({ at: '2026-10-18T12:00:00.000Z', report: r => { r.startedAt = '2026-10-18T15:00:00.000Z'; } });
  for (const sourceHour of [11, 12, 13]) for (const runHour of [14, 15, 16]) {
    const source = await f.fixture({ at: `2026-10-18T${sourceHour}:00:00.000Z`, report: r => { r.startedAt = `2026-10-18T${runHour}:00:00.000Z`; r.status = 'partial'; r.executionComplete = false; r.gaps = ['fixture_failed']; } });
    const q = await QueueStore.create(join(f.root, `order-${sourceHour}-${runHour}`), 'example/project');
    try {
      const initial = q.import(await first.packet()); const added = q.import(await source.packet());
      const mixed = (sourceHour < 12 && runHour > 15) || (sourceHour > 12 && runHour < 15) || (sourceHour === 12 && runHour === 15);
      const old = !mixed && (sourceHour < 12 || runHour < 15);
      assert.equal(added.observationConflict, mixed, `source ${sourceHour}, run ${runHour}`); assert.equal(added.archived, old);
      const state = q.status().items[0]; assert.equal(state.summary.evidenceComplete, old);
      if (mixed) { assert.equal(q.begin(initial.item, 'must-wait').blocked[0], 'observation_order_conflict'); assert.equal(state.materialHistory.length, 2); }
    } finally { q.close(); }
  }
});

test('mixed observations persist, block dependents, preserve original recovery, and require a joint update', async t => {
  const f = await setup(t); let q = f.q; t.after(() => q.close());
  const first = await f.fixture({ at: '2026-10-18T13:00:00.000Z', report: r => { r.startedAt = '2026-10-18T14:00:00.000Z'; } });
  const parent = q.import(await first.packet()), original = q.begin(parent.item, 'original-still-running');
  const failed = await f.fixture({ at: '2026-10-18T12:00:00.000Z', report: r => { r.startedAt = '2026-10-18T15:00:00.000Z'; r.status = 'partial'; r.executionComplete = false; r.gaps = ['fixture_failed']; } });
  assert.equal(q.import(await failed.packet()).observationConflict, true); q.close(); q = await QueueStore.open(f.store);
  const context = { ...first.context, requires: [{ item: parent.item, type: 'development', version: first.candidate.H, blocks: 'shadow_review', source: 'fixture:parent', canContinue: 'independent work' }] };
  const child = q.import(await (await f.fixture({ pr: 2, context })).packet()); assert.ok(q.begin(child.item, 'child-waits').blocked.includes(`observation_order_conflict:${parent.item}`));
  assert.equal(q.begin(parent.item, 'no-substitute').originalOperation, original.operation);
  const unaffected = q.import(await (await f.fixture({ pr: 3, target: 'other-target' })).packet()); assert.equal(q.evaluate(q.begin(unaffected.item, 'independent').operation).evidenceComplete, true);
  assert.equal(q.evaluate(original.operation).evidenceComplete, false); assert.equal(q.status().claims.length, 0);
  q.import(await first.packet()); assert.equal(q.status().items.find((i: any) => i.id === parent.item).observationConflict, true);
  const joint = await f.fixture({ at: '2026-10-18T16:00:00.000Z', report: r => { r.startedAt = '2026-10-18T17:00:00.000Z'; } });
  const resolved = q.import(await joint.packet()); assert.equal(resolved.observationConflict, false); assert.equal(resolved.duplicate, false);
  const current = q.begin(parent.item, 'joint-evidence'); assert.notEqual(current.operation, original.operation); assert.equal(q.evaluate(current.operation).evidenceComplete, true);
  assert.ok(q.begin(child.item, 'child-can-review').operation);
});

test('a persisted conflict is cleared only beyond both watermarks, including every equal/older/newer combination', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const good = await f.fixture({ at: '2026-10-18T12:00:00.000Z', report: r => { r.startedAt = '2026-10-18T15:00:00.000Z'; } });
  const contradictory = await f.fixture({ at: '2026-10-18T12:00:00.000Z', report: r => { r.startedAt = '2026-10-18T15:00:00.000Z'; r.executionComplete = false; } });
  for (const sourceHour of [11, 12, 13]) for (const runHour of [14, 15, 16]) {
    const store = join(f.root, `reconciliation-${sourceHour}-${runHour}`); let q = await QueueStore.create(store, 'example/project');
    try {
      const parent = q.import(await good.packet()); q.import(await contradictory.packet()); q.close(); q = await QueueStore.open(store);
      const context = { ...good.context, requires: [{ item: parent.item, type: 'parent', version: good.candidate.H, blocks: 'shadow_review', source: 'fixture:parent', canContinue: 'independent work' }] };
      const child = q.import(await (await f.fixture({ pr: 2, context })).packet());
      const next = await f.fixture({ at: `2026-10-18T${sourceHour}:00:00.000Z`, report: r => { r.startedAt = `2026-10-18T${runHour}:00:00.000Z`; } });
      const resolved = sourceHour > 12 && runHour > 15;
      assert.equal(q.import(await next.packet()).observationConflict, !resolved);
      assert.equal(q.status().items.find((i: any) => i.id === parent.item).summary.evidenceComplete, resolved);
      const admission = q.begin(child.item, 'check-dependency');
      if (resolved) assert.ok(admission.operation);
      else assert.ok(admission.blocked.includes(`observation_order_conflict:${parent.item}`));
    } finally { q.close(); }
  }
});

test('JSON reencoding and report identifiers cannot reconcile unknown-order or same-time conflicts', async t => {
  const f = await setup(t); t.after(() => f.q.close());
  const good = await f.fixture(), original = await good.packet();
  const unknown = await f.fixture({ report: r => { delete r.startedAt; r.executionComplete = false; } });
  const contradictory = await f.fixture({ context: { ...good.context, decisionKind: 'fact' } });
  for (const [name, conflict] of [['unknown', unknown], ['same-time', contradictory]] as const) {
    const store = join(f.root, name); let q = await QueueStore.create(store, 'example/project');
    try {
      const parent = q.import(original); assert.equal(q.import(await conflict.packet()).observationConflict, true);
      const childContext = { ...good.context, requires: [{ item: parent.item, type: 'development', version: good.candidate.H, blocks: 'shadow_review', source: 'fixture:parent', canContinue: 'independent work' }] };
      const child = q.import(await (await f.fixture({ pr: 2, context: childContext })).packet());
      const reportPath = join(good.verification, 'verification.json'), report = JSON.parse(await readFile(reportPath, 'utf8'));
      for (const variant of ['context-format', 'report-format', 'report-id']) {
        if (variant === 'context-format') await writeFile(good.contextPath, JSON.stringify(good.context, null, 2) + '\n');
        else { if (variant === 'report-id') report.id += '-receipt-only'; await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
        const replay = await good.packet(); assert.equal(replay.fingerprint, original.fingerprint);
        q.import(replay); q.close(); q = await QueueStore.open(store);
        const state = q.status().items.find((i: any) => i.id === parent.item);
        assert.equal(state.observationConflict, true, variant); assert.equal(state.currentPacket, parent.packet);
        assert.equal(state.summary.evidenceComplete, false); assert.ok(q.begin(child.item, variant).blocked.includes(`observation_order_conflict:${parent.item}`));
      }
      const fresh = await f.fixture({ at: '2026-10-18T18:00:00.000Z', report: r => { r.startedAt = '2026-10-18T19:00:00.000Z'; } });
      assert.equal(q.import(await fresh.packet()).observationConflict, false);
      assert.ok(q.begin(child.item, 'fresh-joint-observation').operation);
    } finally { q.close(); }
  }
});
