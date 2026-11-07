import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from '../w6/message-fixture.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {runCoordination} from '../../src/coordination.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';
import type {ConditionalEntryPlan} from '../../src/conditional-entry-contract.js';

async function fixture(t:test.TestContext,mode='complete',configure?:(plan:CoordinationPlan)=>void){
 const f=await messageFixture(t,mode),second=await f.packet({pr:2}),third=await f.packet({pr:3});
 const plan:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'finite-normal-material-refresh',revision:'initial',previous:null,source:'Explicit source/role fixtures; real current queue and fixed Git objects',authorityIntent:null,mode:'stage_serial',actors:[{id:'a',tool:'codex'},{id:'b',tool:'codex'},{id:'independent',tool:'codex'}],tasks:[['A1',f.item,'a'],['B1',second.item,'b'],['A3',third.item,'independent']].map(([id,item,actor])=>({id:id!,item:item!,actor:actor!,originActor:actor!,dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['independent/'+id+'.ts'],workspace:null,publishBranch:null,outputs:id==='A1'?[{id:'A1-report',stage:'investigate',kind:'message_report'}]:[]})),shared:[{id:'contract',tasks:['A1','B1'],paths:['sample.js'],contract:'Related consumers must read the exact current contract before implementation; independent A3 has no shared write.',feedbackFrom:['A1','B1'],blockedStages:['implement'],earlyReceiverAdvice:true}],dependencies:[{task:'B1',stage:'implement',producer:'A1',capability:'A1-report'}]};
 configure?.(plan);
 let script=await readFile(f.codex,'utf8');const marker="report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId";assert.ok(script.includes(marker));script=script.replace(marker,"report:JSON.stringify((()=>{const early=x.material.find(m=>m.name==='early-receiver-context.json');if(early){const c=JSON.parse(early.text);return {schemaVersion:1,kind:'tongxu-early-receiver-advice',relationSha256:c.relationSha256,materialSha256:early.sha256,parts:c.shared.map(p=>({id:p.id,hash:p.hash,position:'compatible',report:'Explicit advice on exact source and execution mode '+c.mode})),report:'Explicit fixture early receiver, not a final judgment.'};}const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),task=x.body.split('\\n')[0].slice(18);return {kind:'tongxu-coordination-feedback',task,revision:c.revision,parts:c.shared.filter(p=>p.feedbackFrom.includes(task)).map(p=>({id:p.id,hash:p.hash,position:'agreed',report:'Read current full original source/advice'})),report:'Complete original fixture task response '+task};})())");await writeFile(f.codex,script);
 const {item:_item,role:_role,parent:_parent,...profile}=f.plan.participants[0]!,actor={...profile,executableSha256:hash(script)},execution={schemaVersion:1,kind:'tongxu-coordination-readonly-execution',executionKind:'fixture',source:'Once installed fixed source/role capabilities',actors:plan.actors.map(a=>({...actor,id:a.id})),taskBodies:Object.fromEntries(plan.tasks.map(t=>[t.id,'Read current supplied original source and dependencies'])),authorityIntents:Object.fromEntries(plan.tasks.map(t=>[t.id,null])),billing:f.plan.billing,timeoutMs:3000,refreshUnsent:false,earlyReceiver:{actor:{...actor,id:'early-receiver'},authorityIntent:null,objects:join(f.root,'objects'),sourcePaths:{A1:['sample.js'],B1:['sample.js']}}};
 const paths={plan:join(f.root,'initial-coordination.json'),execution:join(f.root,'fixed-execution.json'),parallel:join(f.root,'parallel-coordination.json'),other:join(f.root,'other-owner-coordination.json'),otherExecution:join(f.root,'other-owner-execution.json'),tests:join(f.root,'unused-tests.json')};await writeFile(paths.plan,canonical(plan));await writeFile(paths.execution,canonical(execution));await writeFile(paths.parallel,canonical({...plan,mode:'parallel'}));const other=structuredClone(plan);other.actors.push({id:'new-a',tool:'codex'});other.tasks[0]={...other.tasks[0]!,actor:'new-a',dispatch:'same_tool_new'};await writeFile(paths.other,canonical(other));await writeFile(paths.otherExecution,canonical({...execution,actors:execution.actors.map(a=>({...a,id:a.id==='a'?'new-a':a.id}))}));await writeFile(paths.tests,canonical({schemaVersion:1,tools:[{id:'unused',argv:['/fixture/not-executed'],timeoutMs:1000}]}));const ref=async(path:string)=>({path,sha256:hash(await readFile(path))});
 const entry:ConditionalEntryPlan={schemaVersion:1,kind:'tongxu-conditional-delivery-entry',id:'normal-material-refresh',title:'Finite refresh and arrangement component',store:f.store,repository:'fixture/reception',target:'fixture',coordination:{plan:await ref(paths.plan),execution:await ref(paths.execution),choices:[{id:'parallel',title:'Declared parallel mode with the same exact dependencies',plan:await ref(paths.parallel),execution:await ref(paths.execution)},{id:'new-owner',title:'Explicitly selected fresh readonly actor, no writer takeover',plan:await ref(paths.other),execution:await ref(paths.otherExecution)}]},integration:{item:f.item,members:['A1','B1'],gateStage:'implement',objects:join(f.root,'objects'),selectionReason:'This component exercises source and registered arrangement refresh only',authorization:null,testPlan:await ref(paths.tests),receiverTemplate:await ref(join(f.root,'plan.json')),receiverAuthorization:null,sourceReader:{repositoryId:1,ghExecutable:f.codex,ghSha256:hash(script),issues:[],executionKind:'fixture'}}};
 const entryPath=join(f.root,'normal-entry.json');await writeFile(entryPath,canonical(entry));const execute=promisify(execFile),cli=fileURLToPath(new URL('../../src/conditional-entry-cli.js',import.meta.url)),run=async(action:string,...args:string[])=>{const r=await execute(process.execPath,[cli,action,'--entry',entryPath,...args],{cwd:f.root,timeout:30000,maxBuffer:8*1024*1024});return JSON.parse(r.stdout);};
 return {...f,entry,entryPath,plan,paths,run};
}

