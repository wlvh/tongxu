import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeControlFixture} from './native-control-fixture.js';
import {hash} from '../../src/snapshot.js';

/** Persistent native history is an explicit local protocol fixture. The
 * real runtime must request resume/read; this script does not invent a start. */
export async function nativeResumeFixture(t:test.TestContext){
  const f=await nativeControlFixture(t),history=join(f.root,'native-history.json'),readOverride=join(f.root,'native-read-override.json');let code=await readFile(f.codex,'utf8');
  code=code.replace('let active=null;let thread,turn=0,initialized=false;',`const history=${JSON.stringify(history)};const save=()=>{const all=fs.existsSync(history)?JSON.parse(fs.readFileSync(history,'utf8')):{};all[thread.id]=thread;fs.writeFileSync(history,JSON.stringify(all));};let active=null;let thread,turn=0,initialized=false;`);
  const start="if(m.method==='thread/start'){";if(!code.includes(start))throw new Error('fixture_start_missing');
  code=code.replace(start,`if(m.method==='thread/resume'){thread=JSON.parse(fs.readFileSync(history,'utf8'))[m.params.threadId];if(!thread){emit({id:m.id,error:{code:-32602,message:'unknown fixture thread'}});return;}turn=thread.turns.length;fs.appendFileSync(trace,JSON.stringify({kind:'resume',threadId:thread.id,sessionId:thread.sessionId})+'\\n');emit({id:m.id,result:{thread,model:thread.model,reasoningEffort:thread.reasoningEffort,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]}});return;}
  if(m.method==='thread/read'){emit({id:m.id,result:{thread:{...thread,status:{type:thread.active?'active':'idle'},turns:thread.turns,...(fs.existsSync(${JSON.stringify(readOverride)})?JSON.parse(fs.readFileSync(${JSON.stringify(readOverride)},'utf8')):{})}}});return;}
  `+start);
  code=code.replace("ephemeral:m.params.ephemeral,source:'appServer'","ephemeral:m.params.ephemeral,model:m.params.model??'fixture',reasoningEffort:m.params.config?.model_reasoning_effort??'high',turns:[],active:false,source:'appServer'");
  const record="forkedFromId:null};emit({id:m.id,result:{thread";if(!code.includes(record))throw new Error('fixture_thread_metadata_missing');code=code.replace(record,"forkedFromId:null};save();fs.appendFileSync(trace,JSON.stringify({kind:'start',threadId:thread.id})+'\\n');emit({id:m.id,result:{thread");
  code=code.replace('active={x,id};','active={x,id};thread.active=true;save();');
  code=code.replaceAll('active=null;return;',"thread.turns.push({id,status:m.method==='turn/interrupt'?'interrupted':'completed'});thread.active=false;save();active=null;return;");
  await writeFile(f.codex,code,{mode:0o700});f.request.participant.executableSha256=hash(code);f.request.timeoutMs=12000;f.controls=await f.reload();return {...f,history,readOverride};
}
