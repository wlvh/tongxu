import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,cp,mkdir,rm,stat} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {coordinatedRepair,setupRepair} from '../review-records/queue-repair-fixture.js';
import {fixture} from '../w5/repair-fixture.js';
import {runQueueRepair,parseQueueRepairPlan} from '../../src/queue-repair.js';
import {runReception} from '../../src/receiver.js';
import {runCoordination} from '../../src/coordination.js';
import {git} from '../../src/repair-workspace.js';
import {hash} from '../../src/snapshot.js';
import {observeManagedWorkspace,managedWorkspaceStateSha256} from '../../src/workspace-handoff-source.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectRepairContinuation} from '../../src/repair-continuation.js';
const exec=promisify(execFile);

async function successor(t:test.TestContext,handoff=false){
  const hooks:Array<()=>unknown>=[],owned={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext;
  const f=await coordinatedRepair(owned,true,'complete',handoff);
  t.after(async()=>{if(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE){await mkdir(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE,{recursive:true});await cp(f.root,join(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE,basename(f.root)),{recursive:true});}for(const h of hooks.reverse())await h();});
  const first=await runQueueRepair(f.planPath),source=f.q.managedRepairOriginal(f.operation),workspace=join(f.request.executionRoot,'workspace');
  assert.equal(first.repairStatus,'completed');
  // Preserve a staged version and a different working version. Neither is
  // silently included in the committed source chosen for the successor.
  const committed=await readFile(join(workspace,'README.md'),'utf8');
  await writeFile(join(workspace,'README.md'),committed+'staged owner note\n');await git(workspace,['add','README.md']);
  await writeFile(join(workspace,'README.md'),committed+'unstaged owner note\n');await writeFile(join(workspace,'owner-note.txt'),'untracked owner evidence\n');
  const snapshot=await observeManagedWorkspace(workspace),index=await readFile(join(workspace,'.git/index')),indexMtime=(await stat(join(workspace,'.git/index'))).mtimeMs;
  await git(f.plan.objects,['fetch',workspace,first.after.H]);const packet=await f.packet({H:first.after.H});
  const reception={...f.plan,item:packet.item};const receptionPath=join(f.root,'next-reception.json');await writeFile(receptionPath,JSON.stringify(reception));const received=await runReception(receptionPath),original=f.q.receiverState(received.operation),evidence=f.q.receiverEvidence(received.operation);
  const model=await fixture(owned,'project-refuted'),request={...f.request,executionRoot:join(f.root,'continued'),candidate:{...f.request.candidate,H:first.after.H}},requestPath=join(f.root,'next-request.json');await writeFile(requestPath,JSON.stringify(request));
  const coord={...f.coordPlan,revision:'r2',previous:f.coordId,source:'Explicit fixture: original owner continues; when selected, B work is unified into A with original history.',...(handoff?{mode:'unified_owner'}:{}),tasks:f.coordPlan.tasks.map(task=>task.id==='A'?{...task,item:packet.item,actor:'A',...(handoff?{dispatch:'same_tool_new'}:{}),workspace:join(request.executionRoot,'workspace')}:task)};
  const coordPath=join(f.root,'next-coordination.json'),configPath=join(f.root,'next-coordination-execution.json'),config=JSON.parse(await readFile(f.coordConfigPath,'utf8'));config.actors=config.actors.filter((actor:any)=>coord.tasks.some(task=>task.actor===actor.id));await writeFile(configPath,JSON.stringify(config));await writeFile(coordPath,JSON.stringify(coord));const prepared=await runCoordination(f.store,coordPath,configPath);assert.equal(prepared.results['A:investigate']?.completed,true,JSON.stringify(prepared.errors));
  const from=prepared.prepared['A:investigate'],continuation={operation:f.operation,bindingHash:source.repair.bindingHash,resultSha256:source.repair.resultSha256,evidenceSha256:source.repair.evidenceSha256,workspaceStateSha256:managedWorkspaceStateSha256(snapshot),mode:handoff?'explicit_handoff':'same_owner',adoption:'committed_candidate',source:'Explicit fixture selection: adopt the fixed commit and preserve staged/unstaged originals separately.'};
  const plan={...f.p,operation:received.operation,packet:evidence.packet,judgmentId:original.receiver.judgmentId,bindingHash:original.receiver.bindingHash,context:evidence.context,request:requestPath,requestSha256:hash(await readFile(requestPath)),config:model.configPath,configSha256:hash(await readFile(model.configPath)),coordination:{planId:prepared.coordination,task:'A',capability:'fixed-label',fromRun:from.run,fromMessage:from.messageId},continuation};
  const planPath=join(f.root,'next-queue-repair.json');await writeFile(planPath,JSON.stringify(plan));
  return {...f,next:{plan,planPath,model,request,requestPath,original,evidence},source,workspace,snapshot,index,indexMtime,first,committed};
}

test('A continues on the same logical branch after proof of end, preserves dirty/index originals, and refutes an obsolete finding without inventing repair',async t=>{
  const f=await successor(t),n=f.next,originalTerminal=await readFile(join(f.request.executionRoot,'operation/terminal-record.json')),oldTrace=await readFile(f.model.trace),newTrace=await readFile(n.model.trace);
  const attempt=async(plan:unknown)=>{await writeFile(n.planPath,JSON.stringify(plan));return runQueueRepair(n.planPath);};
  const {continuation,...without}=n.plan;
  await assert.rejects(attempt(without),/coordination_write_responsibility_held/);
  await assert.rejects(attempt({...n.plan,continuation:{...continuation,workspaceStateSha256:'0'.repeat(64)}}),/continuation_original_state_changed_or_occupied/);
  await assert.rejects(attempt({...n.plan,continuation:{...continuation,mode:'explicit_handoff'}}),/continuation_explicit_responsibility_mismatch/);
  const lock=new DatabaseSync(join(f.store,`repair-controller-${f.operation}.sqlite`));lock.exec('BEGIN IMMEDIATE');try{await assert.rejects(attempt(n.plan),/handoff_original_controller_active/);}finally{lock.exec('ROLLBACK');lock.close();}
  await writeFile(join(f.workspace,'.git/tongxu-writer.json'),JSON.stringify({controllerPid:process.pid,status:'held'}));try{await assert.rejects(attempt(n.plan),/continuation_original_state_changed_or_occupied/);}finally{await rm(join(f.workspace,'.git/tongxu-writer.json'));}
  const request={...n.request,authorization:{...n.request.authorization,allowRepair:false}};await writeFile(n.requestPath,JSON.stringify(request));await assert.rejects(attempt({...n.plan,requestSha256:hash(await readFile(n.requestPath))}),/coordination_exact_repair_task_workspace_required/);await writeFile(n.requestPath,JSON.stringify(n.request));
  assert.deepEqual(await readFile(n.model.trace),newTrace);assert.equal(f.q.coordination().continuation(n.plan.operation),null);assert.equal(f.q.status().claims.length,0);
  const result=await attempt(n.plan);assert.equal(result.repairStatus,'skipped_refuted');assert.equal(result.after.H,f.first.after.H);assert.equal(result.counters.actualFileWrites,0);assert.equal(result.counters.writeHandoffs,0);
  const saved=f.q.coordination().continuation(n.plan.operation)!;assert.equal(saved.priorActor,'A');assert.equal(saved.actor,'A');assert.equal(saved.mode,'same_owner');assert.equal(saved.newExecutionContext,true);assert.equal(saved.nativeSessionResumed,false);assert.equal(saved.capture.uncommittedPolicy,'preserved_separately_not_applied');
  assert.deepEqual(saved.capture.changes.staged.map((x:any)=>x.path),['README.md']);const entry=saved.capture.workspace.indexEntries.find((x:any)=>x.path==='README.md');assert.match(saved.capture.workspace.gitBlobs[entry.object].text,/staged owner note/);assert.match(saved.capture.workspace.files['README.md'].text,/unstaged owner note/);assert.match(saved.capture.workspace.files['owner-note.txt'].text,/untracked owner evidence/);
  assert.equal(await readFile(join(n.request.executionRoot,'workspace/README.md'),'utf8'),f.committed);assert.match(await readFile(join(n.request.executionRoot,'workspace/src/normalize.mjs'),'utf8'),/Untitled/);
  assert.deepEqual(await readFile(join(f.workspace,'.git/index')),f.index);assert.equal((await stat(join(f.workspace,'.git/index'))).mtimeMs,f.indexMtime);assert.deepEqual(await readFile(join(f.request.executionRoot,'operation/terminal-record.json')),originalTerminal);assert.deepEqual(await readFile(f.model.trace),oldTrace);
  const trace=await readFile(n.model.trace);assert.equal((await runQueueRepair(n.planPath)).duplicate,true);assert.deepEqual(await readFile(n.model.trace),trace);assert.equal(f.q.status().claims.length,0);
  const prepared=await inspectRepairContinuation(f.store,f.operation,'same_owner','Read-only source inspection');assert.equal(prepared.continuation.workspaceStateSha256,continuation.workspaceStateSha256);assert.equal(prepared.newModelInputs,0);assert.equal(prepared.writePermissionGranted,false);
  assert.throws(()=>parseQueueRepairPlan(Buffer.from(JSON.stringify({...n.plan,continuation:{...continuation,authority:'model PASS'}}))),/repair_continuation_invalid/);
  await writeFile(join(f.root,'continuation-verification.json'),JSON.stringify({result,record:saved,oldIndexUnchanged:true,oldTerminalUnchanged:true,duplicateNoNewInputs:true,executionKind:'fixture'},null,2));
});

test('explicit B work unified into A adopts the fixed result in a fresh workspace; same-owner aliases are refused',async t=>{
  const f=await successor(t,true),n=f.next;
  await writeFile(n.planPath,JSON.stringify({...n.plan,continuation:{...n.plan.continuation,mode:'same_owner'}}));await assert.rejects(runQueueRepair(n.planPath),/continuation_explicit_responsibility_mismatch/);assert.equal(await readFile(n.model.trace,'utf8'),'');
  await writeFile(n.planPath,JSON.stringify(n.plan));const result=await runQueueRepair(n.planPath);assert.equal(result.repairStatus,'skipped_refuted');const record=f.q.coordination().continuation(n.plan.operation)!;assert.equal(record.priorActor,'B');assert.equal(record.actor,'A');assert.equal(record.adoptedH,f.first.after.H);assert.notEqual(record.workspace,record.priorWorkspace);assert.equal(record.nativeSessionResumed,false);
  const input=await readFile(join(n.request.executionRoot,'operation/attempt-1/fact-and-repair/stdin.ndjson'),'utf8');assert.match(input,/Untitled/);assert.ok(input.includes(n.original.receiver.judgment.report));assert.deepEqual(await readFile(join(f.workspace,'.git/index')),f.index);
  assert.ok(input.includes(f.source.repair.result.data.review.report));
  await writeFile(join(f.root,'unification-verification.json'),JSON.stringify({result,record,adoptedSourceActuallyRead:true,executionKind:'fixture'},null,2));
});

test('A resumes the ended original operation in its original workspace, preserves staged bytes and does not resend the interrupted writer',async t=>{
  const hooks:Array<()=>unknown>=[],owned={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext,f=await setupRepair(owned,'return','project-interrupt');
  t.after(async()=>{if(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE){await mkdir(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE,{recursive:true});await cp(f.root,join(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE,basename(f.root)),{recursive:true});}for(const h of hooks.reverse())await h();});
  const script=`import {runQueueRepair} from ${JSON.stringify(new URL('../../src/queue-repair.js',import.meta.url).href)};try{await runQueueRepair(${JSON.stringify(f.planPath)})}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath,['--input-type=module','-e',script]),/executor_closed_before_result/);
  const workspace=join(f.request.executionRoot,'workspace'),operation=join(f.request.executionRoot,'operation'),oldOutput=await readFile(join(operation,'attempt-1/fact-and-repair/stdout.ndjson')),beforeTrace=await readFile(f.model.trace,'utf8');
  assert.match(await readFile(join(workspace,'src/normalize.mjs'),'utf8'),/Untitled/);
  // A may have staged the already registered partial repair before its old
  // controller ended. Resume must retain the bytes as evidence, then test
  // and commit only that verified repair without another writer request.
  await git(workspace,['add','src/normalize.mjs']);const index=await readFile(join(workspace,'.git/index'));
  const result=await runQueueRepair(f.planPath,true);assert.equal(result.repairStatus,'completed_recovered_candidate');assert.equal(result.counters.actualFileWrites,1);assert.deepEqual(await readFile(join(operation,'attempt-1/fact-and-repair/stdout.ndjson')),oldOutput);
  const afterTrace=await readFile(f.model.trace,'utf8'),inputs=(s:string)=>s.split('\n').filter(x=>x.includes('"kind":"model-input"')).length;assert.equal(inputs(afterTrace),inputs(beforeTrace)+1);assert.equal(afterTrace.split('\n').filter(x=>x.includes('"name":"tongxu_replace_file"')).length,1);
  const recovered=JSON.parse(await readFile(join(operation,'attempt-2/recovery.json'),'utf8'));assert.equal(recovered.originalNativeSessionNotResumed,true);const {readdir}=await import('node:fs/promises'),observations=await Promise.all((await readdir(join(operation,'index-observations'))).map(async name=>JSON.parse(await readFile(join(operation,'index-observations',name),'utf8'))));assert.ok(observations.some(x=>Buffer.from(x.indexBase64,'base64').equals(index)&&x.matched));
  assert.equal((await runQueueRepair(f.planPath)).duplicate,true);assert.equal(await readFile(f.model.trace,'utf8'),afterTrace);assert.equal(f.q.status().claims.length,0);
  await writeFile(join(f.root,'same-workspace-recovery-verification.json'),JSON.stringify({result,preservedIndexSha256:hash(index),originalOutputUnchanged:true,originalWriterResent:false,newIndependentReviewInputs:1,executionKind:'fixture'},null,2));
});
