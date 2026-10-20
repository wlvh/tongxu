import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Snapshot, hash } from '../../src/snapshot.js';
import { QueueStore } from '../../src/queue-store.js';
import { readPacket } from '../../src/queue-evidence.js';
import { runReception, reconcileReception, supplementReception, type ReceiverPlan } from '../../src/receiver.js';
import { canonical } from '../../src/comparison.js';

import { setup, waitPhase } from './receiver-fixture.js';

test('one entry sends fixed queued materials to a separate fixture process and records the same operation; repeat does not resend', async t => {
  const f = await setup(t); const result = await runReception(f.path);
  assert.equal(result.independentReception, 'fixture_judgment_recorded'); assert.equal(result.productionActionAllowed, false); assert.equal(result.receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE');
  assert.equal(await f.count(), 1); assert.equal(f.q.status().operations.length, 1); assert.equal(f.q.status().claims.length, 0);
  const packet = JSON.parse(await readFile(join(result.receiver.directory, 'binding-input.json'), 'utf8')); assert.equal(packet.binding.operation, result.operation); assert.ok(packet.data.sources[0].text.includes('explicit test fixture'));
  const before = await readFile(join(result.receiver.directory, 'claude/stdout.ndjson')); const again = await runReception(f.path); assert.equal(again.operation, result.operation); assert.equal(again.duplicate, true); assert.equal(await f.count(), 1); assert.deepEqual(await readFile(join(result.receiver.directory, 'claude/stdout.ndjson')), before);
});
test('existing shadow stores require explicit format enablement and cannot change format during an active operation', async t => {
  const f = await setup(t, 'no-enable'); await assert.rejects(runReception(f.path), /receiver_mode_not_enabled/); assert.equal(f.q.status().operations.length, 0);
  const op = f.q.begin(f.item, 'original-shadow'); assert.throws(() => f.q.enableReceiver(), /queue_has_active_or_unknown_operation/); f.q.evaluate(op.operation);
  assert.equal(f.q.enableReceiver().receiverEnabled, true); assert.equal(f.q.enableReceiver().duplicate, true); assert.equal((await runReception(f.path)).operation, op.operation); assert.equal(await f.count(), 1);
});
test('stopped investment, incomplete evidence and explicit missing dependencies do not launch a model', async t => {
  const f = await setup(t); f.q.control('scope', 'investment', 'stopped', 'fixture:stop'); assert.ok((await runReception(f.path)).blocked.includes('new_investment_stopped')); assert.equal(await f.count(), 0);
  f.q.control('scope', 'investment', 'open', 'fixture:resume'); await f.packet({ incomplete: true }); await assert.rejects(runReception(f.path), /receiver_current_material_unverified/); assert.equal(await f.count(), 0);
  const child = await f.packet({ pr: 2, requires: [{ item: 'a'.repeat(64), type: 'development', version: 'a'.repeat(40), blocks: 'shadow_review', source: 'fixture:dependency', canContinue: 'read only' }] });
  await writeFile(f.path, JSON.stringify({ ...f.plan, item: child.item })); assert.ok((await runReception(f.path)).blocked.some((x: string) => x.startsWith('missing_dependency:'))); assert.equal(await f.count(), 0);
});
test('final gate after auth preflight observes a newly stopped scope, retains the original and can close ended without retry', async t => {
  const f = await setup(t, 'auth-delay'), running = runReception(f.path), op = await waitPhase(f.q, 'reserved'); f.q.control('scope', 'investment', 'stopped', 'fixture:stop-during-preflight');
  const result = await running; assert.equal(result.status, 'receiver_unknown'); assert.equal(result.newTaskSent, false); assert.equal(await f.count(), 0); assert.equal(f.q.status().claims.length, 1);
  const closed = await reconcileReception(f.store, op.id, 'fixture:explicit-close-known-ended'); assert.equal(closed.independentReception, 'closed_without_judgment'); assert.equal(f.q.status().claims.length, 0);
  f.q.control('scope', 'investment', 'open', 'fixture:resume'); assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 0);
});
test('active receiver owns the target; duplicate, old evaluate and new competing target operation cannot take its claim', async t => {
  const f = await setup(t, 'delay'), running = runReception(f.path), op = await waitPhase(f.q, 'dispatch_registered');
  await assert.rejects(runReception(f.path), /receiver_controller_active/); assert.throws(() => f.q.evaluate(op.id), /original_receiver_pending/);
  const other = await f.packet({ pr: 2 }); assert.deepEqual(f.q.begin(other.item, 'fixture-competing').blocked, ['target_occupied_or_unknown']);
  await assert.rejects(reconcileReception(f.store, op.id, 'fixture:cannot-takeover'), /receiver_controller_active/);
  const done = await running; assert.equal(done.receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE'); assert.equal(await f.count(), 1);
});
test('new material while receiver runs is not silently covered by its old candidate judgment', async t => {
  const f = await setup(t, 'delay'), running = runReception(f.path); await waitPhase(f.q, 'dispatch_registered'); await f.packet();
  const done = await running; assert.equal(done.receiver.currentMaterialMatches, false); assert.ok(done.gaps.includes('newer_material_requires_own_reception')); assert.equal(done.productionActionAllowed, false); assert.equal(await f.count(), 1);
});
test('new H creates a different item but still blocks old-H dispatch and invalidates applicability of a late old-H result', async t => {
  const f = await setup(t, 'auth-delay'), running = runReception(f.path), op = await waitPhase(f.q, 'reserved'); const next = await f.packet({ H: await f.newHead() }); assert.notEqual(next.item, f.item);
  const stopped = await running; assert.equal(stopped.status, 'receiver_unknown'); assert.equal(stopped.newTaskSent, false); assert.equal(await f.count(), 0); await reconcileReception(f.store, op.id, 'fixture:ended-old-candidate');
  const g = await setup(t, 'delay'), late = runReception(g.path); await waitPhase(g.q, 'dispatch_registered'); await g.packet({ H: await g.newHead() }); const result = await late;
  assert.equal(result.receiver.currentMaterialMatches, false); assert.ok(result.gaps.includes('newer_material_requires_own_reception')); assert.equal(await g.count(), 1);
});
test('an older different-H source arriving later does not supersede the selected current candidate', async t => {
  const f = await setup(t); await f.packet({ H: await f.newHead(), sourceAt: '2026-10-18T00:00:00.000Z' }); const r = await runReception(f.path);
  assert.equal(r.receiver.currentMaterialMatches, true); assert.equal(await f.count(), 1);
});
test('new versions in the selected scope stop stale dispatch without adopting a different task scope', async t => {
  const f = await setup(t, 'auth-delay'), running = runReception(f.path), op = await waitPhase(f.q, 'reserved'); await f.packet({ scopeVersion: 'S2', arrangementVersion: 'r2' }); assert.equal((await running).newTaskSent, false); assert.equal(await f.count(), 0); await reconcileReception(f.store, op.id, 'fixture:close-obsolete-context');
  const g = await setup(t); await g.packet({ scopeId: 'separate-task', scopeVersion: 'S2' }); assert.equal((await runReception(g.path)).receiver.currentMaterialMatches, true); assert.equal(await g.count(), 1);
});
test('reading a completed judgment after a later H appears preserves the old report but does not copy its applicability', async t => {
  const f = await setup(t), initial = await runReception(f.path); await f.packet({ H: await f.newHead() });
  const reread = await runReception(f.path); assert.equal(reread.operation, initial.operation); assert.equal(reread.receiver.currentMaterialMatches, false); assert.equal(reread.receiver.materialMatchedAtReturn, true); assert.deepEqual(reread.receiver.judgment, initial.receiver.judgment); assert.equal(await f.count(), 1);
  assert.equal(f.q.evaluate(initial.operation).receiver.currentMaterialMatches, false); assert.equal(f.q.status().operations[0].result.receiver.currentMaterialMatches, false);
});
test('SQL prepared by a v3 connection before enable cannot release or overwrite a native receiver', async t => {
  const f = await setup(t, 'no-enable'), legacy = new DatabaseSync(join(f.store, 'queue.sqlite')); t.after(() => legacy.close());
  // Exact old evaluate UPDATE predicate and DELETE shape, prepared before the
  // schema transition. An old client would update zero rows then delete a claim.
  const oldUpdate = legacy.prepare("UPDATE operations SET status='complete',finished_at=?,result=? WHERE id=? AND status='running'");
  const oldDelete = legacy.prepare('DELETE FROM claims WHERE target=? AND operation=? AND generation=?');
  f.q.enableReceiver(); let script = await readFile(f.plan.claudeExecutable, 'utf8'); script = script.replace("mode==='delay'?900:0", '900'); await writeFile(f.plan.claudeExecutable, script);
  const running = runReception(f.path), op = await waitPhase(f.q, 'dispatch_registered');
  legacy.exec('BEGIN IMMEDIATE'); try { oldUpdate.run(new Date().toISOString(), '{"status":"evaluated"}', op.id); assert.throws(() => oldDelete.run(op.target, op.id, op.generation), /receiver_claim_active/); } finally { legacy.exec('ROLLBACK'); }
  assert.throws(() => legacy.prepare("UPDATE operations SET result='{}' WHERE id=?").run(op.id), /receiver_record_is_bound/);
  assert.equal(f.q.status().claims.length, 1); assert.equal((await running).independentReception, 'fixture_judgment_recorded'); assert.equal(await f.count(), 1);
});
test('SIGKILL after complete capture releases only the controller mutex; recovery consumes the original without another dispatch', { timeout: 10000 }, async t => {
  const f = await setup(t), script = join(f.root, 'interrupted-controller.mjs');
  await writeFile(script, `import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js', import.meta.url).href)};import {runReception} from ${JSON.stringify(new URL('../../src/receiver.js', import.meta.url).href)};QueueStore.prototype.finishReceiver=function(){process.kill(process.pid,'SIGSTOP');throw Error('fixture-stop-before-recording')};await runReception(${JSON.stringify(f.path)});`);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' }); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const op = await waitPhase(f.q, 'dispatch_registered'), dir = op.result.receiver.directory; let captured = false;
  for (let i = 0; i < 400; i++) { try { captured = JSON.parse(await readFile(join(dir, 'claude/capture-status.json'), 'utf8')).status === 'complete'; } catch {} if (captured) break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(captured, true); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(f.q.status().claims.length, 1); const trace = await readFile(f.trace);
  const recovered = await reconcileReception(f.store, op.id); assert.equal(recovered.independentReception, 'fixture_judgment_recorded'); assert.deepEqual(await readFile(f.trace), trace); assert.equal(f.q.status().claims.length, 0);
});
test('SIGKILL during capture cannot release an active original CLI or promote its partial result', { timeout: 10000 }, async t => {
  const f = await setup(t, 'delay'), cli = fileURLToPath(new URL('../../src/receiver-cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'run', '--plan', f.path], { stdio: 'ignore' }); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const op = await waitPhase(f.q, 'dispatch_registered'), stage = join(op.result.receiver.directory, 'claude');
  for (let i = 0; i < 200 && await f.count() === 0; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(await f.count(), 1);
  const pid = JSON.parse(await readFile(join(stage, 'process.json'), 'utf8')).pid; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await assert.rejects(reconcileReception(f.store, op.id, 'fixture:active-not-released'), /receiver_original_cli_active_or_unknown/);
  let ended = false; for (let i = 0; i < 300; i++) { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { ended = true; break; } } await new Promise(r => setTimeout(r, 10)); }
  assert.equal(ended, true); const raw = await readFile(join(stage, 'stdout.ndjson')); assert.equal((await reconcileReception(f.store, op.id)).status, 'receiver_unknown');
  assert.equal((await reconcileReception(f.store, op.id, 'fixture:close-confirmed-ended')).independentReception, 'closed_without_judgment'); assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 1); assert.deepEqual(await readFile(join(stage, 'stdout.ndjson')), raw);
});
for (const mode of ['bad-binding', 'aborted']) test(`fixture ${mode} cannot become a judgment or trigger a replacement`, async t => {
  const f = await setup(t, mode), r = await runReception(f.path); assert.equal(r.status, mode === 'aborted' ? 'receiver_unknown' : 'receiver_invalid_result'); assert.equal(await f.count(), 1);
  const restored = await reconcileReception(f.store, r.operation); assert.equal(restored.status, mode === 'aborted' ? 'receiver_unknown' : 'receiver_invalid_result'); assert.equal(await f.count(), 1);
  const closed = await reconcileReception(f.store, r.operation, 'fixture:close-ended-unresolved'); assert.equal(closed.independentReception, mode === 'aborted' ? 'closed_without_judgment' : 'completed_output_not_a_valid_judgment'); assert.equal(closed.receiver.judgment, null); assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 1);
});
test('recovery binds full original stdin and tool policy even when stream hashes are rewritten; changed plan never resends', async t => {
  const f = await setup(t), r = await runReception(f.path), stage = join(r.receiver.directory, 'claude'), input = await readFile(join(stage, 'stdin.ndjson'));
  await writeFile(join(stage, 'stdin.ndjson'), Buffer.concat([input, Buffer.from('unregistered extra material')])); const capture = JSON.parse(await readFile(join(stage, 'capture-status.json'), 'utf8')); capture.files['stdin.ndjson'] = hash(await readFile(join(stage, 'stdin.ndjson'))); await writeFile(join(stage, 'capture-status.json'), JSON.stringify(capture));
  await assert.rejects(runReception(f.path), /receiver_original_input_or_tool_policy_changed/); assert.equal(await f.count(), 1);
  await writeFile(f.path, JSON.stringify({ ...f.plan, timeoutMs: 4000 })); await assert.rejects(runReception(f.path), /receiver_plan_changed/); assert.equal(await f.count(), 1);
});

async function supplementPlan(f: Awaited<ReturnType<typeof setup>>, result: any, content = '{"rawFixtureEvidence":1}', name = 'new original evidence') {
  const materialPath = join(f.root, `material-${hash(content)}.json`); await writeFile(materialPath, content);
  const p = { schemaVersion: 1, kind: 'tongxu-receiver-supplement', store: f.store, operation: result.operation, judgmentId: result.receiver.judgmentId, bindingHash: result.receiver.bindingHash, source: 'fixture:authorized-continuation', reason: 'provide omitted original evidence', material: [{ name, path: materialPath, sha256: hash(Buffer.from(content)) }] };
  const path = join(f.root, `supplement-${hash(JSON.stringify(p))}.json`); await writeFile(path, JSON.stringify(p)); return { path, plan: p, materialPath };
}
test('explicit supplement registers a new packet in the same queue and the next receiver consumes it without overwriting the first', async t => {
  const f = await setup(t, 'insufficient'), first = await runReception(f.path), p = await supplementPlan(f, first);
  const original = await readFile(join(first.receiver.directory, 'claude/stdout.ndjson'));
  await assert.rejects(supplementReception(p.path), /supplements_not_enabled/); f.q.enableSupplements();
  const added = await supplementReception(p.path); assert.equal(added.previousOperation, first.operation); assert.equal(added.item, f.item); assert.notEqual(added.packet, first.packet); assert.equal(added.modelDispatched, false); assert.equal(await f.count(), 1);
  assert.equal((await supplementReception(p.path)).packet, added.packet); assert.equal((await supplementReception(p.path)).duplicate, true);
  const next = await runReception(f.path); assert.notEqual(next.operation, first.operation); assert.equal(next.receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE'); assert.equal(await f.count(), 2);
  const input = JSON.parse(await readFile(join(next.receiver.directory, 'binding-input.json'), 'utf8'));
  assert.equal(input.binding.materialSha256, hash(canonical(input.data)), 'material digest must be reproducible from the actual submitted JSON');
  assert.equal(input.data.evidence.supplements[0].previousOperation, first.operation); assert.equal(input.data.evidence.supplements[0].priorJudgment.verdict, 'INSUFFICIENT_EVIDENCE'); assert.equal(input.data.evidence.supplements[0].material[0].text, '{"rawFixtureEvidence":1}');
  assert.equal(next.candidate.H, first.candidate.H); assert.equal(next.candidate.observedAt, first.candidate.observedAt); assert.equal(next.productionActionAllowed, false);
  assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 2); assert.deepEqual(await readFile(join(first.receiver.directory, 'claude/stdout.ndjson')), original);
  assert.equal(f.q.evaluate(first.operation).receiver.currentMaterialMatches, false); assert.equal(f.q.status().operations.length, 2);
  const sameLogical = await supplementPlan(f, first, '{ \n "rawFixtureEvidence": 1 }', 'renamed'); assert.equal((await supplementReception(sameLogical.path)).packet, added.packet);
  const db = new DatabaseSync(join(f.store, 'queue.sqlite'));
  db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('corrupted supplementary original'), p.plan.material[0]!.sha256); db.close();
  await assert.rejects(supplementReception(p.path), /stored_evidence_hash_mismatch/);
});
test('supplement needs a verified ended insufficient result, intact originals and a still-current candidate', async t => {
  const f = await setup(t), accepted = await runReception(f.path); f.q.enableSupplements(); const p = await supplementPlan(f, accepted);
  await assert.rejects(supplementReception(p.path), /requires_completed_insufficient_judgment/);
  const g = await setup(t, 'insufficient'), first = await runReception(g.path); g.q.enableSupplements(); const next = await supplementPlan(g, first);
  await writeFile(next.materialPath, 'changed'); await assert.rejects(supplementReception(next.path), /material_changed/); await writeFile(next.materialPath, '{"rawFixtureEvidence":1}');
  await g.packet({ H: await g.newHead() }); await assert.rejects(supplementReception(next.path), /original_no_longer_current/); assert.equal(await g.count(), 1);
  const h = await setup(t, 'insufficient'), r = await runReception(h.path); h.q.enableSupplements(); const intact = await supplementPlan(h, r);
  await writeFile(join(r.receiver.directory, 'claude/stdout.ndjson'), 'corrupt'); await assert.rejects(supplementReception(intact.path)); assert.equal(await h.count(), 1);
});
test('active receiver cannot enable supplements or bypass the original process with a new evidence registration', async t => {
  const f = await setup(t, 'delay'), running = runReception(f.path), op = await waitPhase(f.q, 'dispatch_registered');
  assert.throws(() => f.q.enableSupplements(), /active_or_unknown/); const p = await supplementPlan(f, { operation: op.id, receiver: op.result.receiver }); await assert.rejects(supplementReception(p.path), /controller_active/);
  await running; assert.equal(await f.count(), 1);
});
test('a stopped investment can store supplementary originals but cannot dispatch them; original material identity cannot manufacture new work', async t => {
  const f = await setup(t, 'insufficient'), first = await runReception(f.path); f.q.enableSupplements();
  const input = JSON.parse(await readFile(join(first.receiver.directory, 'binding-input.json'), 'utf8')), same = await supplementPlan(f, first, input.data.sources[0].text);
  await assert.rejects(supplementReception(same.path), /no_new_material/);
  for (const key of ['manifest', 'report', 'plan', 'context']) {
    const repeated = await supplementPlan(f, first, JSON.stringify(input.data.evidence[key], null, 2), `reencoded prior ${key}`);
    await assert.rejects(supplementReception(repeated.path), /no_new_material/);
  }
  f.q.control('scope', 'investment', 'stopped', 'fixture:stop'); const p = await supplementPlan(f, first); await supplementReception(p.path);
  assert.ok((await runReception(f.path)).blocked.includes('new_investment_stopped')); assert.equal(await f.count(), 1);
  f.q.control('scope', 'investment', 'open', 'fixture:resume'); assert.equal((await runReception(f.path)).receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE'); assert.equal(await f.count(), 2);
});
test('two supplementary packets exhaust the three-batch evidence boundary and keep all prior judgments', async t => {
  const f = await setup(t, 'always-insufficient'); let result = await runReception(f.path); f.q.enableSupplements();
  for (let n = 1; n <= 2; n++) { const p = await supplementPlan(f, result, JSON.stringify({ fixtureEvidenceBatch: n })); assert.equal((await supplementReception(p.path)).depth, n); result = await runReception(f.path); }
  const p = await supplementPlan(f, result, '{"fixtureEvidenceBatch":3}'); await assert.rejects(supplementReception(p.path), /three_batch_limit/); assert.equal(await f.count(), 3); assert.equal(f.q.status().operations.length, 3);
  const input = JSON.parse(await readFile(join(result.receiver.directory, 'binding-input.json'), 'utf8')); assert.equal(input.data.evidence.supplements.length, 2);
  const refreshed = await f.packet({ artifactIndex: 1 }); assert.equal(refreshed.duplicate, true); assert.equal(refreshed.packet, result.packet);
  assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 3);
  const changed = await f.packet({ artifactIndex: 9 }); assert.equal(changed.duplicate, false);
  await assert.rejects(runReception(f.path), /receiver_three_batch_limit/); assert.equal(await f.count(), 3);
  const pending = f.q.status().operations.find((o: any) => o.packet === changed.packet); assert.equal(f.q.receiverEvidence(pending.id).supplements.length, 2);
});
test('a pre-opened legacy v4 dispatch cannot omit supplemental material binding; valid new executor still succeeds', async t => {
  const f = await setup(t, 'insufficient'), first = await runReception(f.path), legacy = new DatabaseSync(join(f.store, 'queue.sqlite')); t.after(() => legacy.close());
  const legacyReserve = legacy.prepare("UPDATE operations SET status='receiving',generation=?,result=?,finished_at=NULL WHERE id=?");
  f.q.enableSupplements(); await supplementReception((await supplementPlan(f, first)).path);
  legacy.exec("DROP TRIGGER receiver_packet_material_guard; CREATE TRIGGER receiver_packet_material_guard BEFORE UPDATE ON operations WHEN 0 BEGIN SELECT RAISE(ABORT,'obsolete-guard'); END");
  await assert.rejects(runReception(f.path), /supplement_guard_missing/); assert.equal(await f.count(), 1);
  assert.equal(f.q.enableSupplements().schemaVersion, 6); assert.equal(f.q.enableSupplements().duplicate, true);
  assert.throws(() => legacy.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) SELECT item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at FROM packets WHERE id=?').run(first.packet), /supplement_lineage_must_be_retained/);
  const op = f.q.begin(f.item, 'fixture-legacy-client'), result = f.q.evaluate(op.operation);
  assert.throws(() => legacyReserve.run(100, JSON.stringify({ ...result, receiver: { bindingHash: 'a'.repeat(64) } }), op.operation), /packet_material_binding_required/);
  assert.throws(() => legacyReserve.run(100, JSON.stringify({ ...result, receiver: { bindingHash: 'a'.repeat(64), packetFingerprint: f.q.receiverEvidence(op.operation).fingerprint } }), op.operation), /packet_material_binding_required/);
  assert.equal((await runReception(f.path)).receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE'); assert.equal(await f.count(), 2);
});

test('legacy supplemented packets without a base fingerprint reuse verified predecessor identity instead of redispatching', async t => {
  const f = await setup(t, 'always-insufficient'), first = await runReception(f.path); f.q.enableSupplements();
  await supplementReception((await supplementPlan(f, first)).path); const second = await runReception(f.path);
  const db = new DatabaseSync(join(f.store, 'queue.sqlite')); t.after(() => db.close());
  const saved = db.prepare('SELECT summary FROM packets WHERE id=?').get(second.packet) as any, legacy = JSON.parse(saved.summary); delete legacy.baseFingerprint;
  // Shape compatibility fixture; independent review additionally runs the actual
  // archived c491 writer to create this historical data without editing SQL.
  db.prepare('UPDATE packets SET summary=? WHERE id=?').run(JSON.stringify(legacy), second.packet);
  const refreshed = await f.packet({ artifactIndex: 1 }); assert.equal(refreshed.duplicate, true); assert.equal(refreshed.packet, second.packet);
  assert.equal((await runReception(f.path)).operation, second.operation); assert.equal(await f.count(), 2);
  await supplementReception((await supplementPlan(f, second, '{"newOriginalEvidence":2}')).path); const third = await runReception(f.path); assert.equal(await f.count(), 3);
  const after = await f.packet({ artifactIndex: 1 }); assert.equal(after.packet, third.packet); assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 3);
});

test('a single complete fenced JSON native final is consumed from the original capture; prose and multiple fences remain invalid without resend', async t => {
  const f = await setup(t, 'fenced'), r = await runReception(f.path); assert.equal(r.receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE');
  const original = await readFile(join(r.receiver.directory, 'claude/stdout.ndjson'));
  assert.ok(original.toString().includes('```json'));
  const again = await reconcileReception(f.store, r.operation); assert.equal(again.duplicate, true); assert.deepEqual(again.receiver.judgment, r.receiver.judgment); assert.equal(await f.count(), 1); assert.deepEqual(await readFile(join(r.receiver.directory, 'claude/stdout.ndjson')), original);
  for (const mode of ['fenced-prose','fenced-double']) { const g = await setup(t, mode), bad = await runReception(g.path); assert.equal(bad.status, 'receiver_invalid_result'); assert.equal((await reconcileReception(g.store, bad.operation)).status, 'receiver_invalid_result'); assert.equal(await g.count(), 1); }
});
