import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, privateDirectory } from './snapshot.js';
import { exists, regular } from './repair-workspace.js';
import { save } from './live-process.js';
import { QueueStore } from './queue-store.js';
import { runReception, parseReceiverPlan, type ReceiverPlan } from './receiver.js';

type Ref = { path: string; sha256: string };
export type PairPlan = { schemaVersion: 1; kind: 'tongxu-paired-reception'; source: string; first: Ref; second: Ref };
const digest = /^[a-f0-9]{64}$/;
async function readPlan(path: string) {
  const bytes = await regular(path), p = JSON.parse(bytes.toString()) as PairPlan;
  if (p.schemaVersion !== 1 || p.kind !== 'tongxu-paired-reception' || typeof p.source !== 'string' || !p.source.trim() || p.source.length > 2048) throw new Error('invalid_pair_plan');
  const plans: Array<{ bytes: Buffer; plan: ReceiverPlan }> = [];
  for (const ref of [p.first, p.second]) {
    if (!ref || !digest.test(ref.sha256)) throw new Error('invalid_pair_plan_reference');
    const b = await regular(ref.path); if (hash(b) !== ref.sha256) throw new Error('pair_receiver_plan_changed');
    const plan = parseReceiverPlan(b);
    if (plan.kind !== 'tongxu-queue-receiver' || plan.schemaVersion !== 1 || !digest.test(plan.item) || !['native_capture', 'fixture'].includes(plan.executionKind)) throw new Error('pair_requires_receiver_plans');
    plans.push({ bytes: b, plan });
  }
  const [first, second] = plans as [typeof plans[number], typeof plans[number]];
  if (first.plan.store !== second.plan.store || first.plan.item === second.plan.item || first.plan.executionKind !== second.plan.executionKind) throw new Error('pair_scope_or_execution_kind_mismatch');
  return { bytes, p, first, second };
}

/** Two fixed tasks, only their shared reception phase is serial. */
export async function runPairedReception(path: string) {
  const { bytes, p, first, second } = await readPlan(path), q = await QueueStore.open(first.plan.store), id = hash(bytes);
  let lock: DatabaseSync | undefined;
  try {
    const pair = q.registerPair(bytes, first.plan.item, second.plan.item, p.source), directory = join(q.directory, 'pair-' + id);
    if (!await exists(directory)) await privateDirectory(directory, true); else await privateDirectory(directory, false);
    const lockPath = join(directory, 'controller.sqlite');
    try { await writeFile(lockPath, '', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    await regular(lockPath); lock = new DatabaseSync(lockPath); lock.exec('PRAGMA busy_timeout=0');
    try { lock.exec('BEGIN IMMEDIATE'); } catch { lock.close(); lock = undefined; throw new Error('pair_controller_active'); }
    for (const [name, b] of [['plan.json', bytes], ['first-plan.json', first.bytes], ['second-plan.json', second.bytes]] as const) {
      const file = join(directory, name);
      if (await exists(file)) { if (!(await regular(file)).equals(b)) throw new Error('pair_frozen_plan_changed'); }
      else await writeFile(file, b, { flag: 'wx', mode: 0o600 });
    }
    // Start A once; B's independent local inspection can join while A runs.
    // Always await A even if B fails: no orphaned promise or invisible model.
    let settled = false;
    const upstream = runReception(join(directory, 'first-plan.json')).then(value => ({ value, error: null }), error => ({ value: null, error: error instanceof Error ? error.message : 'upstream_failed' })).finally(() => { settled = true; });
    let independent: any, independentError: string | null = null;
    try {
      while (!settled && !q.pairedStatus(id).operations.some((o: any) => o.item === first.plan.item && o.status === 'receiving')) await new Promise(r => setTimeout(r, 25));
      const started = q.begin(second.plan.item, 'paired-independent-material-inspection');
      independent = started.blocked ? started : q.receiverState(started.operation).receiver ? { operation: started.operation, duplicate: true, inspectionPreviouslyCompleted: true } : q.evaluate(started.operation);
      q.pairNote(id, 'independent_inspection', { operation: independent.operation ?? null, blocked: independent.blocked ?? [], predecessorAtObservation: q.pairedStatus(id).operations.find((o: any) => o.item === first.plan.item)?.status ?? 'not_started' });
      const gate = q.pairedStatus(id);
      if (gate.blocked) q.pairNote(id, 'shared_waiting', { reason: gate.blocked, independentOperation: independent.operation ?? null, newDownstreamModelSent: false });
    } catch (e) { independentError = e instanceof Error ? e.message : 'independent_inspection_failed'; }
    const a = await upstream, state = q.pairedStatus(id);
    let downstream: any = null, downstreamError: string | null = null;
    if (!a.error && !state.blocked && !independentError && !independent?.blocked) {
      try {
        downstream = await runReception(join(directory, 'second-plan.json'));
        const consumed = downstream.receiver?.judgment?.consumedPrerequisite;
        if (consumed && downstream.receiver.currentMaterialMatches && consumed === state.prerequisite?.receiptSha256) q.pairNote(id, 'shared_consumed', { operation: downstream.operation, prerequisiteReceiptSha256: consumed, judgmentId: downstream.receiver.judgmentId });
      } catch (e) { downstreamError = e instanceof Error ? e.message : 'downstream_failed'; }
    }
    const current = q.pairedStatus(id), accepted = downstream?.receiver?.phase === 'returned' && downstream.receiver.currentMaterialMatches && downstream.receiver.judgment?.consumedPrerequisite === current.prerequisite?.receiptSha256;
    const result = { kind: 'tongxu-paired-reception-result', pair: id, executionKind: first.plan.executionKind, status: accepted ? 'completed' : 'waiting_or_unresolved', first: a.value, firstError: a.error, independent, independentError, second: downstream, secondError: downstreamError, blocked: current.blocked, directory, sharedResultConsumed: !!accepted, productionActionAllowed: false, automaticResend: false, duplicateRegistration: pair.duplicate };
    save(join(directory, 'result.json'), result); return result;
  } finally { if (lock) { lock.exec('ROLLBACK'); lock.close(); } q.close(); }
}
