import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {controlFixture} from './task-controls-fixture.js';
import {startWorkbench} from '../../src/workbench.js';
import {TaskControls} from '../../src/task-controls.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {prepareTaskOwner} from '../../src/tasks.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {observeTask,SecretaryTools} from '../../src/secretary-tools.js';
const raw=(x:unknown)=>Buffer.from(canonical(x));
async function setup(t:test.TestContext){const f=await controlFixture(t),catalog={...f.catalog,schemaVersion:2,scopeControls:['investment','implementation','merge'].map(control=>({id:control,title:control,source:'task',scopeSha256:hash(canonical(f.definition.context.scope)),control}))};const start=async()=>{await writeFile(f.catalogPath,canonical(catalog));const plan={...f.plan,controls:{path:f.catalogPath,sha256:hash(await readFile(f.catalogPath))}};await writeFile(f.planPath,canonical(plan));const app=await startWorkbench(f.planPath);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json',Origin:u.origin};return {app,state:async()=>(await (await fetch(u.origin+'/api/state',{headers})).json()) as any,post:(path:string,body:unknown)=>fetch(u.origin+path,{method:'POST',headers,body:JSON.stringify(body)})};};return {...f,catalog,start};}
const candidate=(f:Awaited<ReturnType<typeof setup>>)=>{const c=f.q.tasks().current(f.task).manifest.candidate;return {repository:c.repository,pr:null,H:c.H,B:c.B,target:c.targetRef,kind:'development-task' as const,taskId:f.task,sourceSha256:c.sourceSha256};};
async function waitFor(state:()=>Promise<any>,condition:(s:any)=>boolean){const end=Date.now()+6000;let s;do{s=await state();if(condition(s))return s;await new Promise(r=>setTimeout(r,20));}while(Date.now()<end);throw new Error('expected_control_state_not_observed:'+JSON.stringify(s.taskControls));}

test('one actual HTTP scope stop blocks new contact, secretary sees it, and resume completes the original request',async t=>{
  const f=await setup(t),web=await f.start(),first=await web.state();assert.equal(first.mode,'bounded_task_controls');assert.equal(first.scopeControls.length,3);assert.ok(!JSON.stringify(first.scopeControls).includes(f.root));
  const stopped=await web.post('/api/scope-control/investment/stopped',{revision:0});assert.equal(stopped.status,200);assert.equal((await stopped.json() as any).ownerApproval,false);const view=await observeTask(f.store,f.task,candidate(f));assert.equal(view.controls.find((c:any)=>c.kind==='investment')!.stopped,true);
  assert.equal((await web.post('/api/task-control/contact/start',{})).status,202);const held=await waitFor(web.state,s=>!!s.taskControls[0].lastControllerReturn&&!s.taskControls[0].controllerActive);assert.equal(held.taskControls[0].lastControllerReturn.completed,false);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,0);
  assert.equal((await web.post('/api/scope-control/investment/open',{revision:1})).status,200);assert.equal((await web.post('/api/task-control/contact/start',{})).status,202);const returned=await waitFor(web.state,s=>s.taskControls[0].phase==='returned'&&!s.taskControls[0].controllerActive);assert.equal(returned.taskControls[0].lastControllerReturn.completed,true);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(f.q.taskInbox().status(f.task).length,1);assert.ok(!JSON.stringify(returned).includes(f.root));
  const again=await web.post('/api/scope-control/investment/stopped',{revision:0}),old=await again.json() as any;assert.equal(old.duplicate,true);assert.equal(old.receiptStillLatest,false);assert.equal(old.currentControl.state,'open');
});

test('HTTP cannot select a new scope or role, and concurrent identical requests keep one control revision',async t=>{
  const f=await setup(t),web=await f.start();assert.equal((await web.post('/api/scope-control/investment/stopped',{revision:0,scope:'other'})).status,400);assert.equal((await web.post('/api/scope-control/other/stopped',{revision:0})).status,503);
  const responses=await Promise.all([web.post('/api/scope-control/investment/stopped',{revision:0}),web.post('/api/scope-control/investment/stopped',{revision:0})]);assert.ok(responses.every(r=>r.status===200));const receipts=await Promise.all(responses.map(r=>r.json())) as any[];assert.equal(receipts.filter(r=>r.duplicate).length,1);assert.equal((await web.state()).scopeControls.find((c:any)=>c.id==='investment').revision,1);assert.equal((await web.post('/api/scope-control/investment/open',{revision:0})).status,503);assert.equal((await f.calls()).length,0);
  const gate=new SecretaryTools(f.store,f.task,candidate(f),join(f.root,'no-secretary-approval'),await TaskControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),f.sources));await assert.rejects(gate.call({tool:'tongxu_scope_control',arguments:{state:'open'},callId:'not-authorized'}),/secretary_query_not_allowed/);
});

