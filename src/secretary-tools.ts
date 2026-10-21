import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { QueueStore } from './queue-store.js';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { save } from './live-process.js';
import { exists, regular } from './repair-workspace.js';
import type { Candidate } from './live-codex.js';
import { targetKey } from './queue-evidence.js';
import type { Composition } from './composition.js';

type Row = Record<string, any>;
export const secretaryToolSpecs = [
  { type: 'function', name: 'tongxu_task_status', description: 'Read the selected task from its existing local queue, including recorded reception and publication states. This does not contact GitHub or grant any permission.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'tongxu_operation_status', description: 'Read one operation belonging to the selected task. Only IDs returned by task_status are available; no report text, paths or actions are exposed.', inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'], additionalProperties: false } }
];
// Explain exactly what was reviewed without exposing source-gap prose, report
// text, paths or arbitrary candidate extension fields to these query tools.
function subjectProjection(subject: Composition['subject'] | undefined, sha256: string | undefined) {
  if (!subject) return {};
  return { candidateRole: 'routing_anchor', subjectProjection: 'identity_and_coverage_counts_only', originalSubjectSha256: sha256,
    subject: { kind: subject.kind, repository: subject.repository, B: subject.B, targetRef: subject.targetRef,
      members: subject.members.map(m => ({ index: m.index, manifestHash: m.manifestHash, sourceGapCount: m.sourceGaps.length,
        candidate: { repository: m.candidate.repository, pr: m.candidate.pr, H: m.candidate.H, B: m.candidate.B, mergeBase: m.candidate.mergeBase, targetRef: m.candidate.targetRef } })),
      testedHead: subject.testedHead, testedTree: subject.testedTree, individualAcceptanceInferred: false } };
}
function operation(o: Row, publications: Row[]) {
  const r = o.result?.receiver, j = r?.judgment;
  return { id: o.id, packet: o.packet, status: o.status, startedAt: o.started_at, finishedAt: o.finished_at, recovery: o.recovery, ...subjectProjection(r?.subject, r?.subjectSha256),
    receiver: r ? { phase: r.phase, executionKind: r.executionKind, dispatchRegistered: !!r.dispatchRegisteredAt, currentMaterialMatches: r.currentMaterialMatches, ...(r.invalidResult?{invalidResult:r.invalidResult}:{}), ...(r.correctionOf?{correctionOf:r.correctionOf}:{}), judgment: j ? { id: j.judgmentId, verdict: j.verdict, reportSha256: hash(j.report), findings: Object.fromEntries([0, 1, 2].map(n => [`P${n}`, j.findings.filter((f: Row) => f.priority === n).length])) } : null } : null,
    publication: publications.find(p => p.operation === o.id) ?? null, productionActionAllowed: false };
}
export async function observeTask(store: string, itemId: string, candidate: Candidate) {
  const status = await QueueStore.observe(store,[],[],[itemId]), item = status.items.find((i: Row) => i.id === itemId);
  const c = item?.candidate;
  if (!c || c.repository !== candidate.repository || c.pr !== candidate.pr || c.H !== candidate.H || c.B !== candidate.B || c.targetRef !== candidate.target) throw new Error('secretary_task_candidate_mismatch');
  const operations = status.operations.filter((o: Row) => o.item === itemId);
  if (operations.length > 32) throw new Error('secretary_task_history_limit');
  return { schemaVersion: 1, role: 'secretary', item: itemId, candidate, ...subjectProjection(item.summary.composition?.subject, item.summary.composition?.sha256), ...(item.summary.composition ? { compositionCurrent: item.compositionCurrent } : {}), currentPacket: item.currentPacket, observationConflict: item.observationConflict, latestExecutionObservation: item.latestObservation, latestSourceObservation: item.latestSourceObservation,
    evidenceComplete: item.summary.evidenceComplete, dependencyGapCount: item.dependencyGaps.length, contextSha256: hash(canonical(item.context)),
    controls: status.controls.filter((c: Row) => c.scope === item.context.scope.id).map((c: Row) => ({ kind: c.kind, stopped: !!c.stopped, revision: c.revision, sourceSha256: hash(c.source), effectiveAt: c.effective_at })),
    claims: status.claims.filter((claim: Row) => claim.target === targetKey(c)).map((claim: Row) => ({ operation: claim.operation, generation: claim.generation, selectedTask: operations.some((o: Row) => o.id === claim.operation) })),
    operations: operations.map((o: Row) => operation(o, status.publications)), collaboration:status.collaboration[itemId], eventRevision: status.events.at(-1)?.id ?? 0,
    localLedgerOnly: true, externalStateRechecked: false, productionActionAllowed: false };
}
export class SecretaryTools {
  private calls = 0;
  constructor(readonly store: string, readonly item: string, readonly candidate: Candidate, readonly directory: string) {}
  async check() { if (await exists(join(this.directory, 'revoked.json'))) throw new Error('secretary_run_revoked'); }
  async call(p: { tool: string; arguments: any; callId: string }) {
    await this.check();
    if (!/^[\w-]{1,96}$/.test(p.callId) || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) throw new Error('secretary_invalid_tool_arguments');
    if (p.tool === 'tongxu_task_status' ? Object.keys(p.arguments).length !== 0 : p.tool !== 'tongxu_operation_status' || Object.keys(p.arguments).join() !== 'operation' || typeof p.arguments.operation !== 'string') throw new Error('secretary_query_not_allowed');
    const calls = join(this.directory, 'queries'); await mkdir(calls, { mode: 0o700, recursive: true }); const path = join(calls, p.callId + '.json');
    if (await exists(path)) { const prior = JSON.parse((await regular(path)).toString()); if (canonical(prior.request) !== canonical(p)) throw new Error('secretary_conflicting_query_id'); return prior.response; }
    if (++this.calls > 8) throw new Error('secretary_query_budget');
    const state = await observeTask(this.store, this.item, this.candidate);
    const data = p.tool === 'tongxu_task_status' ? state : state.operations.find((o: Row) => o.id === p.arguments.operation);
    if (!data) throw new Error('secretary_operation_outside_task');
    const observation = { queryId: p.callId, observedAt: new Date().toISOString(), eventRevision: state.eventRevision, data, localLedgerOnly: true };
    const observationId = hash(canonical(observation));
    const response = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ observationId, ...observation }) }] };
    save(path, { request: p, observationId, observation, response }); return response;
  }
  async observations() {
    const path = join(this.directory, 'queries'); if (!await exists(path)) return [];
    return Promise.all((await readdir(path)).sort().map(async name => {
      if (!/^[\w-]+\.json$/.test(name)) throw new Error('secretary_query_file_invalid');
      const row = JSON.parse((await regular(join(path, name))).toString());
      if (hash(canonical(row.observation)) !== row.observationId || row.response?.contentItems?.[0]?.text !== JSON.stringify({ observationId: row.observationId, ...row.observation })) throw new Error('secretary_query_record_changed');
      return row;
    }));
  }
}
