import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from './queue-store.js';
import { reconcileReception } from './receiver.js';
import { canonical } from './comparison.js';
import { hash, privateDirectory } from './snapshot.js';
import { PublicationHttp, ordinaryFile } from './publication-http.js';

import {parsePublicationPlan as plan,publicationAuthorityPayloadSha,type PublicationPlan as Plan} from './publication-contract.js';
import {publicationGovernance} from './publication-governance.js';
import {requirePublicationExit,requirePublicationProcessEnded} from './publication-process.js';
type Row = Record<string, any>;
export function publicDocument(p: Plan, state: Row): Row {
  const r = state.receiver, input = JSON.parse(state.input.toString()), j = r.judgment, c = state.result.candidate;
  const candidate = { repository: c.repository, pr: c.pr, H: c.H, B: c.B, targetRef: c.targetRef };
  if (r.phase !== 'returned' || r.executionKind !== 'native_capture' || state.result.independentReception !== 'judgment_recorded' || input.binding.operation !== p.operation || input.binding.role !== 'receiver') throw new Error('publication_requires_complete_native_judgment');
  const materialDigest = input.binding.materialSha256 === hash(canonical(input.data)) ? 'matches_submitted_json' : 'historical_derived_digest_mismatch';
  const publicScopeReferences = ['scope', 'arrangement'].flatMap(kind => {
    const source = input.binding.context[kind]?.source;
    const prefix = `https://github.com/${candidate.repository}/issues/`;
    return typeof source === 'string' && source.startsWith(prefix) && /^[1-9][0-9]*(?:#issuecomment-[1-9][0-9]*)?$/.test(source.slice(prefix.length)) ? [{ kind, reportedReference: source }] : [];
  });
  const core = { template: 'tongxu-fixed-reception-v1', operation: p.operation, judgmentId: j.judgmentId, bindingHash: r.bindingHash, inputSha256: r.inputSha256, rawOutputSha256: r.blobs['stdout.ndjson'].sha256, reportTextSha256: hash(j.report), contextSha256: hash(canonical(input.binding.context)), publicScopeReferences, candidate, judgment: j.verdict, findingCounts: Object.fromEntries([0, 1, 2].map(n => [`P${n}`, j.findings.filter((f: Row) => f.priority === n).length])), materialDigest, repositoryId: p.repositoryId, expectedPublisherActor: { id: p.actor.id, login: p.actor.login }, publicationAuthoritySourceSha256: hash(p.source), productionActionAllowed: false };
  const publicationId = hash(canonical(core));
  // Only this allowlisted projection is public. Never emit model text, local
  // paths, full source references or arbitrary links, even inside markdown.
  const json = JSON.stringify({ publicationId, ...core }, null, 2).replaceAll('`', '\\u0060').replaceAll('@', '\\u0040').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  const commentBody = `<!-- tongxu-publication:${publicationId} -->\n同序固定接收记录\n\n这是程序生成的事实记录；API执笔者以GitHub记录为准，expectedPublisherActor是固定预期，不是本人批准、合并或部署授权。模型任务已经结束；pending 表示材料仍有保留，不表示后台任务仍在运行。私人报告和输入原文保留在原接收现场。\n\n\`\`\`json\n${json}\n\`\`\`\n`;
  const status = { context: `tongxu/reception/${publicationId}`, state: j.verdict === 'RETURN_FOR_WORK' ? 'failure' : materialDigest !== 'matches_submitted_json' || j.verdict === 'INSUFFICIENT_EVIDENCE' ? 'pending' : 'success', description: materialDigest !== 'matches_submitted_json' ? 'Scoped judgment recorded; historical digest caveat; no merge permission' : `Scoped ${j.verdict}; no merge permission` };
  return { ...core, publicationId, commentBody, status };
}
async function lock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(directory, false); const path = join(directory, 'publisher-controller.sqlite');
  try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  await ordinaryFile(path, 8 * 1024 * 1024); const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); } catch { db.close(); throw new Error('publication_controller_active'); }
  try { return await action(); } finally { db.exec('ROLLBACK'); db.close(); }
}
function actorMatches(actor: Row | undefined, p: Plan) { return actor?.id === p.actor.id && typeof actor.login === 'string' && actor.login.toLowerCase() === p.actor.login.toLowerCase(); }
function repoPath(d: Row) { return `repos/${d.candidate.repository}`; }
async function current(http: PublicationHttp, p: Plan, d: Row): Promise<Row> {
  const targetPath = `${repoPath(d)}/git/ref/heads/${encodeURIComponent(d.candidate.targetRef)}`;
  const before = await http.request('GET', targetPath), actor = await http.request('GET', 'user'), repo = await http.request('GET', repoPath(d)), pr = await http.request('GET', `${repoPath(d)}/pulls/${d.candidate.pr}`), ref = await http.request('GET', targetPath);
  if ([before, actor, repo, pr, ref].some(x => x.status !== 200)) throw new Error('publication_preflight_unavailable');
  if (!actorMatches(actor.value, p)) throw new Error('publication_actor_changed');
  if (repo.value.id !== p.repositoryId || repo.value.full_name?.toLowerCase() !== d.candidate.repository.toLowerCase() || repo.value.permissions?.push !== true) throw new Error('publication_repository_permission_unverified');
  const v = pr.value, c = d.candidate;
  if (v.number !== c.pr || v.state !== 'open' || v.head?.repo?.id !== p.repositoryId || v.base?.repo?.id !== p.repositoryId || v.head.sha !== c.H || v.base.ref !== c.targetRef || [before,ref].some(r=>r.value.ref !== `refs/heads/${c.targetRef}` || r.value.object?.type !== 'commit' || r.value.object.sha !== c.B)) throw new Error('publication_remote_candidate_changed');
  return { actor: { id: actor.value.id, login: actor.value.login }, repositoryId: repo.value.id, H: v.head.sha, B: ref.value.object.sha, prReportedBase: v.base.sha, target: v.base.ref, observedAt: new Date().toISOString(), nonAtomicRemoteObservation: true };
}
function commentMatches(v: Row, p: Plan, d: Row) {
  return Number.isSafeInteger(v.id) && v.id > 0 && actorMatches(v.user, p) && v.body === d.commentBody && v.issue_url === `https://api.github.com/${repoPath(d)}/issues/${d.candidate.pr}` && v.html_url === `https://github.com/${d.candidate.repository}/pull/${d.candidate.pr}#issuecomment-${v.id}`;
}
function statusPayload(d: Row, comment: Row) { return { ...d.status, target_url: comment.url }; }
function statusMatches(v: Row, p: Plan, d: Row, comment: Row) {
  const expected = statusPayload(d, comment);
  return Number.isSafeInteger(v.id) && v.id > 0 && actorMatches(v.creator, p) && Object.entries(expected).every(([k, value]) => v[k] === value);
}
async function findRemote(http: PublicationHttp, p: Plan, d: Row, stage: string, comment?: Row, expectedId?: number) {
  const originals: Record<string, Buffer> = {}, observations: Row[] = [];
  const remember = (r: { directory: string; status: number; body: Buffer }) => { const name = `readback-${observations.length}`; originals[name] = r.body; observations.push({ directory: r.directory, status: r.status, bodySha256: hash(r.body), blob: name }); };
  if (stage === 'comment' && expectedId) {
    const r = await http.request('GET', `${repoPath(d)}/issues/comments/${expectedId}`);
    remember(r);
    if (r.status !== 200 || !commentMatches(r.value, p, d)) return { matches: [], complete: [200, 404].includes(r.status), conflict: r.status === 200, originals, observations };
  }
  const matches: Row[] = []; let conflict = false;
  for (let page = 1; page <= 10; page++) {
    const r = await http.request('GET', `${repoPath(d)}/${stage === 'comment' ? `issues/${d.candidate.pr}/comments` : `commits/${d.candidate.H}/statuses`}?per_page=100&page=${page}`);
    remember(r);
    if (r.status !== 200 || !Array.isArray(r.value) || r.value.length > 100) return { matches, complete: false, conflict, originals, observations };
    for (const value of r.value) {
      // GitHub compares status contexts without case. A case variant belongs
      // to this same effective status and must reach the conflict checks.
      const selected = stage === 'comment' ? typeof value.body === 'string' && value.body.includes(`<!-- tongxu-publication:${d.publicationId} -->`) : typeof value.context === 'string' && value.context.toLowerCase() === d.status.context.toLowerCase();
      if (!selected) continue;
      const match = stage === 'comment' ? commentMatches(value, p, d) : statusMatches(value, p, d, comment!);
      if (!match || expectedId && value.id !== expectedId) conflict = true;
      if (match) matches.push(stage === 'comment' ? { id: value.id, url: value.html_url, bodySha256: hash(value.body) } : { id: value.id, ...statusPayload(d, comment!), candidateH: d.candidate.H });
    }
    if (r.value.length < 100) return { matches, complete: true, conflict, originals, observations };
  }
  return { matches, complete: false, conflict, originals, observations };
}
async function originalEnded(stage: Row) {
  if (!stage.intent) return;
  const directory = stage.intent.directory;
  try {
    const exit = JSON.parse((await ordinaryFile(join(directory, 'exit.json'), 4096)).toString());
    requirePublicationExit(exit);
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  requirePublicationProcessEnded(stage.started?.pid,stage.started?.identity);
}
async function stageWork(q: QueueStore, http: PublicationHttp, p: Plan, d: Row, name: 'comment' | 'status', allowWrite: boolean, retrySource?: string,governance?:ReturnType<typeof publicationGovernance>): Promise<boolean> {
  let state = q.publicationState(p.operation), stage = state.stages[name], comment = state.stages.comment.verified?.remote;
  if (name === 'status' && state.stages.comment.lastState !== 'verified') return false;
  if (stage.intent) await originalEnded(stage);
  const found = await findRemote(http, p, d, name, comment, stage.verified?.remote.id);
  if (found.complete && !found.conflict && found.matches.length === 1 && stage.intent) {
    q.publicationEvent(p.operation, 'verified', name, { remote: found.matches[0], recovered: stage.lastState !== 'verified', readAt: new Date().toISOString(), observations: found.observations }, found.originals); return true;
  }
  if (!found.complete || found.conflict || found.matches.length > 0) {
    q.publicationEvent(p.operation, 'problem', name, { reason: !found.complete ? 'remote_read_incomplete' : 'remote_identity_or_content_conflict', observations: found.observations }, found.originals);
    return false;
  }
  if (stage.intent && (!retrySource || !stage.response?.rejected || stage.lastState === 'verified')) { q.publicationEvent(p.operation, 'problem', name, { reason: stage.response?.rejected ? 'remote_rejected' : 'remote_result_unknown' }); return false; }
  if (!allowWrite) return false;
  const observed = await current(http, p, d);
  await governance?.beforeWrite();
  const payload = name === 'comment' ? { body: d.commentBody } : statusPayload(d, comment);
  const endpoint=`${repoPath(d)}/${name === 'comment' ? `issues/${d.candidate.pr}/comments` : `statuses/${d.candidate.H}`}`;
  let reply;
  try {
    reply = await http.request('POST', endpoint, payload, {
      ...(p.governance?{dispatch:(directory:string,effect:()=>void)=>{q.publicationDispatchPrepared(p.operation,name,{directory,endpoint,requestSha256:hash(canonical(payload)),controllerPid:process.pid,remotePreflight:observed},{request:Buffer.from(JSON.stringify(payload)),preflight:Buffer.from(JSON.stringify(observed))},stage.intent?retrySource:undefined);q.publicationEffect(p.operation,name,directory,governance!.observations,effect);}}:{}),
      intent: directory => q.publicationEvent(p.operation, 'intent', name, { directory, requestSha256: hash(canonical(payload)), controllerPid: process.pid, remotePreflight: observed }, { request: Buffer.from(JSON.stringify(payload)), preflight: Buffer.from(JSON.stringify(observed)) }, stage.intent ? retrySource : undefined),
      started: (pid,identity) => q.publicationEvent(p.operation, 'started', name, { pid,identity })
    });
  } catch (e) {
    state = q.publicationState(p.operation); if (state.stages[name].intent) q.publicationEvent(p.operation, 'problem', name, { reason: e instanceof Error ? e.message : 'publication_request_unknown' }); throw e;
  }
  const rejected = [400, 401, 403, 404, 410, 422, 429].includes(reply.status);
  q.publicationEvent(p.operation, 'response', name, { status: reply.status, rejected, directory: reply.directory }, { response: reply.body });
  if (reply.status !== 201) { q.publicationEvent(p.operation, 'problem', name, { reason: rejected ? 'remote_rejected' : 'remote_result_unknown' }); return false; }
  const valid = name === 'comment' ? commentMatches(reply.value, p, d) : statusMatches(reply.value, p, d, comment);
  if (!valid) { q.publicationEvent(p.operation, 'problem', name, { reason: 'post_response_mismatch' }); return false; }
  const verified = await findRemote(http, p, d, name, comment, reply.value.id);
  if (!verified.complete || verified.conflict || verified.matches.length !== 1) { q.publicationEvent(p.operation, 'problem', name, { reason: 'remote_readback_unverified' }); return false; }
  q.publicationEvent(p.operation, 'verified', name, { remote: verified.matches[0], recovered: false, readAt: new Date().toISOString(), observations: verified.observations }, verified.originals); return true;
}
export async function publication(planPath: string, action: 'prepare' | 'publish' | 'reconcile' | 'retry-rejected', retrySource?: string) {
  const bytes = await ordinaryFile(planPath, 1024 * 1024), p = plan(bytes), q = await QueueStore.open(p.store);
  try {
    if(p.governance)q.authority().enableGovernedPublication();
    await reconcileReception(p.store, p.operation);
    const original = q.receiverState(p.operation), d = publicDocument(p, original), directory = original.receiver.directory;
    return await lock(directory, async () => {
      let state = q.preparePublication(p.operation, bytes, Buffer.from(JSON.stringify(d)), action === 'prepare');
      const governance=publicationGovernance(q,p);await governance.recover();state=q.publicationState(p.operation);
      const preview = join(directory, `publication-preview-${d.publicationId}.json`);
      try { await writeFile(preview, JSON.stringify(d, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; if (canonical(JSON.parse((await ordinaryFile(preview, 1024 * 1024)).toString())) !== canonical(d)) throw new Error('publication_preview_changed'); }
      if (action === 'prepare') return { operation: p.operation, publicationId: d.publicationId, status: state.events.some((e:Row)=>['intent','recovered_intent'].includes(e.kind))?'prepared_original_dispatch_exists':'prepared_not_sent', newRequestsSent:0, documentSha256:state.prepared.documentSha256, publicationPayloadSha256:publicationAuthorityPayloadSha(p,state.prepared.documentSha256), preview, channel: p.channel, githubState: d.status.state, judgment: d.judgment, productionActionAllowed: false };
      if (action === 'retry-rejected' && (!retrySource?.trim() || retrySource.length > 2048 || !Object.values(state.stages).some((s: any) => s.response?.rejected && s.lastState !== 'verified'))) throw new Error('publication_explicit_rejected_retry_required');
      const http = new PublicationHttp(directory, p.ghExecutable, p.ghSha256, d.candidate.repository, d.candidate.pr, d.candidate.H, d.candidate.targetRef);
      const detail = await stageWork(q, http, p, d, 'comment', action !== 'reconcile', action === 'retry-rejected' ? retrySource : undefined,governance);
      const status = detail && await stageWork(q, http, p, d, 'status', action !== 'reconcile', action === 'retry-rejected' ? retrySource : undefined,governance);
      let remoteCurrent = false, remoteCheckError: string | null = null;
      try { await current(http, p, d); remoteCurrent = true; } catch (e) { remoteCheckError = e instanceof Error ? e.message : 'current_remote_unknown'; }
      const resources=await governance.settle(),final = q.publicationState(p.operation);
      const repairBatches=detail&&status?q.reconcilePublishedRepairBatches():null;
      return { operation: p.operation, publicationId: d.publicationId, resources, resourcesSettled:p.governance?p.governance.resourceRequests.every(id=>q.resources().settledOutcome(id)):null, repairBatches, status: detail && status ? 'published_verified' : 'publication_pending_or_unknown', channel: p.channel, githubState: d.status.state, judgment: d.judgment, materialDigest: d.materialDigest, comment: final.stages.comment.verified?.remote ?? null, commitStatus: final.stages.status.verified?.remote ?? null, stages: final.stages, localMaterialCurrent: q.receiverState(p.operation).result.receiver.currentMaterialMatches, remoteCurrent, remoteCheckError, privateReportPublished: false, modelTasksStarted: 0, productionActionAllowed: false };
    });
  } finally { q.close(); }
}
