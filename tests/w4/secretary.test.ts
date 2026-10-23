import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../w3/receiver-fixture.js';
import { runReception } from '../../src/receiver.js';
import { hash } from '../../src/snapshot.js';
import { runSecretary, type SecretaryPlan } from '../../src/secretary.js';
import { SecretaryTools, observeTask } from '../../src/secretary-tools.js';
import { QueueStore } from '../../src/queue-store.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {fixture as repairFixture} from '../w5/repair-fixture.js';
import {overallReview,type OverallPlan} from '../../src/overall-review.js';
import {startWorkbench} from '../../src/workbench.js';
import {SecretaryWorkbench} from '../../src/secretary-workbench.js';
import {scopeFollowupFixture} from '../w7/scope-followup-fixture.js';
import {prepareScopeFollowup,authorizeScopeFollowup} from '../../src/task-scope-followup.js';
import {TaskControls} from '../../src/task-controls.js';
import {OwnerControls} from '../../src/owner-controls.js';

import {secretaryFixture as fixture} from './secretary-fixture.js';

test('a distinct secretary uses only registered state queries; original queue stays unchanged and repeat starts no model', async t => {
  const f = await fixture(t), before = f.q.status(), result = await runSecretary(f.secretaryPlan, f.output);
  assert.equal(result.status, 'completed'); assert.equal(result.queryCalls, 2); assert.equal(result.productionActionAllowed, false); assert.deepEqual(f.q.status(), before);
  const logs = await f.logs(); assert.deepEqual(logs.find(x => x.kind === 'tools').names, ['tongxu_task_status', 'tongxu_operation_status']);
  const responses = JSON.stringify(logs.filter(x => x.kind === 'observation')); assert.ok(!responses.includes(f.root)); assert.ok(!responses.includes('明确标注的模拟接收判断'));
  await writeFile(join(f.output, 'result.json'), '{"status":"forged","approval":true}');
  const again = await runSecretary(f.secretaryPlan, f.output); assert.equal(again.duplicate, true); assert.equal(again.newModelTasks, 0); assert.equal(again.report, result.report); assert.deepEqual(await f.logs(), logs); assert.deepEqual(f.q.status(), before);
  const binding = JSON.parse(await readFile(join(f.output, 'codex-secretary/binding.json'), 'utf8')); assert.equal(binding.role, 'secretary');
});
test('explicit delivery-query capability is captured and replayed without changing legacy tool contracts',async t=>{
  const f=await fixture(t,'delivery'),item=f.q.status().items.find((x:any)=>x.id===f.item),event=f.q.status().events.filter((e:any)=>e.object===f.item&&e.kind==='material_changed').at(-1),batch=f.q.deliveries().register(Buffer.from(JSON.stringify({schemaVersion:1,kind:'tongxu-delivery-batch',id:'secretary-batch',revision:1,previous:null,repository:item.candidate.repository,issue:9,title:'Secretary query fixture',source:'explicit fixture; no model or owner acceptance',target:item.candidate.targetRef,scope:{id:item.context.scope.id,version:item.context.scope.version,adoption:null},goals:['read original outcome state'],nonGoals:['no authority'],members:[{item:f.item,packet:item.currentPacket,fingerprint:JSON.parse(event.data).fingerprint}],scenarios:[{id:'read',title:'Read exact record',expected:'No invented acceptance',members:[f.item]}],related:[]})));
  f.p.deliveryOutcomes=true;await writeFile(f.secretaryPlan,JSON.stringify(f.p));const before=f.q.status(),result=await runSecretary(f.secretaryPlan,f.output),logs=await f.logs(),observation=logs.find(x=>x.kind==='observation').value;assert.equal(result.queryCalls,1);assert.equal(observation.data.batches[0].batchSha256,batch.batchSha256);assert.equal(observation.data.batches[0].userOutcomeAccepted,false);assert.deepEqual(logs.find(x=>x.kind==='tools').names,['tongxu_task_status','tongxu_operation_status','tongxu_delivery_outcomes']);assert.deepEqual(f.q.status(),before);const again=await runSecretary(f.secretaryPlan,f.output);assert.equal(again.newModelTasks,0);assert.deepEqual(await f.logs(),logs);
});
test('secretary reads the selected page and complete original overall report through captured readonly tools',async t=>{
  const f=await fixture(t,'workbench'),m=await repairFixture(t),original=f.q.receiverState(f.received.operation),context=f.q.receiverEvidence(f.received.operation).context;
  f.q.enableSupplements();f.q.reviewRecords().enable();const evidence=join(f.root,'review-source.txt');await writeFile(evidence,'Explicit fixed comparison fixture; no adopted baseline or real model.');const ref={name:'original fixture evidence',path:evidence,sha256:hash(await readFile(evidence))};
  const review:OverallPlan={schemaVersion:1,kind:'tongxu-overall-review',store:f.store,operation:f.received.operation,judgmentId:original.receiver.judgmentId,bindingHash:original.receiver.bindingHash,context,config:m.configPath,configSha256:hash(await readFile(m.configPath)),trigger:{kind:'owner_request',source:'explicit fixture',reason:'bounded comparison'},material:{acceptedBaseline:[],cumulativeChanges:[ref],currentBehavior:[ref],currentDocuments:[ref]},baselineAcceptance:{kind:'missing',source:null}},reviewPath=join(f.root,'overall.json');await writeFile(reviewPath,JSON.stringify(review));await overallReview(reviewPath,'run');
  const workbench={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Same original sources',goal:'Read only; fixture is not acceptance',sources:[{id:'selected',title:'Selected task',store:f.store,item:f.item}],ownerControls:['selected'],overallReviews:[{id:'fixed-review',title:'Fixed review',source:'selected',plan:{path:reviewPath,sha256:hash(await readFile(reviewPath))}}]},path=join(f.root,'workbench.json');await writeFile(path,JSON.stringify(workbench));f.p.workbench={path,sha256:hash(await readFile(path)),source:'selected'};await writeFile(f.secretaryPlan,JSON.stringify(f.p));
  const app=await startWorkbench(path);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)},page=await (await fetch(u.origin+'/api/state',{headers})).json() as any,full=await (await fetch(u.origin+'/api/overall-report/fixed-review',{headers})).json() as any,before=f.q.status(),modelTrace=await readFile(m.trace);
  const result=await runSecretary(f.secretaryPlan,f.output),logs=await f.logs(),observations=logs.filter(x=>x.kind==='observation').map(x=>x.value.data);
  assert.equal(result.queryCalls,3);assert.equal(result.status,'completed');assert.deepEqual(observations[0].owner,page.ownerControls[0]);assert.deepEqual(observations[1].reviews,page.overallReviews.map(({active,currentControllerProblem,...original}:any)=>original));assert.equal(observations[1].controllerActivity,'not_observed');assert.ok(observations[1].reviews.every((r:any)=>!Object.hasOwn(r,'active')&&!Object.hasOwn(r,'currentControllerProblem')));assert.deepEqual(observations[2],full);assert.equal(full.executionKind,'fixture');assert.equal(full.noOverallDriftEstablished,false);assert.ok(full.gaps.length>0);
  assert.deepEqual(logs.find(x=>x.kind==='tools').names,['tongxu_task_status','tongxu_operation_status','tongxu_owner_controls','tongxu_overall_reviews','tongxu_overall_report']);assert.deepEqual(f.q.status(),before);assert.deepEqual(await readFile(m.trace),modelTrace);
  const again=await runSecretary(f.secretaryPlan,f.output);assert.equal(again.newModelTasks,0);assert.deepEqual(await f.logs(),logs);
  const selected=await SecretaryWorkbench.load(f.p.workbench,f.store,f.item),gate=new SecretaryTools(f.store,f.item,f.p.candidate,join(f.root,'workbench-gate'),undefined,false,false,selected);
  await assert.rejects(gate.call({tool:'tongxu_overall_report',arguments:{review:'unselected'},callId:'outside'}),/report_not_selected/);
  await assert.rejects(gate.call({tool:'tongxu_owner_controls',arguments:{source:'another'},callId:'arguments'}),/query_not_allowed/);
  await assert.rejects(gate.call({tool:'tongxu_owner_apply',arguments:{},callId:'no-owner-authority'}),/query_not_allowed/);
  await assert.rejects(SecretaryWorkbench.load(f.p.workbench,f.store,'f'.repeat(64)),/task_mismatch/);
  await writeFile(path,JSON.stringify({...workbench,title:'Changed selection'}));await assert.rejects(SecretaryWorkbench.load(f.p.workbench,f.store,f.item),/selection_changed/);
  // Original completed capture stays readable when the later page selection changes.
  assert.equal((await runSecretary(f.secretaryPlan,f.output)).newModelTasks,0);assert.deepEqual(f.q.status(),before);
});
test('explicit followup report tool reads the actual selected descendant capture and preserves old tool contracts on replay',async t=>{
  const f=await fixture(t,'scope-followup'),g=await scopeFollowupFixture(t),prepared=await prepareScopeFollowup(g.store,Buffer.from(JSON.stringify(g.request))),owner=new OwnerControls([prepared.source.id],[prepared.source]);
  await owner.apply(prepared.source.id,{proposalSha256:prepared.proposalSha256,sourceUrl:await g.originalDecision(prepared.proposalSha256)});await authorizeScopeFollowup(g.store,prepared.task);const controls=await TaskControls.load(prepared.controls.path,prepared.controls.sha256,[prepared.source]);t.after(()=>controls.drain());assert.equal(((await controls.execute(prepared.contact.id)).execution as any).completed,true);
  await writeFile(g.planPath,JSON.stringify({...g.plan,ownerControls:['task']}));const c=g.q.tasks().current(g.task).manifest.candidate;Object.assign(f.p,{store:g.store,item:g.task,candidate:{repository:c.repository,pr:null,H:c.H,B:c.B,target:c.targetRef,kind:'development-task',taskId:g.task,sourceSha256:c.sourceSha256},workbench:{path:g.planPath,sha256:hash(await readFile(g.planPath)),source:'task'},scopeFollowupReports:true});await writeFile(f.secretaryPlan,JSON.stringify(f.p));
  const before=g.q.status(),trace=await readFile(g.trace),result=await runSecretary(f.secretaryPlan,f.output),logs=await f.logs(),observations=logs.filter(x=>x.kind==='observation').map(x=>x.value.data),report=await controls.report(prepared.contact.id);
  assert.equal(result.queryCalls,2);assert.equal(observations[0].scopeFollowups.followups[0].task,prepared.task);assert.equal(observations[0].scopeFollowups.controllerActivity,'not_observed');assert.deepEqual(observations[1],report);assert.equal(observations[1].completeCapture,true);assert.equal(observations[1].nativeSessionResumed,false);assert.deepEqual(g.q.status(),before);assert.deepEqual(await readFile(g.trace),trace);
  assert.deepEqual(logs.find(x=>x.kind==='tools').names,['tongxu_task_status','tongxu_operation_status','tongxu_owner_controls','tongxu_overall_reviews','tongxu_overall_report','tongxu_scope_followup_report']);assert.equal((await runSecretary(f.secretaryPlan,f.output)).newModelTasks,0);assert.deepEqual(await f.logs(),logs);
  const selected=await SecretaryWorkbench.load(f.p.workbench!,g.store,g.task),legacy=new SecretaryTools(g.store,g.task,f.p.candidate,join(f.root,'legacy-followup'),undefined,false,false,selected),enabled=new SecretaryTools(g.store,g.task,f.p.candidate,join(f.root,'enabled-followup'),undefined,false,false,selected,true);
  await assert.rejects(legacy.call({tool:'tongxu_scope_followup_report',arguments:{task:prepared.task},callId:'not-enabled'}),/query_not_allowed/);await assert.rejects(enabled.call({tool:'tongxu_scope_followup_report',arguments:{task:g.task},callId:'not-descendant'}),/followup_not_selected/);assert.deepEqual(await readFile(g.trace),trace);
});
test('wrong tool, arguments, operation and thread are rejected without queue mutation or a replacement model', async t => {
  for (const mode of ['forbidden', 'arguments', 'outside', 'wrong-thread']) {
    const f = await fixture(t, mode), before = f.q.status(); await assert.rejects(runSecretary(f.secretaryPlan, f.output), /permission_mismatch|query_not_allowed|outside_task/);
    const logs = await f.logs(); await assert.rejects(runSecretary(f.secretaryPlan, f.output)); assert.deepEqual(await f.logs(), logs); assert.deepEqual(f.q.status(), before);
  }
});
test('partial, waiting, interrupted and fabricated-reference answers stay unresolved; no repeated turn', async t => {
  for (const mode of ['partial', 'waiting', 'interrupt', 'false-reference']) {
    const f = await fixture(t, mode); await assert.rejects(runSecretary(f.secretaryPlan, f.output), mode === 'false-reference' ? /secretary_unobserved_reference/ : mode === 'waiting' ? /native_waiting/ : mode === 'partial' ? /controlled_result_not_final/ : /executor_closed_before_result/); const logs = await f.logs(); assert.equal(logs.filter(x => x.kind === 'model-input').length, 1); await assert.rejects(runSecretary(f.secretaryPlan, f.output)); assert.deepEqual(await f.logs(), logs);
  }
});
test('investment stop prevents model dispatch and explicit reopening can continue the original unsent operation', async t => {
  const f = await fixture(t); f.q.control('scope', 'investment', 'stopped', 'fixture:stop'); await assert.rejects(runSecretary(f.secretaryPlan, f.output), /new_investment_stopped/); assert.equal((await f.logs()).length, 0);
  f.q.control('scope', 'investment', 'open', 'fixture:resume'); const r = await runSecretary(f.secretaryPlan, f.output); assert.equal(r.status, 'completed'); assert.equal((await f.logs()).filter(x => x.kind === 'model-input').length, 1);
});
test('wrong native version and unavailable ordinary quota prevent a model turn', async t => {
  for (const mode of ['version', 'quota']) { const f = await fixture(t, mode); await assert.rejects(runSecretary(f.secretaryPlan, f.output), /version_mismatch|ordinary_usage_unavailable/); assert.equal((await f.logs()).filter(x => x.kind === 'model-input').length, 0); }
});
test('a stop arriving during the last native usage check is observed before turn/start', async t => {
  const f = await fixture(t, 'late-stop'); await assert.rejects(runSecretary(f.secretaryPlan, f.output), /new_investment_stopped/); assert.equal((await f.logs()).filter(x => x.kind === 'model-input').length, 0);
});
test('a tool request sharing one pipe frame with turn acceptance waits for that exact accepted turn', async t => {
  const f = await fixture(t, 'same-frame'); const r = await runSecretary(f.secretaryPlan, f.output); assert.equal(r.status, 'completed'); assert.equal(r.queryCalls, 2);
});
test('queries observe actual later queue revisions, while local observations are not remote rechecks', async t => {
  const f = await fixture(t, 'change'); await runSecretary(f.secretaryPlan, f.output); const observations = (await f.logs()).filter(x => x.kind === 'observation').map(x => x.value); assert.equal(observations.length, 2); assert.ok(observations[1].eventRevision > observations[0].eventRevision); assert.equal(observations[0].data.externalStateRechecked, false);
});
test('query gate is bounded, binds duplicate IDs and shows another task occupying the same target', async t => {
  const f = await fixture(t); await mkdir(f.output, { mode: 0o700 }); const gate = new SecretaryTools(f.store, f.item, f.p.candidate, f.output);
  const other = await f.packet({ pr: 2 }); const active = f.q.begin(other.item, 'fixture:other-task'); const state = await observeTask(f.store, f.item, f.p.candidate); assert.equal(state.claims.length, 1); assert.equal(state.claims[0].selectedTask, false);
  const p = { tool: 'tongxu_task_status', arguments: {}, callId: 'same' }; const a = await gate.call(p); assert.deepEqual(await gate.call(p), a); await assert.rejects(gate.call({ ...p, tool: 'tongxu_operation_status', arguments: { operation: f.received.operation } }), /conflicting_query_id/);
  await assert.rejects(gate.call({ tool: 'tongxu_operation_status', arguments: { operation: active.operation }, callId: 'outside' }), /outside_task/);
  for (let i = 0; i < 6; i++) await gate.call({ ...p, callId: 'next-' + i }); await assert.rejects(gate.call({ ...p, callId: 'over-budget' }), /query_budget/);
});