test('normal refresh derives the exact new original PR item without rebinding another scope, preserves independent A3, and identical refresh creates no new revision or model',async t=>{
 const f=await fixture(t),prepared=await f.run('prepare');await f.run('advice');const first=await f.run('investigate');assert.equal(first.readonlyTasksCompleted,true);const a3=f.q.coordination().dispatchSelection(first.coordination,'A3','investigate')!,calls=await readFile(f.trace);
 const identical=await f.run('refresh');assert.equal(identical.coordination,prepared.preparedCoordination);assert.equal(identical.newModelInputs,0);assert.deepEqual(await readFile(f.trace),calls);
 const H1=await f.newHead(),newSource=await f.packet({pr:1,H:H1});assert.notEqual(newSource.item,f.item);
 const partial=await f.run('investigate');assert.ok(partial.results['A3:investigate'],JSON.stringify({errors:partial.errors,prepared:Object.keys(partial.prepared),results:Object.keys(partial.results)}));assert.equal(partial.results['A3:investigate'].completed,true);assert.equal(f.q.coordination().dispatchSelection(first.coordination,'A3','investigate')!.run,a3.run);assert.deepEqual(await readFile(f.trace),calls);
 const refreshed=await f.run('refresh');assert.notEqual(refreshed.coordination,first.coordination);assert.equal(refreshed.current.plan.tasks.find((t:any)=>t.id==='A1').item,newSource.item);assert.equal(refreshed.current.plan.previous,first.coordination);assert.equal(refreshed.current.currentMaterials,true);assert.deepEqual(await readFile(f.trace),calls);
 const advice=await f.run('advice');assert.equal(advice.newModelRequests,1);const after=await f.run('investigate');assert.equal(after.readonlyTasksCompleted,true,JSON.stringify(after.errors));assert.equal(after.prepared['A3:investigate'].historicalReuse.run,a3.run);assert.equal(f.q.coordination().stage(after.coordination,'B1','implement').phasePrerequisitesMet,true);
 const latestCalls=await readFile(f.trace),again=await f.run('refresh');assert.equal(again.coordination,after.coordination);assert.equal((await f.run('investigate')).newModelRequests,0);assert.deepEqual(await readFile(f.trace),latestCalls);
 await f.packet({pr:1,H:H1,scopeVersion:'S2'});await assert.rejects(()=>f.run('refresh'),/conditional_entry_unique_current_task_source_required/);assert.equal((await f.run('state')).coordination.id,after.coordination);assert.deepEqual(await readFile(f.trace),latestCalls);
});

