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
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import type {AIProvider} from '../../src/ai-catalog.js';
import {BoundedCodexSession,projectSecretarySchema,secretarySchema,isSecretaryOutputSchema} from '../../src/repair-native.js';

async function fixture(t:test.TestContext,mode='normal'){
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-project-chat-'))),trace=join(root,'trace.ndjson'),binary=join(root,'codex.mjs');await writeFile(trace,'');
  const code=`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const trace=${JSON.stringify(trace)},mode=${JSON.stringify(mode)},emit=x=>process.stdout.write(JSON.stringify(x)+'\\n'),log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.163.0-alpha.10.2');process.exit(0)}
let thread,turn,context,toolReplies=0,observationIds=[],commentBodies=[];
const query=index=>emit({id:'query-'+index,method:'item/tool/call',params:{threadId:thread.id,turnId:turn,callId:'query-'+index,tool:mode==='budget-overrun'&&index===25?'tongxu_project_item':'tongxu_project_info',namespace:null,arguments:mode==='budget-overrun'&&index===25?{kind:'issues',number:999}:{}}});
const queryComments=(index,args)=>emit({id:'comments-'+index,method:'item/tool/call',params:{threadId:thread.id,turnId:turn,callId:'comments-'+index,tool:'tongxu_project_comments',namespace:null,arguments:args}});
const finish=observation=>{
const counts={'citation-one':1,'citation-empty':0,'citation-nine':9};
const references=mode.startsWith('citation-')?observationIds.slice(0,counts[mode]??8):[observation.observationId];
if(mode==='citation-invalid-hex')references[0]='invalid-hex';
if(mode==='citation-unobserved')references[0]='f'.repeat(64);
const report={candidateH:mode==='citation-wrong-candidate'?'wrong-candidate':context.candidate.H,report:'明确测试回答：'+context.question+'；历史问题：'+(context.conversation[0]?.question??'无')+'；历史完整回答：'+(context.conversation[0]?.answer??'无')+(mode==='comments'?'；评论原文：'+commentBodies.join(' | '):''),observationIds:references},item={id:'answer',type:'agentMessage',phase:mode==='partial'?'commentary':'final_answer',text:JSON.stringify(report)};emit({method:'item/completed',params:{threadId:thread.id,turnId:turn,completedAtMs:100,item}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:turn,status:'completed',rootTurnId:turn,items:[item],itemsView:'full',error:null}}});};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method&&typeof m.id==='string'){if(m.error)return;const observation=JSON.parse(m.result.contentItems[0].text);if(mode==='comments'){log({kind:'comment-result',observation});commentBodies.push(...observation.data.comments.map(c=>c.body));toolReplies++;if(toolReplies===1){queryComments(2,{kind:'issues',number:9,page:2,cursor:observation.data.nextCursor});return;}if(toolReplies===2){queryComments(3,{kind:'pulls',number:65});return;}finish(observation);return;}if(mode.startsWith('citation-')){observationIds.push(observation.observationId);toolReplies++;if(toolReplies===21){finish(observation);return;}query(toolReplies+1);return;}if(mode==='time-budget'){log({kind:'time-result',observation});toolReplies++;if(toolReplies<3){const gate=trace+'.time-'+toolReplies,waiting=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(waiting);query(toolReplies+1);}},5);return;}finish(observation);return;}if(mode.startsWith('budget-')){log({kind:'tool-result',budget:observation.toolBudget});toolReplies++;if(mode==='budget-aware'&&observation.toolBudget?.remaining===0){finish(observation);return;}query(toolReplies+1);return;}finish(observation);return;}if(!('id'in m))return;let result={};
if(m.method==='model/list')result={data:[{model:'fixture-astra',displayName:'Fixture Astra',supportedReasoningEfforts:[{reasoningEffort:'max'}],defaultReasoningEffort:'max'}],nextCursor:null};
if(m.method==='account/read')result={account:{type:'chatgpt'}};
if(m.method==='account/rateLimits/read')result={ordinaryUsageAllowed:mode!=='quota'};
if(m.method==='config/read')result={config:{mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(process.argv.filter(x=>x.startsWith('features.')).map(x=>[x.slice(9).split('=')[0],x.split('=')[1]==='true']))}};
if(m.method==='thread/start'){thread={id:'project-fixture-'+process.pid,sessionId:'project-fixture-'+process.pid,cwd:m.params.cwd,reasoningEffort:m.params.config?.model_reasoning_effort??'xhigh',source:'appServer',cliVersion:'0.163.0-alpha.10.2',parentThreadId:null,forkedFromId:null};log({kind:'tools',tools:m.params.dynamicTools.map(t=>t.name),instructions:m.params.developerInstructions});emit({id:m.id,result:{thread,model:mode==='wrong-selected-model'?'wrong':m.params.model??'fixture-default',reasoningEffort:thread.reasoningEffort,cwd:thread.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},instructionSources:[]}});emit({method:'thread/started',params:{thread}});return;}
if(m.method==='turn/start'){turn='project-turn';context=JSON.parse(m.params.input[0].text);log({kind:'input',schema:m.params.outputSchema,context,model:m.params.model,effort:m.params.effort,effectiveEffort:m.params.effort??thread.reasoningEffort});emit({id:m.id,result:{turn:{id:turn}}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id:turn,status:'inProgress',items:[],rootTurnId:turn}}});observationIds=[context.initialObservation.observationId];if(mode==='hold'||mode==='timeout')return;if(mode==='comments'){queryComments(1,{kind:'issues',number:9});return;}if(mode.startsWith('citation-')){query(1);return;}if(mode.startsWith('budget-')||mode==='time-budget'){query(1);return;}emit({id:'query-1',method:'item/tool/call',params:{threadId:thread.id,turnId:turn,callId:'query-1',tool:mode==='forbidden'?'shell':'tongxu_project_info',namespace:null,arguments:{}}});return;}
if(m.method==='turn/interrupt'){log({kind:'interrupt'});emit({id:m.id,result:{}});emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:turn,status:'interrupted',rootTurnId:turn,items:[],itemsView:'full',error:null}}});return;}
emit({id:m.id,result});});
`;
  await writeFile(binary,code,{mode:0o700});let account=7,offline=false;
  const repo=(id:number)=>({id,nodeId:'R_'+id,full_name:'fixture/project-'+id,description:'Explicit project fixture',private:true,archived:false,defaultBranchRef:id===2?null:{name:'main',target:{oid:'a'.repeat(40)}},updated_at:'2026-10-30T00:00:00Z'});
  const reader:GitHubReaderFactory=async()=>({query:async(op,v)=>{if(mode==='budget-overrun')await appendFile(trace,JSON.stringify({kind:'read-op',op,args:v})+'\n');if(offline)throw new Error('github_connection_unavailable');
    const selected=repo(v.id==='R_2'?2:1),pull=op==='pull_comments',commentId=pull?3:v.before?1:2;
    const comments={number:v.number,comments:{totalCount:pull?1:2,edges:[{cursor:'comment-'+commentId,node:{databaseId:commentId,author:pull?null:{login:'fixture'},createdAt:'2026-10-30T00:00:00Z',updatedAt:'2026-10-31T00:00:00Z',url:'https://github.com/'+selected.full_name+'/'+(pull?'pull':'issues')+'/'+v.number+'#issuecomment-'+commentId,body:pull?'PR ordinary conversation':'Issue comment '+commentId}}],pageInfo:{hasPreviousPage:!pull&&!v.before,startCursor:'comment-'+commentId}}};
    return {status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:op==='projects'?{account:{id:account,login:'fixture',projects:{nodes:[repo(1),repo(2)],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account:{id:account,login:'fixture'},repository:{...selected,...(op==='issue_comments'||op==='pull_comments'?{item:comments}:{})}}})};}});
  const plan={schemaVersion:1,kind:'tongxu-local-workbench',title:'Project chat fixture',goal:'No task registration required',sources:[],githubProjects:true,aiSettings:{root:join(root,'ai-settings'),configured:[{tool:'codex',path:binary}],disabledMcpServers:[]},projectSecretary:{root:join(root,'chats'),codexExecutable:binary,disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:mode==='timeout'?1000:3000,billing:'existing_subscription_only',executionKind:'fixture'}},path=join(root,'workbench.json');await writeFile(path,JSON.stringify(plan));
  const launch=async()=>{const app=await startWorkbench(path,undefined,{githubReader:reader,aiProbe:async(tool,path,directory):Promise<AIProvider>=>({id:hash(JSON.stringify([tool,path])).slice(0,24),tool,path,version:'explicit fixture',available:path===binary,reason:path===binary?null:'explicit_fixture_not_selected',authentication:'subscription',models:[{id:'fixture-astra',resolvedId:null,name:'Fixture Astra',description:'Explicit fixture',efforts:['max'],defaultEffort:'max',isDefault:true}],defaults:{model:'fixture-default',effort:'xhigh',source:'codex_config_read'},observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:tool==='codex',ownedControl:tool==='codex'},evidence:directory})}),u=new URL(app.url),auth={Authorization:'Bearer '+u.hash.slice(1)};let ended=false;const close=async()=>{if(!ended){ended=true;await app.close();}};const headers=(id=1)=>({...auth,'X-Tongxu-Account':String(account),'X-Tongxu-Project':String(id)});await fetch(u.origin+'/api/github/projects',{headers:auth});return {app,u,auth,headers,close,get:async(path:string,id=1)=>{const r=await fetch(u.origin+path,{headers:headers(id)});return {status:r.status,data:await r.json() as any};},post:async(path:string,body:any,id=1)=>{const r=await fetch(u.origin+path,{method:'POST',headers:{...headers(id),Origin:u.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}};};
  const current=await launch();t.after(async()=>{await current.close();await rm(root,{recursive:true,force:true});});
  const logs=async()=>((await readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)));
  const wait=async(id:string,predicate:(messages:any[])=>boolean)=>{for(let n=0;n<150;n++){const r=await current.get('/api/project-secretary/conversations/'+id);if(predicate(r.data.messages??[]))return r.data;await new Promise(r=>setTimeout(r,25));}throw new Error('fixture_chat_timeout');};
  return {...current,root,path,plan,logs,wait,launch,setOffline:(v:boolean)=>{offline=v;},setAccount:(v:number)=>{account=v;}};
}
const question=(text='当前项目有哪些待办？',parent:string|null=null,conversationId=randomUUID())=>({requestId:randomUUID(),conversationId,parent,question:text});
test('normal project secretary reads both ordinary comment kinds, pages and verified history without opening old queues',async t=>{
  const f=await fixture(t,'comments');
  const plan={...f.plan,sources:[{id:'unavailable',title:'Unavailable legacy source',store:join(f.root,'absent-queue'),item:'b'.repeat(64)}]};
  await f.close();await writeFile(f.path,JSON.stringify(plan));const app=await f.launch();
  try{
    const q=question('当前工作已交付什么，还有什么待做？请以当前有效记录为准。');
    assert.equal((await app.post('/api/project-secretary/ask',q)).status,202);
    let state:any;
    for(let n=0;n<150;n++){state=await app.get('/api/project-secretary/conversations/'+q.conversationId);if(state.data.messages?.[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,25));}
    const message=state.data.messages[0];assert.equal(message.status,'completed');assert.match(message.answer,/Issue comment 2 \| Issue comment 1 \| PR ordinary conversation/);
    const observations=JSON.parse(await readFile(join(f.root,'chats',q.requestId,'observations.json'),'utf8'));
    assert.equal(observations.length,4);assert.deepEqual(observations.slice(1).map((o:any)=>o.observation.data.hasNext),[true,false,false]);
    assert.deepEqual(observations.slice(1).map((o:any)=>o.observation.toolBudget.remaining),[23,22,21]);
    for(const o of observations.slice(1)){assert.equal(o.tool,'tongxu_project_comments');assert.equal(o.id,hash(canonical(o.observation)));}
    const logs=await f.logs();assert.ok(logs.find(x=>x.kind==='tools').tools.includes('tongxu_project_comments'));assert.equal(logs.filter(x=>x.kind==='input').length,1);
    assert.equal((await app.post('/api/project-secretary/ask',q)).status,202);await app.close();
    const cold=await f.launch();try{const restored=await cold.get('/api/project-secretary/conversations/'+q.conversationId);assert.equal(restored.data.messages[0].answer,message.answer);assert.deepEqual(restored.data.messages[0].receipt,message.receipt);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);}finally{await cold.close();}
  }finally{await app.close();}
});
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
test('initialization rejection after creating a native stage does not infer an ended child from a missing session object',async t=>{
  const f=await fixture(t),originalStart=BoundedCodexSession.start,child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});assert.ok(child.pid);const exited=new Promise<void>(r=>child.once('exit',()=>r()));
  t.after(async()=>{BoundedCodexSession.start=originalStart;child.kill();await exited;});
  BoundedCodexSession.start=async options=>{await mkdir(options.directory,{recursive:true});await writeFile(join(options.directory,'process.json'),'{truncated');throw new Error('fixture_start_rejected_after_native_stage');};
  const q=question('启动故障夹具');assert.equal((await f.post('/api/project-secretary/ask',q)).status,202);const unknown=await f.wait(q.conversationId,m=>m[0]&&m[0].status!=='registered'&&!m[0].owned);assert.equal(unknown.messages[0].status,'unknown');assert.equal(unknown.messages[0].active,false);const outcome=JSON.parse(await readFile(join(f.root,'chats',q.requestId,'outcome.json'),'utf8'));assert.equal(outcome.status,'unknown');assert.equal(outcome.nativeProcessState,'unknown');
  assert.equal((await f.post('/api/project-secretary/ask',question('不得越过未知启动'))).status,503);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,0);
  await writeFile(join(f.root,'chats',q.requestId,'native','process.json'),JSON.stringify({pid:child.pid,status:'spawn_attempted'}));assert.equal((await f.get('/api/project-secretary/conversations/'+q.conversationId)).data.messages[0].status,'unknown');child.kill();await exited;BoundedCodexSession.start=originalStart;
  assert.equal((await f.get('/api/project-secretary/conversations/'+q.conversationId)).data.messages[0].status,'interrupted');
});