test('two actual CLI processes cannot start competing secretary turns for one operation', async t => {
  const f = await fixture(t, 'slow'), cli = fileURLToPath(new URL('../../src/secretary-cli.js', import.meta.url));
  const start = () => { const p = spawn(process.execPath, [cli, 'run', '--plan', f.secretaryPlan, '--output', f.output], { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; p.stdout.resume(); p.stderr.on('data', b => stderr += b); return once(p, 'close').then(([code]) => ({ code, stderr })); };
  const first = start(); for (let i = 0; i < 300 && !(await f.logs()).some(x => x.kind === 'model-input'); i++) await new Promise(r => setTimeout(r, 10));
  const second = await start(), done = await first; assert.equal(done.code, 0); assert.equal(second.code, 1); assert.match(second.stderr, /secretary_controller_active/); assert.equal((await f.logs()).filter(x => x.kind === 'model-input').length, 1);
});

async function reviseCapture(native: string, name: string, mutate: (messages: any[]) => void) {
  const file = join(native, name), messages = (await readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x)); mutate(messages);
  const bytes = Buffer.from(messages.map(x => JSON.stringify(x)).join('\n') + '\n'); await writeFile(file, bytes);
  const capturePath = join(native, 'capture-status.json'), capture = JSON.parse(await readFile(capturePath, 'utf8')); capture.files[name] = hash(bytes); await writeFile(capturePath, JSON.stringify(capture));
  const receiptPath = join(native, 'completed.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (name === 'stdin.ndjson') { const contract = Buffer.from(JSON.stringify(messages)); await writeFile(join(native, 'expected-requests.json'), contract); receipt.inputSha256 = hash(bytes); receipt.contractSha256 = hash(contract); } else receipt.rawSha256 = hash(bytes);
  await writeFile(receiptPath, JSON.stringify(receipt));
}
test('coherently rehashed capture cannot change thread permissions, client request IDs, bare replies or accepted turn identity', async t => {
  for (const mode of ['permissions', 'request-id', 'bare-response', 'accepted-turn']) {
    const f = await fixture(t); await runSecretary(f.secretaryPlan, f.output); const logs = await f.logs(), native = join(f.output, 'codex-secretary');
    if (mode === 'accepted-turn') await reviseCapture(native, 'stdout.ndjson', messages => { messages.find(x => x.id === 7 && !x.method).result.turn.id = 'different-accepted-turn'; });
    else await reviseCapture(native, 'stdin.ndjson', messages => {
      if (mode === 'permissions') Object.assign(messages.find(x => x.method === 'thread/start').params, { approvalPolicy: 'on-request', sandbox: 'danger-full-access', ephemeral: false });
      if (mode === 'request-id') messages.find(x => x.method === 'initialize').id = 900;
      if (mode === 'bare-response') messages.push({ id: 'unmatched-response', result: { success: true, contentItems: [] } });
    });
    await assert.rejects(runSecretary(f.secretaryPlan, f.output)); assert.deepEqual(await f.logs(), logs);
  }
});
test('identical RPC retries and semantic query retries consume the original response without another query or model turn', async t => {
  for (const mode of ['retransmit', 'new-rpc-id']) {
    const f = await fixture(t, mode), result = await runSecretary(f.secretaryPlan, f.output); assert.equal(result.status, 'completed'); assert.equal(result.queryCalls, 2); const logs = await f.logs();
    assert.equal((await runSecretary(f.secretaryPlan, f.output)).newModelTasks, 0); assert.deepEqual(await f.logs(), logs);
  }
});
test('a valid late final from the same original run can be recovered after waiting, without losing the waiting record', async t => {
  const f = await fixture(t, 'waiting-late-final'); await assert.rejects(runSecretary(f.secretaryPlan, f.output), /native_waiting/); const logs = await f.logs();
  const recovered = await runSecretary(f.secretaryPlan, f.output); assert.equal(recovered.status, 'completed'); assert.equal(recovered.newModelTasks, 0); assert.deepEqual(await f.logs(), logs); assert.equal(JSON.parse(await readFile(join(f.output, 'outcome.json'), 'utf8')).reason, 'native_waiting');
});
test('waiting preserves the original run but a late answer for the wrong candidate cannot become a completion', async t => {
  const f = await fixture(t, 'waiting-late-final');
  await writeFile(f.p.codexExecutable, (await readFile(f.p.codexExecutable, 'utf8')).replace('candidateH:context.candidate.H', "candidateH:'wrong-candidate'"));
  await writeFile(f.secretaryPlan, JSON.stringify({ ...f.p, codexSha256: hash(await readFile(f.p.codexExecutable)) }));
  await assert.rejects(runSecretary(f.secretaryPlan, f.output), /native_waiting/);
  const logs = await f.logs();
  await assert.rejects(readFile(join(f.output, 'codex-secretary/completed.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(f.output, 'codex-secretary/native-boundary-failure.json'), 'utf8')).reason, 'structured_report_wrong_candidate');
  await assert.rejects(runSecretary(f.secretaryPlan, f.output)); assert.deepEqual(await f.logs(), logs);
});

test('pinned native binaries larger than 128 MB reach the stop gate without being executed', async t => {
  const f = await fixture(t), path = join(f.root, 'large-binary-data-fixture');
  const file = await open(path, 'wx', 0o700); try { await file.truncate(160 * 1024 * 1024); } finally { await file.close(); }
  await writeFile(f.secretaryPlan, JSON.stringify({ ...f.p, codexExecutable: path, codexSha256: hash(await readFile(path)) }));
  f.q.control('scope', 'investment', 'stopped', 'fixture:do-not-execute-data-file');
  await assert.rejects(runSecretary(f.secretaryPlan, f.output), /new_investment_stopped/); assert.equal((await f.logs()).length, 0);
});
