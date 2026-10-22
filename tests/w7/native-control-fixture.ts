import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {controlFixture} from './task-controls-fixture.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

/** Actual local child/RPC and SQLite; the model and account are explicit
 * fixtures. It intentionally waits for an exact control, never a timer PASS. */
export async function nativeControlFixture(t:test.TestContext,mode='complete'){
  const f=await controlFixture(t,mode);let code=await readFile(f.codex,'utf8');
  code=code.replace('let thread,turn=0,initialized=false;','let active=null;let thread,turn=0,initialized=false;');
  code=code.replace("thread={id,sessionId:id,cwd:m.params.cwd,source:'appServer'","thread={id,sessionId:id,cwd:m.params.cwd,ephemeral:m.params.ephemeral,source:'appServer'");
  const at="if(m.method==='turn/start'){";if(!code.includes(at))throw new Error('fixture_original_script_changed');
  code=code.replace(at,`if(m.method==='turn/start'){
    const x=JSON.parse(m.params.input[0].text),id='owned-turn-'+(++turn);active={x,id};
    fs.appendFileSync(trace,JSON.stringify({kind:'input',claude:false,messageId:x.messageId,session:thread.sessionId,turn:id})+'\\n');
    emit({id:m.id,result:{turn:{id}}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id,status:'inProgress',items:[],rootTurnId:id}}});return;
  }
  if(m.method==='turn/steer'||m.method==='turn/interrupt'){
    if(!active||m.params.threadId!==thread.id||(m.params.expectedTurnId??m.params.turnId)!==active.id){emit({id:m.id,error:{code:-32602,message:'exact fixture turn required'}});return;}
    fs.appendFileSync(trace,JSON.stringify({kind:'control',method:m.method,turn:active.id})+'\\n');
    const {x,id}=active;
    if(m.method==='turn/interrupt'){emit({id:m.id,result:{}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id,status:'interrupted',rootTurnId:id,items:[],itemsView:'full',error:null}}});active=null;return;}
    const supplement=JSON.parse(m.params.input[0].text),text=JSON.stringify({messageId:x.messageId,consumed:[...x.replyReferences,supplement.supplementSha256],report:'明确模型夹具：已读取原固定材料；补查 '+supplement.text}),item={id:id+'-answer',type:'agentMessage',phase:'final_answer',text};
    emit({id:m.id,result:{turnId:id}});emit({method:'item/completed',params:{threadId:thread.id,turnId:id,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id,status:'completed',rootTurnId:id,items:[item],itemsView:'full',error:null}}});active=null;return;
  }
  `+at);
  await writeFile(f.codex,code,{mode:0o700});f.request.participant.executableSha256=hash(code);f.request.timeoutMs=8000;
  f.request.nativeControls=[{id:'check-counterexample',messageId:f.request.id,title:'补查反例',action:'steer',text:'核对边界值反例，保留原结论及实际依据。'},{id:'interrupt-current',messageId:f.request.id,title:'中断当前轮次',action:'interrupt',text:null}];
  const reload=async()=>{await writeFile(f.requestPath,canonical(f.request));f.catalog.contacts[0]!.request.sha256=hash(await readFile(f.requestPath));const controls=await f.load();t.after(()=>controls.drain());f.plan.controls.sha256=hash(await readFile(f.catalogPath));await writeFile(f.planPath,canonical(f.plan));return controls;};
  const controls=await reload();return {...f,controls,reload};
}
export async function until<T>(read:()=>Promise<T>,check:(v:T)=>boolean,ms=6000){const deadline=Date.now()+ms;let value:T;do{value=await read();if(check(value))return value;await new Promise(r=>setTimeout(r,25));}while(Date.now()<deadline);throw new Error('fixture_wait_failed:'+JSON.stringify(value!));}
