import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {controlFixture} from './task-controls-fixture.js';
import {TaskControls,parseTaskControlCatalog} from '../../src/task-controls.js';
import {startWorkbench,parseWorkbenchPlan} from '../../src/workbench.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {QueueStore} from '../../src/queue-store.js';
import {prepareTaskOwner} from '../../src/tasks.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
const raw=(x:unknown)=>Buffer.from(canonical(x));

test('fixed contacts retain the original inbox, full reports and zero-input repeat without a secretary',async t=>{
  const f=await controlFixture(t),before=f.q.status();assert.equal((await f.controls.state())[0]!.available,true);assert.deepEqual(f.q.status(),before);const run=await f.controls.execute('contact');assert.equal((run.state[0] as any).phase,'returned');assert.equal((run.execution as any).newModelRequests,1);
  const status=f.q.taskInbox().status(f.task)[0]!,report=await QueueStore.observeMessageReport(f.store,f.task,status.run,f.request.id);assert.equal(report.completeCapture,true);assert.ok(report.report.length>0);const repeated=await f.controls.execute('contact');assert.equal((repeated.execution as any).newModelRequests,0);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(f.q.taskInbox().status(f.task).length,1);
});

test('two control instances competing for the same request cannot start a second model task',async t=>{
  const f=await controlFixture(t,'delay'),second=await f.load();t.after(()=>second.drain());await Promise.all([f.controls.execute('contact'),second.execute('contact')]);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(f.q.taskInbox().status(f.task).length,1);assert.equal((await f.controls.state())[0]!.available,true);
});

test('unknown execution remains the original unknown across repeat, cancellation and a new controller',async t=>{
  const f=await controlFixture(t,'hang');await f.controls.execute('contact');await assert.rejects(f.controls.cancel('contact'),/active_or_unknown/);const second=await f.load();t.after(()=>second.drain());await second.execute('contact');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.notEqual(((await second.state())[0] as any).phase,'returned');assert.equal(f.q.taskInbox().status(f.task).length,1);
});

test('an unsent stopped request can be withdrawn and stays cancelled without removing its original record',async t=>{
  const f=await controlFixture(t);f.q.control(f.definition.context.scope.id,'investment','stopped','fixture:stop-before-contact');await f.controls.execute('contact');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,0);await f.controls.cancel('contact');assert.equal(((await f.controls.state())[0] as any).phase,'cancelled');await f.controls.execute('contact');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,0);assert.equal(f.q.taskInbox().status(f.task).length,1);
});

test('a source change is observed before registering the configured request and sends no input',async t=>{
  const f=await controlFixture(t);await writeFile(join(f.definition.workspace,'sample.js'),'export const later=99;\n');await assert.rejects(f.controls.begin('contact'),/task_control_candidate_changed/);assert.equal(f.q.taskInbox().status(f.task).length,0);assert.equal((await f.calls()).length,0);assert.equal(((await f.controls.state())[0] as any).currentMaterial,false);
});

test('request content is frozen at load; neither a changed path nor runtime text can replace the input',async t=>{
  const f=await controlFixture(t);await writeFile(f.requestPath,canonical({...f.request,question:'arbitrary substituted request'}));await assert.rejects(f.load(),/task_control_request_changed/);await f.controls.execute('contact');const s=f.q.taskInbox().status(f.task)[0]!,submitted=f.q.messages().submitted(s.run,'original-owner')[0]!;assert.match(submitted.body,new RegExp(f.request.question));assert.ok(!JSON.stringify(submitted).includes('arbitrary substituted request'));
});

test('catalog rejects unselected routes, forged sender identities, aliases and implicit readonly writes',async t=>{
  const f=await controlFixture(t);await assert.rejects(TaskControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),[]),/source_not_selected/);await assert.rejects(f.controls.begin('other'),/action_not_selected/);assert.throws(()=>parseWorkbenchPlan(raw({...f.plan,kind:'tongxu-local-workbench'})),/invalid_workbench_controls/);assert.throws(()=>parseTaskControlCatalog(raw({...f.catalog,contacts:[...f.catalog.contacts,...f.catalog.contacts]})),/contact_invalid/);
  await writeFile(f.requestPath,canonical({...f.request,from:{task:'a'.repeat(64),run:'b'.repeat(64),messageId:'forged'}}));f.catalog.contacts[0]!.request.sha256=hash(await readFile(f.requestPath));await assert.rejects(f.load(),/route_invalid/);assert.equal((await f.calls()).length,0);
});

