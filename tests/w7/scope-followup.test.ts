import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,chmod,rm} from 'node:fs/promises';
import {DatabaseSync,backup} from 'node:sqlite';
import {join} from 'node:path';
import {prepareScopeFollowup,authorizeScopeFollowup} from '../../src/task-scope-followup.js';
import {TaskControls} from '../../src/task-controls.js';
import {OwnerControls} from '../../src/owner-controls.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {startWorkbench} from '../../src/workbench.js';
import {scopeFollowupFixture as fixture} from './scope-followup-fixture.js';
import {ScopeFollowupControls} from '../../src/scope-followup-controls.js';
import {until} from './native-control-fixture.js';


test('new adopted scope prepares original A followup, retains dirty/index and old records, then uses exact original authority and captures',async t=>{
 const f=await fixture(t,true),before=f.q.tasks().current(f.task),oldInbox=f.q.taskInbox().status(f.task),file=await readFile(join(f.definition.workspace,'sample.js')),index=await readFile(join(f.definition.workspace,'.git/index')),calls=await f.calls();
 const prepared=await prepareScopeFollowup(f.store,Buffer.from(canonical(f.request)));assert.equal(prepared.newModelRequests,0);assert.equal(prepared.modelStarted,false);assert.equal(prepared.originalOwnerAssignmentRetained,true);assert.notEqual(prepared.task,f.task);assert.deepEqual(await f.calls(),calls);
 assert.deepEqual(f.q.tasks().current(f.task),before);assert.deepEqual(f.q.taskInbox().status(f.task),oldInbox);assert.deepEqual(await readFile(join(f.definition.workspace,'sample.js')),file);assert.deepEqual(await readFile(join(f.definition.workspace,'.git/index')),index);
 const next=f.q.tasks().current(prepared.task);assert.equal(next.context.scope.version,'S2');assert.equal(next.definition.workspace,before.definition.workspace);assert.deepEqual(next.definition.paths,before.definition.paths);assert.deepEqual(f.q.taskInbox().originalResponsibility(prepared.task).participant,{...f.q.taskInbox().originalResponsibility(f.task).participant,item:prepared.task});
 const selected=f.q.taskInbox().prepare(prepared.task,prepared.ownerRequest),context=JSON.parse(selected.context.toString());assert.equal(context.scopeContinuation.predecessor,f.task);assert.equal(context.scopeContinuation.newScope.adoption,f.nextScope.sha);assert.equal(context.scopeContinuation.newScope.productAcceptance,false);assert.equal(context.scopeContinuation.latestOriginal.run,oldInbox[0]!.run);assert.ok(context.scopeContinuation.latestOriginal.replies[0].reply.report.includes('明确标记'));assert.equal(context.nativeSessionResumed,false);
 const originalPrepared=f.q.status(),again=await prepareScopeFollowup(f.store,Buffer.from(canonical(f.request)));assert.equal(again.duplicate,true);assert.equal(again.task,prepared.task);assert.deepEqual(f.q.status(),originalPrepared);assert.deepEqual(await f.calls(),calls);
 const controls=await TaskControls.load(prepared.controls.path,prepared.controls.sha256,[prepared.source]);t.after(()=>controls.drain());const blocked=await controls.execute(prepared.contact.id);assert.equal((blocked.execution as any).completed,false);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
 const owner=new OwnerControls([prepared.source.id],[prepared.source]);await owner.apply(prepared.source.id,{proposalSha256:prepared.proposalSha256,sourceUrl:await f.originalDecision(prepared.proposalSha256)});await authorizeScopeFollowup(f.store,prepared.task);
 const completed=await controls.execute(prepared.contact.id);assert.equal((completed.execution as any).completed,true,JSON.stringify(completed));assert.equal((await f.calls()).filter(x=>x.kind==='input').length,2);assert.equal(((await controls.state())[0] as any).phase,'returned');assert.equal((await controls.report(prepared.contact.id)).completeCapture,true);
 const trace=await readFile(f.trace);await controls.execute(prepared.contact.id);assert.deepEqual(await readFile(f.trace),trace);assert.deepEqual(await readFile(join(f.definition.workspace,'sample.js')),file);assert.deepEqual(await readFile(join(f.definition.workspace,'.git/index')),index);
});
test('queued original or prepared family work blocks another followup; stale selected source and extra permissions are refused',async t=>{
 const f=await fixture(t),raw=Buffer.from(canonical(f.request));f.q.taskInbox().enqueue(Buffer.from(canonical({...f.previousRequest,id:'old-unsent'})));
 const before=f.q.status();await assert.rejects(prepareScopeFollowup(f.store,raw),/original_work_not_ended/);assert.deepEqual(f.q.status(),before);
 f.q.taskInbox().cancelUnsent(f.task,'old-unsent','explicit fixture cancellation before scope continuation');
 const prepared=await prepareScopeFollowup(f.store,raw);await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical({...f.request,goal:'another pending followup'}))),/original_work_not_ended/);assert.equal(f.q.scopeFollowups().status(f.task).length,1);assert.equal(prepared.newModelRequests,0);
 // The original queue is still callable after preparation. It must not admit
 // competing work behind the new workbench's prepared task.
 const fixed=f.q.status();assert.throws(()=>f.q.taskInbox().enqueue(Buffer.from(canonical({...f.previousRequest,id:'late-original-after-preparation'}))),/original_work_not_ended/);assert.deepEqual(f.q.status(),fixed);
 const nextControl=await TaskControls.load(prepared.controls.path,prepared.controls.sha256,[prepared.source]);t.after(()=>nextControl.drain());await nextControl.cancel(prepared.contact.id);
 const late=f.q.taskInbox().enqueue(Buffer.from(canonical({...f.previousRequest,id:'late-original-after-preparation'})));assert.equal(late.duplicate,false);f.q.taskInbox().cancelUnsent(f.task,'late-original-after-preparation','explicit fixture cleanup');
 await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical({...f.request,writingPermissionGranted:true}))),/followup_invalid/);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
});
test('changed workspace or missing current scope cannot be silently substituted during preparation',async t=>{
 const f=await fixture(t),before=f.q.status();await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical({...f.request,adoption:f.a.scope.sha}))),/new_adopted_scope_required/);assert.deepEqual(f.q.status(),before);
 await writeFile(join(f.definition.workspace,'sample.js'),'export const value = 99;\n');await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical(f.request))),/original_source_changed/);assert.equal(f.q.scopeFollowups().status(f.task).length,0);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
 const controls=new ScopeFollowupControls(['task'],f.plan.sources);t.after(()=>controls.drain());const observed=await controls.observe('task',{task:f.task});assert.equal(observed.workspaceModified,false);assert.notEqual(observed.current.sourceSha256,f.request.expectedSourceSha256);
 const prepared=await controls.prepare('task',{task:f.task,adoption:f.nextScope.sha,expectedPacket:observed.current.packet,expectedSourceSha256:observed.current.sourceSha256,goal:f.request.goal,acceptance:f.request.acceptance});assert.equal(prepared.newModelRequests,0);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(await readFile(join(f.definition.workspace,'sample.js'),'utf8'),'export const value = 99;\n');
});
test('the same HTTP workbench prepares new-scope work, reads its original Owner confirmation, starts A and reads the captured report',async t=>{
 const f=await fixture(t,true);await writeFile(f.planPath,canonical({...f.plan,ownerControls:['task']}));const app=await startWorkbench(f.planPath);t.after(()=>app.close());
 const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json',Origin:u.origin},state=async()=>await (await fetch(u.origin+'/api/state',{headers})).json() as any;
 const post=async(action:string,body:unknown,source='task',h=headers)=>{const r=await fetch(u.origin+'/api/scope-followup/'+source+'/'+action,{method:'POST',headers:h,body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};
 const {schemaVersion,kind,...body}=f.request,before=await state();assert.equal(before.scopeFollowups[0].original.scope.version,'S1');assert.equal(before.ownerControls[0].currentScope.scopeVersion,'S2');
 assert.equal((await post('prepare',body,'not-selected')).status,503);assert.equal((await post('prepare',body,'task',{...headers,Origin:'https://outside.example'})).status,403);
 const prepared=await post('prepare',body);assert.equal(prepared.status,200,JSON.stringify(prepared));const p=prepared.value;
 const followup=async()=> (await state()).scopeFollowups[0].followups.find((x:any)=>x.task===p.task);
 async function settled(){for(let i=0;i<300;i++){const value=await followup();if(!value.controllerActive)return value;await new Promise(r=>setTimeout(r,20));}throw new Error('scope_fixture_controller_timeout');}
 assert.equal((await post('start',{task:p.task})).status,202);assert.equal((await settled()).currentControllerProblem,'verified_owner_decision_missing');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
 const sourceUrl=await f.originalDecision(p.proposalSha256);assert.equal((await post('owner-apply',{task:p.task,request:{proposalSha256:p.proposalSha256,sourceUrl}})).status,200);
 assert.equal((await post('start',{task:p.task})).status,202);const completed=await settled();assert.equal(completed.control.phase,'returned',JSON.stringify(completed));assert.equal((await f.calls()).filter(x=>x.kind==='input').length,2);
 const response=await fetch(u.origin+'/api/scope-followup-report/task/'+p.task,{headers}),report=await response.json() as any;assert.equal(response.status,200);assert.equal(report.completeCapture,true);assert.equal(report.consumptionConfirmed,true);assert.equal(report.nativeSessionResumed,false);assert.equal(report.executionKind,'fixture');
 const trace=await readFile(f.trace);await post('start',{task:p.task});await settled();assert.deepEqual(await readFile(f.trace),trace);
 const second=await startWorkbench(f.planPath);t.after(()=>second.close());const v=new URL(second.url),otherHeaders={Authorization:'Bearer '+v.hash.slice(1)};const reopened=await (await fetch(v.origin+'/api/state',{headers:otherHeaders})).json() as any;assert.equal(reopened.scopeFollowups[0].followups[0].inbox[0].phase,'returned');assert.deepEqual(await (await fetch(v.origin+'/api/scope-followup-report/task/'+p.task,{headers:otherHeaders})).json(),report);assert.deepEqual(await readFile(f.trace),trace);
});
test('cancelled unstarted S2 preparation does not discard the last real original report when explicitly preparing S3',async t=>{
 const f=await fixture(t),one=await prepareScopeFollowup(f.store,Buffer.from(canonical(f.request))),current=f.q.tasks().current(one.task),old=f.a.a.proposal(f.nextScope.sha).proposal as any,next=await f.a.adopt({...old,scopeVersion:'S3',previousAdoption:f.nextScope.sha});
 const three={...f.request,task:one.task,adoption:next.sha,expectedPacket:current.packet,expectedSourceSha256:current.fingerprint};await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical(three))),/original_work_not_ended/);
 const controls=await TaskControls.load(one.controls.path,one.controls.sha256,[one.source]);t.after(()=>controls.drain());await controls.cancel(one.contact.id);
 const two=await prepareScopeFollowup(f.store,Buffer.from(canonical(three))),context=f.q.scopeFollowups().context(two.task)!;assert.equal(context.predecessor,one.task);assert.equal(context.rootTask,f.task);assert.equal(context.latestOriginal.task,f.task);assert.ok(context.latestOriginal.replies[0].reply.report.includes('明确标记'));assert.equal(f.q.scopeFollowups().status(f.task).length,2);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
});
test('an active new-scope run blocks S3; its exact owned interrupt and explicit closure preserve the original assignment',async t=>{
 const f=await fixture(t,false,true),prepared=await prepareScopeFollowup(f.store,Buffer.from(canonical(f.request))),owner=new OwnerControls([prepared.source.id],[prepared.source]);
 await owner.apply(prepared.source.id,{proposalSha256:prepared.proposalSha256,sourceUrl:await f.originalDecision(prepared.proposalSha256)});
 const controls=new ScopeFollowupControls(['task'],f.plan.sources);t.after(()=>controls.drain());controls.begin('task','start',{task:prepared.task});
 const active=await until(()=>controls.state(),rows=>Boolean((rows[0] as any).followups?.[0]?.control?.nativeControl?.currentTurnActive)),n=(active[0] as any).followups[0].control.nativeControl;assert.deepEqual(n.options.map((o:any)=>o.action),['interrupt']);
 const prior=f.a.a.proposal(f.nextScope.sha).proposal as any,next=await f.a.adopt({...prior,scopeVersion:'S3',previousAdoption:f.nextScope.sha}),current=f.q.tasks().current(prepared.task),request={...f.request,task:prepared.task,adoption:next.sha,expectedPacket:current.packet,expectedSourceSha256:current.fingerprint};
 await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical(request))),/original_work_not_ended/);
 await assert.rejects(controls.native('task',{task:prepared.task,request:{option:n.options[0].id,threadId:n.threadId,sessionId:n.sessionId,turnId:'wrong-turn'}}),/target|turn/);
 await controls.native('task',{task:prepared.task,request:{option:n.options[0].id,threadId:n.threadId,sessionId:n.sessionId,turnId:n.turnId}});
 const ended=await until(()=>controls.state(),rows=>!(rows[0] as any).followups[0].controllerActive);assert.equal((ended[0] as any).followups[0].inbox[0].phase,'interrupted');await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical(request))),/original_work_not_ended/);
 controls.begin('task','close-interrupted',{task:prepared.task});await until(()=>controls.state(),rows=>!(rows[0] as any).followups[0].controllerActive);
 const continued=await prepareScopeFollowup(f.store,Buffer.from(canonical(request))),context=f.q.scopeFollowups().context(continued.task)!;assert.equal(context.latestOriginal.phase,'interrupted_closed');assert.equal(context.newScope.scopeVersion,'S3');assert.equal(context.originalOwnerAssignmentRetained,true);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,2);
});
test('an ended but incomplete native followup stays unknown across retry and cannot be bypassed by a newer scope',async t=>{
 const f=await fixture(t,false,true),prepared=await prepareScopeFollowup(f.store,Buffer.from(canonical(f.request))),owner=new OwnerControls([prepared.source.id],[prepared.source]);await owner.apply(prepared.source.id,{proposalSha256:prepared.proposalSha256,sourceUrl:await f.originalDecision(prepared.proposalSha256)});
 const controls=new ScopeFollowupControls(['task'],f.plan.sources);t.after(()=>controls.drain());controls.begin('task','start',{task:prepared.task});await until(()=>controls.state(),rows=>Boolean((rows[0] as any).followups[0].control?.nativeControl?.currentTurnActive));
 const ended=await until(()=>controls.state(),rows=>!(rows[0] as any).followups[0].controllerActive,14000);assert.ok(['active_or_unknown','unresolved'].includes((ended[0] as any).followups[0].inbox[0].phase));
 const trace=await readFile(f.trace),prior=f.a.a.proposal(f.nextScope.sha).proposal as any,next=await f.a.adopt({...prior,scopeVersion:'S3',previousAdoption:f.nextScope.sha}),current=f.q.tasks().current(prepared.task),request={...f.request,task:prepared.task,adoption:next.sha,expectedPacket:current.packet,expectedSourceSha256:current.fingerprint};await assert.rejects(prepareScopeFollowup(f.store,Buffer.from(canonical(request))),/original_work_not_ended/);
 controls.begin('task','start',{task:prepared.task});await until(()=>controls.state(),rows=>!(rows[0] as any).followups[0].controllerActive);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.q.scopeFollowups().status(f.task).length,1);
});
test('equal task IDs in two selected queues keep their controllers, permissions and actual returned runs separate',async t=>{
 const f=await fixture(t,false,false,true),other=join(f.root,'second-independent-queue');await cp(f.store,other,{recursive:true});
 // Produce one consistent DB copy while the source writer is idle. There are
 // no native runs in this original zero-input fixture to relocate or relabel.
 for(const name of ['queue.sqlite','queue.sqlite-wal','queue.sqlite-shm'])await rm(join(other,name),{force:true});const db=new DatabaseSync(join(f.store,'queue.sqlite'),{readOnly:true});try{await backup(db,join(other,'queue.sqlite'));}finally{db.close();}await chmod(join(other,'queue.sqlite'),0o600);
 const a=await prepareScopeFollowup(f.store,Buffer.from(canonical(f.request))),b=await prepareScopeFollowup(other,Buffer.from(canonical(f.request)));assert.equal(a.task,b.task);assert.notEqual(a.run,b.run);
 for(const prepared of [a,b]){const owner=new OwnerControls([prepared.source.id],[prepared.source]);await owner.apply(prepared.source.id,{proposalSha256:prepared.proposalSha256,sourceUrl:await f.originalDecision(prepared.proposalSha256)});}
 const controls=new ScopeFollowupControls(['one','two'],[{...f.plan.sources[0]!,id:'one'},{...f.plan.sources[0]!,id:'two',store:other}]);t.after(()=>controls.drain());controls.begin('one','start',{task:a.task});await until(()=>controls.state(),rows=>!(rows[0] as any).followups[0].controllerActive);
 assert.equal((await controls.report('one',a.task)).completeCapture,true);controls.begin('two','start',{task:b.task});const states=await until(()=>controls.state(),rows=>!(rows[1] as any).followups[0].controllerActive);assert.equal((states[1] as any).followups[0].inbox[0].phase,'returned');const one=await controls.report('one',a.task),two=await controls.report('two',b.task);assert.notEqual(one.sessionId,two.sessionId);assert.notEqual(one.run,two.run);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,2);
});
