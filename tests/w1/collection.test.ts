import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, lstat, readdir, rm, rename, realpath } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { Snapshot, hash } from '../../src/snapshot.js';
import { collect } from '../../src/collector.js';
import { renderSummary } from '../../src/handoff.js';
import type { GitReader, Response, Transport } from '../../src/contract.js';

const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40);
const repository = 'example/project';
const roots: string[] = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
const reply = (data: unknown, status = 200, headers = {}): Response => ({ body: JSON.stringify(data), status, headers, provenance: 'fixture' });
const comments = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}`, user: { login: 'same-account' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }));
class Fixture implements Transport {
  rows = comments(101);
  calls: string[] = [];
  pr = { id: 12, number: 12, head: { sha: H }, base: { sha: B, ref: 'integration/parent', repo: { full_name: repository } }, body: 'delegated summary is not human approval', updated_at: '2026-01-01T00:00:00Z', comments: 101, review_comments: 1, commits: 1, changed_files: 1 };
  override?: (endpoint: string, fixture: Fixture) => Response | undefined;
  async get(endpoint: string): Promise<Response> {
    this.calls.push(endpoint);
    const overridden = this.override?.(endpoint, this);
    if (overridden) return overridden;
    const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get('page') ?? '1');
    if (endpoint.endsWith('/pulls/12')) return reply(this.pr);
    if (endpoint.includes('/issues/12/comments')) return reply(this.rows.slice((page - 1) * 100, page * 100));
    if (endpoint.includes('/pulls/12/comments')) return reply([{ id: 80, body: 'finding after CI green', in_reply_to_id: 79 }]);
    if (endpoint.includes('/reviews')) return reply([{ id: 9, body: 'review', user: { login: 'same-account' } }]);
    if (endpoint.includes('/commits')) return reply([{ sha: H, commit: { message: 'change' } }]);
    if (endpoint.includes('/files')) return reply([{ filename: 'README.txt', status: 'modified' }]);
    if (endpoint.endsWith('/issues/3')) return reply({ id: 3, number: 3, body: 'source', comments: 0, updated_at: '2026-01-01T00:00:00Z' });
    if (endpoint.includes('/issues/3/comments')) return reply([]);
    throw new Error('unexpected_endpoint');
  }
}
const git: GitReader = async () => ({ mergeBase: M, files: ['README.txt'], commits: [H], patch: Buffer.from('fixed patch') });
async function setup(t: test.TestContext, notes: any[] = [], issues: number[] = []) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-test-'));
  roots.push(root);
  const s = await Snapshot.create(join(root, 'out'), repository, 12, issues, notes);
  t.after(() => s.close());
  return s;
}

test('full requested collection keeps real target, inline replies, source hashes and private artifacts', async t => {
  const s = await setup(t, [], [3]);
  const f = new Fixture();
  assert.equal(await collect(s, f, git), 0);
  const r = s.manifest.rounds[0]!;
  assert.equal(s.manifest.candidate?.targetRef, 'integration/parent');
  assert.equal(r.coverage.pr_comments?.records, 101);
  assert.equal(r.coverage.pr_comments?.pages, 2);
  assert.equal(r.coverage.issue_3_comments?.state, 'complete');
  assert.equal(r.sources.find(x => x.id === 'review-comment:80')?.replyTo, 79);
  assert.equal(r.sources.find(x => x.id === 'pr:12')?.bodyHash, hash(f.pr.body));
  assert.equal((await lstat(s.directory)).mode & 0o077, 0);
  for (const a of s.manifest.artifacts) assert.equal((await lstat(join(s.directory, a.path))).mode & 0o077, 0);
  assert.match(await readFile(join(s.directory, 'handoff.md'), 'utf8'), /never a human identity/);
});

test('second-page failure then deletion/edit restarts mutable pages, keeps old evidence and reuses fixed Git', async t => {
  const s = await setup(t);
  const f = new Fixture();
  f.override = ep => { if (ep.includes('/issues/12/comments') && ep.endsWith('page=2')) throw new Error('network_failure'); return undefined; };
  let gitCalls = 0;
  const reader: GitReader = async (...args) => { gitCalls++; return git(...args); };
  assert.equal(await collect(s, f, reader), 2);
  assert.equal(s.manifest.rounds[0]!.coverage.pr_comments?.nextPage, 2);
  const old = s.manifest.artifacts.map(a => ({ ...a }));
  await s.close();
  const resumed = await Snapshot.resume(s.directory);
  t.after(() => resumed.close());
  f.override = undefined;
  f.rows.shift(); f.rows[0]!.body = 'edited while interrupted'; f.pr.comments = 100;
  const start = f.calls.length;
  assert.equal(await collect(resumed, f, reader), 0);
  const r = resumed.manifest.rounds.at(-1)!;
  assert.ok(f.calls.slice(start).some(p => p.endsWith('/issues/12/comments?per_page=100&page=1')));
  assert.equal(r.coverage.pr_comments?.records, 100);
  assert.equal(r.sources.find(x => x.id === 'issue-comment:2')?.body, 'edited while interrupted');
  assert.equal(resumed.manifest.rounds[0]!.sources.find(x => x.id === 'issue-comment:2')?.body, 'comment 2');
  assert.equal(gitCalls, 1);
  for (const a of old) assert.equal(hash(await readFile(join(s.directory, a.path))), a.sha256);
});

for (const field of ['head', 'base', 'target'] as const) test(`${field} changes never attach old patch to a new candidate`, async t => {
  const s = await setup(t); const f = new Fixture(); let reads = 0;
  f.override = ep => {
    if (ep.endsWith('/pulls/12') && ++reads === 2) {
      if (field === 'head') f.pr.head.sha = 'd'.repeat(40);
      if (field === 'base') f.pr.base.sha = 'd'.repeat(40);
      if (field === 'target') f.pr.base.ref = 'main';
    }
    return undefined;
  };
  assert.equal(await collect(s, f, git), 2);
  assert.equal(s.manifest.candidate?.H, H); assert.equal(s.manifest.candidate?.B, B);
  assert.equal(s.manifest.rounds[0]!.current, false);
  await s.close(); const resumed = await Snapshot.resume(s.directory); t.after(() => resumed.close());
  f.override = undefined; const before = f.calls.length;
  assert.equal(await collect(resumed, f, git), 2);
  assert.equal(f.calls.length - before, 1);
  assert.ok(resumed.manifest.rounds.at(-1)!.gaps.includes('candidate_changed_create_new_output'));
});

for (const status of [403, 404, 429, 503]) test(`HTTP ${status} is a saved gap, not an empty complete collection`, async t => {
  const s = await setup(t); const f = new Fixture(); let tries = 0;
  f.override = ep => ep.includes('/reviews?') ? (tries++, reply({ message: 'unavailable' }, status, { 'retry-after': '0' })) : undefined;
  assert.equal(await collect(s, f, git), 2);
  assert.equal(s.manifest.rounds[0]!.coverage.reviews?.state, 'unavailable');
  assert.equal(tries, [429, 503].includes(status) ? 3 : 1);
  assert.ok(s.manifest.artifacts.some(a => a.status === status));
});

test('long Retry-After leaves a recovery point without repeated calls', async t => {
  const s = await setup(t); const f = new Fixture();
  f.override = ep => ep.includes('/reviews?') ? reply({}, 429, { 'retry-after': '3600' }) : undefined;
  assert.equal(await collect(s, f, git), 2);
  assert.equal(f.calls.filter(p => p.includes('/reviews?')).length, 1);
});

for (const failure of ['overlap', 'count', 'next-host', 'json', 'cap']) test(`${failure} pagination evidence cannot claim complete`, async t => {
  const s = await setup(t); const f = new Fixture();
  if (failure === 'count') f.pr.comments = 102;
  f.override = ep => {
    if (failure === 'overlap' && ep.includes('/issues/12/comments') && ep.endsWith('page=2')) return reply([f.rows[0]]);
    if (failure === 'next-host' && ep.includes('/issues/12/comments')) return reply(f.rows.slice(0, 100), 200, { link: '<https://evil.example/steal>; rel="next"' });
    if (failure === 'json' && ep.includes('/reviews?')) return { ...reply([]), body: 'broken JSON' };
    if (failure === 'cap' && ep.includes('/commits?')) {
      f.pr.commits = 250;
      const page = Number(new URL(`https://x/${ep}`).searchParams.get('page'));
      return reply(Array.from({ length: page === 3 ? 50 : 100 }, (_, i) => ({ sha: ((page - 1) * 100 + i + 1).toString(16).padStart(40, '0') })));
    }
    return undefined;
  };
  assert.equal(await collect(s, f, git), 2);
  assert.ok(s.manifest.rounds[0]!.gaps.length);
  assert.ok(f.calls.every(p => p.startsWith('repos/example/project/')));
});

