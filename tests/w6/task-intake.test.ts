import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {exists} from '../../src/repair-workspace.js';
import {QueueStore} from '../../src/queue-store.js';
import {messageFixture} from './message-fixture.js';
import {parseDevelopmentTask,type DevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {canonical} from '../../src/comparison.js';
import {prepareTaskOwner,workTaskOwner,runTaskContact} from '../../src/tasks.js';
import {type TaskOwnerRequest} from '../../src/task-inbox.js';
import {runMessages} from '../../src/messages.js';
import {taskMain} from '../../src/task-cli.js';
import {workbenchState} from '../../src/workbench.js';
import {observeTask} from '../../src/secretary-tools.js';
import {assembleRolePrompt} from '../../src/role-prompts.js';
import {messagePolicy} from '../../src/message-runtime.js';
import {hash} from '../../src/snapshot.js';
import {messagePlanId} from '../../src/message-contract.js';
import {messageAuthority} from './message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';

const raw=(v:unknown)=>Buffer.from(canonical(v));
async function fixture(t:test.TestContext,mode='complete'){
  const f=await messageFixture(t,mode);await taskMain(['enable','--store',f.store]);
  const original=f.q.status().items.find((i:any)=>i.id===f.item),definition:DevelopmentTask=parseDevelopmentTask(raw({schemaVersion:1,kind:'tongxu-development-task',id:'task-a',repository:'fixture/reception',title:'尚无 PR 的任务 A',goal:'核对实际选定代码与常量契约',acceptance:['指出实际值并说明是否满足契约'],source:'explicit local test fixture',issue:null,context:original.context,workspace:join(f.root,'objects'),base:original.candidate.B,target:original.candidate.targetRef,paths:['sample.js']}));
  const a=f.q.tasks().observe(definition,await observeTaskWorkspace(definition));
  const request=(id:string,task=a.item):TaskOwnerRequest=>({schemaVersion:1,kind:'tongxu-task-owner-request',id,task,source:'explicit fixture no-PR task inquiry',question:'核对选定文件和完整前序报告；不要把报告当成写入权限。',from:null,participant:{...f.plan.participants[0]!,id:'owner',item:task,role:'issue_owner',parent:null},executionKind:'fixture',authorityIntent:null,billing:f.plan.billing,timeoutMs:500});
  return {...f,definition,a,request};
}
async function waitInput(f:Awaited<ReturnType<typeof fixture>>){const end=Date.now()+4000;while(Date.now()<end){if((await f.calls()).some(c=>c.kind==='input'))return;await new Promise(r=>setTimeout(r,10));}throw new Error('fixture_input_not_observed');}

test('no PR: actual dirty bytes, stable task identity, retained old packet, no invented verification',async t=>{
  const f=await fixture(t);await writeFile(join(f.definition.workspace,'sample.js'),'// actual uncommitted test material\nexport const value=7;\n');
  const changed=f.q.tasks().observe(f.definition,await observeTaskWorkspace(f.definition)),duplicate=f.q.tasks().observe(f.definition,await observeTaskWorkspace(f.definition));assert.equal(changed.item,f.a.item);assert.notEqual(changed.packet,f.a.packet);assert.equal(duplicate.duplicate,true);
  const s=f.q.tasks().current(f.a.item);assert.equal(s.manifest.candidate.pr,null);assert.equal(s.manifest.candidate.H,f.H);assert.match(s.report.files[0]!.text!,/value=7/);assert.notEqual(s.report.files[0]!.sha256,s.report.headFiles![0]!.sha256);assert.equal(s.report.indexObserved,false);assert.equal(s.report.testsExecuted,false);assert.equal(s.report.branch,'fixture');assert.equal(f.q.tasks().status(f.a.item).history.length,2);
  const op=f.q.begin(f.a.item,'task-investigation'),result=f.q.evaluate(op.operation);assert.equal(result.evidenceComplete,false);assert.equal(result.productionActionAllowed,false);assert.throws(()=>f.q.receiverEvidence(op.operation),/development_task_requires_formal_candidate/);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{assert.throws(()=>db.prepare("UPDATE operations SET status='repairing' WHERE id=?").run(op.operation),/development_task_requires_formal_candidate|repair/);}finally{db.close();}
  assert.throws(()=>f.q.tasks().observe({...f.definition,title:'changed goal'},s.report),/actual_task_workspace_observation_required|task_definition_is_fixed/);
  assert.throws(()=>f.q.tasks().observe(f.definition,JSON.parse(canonical(s.report))),/actual_task_workspace_observation_required/);
});

test('one worker consumes requests arriving during a real child turn, retaining exact original report in new context',async t=>{
  const f=await fixture(t,'delay');f.q.taskInbox().enqueue(raw(f.request('first')));const work=workTaskOwner(f.store,f.a.item,3);await waitInput(f);
  f.q.taskInbox().enqueue(raw(f.request('followup')));assert.throws(()=>f.q.taskInbox().prepare(f.a.item,'followup'),/task_original_responsibility_pending/);
  const result=await work;assert.equal(result.newModelRequests,2);assert.equal(result.pending.length,0);const states=f.q.taskInbox().status(f.a.item);assert.deepEqual(states.map(x=>x.phase),['returned','returned']);assert.notEqual(states[0]!.sessionId,states[1]!.sessionId);
  const first=f.q.messages().status(states[0]!.run).messages[0]!.reply,second=f.q.messages().submitted(states[1]!.run,'owner')[0]!,context=JSON.parse(second.material[0].text);
  assert.equal(context.previousExecutions[0].reports[0].receipt.finalText,first.finalText);assert.equal(context.nativeSessionResumed,false);assert.equal(context.task.candidate.pr,null);assert.equal(second.permissions.write,false);
  const repeated=await workTaskOwner(f.store,f.a.item,3);assert.equal(repeated.newModelRequests,0);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,2);
});

