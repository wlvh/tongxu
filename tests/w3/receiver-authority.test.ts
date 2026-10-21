import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup} from './receiver-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {QueueStore} from '../../src/queue-store.js';
import {runReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';
import {ownerDecisionText,scopeBodyHash,actionHash,type AuthorityProfile,type ActionRequest} from '../../src/authority-contract.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';
import type {ResourceRequest} from '../../src/resource-contract.js';
import {enableMemberRefutationFormat} from '../../src/queue-format.js';
import {LiveProcess} from '../../src/live-process.js';
const raw=(x:unknown)=>Buffer.from(JSON.stringify(x));

async function ready(t:test.TestContext,resources=true,providerMode='normal',modelMode='complete'){
  const hooks:Array<()=>unknown>=[],owned={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext,f=await setup(owned,modelMode),ledger=resources?await ledgerFixture(owned,providerMode):null;
  t.after(async()=>{f.q.close();if(process.env.TONGXU_RECEIVER_AUTHORITY_EVIDENCE){const root=process.env.TONGXU_RECEIVER_AUTHORITY_EVIDENCE;await mkdir(root,{recursive:true});for(const source of [f.root,...(ledger?[ledger.root]:[])])await cp(source,join(root,basename(source)),{recursive:true});}for(const fn of hooks.reverse())try{await fn();}catch{}});
  f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();
  const records:Record<string,any>={},sourcePath=join(f.root,'owner-originals.json'),exe=join(f.root,'owner-fixture.mjs');
  const code=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),r=JSON.parse(fs.readFileSync(${JSON.stringify(sourcePath)},'utf8'));if(args.includes('graphql')){const id=args.find(v=>v.startsWith('id=')).slice(3);console.log(JSON.stringify(Object.values(r).find(x=>x.comment.node_id===id).graph));}else console.log(JSON.stringify(r[args.at(-1).split('/').at(-1)].comment));`;
  await writeFile(exe,code,{mode:0o700});const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:8,ownerId:101,executorId:202,ghExecutable:exe,ghSha256:hash(code),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000},a=f.q.authority();a.configure(raw(profile));if(ledger)f.q.resources().configure(raw(ledger.profile));let seq=8500000000;
  async function adopt(value:any){const p=a.prepare('receiver-proposal-'+(++seq),raw(value)),id=seq,sha=p.proposalSha256,text=ownerDecisionText(sha),at=new Date().toISOString(),node='IC_receiver_'+id,url=`https://github.com/fixture/reception/issues/8#issuecomment-${id}`,comment={id,node_id:node,body:text,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/8',html_url:url},graph={data:{viewer:{databaseId:202},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body:text,createdAt:at,updatedAt:at,url,issue:{number:8,repository:{nameWithOwner:'fixture/reception'}}}}};records[id]={comment,graph};await writeFile(sourcePath,raw(records));const observation=fixtureOwnerObservation(profile,sha,id,raw(graph),raw(comment),at);a.apply(sha,observation);return {sha,observation};}
  const item=f.q.status().items[0],body={goals:['Exact governed receiver fixture'],nonGoals:['No official model or business acceptance'],preserve:['Original queue and grants'],acceptance:['One original execution and resource result'],constraints:['No copied implementation permission']},scope=await adopt({kind:'adopt_scope',scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,body,previousAdoption:null}),action:ActionRequest={schemaVersion:1,scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,scopeBodySha256:scopeBodyHash(body),repository:'fixture/reception',target:'fixture',action:'receive',item:f.item,candidate:{H:item.candidate.H,B:item.candidate.B,subjectSha256:null},paths:[],resourceRefs:ledger?[ledger.profile.resources[0]!.ref]:[]},confirmation=await adopt({kind:'confirm_action',adoption:scope.sha,performerRole:'receiver',request:action,expiresAt:new Date(Date.now()+3600000).toISOString()}),observations=[scope.observation,confirmation.observation],intent='exact-receiver';
  a.reserveAction(intent,action,'receiver',confirmation.sha,observations);const begun=f.q.begin(f.item,'original-receiver-preparation');f.q.evaluate(begun.operation);const resourceRequests:string[]=[];
  if(ledger){const request:ResourceRequest={...ledger.request,operation:begun.operation,authorityIntent:intent,actionSha256:actionHash(action)};resourceRequests.push(f.q.resources().prepare(request,observations,'receiver').id);}
  f.plan.governance={authorityIntent:intent,resourceRequests};await writeFile(f.path,raw(f.plan));return {...f,ledger,a,scope,action,confirmation,adopt,observations,intent,operation:begun.operation,resourceRequests};
}
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
