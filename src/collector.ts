import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { emptyCoverage, now, shaPattern } from './contract.js';
import type { Candidate, Coverage, GitReader, Response, Round, Source, Transport } from './contract.js';
import { Snapshot, hash } from './snapshot.js';
import { readGit } from './git.js';
import { renderHandoff, renderSummary } from './handoff.js';

type RecordValue = Record<string, any>;
class Gap extends Error {}
const errorCode = (e: unknown) => e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'request_or_local_operation_failed';
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Gap('invalid_response_object');
  return value;
}
function candidate(value: RecordValue, repository: string, pr: number): Candidate {
  if (value.number !== pr || value.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() || !shaPattern.test(value.head?.sha) || !shaPattern.test(value.base?.sha) || typeof value.base?.ref !== 'string' || !value.base.ref || /[\x00-\x20\x7f]/.test(value.base.ref)) throw new Gap('invalid_candidate_metadata');
  return { repository, pr, H: value.head.sha, B: value.base.sha, targetRef: value.base.ref, mergeBase: null, observedAt: now() };
}
function same(a: Candidate, b: Candidate): boolean { return a.H === b.H && a.B === b.B && a.targetRef === b.targetRef; }
function recordId(item: RecordValue, kind: string): string {
  const id = kind === 'files' ? item.filename : kind === 'commits' ? item.sha : item.id;
  if (!(typeof id === 'string' && id.length > 0) && !(typeof id === 'number' && Number.isSafeInteger(id))) throw new Gap('missing_stable_id');
  if (kind === 'commits' && !shaPattern.test(String(id))) throw new Gap('invalid_commit_sha');
  return String(id);
}
function source(item: RecordValue, id: string, artifact: string): Source {
  const body = typeof item.body === 'string' ? item.body : typeof item.commit?.message === 'string' ? item.commit.message : '';
  return { id, body, bodyHash: hash(body), url: typeof item.html_url === 'string' ? item.html_url : null, account: typeof item.user?.login === 'string' ? item.user.login : null, createdAt: typeof item.created_at === 'string' ? item.created_at : null, updatedAt: typeof item.updated_at === 'string' ? item.updated_at : null, replyTo: item.in_reply_to_id ?? null, artifact };
}
function count(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined; }

