import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from './message-fixture.js';
import {taskMain} from '../../src/task-cli.js';
import {parseDevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {workTaskOwner,prepareTaskOwner,linkTaskCandidate,resolveTaskCandidate} from '../../src/tasks.js';
import {runMessages} from '../../src/messages.js';
import {canonical} from '../../src/comparison.js';
import {workbenchState} from '../../src/workbench.js';
import {observeTask} from '../../src/secretary-tools.js';
import {exists} from '../../src/repair-workspace.js';
import type {TaskOwnerRequest} from '../../src/task-inbox.js';
import {messageAuthority} from './message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
const raw=(x:unknown)=>Buffer.from(canonical(x));

async function fixture(t:test.TestContext,mode='complete',links=true){
  const f=await messageFixture(t,mode);await taskMain(['enable','--store',f.store]);if(links)await taskMain(['enable-links','--store',f.store]);const original=f.q.status().items.find((x:any)=>x.id===f.item),p=parseDevelopmentTask(raw({schemaVersion:1,kind:'tongxu-development-task',id:'original-task',repository:'fixture/reception',title:'先于 PR 的原任务',goal:'核对 sample.js 与原要求',acceptance:['实际代码与证据均准确关联'],source:'explicit candidate-link fixture',issue:null,context:original.context,workspace:join(f.root,'objects'),base:original.candidate.B,target:original.candidate.targetRef,paths:['sample.js']}));
  const item=f.q.tasks().observe(p,await observeTaskWorkspace(p)).item,request=(id:string):TaskOwnerRequest=>({schemaVersion:1,kind:'tongxu-task-owner-request',id,task:item,source:'explicit original owner fixture',question:'核对当前任务、候选材料与保留的原报告。',from:null,participant:{...f.plan.participants[0]!,item,id:'owner',role:'issue_owner',parent:null},executionKind:'fixture',authorityIntent:null,billing:f.plan.billing,timeoutMs:500});
  const linkFile=join(f.root,'link.json'),link=async(candidateItem:string)=>{await writeFile(linkFile,raw({schemaVersion:1,kind:'tongxu-task-candidate-link',task:item,candidateItem,source:'explicit association request'}));return linkTaskCandidate(f.store,linkFile);};
  const git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',p.workspace,...args],{encoding:'utf8'}).trim();
  return {...f,p,task:item,request,link,git,linkFile};
}

test('task before PR keeps identity, original owner and exact earlier report while consuming real candidate records',async t=>{
  const f=await fixture(t);f.q.taskInbox().enqueue(raw(f.request('before-pr')));await workTaskOwner(f.store,f.task,1);const before=f.q.taskInbox().status(f.task)[0]!,originalReport=f.q.messages().status(before.run).messages[0]!.reply.finalText,definition=canonical(f.q.tasks().definition(f.task));
  const candidate=await f.packet({pr:7}),linked=await f.link(candidate.item);assert.equal(linked.current,true);assert.equal(linked.pr,7);assert.equal(linked.permissionGranted,false);assert.equal((await f.link(candidate.item)).duplicate,true);assert.equal(f.q.taskLinks().state(f.task).length,1);
  f.q.taskInbox().enqueue(raw(f.request('after-pr')));const next=await workTaskOwner(f.store,f.task,1);assert.equal(next.runs[0]?.completed,true);const input=f.q.messages().submitted(next.runs[0]!.run,'owner')[0]!,context=JSON.parse(input.material[0].text);
  assert.equal(context.candidateAssociation.association.link,linked.link);assert.equal(context.candidateAssociation.originalCandidate.candidate.pr,7);assert.equal(context.candidateAssociation.originalCandidate.verification.kind,'tongxu-verification');assert.equal(context.previousExecutions[0].reports[0].receipt.finalText,originalReport);assert.equal(context.task.item,f.task);assert.equal(context.task.candidate.pr,null);assert.equal(canonical(f.q.tasks().definition(f.task)),definition);assert.equal(f.q.messages().status(before.run).messages[0]!.reply.finalText,originalReport);
  const resolved=await resolveTaskCandidate(f.store,f.task,linked.link);assert.equal(resolved.binding.candidateItem,candidate.item);assert.equal(resolved.material.originalCandidate.packet,linked.candidatePacket);assert.equal(resolved.permissionGranted,false);assert.equal((await workTaskOwner(f.store,f.task,1)).newModelRequests,0);
});

test('dirty selected bytes, staged-only content and executable mode cannot be hidden behind an unchanged HEAD',async t=>{
  const f=await fixture(t),linked=await f.link(f.item),head=f.git(['rev-parse','HEAD']),original=await readFile(join(f.p.workspace,'sample.js'));
  await writeFile(join(f.p.workspace,'sample.js'),'export const changed=10;\n');await assert.rejects(f.link(f.item),/task_link_uncommitted_selected_content/);assert.equal(f.q.taskLinks().state(f.task)[0]!.current,false);await writeFile(join(f.p.workspace,'sample.js'),original);const restored=await f.link(f.item);assert.notEqual(restored.link,linked.link);assert.equal(restored.current,true);
  await writeFile(join(f.p.workspace,'sample.js'),'export const staged=77;\n');f.git(['add','sample.js']);await writeFile(join(f.p.workspace,'sample.js'),original);await assert.rejects(resolveTaskCandidate(f.store,f.task,restored.link),/task_candidate_link_no_longer_current/);assert.equal(f.q.taskLinks().state(f.task).find(x=>x.link===restored.link)!.reason,'task_link_staged_selected_changes');assert.equal(f.git(['rev-parse','HEAD']),head);
  f.git(['reset','--','sample.js']);await f.link(f.item);await chmod(join(f.p.workspace,'sample.js'),0o755);await assert.rejects(f.link(f.item),/task_link_selected_mode_changed/);assert.equal(f.q.taskLinks().state(f.task).filter(x=>x.current).length,0);
});

test('wrong target, baseline, scope, changed candidate or lost provenance are refused without rewriting task history',async t=>{
  const f=await fixture(t),before=f.q.tasks().status(f.task),wrong=await f.packet({pr:9,target:'other-target'});await assert.rejects(f.link(wrong.item),/candidate_or_scope_mismatch/);
  const scope=await f.packet({pr:10,scopeId:'different'});await assert.rejects(f.link(scope.item),/candidate_or_scope_mismatch/);
  const definition={...f.p,id:'different-base',base:f.H},other=f.q.tasks().observe(definition,await observeTaskWorkspace(definition));await writeFile(f.linkFile,raw({schemaVersion:1,kind:'tongxu-task-candidate-link',task:other.item,candidateItem:f.item,source:'wrong baseline test'}));await assert.rejects(linkTaskCandidate(f.store,f.linkFile),/candidate_or_scope_mismatch/);
  const linked=await f.link(f.item),newHead=await f.newHead();await f.packet({H:newHead});await assert.rejects(resolveTaskCandidate(f.store,f.task,linked.link),/no_longer_current/);assert.equal(f.q.taskLinks().state(f.task)[0]!.current,false);assert.equal(f.q.tasks().status(f.task).id,before.id);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));const old=db.prepare('SELECT manifest_hash FROM packets WHERE id=?').get(linked.candidatePacket) as any;db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('broken original'),old.manifest_hash);db.close();const states=f.q.taskLinks().state(f.task);assert.equal(states[0]!.current,false);assert.equal(states[0]!.reason,'stored_evidence_hash_mismatch');
});

