import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeControlFixture,until} from './native-control-fixture.js';
import {startWorkbench} from '../../src/workbench.js';
import {QueueStore} from '../../src/queue-store.js';
import {prepareTaskOwner} from '../../src/tasks.js';
import {runMessages} from '../../src/messages.js';
import type {MessageNativeHandle} from '../../src/message-runtime.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
const control=(s:any,option='check-counterexample')=>({option,threadId:s.nativeControl.threadId,sessionId:s.nativeControl.sessionId,turnId:s.nativeControl.turnId});
const active=(f:Awaited<ReturnType<typeof nativeControlFixture>>)=>until(async()=> (await f.controls.state())[0] as any,s=>s.nativeControl?.currentTurnActive===true);

test('workbench sends a fixed supplement to its exact owned turn, saves complete reply, and repeated/restarted entry sends nothing',async t=>{
  const f=await nativeControlFixture(t),app=await startWorkbench(f.planPath);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json',Origin:u.origin},post=(path:string,body:any)=>fetch(u.origin+path,{method:'POST',headers,body:JSON.stringify(body)}),state=async()=>(await (await fetch(u.origin+'/api/state',{headers})).json() as any).taskControls[0];
  assert.equal((await post('/api/task-control/contact/start',{})).status,202);const s=await until(state,s=>s.nativeControl?.currentTurnActive===true),body=control(s);
  assert.equal((await post('/api/task-control/contact/native',{...body,text:'unfixed input'})).status,503);assert.equal((await post('/api/task-control/contact/native',{...body,turnId:'wrong'})).status,503);assert.equal((await f.calls()).filter(c=>c.kind==='control').length,0);
  const response=await post('/api/task-control/contact/native',body);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json() as any).turnTerminationVerified,false);
  const returned=await until(state,s=>s.phase==='returned');assert.equal(returned.nativeControl,null);assert.equal(returned.nativeControlHistory[0].acknowledged,true);assert.equal(returned.nativeControlHistory[0].turnTerminationVerified,true);
  const report=await QueueStore.observeMessageReport(f.store,f.task,returned.run,f.request.id);assert.equal(report.completeCapture,true);assert.match(report.reportText,/核对边界值反例/);
  const repeat=await post('/api/task-control/contact/native',body);assert.equal((await repeat.json() as any).duplicate,true);assert.equal((await f.calls()).filter(c=>c.kind==='control').length,1);
  const fresh=await f.reload();await fresh.execute('contact');assert.equal((await fresh.controlNative('contact',body)).duplicate,true);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);
});

test('investment stop rejects the supplement but allows exact cleanup; interrupted original remains incomplete and is never resent',async t=>{
  const f=await nativeControlFixture(t),pending=f.controls.execute('contact'),s=await active(f);f.q.control(f.definition.context.scope.id,'investment','stopped','fixture:stop-before-steer');
  await assert.rejects(f.controls.controlNative('contact',control(s)),/new_investment_stopped/);assert.equal((await f.calls()).filter(c=>c.kind==='control').length,0);
  const receipt=await f.controls.controlNative('contact',control(s,'interrupt-current'));assert.equal(receipt.acknowledged,true);assert.equal(receipt.turnTerminationVerified,false);const result=await pending;assert.equal((result.execution as any).completed,false);assert.equal((result.state[0] as any).phase,'interrupted');
  const run=(result.execution as any).run,state=f.q.messages().status(run);assert.equal(state.messages[0]!.state,'Interrupted');assert.equal(state.runtimes[0]!.captureVerification?.proof.successfulCapture,true);
  const original=await readFile(join(state.runtimes[0]!.started.directory,'native','stdout.ndjson'));await f.controls.execute('contact');assert.deepEqual(await readFile(join(state.runtimes[0]!.started.directory,'native','stdout.ndjson')),original);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);
});

test('a second controller and stale candidate cannot acquire a live session; stopping it does not require new candidate authority',async t=>{
  const f=await nativeControlFixture(t),pending=f.controls.execute('contact'),s=await active(f),second=await f.reload();
  await assert.rejects(second.controlNative('contact',control(s)),/original_controller_required/);
  await writeFile(join(f.definition.workspace,'sample.js'),'export const changed=99;\n');await assert.rejects(f.controls.controlNative('contact',control(s)),/candidate_or_material_changed|task_queued_source_changed/);
  await f.controls.controlNative('contact',control(s,'interrupt-current'));await pending;assert.equal((await f.calls()).filter(c=>c.kind==='control').length,1);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);
});