test('source-bound roles and actions remain reports; private text never enters summary', async t => {
  const secret = 'PRIVATE_SESSION_/home/person/token';
  const notes = [{ sourceId: 'pr:12', sourceBodyHash: hash('delegated summary is not human approval'), locator: 'body', kind: 'delegated_action', scope: 'S', note: secret, role: { account: 'same-account', claimedRole: 'owner', taskOwner: 'issue47', executor: 'issue28' }, relation: { type: 'development', object: 'B1', version: H, blocks: 'implementation', canContinue: 'independent inspection' }, action: { step: 'check two config bindings', exitCondition: 'receiver rechecks' } }, { sourceId: 'pr:12', sourceBodyHash: '0'.repeat(64), locator: 'body', kind: 'owner_adoption_report', scope: 'r', note: 'old version' }];
  const s = await setup(t, notes); const f = new Fixture();
  assert.equal(await collect(s, f, git), 2);
  assert.equal(s.manifest.rounds[0]!.notes[0]?.binding, 'verified');
  assert.equal(s.manifest.rounds[0]!.notes[1]?.binding, 'stale');
  assert.equal(s.manifest.rounds[0]!.notes[0]?.version, undefined);
  assert.ok(!renderSummary(s.manifest).includes(secret));
  assert.match(await readFile(join(s.directory, 'handoff.md'), 'utf8'), /issue47/);
});

