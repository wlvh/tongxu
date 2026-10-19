import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash } from '../../src/snapshot.js';
import { prepareRepairFixture, runRepair, revokeRepair, type RepairConfig } from '../../src/repair.js';
import { git, tree, treeHash, acquireWorkspace, releaseWorkspace, RepairTools } from '../../src/repair-workspace.js';

const exec = promisify(execFile);
async function fixture(t: test.TestContext, mode = '') {
  const root = await mkdtemp(join(tmpdir(), 'tongxu-controlled-fixture-')); t.after(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, 'trace.ndjson'); await writeFile(trace, '');
  const code = `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const mode=${JSON.stringify(mode)},trace=${JSON.stringify(trace)},claude=process.argv[1].includes('claude');
const log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n');const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
log({kind:'process',claude,args:process.argv.slice(2)});
if(process.argv.includes('--version')){console.log(claude?'2.1.233 (Claude Code)':'codex-cli 0.163.0-alpha.10.2');process.exit(0)}
if(claude&&process.argv.includes('auth')){emit({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'});process.exit(0)}
if(claude){let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{log({kind:'model-input',role:'impact'});emit({type:'system',subtype:'init',session_id:'fixture-impact-'+process.pid,claude_code_version:'2.1.233',model:'fixture',permissionMode:'dontAsk',apiKeySource:'none',tools:[],mcp_servers:[]});emit({type:'assistant',session_id:'fixture-impact-'+process.pid,parent_tool_use_id:null,message:{content:[{type:'text',text:'Fixture impact analysis'}]}});emit({type:'result',session_id:'fixture-impact-'+process.pid,subtype:'success',is_error:false,terminal_reason:'completed',stop_reason:'end_turn',result:'Synthetic impact verification: bounded clamp correction is supported. This is fixture evidence only.',usage:{},total_cost_usd:0});});}
else{let thread,turn=0,context,current,stage,readHash;const rl=readline.createInterface({input:process.stdin});
const finish=(report)=>{const item={id:current+'-final',type:'agentMessage',phase:'final_answer',text:JSON.stringify(report)};emit({method:'item/completed',params:{threadId:thread.id,turnId:current,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:current,status:'completed',rootTurnId:current,items:[item],itemsView:'full',error:null}}});};
const tool=(name,args)=>{stage=name;log({kind:'tool-request',name});emit({id:'tool-'+current+'-'+name,method:'item/tool/call',params:{threadId:thread.id,turnId:current,callId:'call-'+process.pid+'-'+turn+'-'+name,tool:name,namespace:null,arguments:args}})};
rl.on('line',line=>{const m=JSON.parse(line);
if(!m.method&&typeof m.id==='string'&&m.id.startsWith('tool-')){if(m.error)return;const v=JSON.parse(m.result.contentItems[0].text);if(stage==='tongxu_read_file'){readHash=v.sha256;tool('tongxu_replace_file',{path:mode==='outside'?'README.md':'clamp.mjs',expectedSha256:readHash,text:'// repaired by synthetic agent fixture\\nexport function clamp(value,low,high){return Math.min(high,Math.max(low,value));}\\n'});}else if(stage==='tongxu_replace_file'){if(mode==='interrupt'){process.exit(7)}else tool('tongxu_run_tests',{});}else finish({candidateH:context.candidate.H,decision:'repaired',report:'Synthetic agent used registered write and test tools.'});return;}
if(!('id'in m))return;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='account/rateLimits/read')result={ordinaryUsageAllowed:true};
if(m.method==='config/read')result={config:{mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(process.argv.filter(x=>x.startsWith('features.')).map(x=>[x.slice(9).split('=')[0],false]))}};
if(m.method==='thread/start'){const id='fixture-thread-'+process.pid;thread={id,sessionId:id,cwd:m.params.cwd,source:'appServer',cliVersion:'0.163.0-alpha.10.2',parentThreadId:null,forkedFromId:null};emit({id:m.id,result:{thread,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]}});emit({method:'thread/started',params:{thread}});return;}
if(m.method==='turn/start'){current='fixture-turn-'+(++turn);const text=m.params.input[0].text;context=JSON.parse(text.slice(text.lastIndexOf('\\n')+1));log({kind:'model-input',role:m.params.outputSchema.properties.verdict?'review':'fact',turn});emit({id:m.id,result:{turn:{id:current}}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id:current,status:'inProgress',items:[],rootTurnId:current}}});if(m.params.outputSchema.properties.verdict){finish({candidateH:context.candidate.H,verdict:'PASS',report:'Independent synthetic review of current candidate.',findings:[]});}else if(text.startsWith('The host has now explicitly'))tool('tongxu_read_file',{path:'clamp.mjs'});else finish({candidateH:context.candidate.H,decision:'confirmed',report:'Synthetic fact verification confirms the fixture contract failure.'});return;}
emit({id:m.id,result});});}
`;
  const codex = join(root, 'codex-fixture.mjs'), claude = join(root, 'claude-fixture.mjs'); await writeFile(codex, code, { mode: 0o700 }); await writeFile(claude, code, { mode: 0o700 });
  const prompt = join(root, 'role.txt'), billing = join(root, 'billing.txt'); await writeFile(prompt, 'Explicit synthetic role test.'); await writeFile(billing, 'Synthetic subscription evidence; no vendor or model is invoked.');
  const config: RepairConfig = { codexExecutable: codex, claudeExecutable: claude, nodeExecutable: process.execPath, disabledMcpServers: [], allowedInstructionSources: [], prompts: { fact: prompt, impact: prompt, reviewer: prompt }, billing: { mode: 'existing_subscription_only', evidence: billing, evidenceSha256: hash(await readFile(billing)), observedAt: new Date().toISOString(), usageCreditsEnabled: false }, scopeSource: 'fixture:explicit-controlled-repair-authorization', timeoutMs: 3000, executionKind: 'fixture' };
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const prepared = await prepareRepairFixture(configPath, join(root, 'managed'));
  const plan = JSON.parse(await readFile(prepared.plan, 'utf8'));
  return { root, trace, ...prepared, workspace: plan.workspace, grantPath: plan.grant };
}
const modelInputs = (text: string) => text.split('\n').filter(x => x.includes('"kind":"model-input"')).length;

