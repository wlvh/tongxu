import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {runCoordination} from '../../src/coordination.js';
import {runCoordinationEarlyReceiver} from '../../src/coordination-early-receiver.js';
import {coordinationPlanId,type CoordinationPlan} from '../../src/coordination-contract.js';
import type {CoordinationExecution} from '../../src/coordination-execution-contract.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {runReception,type ReceiverPlan} from '../../src/receiver.js';
import {conditionalEntryMain} from '../../src/conditional-entry-cli.js';
import type {ConditionalEntryPlan} from '../../src/conditional-entry-contract.js';

async function fixture(t:test.TestContext,position='compatible',mode='complete'){
 const f=await messageFixture(t,mode),second=await f.packet({pr:2}),third=await f.packet({pr:3});
 const tasks=[['A1',f.item,'a'],['B1',second.item,'b'],['A3',third.item,'independent']];
 const plan:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'fixed-shared-early-receiver',revision:'r1',previous:null,source:'Explicit protocol fixture with real Git sources; no provider or permissions',authorityIntent:null,mode:'stage_serial',actors:tasks.map(([, ,id])=>({id:id!,tool:'codex'})),tasks:tasks.map(([id,item,actor])=>({id:id!,item:item!,actor:actor!,originActor:actor!,dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['independent/'+id+'.ts'],workspace:null,publishBranch:null,outputs:id==='A1'?[{id:'A1-result',stage:'investigate',kind:'message_report'}]:[]})),shared:[{id:'api',tasks:['A1','B1'],paths:['sample.js'],contract:'The exported value and both consumers must keep a compatible intermediate contract.',feedbackFrom:['A1','B1'],blockedStages:['implement'],earlyReceiverAdvice:true}],dependencies:[{task:'B1',stage:'implement',producer:'A1',capability:'A1-result'}]};
 let script=await readFile(f.codex,'utf8');const marker="report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId";
 assert.ok(script.includes(marker));
 script=script.replace(marker,"report:JSON.stringify((()=>{const e=x.material.find(m=>m.name==='early-receiver-context.json');if(e){const c=JSON.parse(e.text);return {schemaVersion:1,kind:'tongxu-early-receiver-advice',relationSha256:c.relationSha256,materialSha256:e.sha256,parts:c.shared.map(p=>({id:p.id,hash:p.hash,position:"+JSON.stringify(position)+",report:'Explicit protocol advice on actual supplied Git source and consumers.'})),report:'Explicit fixture advice, not final technical acceptance or a real model.'};}const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),task=x.body.split('\\n')[0].slice(18);return {kind:'tongxu-coordination-feedback',task,revision:c.revision,parts:c.shared.filter(p=>p.feedbackFrom.includes(task)).map(p=>({id:p.id,hash:p.hash,position:'agreed',report:'Explicit fixture task response.'})),report:'Explicit task consumed complete supplied context.'};})())");
 await writeFile(f.codex,script);const {item,role,parent,...base}=f.plan.participants[0]!,actor={...base,executableSha256:hash(script)};
 const request:CoordinationExecution={schemaVersion:1,kind:'tongxu-coordination-readonly-execution',source:'Explicit configured early-advice fixture',executionKind:'fixture',actors:plan.actors.map(a=>({...actor,id:a.id})),taskBodies:Object.fromEntries(plan.tasks.map(task=>[task.id,'Investigate and consume only exact registered upstream material.'])),authorityIntents:Object.fromEntries(plan.tasks.map(task=>[task.id,null])),billing:f.plan.billing,timeoutMs:2000,refreshUnsent:false,earlyReceiver:{actor:{...actor,id:'early-receiver'},authorityIntent:null,objects:join(f.root,'objects'),sourcePaths:{A1:['sample.js'],B1:['sample.js']}}};
 const planPath=join(f.root,'early-coordination.json'),requestPath=join(f.root,'early-execution.json');await writeFile(planPath,canonical(plan));await writeFile(requestPath,canonical(request));
 return {...f,plan,request,planPath,requestPath,save:()=>writeFile(planPath,canonical(plan))};
}

