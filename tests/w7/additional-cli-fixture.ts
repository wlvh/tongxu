import type test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {hash} from '../../src/snapshot.js';
import type {AdditionalProgram} from '../../src/ai-programs.js';

export async function additionalFixture(t:test.TestContext,tool:AdditionalProgram,mode='complete',responseKind:'message'|'formal'|'formal-profile'='message'){
 const f=await messageFixture(t);const binary=join(f.root,tool+'.mjs');
 const code=`#!${process.execPath}
import readline from 'node:readline';import fs from 'node:fs';
const responseKind=${JSON.stringify(responseKind)},tool=${JSON.stringify(tool)},mode=${JSON.stringify(mode)},trace=${JSON.stringify(f.trace)},emit=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
if(process.argv.includes('--version')){console.log('999.1.0');process.exit(0)}
if(process.argv.includes('--help')){console.log('acp --admin-policy --pure --version\\n  provider  existing account');process.exit(0)}
let session=(responseKind==='formal-profile'?'session_fixture-':'explicit-acp-fixture-')+process.pid,model='fixture/model-a',effort='max',turn=0;
const writeNativeProfile=()=>{if(responseKind!=='formal-profile'||mode==='profile-never')return;const home=process.env.KIMI_CODE_HOME;if(!home||!home.startsWith(${JSON.stringify(f.root+'/')}))throw Error('fixture_home_required');let system=fs.readFileSync(process.cwd()+'/.kimi-code/agents/agent.md','utf8');system=system.slice(system.indexOf('\\n---\\n')+5);const directory=home+'/sessions/fixture/'+session+'/agents/main';fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(directory+'/wire.jsonl',JSON.stringify({type:'profile.bind',agentId:'main',profileName:'agent',systemPrompt:system,activeToolNames:mode==='profile-tools'?['shell']:[],subagents:[],agentsMdPaths:[],modelAlias:model,thinkingEffort:effort})+'\\n');};
const options=()=>[{type:'select',id:'model',category:'model',currentValue:model,options:[{value:'fixture/model-a',name:'Fixture A'},{value:'fixture/model-next',name:'Future model'}]},{type:'select',id:'thinking',category:'thought_level',currentValue:effort,options:[{value:'max',name:'Max'},{value:'future-depth',name:'Future depth'}]}].filter(o=>mode!=='legacy-model'||o.category!=='model');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method)return;let result={};if(m.jsonrpc!=='2.0')process.exit(12);
if(m.method==='initialize')result={protocolVersion:1,agentInfo:{name:tool,version:'999.1.0'},agentCapabilities:{sessionCapabilities:{close:{}}}};
if(m.method==='session/new'&&mode==='auth-required'){emit({id:m.id,error:{code:-32000,message:'Authentication required'}});return;}
if(m.method==='session/new')result={sessionId:session,configOptions:options(),...(mode==='legacy-model'?{models:{currentModelId:model,availableModels:[{modelId:'fixture/model-a',name:'Fixture A'},{modelId:'fixture/model-next',name:'Future model'}]}}:{}),modes:{currentModeId:'tongxu',availableModes:[{id:'tongxu'}]}};
if(m.method==='session/new'){if(mode==='profile-delay')setTimeout(writeNativeProfile,150);else writeNativeProfile();}
if(m.method==='session/new'&&mode==='slow-bootstrap'){setTimeout(()=>emit({id:m.id,result}),300);return;}
if(m.method==='session/set_model'){model=m.params.modelId;writeNativeProfile();}
if(m.method==='session/set_config_option'){if(m.params.configId==='model')model=mode==='wrong-model'?'other':m.params.value;else {effort=m.params.value;if(mode==='effort-changes-model')model='fixture/model-a';}result={configOptions:options()};writeNativeProfile();}
if(m.method==='session/prompt'){
 const input=m.params.prompt[0].text,envelope=JSON.parse(responseKind==='message'?input:input.slice(input.lastIndexOf('\\n')+1));fs.appendFileSync(trace,JSON.stringify({kind:'input',tool,session,model,effort,messageId:envelope.messageId,...(responseKind==='message'?{}:{input})})+'\\n');turn++;
 if(mode==='partial')return;
 if(mode==='tool'){emit({id:'forbidden',method:'session/request_permission',params:{sessionId:session,toolCall:{title:'forbidden shell'},options:[]}});}
 if(!(mode==='unsolicited-between-inputs'&&turn===2))emit({method:'session/update',params:{sessionId:mode==='wrong-session'?'wrong':session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(responseKind==='message'?{messageId:envelope.messageId,consumed:envelope.replyReferences,report:'Explicit '+tool+' fixture complete material report '+turn}:{candidateH:envelope.material.candidate.H,batchSha256:envelope.batch.sha256,report:'Complete actual ACP fixture impact report: retained full text',assessments:(mode==='missing-finding'?[]:envelope.batch.findings).map(f=>({id:f.id,decision:'refuted',report:'Explicit code and test counterevidence for '+f.id,evidence:['sample.js','test.mjs']}))})}}}});
 result={stopReason:mode==='cancelled'?'cancelled':'end_turn'};
 }emit({id:m.id,result});
 if(m.method==='session/prompt'&&mode==='duplicate-response')emit({id:m.id,error:{code:-1,message:'conflicting response'}});
 if(m.method==='session/prompt'&&mode==='late-duplicate')setTimeout(()=>emit({id:m.id,error:{code:-1,message:'late conflicting response'}}),100);
 if(m.method==='session/prompt'&&mode==='unknown-response')emit({id:99999,result:{stopReason:'end_turn'}});
 if(m.method==='session/prompt'&&turn===1&&mode.startsWith('between-'))setTimeout(()=>{model='fixture/model-a';emit({method:'session/update',params:{sessionId:mode==='between-wrong-session'?'foreign':session,update:mode==='between-model'?{sessionUpdate:'config_option_update',configOptions:options()}:{sessionUpdate:'tool_call',toolCallId:'forbidden',status:'completed'}}});},50);
 if(mode==='unsolicited-between-inputs'&&m.method==='session/prompt'&&turn===1)setTimeout(()=>emit({method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({messageId:'second',consumed:[],report:'Unsolicited text before second input: never a second result'})}}}}),50);
});
`;
 await writeFile(binary,code,{mode:0o700});f.plan.participants=[{...f.plan.participants[0]!,id:'owner',role:'issue_owner',tool,executable:binary,executableSha256:hash(code),parent:null,aiModel:{model:'fixture/model-next',effort:'future-depth'}}];
 f.plan.messages=[{id:'first',from:null,to:'owner',body:'Inspect supplied fixed material.',replies:[]},{id:'second',from:null,to:'owner',body:'Consider a counterexample using the complete first report.',replies:['first']}];f.plan.timeoutMs=500;await f.write();return {...f,binary};
}