test('normal mode changes select only installed choices, bind the mode into early advice, and do not turn the changed arrangement into writing authority',async t=>{
 const f=await fixture(t);await f.run('prepare');const early=await f.run('advice');await f.run('investigate');const before=await readFile(f.entryPath),calls=await readFile(f.trace);
 await assert.rejects(()=>f.run('arrange','--choice','unregistered'),/conditional_entry_choice_not_configured/);assert.deepEqual(await readFile(f.trace),calls);
 const changed=await f.run('arrange','--choice','parallel');assert.equal(changed.current.plan.mode,'parallel');assert.equal(changed.writingPermissionGranted,false);assert.equal(changed.ownerAdoptionCreated,false);assert.equal(changed.newModelInputs,0);assert.deepEqual(await readFile(f.trace),calls);assert.deepEqual(await readFile(f.entryPath),before);
 const advice=await f.run('advice');assert.equal(advice.newModelRequests,1);assert.notEqual(advice.run,early.run);const result=await f.run('investigate');assert.equal(result.readonlyTasksCompleted,true,JSON.stringify(result.errors));
 const normal=await f.run('arrange','--choice','parallel');assert.equal(normal.coordination,changed.coordination);assert.equal((await f.run('advice')).newModelRequests,0);const source=await f.run('state');assert.equal(source.choices.length,3);assert.equal(source.coordination.plan,undefined);
});

test('a newly selected normal mode cannot replace the unknown original early receiver',async t=>{
 const f=await fixture(t,'partial-answer');await f.run('prepare');const original=await f.run('advice'),before=await readFile(f.trace);assert.equal(original.newModelRequests,1);assert.equal(original.advice.available,false);
 const changed=await f.run('arrange','--choice','parallel');assert.equal(changed.newModelInputs,0);await assert.rejects(()=>f.run('advice'),/early_receiver_prior_runtime_active_or_unknown/);assert.deepEqual(await readFile(f.trace),before);assert.equal((await f.run('report')).earlyAdvice.available,false);
});

test('an independent task with no prior input can actually read while another component is stale, and its labeled historical context cannot be bound to that component',async t=>{
 const f=await fixture(t),prepared=await f.run('prepare');await f.run('advice');const H1=await f.newHead();await f.packet({pr:1,H:H1});
 const run=await f.run('investigate');assert.equal(run.results['A3:investigate'].completed,true);assert.equal(run.newModelRequests,1);assert.equal(run.readonlyTasksCompleted,false);assert.equal(f.q.coordination().stage(prepared.preparedCoordination,'A3','implement').phasePrerequisitesMet,true);
 const selected=f.q.coordination().dispatchSelection(prepared.preparedCoordination,'A3','investigate')!,input=f.q.messages().submitted(selected.run,'independent')[0],material=input.material.find((m:any)=>m.name==='coordination-context.json'),context=JSON.parse(material.text);assert.deepEqual(context.sourceApplicability.nonCurrentTasks,['A1']);assert.deepEqual(context.sourceApplicability.selectedTasks,['A3']);assert.equal(context.sourceApplicability.unrelatedOriginalsAreHistorical,true);
 const wrong=JSON.parse(selected.plan.toString());wrong.source='Explicit wrong component context fixture';wrong.participants[0].id='a';wrong.participants[0].item=f.item;wrong.messages[0].to='a';wrong.messages[0].id='misrouted';assert.throws(()=>f.q.coordination().bindMessages(prepared.preparedCoordination,Buffer.from(canonical(wrong)),selected.contextSha256,[{task:'A1',messageId:'misrouted'}]),/coordination_context_not_for_task/);
});

test('a normal actor choice preserves the unresolved original task even when the selected actor ID changes',async t=>{
 const f=await fixture(t,'partial-answer');await f.run('prepare');const first=await f.run('investigate');assert.equal(first.newModelRequests,3);assert.equal(first.readonlyTasksCompleted,false);const before=await readFile(f.trace);
 await f.run('arrange','--choice','new-owner');const next=await f.run('investigate');assert.equal(next.newModelRequests,0,JSON.stringify(next.errors));assert.match(JSON.stringify(next),/coordination_actor_active_or_unknown/);assert.deepEqual(await readFile(f.trace),before);
});