test('exact early advice actually enters shared task inputs and only then permits their existing technical stage',async t=>{
 const f=await fixture(t),id=coordinationPlanId(f.plan);f.q.coordination().register(Buffer.from(canonical(f.plan)));
 assert.equal(f.q.coordination().stage(id,'A3','implement').phasePrerequisitesMet,true);
 assert.ok(f.q.coordination().stage(id,'A1','implement').blockers.some(b=>b.startsWith('early_receiver_advice:')));
 const advice=await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);assert.equal(advice.newModelRequests,1);assert.ok('advice' in advice&&advice.advice?.available,JSON.stringify(advice));
 assert.ok(f.q.coordination().stage(id,'A1','implement').blockers.includes('early_receiver_advice_not_consumed:api'));
 const result=await runCoordination(f.store,f.planPath,f.requestPath);assert.equal(result.readonlyTasksCompleted,true,JSON.stringify(result.errors));
 for(const task of ['A1','B1'])assert.equal(f.q.coordination().stage(id,task,'implement').phasePrerequisitesMet,true,task);
 const captured=f.q.coordination().context(id).value.earlyReceiverAdvice;assert.ok(captured?.available);
 for(const task of ['A1','B1']){
  const selected=f.q.coordination().dispatchSelection(id,task,'investigate')!;
  const input=f.q.messages().submitted(selected.run,f.plan.tasks.find(t=>t.id===task)!.actor)[0];
  const context=input.material.find((m:any)=>m.name==='coordination-context.json');assert.equal(JSON.parse(context.text).earlyReceiverAdvice.fullOriginalReply,captured.fullOriginalReply);
 }
 const trace=await readFile(f.trace);assert.equal((await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath)).newModelRequests,0);assert.equal((await runCoordination(f.store,f.planPath,f.requestPath)).newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
 assert.equal(f.q.status().operations.some((o:any)=>Boolean(o.result?.receiver?.judgment)),false);
});

test('conflict or unknown early advice never becomes an agreed shared stage and never blocks independent A3',async t=>{
 for(const position of ['conflict','unknown']){
  const f=await fixture(t,position);await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);const r=await runCoordination(f.store,f.planPath,f.requestPath);assert.equal(r.readonlyTasksCompleted,true,JSON.stringify(r.errors));
  assert.ok(f.q.coordination().stage(r.coordination,'A1','implement').blockers.includes('early_receiver_advice:api:'+position));assert.equal(f.q.coordination().stage(r.coordination,'A3','implement').phasePrerequisitesMet,true);
 }
});

test('advice arriving after the original investigation and upstream consumption is actually consumed without replacing those messages',async t=>{
 const f=await fixture(t),before=await runCoordination(f.store,f.planPath,f.requestPath),originalA=before.prepared['A1:investigate'],originalBPurpose=before.prepared['B1:consume']?'consume':'investigate',originalB=before.prepared['B1:'+originalBPurpose];
 assert.equal(before.readonlyTasksCompleted,true,JSON.stringify(before.errors));assert.ok(before.results['A3:investigate']?.completed);assert.equal(f.q.coordination().stage(before.coordination,'A1','implement').phasePrerequisitesMet,false);
 const a=await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);assert.ok('advice' in a&&a.advice?.available);
 const after=await runCoordination(f.store,f.planPath,f.requestPath);assert.equal(after.readonlyTasksCompleted,true,JSON.stringify(after.errors));
 for(const task of ['A1','B1'])assert.equal(f.q.coordination().stage(after.coordination,task,'implement').phasePrerequisitesMet,true,task);
 assert.equal(f.q.coordination().dispatchSelection(after.coordination,'A1','investigate')!.run,originalA.run);assert.equal(f.q.coordination().dispatchSelection(after.coordination,'B1',originalBPurpose)!.run,originalB.run);
 const trace=await readFile(f.trace);assert.equal((await runCoordination(f.store,f.planPath,f.requestPath)).newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
});

