import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {publicationFixture} from './publication-fixture.js';
import {messageFixture} from '../w6/message-fixture.js';
import {publication} from '../../src/publisher.js';
import {publicationReturn} from '../../src/publication-return.js';
import {publicationReturnMain} from '../../src/publication-return-cli.js';
import {parsePublicationReturnPlan} from '../../src/publication-return-contract.js';
import {parseDevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {taskMain} from '../../src/task-cli.js';
import {linkTaskCandidate,workTaskOwner} from '../../src/tasks.js';
import {parseTaskOwnerRequest,type TaskOwnerRequest} from '../../src/task-inbox.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
const raw=(v:unknown)=>Buffer.from(canonical(v));

async function fixture(t:test.TestContext,remote='normal',message='complete',owner=true,receiver='return',native=false,runOriginal=true){
  const hooks:Array<()=>unknown>=[],owned={after:(f:()=>unknown)=>hooks.push(f)} as unknown as test.TestContext,f=await publicationFixture(owned,remote,receiver),m=await messageFixture(owned,message,native);
  t.after(async()=>{f.q.close();m.q.close();const parent=process.env.TONGXU_PUBLICATION_TEST_EVIDENCE;if(parent){await mkdir(parent,{recursive:true});for(const p of [f.root,m.root])await cp(p,join(parent,basename(p)),{recursive:true});}for(const h of hooks.reverse())try{await h();}catch{}});
  await taskMain(['enable','--store',f.store]);await taskMain(['enable-links','--store',f.store]);const item=f.q.status().items.find((i:any)=>i.id===f.item),definition=parseDevelopmentTask(raw({schemaVersion:1,kind:'tongxu-development-task',id:'original-publication-task',repository:'fixture/reception',title:'原候选负责人',goal:'接收准确正式退回报告',acceptance:['完整原文、原责任和真实回复对应'],source:'Explicit local fixture only',issue:null,context:item.context,workspace:join(f.root,'objects'),base:item.candidate.B,target:item.candidate.targetRef,paths:['sample.js']})),task=f.q.tasks().observe(definition,await observeTaskWorkspace(definition)).item;
  const request:TaskOwnerRequest={schemaVersion:1,kind:'tongxu-task-owner-request',id:'original-owner',task,source:'Explicit fixture original owner registration',question:'核对原候选材料。',from:null,participant:{...m.plan.participants[0]!,id:'original-owner',role:'issue_owner',item:task,parent:null},executionKind:native?'native_capture':'fixture',authorityIntent:null,billing:m.plan.billing,timeoutMs:1000};
  if(owner){f.q.taskInbox().enqueue(raw(request));if(runOriginal)await workTaskOwner(f.store,task,1);else f.q.taskInbox().cancelUnsent(task,request.id,'Explicit fixture: original request withdrawn before any run; fixed responsibility retained');}
  const linkPath=join(f.root,'task-link.json');await writeFile(linkPath,raw({schemaVersion:1,kind:'tongxu-task-candidate-link',task,candidateItem:f.item,source:'Explicit exact original association'}));const link=await linkTaskCandidate(f.store,linkPath);
  if(remote==='normal')await publication(f.pubPath,'publish');
  const plan={schemaVersion:1 as const,kind:'tongxu-publication-return' as const,store:f.store,operation:f.result.operation,task,taskLink:link.link,id:'formal-return',source:'Explicit bounded original-owner RETURN notification',question:'读取完整接收原文，核对退回理由并给出必要下一步；不修改或发布。',authorityIntent:null as string|null,billing:m.plan.billing,timeoutMs:1000},path=join(f.root,'publication-return-plan.json');await writeFile(path,raw(plan));
  return {...f,m,task,definition,request,link,returnPlan:plan,returnPath:path,write:async(value:unknown=plan)=>writeFile(path,raw(value))};
}

test('formal RETURN carries the complete original final to the fixed owner and consumes one reply without manual copying',async t=>{
  const f=await fixture(t),before=await f.m.calls(),prepared=await publicationReturn(f.returnPath,'prepare');assert.equal(prepared.contact,'prepared_not_sent');assert.equal(prepared.newModelRequests,0);assert.equal((await f.m.calls()).length,before.length);
  const completed=await publicationReturn(f.returnPath,'deliver');assert.equal(completed.contact,'Reply');assert.equal(completed.completed,true);assert.equal(completed.completeMaterialConsumptionReported,true);assert.equal(completed.resourcesSettled,true);assert.equal(completed.currentMaterial,true);assert.equal(completed.newModelRequests,1);assert.equal(completed.originalOwner,'original-owner');assert.equal(completed.nativeSessionResumed,false);
  const selected=f.q.taskInbox().prepare(f.task,'formal-return'),context=JSON.parse(selected.context.toString()),r=f.q.receiverState(f.result.operation).receiver;assert.equal(context.sender,null);assert.equal(context.publicationReturn.notModelSender,true);assert.equal(context.publicationReturn.receipt.fullFinalSha256,hash(context.publicationReturn.receipt.fullFinal));assert.equal(JSON.parse(context.publicationReturn.receipt.fullFinal).report,r.judgment.report);assert.equal(context.publicationReturn.receipt.judgment.report,f.secret);assert.equal(context.publicationReturn.receipt.publication.governance,'historical_unprofiled');assert.ok(context.previousExecutions[0].reports[0].receipt.finalText);assert.equal(context.newNativeContext,true);
  const repeated=await publicationReturn(f.returnPath,'deliver');assert.equal(repeated.newModelRequests,0);assert.equal(repeated.fullReply,completed.fullReply);assert.equal(repeated.run,completed.run);assert.equal((await f.remote()).posts.length,2);assert.equal((await f.m.calls()).filter((c:any)=>c.kind==='input').length,2);
  const historical=await publicationReturn(f.returnPath,'prepare');assert.equal(historical.contact,'prepared_original_run_exists');assert.equal(historical.inputSubmitted,true);assert.equal(historical.newModelRequests,0);
  await f.write({...f.returnPlan,id:'renamed-repeat'});await assert.rejects(publicationReturn(f.returnPath,'deliver'),/publication_return_already_queued/);assert.equal((await f.m.calls()).filter((c:any)=>c.kind==='input').length,2);
  await writeFile(join(f.root,'publication-return-verification.json'),JSON.stringify({prepared,completed,repeated,fullOriginalFinal:context.publicationReturn.receipt.fullFinal,sourceIsExplicitFixture:true,realModels:0},null,2));
});

for(const mode of ['partial-answer','missing-consumption','refused'])test(`an incomplete contact (${mode}) retains its original input and cannot be resent as a new success`,async t=>{
  const f=await fixture(t,'normal',mode,true,'return',false,false),result=await publicationReturn(f.returnPath,'deliver');assert.equal(result.completed,false);assert.equal(result.newModelRequests,1);assert.equal(result.completeMaterialConsumptionReported,false);assert.equal(result.inputRegistered,true);assert.equal(result.inputSubmitted,mode==='refused'?null:true);assert.equal(result.deliveryObserved,mode!=='refused');
  const again=await publicationReturn(f.returnPath,'deliver');assert.equal(again.completed,false);assert.equal(again.run,result.run);assert.equal(again.newModelRequests,0);assert.equal((await f.m.calls()).filter((x:any)=>x.kind==='input').length,1);assert.equal((await f.remote()).posts.length,2);
});

test('stopping investment holds the prepared original notification without changing its recipient or losing its report',async t=>{
  const f=await fixture(t),prepared=await publicationReturn(f.returnPath,'prepare');assert.ok('run'in prepared);const selected=f.q.taskInbox().prepare(f.task,'formal-return'),context=JSON.parse(selected.context.toString()),reference=context.publicationReturn.reference;
  assert.throws(()=>f.q.taskInbox().enqueue(raw({...f.request,id:'replacement',publicationReturn:reference,participant:{...f.request.participant,id:'replacement-owner'}})),/original_responsibility_is_fixed/);
  f.q.control(f.definition.context.scope.id,'investment','stopped','Explicit bounded fixture stop');const held=await publicationReturn(f.returnPath,'deliver');assert.equal(held.newModelRequests,0);assert.equal(held.completed,false);assert.equal((await f.m.calls()).filter((x:any)=>x.kind==='input').length,1);
  f.q.control(f.definition.context.scope.id,'investment','open','Explicit fixture continuation');const done=await publicationReturn(f.returnPath,'deliver');assert.equal(done.completed,true);assert.equal(done.run,prepared.run);assert.equal(done.newModelRequests,1);assert.ok(f.q.taskInbox().prepare(f.task,'formal-return').context.equals(selected.context));
});

test('missing original responsibility, changed recipient fields, incomplete publication and non-RETURN cannot launch a contact',async t=>{
  const absent=await fixture(t,'normal','complete',false);await assert.rejects(publicationReturn(absent.returnPath,'deliver'),/task_original_responsibility_required/);assert.equal((await absent.m.calls()).length,0);
  assert.throws(()=>parsePublicationReturnPlan(raw({...absent.returnPlan,participant:absent.request.participant})),/plan_invalid/);
  const incomplete=await fixture(t,'empty-no-create');await assert.rejects(publication(incomplete.pubPath,'publish'),/response_unknown/);const before=(await incomplete.m.calls()).length;await assert.rejects(publicationReturn(incomplete.returnPath,'deliver'),/complete_publication_required/);assert.equal((await incomplete.m.calls()).length,before);assert.equal((await incomplete.remote()).posts.length,1);
  const accepted=await fixture(t,'normal','complete',true,'complete');await assert.rejects(publicationReturn(accepted.returnPath,'deliver'),/complete_original_required/);assert.equal((await accepted.m.calls()).filter((x:any)=>x.kind==='input').length,1);
});

test('wrong task association and unresolved original owner keep the same notification waiting',async t=>{
  const f=await fixture(t);await f.write({...f.returnPlan,taskLink:'f'.repeat(64)});await assert.rejects(publicationReturn(f.returnPath,'deliver'),/exact_task_candidate_required/);assert.equal((await f.m.calls()).filter((x:any)=>x.kind==='input').length,1);
  const pending=await fixture(t,'normal','hang');const p=await publicationReturn(pending.returnPath,'deliver');assert.equal(p.contact,'waiting');assert.equal(p.reason,'task_original_responsibility_pending');assert.equal(p.newModelRequests,0);const again=await publicationReturn(pending.returnPath,'deliver');assert.equal(again.newModelRequests,0);assert.equal(pending.q.taskInbox().status(pending.task).filter(x=>x.id==='formal-return').length,1);assert.equal((await pending.m.calls()).filter((x:any)=>x.kind==='input').length,1);
});

test('prepared RETURN is checked again at the actual role entry when its original candidate changes',async t=>{
  const f=await fixture(t),prepared=await publicationReturn(f.returnPath,'prepare');assert.ok('plan'in prepared);const before=(await f.m.calls()).length,H=await f.newHead();await f.packet({H});
  const {runMessages}=await import('../../src/messages.js'),result=await runMessages(f.store,prepared.plan!);assert.equal(result.completed,false);assert.equal(result.newModelRequests,0);assert.equal((await f.m.calls()).length,before);assert.equal(f.q.taskInbox().status(f.task).find(x=>x.id==='formal-return')!.currentMaterial,false);
});

test('formal publication is evidence only; the contact uses its own exact coordinate authorization and original resources',async t=>{
  const f=await fixture(t,'normal','complete',true,'return',true),ledger=await ledgerFixture(t),spec=ledger.profile.resources[0]!;const provider=(await readFile(ledger.profile.executable,'utf8')).replace("executionKind:'fixture'","executionKind:'external'");await writeFile(ledger.profile.executable,provider);const profile={...ledger.profile,executionKind:'external' as const,executableSha256:hash(provider)};Object.assign(f.returnPlan,{authorityIntent:'bounded-messages',resourceBudget:[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}]});await f.write();const prepared=await publicationReturn(f.returnPath,'prepare');assert.ok('plan'in prepared);const plan=JSON.parse(await readFile(prepared.plan!,'utf8'));
  const owner=await messageAuthority({...f.m,q:f.q,store:f.store,item:f.task,root:f.root,plan,write:async()=>writeFile(prepared.plan!,raw(plan))},true);f.q.resources().configure(raw(profile));const result=await publicationReturn(f.returnPath,'deliver');assert.equal(result.completed,true);assert.equal(result.resourcesSettled,true);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);
  await owner.adopt({kind:'revoke',decision:owner.confirmed.sha});const again=await publicationReturn(f.returnPath,'deliver');assert.equal(again.newModelRequests,0);assert.equal(again.fullReply,result.fullReply);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);
  const selected=f.q.taskInbox().prepare(f.task,'formal-return'),ref=JSON.parse(selected.context.toString()).publicationReturn.reference;assert.throws(()=>parseTaskOwnerRequest(raw({...f.request,id:'wrong-sender',from:{task:'a'.repeat(64),run:'b'.repeat(64),messageId:'invented'},publicationReturn:ref})),/task_request_invalid/);
});

