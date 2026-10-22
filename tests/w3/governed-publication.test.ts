import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {governedPublicationFixture} from './governed-publication-fixture.js';
import {publication} from '../../src/publisher.js';
import {QueueStore} from '../../src/queue-store.js';
import {readOwnerSource} from '../../src/authority-source.js';

test('governed publication consumes its exact permission and original resource, then repeats without new POST or model',async t=>{
  const f=await governedPublicationFixture(t),before=await readFile(f.trace),prepared=await publication(f.pubPath,'prepare');assert.equal(prepared.status,'prepared_not_sent');assert.equal(prepared.publicationPayloadSha256,f.owner.request.payloadSha256);assert.equal((await f.remote()).posts.length,0);assert.equal(f.ledger.state().claims.length,0);
  const result=await publication(f.pubPath,'publish');assert.equal(result.status,'published_verified');assert.equal(result.remoteCurrent,true);assert.equal(result.resourcesSettled,true);assert.equal((await f.remote()).posts.length,2);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.ok((await readFile(f.trace)).equals(before));
  assert.equal((await publication(f.pubPath,'prepare')).status,'prepared_original_dispatch_exists');assert.equal((await f.remote()).posts.length,2);
  await f.owner.adopt({kind:'revoke',decision:f.owner.confirmed.sha});const again=await publication(f.pubPath,'publish');assert.equal(again.status,'published_verified');assert.equal(again.resourcesSettled,true);assert.equal((await f.remote()).posts.length,2);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.ok((await readFile(f.trace)).equals(before));
});

test('a stop at the actual publication effect proves no send, then resumes the original held resource',async t=>{
  const f=await governedPublicationFixture(t),original=QueueStore.prototype.publicationEffect;
  QueueStore.prototype.publicationEffect=function(id,stage,directory,observations,effect){f.q.control('scope','investment','stopped','Explicit fixture stop at final POST gate');return (original as any).call(this,id,stage,directory,observations,effect);};
  try{await assert.rejects(publication(f.pubPath,'publish'),/new_investment_stopped/);}finally{QueueStore.prototype.publicationEffect=original;}
  assert.equal((await f.remote()).posts.length,0);const state=f.q.publicationState(f.p.operation),closed=state.events.find((e:any)=>e.kind==='dispatch_unstarted');assert.equal(state.pendingDispatches.length,0);assert.equal(closed.proof,'trusted_live_effect_not_invoked');assert.equal(JSON.parse(await readFile(join(closed.directory,'dispatch-error.json'),'utf8')).spawnAttempted,false);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,0);
  f.q.control('scope','investment','open','Explicit fixture resumes only this local stop');const resumed=await publication(f.pubPath,'publish');assert.equal(resumed.status,'published_verified');assert.equal(resumed.resourcesSettled,true);assert.equal((await f.remote()).posts.length,2);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.equal(f.q.publicationState(f.p.operation).events.filter((e:any)=>e.kind==='dispatch_unstarted').length,1);
});

test('unknown publication keeps its original resource and cannot be retried or replaced',async t=>{
  const f=await governedPublicationFixture(t,'empty-no-create');await assert.rejects(publication(f.pubPath,'publish'),/response_unknown/);assert.equal((await f.remote()).posts.length,1);assert.equal(f.q.resources().status(f.resourceId).state,'held');
  await f.change({mode:'normal'});assert.equal((await publication(f.pubPath,'reconcile')).status,'publication_pending_or_unknown');assert.equal((await publication(f.pubPath,'publish')).status,'publication_pending_or_unknown');await assert.rejects(publication(f.pubPath,'retry-rejected','Cannot turn unknown into rejected'),/explicit_rejected_retry_required/);assert.equal((await f.remote()).posts.length,1);assert.equal(f.ledger.state().settlements.length,0);
  await writeFile(f.pubPath,JSON.stringify({...f.p,source:'Changed plan must not replace an unknown request'}));await assert.rejects(publication(f.pubPath,'prepare'),/publication_plan_or_result_changed/);assert.equal((await f.remote()).posts.length,1);
});

