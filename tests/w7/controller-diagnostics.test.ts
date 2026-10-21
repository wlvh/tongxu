import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {controlFixture} from './task-controls-fixture.js';
import {prepareTaskOwner} from '../../src/tasks.js';
import {canonical} from '../../src/comparison.js';
import {observeTask} from '../../src/secretary-tools.js';
test('preparation failure survives a new controller and remains separate from the original model result',async t=>{
  const f=await controlFixture(t);f.q.taskInbox().enqueue(Buffer.from(canonical(f.request)));const prepared=await prepareTaskOwner(f.store,f.task,f.request.id),path=join(f.store,'task-inbox',f.task,f.request.id,'context.json'),original=await readFile(path);await writeFile(path,'different input');await f.controls.execute('contact');const next=await f.load();t.after(()=>next.drain());let state=(await next.state())[0] as any;assert.equal(state.phase,'prepared');assert.equal(state.lastControllerReturn.reason,'task_prepared_file_changed');assert.equal(state.lastControllerReturn.newModelRequests,null);assert.equal((await f.calls()).length,0);assert.ok(!JSON.stringify(state).includes(f.root));
  const c=f.q.tasks().current(f.task).manifest.candidate,s=await observeTask(f.store,f.task,{repository:c.repository,pr:null,H:c.H,B:c.B,target:c.targetRef,kind:'development-task',taskId:f.task,sourceSha256:c.sourceSha256});assert.equal(s.developmentTask.controllerReturns.at(-1).reason,state.lastControllerReturn.reason);
  await writeFile(path,original);await next.execute('contact');state=(await next.state())[0] as any;assert.equal(state.phase,'returned');assert.equal(state.lastControllerReturn.completed,true);assert.equal(state.controllerReturnCount,2);const report=await next.report('contact');
  await writeFile(path,'another failed input');await next.execute('contact');state=(await next.state())[0] as any;assert.equal(state.phase,'returned');assert.equal(state.lastControllerReturn.completed,false);assert.equal((await next.report('contact')).report,report.report);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(state.run,prepared.run);
});
test('failure before inbox registration is recorded without creating a task request or dispatch proof',async t=>{
  const f=await controlFixture(t);await writeFile(join(f.definition.workspace,'sample.js'),'export const changed=111;\n');await assert.rejects(f.controls.begin('contact'),/candidate_changed/);const state=(await f.controls.state())[0] as any;assert.equal(state.phase,'not_registered');assert.equal(state.currentMaterial,false);assert.equal(state.lastControllerReturn.reason,'task_control_candidate_changed');assert.equal(state.lastControllerReturn.meaning,'controller_return_not_dispatch_proof');assert.equal(f.q.taskInbox().status(f.task).length,0);assert.equal((await f.calls()).length,0);
});
test('a slow status read cannot lose the result of the exact execution that has already ended',async t=>{
  const f=await controlFixture(t),read=f.controls.state.bind(f.controls);let first=true;f.controls.state=async(id?:string)=>{if(first){first=false;const end=Date.now()+5000;while(!f.q.taskInbox().controllerReturns(f.task).some(r=>r.completed)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(f.q.taskInbox().controllerReturns(f.task).some(r=>r.completed));await new Promise(r=>setTimeout(r,10));}return read(id);};const result=await f.controls.execute('contact');assert.equal((result.execution as any).completed,true);assert.equal((result.execution as any).newModelRequests,1);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
});