export async function collect(snapshot: Snapshot, transport: Transport, gitReader: GitReader = readGit): Promise<number> {
  const m = snapshot.manifest;
  const round: Round = { number: m.rounds.length + 1, startedAt: now(), coverage: {}, sources: [], notes: [], gaps: [], limitations: ['observations_are_not_an_atomic_github_snapshot'], current: false };
  m.rounds.push(round);
  const prefix = `repos/${m.repository}`;
  const gap = (code: string) => { if (!round.gaps.includes(code)) round.gaps.push(code); };
  const coverage = (key: string) => round.coverage[key] ??= emptyCoverage();
  const finish = async () => {
    round.notes = m.context.map(note => ({ ...note, binding: round.sources.some(s => s.id === note.sourceId && s.bodyHash === note.sourceBodyHash) ? 'verified' : round.sources.some(s => s.id === note.sourceId) ? 'stale' : 'unverified' }));
    for (const note of round.notes) if (note.binding !== 'verified') gap(`context_${note.binding}`);
    round.finishedAt = now();
    await snapshot.save();
    await snapshot.atomic('handoff.md', renderHandoff(m));
    await snapshot.atomic('summary.md', renderSummary(m));
    return round.gaps.length === 0 && round.current ? 0 : 2;
  };
  const request = async (endpoint: string, key: string, page?: number): Promise<{ data: unknown; path: string; response: Response }> => {
    for (let attempt = 0; attempt <= 2; attempt++) {
      const response = await transport.get(endpoint);
      const artifact = await snapshot.artifact(response.body, { kind: key, round: round.number, retrievedAt: now(), endpoint, page, provenance: response.provenance, headers: response.headers, status: response.status });
      if (response.provenance === 'connector-json-no-http-headers' && !round.limitations.includes('connector_json_is_not_http_wire_bytes_headers_unavailable')) round.limitations.push('connector_json_is_not_http_wire_bytes_headers_unavailable');
      await snapshot.save();
      if (response.status >= 200 && response.status < 300) {
        try { return { data: JSON.parse(response.body), path: artifact.path, response }; } catch { throw new Gap('invalid_json_response'); }
      }
      const retry = [429, 502, 503, 504].includes(response.status) || (response.status === 403 && response.headers['x-ratelimit-remaining'] === '0');
      const rawWait = response.headers['retry-after'];
      const seconds = rawWait === undefined ? 0.1 : /^\d+$/.test(rawWait) ? Number(rawWait) : Math.max(0, (Date.parse(rawWait) - Date.now()) / 1000);
      // A long rate wait is a recovery point, not a loop or a new identity.
      if (!retry || attempt === 2 || !Number.isFinite(seconds) || seconds > 2) throw new Gap(`http_${response.status}`);
      await delay(seconds * 1000);
    }
    throw new Gap('retry_exhausted');
  };
  const single = async (endpoint: string, key: string, sourceId?: string): Promise<RecordValue | null> => {
    const c = coverage(key);
    try {
      const result = await request(endpoint, key);
      const data = object(result.data);
      if (!Number.isSafeInteger(data.id) || data.number !== Number(endpoint.split('/').at(-1)) || typeof data.updated_at !== 'string' || !('body' in data)) throw new Gap('incomplete_object_metadata');
      if (sourceId) round.sources.push(source(data, sourceId, result.path));
      Object.assign(c, { state: 'complete', pages: 1, records: 1, ids: [String(data.id)], nextPage: null, termination: 'single_object' });
      return data;
    } catch (e) { c.errors.push(errorCode(e)); c.termination = 'failed'; gap(`${key}_incomplete`); return null; }
    finally { await snapshot.save(); }
  };
  const list = async (endpoint: string, key: string, kind: string, expected?: number, platformCap?: number): Promise<RecordValue[]> => {
    const c = coverage(key);
    const items = new Map<string, { item: RecordValue; digest: string }>();
    try {
      for (let page = 1; page <= 100; page++) {
        c.nextPage = page;
        const result = await request(`${endpoint}?per_page=100&page=${page}`, key, page);
        if (!Array.isArray(result.data) || result.data.length > 100) throw new Gap('invalid_list_response');
        for (const value of result.data) {
          const item = object(value);
          const id = recordId(item, kind);
          const digest = hash(JSON.stringify(item));
          const previous = items.get(id);
          // Even identical overlap may hide a shifted page. Do not silently deduplicate into complete.
          if (previous) throw new Gap(previous.digest === digest ? 'pagination_overlap' : 'record_changed_during_collection');
          items.set(id, { item, digest });
          round.sources.push(source(item, `${kind}:${id}`, result.path));
        }
        c.pages++; c.records = items.size; c.ids = [...items.keys()]; c.state = 'partial';
        const link = result.response.headers.link;
        const next = link && /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
        if (next) {
          const url = new URL(next);
          if (url.origin !== 'https://api.github.com' || url.pathname !== `/${endpoint}` || url.searchParams.get('per_page') !== '100' || url.searchParams.get('page') !== String(page + 1) || [...url.searchParams.keys()].some(k => !['per_page', 'page'].includes(k))) throw new Gap('invalid_next_page_link');
        }
        // A missing Link is not enough on relay; explicitly traverse until a short/empty page.
        const ended = !next && result.data.length < 100;
        if (ended) {
          if (expected !== undefined && expected !== items.size) throw new Gap('count_mismatch');
          if (platformCap !== undefined && items.size >= platformCap) throw new Gap('platform_cap_reached');
          Object.assign(c, { state: 'complete', nextPage: null, termination: result.data.length === 0 ? 'empty_page' : 'short_page' });
          break;
        }
        if (platformCap !== undefined && items.size >= platformCap) throw new Gap('platform_cap_reached');
        c.nextPage = page + 1;
        await snapshot.save();
        if (page === 100) throw new Gap('page_limit_reached');
      }
    } catch (e) { c.state = c.pages > 0 ? 'partial' : 'unavailable'; c.errors.push(errorCode(e)); c.termination = 'failed'; gap(`${key}_incomplete`); }
    await snapshot.save();
    return [...items.values()].map(v => v.item);
  };

  await snapshot.save();
  const pr = await single(`${prefix}/pulls/${m.pr}`, 'pr', `pr:${m.pr}`);
  if (!pr) return finish();
  let observed: Candidate;
  try { observed = candidate(pr, m.repository, m.pr); }
  catch (e) { gap(errorCode(e)); return finish(); }
  if (m.candidate && !same(m.candidate, observed)) { gap('candidate_changed_create_new_output'); return finish(); }
  m.candidate ??= observed;
  await snapshot.save();
  const mandatoryCounts = ['comments', 'review_comments', 'commits', 'changed_files'];
  for (const key of mandatoryCounts) if (count(pr[key]) === undefined) gap(`pr_${key}_count_missing`);
  await list(`${prefix}/issues/${m.pr}/comments`, 'pr_comments', 'issue-comment', count(pr.comments));
  await list(`${prefix}/pulls/${m.pr}/reviews`, 'reviews', 'review');
  await list(`${prefix}/pulls/${m.pr}/comments`, 'review_comments', 'review-comment', count(pr.review_comments));
  const commits = await list(`${prefix}/pulls/${m.pr}/commits`, 'commits', 'commits', count(pr.commits), 250);
  const files = await list(`${prefix}/pulls/${m.pr}/files`, 'files', 'files', count(pr.changed_files), 3000);
  if (!m.issues.length) round.coverage.linked_issues = { ...emptyCoverage(), state: 'not_requested', nextPage: null, termination: 'explicit_issues_only' };
  for (const issue of m.issues) {
    const key = `issue_${issue}`;
    const before = await single(`${prefix}/issues/${issue}`, key, `issue:${issue}`);
    if (before && count(before.comments) === undefined) gap(`${key}_comment_count_missing`);
    await list(`${prefix}/issues/${issue}/comments`, `${key}_comments`, 'issue-comment', before ? count(before.comments) : undefined);
    const after = await single(`${prefix}/issues/${issue}`, `${key}_verify`);
    if (before && after && (before.updated_at !== after.updated_at || before.body !== after.body || before.comments !== after.comments)) gap(`${key}_changed_during_collection`);
  }
  const gitCoverage = coverage('git');
  try {
    if (!m.gitComplete) {
      const result = await gitReader(m.candidate, join(snapshot.directory, `git-cache-${randomUUID()}`));
      m.candidate.mergeBase = result.mergeBase;
      m.gitFiles = result.files;
      m.gitCommits = result.commits;
      await snapshot.artifact(result.patch, { kind: 'git_patch', round: round.number, retrievedAt: now(), provenance: 'fixed_git_objects' }, 'patch');
      await snapshot.artifact(JSON.stringify({ H: m.candidate.H, B: m.candidate.B, mergeBase: result.mergeBase, files: result.files, commits: result.commits }), { kind: 'git_inventory', round: round.number, retrievedAt: now(), provenance: 'fixed_git_objects' }, 'git-json');
      m.gitComplete = true;
    }
    Object.assign(gitCoverage, { state: 'complete', pages: 1, records: m.gitFiles.length, ids: m.gitFiles, nextPage: null, termination: 'fixed_objects' });
    if (coverage('files').state === 'complete' && JSON.stringify(files.map(f => f.filename).sort()) !== JSON.stringify([...m.gitFiles].sort())) gap('git_api_files_differ');
    if (coverage('commits').state === 'complete' && JSON.stringify(commits.map(c => c.sha).sort()) !== JSON.stringify([...m.gitCommits].sort())) gap('git_api_commits_differ');
  } catch { gitCoverage.errors.push('fixed_git_objects_unavailable'); gitCoverage.termination = 'failed'; gap('git_incomplete'); }
  await snapshot.save();
  const end = await single(`${prefix}/pulls/${m.pr}`, 'pr_verify');
  if (end) {
    try { round.current = same(m.candidate, candidate(end, m.repository, m.pr)); }
    catch { gap('invalid_final_candidate'); }
    if (!round.current) gap('candidate_changed_create_new_output');
    if (end.updated_at !== pr.updated_at || end.body !== pr.body || mandatoryCounts.some(k => pr[k] !== end[k])) gap('pr_changed_during_collection');
  }
  return finish();
}
