import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {runMessages} from '../../src/messages.js';
import {inspectUnstartedDialog,inspectDialogCapture} from '../../src/message-runtime.js';
import {hash} from '../../src/snapshot.js';
import {ExtraCliSession,parseAcpPrompt,acpModels,readConfigJson} from '../../src/additional-cli.js';
import {parseMessagePlan} from '../../src/message-contract.js';
import type {AdditionalProgram} from '../../src/ai-programs.js';
import {AISettings,participantWithAI,withAIPreferences} from '../../src/ai-settings.js';

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
if(m.method==='session/new'&&mode==='auth-required'){emit({id:m.id,error:{code:-32000,message:'Authentication required'}});return;}
if(m.method==='session/new')result={sessionId:session,configOptions:options(),modes:{currentModeId:'tongxu',availableModes:[{id:'tongxu'}]}};
if(m.method==='session/set_config_option'){if(m.params.configId==='model')model=mode==='wrong-model'?'other':m.params.value;else {effort=m.params.value;if(mode==='effort-changes-model')model='fixture/model-a';}result={configOptions:options()};}
if(m.method==='session/prompt'){
 const envelope=JSON.parse(m.params.prompt[0].text);fs.appendFileSync(trace,JSON.stringify({kind:'input',tool,session,model,effort,messageId:envelope.messageId})+'\\n');turn++;
 if(mode==='partial')return;
 if(mode==='tool'){emit({id:'forbidden',method:'session/request_permission',params:{sessionId:session,toolCall:{title:'forbidden shell'},options:[]}});}
 if(!(mode==='unsolicited-between-inputs'&&turn===2))emit({method:'session/update',params:{sessionId:mode==='wrong-session'?'wrong':session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({messageId:envelope.messageId,consumed:envelope.replyReferences,report:'Explicit '+tool+' fixture complete material report '+turn})}}}});
 result={stopReason:mode==='cancelled'?'cancelled':'end_turn'};
 }emit({id:m.id,result});
 if(mode==='unsolicited-between-inputs'&&m.method==='session/prompt'&&turn===1)setTimeout(()=>emit({method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({messageId:'second',consumed:[],report:'Unsolicited text before second input: never a second result'})}}}}),50);
});
`;
 await writeFile(binary,code,{mode:0o700});f.plan.participants=[{...f.plan.participants[0]!,id:'owner',role:'issue_owner',tool,executable:binary,executableSha256:hash(code),parent:null,aiModel:{model:'fixture/model-next',effort:'future-depth'}}];
 f.plan.messages=[{id:'first',from:null,to:'owner',body:'Inspect supplied fixed material.',replies:[]},{id:'second',from:null,to:'owner',body:'Consider a counterexample using the complete first report.',replies:['first']}];f.plan.timeoutMs=500;await f.write();return {...f,binary};
}
for(const tool of ['kimi','gemini','opencode'] as const)test(tool+' executes two bounded messages, preserves actual session/selection and replays without another input',async t=>{
 const f=await fixture(t,tool),scope={account:{id:7},repository:{id:1,nodeId:'R_1',fullName:'fixture/reception'}},config={root:join(f.root,'settings'),configured:[{tool,path:f.binary}],disabledMcpServers:[]};
 const probe:Parameters<typeof AISettings.open>[1]=async(program,path,directory)=>({id:hash(path),tool:program,path,version:'999.1.0',available:path===f.binary,reason:null,authentication:'subscription',models:[{id:'fixture/model-next',name:'Future model',resolvedId:null,description:'Explicit test model',efforts:['future-depth'],defaultEffort:'future-depth',isDefault:true}],observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:false,ownedControl:false},evidence:directory});
 let settings=await AISettings.open(config,probe);await settings.scan(scope);const providerId=hash(f.binary);
 await settings.change(scope,{revision:0,role:'issue_owner',choice:{providerId,model:'fixture/model-next',effort:'future-depth'}});
 await assert.rejects(()=>settings.change(scope,{revision:1,role:'secretary',choice:{providerId,model:'fixture/model-next',effort:'future-depth'}}),/tools_not_supported/);
 await settings.close();settings=await AISettings.open(config,probe);const snapshot=settings.snapshot(scope);await settings.close();
 const original={...f.plan.participants[0]!,tool:'codex' as const,executable:f.codex,aiModel:undefined};
 f.plan.participants[0]=withAIPreferences(snapshot,()=>participantWithAI(original,scope.repository.fullName).participant);await f.write();
 const result=await runMessages(f.store,f.path);assert.equal(result.completed,true,JSON.stringify(result.problems));const calls=await f.calls();assert.equal(calls.filter(c=>c.kind==='input').length,2);assert.equal(new Set(calls.map(c=>c.session)).size,1);assert.ok(calls.every(c=>c.model==='fixture/model-next'&&c.effort==='future-depth'));
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
 assert.equal(readConfigJson(Buffer.from('{"maxSessionTurns":-1}')).maxSessionTurns,-1);
 assert.deepEqual(readConfigJson(Buffer.from('{/* native config */"security":{"auth":{"selectedType":"oauth-personal",}},}')),{security:{auth:{selectedType:'oauth-personal'}}});
 for(const text of ['{"x":process.exit()}','{"__proto__":{"allowed":true}}','{"a":1,"a":2}','{"x":(()=>1)()}'])assert.throws(()=>readConfigJson(Buffer.from(text)));
});

test('missing original exit or launch cannot classify an ACP bootstrap as safely unstarted',async t=>{
 const f=await fixture(t,'kimi','wrong-model');const result=await runMessages(f.store,f.path);const dir=result.runtimes[0]!.started.directory,spec=JSON.parse(await readFile(join(dir,'runtime-spec.json'),'utf8'));
 const exit=await readFile(join(dir,'exit.json'));await rm(join(dir,'exit.json'));await assert.rejects(()=>inspectUnstartedDialog(spec),/process_unknown/);await writeFile(join(dir,'exit.json'),exit);
 const launch=await readFile(join(dir,'launch.json'));await rm(join(dir,'launch.json'));await assert.rejects(()=>inspectUnstartedDialog(spec),/launch_unknown/);await writeFile(join(dir,'launch.json'),launch);assert.equal((await f.calls()).length,0);
});
test('altered route scope or a contradictory initialization record cannot be consumed from an intact stream',async t=>{
 const f=await fixture(t,'kimi');const result=await runMessages(f.store,f.path);assert.equal(result.completed,true);const dir=result.runtimes[0]!.started.directory,spec=JSON.parse(await readFile(join(dir,'runtime-spec.json'),'utf8')),sent=(await readFile(join(dir,'stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x)),expected=sent.filter(m=>m.method==='session/prompt').map(m=>JSON.parse(m.params.prompt[0].text));
 const route=await readFile(join(dir,'route.json'));await writeFile(join(dir,'route.json'),JSON.stringify({...JSON.parse(route.toString()),writePermission:true}));assert.equal((await inspectDialogCapture(spec,expected)).error,'message_original_execution_binding_changed');await writeFile(join(dir,'route.json'),route);
 const init=JSON.parse(await readFile(join(dir,'initialize.json'),'utf8'));await writeFile(join(dir,'initialize.json'),JSON.stringify({...init,protocolVersion:99}));assert.equal((await inspectDialogCapture(spec,expected)).error,'external_cli_initialize_changed');
});

test('authentication-required bootstrap stays unstarted and never opens a login flow or sends input',async t=>{
 const f=await fixture(t,'kimi','auth-required');const result=await runMessages(f.store,f.path);assert.equal(result.completed,false);assert.ok(result.problems.some(p=>p.reason==='ai_subscription_not_confirmed'));assert.equal((await f.calls()).length,0);
});

test('the original synchronous authority check runs after asynchronous profile inspection and prevents dispatch after revocation',async t=>{
 const f=await fixture(t,'kimi'),session=await ExtraCliSession.open('kimi',f.binary,join(f.root,'revoked'), 'bounded reader',true);
 await session.select(f.plan.participants[0]!.aiModel!);let authorized=true,checked=false;
 // The asynchronous profile read represents time during which the operator can
 // revoke the original authority. No real account or model is involved.
 (session as any).verifyProfile=async()=>{await new Promise(resolve=>setImmediate(resolve));authorized=false;};
 await assert.rejects(()=>session.prompt(JSON.stringify({messageId:'revoked',replyReferences:[]}),500,()=>{checked=true;if(!authorized)throw Error('original_authority_revoked');}),/original_authority_revoked/);
 await session.close();assert.equal(checked,true);assert.equal((await f.calls()).length,0);assert.ok(!(await readFile(join(session.directory,'stdin.ndjson'),'utf8')).includes('session/prompt'));
});

test('a premature second answer cannot become a complete second result during live execution or closed replay',async t=>{
 const f=await fixture(t,'kimi','unsolicited-between-inputs');f.plan.messages[1]!.replies=[];await f.write();
 const original=ExtraCliSession.prototype.prompt;t.mock.method(ExtraCliSession.prototype,'prompt',async function(this:ExtraCliSession,...args:Parameters<ExtraCliSession['prompt']>){if(JSON.parse(args[0]).messageId==='second')await this.rpc.waitFor(m=>m.params?.update?.content?.text?.includes('Unsolicited text before second input'),1000);return original.apply(this,args);});
 const result=await runMessages(f.store,f.path);assert.equal(result.completed,false);assert.ok(result.problems.some(p=>p.reason==='external_cli_final_missing'));assert.equal(result.messages.find(m=>m.id==='second')?.reply??null,null);
 const calls=await f.calls();assert.equal(calls.length,2);const again=await runMessages(f.store,f.path,true);assert.equal(again.completed,false);assert.equal(again.messages.find(m=>m.id==='second')?.reply??null,null);assert.deepEqual(await f.calls(),calls);
});

for(const tool of ['gemini','opencode'] as const)test(tool+' rejects a model changed by the effort response before any input',async t=>{
 const f=await fixture(t,tool,'effort-changes-model');const result=await runMessages(f.store,f.path);assert.equal(result.completed,false);assert.ok(result.problems.some(p=>p.reason==='ai_selected_model_not_applied'));assert.equal((await f.calls()).length,0);
});

test('grouped missing launch and process streams with surviving session evidence remain unknown',async t=>{
 const f=await fixture(t,'kimi','wrong-model');const result=await runMessages(f.store,f.path),dir=result.runtimes[0]!.started.directory,spec=JSON.parse(await readFile(join(dir,'runtime-spec.json'),'utf8'));
 for(const name of ['launch.json','process.json','stdin.ndjson','stdout.ndjson','stderr.txt','exit.json','capture-status.json'])await rm(join(dir,name));
 assert.ok(await readFile(join(dir,'session.json')));await assert.rejects(()=>inspectUnstartedDialog(spec),/launch_unknown/);
 const before=await f.calls();const again=await runMessages(f.store,f.path);assert.equal(again.completed,false);assert.deepEqual(await f.calls(),before);assert.equal(again.runtimes.length,1);
});

test('missing or shifted per-input output boundaries cannot validate a closed capture',async t=>{
 const f=await fixture(t,'kimi');const result=await runMessages(f.store,f.path);assert.equal(result.completed,true);const dir=result.runtimes[0]!.started.directory,spec=JSON.parse(await readFile(join(dir,'runtime-spec.json'),'utf8')),sent=(await readFile(join(dir,'stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x)),expected=sent.filter(m=>m.method==='session/prompt').map(m=>JSON.parse(m.params.prompt[0].text));
 const path=join(dir,'prompt-boundaries.ndjson'),raw=await readFile(path),rows=raw.toString().trim().split('\n').map(x=>JSON.parse(x));await rm(path);assert.equal((await inspectDialogCapture(spec,expected)).error,'external_cli_input_boundary_missing');
 rows[1].stdoutBytes++;await writeFile(path,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');assert.equal((await inspectDialogCapture(spec,expected)).error,'external_cli_input_boundary_changed');
});