test('normal project AI settings feed actual native model/effort and stay fixed on history replay',async t=>{
  const f=await fixture(t),scan=await f.post('/api/ai-settings/scan',{});assert.equal(scan.status,200);assert.equal((await f.logs()).length,0);
  const provider=scan.data.catalog.find((p:any)=>p.available);const saved=await f.post('/api/ai-settings/role',{revision:0,role:'secretary',choice:{providerId:provider.id,model:'fixture-astra',effort:'max'}});assert.equal(saved.status,200);assert.equal((await f.get('/api/ai-settings',2)).data.revision,0);
  const q=question('使用本项目选择的模型');await f.post('/api/project-secretary/ask',q);const answer=await f.wait(q.conversationId,m=>m[0]?.status==='completed');assert.equal(answer.messages[0].receipt.aiExecution.actualModel,'fixture-astra');assert.equal(answer.messages[0].receipt.aiExecution.actualEffort,'max');const input=(await f.logs()).find(x=>x.kind==='input');assert.equal(input.model,'fixture-astra');assert.equal(input.effort,'max');
  await f.post('/api/ai-settings/role',{revision:1,role:'secretary',choice:null});const before=await f.logs();await f.post('/api/project-secretary/ask',q);await f.close();const reopened=await f.launch();try{const restored=await reopened.get('/api/project-secretary/conversations/'+q.conversationId);assert.deepEqual(restored.data.messages[0].receipt.aiExecution,answer.messages[0].receipt.aiExecution);assert.deepEqual(await f.logs(),before);}finally{await reopened.close();}
});