test('a registered successor without its normal binding cannot dispatch through the ordinary component entry',async t=>{
 const f=await fixture(t),prepared=await f.run('prepare'),plan={...f.plan,previous:prepared.preparedCoordination,revision:'registered-before-normal-bind'},path=join(f.root,'registration-interruption.json');await writeFile(path,canonical(plan));f.q.coordination().register(Buffer.from(canonical(plan)));const before=await readFile(f.trace);
 const ordinary=await runCoordination(f.store,path,f.paths.execution);assert.equal(ordinary.newModelRequests,0);assert.match(JSON.stringify(ordinary),/conditional_entry_current_binding_required/);assert.deepEqual(await readFile(f.trace),before);
 const recovered=await f.run('prepare');assert.equal(recovered.coordination.id,f.q.coordination().current(f.plan.name)!.id);assert.ok(f.q.coordination().normalEntry(recovered.coordination.id,f.entry.id));assert.deepEqual(await readFile(f.trace),before);
});

test('cold original reports remain visible when the component completed before the entry saved its convenience association',async t=>{
 const f=await fixture(t);await f.run('prepare');await f.run('advice');const direct=await runCoordination(f.store,f.paths.plan,f.paths.execution);assert.equal(direct.readonlyTasksCompleted,true);const before=await readFile(f.trace);
 const report=await f.run('report'),messages=report.reports.filter((r:any)=>r.kind==='message');assert.ok(messages.some((r:any)=>r.key==='A3:investigate'&&r.available&&r.complete));assert.ok(messages.some((r:any)=>r.key==='A1:investigate'&&r.available&&r.complete));assert.equal(new Set(messages.map((r:any)=>r.result?.run+':'+r.result?.messageId)).size,messages.length);assert.deepEqual(await readFile(f.trace),before);
 const source=await f.run('state');assert.ok(!source.entry.steps.some((s:any)=>s.key.startsWith('investigate-')));assert.equal(report.newModelInputs,0);
 const selected=f.q.coordination().dispatchSelection(direct.coordination,'A1','investigate')!,sha=hash(selected.plan),db=new DatabaseSync(join(f.store,'queue.sqlite'));try{const original=(db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as any).bytes;db.prepare('DELETE FROM blobs WHERE hash=?').run(sha);const partial=await f.run('report');assert.ok(partial.reports.some((r:any)=>r.key==='A1:investigate'&&!r.available&&!r.complete));assert.ok(partial.reports.some((r:any)=>r.key==='A3:investigate'&&r.available&&r.complete));const degraded=await f.run('state');assert.equal(degraded.coordination,null);assert.ok(degraded.currentProblem);assert.equal(degraded.currentReference.id,direct.coordination);db.prepare('INSERT INTO blobs(hash,bytes) VALUES(?,?)').run(sha,original);
  const early=JSON.parse((db.prepare("SELECT data FROM events WHERE object=? AND kind='coordination_early_advice_selected'").get('coordination:'+direct.coordination) as any).data).value,bytes=(db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(early.planSha256) as any).bytes;db.prepare('DELETE FROM blobs WHERE hash=?').run(early.planSha256);const missingEarly=await f.run('report');assert.equal(missingEarly.earlyAdvice.available,false);assert.ok(missingEarly.reports.some((r:any)=>r.key==='early-advice'&&!r.available));assert.ok(missingEarly.reports.some((r:any)=>r.key==='A3:investigate'&&r.available&&r.complete));db.prepare('INSERT INTO blobs(hash,bytes) VALUES(?,?)').run(early.planSha256,bytes);
 }finally{db.close();}assert.deepEqual(await readFile(f.trace),before);
});


for(const explicitDependency of [true,false])test('a producer report stops being current when its '+(explicitDependency?'consumed upstream':'shared contract')+' source changes',async t=>{
 const f=await fixture(t,'complete',plan=>{
  plan.tasks[1]!.outputs=[{id:'B1-report',stage:'investigate',kind:'message_report'}];
  plan.dependencies=[...(explicitDependency?[{task:'B1',stage:'investigate' as const,producer:'A1',capability:'A1-report'}]:[]),{task:'A3',stage:'implement',producer:'B1',capability:'B1-report'}];
 });
 await f.run('prepare');await f.run('advice');const result=await f.run('investigate');assert.equal(result.readonlyTasksCompleted,true,JSON.stringify(result.errors));assert.equal(f.q.coordination().stage(result.coordination,'A3','implement').phasePrerequisitesMet,true);
 const before=await readFile(f.trace);await f.packet({pr:1,H:await f.newHead()});
 const stale=f.q.coordination().stage(result.coordination,'A3','implement');assert.equal(stale.phasePrerequisitesMet,false,JSON.stringify(stale));assert.ok(stale.blockers.some(b=>b.includes('B1')&&b.includes('A1')));assert.deepEqual(await readFile(f.trace),before);
});