test('unchanged relevant parts reuse the exact early capture while a changed shared contract gets its own advice',async t=>{
 const f=await fixture(t),first=await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);assert.ok('advice' in first&&first.advice?.available);
 f.plan.previous=first.coordination;f.plan.revision='only-independent-A3-changed';f.plan.tasks.find(t=>t.id==='A3')!.independentPaths.push('independent/extra.ts');await f.save();
 const unchanged=await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);assert.equal(unchanged.newModelRequests,0);assert.equal(unchanged.run,first.run);assert.ok('advice' in unchanged&&unchanged.advice?.available&&unchanged.advice.reusedOriginal);
 f.plan.previous=unchanged.coordination;f.plan.revision='shared-interface-changed';f.plan.shared[0]!.contract+=' The consumers now explicitly require integer values.';await f.save();
 const changed=await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);assert.equal(changed.newModelRequests,1);assert.notEqual(changed.run,first.run);assert.ok('advice' in changed&&changed.advice?.available);
});

test('unknown original early input is never replaced by a new shared revision',async t=>{
 const f=await fixture(t,'compatible','partial-answer'),first=await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);assert.equal(first.newModelRequests,1);assert.ok('advice' in first&&!first.advice?.available);
 const trace=await readFile(f.trace);f.plan.previous=first.coordination;f.plan.revision='shared-change-while-original-unknown';f.plan.shared[0]!.contract+=' New evidence cannot replace an unknown original send.';await f.save();
 await assert.rejects(runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath),/early_receiver_prior_runtime_active_or_unknown/);assert.deepEqual(await readFile(f.trace),trace);
});

test('valid existing receiver results are reused, and an available earlier phase is consumed while a later phase still waits',async t=>{
 const f=await fixture(t),originalPlan=JSON.parse(await readFile(join(f.root,'plan.json'),'utf8')) as ReceiverPlan;
 const originalOperations:Record<string,string>={};
 for(const task of f.plan.tasks.filter(t=>t.id!=='A3')){
  const path=join(f.root,'original-reception-'+task.id+'.json');await writeFile(path,canonical({...originalPlan,item:task.item}));await runReception(path);
  const operation=f.q.status().operations.find((o:any)=>o.item===task.item&&o.result?.receiver?.judgment?.verdict==='ACCEPT_WITHIN_SCOPE');assert.ok(operation);originalOperations[task.id]=operation.id;
 }
 const receiverCalls=await f.count();
 for(const task of f.plan.tasks){task.stages=['investigate','implement','receive','publish','enable'];if(task.id!=='A3')task.outputs.push({id:task.id+'-received',stage:'receive',kind:'receiver_judgment'});}
 f.plan.tasks[0]!.outputs.push({id:'A1-published',stage:'publish',kind:'publication_readback'});
 f.plan.dependencies.push({task:'B1',stage:'receive',producer:'A1',capability:'A1-received'},{task:'A1',stage:'publish',producer:'B1',capability:'B1-received'},{task:'B1',stage:'enable',producer:'A1',capability:'A1-published'});await f.save();
 await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);let work=await runCoordination(f.store,f.planPath,f.requestPath);assert.equal(work.readonlyTasksCompleted,true,JSON.stringify(work.errors));
 const records=f.q.coordination(),id=work.coordination;records.recordReceiverOutput(id,'A1','A1-received',originalOperations.A1!);
 assert.throws(()=>records.recordReceiverOutput(id,'B1','B1-received',originalOperations.B1!),/capability_not_consumed/);
 work=await runCoordination(f.store,f.planPath,f.requestPath);assert.equal(work.readonlyTasksCompleted,true,JSON.stringify(work.errors));
 assert.equal(records.stage(id,'B1','receive').phasePrerequisitesMet,true,'B1 receive consumes A1 while B1 enable waits for future publication');
 assert.throws(()=>records.recordReceiverOutput(id,'B1','B1-received',originalOperations.A1!),/coordination_exact_accepted_receiver_required/);
 records.recordReceiverOutput(id,'B1','B1-received',originalOperations.B1!);await runCoordination(f.store,f.planPath,f.requestPath);
 assert.equal(records.stage(id,'A1','publish').phasePrerequisitesMet,true);assert.equal(records.stage(id,'B1','enable').phasePrerequisitesMet,false);
 assert.equal((records.recordReceiverOutput(id,'A1','A1-received',originalOperations.A1!) as any).duplicate,true);assert.equal(await f.count(),receiverCalls,'valid originals do not start receiver again');
 const trace=await readFile(f.trace);assert.equal((await runCoordination(f.store,f.planPath,f.requestPath)).newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
});