test('explicit status rejection retries only that stage under the same publication resource',async t=>{
  const f=await governedPublicationFixture(t,'reject-status');const first=await publication(f.pubPath,'publish');assert.equal(first.status,'publication_pending_or_unknown');assert.equal(f.q.resources().status(f.resourceId).state,'held');assert.equal((await f.remote()).posts.length,2);assert.equal(f.ledger.state().settlements.length,0);
  await publication(f.pubPath,'publish');assert.equal((await f.remote()).posts.length,2);const resumed=await publication(f.pubPath,'retry-rejected','Explicit retry of the definitively rejected local fixture status');assert.equal(resumed.status,'published_verified');assert.equal(resumed.resourcesSettled,true);assert.equal((await f.remote()).comments.length,1);assert.equal((await f.remote()).posts.length,3);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});

for(const mode of ['lost-after-claim','lost-after-result'])test('governed publication looks up the original resource after '+mode,async t=>{
  const f=await governedPublicationFixture(t,'normal',mode);
  if(mode==='lost-after-claim'){await assert.rejects(publication(f.pubPath,'publish'));assert.equal((await f.remote()).posts.length,0);}else{const first=await publication(f.pubPath,'publish');assert.equal(first.status,'published_verified');assert.equal(first.resourcesSettled,false);assert.equal((await f.remote()).posts.length,2);}
  const resumed=await publication(f.pubPath,'publish');assert.equal(resumed.status,'published_verified');assert.equal(resumed.resourcesSettled,true);assert.equal((await f.remote()).posts.length,2);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});

test('a revoked or differently scoped publication permission cannot claim resources or send',async t=>{
  const f=await governedPublicationFixture(t);await f.owner.adopt({kind:'revoke',decision:f.owner.confirmed.sha});await assert.rejects(publication(f.pubPath,'publish'),/owner_decision_revoked/);assert.equal((await f.remote()).posts.length,0);assert.equal(f.ledger.state().claims.length,0);
  const g=await governedPublicationFixture(t),request={...g.owner.request,payloadSha256:'f'.repeat(64)},wrong=await g.owner.adopt({kind:'confirm_action',adoption:g.owner.scope.sha,performerRole:'background',request,expiresAt:new Date(Date.now()+3600000).toISOString()}),observations=[];
  for(const [i,ref] of g.owner.a.sourceRequests(wrong.sha).entries())observations.push(await readOwnerSource(g.owner.profile,ref.proposalSha256,ref.commentId,join(g.root,'wrong-scope-source-'+i)));
  g.owner.a.reserveAction('other-publication-intent',request,'background',wrong.sha,observations);await writeFile(g.pubPath,JSON.stringify({...g.p,governance:{...g.p.governance,authorityIntent:'other-publication-intent'}}));await assert.rejects(publication(g.pubPath,'publish'),/publication_exact_authority_required/);assert.equal((await g.remote()).posts.length,0);assert.equal(g.ledger.state().claims.length,0);
});

test('the actual prior publisher remains refused, while the exact new consumer can continue the unsent preview',{skip:!process.env.TONGXU_LEGACY_PUBLICATION_SOURCE},async t=>{
  const old=await import(pathToFileURL(join(process.env.TONGXU_LEGACY_PUBLICATION_SOURCE!,'dist/src/publisher.js')).href),f=await governedPublicationFixture(t),legacy=join(f.root,'old-publication-plan.json'),{governance,...p}=f.p;await writeFile(legacy,JSON.stringify(p));
  await assert.rejects(old.publication(legacy,'publish'),/authority_consumer_binding_required/);assert.equal((await f.remote()).posts.length,0);assert.equal(f.ledger.state().claims.length,0);
  await publication(f.pubPath,'prepare');const result=await publication(f.pubPath,'publish');assert.equal(result.status,'published_verified');assert.equal(result.resourcesSettled,true);assert.equal((await f.remote()).posts.length,2);
});