test('fresh billing observation continues the original expired RETURN through the CLI without replacing its plan or run',async t=>{
  const f=await fixture(t),fresh={...f.returnPlan.billing};f.returnPlan.billing={...fresh,observedAt:new Date(Date.now()-3600000).toISOString()};await f.write();const original=await readFile(f.returnPath),prepared=await publicationReturnMain(['prepare','--plan',f.returnPath]);assert.ok('run'in prepared);const selected=f.q.taskInbox().prepare(f.task,'formal-return'),planBytes=await readFile(join(selected.directory,'plan.json')),held=await publicationReturnMain(['deliver','--plan',f.returnPath]);assert.equal(held.newModelRequests,0);assert.equal(held.completed,false);assert.equal((await f.m.calls()).filter((x:any)=>x.kind==='input').length,1);
  const billingPath=join(f.root,'explicit-current-billing.json');await writeFile(billingPath,raw({...fresh,usageCreditsEnabled:true}));await assert.rejects(publicationReturnMain(['deliver','--plan',f.returnPath,'--billing',billingPath]),/message_billing_boundary_required/);assert.equal((await f.m.calls()).filter((x:any)=>x.kind==='input').length,1);
  await writeFile(billingPath,raw(fresh));const done=await publicationReturnMain(['deliver','--plan',f.returnPath,'--billing',billingPath]);assert.equal(done.completed,true);assert.equal(done.newModelRequests,1);assert.equal(done.run,prepared.run);assert.ok((await readFile(f.returnPath)).equals(original));assert.ok((await readFile(join(selected.directory,'plan.json'))).equals(planBytes));const repeated=await publicationReturnMain(['deliver','--plan',f.returnPath]);assert.equal(repeated.newModelRequests,0);assert.equal(repeated.fullReply,done.fullReply);assert.equal((await f.remote()).posts.length,2);
  await writeFile(join(f.root,'billing-continuation-verification.json'),JSON.stringify({prepared,held,done,repeated,originalRequestSha256:hash(original),originalMessagePlanSha256:hash(planBytes),newOfficialInputs:0},null,2));
});
