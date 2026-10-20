import { writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from './queue-store.js';
import { reconcileReception } from './receiver.js';
import { prepareProjectRepair, type ProjectRequest } from './project-repair.js';
import { runRepair } from './repair.js';
import { regular, exists, processState } from './repair-workspace.js';
import { hash } from './snapshot.js';
import { canonical } from './comparison.js';

type Row = Record<string, any>;
export type QueueRepairPlan = { schemaVersion: 1; kind: 'tongxu-queue-repair'; store: string; operation: string; packet: number; judgmentId: string; bindingHash: string; context: unknown;
  request: string; requestSha256: string; config: string; configSha256: string };
const uuid = /^[a-f0-9-]{36}$/, digest = /^[a-f0-9]{64}$/;
export function parseQueueRepairPlan(bytes: Buffer): QueueRepairPlan {
  const p = JSON.parse(bytes.toString());
  if (p.schemaVersion !== 1 || p.kind !== 'tongxu-queue-repair' || !uuid.test(p.operation) || !uuid.test(p.judgmentId) || !Number.isSafeInteger(p.packet) || p.packet < 1 || !digest.test(p.bindingHash) || !digest.test(p.requestSha256) || !digest.test(p.configSha256) || !p.context || Object.keys(p).sort().join() !== 'bindingHash,config,configSha256,context,judgmentId,kind,operation,packet,request,requestSha256,schemaVersion,store') throw new Error('invalid_queue_repair_plan');
  for (const path of [p.store, p.request, p.config]) if (typeof path !== 'string' || resolve(path) !== path) throw new Error('queue_repair_path_not_canonical');
  return p;
}
async function putFixed(path: string, bytes: Buffer) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (e: any) { if (e.code !== 'EEXIST') throw e; if (hash(await regular(path)) !== hash(bytes)) throw new Error('queue_repair_original_changed'); }
}
async function lock<T>(store: string, operation: string, action: () => Promise<T>) {
  if (await realpath(store) !== store) throw new Error('queue_repair_store_not_canonical');
  const path = join(store, `repair-controller-${operation}.sqlite`);
  try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  await regular(path); const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); } catch { db.close(); throw new Error('queue_repair_controller_active'); }
  try { return await action(); } finally { db.exec('ROLLBACK'); db.close(); }
}
/** Derive counts from immutable original records, not model prose or exit zero. */
export async function repairEvidence(operation: string, queueOperation: string, bindingHash: string, resultBytes: Buffer) {
  const terminalBytes = await regular(join(operation, 'terminal-record.json'), 4 * 1024 * 1024), terminal = JSON.parse(terminalBytes.toString());
  if (canonical(terminal.result) !== canonical(JSON.parse(resultBytes.toString()))) throw new Error('queue_repair_terminal_result_changed');
  const names = Object.keys(terminal.files) as string[], calls = [], candidates = new Set<string>();
  for (const path of names) {
    if (/^calls\/[^/]+\.json$/.test(path)) { const b = await regular(join(operation,path)); if (hash(b)!==terminal.files[path]) throw new Error('queue_repair_call_changed'); calls.push(JSON.parse(b.toString())); }
    if (/^attempt-\d+\/candidate-\d+\.json$/.test(path)) { const b = await regular(join(operation,path),32*1024*1024); if (hash(b)!==terminal.files[path]) throw new Error('queue_repair_candidate_changed'); candidates.add(JSON.parse(b.toString()).candidate.H); }
  }
  const result = terminal.result; if (result.after.H !== result.before.H) candidates.add(result.after.H);
  const counters = {
    recoveryAttempts: new Set(names.map(n=>/^attempt-\d+\//.exec(n)?.[0]).filter(Boolean)).size,
    nativeProcessesStarted: names.filter(n=>/^attempt-\d+\/(?:fact-and-repair|impact-\d+|review-(?:\d+|recovered))\/process\.json$/.test(n)).length,
    evidenceExchangeRoundsStarted: names.filter(n=>/^attempt-\d+\/impact-\d+\/launch\.json$/.test(n)).length,
    impactReportsCompleted: names.filter(n=>/^attempt-\d+\/impact-\d+\/completed\.json$/.test(n)).length,
    writeHandoffs: names.filter(n=>/^attempt-\d+\/repair-context-\d+\.json$/.test(n)).length,
    actualFileWrites: calls.filter(c=>c.status==='applied' && c.request?.tool==='tongxu_replace_file' && c.beforeSha256!==c.afterSha256).length,
    fixedNewCandidates: candidates.size,
    publishedReworkBatches: 0,
    publicationCountSource: 'separate verified publication events; no publication inferred from a local commit'
  };
  return { operation:queueOperation, bindingHash, resultSha256:hash(resultBytes), terminalRecordSha256:hash(terminalBytes), counters, nativeEvidenceRevalidatedBy:'runRepair terminal reader', productionActionAllowed:false };
}
export async function runQueueRepair(planPath: string, reconcileEnded = false) {
  const planBytes = await regular(planPath), p = parseQueueRepairPlan(planBytes);
  return lock(p.store,p.operation,async()=> {
    // Re-read the supplier capture before using the stored finding. No resend.
    await reconcileReception(p.store,p.operation);
    const q = await QueueStore.open(p.store), records = q.reviewRecords();
    try {
      const original = q.receiverState(p.operation), evidence = q.receiverEvidence(p.operation), r = original.receiver;
      const requestBytes = await regular(p.request), configBytes = await regular(p.config);
      if (hash(requestBytes)!==p.requestSha256 || hash(configBytes)!==p.configSha256) throw new Error('queue_repair_plan_inputs_changed');
      const request = JSON.parse(requestBytes.toString()) as ProjectRequest;
      if (request.priorReview || request.queueOperation || request.findings.length) throw new Error('queue_repair_findings_must_come_from_original');
      const effective: ProjectRequest = { ...request,
        findings:r.judgment.findings.map((f: Row,i: number)=>({id:r.judgmentId+':'+i,description:f.description})),
        priorReview:{operation:p.operation,packet:evidence.packet,judgmentId:r.judgmentId,bindingHash:r.bindingHash,inputSha256:r.inputSha256,report:r.judgment.report,findings:r.judgment.findings,context:evidence.context},
        queueOperation:{store:p.store,operation:p.operation}
      };
      const effectiveBytes = Buffer.from(JSON.stringify(effective)), registered = records.reserve(p.operation,planBytes,effectiveBytes,configBytes), bound = registered.repair.bindingHash;
      if (registered.duplicate && registered.repair.phase !== 'returned' && !registered.repair.controllerReturned && processState(registered.repair.controllerPid) !== 'ended') throw new Error('original_queue_repair_controller_active_or_unknown');
      if (registered.duplicate && registered.repair.phase !== 'returned' && !reconcileEnded) throw new Error('explicit_queue_repair_reconciliation_required');
      const requestPath = join(p.store,`repair-${p.operation}-request.json`), configPath = join(p.store,`repair-${p.operation}-config.json`);
      await putFixed(requestPath,effectiveBytes); await putFixed(configPath,configBytes);
      try {
        if (registered.repair.phase !== 'returned') records.check(p.operation,bound);
        const prepared = await prepareProjectRepair(configPath,requestPath,request.executionRoot);
        if (registered.repair.phase !== 'returned') records.controller(p.operation,bound,'prepared',{plan:prepared.plan});
        if (registered.repair.phase !== 'returned') records.controller(p.operation,bound,'dispatched',{operation:prepared.operation,reconcileEnded});
        const result = await runRepair(prepared.plan,prepared.operation,reconcileEnded,effect=>{records.check(p.operation,bound,effect);});
        const resultBytes = Buffer.from(JSON.stringify(result)), proof = await repairEvidence(prepared.operation,p.operation,bound,resultBytes);
        const receipt = records.complete(p.operation,bound,resultBytes,Buffer.from(JSON.stringify(proof)));
        return {operation:p.operation,status:'repair_result_recorded',repairStatus:result.status,after:result.after,counters:receipt.counters,duplicate:receipt.duplicate,manualReportCopyRequired:false,manualRepairRequired:false,productionActionAllowed:false};
      } catch (e) {
        records.controller(p.operation,bound,'unknown',{reason:e instanceof Error?e.message:'repair_unavailable'}); throw e;
      }
    } finally { q.close(); }
  });
}
