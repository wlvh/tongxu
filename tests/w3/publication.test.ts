import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setup } from './receiver-fixture.js';
import { runReception } from '../../src/receiver.js';
import { publication } from '../../src/publisher.js';
import { hash } from '../../src/snapshot.js';
import { PublicationHttp } from '../../src/publication-http.js';

import {publicationFixture as fixture} from './publication-fixture.js';

const cli = fileURLToPath(new URL('../../src/publisher-cli.js', import.meta.url));
function child(args: string[]) { const p = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b); return { p, closed: once(p, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr })) }; }

test('prepare is local; exact record is published and read back, without exposing private text or resending on repeat', async t => {
  const f = await fixture(t), before = await readFile(join(f.result.receiver.directory, 'claude/stdout.ndjson'));
  assert.equal((await publication(f.pubPath, 'prepare')).status, 'prepared_not_sent'); assert.equal((await f.remote()).requests.length, 0);
  const r = await publication(f.pubPath, 'publish'); assert.equal(r.status, 'published_verified'); assert.equal(r.remoteCurrent, true); assert.equal(r.githubState, 'success'); assert.equal(r.productionActionAllowed, false);
  const remote = await f.remote(); assert.equal(remote.posts.length, 2); assert.equal(remote.statuses[0].target_url, remote.comments[0].html_url); assert.ok(!remote.comments[0].body.includes(f.secret)); assert.ok(!remote.comments[0].body.includes(f.root));
  const rows = f.q.status().events; const again = await publication(f.pubPath, 'publish'); assert.equal(again.status, 'published_verified'); assert.equal((await f.remote()).posts.length, 2); assert.deepEqual(f.q.status().events, rows); assert.equal(await f.count(), 1); assert.deepEqual(await readFile(join(f.result.receiver.directory, 'claude/stdout.ndjson')), before);
  const saved = JSON.parse(await readFile(f.pubPath, 'utf8')); await writeFile(f.pubPath, JSON.stringify({ ...saved, source: 'fixture:changed-plan' })); await assert.rejects(publication(f.pubPath, 'publish'), /plan_or_result_changed/);
});
test('actual target ref, actor and late stop changes prevent the first POST', async t => {
  for (const scenario of ['ref', 'actor', 'stop']) {
    const f = await fixture(t, scenario === 'stop' ? 'stop-on-ref' : 'normal');
    if (scenario === 'ref') await f.change({ refB: 'f'.repeat(40) });
    if (scenario === 'actor') await f.change({ actor: { id: 999, login: 'other-account' } });
    await assert.rejects(publication(f.pubPath, 'publish'), /remote_candidate_changed|actor_changed|new_investment_stopped/); assert.equal((await f.remote()).posts.length, 0); assert.equal(await f.count(), 1);
  }
});
test('publication binds the stable direct target and retains a historical REST base separately', async t => {
  const f=await fixture(t),original=f.result.candidate.B;
  await f.change({B:'a'.repeat(40),refB:original});
  const r=await publication(f.pubPath,'publish');assert.equal(r.status,'published_verified');assert.equal(r.remoteCurrent,true);
  assert.equal(r.stages.comment.intent.remotePreflight.B,original);assert.equal(r.stages.comment.intent.remotePreflight.prReportedBase,'a'.repeat(40));
  assert.equal((await f.remote()).posts.length,2);
});
test('unknown status response is recovered from its unique remote record; no second POST or model request', async t => {
  const f = await fixture(t, 'lose-status-response'); await assert.rejects(publication(f.pubPath, 'publish'), /response_unknown/); assert.equal((await f.remote()).posts.length, 2);
  const recovered = await publication(f.pubPath, 'reconcile'); assert.equal(recovered.status, 'published_verified'); assert.equal(recovered.stages.status.verified.recovered, true); assert.equal((await f.remote()).posts.length, 2); assert.equal(await f.count(), 1);
});
test('a missing result after uncertain POST remains unknown and cannot be retried as a rejected request', async t => {
  const f = await fixture(t, 'empty-no-create'); await assert.rejects(publication(f.pubPath, 'publish'), /response_unknown/); await f.change({ mode: 'normal' });
  assert.equal((await publication(f.pubPath, 'reconcile')).status, 'publication_pending_or_unknown'); assert.equal((await publication(f.pubPath, 'publish')).status, 'publication_pending_or_unknown'); await assert.rejects(publication(f.pubPath, 'retry-rejected', 'fixture:cannot-force-unknown'), /explicit_rejected_retry_required/); assert.equal((await f.remote()).posts.length, 1);
});
test('explicit rejected retry continues only the uncompleted status, preserving the verified detail', async t => {
  const f = await fixture(t, 'reject-status'); const first = await publication(f.pubPath, 'publish'); assert.equal(first.status, 'publication_pending_or_unknown'); assert.equal(first.stages.status.response.rejected, true);
  await publication(f.pubPath, 'publish'); assert.equal((await f.remote()).posts.length, 2);
  const resumed = await publication(f.pubPath, 'retry-rejected', 'fixture:explicit-retry-after-definite-rejection'); assert.equal(resumed.status, 'published_verified'); assert.equal((await f.remote()).comments.length, 1); assert.equal((await f.remote()).posts.length, 3);
});
test('remote detail edits and late candidate changes remain explicit without rewriting or completing another candidate', async t => {
  const f = await fixture(t); await publication(f.pubPath, 'publish'); const remote = await f.remote(); remote.comments[0].body += '\nexternally changed'; await f.change({ comments: remote.comments });
  assert.equal((await publication(f.pubPath, 'reconcile')).status, 'publication_pending_or_unknown'); assert.equal((await f.remote()).posts.length, 2);
  const g = await fixture(t, 'change-head-after-comment'); await assert.rejects(publication(g.pubPath, 'publish'), /remote_candidate_changed/); const r = await publication(g.pubPath, 'reconcile'); assert.equal(r.remoteCurrent, false); assert.equal(r.status, 'publication_pending_or_unknown'); assert.equal((await g.remote()).posts.length, 1);
});
test('two real CLI processes cannot both publish the same original operation', async t => {
  const f = await fixture(t, 'slow-comment'), first = child(['publish', '--plan', f.pubPath]);
  for (let i = 0; i < 150 && !(await f.remote()).posts.length; i++) await new Promise(r => setTimeout(r, 10));
  const second = await child(['publish', '--plan', f.pubPath]).closed, done = await first.closed;
  assert.equal(done.code, 0); assert.equal(second.code, 1); assert.match(second.stderr, /controller_active/); assert.equal((await f.remote()).posts.length, 2);
});
test('SIGKILL after remote comment creation recovers that original and sends only the previously unstarted status', async t => {
  const f = await fixture(t, 'kill-parent-after-comment'), first = await child(['publish', '--plan', f.pubPath]).closed; assert.equal(first.signal, 'SIGKILL'); assert.equal((await f.remote()).comments.length, 1);
  await f.change({ mode: 'normal' });
  const recovered = await publication(f.pubPath, 'reconcile'); assert.equal(recovered.status, 'publication_pending_or_unknown'); assert.equal(recovered.stages.comment.verified.recovered, true); assert.equal((await f.remote()).posts.length, 1);
  assert.equal((await publication(f.pubPath, 'publish')).status, 'published_verified'); assert.equal((await f.remote()).posts.length, 2); assert.equal((await f.remote()).comments.length, 1); assert.equal(await f.count(), 1);
});
test('explicit fixture captures and unsupported channels cannot cross the live publication boundary; merge endpoints are absent', async t => {
  const f = await setup(t), result = await runReception(f.path), p = join(f.root, 'publication.json');
  await writeFile(p, JSON.stringify({ schemaVersion: 1, kind: 'tongxu-reception-publication', store: f.store, operation: result.operation, channel: 'commit-status', ghExecutable: f.plan.claudeExecutable, ghSha256: hash(await readFile(f.plan.claudeExecutable)), repositoryId: 71, actor: { id: 72, login: 'fixture' }, source: 'fixture:not-real' }));
  await assert.rejects(publication(p, 'prepare'), /complete_native_judgment/);
  const http = new PublicationHttp(f.root, f.plan.claudeExecutable, 'a'.repeat(64), 'fixture/reception', 1, f.H, 'fixture'); await assert.rejects(http.request('POST', 'repos/fixture/reception/pulls/1/merge', {}), /endpoint_denied/);
});