async function normalEntry(f:Awaited<ReturnType<typeof fixture>>){
 const testPlan=join(f.root,'normal-entry-test-plan.json');await writeFile(testPlan,canonical({schemaVersion:1,tools:[{id:'registered-fixture-only',argv:[process.execPath,'-e','process.exit(0)'],timeoutMs:1000}]}));
 const ref=async(path:string)=>({path,sha256:hash(await readFile(path))});
 const entry:ConditionalEntryPlan={schemaVersion:1,kind:'tongxu-conditional-delivery-entry',id:'fixed-normal-entry',title:'Explicit normal-entry component fixture',store:f.store,repository:'fixture/reception',target:'fixture',coordination:{plan:await ref(f.planPath),execution:await ref(f.requestPath)},integration:{item:f.item,members:['A1','B1'],gateStage:'implement',objects:join(f.root,'objects'),selectionReason:'This component fixture exercises advice and original reports only; full combination is tested separately.',authorization:null,testPlan:await ref(testPlan),receiverTemplate:await ref(join(f.root,'plan.json')),receiverAuthorization:null,sourceReader:{repositoryId:1,ghExecutable:f.codex,ghSha256:hash(await readFile(f.codex)),issues:[]}}};
 const path=join(f.root,'normal-entry.json');await writeFile(path,canonical(entry));return {entry,path,run:(action:string,...args:string[])=>conditionalEntryMain([action,'--entry',path,...args])};
}

test('one fixed normal CLI entry prepares, obtains advice, investigates and reopens full originals after live capability removal',async t=>{
 const f=await fixture(t),normal=await normalEntry(f),before=f.q.status().events.length;
 const state=await normal.run('state');assert.ok('newModelInputs' in state);assert.equal(state.newModelInputs,0);assert.equal(f.q.status().events.length,before);assert.equal((await f.calls()).length,0);
 const prepared=await normal.run('prepare');assert.ok('preparedCoordination' in prepared);assert.equal((await f.calls()).length,0);
 const advice=await normal.run('advice');assert.ok('advice' in advice&&advice.advice?.available);const work=await normal.run('investigate');assert.ok('readonlyTasksCompleted' in work&&work.readonlyTasksCompleted);
 const trace=await readFile(f.trace),report=await normal.run('report');assert.ok('reports' in report&&report.reports.length>=4);assert.equal(report.newModelInputs,0);
 await unlink(f.requestPath);const reopened=await normal.run('report');assert.deepEqual(reopened,report);assert.deepEqual(await readFile(f.trace),trace);
 await assert.rejects(normal.run('investigate'),/ENOENT|conditional_entry_capability_changed/);assert.deepEqual(await readFile(f.trace),trace);
});

test('a changed normal catalog blocks a prepared early message even through the ordinary component entry',async t=>{
 const f=await fixture(t),normal=await normalEntry(f);await normal.run('prepare');await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath,true);
 normal.entry.title+=' changed';await writeFile(normal.path,canonical(normal.entry));
 const result=await runCoordinationEarlyReceiver(f.store,f.planPath,f.requestPath);assert.equal(result.newModelRequests,0);assert.ok('result' in result&&JSON.stringify(result.result?.problems).includes('conditional_entry_catalog_changed'));assert.equal((await f.calls()).length,0);
});

test('an unconfirmed early reply remains labeled original while independent task full reports stay readable',async t=>{
 const f=await fixture(t);let script=await readFile(f.codex,'utf8');script=script.replace("consumed:mode==='missing-consumption'?[]:x.replyReferences","consumed:x.messageId==='early-advice'?[]:x.replyReferences");await writeFile(f.codex,script);
 for(const actor of [...f.request.actors,f.request.earlyReceiver!.actor])actor.executableSha256=hash(script);await writeFile(f.requestPath,canonical(f.request));
 const normal=await normalEntry(f);await normal.run('advice');const work=await normal.run('investigate');assert.ok('readonlyTasksCompleted' in work&&work.readonlyTasksCompleted);
 const trace=await readFile(f.trace),report=await normal.run('report');assert.ok('reports' in report);
 assert.ok(report.reports.some((r:any)=>r.key==='A3:investigate'&&r.available&&r.complete));assert.ok(report.reports.some((r:any)=>r.key==='early-advice'&&!r.complete));assert.deepEqual(await readFile(f.trace),trace);
});
