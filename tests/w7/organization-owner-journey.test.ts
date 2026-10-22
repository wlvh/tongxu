import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {controlFixture} from './task-controls-fixture.js';
import {parseDevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {startWorkbench} from '../../src/workbench.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';
import {prepareTaskOwner,reconcileTaskCoordination,workTaskOwner} from '../../src/tasks.js';
import {runMessages} from '../../src/messages.js';

async function fixture(t:test.TestContext,mode='complete'){
 const f=await controlFixture(t,mode),definition=parseDevelopmentTask(Buffer.from(canonical({...f.definition,id:'second-original-task',title:'原任务 B'}))),b=f.q.tasks().observe(definition,await observeTaskWorkspace(definition)).item;
 const script=(await readFile(f.codex,'utf8')).replace("report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId","report:JSON.stringify((()=>{const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),own=JSON.parse(x.material.find(m=>m.name==='task-owner-context.json').text),task=c.tasks.find(t=>t.item===own.task.item);return {kind:'tongxu-coordination-feedback',task:task.id,revision:c.revision,parts:c.shared.filter(p=>p.feedbackFrom.includes(task.id)).map(p=>({id:p.id,hash:p.hash,position:'agreed',report:'Explicit fixture result; no real model.'})),report:'Explicit fixed source and exact original task context consumed; no writing grant.'};})())");await writeFile(f.codex,script);
 const aRequest={...f.request,participant:{...f.request.participant,executableSha256:hash(script)}},bRequest={...aRequest,id:'b-contact',task:b,participant:{...aRequest.participant,id:'original-b',item:b}},sources=[{id:'a',title:'原任务 A',store:f.store,item:f.task},{id:'b',title:'原任务 B',store:f.store,item:b}],contacts=[];
 for(const [id,source,request] of [['a','a',aRequest],['b','b',bRequest]] as const){const path=join(f.root,id+'-request.json');await writeFile(path,canonical(request));const current=f.q.tasks().current(request.task);contacts.push({id,title:'原负责人 '+id,source,packet:current.packet,sourceSha256:current.fingerprint,request:{path,sha256:hash(await readFile(path))}});}
 const catalogPath=join(f.root,'joint-contacts.json');await writeFile(catalogPath,canonical({schemaVersion:1,kind:'tongxu-task-controls',contacts}));
 const plan:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'original-owner-journey',revision:'template',previous:null,source:'Explicit bounded workflow fixture; no real Owner or model',authorityIntent:null,mode:'stage_serial',actors:[{id:aRequest.participant.id,tool:'codex'},{id:bRequest.participant.id,tool:'codex'}],tasks:[{id:'A',item:f.task,actor:aRequest.participant.id,originActor:aRequest.participant.id,dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['a.js'],workspace:null,publishBranch:null,outputs:[{id:'A-report',stage:'investigate',kind:'message_report'}]},{id:'B',item:b,actor:bRequest.participant.id,originActor:bRequest.participant.id,dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['b.js'],workspace:null,publishBranch:null,outputs:[]}],shared:[{id:'shared',tasks:['A','B'],paths:['sample.js'],contract:'Keep the fixed exported integer contract.',feedbackFrom:['A','B'],blockedStages:['implement']}],dependencies:[{task:'B',stage:'implement',producer:'A',capability:'A-report'}]},templatePath=join(f.root,'organization-template.json'),organizationPath=join(f.root,'organization.json');await writeFile(templatePath,canonical(plan));await writeFile(organizationPath,canonical({schemaVersion:1,kind:'tongxu-workbench-organization',groups:[{id:'team',title:'原责任任务',sources:['a','b'],choices:[{id:'serial',title:'实现等前置，调查可独立继续',plan:{path:templatePath,sha256:hash(await readFile(templatePath))}}],delegation:null}]}));
 const page={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'组织与原待办连接',goal:'Explicit fixture only',sources,controls:{path:catalogPath,sha256:hash(await readFile(catalogPath))},organization:{path:organizationPath,sha256:hash(await readFile(organizationPath))}},pagePath=join(f.root,'joint-page.json');await writeFile(pagePath,canonical(page));const app=await startWorkbench(pagePath);t.after(()=>app.close());const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json',Origin:url.origin};
 const state=async()=>await (await fetch(url.origin+'/api/state',{headers})).json() as any,post=async(path:string,body:unknown)=>{const r=await fetch(url.origin+'/api/'+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};
 async function contact(id:string){const started=await post('task-control/'+id+'/start',{});assert.equal(started.status,202);for(let i=0;i<200;i++){const c=(await state()).taskControls.find((x:any)=>x.id===id);if(!c.controllerActive)return c;await new Promise(r=>setTimeout(r,20));}throw new Error('bounded_fixture_timeout');}
 return {...f,b,aRequest,bRequest,plan,state,post,contact};
}
test('one page registers an arrangement, contacts original task owners, and consumes the exact producer output without manual report transport',async t=>{
 const f=await fixture(t),registered=await f.post('organization/team/apply',{choice:'serial',expectedPrevious:null});assert.equal(registered.status,200);const id=registered.value.planId;
 assert.equal(f.q.coordination().stage(id,'B','implement').phasePrerequisitesMet,false);assert.equal(f.q.coordination().stage(id,'B','investigate').phasePrerequisitesMet,true);
 const a=await f.contact('a');assert.equal(a.phase,'returned',JSON.stringify(a));assert.equal(f.q.taskInbox().originalResponsibility(f.task).participant.id,'original-owner');
 assert.ok(f.q.status().events.some((e:any)=>e.object==='coordination:'+id&&e.kind==='coordination_output'));const b=await f.contact('b');assert.equal(b.phase,'returned',JSON.stringify(b));assert.equal(f.q.taskInbox().originalResponsibility(f.b).participant.id,'original-b');
 const ready=f.q.coordination().stage(id,'B','implement');assert.equal(ready.phasePrerequisitesMet,true,JSON.stringify(ready));assert.equal(ready.executionAuthorized,false);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,2);
 const view=await f.state();assert.equal(view.organization[0].current.stages.find((x:any)=>x.id==='B').stages.find((x:any)=>x.stage==='implement').phasePrerequisitesMet,true);
 const trace=await readFile(f.trace);await f.contact('a');await f.contact('b');assert.deepEqual(await readFile(f.trace),trace);assert.equal((await reconcileTaskCoordination(f.store,f.task,f.aRequest.id))?.recorded,true);
});
test('a changed arrangement or assigned actor does not rewrite an already prepared original task input',async t=>{
 const f=await fixture(t),registered=await f.post('organization/team/apply',{choice:'serial',expectedPrevious:null}),id=registered.value.planId;
 f.q.taskInbox().enqueue(Buffer.from(canonical(f.aRequest)));const selected=await prepareTaskOwner(f.store,f.task,f.aRequest.id),original=await readFile(selected.plan),next={...f.q.coordination().status(id).plan,previous:id,revision:'changed-before-send'};next.shared[0]!.contract+=' Changed explicitly.';f.q.coordination().register(Buffer.from(canonical(next)));
 const denied=await runMessages(f.store,selected.plan,false,selected.run);assert.equal(denied.newModelRequests,0);assert.match(JSON.stringify(denied.problems),/current_revision/);assert.deepEqual(await readFile(selected.plan),original);
 const current=f.q.coordination().current(f.plan.name)!,wrong=structuredClone(current.plan);wrong.previous=current.id;wrong.revision='different-owner';wrong.tasks[1]!.actor='original-owner';wrong.tasks[1]!.dispatch='same_tool_new';f.q.coordination().register(Buffer.from(canonical(wrong)));
 const b=await f.contact('b');assert.equal(b.lastControllerReturn.reason,'task_coordination_original_actor_mismatch');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,0);
});
test('an early B inquiry waits for A; a later original-owner followup consumes A without replacing the first output',async t=>{
 const f=await fixture(t),registered=await f.post('organization/team/apply',{choice:'serial',expectedPrevious:null}),id=registered.value.planId;
 assert.equal((await f.contact('b')).phase,'returned');assert.equal(f.q.coordination().stage(id,'B','implement').phasePrerequisitesMet,false);
 assert.equal((await f.contact('a')).phase,'returned');assert.equal(f.q.coordination().stage(id,'B','implement').phasePrerequisitesMet,false);
 const original=f.q.status().events.filter((e:any)=>e.object==='coordination:'+id&&e.kind==='coordination_output');
 f.q.taskInbox().enqueue(Buffer.from(canonical({...f.bRequest,id:'b-followup'})));const b=await workTaskOwner(f.store,f.b,1);assert.equal(b.runs[0]!.completed,true);assert.equal(b.runs[0]!.coordination?.recorded,true);assert.equal(f.q.coordination().stage(id,'B','implement').phasePrerequisitesMet,true);
 f.q.taskInbox().enqueue(Buffer.from(canonical({...f.aRequest,id:'a-followup'})));const a=await workTaskOwner(f.store,f.task,1);assert.equal(a.runs[0]!.coordination?.recorded,true);assert.deepEqual(f.q.status().events.filter((e:any)=>e.object==='coordination:'+id&&e.kind==='coordination_output'),original);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,4);
});
test('an incomplete original response stays unresolved and never supplies coordination feedback or an output',async t=>{
 const f=await fixture(t,'partial-answer'),registered=await f.post('organization/team/apply',{choice:'serial',expectedPrevious:null}),id=registered.value.planId,a=await f.contact('a');assert.equal(a.phase,'unresolved');
 const before=await readFile(f.trace);await f.contact('a');assert.deepEqual(await readFile(f.trace),before);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
 assert.ok(!f.q.status().events.some((e:any)=>e.object==='coordination:'+id&&['coordination_feedback','coordination_output'].includes(e.kind)));
 assert.equal(f.q.coordination().stage(id,'B','implement').phasePrerequisitesMet,false);assert.equal((await reconcileTaskCoordination(f.store,f.task,f.aRequest.id))?.recorded,false);
});
test('changing the human-readable report into a permission claim does not satisfy the registered feedback contract',async t=>{
 const f=await fixture(t),registered=await f.post('organization/team/apply',{choice:'serial',expectedPrevious:null}),id=registered.value.planId;
 // Replace only this explicit fixture's simulated reply before registration.
 const source=await readFile(f.codex,'utf8'),changed=source.replace("kind:'tongxu-coordination-feedback'","kind:'arbitrary-authority-claim'");await writeFile(f.codex,changed);
 const request={...f.aRequest,id:'invalid-feedback',participant:{...f.aRequest.participant,executableSha256:hash(changed)}};f.q.taskInbox().enqueue(Buffer.from(canonical(request)));const selected=await prepareTaskOwner(f.store,f.task,request.id),response=await runMessages(f.store,selected.plan,false,selected.run);assert.equal(response.completed,true);
 const feedback=await reconcileTaskCoordination(f.store,f.task,request.id);assert.equal(feedback?.recorded,false);assert.equal('reason' in feedback!&&feedback.reason,'coordination_feedback_shape_invalid');
 assert.ok(!f.q.status().events.some((e:any)=>e.object==='coordination:'+id&&['coordination_feedback','coordination_output'].includes(e.kind)));assert.equal(f.q.coordination().stage(id,'B','implement').phasePrerequisitesMet,false);
});