test('accurate contact consumes sender capture, refuses invented sender and stale sender material',async t=>{
  const f=await fixture(t),bp={...f.definition,id:'task-b',title:'另一任务'},b=f.q.tasks().observe(bp,await observeTaskWorkspace(bp));
  f.q.taskInbox().enqueue(raw(f.request('b-check',b.item)));await workTaskOwner(f.store,b.item,1);const source=f.q.taskInbox().status(b.item)[0]!;
  const contact={...f.request('contact'),from:{task:b.item,run:source.run,messageId:'b-check'}};f.q.taskInbox().enqueue(raw(contact));await workTaskOwner(f.store,f.a.item,1);const target=f.q.taskInbox().status(f.a.item)[0]!,context=JSON.parse(f.q.messages().submitted(target.run,'owner')[0]!.material[0].text);
  assert.equal(context.sender.reply.finalText,f.q.messages().status(source.run).messages[0]!.reply.finalText);
  assert.throws(()=>f.q.taskInbox().enqueue(raw({...contact,id:'fake',from:{...contact.from,messageId:'not-real'}})),/task_contact_requires_current_captured_sender/);
  f.q.taskInbox().enqueue(raw({...contact,id:'later'}));await writeFile(join(bp.workspace,'sample.js'),'export const value=9;\n');f.q.tasks().observe(bp,await observeTaskWorkspace(bp));const held=await workTaskOwner(f.store,f.a.item,1);assert.equal(held.newModelRequests,0);assert.equal(held.pending[0]?.reason,'task_contact_requires_current_captured_sender');
});

test('source refresh before dispatch prevents stale prepared material and preserves its queued operation',async t=>{
  const f=await fixture(t);f.q.taskInbox().enqueue(raw(f.request('check')));const selected=await prepareTaskOwner(f.store,f.a.item,'check');await writeFile(join(f.definition.workspace,'sample.js'),'export const changed=99;\n');
  const result=await runMessages(f.store,selected.plan);assert.equal(result.completed,false);assert.equal(result.newModelRequests,0);assert.equal((await f.calls()).filter(x=>x.kind==='runtime').length,0);assert.equal(f.q.taskInbox().status(f.a.item)[0]?.phase,'waiting');assert.notEqual(f.q.tasks().current(f.a.item).packet,f.a.packet);
});