test('controlled HTTP uses only explicit same-origin empty commands and preserves original report routes',async t=>{
  const f=await controlFixture(t),app=await startWorkbench(f.planPath);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json',Origin:u.origin},post=(path:string,body='{}',h:Record<string,string>=headers)=>fetch(u.origin+path,{method:'POST',headers:h,body});
  const state=await (await fetch(u.origin+'/api/state',{headers})).json() as any;assert.equal(state.mode,'bounded_task_contacts');assert.equal(state.taskControls[0].phase,'not_registered');assert.ok(!JSON.stringify(state.taskControls).includes(f.root));
  assert.equal((await post('/api/task-control/contact/start','{}',{'Content-Type':'application/json',Origin:u.origin})).status,401);assert.equal((await post('/api/task-control/contact/start','{}',{...headers,Origin:'https://elsewhere.example'})).status,403);assert.equal((await post('/api/task-control/contact/start','{"role":"owner","shell":"anything"}')).status,400);assert.equal((await post('/api/task-control/contact/start',' '.repeat(1025))).status,413);assert.equal((await post('/api/merge')).status,405);assert.equal((await post('/api/task-control/not-selected/start')).status,503);assert.equal((await f.calls()).length,0);
  assert.equal((await post('/api/task-control/contact/start')).status,202);const end=Date.now()+6000;let current:any;do{current=await (await fetch(u.origin+'/api/state',{headers})).json();if(current.taskControls[0].phase==='returned')break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<end);assert.equal(current.taskControls[0].phase,'returned');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
  const report=await (await fetch(u.origin+'/api/message-report/task/'+current.taskControls[0].run+'/'+f.request.id,{headers})).json() as any;assert.equal(report.completeCapture,true);assert.ok(report.reportText.length>0);
});

test('direct contacts use exact original authority and provider claims; revoked permission cannot be replaced by a button',async t=>{
  for(const revoked of [false,true]){const f=await controlFixture(t),ledger=await ledgerFixture(t),spec=ledger.profile.resources[0]!;f.request.authorityIntent='bounded-messages';f.request.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];await writeFile(f.requestPath,canonical(f.request));f.catalog.contacts[0]!.request.sha256=hash(await readFile(f.requestPath));const controls=await f.load();t.after(()=>controls.drain());f.q.taskInbox().enqueue(raw(f.request));const selected=await prepareTaskOwner(f.store,f.task,f.request.id),plan=JSON.parse(await readFile(selected.plan,'utf8')),authority=await messageAuthority({...f,item:f.task,plan,write:async()=>writeFile(selected.plan,canonical(plan))});f.q.resources().configure(raw(ledger.profile));if(revoked)await authority.adopt({kind:'revoke',decision:authority.confirmed.sha});
    const result=await controls.execute('contact');assert.equal((result.execution as any).completed,!revoked);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,revoked?0:1);assert.equal(ledger.state().claims.length,revoked?0:1);assert.equal(ledger.state().settlements.length,revoked?0:1);await controls.execute('contact');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,revoked?0:1);
  }
});

test('server closing during source preparation waits for that preparation and prevents late request registration',async t=>{
  const f=await controlFixture(t),open=QueueStore.open;let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);let first=true;
  QueueStore.open=async function(path:string){const q=await open.call(QueueStore,path);if(path===f.store&&first){first=false;entered();await blocked;}return q;};
  try{const pending=f.controls.begin('contact'),rejected=assert.rejects(pending,/server_closing/);await reached;let drained=false;const closing=f.controls.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);release();await rejected;await closing;assert.equal(f.q.taskInbox().status(f.task).length,0);assert.equal((await f.calls()).length,0);}finally{release();QueueStore.open=open;}
});