test('each AI setting exposes a usable destination and complete role policy without starting a model',async t=>{
  const f=await fixture(t),state=await f.get('/api/ai-settings');assert.equal(state.status,200);assert.deepEqual(state.data.roles.map((r:any)=>r.id),['secretary','issue_owner','reviewer','verifier_fact','verifier_impact','receiver','acceptance']);
  for(const role of state.data.roles){assert.ok(['secretary','tasks','retrospective','deliveries'].includes(role.view));assert.ok(role.entry.length>0);assert.ok(role.interaction.length>0);
    const prompt=await f.get('/api/ai-settings/prompts/'+role.id);assert.equal(prompt.status,200);assert.equal(prompt.data.assembly.role,role.id);assert.ok(prompt.data.assembly.system.includes('全文已由运行器放入系统提示'));assert.equal(prompt.data.modelInputs,0);}
  assert.equal((await f.get('/api/ai-settings/prompts/not_a_role')).status,503);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,0);
});

test('the visible wait limit interrupts the exact owned turn, records timeout rather than user stop, and never repeats input',async t=>{
  const f=await fixture(t,'timeout'),q=question('明确超时样例');assert.equal((await f.get('/api/project-secretary')).data.timeoutMs,1000);
  await f.post('/api/project-secretary/ask',q);const result=await f.wait(q.conversationId,m=>m[0]?.status==='failed'&&!m[0]?.owned);
  assert.equal(result.messages[0].problem,'executor_wait_timeout');assert.equal(result.messages[0].answer,null);
  const logs=await f.logs();assert.equal(logs.filter(x=>x.kind==='input').length,1);assert.equal(logs.filter(x=>x.kind==='interrupt').length,1);
  const record=JSON.parse(await readFile(join(f.root,'chats',q.requestId,'timeout-stop-request.json'),'utf8'));assert.equal(record.source,'configured_wait_limit');
  const outcome=JSON.parse(await readFile(join(f.root,'chats',q.requestId,'outcome.json'),'utf8'));assert.equal(outcome.invocationOutcome,'timeout');
  await f.post('/api/project-secretary/ask',q);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);
});

