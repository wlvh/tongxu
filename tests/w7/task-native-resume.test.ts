import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeResumeFixture} from './native-resume-fixture.js';
import {until} from './native-control-fixture.js';
import {prepareTaskOwner} from '../../src/tasks.js';
import {runMessages} from '../../src/messages.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import type {MessageNativeHandle} from '../../src/message-runtime.js';
import type {TaskOwnerRequest} from '../../src/task-inbox.js';
import {startWorkbench} from '../../src/workbench.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {readOwnerSource} from '../../src/authority-source.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {DatabaseSync} from 'node:sqlite';
import {readOwnedCodexSession} from '../../src/repair-native.js';

async function first(f:Awaited<ReturnType<typeof nativeResumeFixture>>,interrupted=false){const pending=f.controls.execute('contact'),s=await until(async()=> (await f.controls.state())[0] as any,s=>s.nativeControl?.currentTurnActive===true);await f.controls.controlNative('contact',{option:interrupted?'interrupt-current':'check-counterexample',threadId:s.nativeControl.threadId,sessionId:s.nativeControl.sessionId,turnId:s.nativeControl.turnId});const returned=await pending;if(interrupted)await f.controls.closeInterrupted('contact');return {...s,run:(returned.execution as any).run};}
function followup(f:Awaited<ReturnType<typeof nativeResumeFixture>>,source:any,id='explicit-resume'):TaskOwnerRequest{return {...f.request,id,question:'沿准确的原会话核对已保留报告及固定代码反例。',nativeResume:f.q.messages().nativeResumeReference(source.run,f.request.participant.id,f.request.id),nativeControls:f.request.nativeControls!.map(c=>({...c,messageId:id}))};}
async function execute(f:Awaited<ReturnType<typeof nativeResumeFixture>>,request:TaskOwnerRequest){f.q.taskInbox().enqueue(Buffer.from(canonical(request)));const selected=await prepareTaskOwner(f.store,f.task,request.id);let handle:MessageNativeHandle|null=null;const pending=runMessages(f.store,selected.plan,false,selected.run,undefined,(_id,h)=>{handle=h;});return {selected,pending,handle:()=>handle};}

test('a new explicit owner input resumes the exact ended native thread, keeps prior files, and repeats without another input',async t=>{
  const f=await nativeResumeFixture(t),original=await first(f),old=f.q.messages().status(original.run),path=join(old.runtimes[0]!.started.directory,'native','stdout.ndjson'),bytes=await readFile(path),next=followup(f,original),work=await execute(f,next),s=await until(async()=>work.handle()?.state(),s=>s?.currentTurnActive===true);
  assert.ok(s);
  assert.equal(s.sessionId,original.nativeControl.sessionId);assert.equal(s.threadId,original.nativeControl.threadId);assert.notEqual(s.turnId,original.nativeControl.turnId);assert.equal(s.nativeSessionResumed,true);
  await work.handle()!.control('check-counterexample',{threadId:s.threadId,sessionId:s.sessionId,turnId:s.turnId});const result=await work.pending;assert.equal(result.completed,true,JSON.stringify(result.problems));assert.equal(f.q.taskInbox().status(f.task)[1]!.nativeSessionResumed,true);assert.deepEqual(await readFile(path),bytes);
  const calls=await f.calls();assert.equal(calls.filter(c=>c.kind==='start').length,1);assert.equal(calls.filter(c=>c.kind==='resume').length,1);assert.equal(calls.filter(c=>c.kind==='input').length,2);
  const again=await runMessages(f.store,work.selected.plan,false,work.selected.run);assert.equal(again.completed,true);assert.equal(again.newModelRequests,0);assert.deepEqual(await f.calls(),calls);
  for(const [name,ref] of Object.entries(old.runtimes[0]!.ended.originals) as Array<[string,{sha256:string;bytes:number}]>){const kept=await readFile(join(old.runtimes[0]!.started.directory,name));assert.equal(hash(kept),ref.sha256);assert.equal(kept.length,ref.bytes);}
});