test('an unsent preview can be explicitly corrected without rerunning its model; intent freezes the plan', async t => {
  const f = await fixture(t); await writeFile(f.pubPath, JSON.stringify({ ...f.p, actor: { id: 999, login: 'typo' } })); const draft = await publication(f.pubPath, 'prepare');
  await writeFile(f.pubPath, JSON.stringify(f.p)); await assert.rejects(publication(f.pubPath, 'publish'), /plan_or_result_changed/);
  const corrected = await publication(f.pubPath, 'prepare'); assert.notEqual(corrected.publicationId, draft.publicationId); assert.notEqual(corrected.preview, draft.preview); assert.equal(typeof draft.preview, 'string'); assert.ok((await readFile(draft.preview!, 'utf8')).includes('typo'));
  assert.equal((await publication(f.pubPath, 'publish')).status, 'published_verified'); assert.equal((await f.remote()).posts.length, 2); assert.equal(await f.count(), 1); assert.equal(f.q.status().publications.length, 1);
});

test('ambiguous duplicates and incomplete remote scans cannot become verified or trigger another POST', async t => {
  const f = await fixture(t); await publication(f.pubPath, 'publish'); const original = await f.remote();
  await f.change({ comments: [...original.comments, { ...original.comments[0], id: 101, html_url: 'https://github.com/fixture/reception/pull/1#issuecomment-101' }] });
  const duplicate = await publication(f.pubPath, 'reconcile'); assert.equal(duplicate.status, 'publication_pending_or_unknown'); assert.equal(duplicate.stages.comment.problem.reason, 'remote_identity_or_content_conflict');
  const unrelated = Array.from({ length: 1000 }, (_, n) => ({ id: 1000 + n, body: 'unrelated fixture comment' }));
  await f.change({ comments: [original.comments[0], ...unrelated] });
  const incomplete = await publication(f.pubPath, 'publish'); assert.equal(incomplete.status, 'publication_pending_or_unknown'); assert.equal(incomplete.stages.comment.problem.reason, 'remote_read_incomplete'); assert.equal((await f.remote()).posts.length, 2);
});

