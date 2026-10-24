import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, cp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../../src/snapshot.js';
import { runRelay, recoverStage, type RelayPlan } from '../../src/relay.js';
import { LiveProcess, newStage } from '../../src/live-process.js';
import { readCodexExecution } from '../../src/live-codex.js';

// These are deliberately synthetic process executors. They never import a
// vendor CLI, read credentials, or make network/model requests.
async function fixture(t: test.TestContext, mode = '') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tongxu-relay-fixture-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, 'calls.ndjson'); await writeFile(trace, '');
  const script = `#!${process.execPath}
import fs from 'node:fs'; import readline from 'node:readline';
const trace=${JSON.stringify(trace)}, mode=${JSON.stringify(mode)}, claude=process.argv[1].includes('claude-fixture');
fs.appendFileSync(trace,JSON.stringify({kind:'process',claude,args:process.argv.slice(2)})+'\\n');
if(mode==='overflow')process.on('SIGTERM',()=>process.exit(0));
const emit=x=>{process.stdout.write(JSON.stringify(x)+'\\n');if(mode==='overflow'&&x.method==='turn/completed'&&x.params.turn.id==='fixture-turn-2')process.stderr.write(Buffer.alloc(17*1024*1024,120));};
if(process.argv.includes('--version')){console.log(claude?'2.1.233 (Claude Code)':'codex-cli 0.163.0-alpha.10.2');process.exit(0)}
if(claude&&process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));process.exit(0)}
if(claude){let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
fs.appendFileSync(trace,JSON.stringify({kind:'fixture-model-input',claude})+'\\n');
emit({type:'system',subtype:'init',session_id:'fixture-claude',model:'fixture',claude_code_version:'2.1.233',permissionMode:'dontAsk',apiKeySource:'none',tools:[],mcp_servers:[]});
emit({type:'assistant',session_id:'fixture-claude',aborted:mode==='aborted',parent_tool_use_id:null,message:{content:[{type:'text',text:'fixture only'}]}});
emit({type:'result',session_id:'fixture-claude',subtype:'success',is_error:false,terminal_reason:mode==='aborted'?'aborted_streaming':'completed',stop_reason:'end_turn',result:'明确标注的 fixture 影响报告。',usage:{input_tokens:0,output_tokens:0},total_cost_usd:0});});
}else{let thread,turn=0;const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='account/rateLimits/read')result={ordinaryUsageAllowed:mode!=='quota'};
if(m.method==='config/read')result={config:{mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(process.argv.filter(x=>x.startsWith('features.')).map(x=>[x.slice(9).split('=')[0],false]))}};
if(m.method==='thread/start'){const id='fixture-thread-'+process.pid;thread={id,sessionId:id,cwd:m.params.cwd,source:'appServer',cliVersion:'0.163.0-alpha.10.2',parentThreadId:null,forkedFromId:null};result={thread,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]};emit({id:m.id,result});emit({method:'thread/started',params:{thread}});return;}
if(m.method==='turn/start'){const id='fixture-turn-'+(++turn),item={id:id+'-answer',type:'agentMessage',phase:'final_answer',text:'合成夹具原文🙂 '+id};fs.appendFileSync(trace,JSON.stringify({kind:'fixture-model-input',id})+'\\n');emit({id:m.id,result:{turn:{id}}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id,status:'inProgress',items:[],rootTurnId:id}}});if(mode==='waiting'){emit({method:'thread/status/changed',params:{threadId:thread.id,status:{type:'active',activeFlags:['waitingOnUserInput']}}});return;}emit({method:'item/completed',params:{threadId:thread.id,turnId:id,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id,status:'completed',rootTurnId:id,items:[item],itemsView:'full',error:null}}});return;}
emit({id:m.id,result});});}
`;
  const codex = join(root, 'codex-fixture.mjs'), claude = join(root, 'claude-fixture.mjs');
  await writeFile(codex, script, { mode: 0o700 }); await writeFile(claude, script, { mode: 0o700 });
  const material = join(root, 'material.txt'), prompt = join(root, 'role.txt'), billing = join(root, 'billing.txt');
  await writeFile(material, 'This is synthetic fixture source, no real model evidence.'); await writeFile(prompt, 'Fixture role.'); await writeFile(billing, 'Synthetic billing evidence; no actual credentials or model are used.');
  const plan: RelayPlan = { schemaVersion: 1, executionKind: 'fixture', candidate: { repository: 'fixture/repo', pr: 1, H: 'a'.repeat(40), B: 'b'.repeat(40), target: 'fixture-base' }, scopeSource: 'fixture:scope', arrangementSource: 'fixture:arrangement', codexExecutable: codex, claudeExecutable: claude, disabledMcpServers: [], allowedInstructionSources: [], material: [{ path: material, sha256: hash(await readFile(material)) }], prompts: { reviewer: prompt, verifierImpact: prompt, verifierFact: prompt }, reviewInputs: ['Inspect the fixture.', 'Recheck the counterexample.'], billing: { mode: 'existing_subscription_only', evidence: billing, evidenceSha256: hash(await readFile(billing)), observedAt: new Date().toISOString(), usageCreditsEnabled: false }, timeoutMs: 2000 };
  const path = join(root, 'plan.json'); await writeFile(path, JSON.stringify(plan));
  return { root, plan, path, output: join(root, 'operation'), trace };
}