test('a verified Owner stop survives local stop and restore attempts; only its original verified source can reopen it',async t=>{
  const f=await setup(t);f.request.authorityIntent='bounded-messages';await writeFile(f.requestPath,canonical(f.request));f.catalog.contacts[0]!.request.sha256=hash(await readFile(f.requestPath));f.q.taskInbox().enqueue(raw(f.request));const p=await prepareTaskOwner(f.store,f.task,f.request.id),plan=JSON.parse(await readFile(p.plan,'utf8')),authority=await messageAuthority({...f,item:f.task,plan,write:async()=>writeFile(p.plan,canonical(plan))});await authority.adopt({kind:'control',adoption:authority.scope.sha,control:'investment',state:'stopped'});const original=f.q.status().controls.find((c:any)=>c.kind==='investment'),web=await f.start();assert.equal((await web.state()).scopeControls.find((c:any)=>c.id==='investment').verifiedOwnerStop,true);
  const rejected=await web.post('/api/scope-control/investment/open',{revision:1});assert.equal(rejected.status,503);assert.equal((await rejected.json() as any).error,'verified_owner_stop_requires_verified_resume');assert.equal((await web.post('/api/scope-control/investment/stopped',{revision:1})).status,200);assert.deepEqual(f.q.status().controls.find((c:any)=>c.kind==='investment'),original);
  await authority.adopt({kind:'control',adoption:authority.scope.sha,control:'investment',state:'open'});assert.equal((await web.state()).scopeControls.find((c:any)=>c.id==='investment').verifiedOwnerStop,false);assert.equal((await web.post('/api/scope-control/investment/stopped',{revision:2})).status,200);assert.equal((await web.post('/api/scope-control/investment/open',{revision:3})).status,200);assert.equal((await f.calls()).length,0);
});

test('a newly adopted scope version invalidates the old control configuration without deleting its history',async t=>{
  const f=await setup(t);f.request.authorityIntent='bounded-messages';await writeFile(f.requestPath,canonical(f.request));f.catalog.contacts[0]!.request.sha256=hash(await readFile(f.requestPath));f.q.taskInbox().enqueue(raw(f.request));const p=await prepareTaskOwner(f.store,f.task,f.request.id),plan=JSON.parse(await readFile(p.plan,'utf8')),a=await messageAuthority({...f,item:f.task,plan,write:async()=>writeFile(p.plan,canonical(plan))}),web=await f.start();assert.equal((await web.post('/api/scope-control/investment/stopped',{revision:0})).status,200);
  const adopted=a.a.proposal(a.scope.sha).proposal;await a.adopt({...adopted,scopeVersion:'S2',previousAdoption:a.scope.sha});assert.equal((await web.state()).scopeControls.find((c:any)=>c.id==='investment').available,false);assert.equal((await web.post('/api/scope-control/investment/open',{revision:1})).status,503);assert.equal(f.q.status().controls.find((c:any)=>c.kind==='investment').stopped,1);assert.equal((await f.calls()).length,0);
});
