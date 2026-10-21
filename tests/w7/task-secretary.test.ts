import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {controlFixture} from './task-controls-fixture.js';
import {runSecretary,type SecretaryPlan} from '../../src/secretary.js';
import {SecretaryTools} from '../../src/secretary-tools.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

async function fixture(t:test.TestContext,mode='normal'){
  const f=await controlFixture(t),trace=join(f.root,'secretary-contacts.ndjson'),exe=join(f.root,'task-secretary-fixture.mjs');await writeFile(trace,'');
  const script=`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const mode=${JSON.stringify(mode)},trace=${JSON.stringify(trace)},emit=x=>process.stdout.write(JSON.stringify(x)+'\\n'),log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.163.0-alpha.10.2');process.exit(0)}
let thread,turn,context,serial=0,observations=[];
const tool=(name,args)=>{serial++;emit({id:'call-'+serial,method:'item/tool/call',params:{threadId:thread.id,turnId:turn,namespace:null,callId:'call-'+serial,tool:name,arguments:args}})};
const finish=()=>{const report={candidateH:context.candidate.H,report:'明确模型夹具：已通过有限联系工具让原负责人处理请求，并读回完整原报告。不是生产接受。',observationIds:observations.map(o=>o.observationId)},item={id:'final',type:'agentMessage',phase:'final_answer',text:JSON.stringify(report)};emit({method:'item/completed',params:{threadId:thread.id,turnId:turn,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:turn,status:'completed',rootTurnId:turn,items:[item],itemsView:'full',error:null}}});};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method&&typeof m.id==='string'){if(m.error)return;const o=JSON.parse(m.result.contentItems[0].text);observations.push(o);log({kind:'observation',tool:serial,value:o});if(serial===1)tool(mode==='forbidden'?'tongxu_merge':'tongxu_contact_task',mode==='forbidden'?{}:{action:mode==='outside'?'unlisted':'contact'});else if(serial===2)tool('tongxu_contact_report',{action:'contact'});else if(serial===3)tool('tongxu_task_status',{});else finish();return;}if(!('id'in m))return;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='account/rateLimits/read')result={ordinaryUsageAllowed:true};
if(m.method==='config/read')result={config:{mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(process.argv.filter(x=>x.startsWith('features.')).map(x=>[x.slice(9).split('=')[0],x.split('=')[1]==='true']))}};
if(m.method==='thread/start'){thread={id:'secretary-contact-'+process.pid,sessionId:'secretary-contact-'+process.pid,cwd:m.params.cwd,source:'appServer',cliVersion:'0.163.0-alpha.10.2',parentThreadId:null,forkedFromId:null};log({kind:'tools',tools:m.params.dynamicTools.map(t=>t.name)});emit({id:m.id,result:{thread,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]}});emit({method:'thread/started',params:{thread}});return;}
if(m.method==='turn/start'){turn='contact-turn';const text=m.params.input[0].text;context=JSON.parse(text.slice(text.lastIndexOf('\\n')+1));log({kind:'input'});emit({id:m.id,result:{turn:{id:turn}}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id:turn,status:'inProgress',items:[],rootTurnId:turn}}});tool('tongxu_contact_options',{});return;}emit({id:m.id,result});});
`;
  await writeFile(exe,script,{mode:0o700});const common=join(f.root,'secretary-common.txt'),role=join(f.root,'secretary-role.txt');await writeFile(common,'Explicit common fixture boundary.');await writeFile(role,'Explicit coordinating secretary fixture; only listed contact tools.');const c=f.q.tasks().current(f.task).manifest.candidate,candidate={repository:c.repository,pr:null,H:c.H,B:c.B,target:c.targetRef,kind:'development-task' as const,taskId:f.task,sourceSha256:c.sourceSha256};
  const p:SecretaryPlan={schemaVersion:1,kind:'tongxu-task-secretary',store:f.store,item:f.task,candidate,codexExecutable:exe,codexSha256:hash(await readFile(exe)),prompts:await Promise.all([common,role].map(async path=>({path,sha256:hash(await readFile(path))}))),question:'联系原负责人完成已装配的核查，再读回其完整原报告，说明实际状态。',scopeSource:'explicit fixture scope',arrangementSource:'explicit fixture secretary contact',disabledMcpServers:[],allowedInstructionSources:[],billing:{mode:'existing_subscription_only',evidence:f.request.billing.evidence,evidenceSha256:f.request.billing.evidenceSha256,observedAt:f.request.billing.observedAt,ordinaryUsageRequired:true},timeoutMs:6000,executionKind:'fixture',taskControls:{path:f.catalogPath,sha256:hash(await readFile(f.catalogPath)),source:'task'}},path=join(f.root,'secretary-plan.json');await writeFile(path,canonical(p));return {...f,p,path,output:join(f.root,'secretary-run'),trace,logs:async()=>(await readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))};
}

test('secretary actually uses fixed contact and full-report tools; direct UI observes the same returned request',async t=>{
  const f=await fixture(t),result=await runSecretary(f.path,f.output);assert.equal(result.status,'completed');assert.equal(result.contactToolCalls,1);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal((await f.controls.state())[0]!.available,true);assert.equal(((await f.controls.state())[0] as any).phase,'returned');
  const logs=await f.logs(),tools=logs.find(x=>x.kind==='tools').tools;assert.deepEqual(tools,['tongxu_task_status','tongxu_operation_status','tongxu_contact_options','tongxu_contact_task','tongxu_contact_report']);const rawReport=await f.controls.report('contact'),read=logs.find(x=>x.kind==='observation'&&x.tool===3).value.data;assert.equal(read.report,rawReport.report);assert.equal(read.reportSha256,rawReport.reportSha256);
  const again=await runSecretary(f.path,f.output);assert.equal(again.newModelTasks,0);assert.deepEqual(await f.logs(),logs);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
});

test('secretary cannot turn a report or guessed action into a new tool, destination or Owner approval',async t=>{
  for(const mode of ['forbidden','outside']){const f=await fixture(t,mode);await assert.rejects(runSecretary(f.path,f.output),/permission_mismatch|action_not_selected/);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,0);await assert.rejects(runSecretary(f.path,f.output));assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);}
});

test('a secretary tool losing its live call before registration cannot queue a contact',async t=>{
  const f=await fixture(t),dir=join(f.root,'gate-only');await mkdir(dir);const gate=new SecretaryTools(f.store,f.task,f.p.candidate,dir,f.controls);await assert.rejects(gate.call({tool:'tongxu_contact_task',arguments:{action:'contact'},callId:'late'},()=>{throw new Error('native_tool_request_after_terminal');}),/after_terminal/);assert.equal(f.q.taskInbox().status(f.task).length,0);assert.equal((await f.calls()).length,0);
});

test('read-only secretary rejects contact configuration instead of silently gaining actions',async t=>{
  const f=await fixture(t);await writeFile(f.path,canonical({...f.p,kind:'tongxu-readonly-secretary'}));await assert.rejects(runSecretary(f.path,f.output),/secretary_task_controls_invalid/);assert.equal((await f.logs()).length,0);assert.equal((await f.calls()).length,0);
});