test('one entry hands actual fixture process results across roles and recovers without duplicate calls', async t => {
  const f = await fixture(t), result = await runRelay(f.path, f.output);
  assert.equal(result.status, 'completed'); assert.equal(result.executionKind, 'fixture'); assert.equal(result.manualReportCopyRequired, false);
  assert.equal(result.reviewer.turnIds.length, 2); assert.notEqual(result.reviewer.threadId, result.synthesis.threadId);
  const assembled=JSON.parse(await readFile(join(f.output,'inputs.json'),'utf8')),sent=(await readFile(join(f.output,'codex-review/stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(sent.find(x=>x.method==='thread/start').params.baseInstructions,assembled.promptAssemblies.reviewer.system);assert.ok(assembled.promptAssemblies.reviewer.parts.some((p:any)=>p.sha256==='08e491ed00e59294408d9a97dd6b64bfa1b5d1d3bd44ba51ada4a6c85585ebe9'));assert.equal(assembled.promptAssemblies.verifierImpact.role,'verifier_impact');assert.equal(assembled.promptAssemblies.verifierFact.role,'verifier_fact');
  const before = await readFile(f.trace, 'utf8'); assert.equal(before.split('\n').filter(x => x.includes('fixture-model-input')).length, 4);
  const handoff = JSON.parse(await readFile(join(f.output, 'handoff/input.json'), 'utf8')); assert.equal(handoff.delivery, 'not_sent'); assert.equal(handoff.sourceKind, 'fixture');
  assert.equal(JSON.parse(await readFile(join(f.output, 'delivery.json'), 'utf8')).status, 'receiver_returned_final');
  await rm(join(f.output, 'result.json')); await rm(join(f.output, 'claude-impact/completed.json'));
  const again = await runRelay(f.path, f.output); assert.deepEqual(again.synthesis, result.synthesis); assert.equal(await readFile(f.trace, 'utf8'), before);
  await writeFile(join(f.output, 'active.lock'), '{}'); await assert.rejects(runRelay(f.path, f.output), { code: 'EEXIST' }); assert.equal(await readFile(f.trace, 'utf8'), before);
});

test('historical empty-environment captures keep their original feature contract without weakening new launches', async t => {
  const f = await fixture(t); await runRelay(f.path, f.output);
  const path = join(f.root, 'historical-capture'); await cp(join(f.output, 'codex-review'), path, { recursive: true });
  const config = JSON.parse(await readFile(join(path, 'effective-config.json'), 'utf8'));
  delete config.config.features.stable_environment_tools;
  await writeFile(join(path, 'effective-config.json'), JSON.stringify(config));
  await assert.rejects(readCodexExecution(path), /unsupported_historical_feature_boundary/);
  const launch = JSON.parse(await readFile(join(path, 'launch.json'), 'utf8'));
  const index = launch.args.indexOf('features.stable_environment_tools=false');
  assert.ok(index > 0); launch.args.splice(index - 1, 2);
  await writeFile(join(path, 'launch.json'), JSON.stringify(launch));
  // Explicitly reconstruct the archived capture shape, rather than pretend a
  // newly capability-negotiated capture had the old feature contract.
  const binding=JSON.parse(await readFile(join(path,'binding.json'),'utf8'));
  binding.protocol='codex-app-server/0.163.0-alpha.10.2';delete binding.runtimeVersion;
  await writeFile(join(path,'binding.json'),JSON.stringify(binding));
  const identity=JSON.parse(await readFile(join(path,'executable.json'),'utf8'));
  delete identity.selection;delete identity.capabilities;
  await writeFile(join(path,'executable.json'),JSON.stringify(identity));
  const trace = await readFile(f.trace, 'utf8');
  assert.equal((await readCodexExecution(path)).status, 'final_observed');
  config.config.features.stable_environment_tools = true;
  await writeFile(join(path, 'effective-config.json'), JSON.stringify(config));
  await assert.rejects(readCodexExecution(path), /native_feature_boundary_not_applied/);
  delete config.config.features.stable_environment_tools; delete config.config.features.shell_tool;
  await writeFile(join(path, 'effective-config.json'), JSON.stringify(config));
  await assert.rejects(readCodexExecution(path), /native_feature_boundary_not_applied/);
  assert.equal(await readFile(f.trace, 'utf8'), trace);
});

test('partial, wrong-session/version, partial_answer and fatal-error raw results cannot be recovered as complete', async t => {
  const f = await fixture(t); await runRelay(f.path, f.output);
  const source = join(f.output, 'codex-review');
  for (const mutation of ['truncated', 'session', 'version', 'phase', 'fatal']) {
    const dest = join(f.root, mutation); await cp(source, dest, { recursive: true });
    const raw = await readFile(join(dest, 'stdout.ndjson'), 'utf8'), events = raw.trim().split('\n').map(x => JSON.parse(x));
    if (mutation === 'session') events.find(x => x.method === 'thread/started').params.thread.sessionId = 'wrong';
    if (mutation === 'version') events.find(x => x.method === 'thread/started').params.thread.cliVersion = '0.164.0';
    if (mutation === 'phase') for (const e of events) { if (e.method === 'item/completed') e.params.item.phase = 'partial_answer'; if (e.method === 'turn/completed') for (const i of e.params.turn.items) i.phase = 'partial_answer'; }
    if (mutation === 'fatal') { const b = JSON.parse(await readFile(join(dest, 'binding.json'), 'utf8')); events.push({ method: 'error', params: { threadId: b.threadId, turnId: b.turnIds[1], willRetry: false, error: { message: 'fixture fatal', codexErrorInfo: 'usageLimitExceeded' } } }); }
    const changed = mutation === 'truncated' ? raw.slice(0, -1) : events.map(x => JSON.stringify(x) + '\n').join('');
    await writeFile(join(dest, 'stdout.ndjson'), changed);
    const receipt = JSON.parse(await readFile(join(dest, 'completed.json'), 'utf8')); receipt.rawSha256 = hash(changed); await writeFile(join(dest, 'completed.json'), JSON.stringify(receipt));
    const capture = JSON.parse(await readFile(join(dest, 'capture-status.json'), 'utf8')); capture.files['stdout.ndjson'] = hash(changed); await writeFile(join(dest, 'capture-status.json'), JSON.stringify(capture));
    await assert.rejects(recoverStage(dest, 'codex'), /stage_raw_result_not_final/);
  }
  const unknown = join(f.root, 'unknown'); await mkdir(unknown); await writeFile(join(unknown, 'launch.json'), '{"status":"sent"}');
  await assert.rejects(recoverStage(unknown, 'codex'), /unknown_no_resend/);
});

test('continuation rechecks checkpoint and complete handoff, repairing only missing derived bytes', async t => {
  const f = await fixture(t); await runRelay(f.path, f.output);
  const before = await readFile(f.trace, 'utf8');
  for (const name of ['packet/capture.json', 'handoff/input.json', 'handoff/source.ndjson']) {
    const path = join(f.output, name), original = await readFile(path);
    let changed: string;
    if (name.endsWith('capture.json')) { const x = JSON.parse(original.toString()); x.rawBytes++; changed = JSON.stringify(x); }
    else if (name.endsWith('input.json')) { const x = JSON.parse(original.toString()); x.finalAnswers[0].turnId = 'wrong-turn'; x.candidate.H = 'f'.repeat(40); changed = JSON.stringify(x); }
    else changed = original.toString() + '{}\n';
    await writeFile(path, changed);
    await assert.rejects(runRelay(f.path, f.output), /capture_integrity_failed|handoff_receipt_mismatch/);
    assert.equal(await readFile(f.trace, 'utf8'), before);
    assert.equal(await readFile(path, 'utf8'), changed);
    await writeFile(path, original);
  }
  const path = join(f.output, 'handoff/input.json'), original = await readFile(path);
  await rm(path); await runRelay(f.path, f.output);
  assert.deepEqual(await readFile(path), original); assert.equal(await readFile(f.trace, 'utf8'), before);
  const stage = join(f.output, 'claude-impact');
  await rm(join(stage, 'completed.json'));
  const rawPath = join(stage, 'stdout.ndjson'), raw = await readFile(rawPath, 'utf8');
  await writeFile(rawPath, raw.replace('"claude_code_version":"2.1.233"', '"claude_code_version":"2.1.299"'));
  await assert.rejects(recoverStage(stage, 'claude'), /stage_capture_integrity_failed/);
  await writeFile(rawPath, raw.slice(0, -1));
  await assert.rejects(recoverStage(stage, 'claude'), /stage_capture_integrity_failed/);
});

test('Claude success labels cannot promote aborted or incomplete terminal semantics', async t => {
  const f = await fixture(t, 'aborted');
  await assert.rejects(runRelay(f.path, f.output), /stage_raw_result_not_final/);
  const before = await readFile(f.trace, 'utf8');
  assert.equal(before.split('\n').filter(x => x.includes('fixture-model-input')).length, 3);
  await assert.rejects(runRelay(f.path, f.output), /stage_raw_result_not_final/);
  assert.equal(await readFile(f.trace, 'utf8'), before);
});

test('transport failure survives restart even with complete final messages and exit zero', async t => {
  const f = await fixture(t, 'overflow');
  await assert.rejects(runRelay(f.path, f.output), /executor_output_limit/);
  assert.equal(JSON.parse(await readFile(join(f.output, 'codex-review/exit.json'), 'utf8')).code, 0);
  assert.equal(JSON.parse(await readFile(join(f.output, 'codex-review/capture-failure.json'), 'utf8')).reason, 'executor_output_limit');
  const before = await readFile(f.trace, 'utf8');
  assert.equal(before.split('\n').filter(x => x.includes('fixture-model-input')).length, 2);
  await assert.rejects(runRelay(f.path, f.output), /stage_capture_failed/);
  assert.equal(await readFile(f.trace, 'utf8'), before);
});

test('recovery binds the entire submitted input and turn permission policy', async t => {
  const f = await fixture(t); await runRelay(f.path, f.output);
  const dir = join(f.output, 'codex-review'), path = join(dir, 'stdin.ndjson');
  const sent = (await readFile(path, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
  const turn = sent.find(x => x.method === 'turn/start');
  turn.params.input.push({ type: 'text', text: 'unregistered extra material' }); turn.params.approvalPolicy = 'on-request';
  const bytes = sent.map(x => JSON.stringify(x) + '\n').join(''); await writeFile(path, bytes);
  // Reproduce malformed original submissions beyond the byte-integrity guard.
  const capture = JSON.parse(await readFile(join(dir, 'capture-status.json'), 'utf8')); capture.files['stdin.ndjson'] = hash(bytes); await writeFile(join(dir, 'capture-status.json'), JSON.stringify(capture));
  await assert.rejects(recoverStage(dir, 'codex'), /stage_submitted_input_mismatch/);
});

test('legacy completed captures reject additional steering rather than discarding it', async t => {
  const f = await fixture(t); await runRelay(f.path, f.output);
  const dir = join(f.output, 'codex-review'), path = join(dir, 'stdin.ndjson');
  // Explicit old-format fixture: completion receipt exists, per-stream capture
  // digests did not exist in the earlier executor. No native model is invoked.
  await rm(join(dir, 'capture-status.json'));
  await runRelay(f.path, f.output);
  const before = await readFile(f.trace, 'utf8'), original = await readFile(path, 'utf8');
  const sent = original.trim().split('\n').map(x => JSON.parse(x));
  const index = sent.findIndex(x => x.method === 'turn/start');
  sent.splice(index + 1, 0, { id: 100, method: 'turn/steer', params: { threadId: sent[index].params.threadId, expectedTurnId: 'fixture-turn-1', input: [{ type: 'text', text: 'unregistered steering' }] } });
  await writeFile(path, sent.map(x => JSON.stringify(x) + '\n').join(''));
  await assert.rejects(runRelay(f.path, f.output), /stage_submitted_request_sequence_mismatch/);
  assert.equal(await readFile(f.trace, 'utf8'), before);
  await writeFile(path, original); await runRelay(f.path, f.output);
  assert.equal(await readFile(f.trace, 'utf8'), before);
});

test('native waiting and quota stop progression; repeated entry starts no replacement process', async t => {
  for (const mode of ['waiting', 'quota']) {
    const f = await fixture(t, mode); await assert.rejects(runRelay(f.path, f.output), /ordinary_usage_unavailable|native_waiting_on_user_or_approval/);
    assert.equal(JSON.parse(await readFile(join(f.output, 'status.json'), 'utf8')).status, 'waiting');
    const before = await readFile(f.trace, 'utf8'); await assert.rejects(runRelay(f.path, f.output)); assert.equal(await readFile(f.trace, 'utf8'), before);
  }
});

test('raw process capture preserves split UTF-8 and rejects an incomplete JSON frame', async t => {
  const f = await fixture(t);
  for (const incomplete of [false, true]) {
    const dir = await newStage(join(f.root, 'bytes-' + incomplete));
    const code = `const b=Buffer.from(JSON.stringify({type:'fixture',text:'汉字🙂'})+${JSON.stringify(incomplete ? '' : '\n')});process.stdout.write(b.subarray(0,28));setTimeout(()=>process.stdout.end(b.subarray(28)),10);`;
    const child = new LiveProcess(dir, process.execPath, ['-e', code], f.root, process.env); child.process.stdin.end(); await child.closed;
    if (incomplete) assert.equal(child.failure, 'incomplete_output_frame'); else { assert.equal(child.failure, null); assert.equal(child.events[0].text, '汉字🙂'); }
  }
});
