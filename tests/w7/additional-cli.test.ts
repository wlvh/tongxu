import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {runMessages} from '../../src/messages.js';
import {hash} from '../../src/snapshot.js';
import {ExtraCliSession,parseAcpPrompt,acpModels,readConfigJson} from '../../src/additional-cli.js';
import {parseMessagePlan} from '../../src/message-contract.js';
import type {AdditionalProgram} from '../../src/ai-programs.js';

async function fixture(t:test.TestContext,tool:AdditionalProgram,mode='complete'){
 const f=await messageFixture(t);const binary=join(f.root,tool+'.mjs');
 const code=`#!${process.execPath}
import readline from 'node:readline';import fs from 'node:fs';
const tool=${JSON.stringify(tool)},mode=${JSON.stringify(mode)},trace=${JSON.stringify(f.trace)},emit=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
if(process.argv.includes('--version')){console.log('999.1.0');process.exit(0)}
if(process.argv.includes('--help')){console.log('acp --admin-policy --pure --version');process.exit(0)}
let session='explicit-acp-fixture-'+process.pid,model='fixture/model-a',effort='max',turn=0;
const options=()=>[{type:'select',id:'model',category:'model',currentValue:model,options:[{value:'fixture/model-a',name:'Fixture A'},{value:'fixture/model-next',name:'Future model'}]},{type:'select',id:'thinking',category:'thought_level',currentValue:effort,options:[{value:'max',name:'Max'},{value:'future-depth',name:'Future depth'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method)return;let result={};if(m.jsonrpc!=='2.0')process.exit(12);
if(m.method==='initialize')result={protocolVersion:1,agentInfo:{name:tool,version:'999.1.0'},agentCapabilities:{sessionCapabilities:{close:{}}}};
if(m.method==='session/new')result={sessionId:session,configOptions:options(),modes:{currentModeId:'tongxu',availableModes:[{id:'tongxu'}]}};
if(m.method==='session/set_config_option'){if(m.params.configId==='model')model=mode==='wrong-model'?'other':m.params.value;else effort=m.params.value;result={configOptions:options()};}
if(m.method==='session/prompt'){
 const envelope=JSON.parse(m.params.prompt[0].text);fs.appendFileSync(trace,JSON.stringify({kind:'input',tool,session,model,effort,messageId:envelope.messageId})+'\\n');turn++;
 if(mode==='partial')return;
 if(mode==='tool'){emit({id:'forbidden',method:'session/request_permission',params:{sessionId:session,toolCall:{title:'forbidden shell'},options:[]}});}
 emit({method:'session/update',params:{sessionId:mode==='wrong-session'?'wrong':session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({messageId:envelope.messageId,consumed:envelope.replyReferences,report:'Explicit '+tool+' fixture complete material report '+turn})}}}});
 result={stopReason:mode==='cancelled'?'cancelled':'end_turn'};
 }emit({id:m.id,result});
});
`;
 await writeFile(binary,code,{mode:0o700});f.plan.participants=[{...f.plan.participants[0]!,id:'owner',role:'issue_owner',tool,executable:binary,executableSha256:hash(code),parent:null,aiModel:{model:'fixture/model-next',effort:'future-depth'}}];
 f.plan.messages=[{id:'first',from:null,to:'owner',body:'Inspect supplied fixed material.',replies:[]},{id:'second',from:null,to:'owner',body:'Consider a counterexample using the complete first report.',replies:['first']}];f.plan.timeoutMs=500;await f.write();return {...f,binary};
}
for(const tool of ['kimi','gemini','opencode'] as const)test(tool+' executes two bounded messages, preserves actual session/selection and replays without another input',async t=>{
 const f=await fixture(t,tool);const result=await runMessages(f.store,f.path);assert.equal(result.completed,true,JSON.stringify(result.problems));const calls=await f.calls();assert.equal(calls.filter(c=>c.kind==='input').length,2);assert.equal(new Set(calls.map(c=>c.session)).size,1);assert.ok(calls.every(c=>c.model==='fixture/model-next'&&c.effort==='future-depth'));
 const again=await runMessages(f.store,f.path,true);assert.equal(again.completed,true,JSON.stringify(again.problems));assert.deepEqual(await f.calls(),calls);
 const native=result.runtimes[0]!.started.directory;const sent=(await readFile(join(native,'stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.equal(sent.filter(x=>x.method==='session/prompt').length,2);assert.ok(sent.every(x=>!['authenticate','session/load','session/resume'].includes(x.method)));
});
for(const mode of ['wrong-session','cancelled','partial','tool'])test('ACP '+mode+' is not a complete report, and re-entry never resends the paid input',async t=>{
 const f=await fixture(t,'kimi',mode);const result=await runMessages(f.store,f.path);assert.equal(result.completed,false);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);const calls=await f.calls();await runMessages(f.store,f.path,true);assert.deepEqual(await f.calls(),calls);
});
test('a substituted model is rejected before the first prompt; unsupported role profiles cannot start',async t=>{
 const f=await fixture(t,'kimi','wrong-model');const result=await runMessages(f.store,f.path);assert.equal(result.completed,false);assert.equal((await f.calls()).length,0);f.plan.participants[0]!.role='verifier_fact';assert.throws(()=>parseMessagePlan(Buffer.from(JSON.stringify(f.plan))),/additional_cli_message_profile_required/);
});
test('ACP discovery reads a per-model catalog and efforts without a prompt',async t=>{
 const f=await fixture(t,'kimi'),directory=join(f.root,'metadata'),session=await ExtraCliSession.open('kimi',f.binary,directory,'metadata only',true);const models=await session.models();assert.deepEqual(models.map(m=>m.id),['fixture/model-a','fixture/model-next']);assert.deepEqual(models[1]!.efforts,['max','future-depth']);await session.close();assert.equal((await f.calls()).length,0);assert.ok(!(await readFile(join(directory,'stdin.ndjson'),'utf8')).includes('session/prompt'));
});
test('unknown, cancelled, tool-bearing and wrong-session streams cannot become final results',()=>{
 const event=(sessionId:string,sessionUpdate:string)=>({method:'session/update',params:{sessionId,update:{sessionUpdate,content:{type:'text',text:'answer'}}}});
 assert.throws(()=>parseAcpPrompt([event('x','agent_message_chunk')],'x',{stopReason:'max_tokens'}),/incomplete/);
 assert.throws(()=>parseAcpPrompt([event('wrong','agent_message_chunk')],'x',{stopReason:'end_turn'}),/wrong_session/);
 assert.throws(()=>parseAcpPrompt([event('x','tool_call')],'x',{stopReason:'end_turn'}),/tool_boundary/);
 assert.throws(()=>parseAcpPrompt([],'x',{stopReason:'end_turn'}),/final_missing/);
 assert.throws(()=>acpModels({configOptions:[{type:'select',category:'model',id:'model',currentValue:'a',options:[{value:'a',name:'A'},{value:'a',name:'duplicate'}]}]}),/invalid/);
});

test('configuration metadata accepts JSON comments without executing expressions or accepting prototype keys',()=>{
 assert.deepEqual(readConfigJson(Buffer.from('{/* native config */"security":{"auth":{"selectedType":"oauth-personal",}},}')),{security:{auth:{selectedType:'oauth-personal'}}});
 for(const text of ['{"x":process.exit()}','{"__proto__":{"allowed":true}}','{"a":1,"a":2}','{"x":(()=>1)()}'])assert.throws(()=>readConfigJson(Buffer.from(text)));
});
