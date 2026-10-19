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

async function fixture(t: test.TestContext, mode = 'normal') {
  const f = await setup(t);
  // Native-shaped local fixture plus a fake gh process. No supplier or GitHub
  // request is possible; this declaration is not reported as a real capture.
  const secret = 'PRIVATE_REPORT_SENTINEL @someone /Users/private/token=fixture ```';
  await writeFile(f.plan.claudeExecutable, (await readFile(f.plan.claudeExecutable, 'utf8')).replace("report:'明确标注的模拟接收判断；没有真实模型或业务批准。'", 'report:' + JSON.stringify(secret)));
  await writeFile(f.path, JSON.stringify({ ...f.plan, executionKind: 'native_capture' }));
  const result = await runReception(f.path), remotePath = join(f.root, 'fake-remote.json');
  const data = { mode, repository: 'fixture/reception', repositoryId: 71, actor: { id: 72, login: 'fixture-publisher' }, H: result.candidate.H, B: result.candidate.B, target: result.candidate.targetRef, comments: [], statuses: [], requests: [], posts: [], rejectionConsumed: false };
  await writeFile(remotePath, JSON.stringify(data)); const gh = join(f.root, 'gh-fixture.mjs');
  await writeFile(gh, `#!${process.execPath}
import fs from 'node:fs';
import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js', import.meta.url).href)};
const path=${JSON.stringify(remotePath)},store=${JSON.stringify(f.store)},args=process.argv.slice(2),method=args[args.indexOf('--method')+1],endpoint=args.at(-1);
let input='';for await(const b of process.stdin)input+=b;
let r=JSON.parse(fs.readFileSync(path,'utf8'));r.requests.push({method,endpoint});
const base='repos/'+r.repository,save=()=>fs.writeFileSync(path,JSON.stringify(r));
function emit(status,value){save();process.stdout.write('HTTP/2.0 '+status+' Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(value));process.exitCode=status>=400?1:0;}
if(method==='GET'){
 if(endpoint==='user')emit(200,r.actor);
 else if(endpoint===base)emit(200,{id:r.repositoryId,full_name:r.repository,permissions:{push:true}});
 else if(endpoint===base+'/pulls/1')emit(200,{number:1,state:'open',head:{sha:r.H,repo:{id:r.repositoryId}},base:{sha:r.B,ref:r.target,repo:{id:r.repositoryId}}});
 else if(endpoint.startsWith(base+'/git/ref/heads/')){if(r.mode==='stop-on-ref'){const q=await QueueStore.open(store);q.control('scope','investment','stopped','fixture:concurrent-stop');q.close();}emit(200,{ref:'refs/heads/'+r.target,object:{type:'commit',sha:r.refB??r.B}});}
 else if(endpoint.includes('/issues/1/comments?')){const page=Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));emit(200,r.comments.slice((page-1)*100,page*100));}
 else if(endpoint.startsWith(base+'/issues/comments/')){const value=r.comments.find(x=>x.id===Number(endpoint.split('/').at(-1)));emit(value?200:404,value??{message:'missing'});}
 else if(endpoint.includes('/commits/')&&endpoint.includes('/statuses?')){const page=Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));emit(200,r.statuses.slice((page-1)*100,page*100));}
 else emit(404,{message:'fixture endpoint absent'});
}else{
 const p=JSON.parse(input),comment=endpoint===base+'/issues/1/comments';
 r.posts.push({endpoint,payload:p});
 if(r.mode==='empty-no-create'){save();process.exit(1);}
 if(!comment&&r.mode==='reject-status'&&!r.rejectionConsumed){r.rejectionConsumed=true;emit(403,{message:'explicit fixture rejection'});}
 else {
  if(comment&&r.mode==='slow-comment')await new Promise(resolve=>setTimeout(resolve,600));
  const value=comment?{id:100+r.comments.length,user:r.actor,body:p.body,issue_url:'https://api.github.com/'+base+'/issues/1',html_url:'https://github.com/'+r.repository+'/pull/1#issuecomment-'+(100+r.comments.length)}:{id:200+r.statuses.length,creator:r.actor,...p};
  if(comment)r.comments.push(value);else r.statuses.unshift(value);
  if(comment&&r.mode==='change-head-after-comment')r.H='a'.repeat(40);
  save();
  if(comment&&r.mode==='kill-parent-after-comment'){process.kill(process.ppid,'SIGKILL');process.exit(0);}
  else if(!comment&&r.mode==='lose-status-response')process.exit(1);
  else emit(201,value);
 }
}
`, { mode: 0o700 });
  const p = { schemaVersion: 1, kind: 'tongxu-reception-publication', store: f.store, operation: result.operation, channel: 'commit-status', ghExecutable: gh, ghSha256: hash(await readFile(gh)), repositoryId: 71, actor: data.actor, source: 'fixture:explicit-record-only-publication' };
  const path = join(f.root, 'publication-plan.json'); await writeFile(path, JSON.stringify(p));
  const read = async () => JSON.parse(await readFile(remotePath, 'utf8'));
  const change = async (changes: Record<string, any>) => writeFile(remotePath, JSON.stringify({ ...await read(), ...changes }));
  return { ...f, result, p, pubPath: path, remotePath, remote: read, change, secret };
}
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
