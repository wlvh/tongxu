import { writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from './queue-store.js';
import { reconcileReception } from './receiver.js';
import { canonical } from './comparison.js';
import { hash, privateDirectory } from './snapshot.js';
import { PublicationHttp, ordinaryFile } from './publication-http.js';

const digest = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9-]{36}$/;
type Plan = { schemaVersion: 1; kind: 'tongxu-reception-publication'; store: string; operation: string; channel: 'commit-status'; ghExecutable: string; ghSha256: string; repositoryId: number; actor: { id: number; login: string }; source: string };
type Row = Record<string, any>;
function plan(bytes: Buffer): Plan {
  const p = JSON.parse(bytes.toString());
  if (p.schemaVersion !== 1 || p.kind !== 'tongxu-reception-publication' || p.channel !== 'commit-status' || !uuid.test(p.operation) || !digest.test(p.ghSha256) || !Number.isSafeInteger(p.repositoryId) || p.repositoryId < 1 || !Number.isSafeInteger(p.actor?.id) || p.actor.id < 1 || !/^[A-Za-z0-9-]{1,39}$/.test(p.actor.login) || typeof p.source !== 'string' || !p.source.trim() || p.source.length > 2048 || p.source.includes('\0') || Object.keys(p).some(k => !['schemaVersion', 'kind', 'store', 'operation', 'channel', 'ghExecutable', 'ghSha256', 'repositoryId', 'actor', 'source'].includes(k))) throw new Error('invalid_publication_plan');
  for (const v of [p.store, p.ghExecutable]) if (typeof v !== 'string' || !isAbsolute(v) || resolve(v) !== v) throw new Error('invalid_publication_path');
  return p;
}
function publicDocument(p: Plan, state: Row): Row {
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
  const actor = await http.request('GET', 'user'), repo = await http.request('GET', repoPath(d)), pr = await http.request('GET', `${repoPath(d)}/pulls/${d.candidate.pr}`), ref = await http.request('GET', `${repoPath(d)}/git/ref/heads/${encodeURIComponent(d.candidate.targetRef)}`);
  if ([actor, repo, pr, ref].some(x => x.status !== 200)) throw new Error('publication_preflight_unavailable');
  if (!actorMatches(actor.value, p)) throw new Error('publication_actor_changed');
  if (repo.value.id !== p.repositoryId || repo.value.full_name?.toLowerCase() !== d.candidate.repository.toLowerCase() || repo.value.permissions?.push !== true) throw new Error('publication_repository_permission_unverified');
  const v = pr.value, c = d.candidate;
  if (v.number !== c.pr || v.state !== 'open' || v.head?.repo?.id !== p.repositoryId || v.base?.repo?.id !== p.repositoryId || v.head.sha !== c.H || v.base.sha !== c.B || v.base.ref !== c.targetRef || ref.value.ref !== `refs/heads/${c.targetRef}` || ref.value.object?.type !== 'commit' || ref.value.object.sha !== c.B) throw new Error('publication_remote_candidate_changed');
  return { actor: { id: actor.value.id, login: actor.value.login }, repositoryId: repo.value.id, H: v.head.sha, B: v.base.sha, target: v.base.ref, observedAt: new Date().toISOString(), nonAtomicRemoteObservation: true };
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
      const selected = stage === 'comment' ? typeof value.body === 'string' && value.body.includes(`<!-- tongxu-publication:${d.publicationId} -->`) : value.context === d.status.context;
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
    if (!(exit.code === null || Number.isSafeInteger(exit.code) && exit.code >= 0) || !(exit.signal === null || typeof exit.signal === 'string' && exit.signal.length > 0) || typeof exit.finishedAt !== 'string') throw new Error('publication_exit_record_invalid');
    if (exit.code !== null || exit.signal !== null) return;
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const pid = stage.started?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('publication_original_process_unknown');
  try { process.kill(pid, 0); throw new Error('publication_original_process_active'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
}
async function stageWork(q: QueueStore, http: PublicationHttp, p: Plan, d: Row, name: 'comment' | 'status', allowWrite: boolean, retrySource?: string): Promise<boolean> {
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
  const payload = name === 'comment' ? { body: d.commentBody } : statusPayload(d, comment);
  let reply;
  try {
    reply = await http.request('POST', `${repoPath(d)}/${name === 'comment' ? `issues/${d.candidate.pr}/comments` : `statuses/${d.candidate.H}`}`, payload, {
      intent: directory => q.publicationEvent(p.operation, 'intent', name, { directory, requestSha256: hash(canonical(payload)), controllerPid: process.pid, remotePreflight: observed }, { request: Buffer.from(JSON.stringify(payload)), preflight: Buffer.from(JSON.stringify(observed)) }, stage.intent ? retrySource : undefined),
      started: pid => q.publicationEvent(p.operation, 'started', name, { pid })
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
    await reconcileReception(p.store, p.operation);
    const original = q.receiverState(p.operation), d = publicDocument(p, original), directory = original.receiver.directory;
    return await lock(directory, async () => {
      const state = q.preparePublication(p.operation, bytes, Buffer.from(JSON.stringify(d)), action === 'prepare');
      const preview = join(directory, `publication-preview-${d.publicationId}.json`);
      try { await writeFile(preview, JSON.stringify(d, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; if (canonical(JSON.parse((await ordinaryFile(preview, 1024 * 1024)).toString())) !== canonical(d)) throw new Error('publication_preview_changed'); }
      if (action === 'prepare') return { operation: p.operation, publicationId: d.publicationId, status: 'prepared_not_sent', preview, channel: p.channel, githubState: d.status.state, judgment: d.judgment, productionActionAllowed: false };
      if (action === 'retry-rejected' && (!retrySource?.trim() || retrySource.length > 2048 || !Object.values(state.stages).some((s: any) => s.response?.rejected && s.lastState !== 'verified'))) throw new Error('publication_explicit_rejected_retry_required');
      const http = new PublicationHttp(directory, p.ghExecutable, p.ghSha256, d.candidate.repository, d.candidate.pr, d.candidate.H, d.candidate.targetRef);
      const detail = await stageWork(q, http, p, d, 'comment', action !== 'reconcile', action === 'retry-rejected' ? retrySource : undefined);
      const status = detail && await stageWork(q, http, p, d, 'status', action !== 'reconcile', action === 'retry-rejected' ? retrySource : undefined);
      let remoteCurrent = false, remoteCheckError: string | null = null;
      try { await current(http, p, d); remoteCurrent = true; } catch (e) { remoteCheckError = e instanceof Error ? e.message : 'current_remote_unknown'; }
      const final = q.publicationState(p.operation);
      return { operation: p.operation, publicationId: d.publicationId, status: detail && status ? 'published_verified' : 'publication_pending_or_unknown', channel: p.channel, githubState: d.status.state, judgment: d.judgment, materialDigest: d.materialDigest, comment: final.stages.comment.verified?.remote ?? null, commitStatus: final.stages.status.verified?.remote ?? null, stages: final.stages, localMaterialCurrent: q.receiverState(p.operation).result.receiver.currentMaterialMatches, remoteCurrent, remoteCheckError, privateReportPublished: false, modelTasksStarted: 0, productionActionAllowed: false };
    });
  } finally { q.close(); }
}
