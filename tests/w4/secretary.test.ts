import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

async function fixture(t: test.TestContext, mode = 'normal') {
  const f = await setup(t), received = await runReception(f.path), trace = join(f.root, 'secretary-trace.jsonl'); await writeFile(trace, '');
  const code = `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js', import.meta.url).href)};
const trace=${JSON.stringify(trace)},mode=${JSON.stringify(mode)},store=${JSON.stringify(f.store)},log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n'),emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(process.argv.includes('--version')){console.log(mode==='version'?'codex-cli 0.1':'codex-cli 0.163.0-alpha.10.2');process.exit(0)}
let thread,current,context,serial=0,observations=[],rateReads=0;
const tool=(name,args)=>emit({id:'query-'+(++serial),method:'item/tool/call',params:{threadId:mode==='wrong-thread'?'other-thread':thread.id,turnId:current,callId:'query-'+serial,tool:name,namespace:null,arguments:args}});
const finish=()=>{const report={candidateH:context.candidate.H,report:'明确标注的秘书模拟回答；读到了真实测试队列，未批准或执行动作。',observationIds:mode==='false-reference'?['0'.repeat(64)]:observations.map(o=>o.observationId)};const item={id:'fixture-answer',type:'agentMessage',phase:mode==='partial'?'commentary':'final_answer',text:JSON.stringify(report)};emit({method:'item/completed',params:{threadId:thread.id,turnId:current,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:current,status:'completed',rootTurnId:current,items:[item],itemsView:'full',error:null}}});};
readline.createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);
if(!m.method&&typeof m.id==='string'){if(m.error)return;const v=JSON.parse(m.result.contentItems[0].text);observations.push(v);log({kind:'observation',value:v});if(mode==='interrupt')process.exit(9);if(serial===1){if(mode==='change'){const q=await QueueStore.open(store);q.control('scope','merge','stopped','fixture:external-control-change');q.close();}tool('tongxu_operation_status',{operation:v.data.operations[0].id});}else finish();return;}
if(!('id'in m))return;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='account/rateLimits/read'){if(mode==='late-stop'&&++rateReads===2){const q=await QueueStore.open(store);q.control('scope','investment','stopped','fixture:late-stop-before-model');q.close();}result={ordinaryUsageAllowed:mode!=='quota'};}
if(m.method==='config/read')result={config:{mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(process.argv.filter(x=>x.startsWith('features.')).map(x=>[x.slice(9).split('=')[0],x.split('=')[1]==='true']))}};
if(m.method==='thread/start'){const id='secretary-fixture-'+process.pid;thread={id,sessionId:id,cwd:m.params.cwd,source:'appServer',cliVersion:'0.163.0-alpha.10.2',parentThreadId:null,forkedFromId:null};log({kind:'tools',names:m.params.dynamicTools.map(x=>x.name)});emit({id:m.id,result:{thread,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]}});emit({method:'thread/started',params:{thread}});return;}
if(m.method==='turn/start'){current='secretary-fixture-turn';const text=m.params.input[0].text;context=JSON.parse(text.slice(text.lastIndexOf('\\n')+1));log({kind:'model-input'});if(mode==='slow')await new Promise(r=>setTimeout(r,900));const reply={id:m.id,result:{turn:{id:current}}},started={method:'turn/started',params:{threadId:thread.id,turn:{id:current,status:'inProgress',items:[],rootTurnId:current}}};if(mode==='same-frame'){serial=1;process.stdout.write([reply,started,{id:'query-1',method:'item/tool/call',params:{threadId:thread.id,turnId:current,callId:'query-1',tool:'tongxu_task_status',namespace:null,arguments:{}}}].map(x=>JSON.stringify(x)).join('\\n')+'\\n');return;}emit(reply);emit(started);if(mode==='waiting'){emit({method:'thread/status/changed',params:{threadId:thread.id,status:{activeFlags:['waitingOnUserInput']}}});return;}if(mode==='forbidden')tool('tongxu_replace_file',{path:'sample.js',text:'not allowed'});else if(mode==='outside')tool('tongxu_operation_status',{operation:'another-task-operation'});else tool('tongxu_task_status',mode==='arguments'?{sql:'DROP TABLE operations'}:{});return;}
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