for(const cause of ['timeout','user'] as const)test('failed '+cause+' metadata write cannot skip exact owned interruption and process cleanup',async t=>{
  const f=await fixture(t,cause==='timeout'?'timeout':'hold'),q=question('明确停止记录失败样例');await f.post('/api/project-secretary/ask',q);
  for(let i=0;i<120;i++){if((await f.logs()).some(x=>x.kind==='input'))break;await new Promise(r=>setTimeout(r,10));}
  const directory=join(f.root,'chats',q.requestId),native=join(directory,'native');
  // Only this explanatory record's atomic rename fails; original capture remains writable.
  await mkdir(join(directory,cause==='timeout'?'timeout-stop-request.json':'stop-request.json'));
  if(cause==='user'){const stop=await f.post('/api/project-secretary/stop',{requestId:q.requestId});assert.equal(stop.status,200);assert.equal(stop.data.stopRecordSaved,false);}
  const result=await f.wait(q.conversationId,m=>m[0]&&['failed','interrupted'].includes(m[0].status)&&!m[0].owned);
  assert.equal(result.messages[0].answer,null);const sent=(await readFile(join(native,'stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x)),thread=JSON.parse(await readFile(join(native,'thread.json'),'utf8')).thread,interrupt=sent.find(m=>m.method==='turn/interrupt');
  assert.ok(interrupt);assert.equal(interrupt.params.threadId,thread.id);assert.equal(interrupt.params.turnId,'project-turn');assert.equal(sent.filter(m=>m.method==='turn/start').length,1);
  const exited=JSON.parse(await readFile(join(native,'exit.json'),'utf8'));assert.equal(exited.code,0);const outcome=JSON.parse(await readFile(join(directory,'outcome.json'),'utf8'));assert.equal(outcome.nativeProcessState,'ended');
  if(cause==='timeout')assert.equal(outcome.cleanupRecordProblem,'timeout_record_unavailable');
  await f.post('/api/project-secretary/ask',q);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);
});
test('a provider that silently substitutes the selected model is rejected before any model input',async t=>{
 const f=await fixture(t,'wrong-selected-model'),scan=await f.post('/api/ai-settings/scan',{}),provider=scan.data.catalog.find((p:any)=>p.available);await f.post('/api/ai-settings/role',{revision:0,role:'secretary',choice:{providerId:provider.id,model:'fixture-astra',effort:'max'}});const q=question('拒绝换模型');await f.post('/api/project-secretary/ask',q);const state=await f.wait(q.conversationId,m=>m[0]&&!m[0].active);assert.notEqual(state.messages[0].status,'completed');assert.equal((await f.logs()).filter(x=>x.kind==='input').length,0);
});

test('unconfigured project secretary exposes the actual default source and does not submit a hidden high override',async t=>{
  const f=await fixture(t);const before=(await f.get('/api/ai-settings')).data;assert.equal(before.defaults.secretary.path,f.plan.projectSecretary.codexExecutable);assert.equal(before.defaults.secretary.observed,null);
  const scanned=await f.post('/api/ai-settings/scan',{});assert.equal(scanned.status,200);assert.deepEqual(scanned.data.defaults.secretary.observed,{model:'fixture-default',effort:'xhigh',source:'codex_config_read'});
  const list=await f.get('/api/project-secretary');assert.equal(list.data.aiChoice,null);assert.equal(list.data.aiDefault.observed.effort,'xhigh');
  const q=question('明确测试：使用程序当前默认值');await f.post('/api/project-secretary/ask',q);await f.wait(q.conversationId,m=>m[0]?.status==='completed');const input=(await f.logs()).find(x=>x.kind==='input');assert.equal(input.effort,undefined);assert.equal(input.model,undefined);assert.equal(input.effectiveEffort,'xhigh');
  const calls=await f.logs();await f.get('/api/project-secretary/conversations/'+q.conversationId);assert.deepEqual(await f.logs(),calls);
});



test('actual secretary input and hashed tool observations carry the existing wait budget and nonnegative remaining snapshots',async t=>{
 let clock=1000;t.mock.method(performance,'now',()=>clock);
 const f=await fixture(t,'time-budget'),q=question('在已有时限内读取当前资料并完成回答');await f.post('/api/project-secretary/ask',q);
 const toolResult=async(count:number)=>{for(let n=0;n<100;n++){if((await f.logs()).filter(x=>x.kind==='time-result').length>=count)return;await new Promise(r=>setTimeout(r,10));}throw new Error('time_budget_fixture_tool_not_returned');};
 await toolResult(1);clock=1800;await writeFile(join(f.root,'trace.ndjson.time-1'),'release second tool');await toolResult(2);clock=5000;await writeFile(join(f.root,'trace.ndjson.time-2'),'release third tool');
 const final=await f.wait(q.conversationId,m=>m[0]?.status==='completed'),logs=await f.logs(),input=logs.find(x=>x.kind==='input').context;
 assert.deepEqual(input.initialObservation.timeBudget,{limitMs:3000,elapsedMs:null,remainingMs:null});
 assert.match(logs.find(x=>x.kind==='tools').instructions,/host wait limit remains authoritative/);
 const results=logs.filter(x=>x.kind==='time-result').map(x=>x.observation);
 assert.deepEqual(results.map(x=>x.timeBudget),[{limitMs:3000,elapsedMs:0,remainingMs:3000},{limitMs:3000,elapsedMs:800,remainingMs:2200},{limitMs:3000,elapsedMs:4000,remainingMs:0}]);
 const saved=JSON.parse(await readFile(join(f.root,'chats',q.requestId,'observations.json'),'utf8'));
 for(const result of results){const {observationId,...observation}=result;assert.equal(hash(canonical(observation)),observationId);assert.deepEqual(saved.find((x:any)=>x.id===observationId).observation,observation);}
 const answer=final.messages[0];await f.close();const reopened=await f.launch();try{const restored=await reopened.get('/api/project-secretary/conversations/'+q.conversationId);assert.equal(restored.data.messages[0].answer,answer.answer);assert.deepEqual(restored.data.messages[0].receipt,answer.receipt);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);}finally{await reopened.close();}
});

test('a tool observation without an observed native turn start does not invent elapsed or remaining time',async t=>{
 const originalStart=BoundedCodexSession.start;t.after(()=>{BoundedCodexSession.start=originalStart;});
 BoundedCodexSession.start=options=>originalStart({...options,afterTurnStarted:undefined});
 const f=await fixture(t,'time-budget'),q=question('起点尚不可用的明确协议样例');await writeFile(join(f.root,'trace.ndjson.time-1'),'release');await writeFile(join(f.root,'trace.ndjson.time-2'),'release');await f.post('/api/project-secretary/ask',q);await f.wait(q.conversationId,m=>m[0]?.status==='completed');
 for(const result of (await f.logs()).filter(x=>x.kind==='time-result'))assert.deepEqual(result.observation.timeBudget,{limitMs:3000,elapsedMs:null,remainingMs:null});
 assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);
});

