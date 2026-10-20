import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceFixture } from './source-fixture.js';
import { QueueStore } from '../../src/queue-store.js';
import { sourceTick } from '../../src/event-tick.js';
import { readEventSource } from '../../src/event-source.js';
import { hash } from '../../src/snapshot.js';
const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));
async function setup(t:test.TestContext,interval=10){const f=await sourceFixture(t);f.profile.pollIntervalMs=interval;const store=join(f.root,'queue'),q=await QueueStore.create(store,f.profile.repository);t.after(()=>q.close());q.events().configure(bytes(f.profile));return {...f,store,q};}
test('due tick persists original observations; not-due and duplicate hints do not create another read or task',async t=>{
  const f=await setup(t,60000),e=f.q.events(),hint={schemaVersion:1,id:'delivery-1',pr:1,kind:'head_changed'};
  assert.equal(e.hint(bytes(hint)).duplicate,false);assert.equal(e.hint(bytes(hint)).duplicate,true);assert.throws(()=>e.hint(bytes({...hint,kind:'submitted'})),/hint_id_content_conflict/);
  const first=await sourceTick(f.store);assert.equal(first.checked.length,1);assert.equal(first.state.subjects[0]!.revision,1);assert.equal(first.state.subjects[0]!.complete,true);const requests=(await f.get()).requests.length;
  const again=await sourceTick(f.store);assert.equal(again.checked.length,0);assert.equal((await f.get()).requests.length,requests);assert.equal(first.modelTasksStarted,0);assert.equal(first.mergeRequestsSent,0);assert.equal(f.q.status().operations.length,0);assert.equal(f.q.status().claims.length,0);
});
test('periodic backfill catches a missing head notification, but unchanged followups do not advance semantic revision',async t=>{
  const f=await setup(t);await sourceTick(f.store);await f.change({H:'c'.repeat(40)});
  const changed=await sourceTick(f.store);assert.equal(changed.state.subjects[0]!.revision,2);assert.ok(changed.state.subjects[0]!.changes.includes('candidate_changed'));assert.equal(changed.state.subjects[0]!.candidate.H,'c'.repeat(40));
  const same=await sourceTick(f.store);assert.equal(same.state.subjects[0]!.revision,2);assert.deepEqual(same.state.subjects[0]!.changes,[]);assert.equal(same.modelTasksStarted,0);
});
test('permission failure stays incomplete; recovery of identical source preserves the last good semantic revision',async t=>{
  const f=await setup(t);await sourceTick(f.store);await f.change({mode:'forbidden-comments'});const bad=await sourceTick(f.store);assert.equal(bad.state.subjects[0]!.complete,false);assert.equal(bad.state.subjects[0]!.revision,1);assert.ok(bad.state.subjects[0]!.currentResult.gaps.length);
  await f.change({mode:'normal'});const recovered=await sourceTick(f.store);assert.equal(recovered.state.subjects[0]!.complete,true);assert.equal(recovered.state.subjects[0]!.revision,1);assert.deepEqual(recovered.state.subjects[0]!.changes,['source_recovered']);
});
test('late older reads are archived without overwriting a newer source and exact duplicate consumption keeps the original',async t=>{
  const f=await setup(t),e=f.q.events(),directory=()=>join(f.store,'source-poll-1-'+randomUUID());
  const a=e.beginPoll(1,directory());assert.equal(a.started,true);if(!a.started)return;const first=await readEventSource(f.profile,1,a.directory,a.knownPublished);
  await f.change({H:'c'.repeat(40)});const b=e.beginPoll(1,directory());assert.equal(b.started,true);if(!b.started)return;const second=await readEventSource(f.profile,1,b.directory,b.knownPublished);e.observe(1,b.sequence,second);
  assert.equal(e.observe(1,a.sequence,first).archived,true);assert.equal(e.status().subjects[0]!.candidate.H,'c'.repeat(40));assert.equal(e.observe(1,b.sequence,second).duplicate,true);
  const altered=await readEventSource(f.profile,1,join(b.directory,'extra'),b.knownPublished);assert.throws(()=>e.observe(1,b.sequence,altered),/original_event_poll_result_changed/);
});
test('caller-supplied publication suppression and damaged capture bytes cannot become current source proof',async t=>{
  const f=await setup(t),e=f.q.events(),comment={id:1,user:{id:11},body:'source material'};await f.change({comments:[comment]});
  const start=e.beginPoll(1,join(f.store,'source-poll-1-'+randomUUID()));if(!start.started)throw new Error('fixture expected due');const falseSuppression=await readEventSource(f.profile,1,start.directory,[{id:1,bodySha256:hash(comment.body)}]);assert.throws(()=>e.observe(1,start.sequence,falseSuppression),/poll_capture_mismatch/);
  await sourceTick(f.store);const s=e.status().subjects[0]!,ref=s.originals[0].sha256,db=new DatabaseSync(join(f.store,'queue.sqlite'));
  try{const original=Buffer.from((db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(ref) as any).bytes);db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(bytes({changed:true}),ref);assert.throws(()=>e.status(),/original_missing_or_changed/);db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(original,ref);assert.equal(e.status().subjects[0]!.complete,true);}finally{db.close();}
});
test('two real tick CLI processes perform at most one due source read and failures release only their controller lock',async t=>{
  const f=await setup(t,60000),cli=fileURLToPath(new URL('../../src/event-cli.js',import.meta.url));const child=()=>new Promise<{code:number|null;error:string}>(resolve=>{const p=spawn(process.execPath,[cli,'tick','--store',f.store],{stdio:['ignore','ignore','pipe']});let error='';p.stderr.on('data',b=>error+=b);p.once('close',code=>resolve({code,error}));});
  const values=await Promise.all([child(),child()]);assert.deepEqual(values.map(v=>v.code).sort(),[0,1]);assert.match(values.find(v=>v.code===1)!.error,/controller_active/);assert.equal((await f.get()).requests.filter((r:any)=>r.path==='repos/fixture/events/pulls/1').length,2);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));db.prepare("UPDATE meta SET value='invalid-fixture-mode' WHERE key='mode'").run();await assert.rejects(sourceTick(f.store),/unsupported_queue/);db.prepare("UPDATE meta SET value='shadow' WHERE key='mode'").run();db.close();assert.equal((await sourceTick(f.store)).checked.length,0);
});