test('unknown previous input cannot be resent or bypassed with a fresh request id',async t=>{
  const f=await fixture(t,'hang');f.q.taskInbox().enqueue(raw(f.request('first')));const result=await workTaskOwner(f.store,f.a.item,1);assert.equal(result.newModelRequests,1);assert.equal(result.runs[0]?.completed,false);
  assert.throws(()=>f.q.taskInbox().cancelUnsent(f.a.item,'first','cannot erase an unknown send'),/task_original_execution_active_or_unknown/);f.q.taskInbox().enqueue(raw(f.request('second')));assert.throws(()=>f.q.taskInbox().prepare(f.a.item,'second'),/task_original_responsibility_pending/);const replay=await workTaskOwner(f.store,f.a.item,2);assert.equal(replay.newModelRequests,0);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
});

test('raw message entry cannot impersonate an owner outside its registered task dispatch',async t=>{
  const f=await fixture(t),r=f.request('forged'),material=f.q.tasks().context(f.a.item),path=join(f.root,'forged-context.json');await writeFile(path,material);const plan={...f.plan,participants:[r.participant],messages:[{id:'forged',from:null,to:'owner',body:'arbitrary bypass',replies:[]}],material:[{name:'task-owner-context.json',path,sha256:hash(material)}],consumeMaterial:['task-owner-context.json']};const p=join(f.root,'forged.json');await writeFile(p,canonical(plan));
  const result=await runMessages(f.store,p);assert.equal(result.newModelRequests,0);assert.equal(result.completed,false);assert.equal((await f.calls()).length,0);
});

test('task B may be admitted while task A is active, without acquiring A responsibility',async t=>{
  const f=await fixture(t,'delay');f.q.taskInbox().enqueue(raw(f.request('a')));const active=workTaskOwner(f.store,f.a.item,1);await waitInput(f);
  const bp={...f.definition,id:'task-b'},b=f.q.tasks().observe(bp,await observeTaskWorkspace(bp));f.q.taskInbox().enqueue(raw(f.request('b',b.item)));const independent=await workTaskOwner(f.store,b.item,1);assert.equal(independent.runs[0]?.completed,true);assert.equal((await active).runs[0]?.completed,true);assert.notEqual(f.q.taskInbox().status(b.item)[0]!.sessionId,f.q.taskInbox().status(f.a.item)[0]!.sessionId);
});

test('investment stop applies to no-PR worker and another name cannot change its frozen actor',async t=>{
  const f=await fixture(t);f.q.taskInbox().enqueue(raw(f.request('first')));assert.throws(()=>f.q.taskInbox().enqueue(raw({...f.request('second'),participant:{...f.request('second').participant,id:'different-owner'}})),/task_original_responsibility_is_fixed/);
  f.q.control(f.definition.context.scope.id,'investment','stopped','explicit fixture pause');const r=await workTaskOwner(f.store,f.a.item,1);assert.equal(r.newModelRequests,0);assert.equal((await f.calls()).length,0);
});

test('same-source workbench and secretary retain explicit no-PR identity without workspace disclosure',async t=>{
  const f=await fixture(t);f.q.taskInbox().enqueue(raw(f.request('first')));await workTaskOwner(f.store,f.a.item,1);
  const state=await workbenchState({schemaVersion:1,kind:'tongxu-local-workbench',title:'任务',goal:'读取原队列',sources:[{id:'a',title:'A',store:f.store,item:f.a.item}]}),task=state.tasks[0]!;assert.equal(task.available,true);assert.equal(task.candidate.pr,null);assert.equal(task.developmentTask.inbox[0].phase,'returned');assert.equal(JSON.stringify(state).includes(f.definition.workspace),false);
  const c=f.q.tasks().current(f.a.item).manifest.candidate,secretary=await observeTask(f.store,f.a.item,{repository:c.repository,kind:'development-task',taskId:c.taskId,sourceSha256:c.sourceSha256,pr:null,H:c.H,B:c.B,target:c.targetRef});assert.equal(secretary.developmentTask.inbox[0].phase,'returned');assert.equal(secretary.evidenceComplete,false);
  await assert.rejects(observeTask(f.store,f.a.item,{repository:c.repository,kind:'development-task',taskId:c.taskId,sourceSha256:'f'.repeat(64),pr:null,H:c.H,B:c.B,target:c.targetRef}),/candidate_mismatch/);
});

