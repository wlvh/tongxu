import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../w3/receiver-fixture.js';
import { fixture as ledgerFixture } from './provider-fixture.js';
import { QueueStore } from '../../src/queue-store.js';
import { fixtureOwnerObservation } from '../../src/authority-source.js';
import { ownerDecisionText,scopeBodyHash,actionHash,type AuthorityProfile,type ActionRequest } from '../../src/authority-contract.js';
import { hash } from '../../src/snapshot.js';
import type { ResourceRequest } from '../../src/resource-contract.js';
import type { AuthorityRole } from '../../src/authority-contract.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resourceMain } from '../../src/resource-cli.js';
import { closeUnstartedResource } from '../../src/resource-claims.js';
import { DatabaseSync } from 'node:sqlite';

const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));let commentId=7100000000;
async function ready(t:test.TestContext,mode='normal',role:AuthorityRole='receiver'){
  const f=await setup(t),ledger=await ledgerFixture(t,mode),begun=f.q.begin(f.item,'resource-original-operation');f.q.evaluate(begun.operation);
  f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();
  const sources:Record<string,any>={},sourcePath=join(f.root,'owner-provider-data.json'),exe=join(f.root,'owner-provider.mjs');
  const sourceCode=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),data=JSON.parse(fs.readFileSync(${JSON.stringify(sourcePath)},'utf8'));if(args.includes('graphql')){const node=args.find(x=>x.startsWith('id=')).slice(3);const entry=Object.values(data).find(x=>x.comment.node_id===node);console.log(JSON.stringify(entry.graph));}else console.log(JSON.stringify(data[args.at(-1).split('/').at(-1)].comment));`;
  writeFileSync(exe,sourceCode,{mode:0o700});
  const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:7,ownerId:11,executorId:22,ghExecutable:exe,ghSha256:hash(sourceCode),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000};
  const a=f.q.authority();a.configure(bytes(profile));const resources=f.q.resources();resources.configure(bytes(ledger.profile));
  function adopt(p:any){const prepared=a.prepare('proposal-'+(++commentId),bytes(p)),sha=prepared.proposalSha256,id=commentId,body=ownerDecisionText(sha),at=new Date().toISOString(),url=`https://github.com/fixture/reception/issues/7#issuecomment-${id}`,nodeId='IC_fixture_'+id;
    const comment={id,node_id:nodeId,user:{id:11,type:'User'},body,created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/7',html_url:url};
    const graph={data:{viewer:{databaseId:22},node:{__typename:'IssueComment',id:nodeId,fullDatabaseId:String(id),author:{__typename:'User',databaseId:11},editor:null,lastEditedAt:null,body,createdAt:at,updatedAt:at,url,issue:{number:7,repository:{nameWithOwner:'fixture/reception'}}}}};
    sources[id]={graph,comment};writeFileSync(sourcePath,bytes(sources));const observation=fixtureOwnerObservation(profile,sha,id,bytes(graph),bytes(comment),at);a.apply(sha,observation);return {sha,observation};
  }
  const item=f.q.status().items.find((x:any)=>x.id===f.item),body={goals:['Fixture resource association'],nonGoals:['No business or supplier'],preserve:[],acceptance:['Retain original claims'],constraints:['No local balance']},scope=adopt({kind:'adopt_scope',scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,body,previousAdoption:null});
  const action:ActionRequest={schemaVersion:1,scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,scopeBodySha256:scopeBodyHash(body),repository:'fixture/reception',target:'fixture',action:'receive',item:f.item,candidate:{H:item.candidate.H,B:item.candidate.B,subjectSha256:null},paths:['sample.js'],resourceRefs:['existing-fixture-slot']};
  const confirmation=adopt({kind:'confirm_action',adoption:scope.sha,performerRole:role,request:action,expiresAt:new Date(Date.now()+3600000).toISOString()}),observations=[scope.observation,confirmation.observation];
  a.reserveAction('fixture-receiver',action,role,confirmation.sha,observations);
  const request:ResourceRequest={schemaVersion:1,ledgerId:ledger.profile.ledgerId,repository:action.repository,operation:begun.operation,authorityIntent:'fixture-receiver',resourceRef:'existing-fixture-slot',unit:'fixture-task',quantity:1,role,actionSha256:actionHash(action)};
  const record=resources.prepare(request,observations,role),id=record.id;
  const claim=async()=>{const cap=await ledger.call(resources.command(id,'capabilities')),command=resources.command(id,'claim');const reply=await ledger.call(command,dir=>resources.dispatchClaim(id,cap,observations,role,dir));return resources.observe(id,command,reply);};
  const lookup=async()=>{const c=resources.command(id,'lookup');return resources.observe(id,c,await ledger.call(c));};
  return {...f,ledger,resources,a,request,id,observations,scope,confirmation,adopt,action,claim,lookup,sourcePath};
}
test('same original QueueStore binds one resource request to exact action and operation; reentry keeps its id',async t=>{
  const f=await ready(t);assert.equal(f.q.status().schemaVersion,13);assert.equal(f.resources.status(f.id).state,'prepared_not_sent');
  assert.equal(f.resources.prepare(f.request,[],'receiver').duplicate,true);
  assert.throws(()=>f.resources.prepare({...f.request,role:'background'},f.observations,'receiver'),/trusted_role_mismatch/);
  assert.throws(()=>f.resources.prepare({...f.request,quantity:2},f.observations,'receiver'),/outside_fixed_boundary/);
  const got=await f.claim();assert.equal(got.state,'held');assert.equal(got.claimAttempts,1);assert.equal(f.ledger.state().claims.length,1);
  const q=await QueueStore.open(f.store);try{assert.equal(q.resources().status(f.id).claim.id,got.claim.id);assert.equal(q.resources().prepare(f.request,[],'receiver').duplicate,true);}finally{q.close();}
  const cap=await f.ledger.call(f.resources.command(f.id,'capabilities'));await assert.rejects(f.ledger.call(f.resources.command(f.id,'claim'),dir=>f.resources.dispatchClaim(f.id,cap,f.observations,'receiver',dir)),/lookup_not_resend/);assert.equal(f.ledger.state().claims.length,1);
  assert.throws(()=>f.resources.prepareOutcome(f.id),/execution_consumer_binding_required/);
});
test('operator CLI runs fixed original-source reads and one claim, then survives unavailable sources without resending',async t=>{
  const f=await ready(t,'normal','background'),path=join(f.root,'resource-request.json');writeFileSync(path,bytes(f.request));
  assert.equal((await resourceMain(['prepare','--store',f.store,'--request',path])).duplicate,true);
  const first=await resourceMain(['claim','--store',f.store,'--id',f.id]);assert.equal(first.state,'held');assert.equal(first.executionKind,'fixture');assert.equal(f.ledger.state().claims.length,1);
  writeFileSync(f.sourcePath,'{}');
  assert.equal((await resourceMain(['prepare','--store',f.store,'--request',path])).duplicate,true);
  const again=await resourceMain(['claim','--store',f.store,'--id',f.id]);assert.equal(again.newProviderCall,false);assert.equal(f.ledger.state().claims.length,1);
  await assert.rejects(resourceMain(['claim','--store',f.store,'--id',f.id,'--role','receiver']),/invalid_resource_command/);
  assert.equal((await resourceMain(['lookup','--store',f.store,'--id',f.id])).state,'held');
});
test('lost reply persists original intent across restart; lookup restores held without another claim or clearing a revoked source',async t=>{
  const f=await ready(t,'lost-after-claim');await assert.rejects(f.claim(),/execution_incomplete/);assert.equal(f.resources.status(f.id).state,'claim_unknown');assert.equal(f.ledger.state().claims.length,1);
  f.adopt({kind:'revoke',decision:f.confirmation.sha});
  const recovered=await f.lookup();assert.equal(recovered.state,'held');assert.equal(recovered.claimAttempts,1);assert.equal(f.resources.prepare(f.request,[],'receiver').duplicate,true);assert.equal(f.ledger.state().remaining,0);
  const cap=await f.ledger.call(f.resources.command(f.id,'capabilities'));assert.throws(()=>f.resources.dispatchClaim(f.id,cap,f.observations,'receiver','fixture-extra'),/lookup_not_resend/);
});
test('credential unavailability and Owner stop prevent a claim without deleting its prepared original',async t=>{
  const f=await ready(t,'credentials-missing');await assert.rejects(f.claim(),/credentials_unavailable/);assert.equal(f.resources.status(f.id).state,'prepared_not_sent');assert.equal(f.ledger.state().claims.length,0);
  const g=await ready(t);g.adopt({kind:'control',adoption:g.scope.sha,control:'investment',state:'stopped'});await assert.rejects(g.claim(),/action_stopped/);assert.equal(g.resources.status(g.id).claimAttempts,0);
  g.adopt({kind:'control',adoption:g.scope.sha,control:'investment',state:'open'});assert.equal((await g.claim()).state,'held');
});
test('an active or unknown original target occupation blocks new resource claims but its confirmed completion permits the same request',async t=>{
  const f=await ready(t),other=await f.packet({pr:2}),active=f.q.begin(other.item,'explicit-existing-shadow-owner');
  await assert.rejects(f.claim(),/target_execution_active_or_unknown/);assert.equal(f.ledger.state().claims.length,0);assert.equal(f.resources.status(f.id).state,'prepared_not_sent');
  f.q.evaluate(active.operation);assert.equal((await f.claim()).state,'held');assert.equal(f.resources.status(f.id).claimAttempts,1);
});
test('two queue connections cannot dispatch the same resource intent twice; lookup absent does not erase sent unknown',async t=>{
  const f=await ready(t),cap=await f.ledger.call(f.resources.command(f.id,'capabilities')),q=await QueueStore.open(f.store);t.after(()=>q.close());
  f.resources.dispatchClaim(f.id,cap,f.observations,'receiver','fixture-capture-interruption-before-spawn');assert.throws(()=>q.resources().dispatchClaim(f.id,cap,f.observations,'receiver','competing'),/lookup_not_resend/);
  assert.equal((await f.lookup()).state,'claim_unknown');assert.equal(f.ledger.state().claims.length,0);assert.equal(f.resources.status(f.id).claimAttempts,1);
});
test('explicit fixture execution outcome remains pending after lost settlement; original lookup confirms one settlement without refund',async t=>{
  const f=await ready(t,'lost-after-result');await f.claim();
  // Only the trusted execution adapter is replaced with explicit test evidence;
  // the public result path accepts no model-provided report or success flag.
  (f.q as any).resourceExecution=()=>({state:'failed',source:'explicit-test-execution-adapter',proof:bytes({kind:'fixture_known_failed_execution',operation:f.request.operation}),executionKind:'fixture'});
  const prepared=f.resources.prepareOutcome(f.id);assert.equal(prepared.state,'result_pending');
  const cap=await f.ledger.call(f.resources.command(f.id,'capabilities')),c=f.resources.command(f.id,'record_result');
  await assert.rejects(f.ledger.call(c,dir=>f.resources.dispatchResult(f.id,cap,dir)),/execution_incomplete/);assert.equal(f.resources.status(f.id).state,'result_pending');assert.equal(f.ledger.state().settlements.length,1);
  assert.throws(()=>f.resources.dispatchResult(f.id,cap,'new-directory'),/lookup_not_resend/);
  const recovered=await f.lookup();assert.equal(recovered.state,'consumed');assert.equal(recovered.claim.outcomeSha256,prepared.outcome.outcomeSha256);assert.equal(f.ledger.state().settlements.length,1);assert.equal(f.ledger.state().remaining,0);assert.equal(f.resources.prepareOutcome(f.id).duplicate,true);
});
test('confirmed ended before-launch claim can continue under the same request; active controller and known launch cannot be cleared',async t=>{
  const f=await ready(t),cap=await f.ledger.call(f.resources.command(f.id,'capabilities'));let directory='';
  await assert.rejects(f.ledger.call(f.resources.command(f.id,'claim'),dir=>{directory=dir;f.resources.dispatchClaim(f.id,cap,f.observations,'receiver',dir);throw new Error('fixture_interrupt_before_spawn');}),/fixture_interrupt/);
  assert.equal(f.resources.status(f.id).state,'claim_unknown');await assert.rejects(closeUnstartedResource(f.store,f.id,'claim'),/controller_active/);
  f.resources.controllerReturned(f.id,'claim',directory);
  const closed=await closeUnstartedResource(f.store,f.id,'claim');assert.equal(closed.state,'prepared_not_sent');assert.equal(closed.claimAttempts,1);assert.equal(f.ledger.state().claims.length,0);
  assert.equal((await closeUnstartedResource(f.store,f.id,'claim')).duplicate,true);
  const done=await f.claim();assert.equal(done.state,'held');assert.equal(done.claimAttempts,2);assert.equal(f.ledger.state().claims.length,1);
  const ref=f.resources.originalDispatch(f.id,'claim');f.resources.controllerReturned(f.id,'claim',ref.directory);await assert.rejects(closeUnstartedResource(f.store,f.id,'claim'),/provider_started_or_unknown/);
});
test('known-unstarted result report can continue, while a different terminal outcome cannot be overwritten',async t=>{
  const f=await ready(t);await f.claim();(f.q as any).resourceExecution=()=>({state:'completed',source:'explicit-fixture-execution',proof:bytes({kind:'fixture-execution',operation:f.request.operation}),executionKind:'fixture'});f.resources.prepareOutcome(f.id);
  const cap=await f.ledger.call(f.resources.command(f.id,'capabilities')),command=f.resources.command(f.id,'record_result');let directory='';
  await assert.rejects(f.ledger.call(command,dir=>{directory=dir;f.resources.dispatchResult(f.id,cap,dir);throw new Error('fixture_result_prelaunch_interruption');}),/prelaunch/);
  f.resources.controllerReturned(f.id,'result',directory);const recovered=await closeUnstartedResource(f.store,f.id,'result');assert.equal(recovered.pendingResultAttempt,false);assert.equal(recovered.resultAttempts,1);
  const observation=await f.ledger.call(command,dir=>f.resources.dispatchResult(f.id,cap,dir));assert.equal(f.resources.observe(f.id,command,observation).state,'consumed');assert.equal(f.ledger.state().settlements.length,1);
  const g=await ready(t);await g.claim();(g.q as any).resourceExecution=()=>({state:'completed',source:'explicit-fixture-execution',proof:bytes({kind:'intended-fixture-outcome'}),executionKind:'fixture'});g.resources.prepareOutcome(g.id);
  const wrong=g.resources.command(g.id,'record_result');wrong.outcome={...wrong.outcome!,evidenceSha256:hash('external conflicting result')};await g.ledger.call(wrong,()=>{});
  assert.equal((await g.lookup()).state,'result_conflict');const gc=await g.ledger.call(g.resources.command(g.id,'capabilities'));assert.throws(()=>g.resources.dispatchResult(g.id,gc,'overwrite-attempt'),/conflicting/);assert.equal(g.ledger.state().settlements.length,1);
});
test('one reserved authority intent cannot move to a new packet/operation and claim the same resource again',async t=>{
  const f=await ready(t);await f.claim();const ledger=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite'));ledger.prepare('UPDATE capacity SET n=2').run();ledger.close();
  const material=await f.packet(),next=f.q.begin(material.item,'same-H-new-material');f.q.evaluate(next.operation);
  assert.equal(material.item,f.item);assert.notEqual(next.operation,f.request.operation);
  assert.throws(()=>f.resources.prepare({...f.request,operation:next.operation},f.observations,'receiver'),/authority_reserved_material_changed|intent_already_bound/);
  assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().remaining,2);assert.equal(f.a.status().intents.length,1);
  assert.equal((await f.lookup()).state,'held');assert.equal(f.resources.prepare(f.request,[],'receiver').duplicate,true);
});
test('persisted execution proof and provider originals are revalidated before result sending; exact original restoration permits continuation',async t=>{
  const f=await ready(t);await f.claim();(f.q as any).resourceExecution=()=>({state:'failed',source:'explicit-fixture-execution',proof:bytes({kind:'known-fixture-failure'}),executionKind:'fixture'});const prepared=f.resources.prepareOutcome(f.id);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());const digest=prepared.outcome.outcome.evidenceSha256,original=Buffer.from((db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(digest) as any).bytes);
  db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('storage corruption fixture'),digest);
  await assert.rejects(resourceMain(['record-result','--store',f.store,'--id',f.id]),/original_missing_or_changed/);assert.equal(f.ledger.state().settlements.length,0);assert.equal(f.resources.status(f.id).resultAttempts,0);
  db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(original,digest);
  assert.equal((await resourceMain(['record-result','--store',f.store,'--id',f.id])).state,'consumed');assert.equal(f.ledger.state().settlements.length,1);
  const observed=f.q.status().events.find((e:any)=>e.kind==='resource_reply_observed'),ref=JSON.parse(observed.data).rawSha256,raw=Buffer.from((db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(ref) as any).bytes);
  db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('broken provider source'),ref);assert.throws(()=>f.resources.status(f.id),/original_missing_or_changed/);db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(raw,ref);assert.equal(f.resources.status(f.id).state,'consumed');
});