test('a prepared inquiry with an associated candidate stops on index changes before sending any new input',async t=>{
  const f=await fixture(t);await f.link(f.item);f.q.taskInbox().enqueue(raw(f.request('prepared')));const plan=await prepareTaskOwner(f.store,f.task,'prepared'),original=await readFile(join(f.p.workspace,'sample.js'));await writeFile(join(f.p.workspace,'sample.js'),'export const stagedOnly=4;\n');f.git(['add','sample.js']);await writeFile(join(f.p.workspace,'sample.js'),original);
  const result=await runMessages(f.store,plan.plan);assert.equal(result.newModelRequests,0);assert.equal(result.completed,false);assert.equal((await f.calls()).length,0);assert.equal(f.q.taskLinks().state(f.task)[0]!.current,false);
});

test('link observation runs neither repository clean nor process filters and ignores undeclared dirty paths',async t=>{
  const f=await fixture(t),marker=join(f.root,'filter-ran'),filter=join(f.root,'filter.mjs');await writeFile(filter,`#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdin.pipe(process.stdout);\n`,{mode:0o700});f.git(['config','filter.canary.clean',filter]);f.git(['config','filter.canary.process',filter]);await writeFile(join(f.p.workspace,'.gitattributes'),'sample.js filter=canary\n');await writeFile(join(f.p.workspace,'unselected.js'),'not selected');const link=await f.link(f.item);assert.equal(await exists(marker),false);assert.equal(link.current,true);assert.equal(link.wholeWorkspaceClean,false);assert.equal(link.selectedFilesOnly,true);
});

