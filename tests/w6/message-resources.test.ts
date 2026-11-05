import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from './message-fixture.js';
import {messageAuthority} from './message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {runMessages} from '../../src/messages.js';
import {closeUnstartedResource} from '../../src/resource-claims.js';
import {QueueStore} from '../../src/queue-store.js';
import {messagePlanId} from '../../src/message-contract.js';
import {readOwnerSource} from '../../src/authority-source.js';

async function setup(t:test.TestContext,providerMode='normal',messageMode='complete',single=false){
  const f=await messageFixture(t,messageMode),ledger=await ledgerFixture(t,providerMode),spec=ledger.profile.resources[0]!;
  if(single)f.plan.messages=f.plan.messages.slice(0,1);
  f.plan.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];
  const authority=await messageAuthority(f);f.q.resources().configure(Buffer.from(JSON.stringify(ledger.profile)));await f.write();return {...f,ledger,authority};
}
test('a lost claim reply keeps the exact governed message unsent; original lookup completes it once',async t=>{
  const f=await setup(t,'lost-after-claim'),first=await runMessages(f.store,f.path);assert.equal(first.completed,false);assert.equal(first.newModelRequests,0);assert.equal((await f.calls()).length,0);assert.equal(f.ledger.state().claims.length,1);
  const binding=f.q.messageResources().state(first.run);assert.equal(f.q.resources().status(binding.resourceRequests[0]).state,'claim_unknown');
  const trace=await readFile(f.trace),readOnly=await runMessages(f.store,f.path,true);assert.equal(readOnly.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
  const next=await runMessages(f.store,f.path);assert.equal(next.completed,true,JSON.stringify(next.problems));assert.equal(next.newModelRequests,4);assert.equal(next.resources[0]!.state,'consumed');assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('lost settlement is reconciled from the original provider after revocation without another input or result write',async t=>{
  const f=await setup(t,'lost-after-result'),first=await runMessages(f.store,f.path);assert.equal(first.completed,true);assert.equal(first.resourcesSettled,false);assert.equal(first.resources[0]!.state,'result_pending_or_unknown');assert.equal(f.ledger.state().settlements.length,1);
  const trace=await readFile(f.trace);await f.authority.adopt({kind:'revoke',decision:f.authority.confirmed.sha});let checks=0;const again=await runMessages(f.store,f.path,false,undefined,undefined,undefined,async()=>{checks++;throw Error('owner_feedback_adopted_requirement_changed');});assert.equal(checks,0);assert.equal(again.completed,true);assert.equal(again.resourcesSettled,true);assert.equal(again.newModelRequests,0);assert.equal(again.resources[0]!.state,'consumed');assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('a newer provider unknown after the first reply stops later messages and repeated entry never resends the original',async t=>{
  const f=await setup(t,'normal','delay'),running=runMessages(f.store,f.path),deadline=Date.now()+6000;while(!(await f.calls()).some(c=>c.kind==='input')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.ok((await f.calls()).some(c=>c.kind==='input'));
  const db=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite')),row=db.prepare('SELECT result FROM requests').get() as any,value=JSON.parse(row.result);value.claim.state='unknown';db.prepare('UPDATE requests SET result=?').run(JSON.stringify(value));db.close();
  const result=await running;assert.equal(result.completed,false);assert.equal(result.newModelRequests,1);assert.match(JSON.stringify(result.problems),/fresh_original_held_resource_claim_required/);const binding=f.q.messageResources().state(result.run);assert.equal(f.q.resources().status(binding.resourceRequests[0]).state,'claim_unknown');
  const trace=await readFile(f.trace);let checks=0;const again=await runMessages(f.store,f.path,false,undefined,undefined,undefined,async()=>{checks++;throw Error('owner_feedback_adopted_requirement_changed');});assert.equal(checks,0);assert.equal(again.completed,false);assert.equal(again.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,0);
});
for(const mode of ['complete','waiting'])test('an ordinary single-message '+mode+' capture cannot be cancelled as zero input',async t=>{
 const f=await setup(t,'normal',mode,true),first=await runMessages(f.store,f.path);assert.equal(first.newModelRequests,1);assert.ok(f.q.messages().status(first.run).messages[0]!.sent);const trace=await readFile(f.trace),before=f.ledger.state();
 assert.throws(()=>f.q.messageResources().cancelUnstarted(first.run),/message_original_zero_input_not_proven/);
 await assert.rejects(runMessages(f.store,f.path,'cancel-unstarted',first.run),/message_original_zero_input_not_proven|message_original_capture_unresolved/);
 assert.deepEqual(await readFile(f.trace),trace);assert.deepEqual(f.ledger.state(),before);assert.equal(before.claims.length,1);assert.equal(before.settlements.length,mode==='complete'?1:0);
});

async function currentObservations(f:Awaited<ReturnType<typeof setup>>,authorization:string){
 const a=f.q.authority(),profile=a.configuration().profile,observations=[];
 for(const ref of a.sourceRequests(authorization))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(f.root,'fresh-cancel-source-'+ref.commentId+'-'+Date.now())));
 return observations;
}
async function unclaimed(t:test.TestContext,mode='normal'){
 const f=await setup(t,mode,'complete',true);let checks=0;
 const first=await runMessages(f.store,f.path,false,undefined,undefined,undefined,async()=>{if(++checks===2)throw Error('fixture_pause_before_claim');});
 assert.equal(checks,2);assert.equal(first.newModelRequests,0);const binding=f.q.messageResources().state(first.run),id=binding.resourceRequests[0]!;
 assert.equal(f.q.resources().status(id).claimAttempts,0);return {...f,run:first.run,binding,id,observations:await currentObservations(f,f.authority.confirmed.sha)};
}
test('ordinary coordinate cancellation closes an unclaimed stage before inbox cleanup and forbids a late provider dispatch',async t=>{
 const f=await unclaimed(t),r=f.q.resources(),command=r.command(f.id,'claim'),cap=await f.ledger.call(r.command(f.id,'capabilities')),other=await QueueStore.open(f.store);
 try{
  // The original provider dispatch has prepared its input, but not registered
  // a claim or launched. A separate queue handle commits cancellation first.
  await assert.rejects(f.ledger.call(command,dir=>{other.messageResources().cancelUnstarted(f.run);r.dispatchClaim(f.id,cap,f.observations,'coordinator',dir);}),/message_resource_phase_no_longer_pending/);
 }finally{other.close();}
 assert.equal(f.q.messageResources().settled(f.run),true);assert.equal(r.status(f.id).claimAttempts,0);assert.equal(r.settledOutcome(f.id),false);assert.equal(f.ledger.state().claims.length,0);
 for(let n=0;n<2;n++){const closed=await runMessages(f.store,f.path,'cancel-unstarted',f.run);assert.equal(closed.resourcesSettled,true);assert.equal(closed.newModelRequests,0);}
 const cold=await QueueStore.open(f.store);try{assert.equal(cold.messageResources().settled(f.run),true);}finally{cold.close();}
 assert.equal(f.ledger.state().claims.length,0);assert.equal(f.ledger.state().settlements.length,0);assert.deepEqual(await f.calls(),[]);
 // A different, valid ordinary message can reuse the original operation once
 // the cancelled predecessor has no remaining provider obligation.
 f.plan.authorityIntent='after-cancel';f.plan.messages[0]!.id='after-cancel';const request={...f.authority.request,payloadSha256:messagePlanId(f.plan)},confirmation=await f.authority.adopt({kind:'confirm_action',adoption:f.authority.scope.sha,performerRole:'coordinator',request,expiresAt:new Date(Date.now()+3600000).toISOString()});
 f.authority.a.reserveAction(f.plan.authorityIntent,request,'coordinator',confirmation.sha,await currentObservations(f,confirmation.sha));await f.write();
 const next=await runMessages(f.store,f.path);assert.equal(next.completed,true,JSON.stringify(next));assert.equal(next.resourcesSettled,true);assert.equal(next.newModelRequests,1);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('cancellation while the original consumer awaits its claim gate never starts a resource or model',async t=>{
 const f=await setup(t,'normal','complete',true);let checks=0;
 const result=await runMessages(f.store,f.path,false,undefined,undefined,undefined,async()=>{if(++checks===2)f.q.messageResources().cancelUnstarted(messagePlanId(f.plan));});
 assert.equal(result.newModelRequests,0);assert.equal(result.resourcesSettled,true);assert.match(JSON.stringify(result.problems),/message_resource_phase_no_longer_pending/);assert.equal(f.ledger.state().claims.length,0);assert.equal(f.ledger.state().settlements.length,0);assert.deepEqual(await f.calls(),[]);
});
test('a dispatched claim proved unstarted is not mistaken for an application that was never claimed',async t=>{
 const f=await unclaimed(t),r=f.q.resources(),cap=await f.ledger.call(r.command(f.id,'capabilities'));let directory='';
 await assert.rejects(f.ledger.call(r.command(f.id,'claim'),dir=>{directory=dir;r.dispatchClaim(f.id,cap,f.observations,'coordinator',dir);throw Error('fixture_stop_before_provider_launch');}),/fixture_stop_before_provider_launch/);
 r.controllerReturned(f.id,'claim',directory);const closed=await closeUnstartedResource(f.store,f.id,'claim');assert.equal(closed.state,'prepared_not_sent');assert.equal(closed.claimAttempts,1);
 await assert.rejects(runMessages(f.store,f.path,'cancel-unstarted',f.run),/fresh_original_held_resource_claim_required/);assert.equal(f.q.messageResources().state(f.run).phase,'resources_pending');assert.equal(r.unclaimedForCancellation(f.id,f.binding.operation,f.binding.authorityIntent),false);assert.equal(f.ledger.state().claims.length,0);assert.equal(f.ledger.state().settlements.length,0);
});
test('a lost original claim remains unknown until lookup proves held; cancellation settles only that actual claim',async t=>{
 const f=await setup(t,'lost-after-claim','complete',true),first=await runMessages(f.store,f.path),binding=f.q.messageResources().state(first.run),id=binding.resourceRequests[0]!,db=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite')),row=db.prepare('SELECT result FROM requests WHERE id=?').get(id) as any,held=JSON.parse(row.result),unknown=structuredClone(held);unknown.claim.state='unknown';db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(unknown),id);
 try{
  await assert.rejects(runMessages(f.store,f.path,'cancel-unstarted',first.run),/fresh_original_held_resource_claim_required/);assert.equal(f.q.messageResources().state(first.run).phase,'resources_pending');assert.equal(f.q.resources().status(id).claimAttempts,1);assert.equal(f.q.resources().status(id).outcome,null);assert.equal(f.ledger.state().settlements.length,0);
  db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(held),id);
 }finally{db.close();}
 for(let n=0;n<2;n++){const cancelled=await runMessages(f.store,f.path,'cancel-unstarted',first.run);assert.equal(cancelled.resourcesSettled,true);assert.equal(cancelled.newModelRequests,0);}
 assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.equal(JSON.parse((f.ledger.state().settlements[0] as any).body).state,'cancelled');assert.deepEqual(await f.calls(),[]);
});