test('a malformed exit record is not evidence that an uncertain original publisher ended', async t => {
  const f = await fixture(t, 'empty-no-create'); await assert.rejects(publication(f.pubPath, 'publish'), /response_unknown/);
  const original = f.q.publicationState(f.result.operation), exit = join(original.stages.comment.intent.directory, 'exit.json'), saved = await readFile(exit);
  await writeFile(exit, '{}'); await assert.rejects(publication(f.pubPath, 'reconcile'), /exit_record_invalid/); assert.equal((await f.remote()).posts.length, 1);
  await writeFile(exit, saved); assert.equal((await publication(f.pubPath, 'reconcile')).status, 'publication_pending_or_unknown'); assert.equal((await f.remote()).posts.length, 1);
});

test('GitHub context names differing only in case are conflicting effective statuses, including lost-response recovery', async t => {
  for (const mode of ['normal', 'lose-status-response']) {
    const f = await fixture(t, mode);
    if (mode === 'normal') await publication(f.pubPath, 'publish'); else await assert.rejects(publication(f.pubPath, 'publish'), /response_unknown/);
    const remote = await f.remote(), original = remote.statuses[0];
    await f.change({ statuses: [{ ...original, id: original.id + 1, context: original.context.toUpperCase(), creator: { id: 999, login: 'other-publisher' }, state: 'failure' }, original] });
    const recovered = await publication(f.pubPath, 'reconcile'); assert.equal(recovered.status, 'publication_pending_or_unknown'); assert.equal(recovered.stages.status.problem.reason, 'remote_identity_or_content_conflict'); assert.equal((await f.remote()).posts.length, 2); assert.equal(await f.count(), 1);
  }
});