test('a budget-aware model can use all24 tool calls then deliver one verified answer and cold replay',async t=>{
 const f=await fixture(t,'budget-aware'),q=question('读取当前所需资料并在预算内形成交接');assert.equal((await f.post('/api/project-secretary/ask',q)).status,202);
 const final=await f.wait(q.conversationId,m=>m[0]&&!m[0].active);assert.equal(final.messages[0].status,'completed');assert.ok(final.messages[0].answer);
 const logs=await f.logs(),inputs=logs.filter(x=>x.kind==='input'),results=logs.filter(x=>x.kind==='tool-result');assert.equal(inputs.length,1);assert.deepEqual(inputs[0].context.initialObservation.toolBudget,{limit:24,used:0,remaining:24});assert.match(logs.find(x=>x.kind==='tools').instructions,/at most 24 total project-secretary tool calls/);assert.equal(results.length,24);for(const [i,r] of results.entries())assert.deepEqual(r.budget,{limit:24,used:i+1,remaining:23-i});
 const saved=JSON.parse(await readFile(join(f.root,'chats',q.requestId,'observations.json'),'utf8'));assert.equal(saved.length,25);assert.deepEqual(saved.at(-1).observation.toolBudget,{limit:24,used:24,remaining:0});
 const original=final.messages[0];await f.close();const reopened=await f.launch();try{const restored=await reopened.get('/api/project-secretary/conversations/'+q.conversationId);assert.equal(restored.data.messages[0].answer,original.answer);assert.deepEqual(restored.data.messages[0].receipt,original.receipt);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);}finally{await reopened.close();}
});
test('a model ignoring remaining0 is refused before its25th reader call and original retry adds no input',async t=>{
 const f=await fixture(t,'budget-overrun'),q=question('明确超量协议样例');assert.equal((await f.post('/api/project-secretary/ask',q)).status,202);
 const final=await f.wait(q.conversationId,m=>m[0]&&!m[0].active);assert.equal(final.messages[0].status,'failed');assert.equal(final.messages[0].problem,'project_chat_tool_limit');assert.equal(final.messages[0].answer,null);
 const logs=await f.logs();assert.equal(logs.filter(x=>x.kind==='input').length,1);assert.equal(logs.filter(x=>x.kind==='tool-result').length,24);assert.ok(!logs.some(x=>x.kind==='read-op'&&Object.values(x.args??{}).some(v=>String(v)==='999')));const saved=JSON.parse(await readFile(join(f.root,'chats',q.requestId,'observations.json'),'utf8'));assert.equal(saved.length,25);
 assert.equal((await f.post('/api/project-secretary/ask',q)).status,202);assert.equal((await f.logs()).filter(x=>x.kind==='input').length,1);
});

