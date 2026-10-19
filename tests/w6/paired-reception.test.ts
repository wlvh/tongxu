import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setup, waitPhase } from '../w3/receiver-fixture.js';
import { runReception } from '../../src/receiver.js';
import { runPairedReception, type PairPlan } from '../../src/paired-reception.js';
import { hash } from '../../src/snapshot.js';

async function fixture(t: test.TestContext, mode = 'delay') {
  const f = await setup(t, mode, 2); f.q.enableSupplements();
  const b = await f.packet({ pr: 2, target: 'consumer-target' }), secondPlan = { ...f.plan, item: b.item }, secondPath = join(f.root, 'second-plan.json');
  await writeFile(secondPath, JSON.stringify(secondPlan));
  const pair: PairPlan = { schemaVersion: 1, kind: 'tongxu-paired-reception', source: 'fixture:two-independent-reception-tasks', first: { path: f.path, sha256: hash(await readFile(f.path)) }, second: { path: secondPath, sha256: hash(await readFile(secondPath)) } };
  const path = join(f.root, 'pair.json'), bytes = Buffer.from(JSON.stringify(pair)); await writeFile(path, bytes);
  return { ...f, b: b.item, pair, pairPath: path, pairBytes: bytes, id: hash(bytes), secondPath,
    register: () => f.q.registerPair(bytes, f.item, b.item, pair.source) };
}
test('one entry lets B inspect while A runs, then automatically delivers A result and consumes it in B; repeat sends zero', async t => {
  const f = await fixture(t), r = await runPairedReception(f.pairPath);
  assert.equal(r.status, 'completed'); assert.equal(r.sharedResultConsumed, true); assert.equal(await f.count(), 2);
  const s = f.q.status(), early = s.events.find((e: any) => e.kind === 'pair_independent_inspection');
  assert.equal(JSON.parse(early.data).predecessorAtObservation, 'receiving');
  const waiting = s.events.find((e: any) => e.kind === 'pair_shared_waiting'); assert.ok(waiting);
  const aFinal = s.events.find((e: any) => e.kind === 'receiver_judgment_recorded' && e.object === r.first.operation), bDispatch = s.events.find((e: any) => e.kind === 'receiver_dispatch_registered' && e.object === r.second.operation);
  assert.ok(early.id < aFinal.id && aFinal.id < bDispatch.id); assert.equal(s.claims.length, 0);
  const input = JSON.parse(await readFile(join(r.second.receiver.directory, 'binding-input.json'), 'utf8'));
  assert.deepEqual(input.data.evidence.prerequisite.judgment, r.first.receiver.judgment);
  assert.equal(input.data.evidence.prerequisite.receiptSha256, r.second.receiver.judgment.consumedPrerequisite);
  const trace = await readFile(f.trace), again = await runPairedReception(f.pairPath);
  assert.equal(again.status, 'completed'); assert.equal(again.first.operation, r.first.operation); assert.equal(again.second.operation, r.second.operation); assert.deepEqual(await readFile(f.trace), trace);
});
test('direct downstream entry cannot skip the gate; its independent inspection can finish without taking a waiting seat', async t => {
  const f = await fixture(t); f.register(); const a = runReception(f.path); await waitPhase(f.q, 'dispatch_registered');
  try {
    await assert.rejects(runReception(f.secondPath), /paired_upstream/);
    const s = f.q.status(); assert.equal(s.operations.find((o: any) => o.item === f.b).status, 'complete'); assert.equal(s.claims.length, 1);
    assert.ok(await f.count() <= 1);
  } finally { await a; }
  assert.equal(await f.count(), 1); assert.equal((await runReception(f.secondPath)).receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE');
});
test('a pre-opened old SQL client cannot reserve B without its bound prerequisite, even after A is accepted', async t => {
  const f = await fixture(t), legacy = new DatabaseSync(join(f.store, 'queue.sqlite')); t.after(() => legacy.close());
  f.register(); const b = f.q.begin(f.b, 'fixture:independent'); f.q.evaluate(b.operation);
  const op = f.q.status().operations.find((o: any) => o.id === b.operation), packet = f.q.status().items.find((i: any) => i.id === f.b).currentPacket;
  const fingerprint = (legacy.prepare('SELECT fingerprint FROM packets WHERE id=?').get(packet) as any).fingerprint;
  const forgedOldRecord = JSON.stringify({ ...op.result, receiver: { contractVersion: 6, packetFingerprint: fingerprint, phase: 'reserved' } });
  const old = legacy.prepare("UPDATE operations SET status='receiving',result=? WHERE id=?");
  assert.throws(() => old.run(forgedOldRecord, op.id), /paired_reception_stage_blocked/);
  await runReception(f.path); assert.throws(() => old.run(forgedOldRecord, op.id), /paired_reception_stage_blocked/);
  assert.equal(f.q.status().operations.find((o: any) => o.id === op.id).status, 'complete');
});
test('investment stop prevents new calls while original results can be read and later continue the same pair', async t => {
  const f = await fixture(t); f.register(); const a = await runReception(f.path);
  f.q.control('scope', 'investment', 'stopped', 'fixture:owner-stop'); const paused = await runPairedReception(f.pairPath);
  assert.equal(paused.status, 'waiting_or_unresolved'); assert.equal(await f.count(), 1); assert.equal(paused.first.operation, a.operation);
  f.q.control('scope', 'investment', 'open', 'fixture:explicit-resume'); const r = await runPairedReception(f.pairPath);
  assert.equal(r.status, 'completed'); assert.equal(await f.count(), 2); assert.equal(r.first.operation, a.operation);
});
test('upstream insufficient result keeps only the shared stage waiting; repeat never replaces it', async t => {
  const f = await fixture(t, 'always-insufficient'); const r = await runPairedReception(f.pairPath);
  assert.equal(r.status, 'waiting_or_unresolved'); assert.match(r.blocked!, /paired_upstream/); assert.ok(r.independent.operation); assert.equal(r.second, null); assert.equal(await f.count(), 1);
  await runPairedReception(f.pairPath); assert.equal(await f.count(), 1);
});
test('missing B consumption reference remains unresolved and is not resent', async t => {
  const f = await fixture(t); const exe = f.plan.claudeExecutable, code = await readFile(exe, 'utf8');
  await writeFile(exe, code.replace('x.data.evidence.prerequisite.receiptSha256', "'0'.repeat(64)"));
  const r = await runPairedReception(f.pairPath); assert.equal(r.status, 'waiting_or_unresolved'); assert.equal(r.second.status, 'receiver_unknown'); assert.match(r.second.reason, /not_consumed/); assert.equal(await f.count(), 2);
  const again = await runPairedReception(f.pairPath); assert.equal(again.status, 'waiting_or_unresolved'); assert.equal(await f.count(), 2);
});
test('a newer upstream candidate blocks B and makes a prior B judgment inapplicable without changing either original', async t => {
  const f = await fixture(t); f.register(); await runReception(f.path); await f.packet({ H: await f.newHead() });
  const r = await runPairedReception(f.pairPath); assert.equal(r.status, 'waiting_or_unresolved'); assert.match(r.blocked!, /candidate_or_material_changed/); assert.equal(await f.count(), 1);
  const g = await fixture(t); const done = await runPairedReception(g.pairPath), original = done.second.receiver.judgment;
  await g.packet({ H: await g.newHead() }); const old = g.q.receiverState(done.second.operation);
  assert.equal(old.result.receiver.currentMaterialMatches, false); assert.deepEqual(old.result.receiver.judgment, original);
});
test('two controllers and changed plans cannot start competing model tasks', async t => {
  const f = await fixture(t), child = spawn(process.execPath, [fileURLToPath(new URL('../../src/paired-reception-cli.js', import.meta.url)), 'run', '--plan', f.pairPath], { stdio: 'ignore' }), ended = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waitPhase(f.q, 'dispatch_registered');
  await assert.rejects(runPairedReception(f.pairPath), /pair_controller_active/); assert.equal((await ended)[0], 0); assert.equal(await f.count(), 2);
  await writeFile(f.pairPath, JSON.stringify({ ...f.pair, source: 'fixture:changed-arrangement' })); await assert.rejects(runPairedReception(f.pairPath), /pair_already_bound/); assert.equal(await f.count(), 2);
});

test('a killed pair controller resumes the captured A and starts B exactly once in the original store', { timeout: 15000 }, async t => {
  const f = await fixture(t), marker = join(f.root, 'captured-upstream.json'), script = join(f.root, 'pause-pair.mjs');
  await writeFile(script, `import fs from 'node:fs';import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js', import.meta.url).href)};import {runPairedReception} from ${JSON.stringify(new URL('../../src/paired-reception.js', import.meta.url).href)};
const original=QueueStore.prototype.pairedStatus;QueueStore.prototype.pairedStatus=function(id){const s=original.call(this,id);if(s.prerequisite&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(s.prerequisite));process.kill(process.pid,'SIGSTOP');}return s;};await runPairedReception(${JSON.stringify(f.pairPath)});`);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' }), exited = once(child, 'exit'); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let receipt: any;
  for (let i = 0; i < 600; i++) { try { receipt = JSON.parse(await readFile(marker, 'utf8')); break; } catch {} await new Promise(r => setTimeout(r, 10)); }
  assert.ok(receipt); child.kill('SIGKILL'); await exited; assert.equal(await f.count(), 1);
  const before = await readFile(join(f.store, 'receiver-' + receipt.operation, 'claude/stdout.ndjson'));
  const result = await runPairedReception(f.pairPath); assert.equal(result.status, 'completed'); assert.equal(result.first.operation, receipt.operation); assert.equal(await f.count(), 2);
  assert.deepEqual(await readFile(join(f.store, 'receiver-' + receipt.operation, 'claude/stdout.ndjson')), before);
  await runPairedReception(f.pairPath); assert.equal(await f.count(), 2);
});