test('missing fixed objects and Git/API differences are separate gaps', async t => {
  const s = await setup(t); const f = new Fixture();
  assert.equal(await collect(s, f, async () => { throw new Error('missing objects'); }), 2);
  assert.ok(s.manifest.rounds[0]!.gaps.includes('git_incomplete'));
  assert.equal(await collect(s, f, async () => ({ mergeBase: M, patch: Buffer.from('x'), files: ['different'], commits: [H] })), 2);
  assert.ok(s.manifest.rounds[1]!.gaps.includes('git_api_files_differ'));
});

test('new outputs refuse overwrite, repository paths and symlink parents', async t => {
  const s = await setup(t);
  await assert.rejects(() => Snapshot.create(s.directory, repository, 12, [], []));
  const repo = join(s.directory, 'repo'); await mkdir(repo); await mkdir(join(repo, '.git'));
  await assert.rejects(() => Snapshot.create(join(repo, 'evidence'), repository, 12, [], []), /inside_git/);
  const link = join(s.directory, 'link'); await symlink(tmpdir(), link);
  await assert.rejects(() => Snapshot.create(join(link, 'evidence'), repository, 12, [], []), /symlink/);
});

test('resume verifies hashes before any requests and refuses a live writer', async t => {
  const s = await setup(t);
  await assert.rejects(() => Snapshot.resume(s.directory), /writer_active_or_unknown/);
  assert.equal(await collect(s, new Fixture(), git), 0);
  await s.close();
  await writeFile(join(s.directory, s.manifest.artifacts[0]!.path), 'tampered');
  await assert.rejects(() => Snapshot.resume(s.directory), /integrity/);
});

test('resume recovers only a demonstrably absent local writer and preserves its lock', async t => {
  const s = await setup(t); await s.close();
  await writeFile(join(s.directory, 'lock.json'), JSON.stringify({ host: hostname(), pid: 2147483647, id: 'dead' }), { mode: 0o600 });
  const resumed = await Snapshot.resume(s.directory); t.after(() => resumed.close());
  assert.ok((await readdir(s.directory)).some(p => p.startsWith('abandoned-lock-')));
});

for (const material of ['raw', 'git'] as const) test(`resume and artifact publication reject replaced empty ${material} directory`, async t => {
  const s = await setup(t);
  const target = join(dirname(s.directory), 'target-checkout'); await mkdir(target); await mkdir(join(target, '.git'));
  await rename(join(s.directory, material), join(s.directory, `${material}-original`));
  await symlink(target, join(s.directory, material));
  await assert.rejects(() => s.artifact('{}', { kind: 'probe', round: 0, retrievedAt: 'fixture', provenance: 'fixture' }, material === 'raw' ? 'raw' : 'git-json'), /symlink/);
  await s.close();
  await assert.rejects(() => Snapshot.resume(s.directory), /symlink/);
  assert.deepEqual(await readdir(target), ['.git']);
});