for (const mode of ['citation-one', 'citation-eight', 'citation-empty', 'citation-nine', 'citation-invalid-hex', 'citation-wrong-candidate', 'citation-unobserved']) {
  test(mode + ' after 21 reads respects the final reference boundary without another turn', async t => {
    const f = await fixture(t, mode), q = question('读取相关资料后选择最终引用');
    assert.equal((await f.post('/api/project-secretary/ask', q)).status, 202);
    const state = await f.wait(q.conversationId, messages => messages[0] && !messages[0].active);
    const message = state.messages[0], accepted = mode === 'citation-one' || mode === 'citation-eight';
    assert.equal(message.status, accepted ? 'completed' : 'failed');
    const logs = await f.logs(), input = logs.find(x => x.kind === 'input');
    assert.deepEqual(input.schema, projectSecretarySchema);
    assert.deepEqual(input.schema.properties.observationIds, {
      type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    });
    assert.match(logs.find(x => x.kind === 'tools').instructions, /Select 1 to 8/);
    const directory = join(f.root, 'chats', q.requestId);
    const observations = JSON.parse(await readFile(join(directory, 'observations.json'), 'utf8'));
    assert.equal(observations.length, 22);
    assert.deepEqual(observations.at(-1).observation.toolBudget, { limit: 24, used: 21, remaining: 3 });
    if (accepted) {
      assert.equal(message.receipt.observationIds.length, mode === 'citation-one' ? 1 : 8);
      assert.equal(message.receipt.observations.length, message.receipt.observationIds.length);
    } else {
      const problem = mode === 'citation-wrong-candidate' ? 'structured_report_wrong_candidate'
        : mode === 'citation-unobserved' ? 'project_chat_answer_unverified' : 'invalid_secretary_report';
      assert.equal(message.problem, problem);
      assert.equal(message.answer, null);
      assert.equal(message.receipt, null);
      await assert.rejects(readFile(join(directory, 'answer.json')), { code: 'ENOENT' });
    }
    assert.equal(logs.filter(x => x.kind === 'input').length, 1);
    assert.equal((await f.post('/api/project-secretary/ask', q)).data.duplicate, true);
    await f.close();
    const reopened = await f.launch();
    try {
      const restored = (await reopened.get('/api/project-secretary/conversations/' + q.conversationId)).data.messages[0];
      assert.equal(restored.status, message.status);
      assert.equal(restored.answer, message.answer);
      assert.deepEqual(restored.receipt, message.receipt);
      assert.deepEqual(await f.logs(), logs);
    } finally { await reopened.close(); }
  });
}