test('confirmed interruption may be resumed explicitly, without relabeling its old incomplete report',async t=>{
  const f=await nativeResumeFixture(t),original=await first(f,true),next=followup(f,original),work=await execute(f,next),s=await until(async()=>work.handle()?.state(),s=>s?.currentTurnActive===true);
  assert.ok(s);
  assert.equal(s.sessionId,original.nativeControl.sessionId);await work.handle()!.control('check-counterexample',{threadId:s.threadId,sessionId:s.sessionId,turnId:s.turnId});const result=await work.pending;assert.equal(result.completed,true,JSON.stringify(result.problems));assert.equal(f.q.messages().status(original.run).messages[0]!.state,'Interrupted');assert.equal(f.q.taskInbox().status(f.task)[0]!.phase,'interrupted_closed');
});

test('wrong capture reference, changed source files and corrupt original frames cannot start a resumed input',async t=>{
  const f=await nativeResumeFixture(t),original=await first(f),next=followup(f,original),old=f.q.messages().status(original.run),path=join(old.runtimes[0]!.started.directory,'native','stdout.ndjson'),bytes=await readFile(path);
  next.nativeResume!.captureSha256='f'.repeat(64);const wrong=await execute(f,next);const rejected=await wrong.pending;assert.equal(rejected.completed,false);assert.ok(rejected.problems.some((p:any)=>p.reason==='native_resume_scope_or_capture_changed'));assert.equal((await f.calls()).filter(c=>c.kind==='resume').length,0);
  // A different caller ID is a new requested input, never replacement of the
  // old one. Close only its proven never-started original pending request.
  f.q.taskInbox().cancelUnsent(f.task,next.id,'explicit invalid reference cancelled');
  const repaired=followup(f,original,'correct-reference');await writeFile(path,bytes.subarray(0,bytes.length-1));const corrupted=await execute(f,repaired);const fail=await corrupted.pending;assert.equal(fail.completed,false);assert.equal((await f.calls()).filter(c=>c.kind==='resume').length,0);await writeFile(path,bytes);
  const source=join(f.definition.workspace,'sample.js'),originalSource=await readFile(source);await writeFile(source,'export const changed=99;\n');const stale=await runMessages(f.store,corrupted.selected.plan,false,corrupted.selected.run);assert.equal(stale.completed,false);assert.equal((await f.calls()).filter(c=>c.kind==='resume').length,0);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);await writeFile(source,originalSource);
});

test('changed actual native history stays a zero-input failure and may retry only after the exact history is restored',async t=>{
  const f=await nativeResumeFixture(t),original=await first(f),next=followup(f,original),history=await readFile(f.history),changed=JSON.parse(history.toString());changed[original.nativeControl.threadId].turns.push({id:'unobserved-external-turn',status:'completed'});await writeFile(f.history,canonical(changed));
  const firstAttempt=await execute(f,next),failed=await firstAttempt.pending;assert.equal(failed.completed,false);assert.ok(failed.problems.some((p:any)=>p.reason==='native_resume_history_changed_or_active'));assert.equal(failed.runtimes[0]!.ended.proof.knownUnstarted,true);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);
  await writeFile(f.history,history);let handle:MessageNativeHandle|null=null;const pending=runMessages(f.store,firstAttempt.selected.plan,false,firstAttempt.selected.run,undefined,(_p,h)=>{handle=h;}),s=await until(async()=>handle?.state(),s=>s?.currentTurnActive===true);assert.ok(s);assert.equal(s.sessionId,original.nativeControl.sessionId);await handle!.control('check-counterexample',{threadId:s.threadId,sessionId:s.sessionId,turnId:s.turnId});const result=await pending;assert.equal(result.completed,true,JSON.stringify(result.problems));assert.equal(result.runtimes[0]!.attempt,2);assert.equal((await f.calls()).filter(c=>c.kind==='start').length,1);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,2);
});