test('after-input transaction rollback retains the original request and recovers its remote result without another POST',async t=>{
  const f=await governedPublicationFixture(t,'sync-input'),original=QueueStore.prototype.publicationEffect;let injected=false;
  QueueStore.prototype.publicationEffect=function(id,stage,directory,observations,effect){return (original as any).call(this,id,stage,directory,observations,()=>{const value=effect();if(!injected){const deadline=Date.now()+5000;while(!JSON.parse(readFileSync(f.remotePath,'utf8')).posts.length&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.equal(JSON.parse(readFileSync(f.remotePath,'utf8')).posts.length,1,'fixture must actually receive the first POST before rollback');injected=true;throw new Error('fixture_transaction_failed_after_input');}return value;});};
  try{await assert.rejects(publication(f.pubPath,'publish'),/fixture_transaction_failed_after_input/);}finally{QueueStore.prototype.publicationEffect=original;}
  const pending=f.q.publicationState(f.p.operation);assert.equal(pending.pendingDispatches.length,1);assert.equal(pending.stages.comment.intent,undefined);const directory=pending.pendingDispatches[0].directory,proof=JSON.parse(await readFile(join(directory,'dispatch-error.json'),'utf8'));assert.equal(proof.inputMayHaveBeenSubmitted,true);assert.equal(f.q.resources().status(f.resourceId).state,'held');
  const originals=new Map<string,Buffer>();for(const name of ['process.json','exit.json','submission-intent.json','submitted.json']){originals.set(name,await readFile(join(directory,name)));await rm(join(directory,name));}const errorPath=join(directory,'dispatch-error.json'),errorBytes=await readFile(errorPath);await writeFile(errorPath,JSON.stringify({...proof,spawnAttempted:false,inputMayHaveBeenSubmitted:false}));
  try{await assert.rejects(publication(f.pubPath,'publish'),/publication_original_process_unknown/);assert.equal((await f.remote()).posts.length,1);assert.equal(f.q.publicationState(f.p.operation).pendingDispatches.length,1);assert.equal(f.ledger.state().settlements.length,0);assert.throws(()=>f.q.publicationEvent(f.p.operation,'dispatch_unstarted' as any,'comment',{directory}),/publication_event_kind_invalid/);assert.throws(()=>f.q.publicationEffect(f.p.operation,'comment',directory,[],()=>{throw new Error('must not run');}),/publication_live_preparation_required/);}finally{for(const [name,bytes] of originals)await writeFile(join(directory,name),bytes,{mode:0o600});await writeFile(errorPath,errorBytes,{mode:0o600});}
  const before=(await f.remote()).posts.length;const recovered=await publication(f.pubPath,'reconcile');assert.equal(recovered.status,'publication_pending_or_unknown');assert.equal((await f.remote()).posts.length,before);assert.equal(f.q.publicationState(f.p.operation).pendingDispatches.length,0);assert.equal(f.q.publicationState(f.p.operation).stages.comment.intent.recoveredFromOriginalCapture,true);
  assert.equal(before,1);const completed=await publication(f.pubPath,'publish');assert.equal(completed.status,'published_verified');assert.equal(completed.resourcesSettled,true);assert.equal((await f.remote()).comments.length,1);assert.equal((await f.remote()).posts.length,2);assert.equal(f.ledger.state().settlements.length,1);
});

test('member format21 and publication guards share the original admission without blocking valid publication',async t=>{
  const f=await governedPublicationFixture(t,'normal','normal',true);assert.equal(f.q.status().schemaVersion,21);const result=await publication(f.pubPath,'publish');assert.equal(result.status,'published_verified');assert.equal(result.resourcesSettled,true);assert.equal((await f.remote()).posts.length,2);assert.equal(f.ledger.state().settlements.length,1);
});