test('configured authority and original resource claims are rechecked for a supplement; revocation cannot be replaced by UI access',async t=>{
  const f=await nativeControlFixture(t),ledger=await ledgerFixture(t),spec=ledger.profile.resources[0]!;f.request.authorityIntent='bounded-messages';f.request.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];const controls=await f.reload();f.controls=controls;f.q.taskInbox().enqueue(Buffer.from(canonical(f.request)));const selected=await prepareTaskOwner(f.store,f.task,f.request.id),plan=JSON.parse(await readFile(selected.plan,'utf8'));
  const authority=await messageAuthority({...f,item:f.task,plan,write:async()=>writeFile(selected.plan,canonical(plan))});f.q.resources().configure(Buffer.from(canonical(ledger.profile)));
  const pending=controls.execute('contact'),s=await active(f);assert.equal(ledger.state().claims.length,1);await authority.adopt({kind:'revoke',decision:authority.confirmed.sha});
  await assert.rejects(controls.controlNative('contact',control(s)),/revoked/);assert.equal((await f.calls()).filter(c=>c.kind==='control').length,0);await controls.controlNative('contact',control(s,'interrupt-current'));const end=await pending;assert.equal((end.execution as any).resourcesSettled,true);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);assert.equal(f.q.messageResources().state((end.execution as any).run).phase,'interrupted_returned');
  await controls.closeInterrupted('contact');assert.equal(((await controls.state())[0] as any).phase,'interrupted_closed');await controls.closeInterrupted('contact');assert.equal(ledger.state().settlements.length,1);
});

test('after exact interruption and capture recovery, the original A can handle a new explicit request with retained inputs and an honestly new session',async t=>{
  const f=await nativeControlFixture(t),pending=f.controls.execute('contact'),s=await active(f);
  await assert.rejects(f.controls.closeInterrupted('contact'),/controller_active/);await f.controls.controlNative('contact',control(s,'interrupt-current'));const ended=await pending,run=(ended.execution as any).run,original=f.q.messages().status(run),path=join(original.runtimes[0]!.started.directory,'native','stdout.ndjson'),bytes=await readFile(path);
  const next={...f.request,id:'explicit-followup',question:'读取保留的中断记录，核对同一固定代码的边界情况。',nativeControls:f.request.nativeControls!.map(c=>({...c,messageId:'explicit-followup'}))};f.q.taskInbox().enqueue(Buffer.from(canonical(next)));await assert.rejects(prepareTaskOwner(f.store,f.task,next.id),/original_responsibility_pending/);
  await writeFile(path,bytes.subarray(0,bytes.length-7));await assert.rejects(f.controls.closeInterrupted('contact'),/capture_unresolved/);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);await writeFile(path,bytes);
  const closed=await f.controls.closeInterrupted('contact');assert.equal(closed.newModelRequests,0);const prepared=await prepareTaskOwner(f.store,f.task,next.id),context=JSON.parse(await readFile(join(f.store,'task-inbox',f.task,next.id,'context.json'),'utf8'));assert.equal(context.newNativeContext,true);assert.equal(context.previousExecutions[0].interruptedRequestClosed,true);assert.equal(context.previousExecutions[0].reports[0].state,'Interrupted');assert.equal(context.previousExecutions[0].reports[0].receipt,null);
  let handle:MessageNativeHandle|null=null;const work=runMessages(f.store,prepared.plan,false,prepared.run,undefined,(_id,h)=>{handle=h;});const current=await until(async()=>handle?.state(),s=>s?.currentTurnActive===true);assert.ok(current);assert.notEqual(current.sessionId,s.nativeControl.sessionId);await handle!.control('check-counterexample',{threadId:current.threadId,sessionId:current.sessionId,turnId:current.turnId});assert.equal((await work).completed,true);
  assert.equal(f.q.taskInbox().status(f.task)[0]!.phase,'interrupted_closed');assert.equal(f.q.taskInbox().status(f.task)[1]!.phase,'returned');assert.equal((await f.calls()).filter(c=>c.kind==='input').length,2);assert.deepEqual(await readFile(path),bytes);
});