test('NR-F01: resume and read must agree on session, workspace and root identity before a new input',async t=>{
  const f=await nativeResumeFixture(t),original=await first(f);
  for(const [id,override] of Object.entries({session:{sessionId:'another-session'},workspace:{cwd:'/other-workspace'},fork:{forkedFromId:'another-thread'}})){
    await writeFile(f.readOverride,canonical(override));const next=followup(f,original,'wrong-'+id),work=await execute(f,next),result=await work.pending;
    assert.equal(result.completed,false);assert.ok(result.problems.some((p:any)=>p.reason==='native_resume_history_changed_or_active'));assert.equal(result.runtimes[0]!.ended.proof.knownUnstarted,true);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);
    f.q.taskInbox().cancelUnsent(f.task,next.id,'explicit zero-input contradictory fixture request cancelled');
  }
});

test('NR-F01: a hash-consistent fixture transcript with contradictory read identity is rejected during replay',async t=>{
  const f=await nativeResumeFixture(t),original=await first(f),next=followup(f,original),work=await execute(f,next),s=await until(async()=>work.handle()?.state(),s=>s?.currentTurnActive===true);assert.ok(s);
  await work.handle()!.control('check-counterexample',{threadId:s.threadId,sessionId:s.sessionId,turnId:s.turnId});const result=await work.pending;assert.equal(result.completed,true);
  const directory=join(result.runtimes[0]!.started.directory,'native'),stdout=await readFile(join(directory,'stdout.ndjson')),history=await readFile(join(directory,'resume-history.json')),status=await readFile(join(directory,'capture-status.json')),requests=(await readFile(join(directory,'stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x)),id=requests.find(x=>x.method==='thread/read').id;
  // Alter only this synthetic fixture, including its declared checksums: file
  // integrity alone must not conceal contradictory native identity.
  const lines=stdout.toString().trim().split('\n').map(x=>JSON.parse(x)),changed=JSON.parse(history.toString());changed.thread.sessionId='contradictory-saved-session';lines.find(x=>x.id===id&&!x.method).result=changed;const altered=Buffer.from(lines.map(x=>JSON.stringify(x)).join('\n')+'\n'),capture=JSON.parse(status.toString());capture.files['stdout.ndjson']=hash(altered);
  await writeFile(join(directory,'stdout.ndjson'),altered);await writeFile(join(directory,'resume-history.json'),canonical(changed));await writeFile(join(directory,'capture-status.json'),canonical(capture));
  await assert.rejects(readOwnedCodexSession(directory),/native_original_resume_history_changed/);
  await writeFile(join(directory,'stdout.ndjson'),stdout);await writeFile(join(directory,'resume-history.json'),history);await writeFile(join(directory,'capture-status.json'),status);assert.equal((await readOwnedCodexSession(directory)).binding.sessionId,original.nativeControl.sessionId);
});

test('the selected workbench contact resumes the original session; a second controller and old turn cannot send',async t=>{
  const f=await nativeResumeFixture(t),original=await first(f),next=followup(f,original);Object.assign(f.request,next);f.controls=await f.reload();
  const app=await startWorkbench(f.planPath);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json',Origin:u.origin},post=(action:string,body:any={})=>fetch(u.origin+'/api/task-control/contact/'+action,{method:'POST',headers,body:JSON.stringify(body)}),state=async()=>((await (await fetch(u.origin+'/api/state',{headers})).json()) as any).taskControls[0];
  assert.equal((await state()).nativeResumeRequested.run,original.run);assert.equal((await post('start')).status,202);const s=await until(state,s=>s.nativeControl?.currentTurnActive===true);assert.equal(s.nativeControl.sessionId,original.nativeControl.sessionId);assert.equal(s.nativeSessionResumed,true);
  const competing=await f.controls.execute('contact');assert.equal((competing.execution as any).completed,false);assert.equal((competing.execution as any).reason,'message_controller_active');
  assert.equal((await post('native',{option:'check-counterexample',threadId:s.nativeControl.threadId,sessionId:s.nativeControl.sessionId,turnId:original.nativeControl.turnId})).status,503);assert.equal((await f.calls()).filter(c=>c.kind==='control').length,1);
  assert.equal((await post('native',{option:'check-counterexample',threadId:s.nativeControl.threadId,sessionId:s.nativeControl.sessionId,turnId:s.nativeControl.turnId})).status,200);const done=await until(state,s=>s.phase==='returned'),report=await (await fetch(u.origin+'/api/message-report/task/'+done.run+'/'+next.id,{headers})).json() as any;assert.equal(report.nativeSessionResumed,true);assert.equal(report.sessionId,original.nativeControl.sessionId);assert.equal(report.resumedFrom.run,original.run);assert.equal(report.completeCapture,true);
  await post('start');await until(state,s=>!s.controllerActive);assert.equal((await f.calls()).filter(c=>c.kind==='start').length,1);assert.equal((await f.calls()).filter(c=>c.kind==='resume').length,1);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,2);
});

test('resuming needs a fresh exact action and original resources; revocation still allows accurate interruption cleanup',async t=>{
  const f=await nativeResumeFixture(t),ledger=await ledgerFixture(t),db=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));db.exec('UPDATE capacity SET n=2');db.close();const spec=ledger.profile.resources[0]!;
  f.request.authorityIntent='bounded-messages';f.request.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];f.controls=await f.reload();f.q.taskInbox().enqueue(Buffer.from(canonical(f.request)));const initial=await prepareTaskOwner(f.store,f.task,f.request.id),plan=JSON.parse(await readFile(initial.plan,'utf8')),authority=await messageAuthority({...f,item:f.task,plan,write:async()=>writeFile(initial.plan,canonical(plan))});f.q.resources().configure(Buffer.from(canonical(ledger.profile)));
  const original=await first(f),next=followup(f,original);next.authorityIntent='bounded-native-resume';f.q.taskInbox().enqueue(Buffer.from(canonical(next)));const selected=await prepareTaskOwner(f.store,f.task,next.id),action={...authority.request,payloadSha256:selected.run},confirmed=await authority.adopt({kind:'confirm_action',adoption:authority.scope.sha,performerRole:'coordinator',request:action,expiresAt:new Date(Date.now()+3600000).toISOString()}),freshScope=await readOwnerSource(authority.a.configuration().profile,authority.scope.sha,authority.scope.id,join(f.root,'resume-scope-observation'));authority.a.reserveAction(next.authorityIntent,action,'coordinator',confirmed.sha,[freshScope,confirmed.observation]);
  const old=f.q.messages().status(original.run),capture=join(old.runtimes[0]!.started.directory,'native','stdout.ndjson'),bytes=await readFile(capture);await writeFile(capture,bytes.subarray(0,bytes.length-1));const damaged=await runMessages(f.store,selected.plan,false,selected.run);assert.equal(damaged.completed,false);assert.equal(ledger.state().claims.length,1,'local original verification must precede a new resource claim');await writeFile(capture,bytes);
  let handle:MessageNativeHandle|null=null;const observation:{ended:any}={ended:null};const pending=runMessages(f.store,selected.plan,false,selected.run,undefined,(_p,h)=>{handle=h;}).then(r=>{observation.ended=r;return r;}),s=await until(async()=>{
    if(observation.ended){if(process.env.TONGXU_RESUME_TEST_EVIDENCE){const root=join(process.env.TONGXU_RESUME_TEST_EVIDENCE,selected.run);await mkdir(root,{recursive:true});await writeFile(join(root,'result.json'),JSON.stringify(observation.ended,null,2));await cp(f.root,join(root,'queue'),{recursive:true});await cp(ledger.root,join(root,'ledger'),{recursive:true});}throw new Error('resume_returned_before_active:'+JSON.stringify(observation.ended.problems));}return handle?.state();
  },s=>s?.currentTurnActive===true);assert.ok(s);assert.equal(s.sessionId,original.nativeControl.sessionId);await authority.adopt({kind:'revoke',decision:confirmed.sha});
  await assert.rejects(handle!.control('check-counterexample',{threadId:s.threadId,sessionId:s.sessionId,turnId:s.turnId}),/revoked/);await handle!.control('interrupt-current',{threadId:s.threadId,sessionId:s.sessionId,turnId:s.turnId});const result=await pending;assert.equal(result.completed,false);assert.equal(result.resourcesSettled,true);assert.equal(ledger.state().claims.length,2);assert.equal(ledger.state().settlements.length,2);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,2);assert.equal(f.q.messages().status(original.run).messages[0]!.state,'Reply');
});