test('native live profiles reject crossed, copied and non-secretary output schemas before input', async () => {
  const cases = [
    { role: 'secretary', projectSecretary: true, schema: secretarySchema },
    { role: 'secretary', projectSecretary: false, schema: projectSecretarySchema },
    { role: 'secretary', projectSecretary: true, schema: structuredClone(projectSecretarySchema) },
    { role: 'reviewer', projectSecretary: false, schema: projectSecretarySchema },
    { role: 'reviewer', projectSecretary: false, schema: secretarySchema }
  ];
  for (const { role, projectSecretary, schema } of cases) {
    const session = Object.create(BoundedCodexSession.prototype);
    session.o = { role, projectSecretary };
    await assert.rejects(session.runTurn('', { H: 'a'.repeat(40) }, schema), /native_role_output_schema_mismatch/);
  }
});

test('history accepts the exact old generic schema but refuses coherently rehashed unknown profiles', async t => {
  const f = await fixture(t), q = question();
  await f.post('/api/project-secretary/ask', q);
  const original = (await f.wait(q.conversationId, messages => messages[0]?.status === 'completed')).messages[0];
  const logs = await f.logs(), directory = join(f.root, 'chats', q.requestId), native = join(directory, 'native');
  const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  const sent = (await readFile(join(native, 'stdin.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const inputs = JSON.parse(await readFile(join(native, 'inputs.json'), 'utf8'));
  const binding = JSON.parse(await readFile(join(native, 'binding.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(join(native, 'completed.json'), 'utf8'));
  const capture = JSON.parse(await readFile(join(native, 'capture-status.json'), 'utf8'));
  const unknown = structuredClone(projectSecretarySchema);
  unknown.properties.observationIds.maxItems = 9;
  const profiles = [
    { schema: secretarySchema, known: true },
    { schema: unknown, known: false },
    { schema: { ...secretarySchema, description: 'unregistered' }, known: false },
    { schema: projectSecretarySchema, known: true }
  ];
  for (const { schema, known } of profiles) {
    assert.equal(isSecretaryOutputSchema(schema), known);
    // Explicit historical-wire fixtures keep the original capture hashes coherent.
    sent.find(message => message.method === 'turn/start').params.outputSchema = schema;
    inputs[0].schema = schema;
    binding.promptSha256 = hash(JSON.stringify({ system: request.system, inputs }));
    const wire = sent.map(message => JSON.stringify(message)).join('\n') + '\n', contract = JSON.stringify(sent);
    receipt.binding = binding;
    receipt.inputSha256 = hash(wire);
    receipt.contractSha256 = hash(contract);
    capture.files['stdin.ndjson'] = hash(wire);
    for (const [name, content] of Object.entries({
      'stdin.ndjson': wire, 'expected-requests.json': contract, 'inputs.json': JSON.stringify(inputs),
      'binding.json': JSON.stringify(binding), 'completed.json': JSON.stringify(receipt), 'capture-status.json': JSON.stringify(capture)
    })) await writeFile(join(native, name), content);
    const restored = (await f.get('/api/project-secretary/conversations/' + q.conversationId)).data.messages[0];
    if (known) {
      assert.equal(restored.status, 'completed');
      assert.equal(restored.answer, original.answer);
      assert.deepEqual(restored.receipt, original.receipt);
    } else {
      assert.equal(restored.status, 'unavailable');
      assert.equal(restored.problem, 'project_chat_original_mismatch');
      assert.equal(restored.answer, null);
      assert.equal((await f.post('/api/project-secretary/ask', question('不能用未知格式追问', q.requestId, q.conversationId))).status, 503);
    }
    assert.deepEqual(await f.logs(), logs);
  }
});
