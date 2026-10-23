import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sourceFixture } from './source-fixture.js';
import { readEventSource,requireEventSource } from '../../src/event-source.js';
import { hash } from '../../src/snapshot.js';
import { PublicationHttp } from '../../src/publication-http.js';

test('actual readonly child captures complete fixed PR/direct refs; timestamp noise and repeats keep semantic identity',async t=>{
  const f=await sourceFixture(t),a=await readEventSource(f.profile,1,join(f.root,'first'));assert.equal(a.result.complete,true,JSON.stringify(a.result.gaps));assert.equal(a.result.candidate?.B,'b'.repeat(40));assert.equal(a.result.prReportedBase,'0'.repeat(40));requireEventSource(a,f.profile,1);
  await f.change({updatedAt:'2026-10-20T00:30:00Z'});const b=await readEventSource(f.profile,1,join(f.root,'timestamp-only'));assert.equal(a.result.semanticSha256,b.result.semanticSha256);assert.equal(b.result.modelTasksStarted,0);assert.ok((await f.get()).requests.every((r:any)=>r.method==='GET'&&!r.env.some((n:string)=>n==='ANTHROPIC_API_KEY'||n==='OPENAI_API_KEY'||n==='SSH_AUTH_SOCK')));
  assert.throws(()=>requireEventSource(JSON.parse(JSON.stringify(a)),f.profile,1),/actual_event_source/);
});
test('new exact head/target or material changes become distinct, while a known verified machine publication does not create a loop',async t=>{
  const f=await sourceFixture(t),a=await readEventSource(f.profile,1,join(f.root,'base'));
  const comment={id:1,user:{id:22},body:'fixed original machine publication',updated_at:'2026-10-20T00:00:00Z'};await f.change({comments:[comment]});
  const own=await readEventSource(f.profile,1,join(f.root,'own-record'),[{id:1,bodySha256:hash(comment.body)}]);assert.equal(own.result.semanticSha256,a.result.semanticSha256);
  await f.change({comments:[{...comment,body:'new evidence which must be assessed'}]});const changed=await readEventSource(f.profile,1,join(f.root,'new-material'),[{id:1,bodySha256:hash(comment.body)}]);assert.notEqual(changed.result.semanticSha256,a.result.semanticSha256);assert.equal(changed.result.complete,true);
  await f.change({H:'c'.repeat(40),B:'d'.repeat(40),target:'other'});const next=await readEventSource(f.profile,1,join(f.root,'new-candidate'));assert.equal(next.result.candidate?.H,'c'.repeat(40));assert.equal(next.result.candidate?.B,'d'.repeat(40));assert.equal(next.result.candidate?.targetRef,'other');
});
test('forbidden, malformed pagination and a moving candidate stay explicit incomplete observations',async t=>{
  const f=await sourceFixture(t);let n=0;
  for(const mode of ['forbidden-comments','bad-pagination','move-during-read']){await f.change({mode,prReads:0});const r=await readEventSource(f.profile,1,join(f.root,'gap-'+(++n)));assert.equal(r.result.complete,false);assert.ok(r.result.gaps.length);assert.equal(r.result.modelTasksStarted,0);}
  const http=new PublicationHttp(f.root,f.profile.ghExecutable,f.profile.ghSha256,f.profile.repository,1,'a'.repeat(40),'main',true);await assert.rejects(http.request('POST','repos/fixture/events/issues/1/comments',{body:'forbidden'}),/readonly_source_mutation_denied/);
});
test('all pages are read once and stored bytes are retained separately from the compact semantic facts',async t=>{
  const f=await sourceFixture(t),comments=Array.from({length:105},(_,i)=>({id:i+1,user:{id:11},body:'source '+i}));await f.change({comments});const r=await readEventSource(f.profile,1,join(f.root,'pages'));assert.equal(r.result.complete,true,JSON.stringify(r.result.gaps));assert.equal(r.records.filter(r=>r.kind==='comments').length,2);assert.equal(r.result.semantic.comments.length,105);
  r.records.find(r=>r.kind==='comments')!.body[0]=0;assert.throws(()=>requireEventSource(r,f.profile,1),/event_source_original_changed/);
});