test('format opt-in preserves existing data, refuses active claims, and rejects links outside selected files',async t=>{
  const f=await messageFixture(t);f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();const later=await f.packet({pr:3}),op=f.q.begin(later.item,'unfinished');assert.throws(()=>f.q.enableTasks(),/active_or_unknown_operation/);f.q.evaluate(op.operation);assert.equal(f.q.enableTasks().schemaVersion,15);assert.equal(f.q.status().items.length,2);
  const item=f.q.status().items[0],p=parseDevelopmentTask(raw({schemaVersion:1,kind:'tongxu-development-task',id:'linked',repository:'fixture/reception',title:'link test',goal:'check one path',acceptance:['read no link'],source:'fixture',issue:null,context:item.context,workspace:join(f.root,'objects'),base:item.candidate.B,target:item.candidate.targetRef,paths:['link.js']}));await symlink(join(f.root,'message-material.txt'),join(p.workspace,'link.js'));await assert.rejects(observeTaskWorkspace(p),/regular|canonical|file|link/);
});

test('explicit unsent cancellation allows fresh work after source change, preserving the cancelled preparation',async t=>{
  const f=await fixture(t);f.q.taskInbox().enqueue(raw(f.request('old')));const old=await prepareTaskOwner(f.store,f.a.item,'old');await writeFile(join(f.definition.workspace,'sample.js'),'export const value=23;\n');f.q.tasks().observe(f.definition,await observeTaskWorkspace(f.definition));
  f.q.taskInbox().cancelUnsent(f.a.item,'old','Fixture operator explicitly withdraws the never-sent stale inquiry');f.q.taskInbox().enqueue(raw(f.request('new')));const next=await workTaskOwner(f.store,f.a.item,2);assert.equal(next.newModelRequests,1);assert.deepEqual(f.q.taskInbox().status(f.a.item).map(x=>x.phase),['cancelled','returned']);
  const stale=await runMessages(f.store,old.plan);assert.equal(stale.newModelRequests,0);assert.equal(stale.completed,false);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(JSON.parse(await readFile(old.plan,'utf8')).messages[0].id,'old');
});

test('no-PR task uses original authority and resource consumer, and migration is not downgraded',async t=>{
  const f=await fixture(t),ledger=await ledgerFixture(t),spec=ledger.profile.resources[0]!,request={...f.request('governed'),authorityIntent:'bounded-messages',resourceBudget:[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}]};
  f.q.taskInbox().enqueue(raw(request));const selected=await prepareTaskOwner(f.store,f.a.item,'governed'),plan=JSON.parse(await readFile(selected.plan,'utf8'));
  await messageAuthority({...f,item:f.a.item,plan,write:async()=>writeFile(selected.plan,canonical(plan))});f.q.resources().configure(raw(ledger.profile));assert.equal(f.q.status().schemaVersion,15);
  const work=await workTaskOwner(f.store,f.a.item,1);assert.equal(work.runs[0]?.completed,true);assert.equal(work.runs[0]?.resourcesSettled,true);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);assert.equal(f.q.taskInbox().status(f.a.item)[0]?.phase,'returned');
  assert.throws(()=>f.q.taskInbox().cancelUnsent(f.a.item,'governed','fixture cancel'),/resource_investment/);assert.equal((await workTaskOwner(f.store,f.a.item,1)).newModelRequests,0);assert.equal(ledger.state().claims.length,1);
});