test('a changed downstream source does not block upstream investigation or the minimal shared component',async t=>{
 const f=await fixture(t,'complete',plan=>{
  plan.tasks[1]!.stages=['investigate','implement','receive','publish'];plan.tasks[1]!.outputs=[{id:'B1-published',stage:'publish',kind:'publication_readback'}];
  plan.tasks[2]!.stages=['investigate','implement','receive','publish','enable'];plan.dependencies.push({task:'A3',stage:'enable',producer:'B1',capability:'B1-published'});
 });
 await f.run('prepare');await f.run('advice');await f.packet({pr:3,H:await f.newHead()});
 const result=await f.run('investigate');assert.equal(result.results['A1:investigate']?.completed,true,JSON.stringify(result.errors));assert.equal(result.results['B1:investigate']?.completed,true,JSON.stringify(result.errors));assert.equal(f.q.coordination().stage(result.coordination,'B1','implement').phasePrerequisitesMet,true);assert.equal(result.prepared['A3:investigate'],undefined);
 const source=JSON.parse(f.q.coordination().dispatchSelection(result.coordination,'A1','investigate')!.context.toString());assert.deepEqual(source.sourceApplicability.nonCurrentTasks,['A3']);assert.equal(source.sourceApplicability.relevantTasks.includes('A3'),false);
});


test('refreshing only A3 reuses complete coupled A1 and B1 reports and their actual consumption without presenting them as readers of the new revision',async t=>{
 const f=await fixture(t);await f.run('prepare');await f.run('advice');const first=await f.run('investigate');assert.equal(first.readonlyTasksCompleted,true);const records=f.q.coordination(),a=records.dispatchSelection(first.coordination,'A1','investigate')!,b=records.dispatchSelection(first.coordination,'B1','investigate')!;
 const output=records.context(first.coordination).value.outputs.find((o:any)=>o.task==='A1')!,source=await f.packet({pr:3,H:await f.newHead()});assert.ok(source.item);await f.run('refresh');assert.equal((await f.run('advice')).newModelRequests,0);const before=(await f.calls()).filter(c=>c.kind==='input').length,result=await f.run('investigate');
 assert.equal(result.readonlyTasksCompleted,true,JSON.stringify(result.errors));assert.equal(result.newModelRequests,1);assert.equal(result.prepared['A1:investigate'].historicalReuse.run,a.run);assert.equal(result.prepared['B1:investigate'].historicalReuse.run,b.run);assert.equal(result.results['A1:investigate'].historicalReuse.readCurrentRevision,false);assert.equal(records.dispatchSelection(result.coordination,'A1','investigate'),null);assert.equal(records.dispatchSelection(result.coordination,'B1','investigate'),null);assert.equal(records.stage(result.coordination,'B1','implement').phasePrerequisitesMet,true);
 const current=records.context(result.coordination).value.outputs.find((o:any)=>o.task==='A1')!;assert.equal(current.sha256,output.sha256);assert.equal(current.originPlan,first.coordination);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,before+1);const trace=await readFile(f.trace);assert.equal((await f.run('investigate')).newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
});


test('an unresolved coupled original survives an unrelated refresh without a substitute task or model input',async t=>{
 const f=await fixture(t,'partial-answer');await f.run('prepare');await f.run('advice');const first=await f.run('investigate');assert.equal(first.readonlyTasksCompleted,false);const original=f.q.coordination().dispatchSelection(first.coordination,'A1','investigate')!,trace=await readFile(f.trace);
 await f.packet({pr:3,H:await f.newHead()});await f.run('refresh');const next=await f.run('investigate');assert.equal(next.readonlyTasksCompleted,false);assert.equal(next.newModelRequests,0);assert.equal(next.prepared['A1:investigate'].historicalReuse.run,original.run);assert.equal(f.q.coordination().dispatchSelection(next.coordination,'A1','investigate'),null);assert.match(next.errors['A1:investigate'],/historical_result_or_resources_unresolved/);assert.deepEqual(await readFile(f.trace),trace);
});
