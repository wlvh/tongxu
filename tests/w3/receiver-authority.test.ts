import {ready} from './receiver-authority-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup} from './receiver-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {QueueStore} from '../../src/queue-store.js';
import {runReception,reconcileReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';
import {ownerDecisionText,scopeBodyHash,actionHash,type AuthorityProfile,type ActionRequest} from '../../src/authority-contract.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';
import type {ResourceRequest} from '../../src/resource-contract.js';
import {enableMemberRefutationFormat} from '../../src/queue-format.js';
import {LiveProcess} from '../../src/live-process.js';
import {candidateFixture,raw as integrationRaw} from '../integration/fixture.js';
const raw=(x:unknown)=>Buffer.from(JSON.stringify(x));


for(const resources of [false,true])test('governed reception consumes its own exact permission and original resources once: '+resources,async t=>{
  const f=await ready(t,resources),r=await runReception(f.path);assert.equal(r.receiver.phase,'returned');assert.equal(r.receiver.authorityIntent,f.intent);assert.equal(r.receiver.controllerReturned,true);assert.equal(await f.count(),1);assert.equal(f.q.authority().status().intents.length,1);
  if(f.ledger){assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'consumed');}
  await f.adopt({kind:'revoke',decision:f.confirmation.sha});const before=await readFile(f.trace),again=await runReception(f.path);assert.equal(again.receiver.phase,'returned');assert.equal(again.duplicate,true);assert.ok((await readFile(f.trace)).equals(before));assert.equal(f.q.status().events.filter((e:any)=>e.kind==='authority_receiver_bound').length,1);
});
test('governed receiver binds zero-resource permission to one plan and preserves both consumer opt-ins',async t=>{
  const f=await ready(t,false);f.a.enableGovernedReceiver();f.a.enableGovernedRepair();assert.equal(f.a.enableGovernedReceiver().duplicate,true);const original=await readFile(f.path);f.q.receiverResourceAdmission(f.operation,original,f.observations);
  await writeFile(f.path,raw({...f.plan,timeoutMs:4000}));await assert.rejects(runReception(f.path),/receiver_original_authority_binding_changed/);assert.equal(await f.count(),0);await writeFile(f.path,original);assert.equal((await runReception(f.path)).receiver.phase,'returned');assert.equal(await f.count(),1);
});
test('a fresh stop at the actual governed spawn gate causes zero inputs and preserves the original held resource',async t=>{
  const f=await ready(t),effect=QueueStore.prototype.receiverEffect;let stopped=false;
  QueueStore.prototype.receiverEffect=function(id,binding,observations,call){stopped=true;f.q.control(f.action.scopeId,'investment','stopped','explicit last-spawn stop fixture');return (effect as any).call(this,id,binding,observations,call);};t.after(()=>{QueueStore.prototype.receiverEffect=effect;});
  const r=await runReception(f.path);assert.equal(stopped,true);assert.equal(r.status,'receiver_unknown');assert.equal(r.newTaskSent,false);assert.equal(await f.count(),0);assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'held');assert.equal(f.ledger!.state().settlements.length,0);assert.equal(f.q.receiverState(f.operation).receiver.controllerReturned,true);
});
test('a lost resource result response is looked up on the original claim without another model task',async t=>{
  const f=await ready(t,true,'lost-after-result'),first=await runReception(f.path);assert.equal(first.receiver.phase,'returned');assert.equal(first.resources[0].state,'result_pending_or_unknown');assert.equal(await f.count(),1);assert.equal(f.ledger!.state().settlements.length,1);
  const again=await runReception(f.path);assert.equal(again.receiver.phase,'returned');assert.equal(again.resources[0].state,'consumed');assert.equal(await f.count(),1);assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);
});
test('missing, revoked and mismatched receive authority or original resources never dispatch',async t=>{
  const f=await ready(t),original=await readFile(f.path);await writeFile(f.path,raw({...f.plan,governance:undefined}));await assert.rejects(runReception(f.path),/authority_consumer_binding_required/);
  await writeFile(f.path,raw({...f.plan,governance:{...f.plan.governance,resourceRequests:[]}}));await assert.rejects(runReception(f.path),/receiver_resource_claim_set_mismatch/);
  await writeFile(f.path,original);await f.adopt({kind:'revoke',decision:f.confirmation.sha});await assert.rejects(runReception(f.path),/owner_decision_revoked/);assert.equal(await f.count(),0);assert.equal(f.ledger!.state().claims.length,0);
});
test('a preopened database cannot enter governed receiving without the current admission',async t=>{
  const f=await ready(t,false),db=new DatabaseSync(join(f.store,'queue.sqlite')),legacy=db.prepare("UPDATE operations SET status='receiving',result=? WHERE id=?");t.after(()=>db.close());f.a.enableGovernedReceiver();
  assert.throws(()=>legacy.run(JSON.stringify({receiver:{phase:'reserved',planSha256:hash(raw(f.plan)),authorityIntent:f.intent}}),f.operation),/authority_consumer_binding_required/);assert.equal(await f.count(),0);
});
test('a preopened resource dispatcher cannot claim a receiver resource without the exact bound consumer',async t=>{
  const f=await ready(t),db=new DatabaseSync(join(f.store,'queue.sqlite')),legacy=db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)');t.after(()=>db.close());f.a.enableGovernedReceiver();
  assert.throws(()=>legacy.run('resource_claim_dispatched','resource:'+f.resourceRequests[0],JSON.stringify({requestSha256:f.resourceRequests[0],originalOperation:f.operation}),new Date().toISOString()),/receiver_resource_binding_required/);
  assert.equal(f.ledger!.state().claims.length,0);assert.equal((await runReception(f.path)).receiver.phase,'returned');assert.equal(f.ledger!.state().claims.length,1);assert.equal(await f.count(),1);
});
test('governed receiver and the existing format21 member resource guard share one actual admission',async t=>{
  const f=await ready(t),db=new DatabaseSync(join(f.store,'queue.sqlite'));try{db.exec('BEGIN IMMEDIATE');enableMemberRefutationFormat(db);db.exec('COMMIT');}finally{db.close();}
  const result=await runReception(f.path);assert.equal(result.receiver.phase,'returned');assert.equal(f.q.status().schemaVersion,21);assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'consumed');assert.equal(await f.count(),1);
});
test('a lost claim receipt resumes the same unstarted reception using lookup, not another claim',async t=>{
  const f=await ready(t,true,'lost-after-claim');await assert.rejects(runReception(f.path));assert.equal(await f.count(),0);assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'claim_unknown');
  const recovered=await runReception(f.path);assert.equal(recovered.receiver.phase,'returned');assert.equal(await f.count(),1);assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);assert.equal(f.q.resources().status(f.resourceRequests[0]!).claimAttempts,1);
});
for(const mode of ['bad-binding','aborted'])test('governed capture retains invalid versus incomplete outcome: '+mode,async t=>{
  const f=await ready(t,true,'normal',mode),result=await runReception(f.path);assert.equal(await f.count(),1);
  if(mode==='bad-binding'){assert.equal(result.status,'receiver_invalid_result');assert.ok(result.receiver.invalidResult);assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'consumed');}
  else {assert.equal(result.status,'receiver_unknown');assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'held');assert.equal(f.ledger!.state().settlements.length,0);}
  await runReception(f.path);assert.equal(await f.count(),1);
});
test('a test permission cannot become receive permission, and a later source invalidates the original receive intent',async t=>{
  const f=await ready(t,false),request={...f.action,action:'test' as const},confirmation=await f.adopt({kind:'confirm_action',adoption:f.scope.sha,performerRole:'background',request,expiresAt:new Date(Date.now()+3600000).toISOString()});
  f.a.reserveAction('wrong-action',request,'background',confirmation.sha,[f.scope.observation,confirmation.observation]);await writeFile(f.path,raw({...f.plan,governance:{authorityIntent:'wrong-action',resourceRequests:[]}}));await assert.rejects(runReception(f.path),/receiver_exact_authority_mismatch/);assert.equal(await f.count(),0);
  await writeFile(f.path,raw(f.plan));const H=await f.newHead();await f.packet({H});await assert.rejects(runReception(f.path),/authority_current_candidate|receiver_current_material|source|current/);assert.equal(await f.count(),0);
});
test('the original queue transaction remains held through the actual first input write',async t=>{
  const f=await ready(t,false),other=new DatabaseSync(join(f.store,'queue.sqlite')),write=LiveProcess.prototype.writeText;other.exec('PRAGMA busy_timeout=0');let observed=false;
  LiveProcess.prototype.writeText=function(text){assert.throws(()=>other.exec('BEGIN IMMEDIATE'),/locked|busy/);observed=true;return write.call(this,text);};t.after(()=>{LiveProcess.prototype.writeText=write;other.close();});
  const result=await runReception(f.path);assert.equal(result.receiver.phase,'returned');assert.equal(observed,true);assert.equal(await f.count(),1);other.exec('BEGIN IMMEDIATE;ROLLBACK');
});
test('GRX-F01: an exact new integration candidate reaches governed reception with one combined admission',{skip:!process.env.TONGXU_TEST_DOCKER_CONFIG},async t=>{
  const f=await ready(t,true,'normal','complete',async owned=>{const x=await candidateFixture(owned);x.q.attachIntegrationCandidate(integrationRaw(x.link));return {...x,item:x.candidateItem,packet:x.addPacket,plan:x.receiverPlan,path:x.receiverPath};});
  const result=await runReception(f.path);assert.equal(result.receiver.phase,'returned');assert.equal(result.receiver.judgment.consumedIntegration,result.receiver.integrationSha256);assert.equal(await f.count(),1);assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'consumed');
  const stamps=f.q.status().events.filter((e:any)=>e.kind==='integration_consumer_admitted'&&e.object===f.operation).map((e:any)=>JSON.parse(e.data));assert.equal(stamps.length,2);assert.ok(stamps.every((e:any)=>e.authorityIntent===f.intent&&e.integrationSha256===result.receiver.integrationSha256));await runReception(f.path);assert.equal(await f.count(),1);
});
test('GRX-F02: closing an ended dispatch rollback preserves captured input as submitted or unknown',async t=>{
  const f=await ready(t),code=await readFile(f.plan.claudeExecutable,'utf8');await writeFile(f.plan.claudeExecutable,code.replace("process.stdin.on('end',()=>{const x=JSON.parse(text);","process.stdin.on('data',()=>{let x;try{x=JSON.parse(text);}catch{return;}"));
  const effect=QueueStore.prototype.receiverEffect;let inputSeen=false;QueueStore.prototype.receiverEffect=function(id,binding,observations,call){return (effect as any).call(this,id,binding,observations,()=>{const value=call(),deadline=Date.now()+5000;while(!readFileSync(f.trace,'utf8').includes('model-dispatch')&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);inputSeen=readFileSync(f.trace,'utf8').includes('model-dispatch');throw new Error('explicit_after_input_before_commit');});};t.after(()=>{QueueStore.prototype.receiverEffect=effect;});
  const result=await runReception(f.path);QueueStore.prototype.receiverEffect=effect;assert.equal(inputSeen,true);assert.equal(result.newTaskSent,true);assert.equal(f.q.receiverState(f.operation).receiver.phase,'reserved');
  const closed=await reconcileReception(f.store,f.operation,'Explicit ended original after dispatch transaction rollback');assert.equal(closed.modelDispatchStatus,'submitted_or_unknown');assert.equal(closed.modelRequestRegistered,false);assert.equal(closed.queueDispatchRegistered,false);assert.equal(closed.dispatchCapture.capturedInputPresent,true);assert.equal(closed.dispatchCapture.queueRegistrationMissing,true);assert.equal(f.q.resources().status(f.resourceRequests[0]!).state,'held');assert.equal(f.ledger!.state().settlements.length,0);await runReception(f.path);assert.equal(await f.count(),1);
});