test('literal selected paths do not expand Git patterns into unrelated material',async t=>{
  const f=await fixture(t),p={...f.definition,id:'literal',paths:['*.js']};await writeFile(join(p.workspace,'sample.js'),'PRIVATE_UNSELECTED\n');const o=await observeTaskWorkspace(p);assert.equal(o.files[0]?.missing,true);assert.equal(o.headFiles![0]!.missing,true);assert.equal(o.diff,undefined);assert.equal(o.gitStatus,undefined);assert.equal(canonical(o).includes('PRIVATE_UNSELECTED'),false);
});

test('one fixed contact entry delivers A to B and returns B to A without copied reports; repetition has no new sends',async t=>{
  const f=await fixture(t),bp={...f.definition,id:'task-b'},b=f.q.tasks().observe(bp,await observeTaskWorkspace(bp)),contact=f.request('b-contact',b.item);contact.participant={...contact.participant,tool:'claude',executable:f.claude};
  const path=join(f.root,'contact-flow.json');await writeFile(path,canonical({schemaVersion:1,kind:'tongxu-task-owner-contact',initial:f.request('initial'),contact,followup:f.request('synthesis')}));
  const result=await runTaskContact(f.store,path);assert.equal(result.completed,true);assert.equal(result.newModelRequests,3);
  const second=f.q.messages().submitted(result.steps[1]!.run,'owner')[0]!,last=f.q.messages().submitted(result.steps[2]!.run,'owner')[0]!,context=JSON.parse(last.material[0].text);assert.equal(JSON.parse(second.material[0].text).sender.run,result.steps[0]!.run);assert.equal(context.sender.run,result.steps[1]!.run);assert.equal(context.previousExecutions[0].run,result.steps[0]!.run);
  const repeated=await runTaskContact(f.store,path);assert.equal(repeated.completed,true);assert.equal(repeated.newModelRequests,0);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,3);
});

test('NT-F01: raw-file observation never invokes configured clean or process filters',async t=>{
  const f=await fixture(t),marker=join(f.root,'filter-ran'),exe=join(f.root,'filter.mjs');await writeFile(exe,`#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'ran');process.stdin.pipe(process.stdout);\n`,{mode:0o700});
  for(const key of ['clean','process'])execFileSync('/usr/bin/git',['-C',f.definition.workspace,'config','filter.taskprobe.'+key,exe]);await writeFile(join(f.definition.workspace,'.gitattributes'),'sample.js filter=taskprobe\n');await writeFile(join(f.definition.workspace,'sample.js'),'export const raw=41;\n');
  const observed=await observeTaskWorkspace(f.definition);assert.equal(observed.schemaVersion,2);assert.equal(await exists(marker),false);assert.match(observed.files[0]!.text!,/raw=41/);assert.notEqual(observed.headFiles![0]!.sha256,observed.files[0]!.sha256);assert.equal(observed.commands.some(c=>c.argv.includes('status')||c.argv.includes('diff')),false);
});

test('NT-F02: changed sender files block the contact without a separate manual observation',async t=>{
  const f=await fixture(t);f.q.taskInbox().enqueue(raw(f.request('a')));await workTaskOwner(f.store,f.a.item,1);const source=f.q.taskInbox().status(f.a.item)[0]!;await writeFile(join(f.definition.workspace,'b.js'),'export const b=1;\n');
  const bp={...f.definition,id:'b',paths:['b.js']},b=f.q.tasks().observe(bp,await observeTaskWorkspace(bp)),request={...f.request('b',b.item),from:{task:f.a.item,run:source.run,messageId:'a'}};f.q.taskInbox().enqueue(raw(request));await writeFile(join(f.definition.workspace,'sample.js'),'export const changedAfterA=1;\n');
  const result=await workTaskOwner(f.store,b.item,1);assert.equal(result.newModelRequests,0);assert.equal(result.runs[0]?.completed,false);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);assert.notEqual(f.q.tasks().current(f.a.item).packet,f.a.packet);
});