test('workbench and secretary show original task plus current or historical PR without exposing private source paths',async t=>{
  const f=await fixture(t),link=await f.link(f.item),definition=f.q.tasks().current(f.task),c=definition.manifest.candidate,p={schemaVersion:1 as const,kind:'tongxu-local-workbench' as const,title:'同一任务',goal:'关联原候选',sources:[{id:'original',title:'原任务',store:f.store,item:f.task}]};const before=f.q.status();
  const web=await workbenchState(p),secretary=await observeTask(f.store,f.task,{repository:c.repository,pr:null,H:c.H,B:c.B,target:c.targetRef,kind:'development-task',taskId:f.task,sourceSha256:c.sourceSha256});assert.equal(web.tasks[0]!.developmentTask.candidateLinks[0].link,link.link);assert.equal(secretary.developmentTask.candidateLinks[0].current,true);assert.equal(JSON.stringify(web).includes(f.p.workspace),false);assert.deepEqual(f.q.status(),before);
  await writeFile(join(f.p.workspace,'sample.js'),'export const later=5;\n');await f.q.refreshTaskLinkSource(f.task);const historical=await workbenchState(p);assert.equal(historical.tasks[0]!.developmentTask.candidateLinks[0].current,false);assert.equal(historical.tasks[0]!.candidate.pr,null);
});

test('association does not resolve an unknown original owner or transfer its authority',async t=>{
  const f=await fixture(t,'hang');f.q.taskInbox().enqueue(raw(f.request('original')));await workTaskOwner(f.store,f.task,1);await f.link(f.item);f.q.taskInbox().enqueue(raw(f.request('later')));assert.throws(()=>f.q.taskInbox().prepare(f.task,'later'),/original_responsibility_pending/);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(f.q.taskLinks().state(f.task)[0]!.permissionGranted,false);
});

test('a factual association does not invent complete evidence or satisfy a missing execution prerequisite',async t=>{
  const f=await fixture(t),candidate=await f.packet({pr:11,incomplete:true,requires:[{item:'e'.repeat(64),version:f.H,type:'development',blocks:'shadow_review',source:'explicit missing prerequisite fixture',canContinue:'readonly investigation only'}]});const link=await f.link(candidate.item);assert.equal(link.current,true);assert.equal(link.candidateEvidenceCompleteAtLink,false);assert.ok(link.candidatePrerequisitesAtLink>0);assert.equal(link.permissionGranted,false);assert.ok(f.q.begin(candidate.item,'must-not-execute').blocked.length);
});

test('a remote candidate change stops a prepared linked inquiry even while the local task packet remains identical',async t=>{
  const f=await fixture(t);await f.link(f.item);const oldTaskPacket=f.q.tasks().current(f.task).packet;f.q.taskInbox().enqueue(raw(f.request('prepared')));const plan=await prepareTaskOwner(f.store,f.task,'prepared');const newer=await f.newHead();await f.packet({H:newer});f.git(['reset','--hard',f.H]);
  const run=await runMessages(f.store,plan.plan);assert.equal(f.q.tasks().current(f.task).packet,oldTaskPacket);assert.equal(run.newModelRequests,0);assert.equal(run.completed,false);assert.equal((await f.calls()).length,0);assert.match(JSON.stringify(run.problems),/task_candidate_link_no_longer_current/);
});