test('one controlled entry performs tool writes, actual tests, a new commit and a fresh review', async t => {
  const f = await fixture(t), before = await git(f.workspace, ['rev-parse', 'HEAD']), result = await runRepair(f.plan, f.operation);
  assert.equal(result.status, 'completed'); assert.equal(result.actualRepairPerformed, true); assert.notEqual(result.after.H, before); assert.equal(result.after.kind, 'local-git'); assert.equal(result.after.pr, null);
  assert.equal(result.manualRepairRequired, false); assert.equal(result.manualReportCopyRequired, false);
  const trace = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(trace), 5); assert.equal(trace.split('\n').filter(x => x.includes('"kind":"tool-request"')).length, 3);
  assert.deepEqual((result.data as any).changed, ['clamp.mjs']); assert.equal((result.data as any).tests.passed, true);
  const again = await runRepair(f.plan, f.operation); assert.deepEqual(again, result); assert.equal(await readFile(f.trace, 'utf8'), trace);
  await writeFile(join(f.operation, 'result.json'), JSON.stringify({ status: 'forged', automaticRepairImplemented: true }));
  assert.deepEqual(await runRepair(f.plan, f.operation), result); assert.equal(await readFile(f.trace, 'utf8'), trace);
});

test('no grant, changed candidate, active writer and unknown writer prevent any model dispatch', async t => {
  for (const mode of ['no-grant', 'changed', 'active', 'unknown']) {
    const f = await fixture(t);
    if (mode === 'no-grant') { const g = JSON.parse(await readFile(f.grantPath, 'utf8')); g.allowRepair = false; await writeFile(f.grantPath, JSON.stringify(g)); }
    if (mode === 'changed') await writeFile(join(f.workspace, 'clamp.mjs'), 'export const changed=true;');
    if (mode === 'active' || mode === 'unknown') await writeFile(join(f.workspace, '.git/tongxu-writer.json'), JSON.stringify({ operation: f.operation, controllerPid: mode === 'active' ? process.pid : 0, generation: 'existing', status: 'held' }));
    await assert.rejects(runRepair(f.plan, f.operation, true), /repair_not_authorized|candidate_or_uncommitted_state_changed|writer_active_or_unknown/);
    assert.equal(modelInputs(await readFile(f.trace, 'utf8')), 0);
  }
});

test('an out-of-scope dynamic write is rejected without modifying the file or starting review', async t => {
  const f = await fixture(t, 'outside'), before = await tree(f.workspace);
  await assert.rejects(runRepair(f.plan, f.operation), /write_outside_grant_or_stale_input/);
  assert.equal(treeHash(await tree(f.workspace)), treeHash(before)); assert.equal(modelInputs(await readFile(f.trace, 'utf8')), 4);
  await assert.rejects(runRepair(f.plan, f.operation), /writer_active_or_unknown/);
});

test('ended interrupted writer resumes from preserved changes without sending the original repair again', async t => {
  const f = await fixture(t, 'interrupt');
  const code = `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)});}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code]), /executor_closed_before_result/);
  const first = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(first), 4);
  const r = await runRepair(f.plan, f.operation, true);
  assert.equal(r.status, 'completed_recovered_candidate'); assert.equal((r.data as any).writerTerminal, 'unknown_or_interrupted'); assert.equal(r.actualRepairPerformed, true);
  const last = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(last), 5); assert.equal(last.split('\n').filter(x => x.includes('"name":"tongxu_replace_file"')).length, 1);
  await runRepair(f.plan, f.operation); assert.equal(await readFile(f.trace, 'utf8'), last);
});

test('revocation is checked by the actual write gate and preserves already applied source', async t => {
  const f = await fixture(t); await mkdir(f.operation, { mode: 0o700 });
  const g = JSON.parse(await readFile(f.grantPath, 'utf8')), current = await tree(f.workspace), lease = await acquireWorkspace(f.workspace, f.operation, false, g);
  const gate = new RepairTools(f.workspace, f.operation, g, lease, process.execPath, current); await gate.handoff('fixture-fact-session');
  await revokeRepair(f.operation, 'fixture:explicit-user-revocation');
  await assert.rejects(gate.call({ tool: 'tongxu_replace_file', callId: 'fixture-write-after-revoke', arguments: { path: 'clamp.mjs', expectedSha256: current['clamp.mjs']!.sha256, text: 'changed' } }), /revoked/);
  assert.equal(treeHash(await tree(f.workspace)), treeHash(current)); await releaseWorkspace(f.workspace, lease, 'revoked');
});
