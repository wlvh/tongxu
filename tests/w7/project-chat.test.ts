import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {startWorkbench} from '../../src/workbench.js';
import type {GitHubReaderFactory} from '../../src/github-projects.js';

async function fixture(t:test.TestContext,mode='normal'){
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-project-chat-'))),trace=join(root,'trace.ndjson'),binary=join(root,'codex.mjs');await writeFile(trace,'');
  const code=`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const trace=${JSON.stringify(trace)},mode=${JSON.stringify(mode)},emit=x=>process.stdout.write(JSON.stringify(x)+'\\n'),log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.163.0-alpha.10.2');process.exit(0)}
let thread,turn,context;
const finish=observation=>{const report={candidateH:context.candidate.H,report:'明确测试回答：'+context.question+'；历史问题：'+(context.conversation[0]?.question??'无')+'；历史完整回答：'+(context.conversation[0]?.answer??'无'),observationIds:[observation.observationId]},item={id:'answer',type:'agentMessage',phase:mode==='partial'?'commentary':'final_answer',text:JSON.stringify(report)};emit({method:'item/completed',params:{threadId:thread.id,turnId:turn,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:turn,status:'completed',rootTurnId:turn,items:[item],itemsView:'full',error:null}}});};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method&&typeof m.id==='string'){if(m.error)return;finish(JSON.parse(m.result.contentItems[0].text));return;}if(!('id'in m))return;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='account/rateLimits/read')result={ordinaryUsageAllowed:mode!=='quota'};
if(m.method==='config/read')result={config:{mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(process.argv.filter(x=>x.startsWith('features.')).map(x=>[x.slice(9).split('=')[0],x.split('=')[1]==='true']))}};
if(m.method==='thread/start'){thread={id:'project-fixture-'+process.pid,sessionId:'project-fixture-'+process.pid,cwd:m.params.cwd,source:'appServer',cliVersion:'0.163.0-alpha.10.2',parentThreadId:null,forkedFromId:null};log({kind:'tools',tools:m.params.dynamicTools.map(t=>t.name)});emit({id:m.id,result:{thread,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]}});emit({method:'thread/started',params:{thread}});return;}
if(m.method==='turn/start'){turn='project-turn';context=JSON.parse(m.params.input[0].text);log({kind:'input',context});emit({id:m.id,result:{turn:{id:turn}}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id:turn,status:'inProgress',items:[],rootTurnId:turn}}});if(mode==='hold')return;emit({id:'query-1',method:'item/tool/call',params:{threadId:thread.id,turnId:turn,callId:'query-1',tool:mode==='forbidden'?'shell':'tongxu_project_info',namespace:null,arguments:{}}});return;}
if(m.method==='turn/interrupt'){log({kind:'interrupt'});emit({id:m.id,result:{}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:turn,status:'interrupted',rootTurnId:turn,items:[],itemsView:'full',error:null}}});return;}
emit({id:m.id,result});});
`;
  await writeFile(binary,code,{mode:0o700});let account=7,offline=false;
  const repo=(id:number)=>({id,nodeId:'R_'+id,full_name:'fixture/project-'+id,description:'Explicit project fixture',private:true,archived:false,defaultBranchRef:id===2?null:{name:'main',target:{oid:'a'.repeat(40)}},updated_at:'2026-10-30T00:00:00Z'});
  const reader:GitHubReaderFactory=async()=>({query:async(op,v)=>{if(offline)throw new Error('github_connection_unavailable');return {status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:op==='projects'?{account:{id:account,login:'fixture',projects:{nodes:[repo(1),repo(2)],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account:{id:account,login:'fixture'},repository:repo(v.id==='R_2'?2:1)}})};}});
  const plan={schemaVersion:1,kind:'tongxu-local-workbench',title:'Project chat fixture',goal:'No task registration required',sources:[],githubProjects:true,projectSecretary:{root:join(root,'chats'),codexExecutable:binary,disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:3000,billing:'existing_subscription_only',executionKind:'fixture'}},path=join(root,'workbench.json');await writeFile(path,JSON.stringify(plan));
  const launch=async()=>{const app=await startWorkbench(path,undefined,{githubReader:reader}),u=new URL(app.url),auth={Authorization:'Bearer '+u.hash.slice(1)};let ended=false;const close=async()=>{if(!ended){ended=true;await app.close();}};const headers=(id=1)=>({...auth,'X-Tongxu-Account':String(account),'X-Tongxu-Project':String(id)});await fetch(u.origin+'/api/github/projects',{headers:auth});return {app,u,auth,headers,close,get:async(path:string,id=1)=>{const r=await fetch(u.origin+path,{headers:headers(id)});return {status:r.status,data:await r.json() as any};},post:async(path:string,body:any,id=1)=>{const r=await fetch(u.origin+path,{method:'POST',headers:{...headers(id),Origin:u.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}};};
  const current=await launch();t.after(async()=>{await current.close();await rm(root,{recursive:true,force:true});});
  const logs=async()=>((await readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)));
  const wait=async(id:string,predicate:(messages:any[])=>boolean)=>{for(let n=0;n<150;n++){const r=await current.get('/api/project-secretary/conversations/'+id);if(predicate(r.data.messages??[]))return r.data;await new Promise(r=>setTimeout(r,25));}throw new Error('fixture_chat_timeout');};
  return {...current,root,path,plan,logs,wait,launch,setOffline:(v:boolean)=>{offline=v;},setAccount:(v:number)=>{account=v;}};
}
const question=(text='当前项目有哪些待办？',parent:string|null=null,conversationId=randomUUID())=>({requestId:randomUUID(),conversationId,parent,question:text});
test('a project with no registered task supports two saved turns, full history, duplicate rejection and cold re-entry',async t=>{
  const f=await fixture(t),a=question();assert.equal((await f.get('/api/project-secretary')).data.available,true);
  const replies=await Promise.all([f.post('/api/project-secretary/ask',a),f.post('/api/project-secretary/ask',a)]);assert.ok(replies.some(r=>r.status===202));
  const first=await f.wait(a.conversationId,m=>m[0]?.status==='completed');assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);
  assert.equal((await f.post('/api/project-secretary/ask',{...a,question:'不能换原问题'})).status,503);
  const b=question('请根据上一个回答继续解释',a.requestId,a.conversationId);assert.equal((await f.post('/api/project-secretary/ask',b)).status,202);const second=await f.wait(a.conversationId,m=>m[1]?.status==='completed');assert.ok(second.messages[1].answer.includes(first.messages[0].answer));
  const inputs=(await f.logs()).filter(x=>x.kind==='input');assert.equal(inputs.length,2);assert.equal(inputs[1].context.conversation[0].answer,first.messages[0].answer);
  assert.equal((await f.get('/api/project-secretary/conversations/'+a.conversationId,2)).status,503);assert.equal((await f.post('/api/project-secretary/ask',a,2)).status,503);
  await f.close();const reopened=await f.launch();try{const restored=await reopened.get('/api/project-secretary/conversations/'+a.conversationId);assert.equal(restored.data.messages[1].answer,second.messages[1].answer);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,2);}finally{await reopened.close();}
});
test('an empty GitHub repository uses no invented commit and can still converse',async t=>{
  const f=await fixture(t),q=question('帮我梳理项目规划');assert.equal((await f.post('/api/project-secretary/ask',q,2)).status,202);
  let result:any;for(let i=0;i<120;i++){result=await f.get('/api/project-secretary/conversations/'+q.conversationId,2);if(result.data.messages?.[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(result.data.messages[0].status,'completed');const input=(await f.logs()).find(x=>x.kind==='input').context;assert.equal(input.candidate.kind,'project-conversation');assert.equal(input.candidate.H,'');assert.equal(input.candidate.pr,null);
});
for(const mode of ['quota','partial','forbidden'])test(mode+' never becomes a full answer or an automatic repeat',async t=>{
  const f=await fixture(t,mode),q=question();assert.equal((await f.post('/api/project-secretary/ask',q)).status,202);const final=await f.wait(q.conversationId,m=>m[0]&&!m[0].active);assert.notEqual(final.messages[0].status,'completed');assert.equal(final.messages[0].answer,null);const before=(await f.logs()).filter(x=>x.kind==='input').length;assert.equal(before,mode==='quota'?0:1);
  assert.equal((await f.post('/api/project-secretary/ask',q)).status,202);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,before);
});
test('stop uses the owned turn, remains available without GitHub, and preserves incomplete history',async t=>{
  const f=await fixture(t,'hold'),q=question();await f.post('/api/project-secretary/ask',q);for(let i=0;i<120;i++){if((await f.logs()).some(x=>x.kind==='input'))break;await new Promise(r=>setTimeout(r,25));}
  const blocked=await f.post('/api/project-secretary/ask',question('不能并发重复发起'));assert.equal(blocked.status,503);f.setOffline(true);const stopped=await f.post('/api/project-secretary/stop',{requestId:q.requestId});assert.equal(stopped.status,200);f.setOffline(false);
  const state=await f.wait(q.conversationId,m=>m[0]?.status==='interrupted');assert.equal(state.messages[0].answer,null);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);assert.equal((await f.logs()).filter(x=>x.kind==='interrupt').length,1);
});
test('tampered original capture is unavailable, cannot seed follow-up context, and triggers no model',async t=>{
  const f=await fixture(t),q=question();await f.post('/api/project-secretary/ask',q);await f.wait(q.conversationId,m=>m[0]?.status==='completed');await appendFile(join(f.root,'chats',q.requestId,'native','stdout.ndjson'),'broken capture');
  const state=await f.get('/api/project-secretary/conversations/'+q.conversationId);assert.equal(state.data.messages[0].status,'unavailable');assert.equal(state.data.messages[0].answer,null);assert.equal((await f.post('/api/project-secretary/ask',question('继续',q.requestId,q.conversationId))).status,503);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);
});
for(const mode of ['missing','truncated'])test('lost original '+mode+' process identity stays unknown until the actual child is proved ended',async t=>{
  const f=await fixture(t);await f.get('/api/project-secretary');
  const endedHost=spawnSync(process.execPath,['-e','process.exit(0)']).pid,child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});assert.ok(child.pid);const exited=new Promise<void>(r=>child.once('exit',()=>r()));t.after(async()=>{child.kill();await exited;});
  const q=question(),native=join(f.root,'chats',q.requestId,'native');await mkdir(native,{recursive:true});const original={pid:child.pid,status:'spawn_attempted'};
  if(mode==='truncated')await writeFile(join(native,'process.json'),'{"pid":');
  const db=new DatabaseSync(join(f.root,'chats','conversations.sqlite'));db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?)').run(q.conversationId,7,1,'R_1','fixture/project-1','Explicit interrupted fixture',new Date().toISOString());db.prepare("INSERT INTO messages(id,conversation,parent,question,phase,created_at,pid,owner) VALUES (?,?,NULL,?,'running',?,?,'ended-fixture-host')").run(q.requestId,q.conversationId,q.question,new Date().toISOString(),endedHost);db.close();
  const unknown=await f.get('/api/project-secretary/conversations/'+q.conversationId);assert.equal(unknown.data.messages[0].status,'unknown');assert.equal((await f.post('/api/project-secretary/ask',question('不能绕过未知旧执行'))).status,503);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,0);
  await writeFile(join(native,'process.json'),JSON.stringify(original));assert.equal((await f.get('/api/project-secretary/conversations/'+q.conversationId)).data.messages[0].status,'unknown');child.kill();await exited;
  const ended=await f.get('/api/project-secretary/conversations/'+q.conversationId);assert.equal(ended.data.messages[0].status,'interrupted');assert.equal(ended.data.messages[0].answer,null);const next=question('原执行结束后明确提新问题');assert.equal((await f.post('/api/project-secretary/ask',next)).status,202);await f.wait(next.conversationId,m=>m[0]?.status==='completed');assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);
});
