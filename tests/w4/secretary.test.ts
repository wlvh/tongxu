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

async function fixture(t: test.TestContext, mode = 'normal') {
  const f = await setup(t), received = await runReception(f.path), trace = join(f.root, 'secretary-trace.jsonl'); await writeFile(trace, '');
  const code = `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js', import.meta.url).href)};
const trace=${JSON.stringify(trace)},mode=${JSON.stringify(mode)},store=${JSON.stringify(f.store)},log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n'),emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(process.argv.includes('--version')){console.log(mode==='version'?'codex-cli 0.1':'codex-cli 0.163.0-alpha.10.2');process.exit(0)}
let thread,current,context,serial=0,observations=[],rateReads=0,retransmitted=false;
const tool=(name,args)=>emit({id:'query-'+(++serial),method:'item/tool/call',params:{threadId:mode==='wrong-thread'?'other-thread':thread.id,turnId:current,callId:'query-'+serial,tool:name,namespace:null,arguments:args}});
const finish=()=>{const report={candidateH:context.candidate.H,report:'明确标注的秘书模拟回答；读到了真实测试队列，未批准或执行动作。',observationIds:mode==='false-reference'?['0'.repeat(64)]:observations.map(o=>o.observationId)};const item={id:'fixture-answer',type:'agentMessage',phase:mode==='partial'?'commentary':'final_answer',text:JSON.stringify(report)};emit({method:'item/completed',params:{threadId:thread.id,turnId:current,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:current,status:'completed',rootTurnId:current,items:[item],itemsView:'full',error:null}}});};
readline.createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);
if(!m.method&&typeof m.id==='string'){if(m.error)return;if(['retransmit','new-rpc-id'].includes(mode)&&!retransmitted&&m.id==='query-1'){retransmitted=true;emit({id:mode==='retransmit'?'query-1':'query-1-again',method:'item/tool/call',params:{threadId:thread.id,turnId:current,callId:'query-1',tool:'tongxu_task_status',namespace:null,arguments:{}}});return;}const v=JSON.parse(m.result.contentItems[0].text);observations.push(v);log({kind:'observation',value:v});if(mode==='interrupt')process.exit(9);if(mode==='delivery'){finish();return;}if(mode==='workbench'){if(serial===1)tool('tongxu_overall_reviews',{});else if(serial===2)tool('tongxu_overall_report',{review:v.data.reviews[0].id});else finish();return;}if(serial===1){if(mode==='change'){const q=await QueueStore.open(store);q.control('scope','merge','stopped','fixture:external-control-change');q.close();}tool('tongxu_operation_status',{operation:v.data.operations[0].id});}else if(mode==='waiting-late-final'){emit({method:'thread/status/changed',params:{threadId:thread.id,status:{type:'active',activeFlags:['waitingOnUserInput']}}});setTimeout(()=>{finish();emit({method:'thread/status/changed',params:{threadId:thread.id,status:{type:'idle'}}});},300);}else finish();return;}
if(!('id'in m))return;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='account/rateLimits/read'){if(mode==='late-stop'&&++rateReads===2){const q=await QueueStore.open(store);q.control('scope','investment','stopped','fixture:late-stop-before-model');q.close();}result={ordinaryUsageAllowed:mode!=='quota'};}
if(m.method==='config/read')result={config:{mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(process.argv.filter(x=>x.startsWith('features.')).map(x=>[x.slice(9).split('=')[0],x.split('=')[1]==='true']))}};
if(m.method==='thread/start'){const id='secretary-fixture-'+process.pid;thread={id,sessionId:id,cwd:m.params.cwd,source:'appServer',cliVersion:'0.163.0-alpha.10.2',parentThreadId:null,forkedFromId:null};log({kind:'tools',names:m.params.dynamicTools.map(x=>x.name)});emit({id:m.id,result:{thread,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]}});emit({method:'thread/started',params:{thread}});return;}
if(m.method==='turn/start'){current='secretary-fixture-turn';const text=m.params.input[0].text;context=JSON.parse(text.slice(text.lastIndexOf('\\n')+1));log({kind:'model-input'});if(mode==='slow')await new Promise(r=>setTimeout(r,900));const reply={id:m.id,result:{turn:{id:current}}},started={method:'turn/started',params:{threadId:thread.id,turn:{id:current,status:'inProgress',items:[],rootTurnId:current}}};if(mode==='same-frame'){serial=1;process.stdout.write([reply,started,{id:'query-1',method:'item/tool/call',params:{threadId:thread.id,turnId:current,callId:'query-1',tool:'tongxu_task_status',namespace:null,arguments:{}}}].map(x=>JSON.stringify(x)).join('\\n')+'\\n');return;}emit(reply);emit(started);if(mode==='waiting'){emit({method:'thread/status/changed',params:{threadId:thread.id,status:{type:'active',activeFlags:['waitingOnUserInput']}}});return;}if(mode==='workbench')tool('tongxu_owner_controls',{});else if(mode==='delivery')tool('tongxu_delivery_outcomes',{});else if(mode==='forbidden')tool('tongxu_replace_file',{path:'sample.js',text:'not allowed'});else if(mode==='outside')tool('tongxu_operation_status',{operation:'another-task-operation'});else tool('tongxu_task_status',mode==='arguments'?{sql:'DROP TABLE operations'}:{});return;}
emit({id:m.id,result});});
`;
  const exe = join(f.root, 'codex-secretary-fixture.mjs'); await writeFile(exe, code, { mode: 0o700 });
  const common = join(f.root, 'common.txt'), role = join(f.root, 'secretary.txt'); await writeFile(common, 'Explicit common boundary fixture'); await writeFile(role, 'Explicit secretary role fixture');
  const candidate = { repository: received.candidate.repository, pr: received.candidate.pr, H: received.candidate.H, B: received.candidate.B, target: received.candidate.targetRef };
  const p: SecretaryPlan = { schemaVersion: 1, kind: 'tongxu-readonly-secretary', store: f.store, item: f.item, candidate, codexExecutable: exe, codexSha256: hash(await readFile(exe)), prompts: await Promise.all([common, role].map(async path => ({ path, sha256: hash(await readFile(path)) }))), question: '当前接收和发布做到哪一步？', scopeSource: 'fixture:query-only-scope', arrangementSource: 'fixture:secretary-role', disabledMcpServers: [], allowedInstructionSources: [], billing: { mode: 'existing_subscription_only', evidence: f.plan.billing.evidence, evidenceSha256: f.plan.billing.evidenceSha256, observedAt: f.plan.billing.observedAt, ordinaryUsageRequired: true }, timeoutMs: 3000, executionKind: 'fixture' };
  const path = join(f.root, 'secretary-plan.json'); await writeFile(path, JSON.stringify(p));
  const read = async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
  return { ...f, received, p, secretaryPlan: path, output: join(f.root, 'brief'), trace, logs: read };
}

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