test('multiple exact candidates require a selection, and resolve returns only the explicitly selected candidate',async t=>{
  const f=await fixture(t),other=await f.packet({pr:12}),one=await f.link(f.item),two=await f.link(other.item);f.q.taskInbox().enqueue(raw(f.request('ambiguous')));assert.throws(()=>f.q.taskInbox().prepare(f.task,'ambiguous'),/multiple_current_candidates_require_selection/);
  assert.equal((await resolveTaskCandidate(f.store,f.task,one.link)).material.originalCandidate.candidate.pr,1);assert.equal((await resolveTaskCandidate(f.store,f.task,two.link)).material.originalCandidate.candidate.pr,12);assert.equal((await f.calls()).length,0);
});

test('old complete report remains readable but becomes historical when its associated PR changes',async t=>{
  const f=await fixture(t);await f.link(f.item);f.q.taskInbox().enqueue(raw(f.request('report')));const run=await workTaskOwner(f.store,f.task,1),id=run.runs[0]!.run,before=await (await import('../../src/queue-store.js')).QueueStore.observeMessageReport(f.store,f.task,id,'report');assert.equal(before.current,true);
  const newer=await f.newHead();await f.packet({H:newer});f.git(['reset','--hard',f.H]);const after=await (await import('../../src/queue-store.js')).QueueStore.observeMessageReport(f.store,f.task,id,'report');assert.equal(after.current,false);assert.equal(after.report,before.report);assert.equal(after.reportSha256,before.reportSha256);assert.equal(f.q.taskInbox().status(f.task)[0]!.phase,'returned');assert.equal(f.q.taskInbox().status(f.task)[0]!.currentMaterial,false);
});

test('format16 refuses active or unknown original roles, then preserves a proven completed role through upgrade',async t=>{
  const f=await fixture(t,'delay',false);f.q.taskInbox().enqueue(raw(f.request('before-upgrade')));const work=workTaskOwner(f.store,f.task,1),deadline=Date.now()+4000;while(!(await f.calls()).some(x=>x.kind==='input')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok((await f.calls()).some(x=>x.kind==='input'));assert.throws(()=>f.q.enableTaskLinks(),/active_or_unknown_message/);const finished=await work;assert.equal(finished.runs[0]?.completed,true);const old=f.q.messages().status(finished.runs[0]!.run).messages[0]!.reply.finalSha256;assert.equal(f.q.enableTaskLinks().schemaVersion,16);await f.link(f.item);assert.equal(f.q.messages().status(finished.runs[0]!.run).messages[0]!.reply.finalSha256,old);
  const unknown=await fixture(t,'hang',false);unknown.q.taskInbox().enqueue(raw(unknown.request('unknown')));await workTaskOwner(unknown.store,unknown.task,1);assert.throws(()=>unknown.q.enableTaskLinks(),/active_or_unknown_message/);
});

test('adding original Owner and resource profiles after format16 never downgrades it and still uses their exact consumer',async t=>{
  const f=await fixture(t),ledger=await ledgerFixture(t),spec=ledger.profile.resources[0]!,request={...f.request('governed'),authorityIntent:'bounded-messages',resourceBudget:[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}]};await f.link(f.item);f.q.taskInbox().enqueue(raw(request));const selected=await prepareTaskOwner(f.store,f.task,'governed'),plan=JSON.parse(await readFile(selected.plan,'utf8'));await messageAuthority({...f,item:f.task,plan,write:async()=>writeFile(selected.plan,canonical(plan))});f.q.resources().configure(raw(ledger.profile));assert.equal(f.q.status().schemaVersion,16);const result=await workTaskOwner(f.store,f.task,1);assert.equal(result.runs[0]?.completed,true);assert.equal(result.runs[0]?.resourcesSettled,true);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);
});