test('NT-F03: cancellation after admission but before resource binding prevents every provider claim',async t=>{
  const f=await fixture(t),ledger=await ledgerFixture(t),spec=ledger.profile.resources[0]!,request={...f.request('governed'),authorityIntent:'bounded-messages',resourceBudget:[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}]};f.q.taskInbox().enqueue(raw(request));const selected=await prepareTaskOwner(f.store,f.a.item,'governed'),plan=JSON.parse(await readFile(selected.plan,'utf8'));
  await messageAuthority({...f,item:f.a.item,plan,write:async()=>writeFile(selected.plan,canonical(plan))});f.q.resources().configure(raw(ledger.profile));
  const original=QueueStore.prototype.begin;let cancelled=false;QueueStore.prototype.begin=function(item,run){const result=original.call(this,item,run);if(item===f.a.item&&!cancelled){cancelled=true;f.q.taskInbox().cancelUnsent(item,'governed','explicit fixture cancellation at committed transaction boundary');}return result;};
  try{const result=await runMessages(f.store,selected.plan);assert.equal(result.newModelRequests,0);assert.equal(result.completed,false);assert.equal(cancelled,true);assert.equal(ledger.state().claims.length,0);assert.equal((await f.calls()).length,0);assert.equal(f.q.taskInbox().status(f.a.item)[0]!.phase,'cancelled');}finally{QueueStore.prototype.begin=original;}
});

test('native-impact BOM counterexample: HEAD and working file retain the exact UTF-8 bytes',async t=>{
  const f=await fixture(t),bytes=Buffer.from('\ufeffexport const bom=1;\n');await writeFile(join(f.definition.workspace,'sample.js'),bytes);const git=(args:string[])=>execFileSync('/usr/bin/git',['-C',f.definition.workspace,...args]);git(['add','sample.js']);git(['-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','explicit BOM fixture']);
  const observed=await observeTaskWorkspace(f.definition);assert.equal(observed.files[0]!.sha256,hash(bytes));assert.equal(observed.headFiles![0]!.sha256,hash(bytes));assert.deepEqual(Buffer.from(observed.files[0]!.text!),bytes);assert.deepEqual(Buffer.from(observed.headFiles![0]!.text!),bytes);assert.doesNotThrow(()=>f.q.tasks().observe(f.definition,observed));
  const plain=Buffer.from('export const bom=1;\n');await writeFile(join(f.definition.workspace,'sample.js'),plain);const onlyHead=await observeTaskWorkspace(f.definition);assert.equal(onlyHead.headFiles![0]!.sha256,hash(bytes));assert.equal(onlyHead.files[0]!.sha256,hash(plain));assert.notEqual(onlyHead.headFiles![0]!.sha256,onlyHead.files[0]!.sha256);assert.doesNotThrow(()=>f.q.tasks().observe(f.definition,onlyHead));
  git(['add','sample.js']);git(['-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','plain HEAD fixture']);await writeFile(join(f.definition.workspace,'sample.js'),bytes);const onlyWorking=await observeTaskWorkspace(f.definition);assert.equal(onlyWorking.headFiles![0]!.sha256,hash(plain));assert.equal(onlyWorking.files[0]!.sha256,hash(bytes));assert.doesNotThrow(()=>f.q.tasks().observe(f.definition,onlyWorking));
});

test('native-impact dangling-link counterexample: an existing broken link is not a missing file',async t=>{
  const f=await fixture(t),p={...f.definition,id:'dangling',paths:['dangling.js']};await symlink(join(f.root,'missing-target'),join(p.workspace,'dangling.js'));await assert.rejects(observeTaskWorkspace(p),/task_selected_symlink/);
  await symlink(join(f.root,'missing-directory'),join(p.workspace,'linked-dir'));await assert.rejects(observeTaskWorkspace({...p,paths:['linked-dir/absent.js']}),/task_selected_symlink/);
});