test('an owned bootstrap denied ordinary usage is known unstarted and can retry after that condition changes',async t=>{
  const f=await nativeControlFixture(t,'quota-toggle'),first=await f.controls.execute('contact');assert.equal((first.execution as any).newModelRequests,0);const run=(first.execution as any).run;assert.equal(f.q.messages().status(run).runtimes[0]!.ended.proof.knownUnstarted,true);
  await rm(f.quotaFile);const pending=f.controls.execute('contact'),s=await active(f);await f.controls.controlNative('contact',control(s));const result=await pending;assert.equal((result.execution as any).completed,true);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);assert.equal(f.q.messages().status(run).runtimes[0]!.attempt,2);
});

test('TNC-F01: source changed during the final actual provider lookup cannot send a supplement',async t=>{
  const f=await nativeControlFixture(t),ledger=await ledgerFixture(t),arm=join(ledger.root,'arm'),entered=join(ledger.root,'entered'),release=join(ledger.root,'release');
  let provider=await readFile(ledger.profile.executable,'utf8');provider=provider.replace("import {DatabaseSync}","import fs from 'node:fs';\nimport {DatabaseSync}");const marker='const c=JSON.parse(input),db=new DatabaseSync(';assert.ok(provider.includes(marker));
  provider=provider.replace(marker,`const c=JSON.parse(input);if(c.command==='lookup'&&fs.existsSync(${JSON.stringify(arm)})){fs.unlinkSync(${JSON.stringify(arm)});fs.writeFileSync(${JSON.stringify(entered)},'entered');const until=Date.now()+2500;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(release)}))throw new Error('fixture_release_missing');}const db=new DatabaseSync(`);
  await writeFile(ledger.profile.executable,provider,{mode:0o700});ledger.profile.executableSha256=hash(provider);const spec=ledger.profile.resources[0]!;f.request.authorityIntent='bounded-messages';f.request.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];f.controls=await f.reload();f.q.taskInbox().enqueue(Buffer.from(canonical(f.request)));const selected=await prepareTaskOwner(f.store,f.task,f.request.id),plan=JSON.parse(await readFile(selected.plan,'utf8'));await messageAuthority({...f,item:f.task,plan,write:async()=>writeFile(selected.plan,canonical(plan))});f.q.resources().configure(Buffer.from(canonical(ledger.profile)));
  const pending=f.controls.execute('contact'),s=await active(f);await writeFile(arm,'armed');const attempt=f.controls.controlNative('contact',control(s)).then(value=>({accepted:true,value,reason:null}),error=>({accepted:false,value:null,reason:error.message}));
  await until(async()=>{try{return await readFile(entered,'utf8');}catch{return null;}},Boolean);await writeFile(join(f.definition.workspace,'sample.js'),'export const lateChanged=70657;\n');await writeFile(release,'release');const result=await attempt;assert.equal(result.accepted,false);assert.match(result.reason,/candidate_or_material_changed|source_changed_before_send/);
  await f.controls.controlNative('contact',control(s,'interrupt-current'));await pending;const calls=await f.calls();assert.equal(calls.filter(c=>c.method==='turn/steer').length,0);assert.equal(calls.filter(c=>c.kind==='input').length,1);await writeFile(join(f.root,'late-source-proof.json'),canonical({result,calls,ledger:ledger.state()}));
});

test('unconsumed supplement leaves the task unresolved but complete original final remains readable over HTTP',async t=>{
  const f=await nativeControlFixture(t);let script=await readFile(f.codex,'utf8');script=script.replace('consumed:[...x.replyReferences,supplement.supplementSha256]','consumed:[...x.replyReferences]');await writeFile(f.codex,script);f.request.participant.executableSha256=hash(script);f.controls=await f.reload();
  const pending=f.controls.execute('contact'),s=await active(f);await f.controls.controlNative('contact',control(s));const ended=await pending,run=(ended.execution as any).run;assert.equal((ended.execution as any).completed,false);assert.equal((ended.state[0] as any).phase,'unresolved');
  const app=await startWorkbench(f.planPath);t.after(()=>app.close());const u=new URL(app.url),response=await fetch(u.origin+'/api/message-report/task/'+run+'/'+f.request.id,{headers:{Authorization:'Bearer '+u.hash.slice(1)}});assert.equal(response.status,200);const report=await response.json() as any;
  assert.equal(report.consumptionConfirmed,false);assert.equal(report.reportBodyKind,'unconfirmed_original');assert.equal(report.completeCapture,true);assert.equal(report.reportText,report.report);assert.equal(hash(report.report),report.reportSha256);assert.match(report.reportText,/核对边界值反例/);
  await assert.rejects(f.controls.closeInterrupted('contact'),/interruption_or_resources_unresolved/);await f.controls.execute('contact');assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);
});
