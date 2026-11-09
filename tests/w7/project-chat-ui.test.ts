import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

async function page(){
  class Element{[key:string]:any;children:Element[]=[];dataset:Record<string,string>={};value='';textContent='';constructor(readonly tag:string){}append(...children:Element[]){for(const child of children)child.parentElement=this;this.children.push(...children);}replaceChildren(...children:Element[]){const detach=(n:Element)=>{if(n.id&&nodes.get(n.id)===n)nodes.delete(n.id);for(const c of n.children)detach(c);};for(const child of this.children)if(!children.includes(child))detach(child);this.children=[];this.append(...children);}setAttribute(k:string,v:string){this[k]=v;}set id(v:string){this.elementId=v;nodes.set(v,this);}get id(){return this.elementId??'';}focus(){document.activeElement=this;}setSelectionRange(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;}}
  const nodes=new Map<string,Element>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id)!;},calls:Array<{path:string;resolve:(v:any)=>void;reject:(e:Error)=>void}>=[];
  const document:any={activeElement:null,body:{classList:{toggle:()=>{}}}},timers=new Map<number,()=>unknown>();let sequence=0,mainRenders=0;const sends:Array<{path:string;options:any;resolve:(v:any)=>void}>=[];
  const context=createContext({crypto:{randomUUID},entryInfo:{githubProjects:true},gh:{account:{id:7},selected:{id:1,fullName:'fixture/project'},epoch:1},view:'github',key:'key',state:null,document,setTimeout:(fn:()=>unknown)=>{timers.set(++sequence,fn);return sequence;},clearTimeout:(id:number)=>timers.delete(id),githubErrors:{},readableReason:(x:any)=>x,date:(x:any)=>x,openSecretaryReport:()=>{},$:get,el:(tag:string,text?:string)=>Object.assign(new Element(tag),{textContent:text??''}),append:(e:Element,...items:Element[])=>{e.append(...items);return e;},intro:()=>new Element('intro'),renderGithub:()=>{mainRenders++;},api:(path:string)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject})),render:()=>{mainRenders++;}});
  (context as any).workspaceFetch=(path:string,options:any)=>new Promise(resolve=>sends.push({path,options,resolve}));
  runInContext(await readFile(new URL('../../../web/workbench/project-chat.js',import.meta.url),'utf8'),context);return {run:(s:string)=>runInContext(s,context),calls,sends,nodes,document,timers,mainRenders:()=>mainRenders,fireTimer:()=>{const [id,fn]=[...timers][0]!;timers.delete(id);return fn();}};
}
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const list={available:true,conversations:[{id:A,title:'A'},{id:B,title:'B'}],busy:[],executionKind:'fixture'};
const messages=(id:string)=>[{id:id+'-answer',question:'question '+id,status:'completed',answer:'answer '+id,receipt:{reportSha256:id},active:false}];
const flush=()=>new Promise(r=>setImmediate(r));
test('the real conversation selector queues a new read and never paints a delayed A reply under B',async()=>{
  const p=await page();p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:messages(A)})});renderProjectChat()`);
  const pending=p.run('loadProjectChat()');p.calls[0]!.resolve(list);await flush();assert.ok(p.calls[1]!.path.endsWith(A));
  p.nodes.get('project-chat-history')!.value=B;p.nodes.get('project-chat-history')!.onchange();p.calls[1]!.resolve({messages:messages(A)});await pending;await flush();
  assert.equal(p.run('chatData().conversationId'),B);assert.deepEqual(JSON.parse(p.run('JSON.stringify(chatData().messages)')),[]);assert.equal(p.calls[2]!.path,'/api/project-secretary');
  p.calls[2]!.resolve(list);await flush();assert.ok(p.calls[3]!.path.endsWith(B));p.calls[3]!.resolve({messages:messages(B)});await flush();assert.equal(p.run('chatData().messages[0].question'),'question '+B);
});
test('switching away and back during a read schedules the current project instead of leaving its composer loading forever',async()=>{
  const p=await page();p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:messages(A)})});renderProjectChat()`);
  const pending=p.run('loadProjectChat()');p.calls[0]!.resolve(list);await flush();p.run("gh.epoch+=2;void loadProjectChat()");p.calls[1]!.resolve({messages:messages(A)});await pending;await flush();assert.equal(p.calls[2]!.path,'/api/project-secretary');p.calls[2]!.resolve(list);await flush();p.calls[3]!.resolve({messages:messages(A)});await flush();assert.equal(p.run('chatData().loading'),false);
});
test('refresh keeps the actual input element and draft while displaying a new answer',async()=>{
  const p=await page();p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:[]})});renderProjectChat()`);const input=p.nodes.get('project-chat-input')!;input.value='我正在输入追问';input.oninput();const pending=p.run('loadProjectChat()');p.calls[0]!.resolve(list);await flush();p.calls[1]!.resolve({messages:messages(A)});await pending;assert.equal(p.nodes.get('project-chat-input'),input);assert.equal(input.value,'我正在输入追问');
});

test('main navigation and folding retain one composer, its draft and caret without a send or main-page redraw',async()=>{
  const p=await page();p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:[]})});renderProjectChat()`);
  const input=p.nodes.get('project-chat-input')!,root=p.nodes.get('project-chat-root')!;input.value='边看 PR 边输入的草稿';input.oninput();input.focus();input.setSelectionRange(3,7);input.oncompositionstart();
  for(const view of ['github','tasks','ai-settings','retrospective']){p.run(`view=${JSON.stringify(view)};renderProjectChat()`);assert.equal(p.nodes.get('project-chat-input'),input);assert.equal(p.document.activeElement,input);assert.equal(input.selectionStart,3);assert.equal(input.value,'边看 PR 边输入的草稿');}
  p.run('setSecretaryOpen(false)');assert.equal(p.nodes.get('secretary-dock')!.hidden,true);p.run('setSecretaryOpen(true)');assert.equal(p.nodes.get('project-chat-root'),root);assert.equal(p.nodes.get('project-chat-input'),input);assert.equal(p.calls.length,0);assert.equal(p.mainRenders(),0);
});
test('active progress continues on another main page and while folded, without touching the main view or adding input',async()=>{
  const p=await page(),active={...list,busy:[{conversationId:A,requestId:'active',status:'running'}]};p.run(`Object.assign(chatData(),${JSON.stringify({...active,ready:true,initialLoaded:true,conversationId:A,messages:[]})});view='tasks';renderProjectChat()`);
  const first=p.run('loadProjectChat()');p.calls[0]!.resolve(active);await flush();p.calls[1]!.resolve({messages:[{id:'active',question:'q',status:'running',answer:null,active:true,owned:true}]});await first;assert.equal(p.timers.size,1);
  p.run('setSecretaryOpen(false)');assert.match(p.nodes.get('secretary-toggle')!.textContent,/处理中/);const poll=p.fireTimer();p.calls[2]!.resolve(list);await flush();p.calls[3]!.resolve({messages:messages(A)});await poll;
  assert.equal(p.run('view'),'tasks');assert.equal(p.run('chatData().messages[0].status'),'completed');assert.equal(p.timers.size,0);p.run('setSecretaryOpen(true)');assert.equal(p.nodes.get('project-chat-send')!.disabled,false);assert.equal(p.mainRenders(),0);assert.ok(p.calls.every(c=>c.path.startsWith('/api/project-secretary')));
});
test('an interrupted owned turn is readable in the companion and never presented as a final answer',async()=>{
  const p=await page();p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:[{id:'stopped',question:'q',status:'interrupted',problem:'native_turn_interrupted',answer:null,active:false,owned:false}]})});renderProjectChat()`);
  const text=(e:any):string=>e.textContent+e.children.map(text).join('');const result=text(p.nodes.get('project-chat-lines'));assert.match(result,/本轮已中断，未形成完整回答/);assert.doesNotMatch(result,/native_turn_interrupted|停止本轮/);assert.equal(p.calls.length,0);
});
test('a late reply from another project cannot replace the visible conversation or its unsent draft',async()=>{
  const p=await page();p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:[]})});renderProjectChat()`);const original=p.nodes.get('project-chat-input')!;original.value='项目 A 草稿';original.oninput();const pending=p.run('loadProjectChat()');p.calls[0]!.resolve(list);await flush();
  p.run("gh.epoch++;gh.selected={id:2,fullName:'fixture/other'};renderProjectChat();");const other=p.nodes.get('project-chat-input')!;assert.notEqual(other,original);assert.equal(other.value,'');other.value='项目 B 草稿';other.oninput();p.calls[1]!.resolve({messages:messages(A)});await pending;assert.equal(other.value,'项目 B 草稿');assert.deepEqual(JSON.parse(p.run('JSON.stringify(chatData().messages)')),[]);
  p.run("gh.epoch++;gh.selected={id:1,fullName:'fixture/project'};renderProjectChat()");assert.equal(p.nodes.get('project-chat-input')!.value,'项目 A 草稿');assert.equal(p.mainRenders(),0);
});

test('a busy secretary keeps the bounded task supplement composer available and posts only a saved intent',async()=>{
 const p=await page(),target={source:'implementation',requestId:'original',task:'a'.repeat(64),operation:'12345678-1234-4234-8234-123456789abc'},receipt={id:'new',text:'保留原结果补充',target,cancelled:false,compiledRequest:null,original:{ready:false,reason:'project_supplement_original_pending_or_unknown'}};
 p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:[],busy:[{requestId:'secretary-busy',status:'running'}],supplementTargets:[{...target,title:'原任务A'}]})});renderProjectChat()`);
 assert.equal(p.nodes.get('project-chat-send')!.disabled,true);const choose=p.nodes.get('project-chat-recipient')!;choose.value=JSON.stringify(target);choose.onchange();assert.equal(p.nodes.get('project-chat-send')!.disabled,false);const input=p.nodes.get('project-chat-input')!;input.value=receipt.text;input.oninput();p.run('loadProjectChat=async()=>{}');const pending=p.run('sendProjectChat()');assert.equal(p.sends.length,1);assert.equal(p.sends[0]!.path,'/api/project-secretary/supplement');const body=JSON.parse(p.sends[0]!.options.body);assert.deepEqual(body.target,target);assert.equal(body.text,receipt.text);assert.equal(body.conversationId,A);assert.equal(Object.hasOwn(body,'parent'),false);p.sends[0]!.resolve({ok:true,json:async()=>({received:true,newModelInputs:0})});await pending;
 p.run(`chatData().supplements=[${JSON.stringify(receipt)}];renderProjectChat()`);assert.equal(p.nodes.get('project-chat-supplements')!.children[0]!.children[0]!.textContent,'补充已收件');assert.equal(p.mainRenders(),0);
});


test('selected approved work uses an explicit ask mode with fixed target and keeps busy work separate from saved supplements',async()=>{
 const p=await page(),target={source:'implementation',issueNumber:74};p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:[],workOptions:[{...target,title:'Issue #74'}]})});renderProjectChat()`);const choose=p.nodes.get('project-chat-recipient')!;choose.value=JSON.stringify({kind:'project_work',target});choose.onchange();assert.equal(p.nodes.get('project-chat-send')!.textContent,'交给秘书办理');assert.match(p.nodes.get('project-chat-limit')!.textContent,/额外文字不增加权限/);const input=p.nodes.get('project-chat-input')!;input.value='保留这段完整原话并办理所选工作';input.oninput();p.run('loadProjectChat=async()=>{}');const pending=p.run('sendProjectChat()');assert.equal(p.sends[0]!.path,'/api/project-secretary/ask');const body=JSON.parse(p.sends[0]!.options.body);assert.deepEqual(body.workTarget,target);assert.equal(body.question,input.value);assert.equal(body.conversationId,A);p.sends[0]!.resolve({ok:true,json:async()=>({registered:true})});await pending;p.run("chatData().busy=[{status:'running'}];renderProjectChat()");assert.equal(p.nodes.get('project-chat-send')!.disabled,true);await p.run('sendProjectChat()');assert.equal(p.sends.length,1);
});

test('secretary answer completion cannot replace original work state or its unsettled complete report',async()=>{
 const p=await page(),receipt={id:A,text:'work',target:{source:'implementation',issueNumber:74},originalRequestId:A,linkedExisting:true,cancelRequested:false,original:{phase:'active_or_unknown',status:null,controllerActive:true,resourcesSettled:false,report:null}};p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:messages(A),workRequests:[receipt]})});renderProjectChat()`);const text=(e:any):string=>e.textContent+e.children.map(text).join('');assert.match(text(p.nodes.get('project-chat-work')),/原实施已开始或状态待核/);assert.match(text(p.nodes.get('project-chat-work')),/新增文字没有冒称被旧实施消费/);assert.doesNotMatch(text(p.nodes.get('project-chat-work')),/原实施已有完整结果/);p.run(`chatData().workRequests[0].original=${JSON.stringify({phase:'returned',status:'completed',H0:'a'.repeat(40),H1:'b'.repeat(40),controllerActive:false,resourcesSettled:false,report:{completeCapture:true,report:{report:'FULL ORIGINAL ROLE REPORT'}}})};renderProjectChat()`);assert.match(text(p.nodes.get('project-chat-work')),/FULL ORIGINAL ROLE REPORT/);assert.match(text(p.nodes.get('project-chat-work')),/原资源结果仍待核/);assert.match(text(p.nodes.get('project-chat-work')),/实施提交 bbbbbbbbbbbb/);p.run("Object.assign(chatData().workRequests[0].original,{status:'no_change',H1:null});renderProjectChat()");assert.match(text(p.nodes.get('project-chat-work')),/未产生新提交，结果基于原提交 aaaaaaaaaaaa/);p.run("chatData().workRequests[0].original=null;chatData().workRequests[0].problem='implementation_issue_source_changed';renderProjectChat()");assert.match(text(p.nodes.get('project-chat-work')),/原工作状态待核/);assert.equal(p.sends.length,0);
});

test('rejected work cancellation keeps original execution and unsettled resources observable without new input',async()=>{
 const p=await page(),receipt={id:A,text:'selected work',target:{source:'implementation',issueNumber:74},originalRequestId:A,cancelRequested:true,problem:'implementation_sent_or_unknown_cannot_cancel',original:{phase:'active_or_unknown',status:null as string|null,controllerActive:true,resourcesSettled:false,report:null as any,H0:'a'.repeat(40),H1:null}};
 p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:messages(A),workRequests:[receipt]})});renderProjectChat()`);const input=p.nodes.get('project-chat-input')!;input.value='保留当前草稿';input.oninput();
 let pending=p.run('loadProjectChat()');p.calls[0]!.resolve(list);await flush();p.calls[1]!.resolve({messages:messages(A),workRequests:[receipt]});await pending;assert.equal(p.timers.size,1);
 // An original whose controller ended but whose execution is unknown still
 // needs observation; cancellation intent is not a terminal execution fact.
 receipt.original.controllerActive=false;pending=p.fireTimer();p.calls[2]!.resolve(list);await flush();p.calls[3]!.resolve({messages:messages(A),workRequests:[receipt]});await pending;assert.equal(p.timers.size,1);
 receipt.original.phase='returned';receipt.original.status='no_change';receipt.original.report={completeCapture:true,report:{report:'LATE COMPLETE ORIGINAL REPORT'}};pending=p.fireTimer();p.calls[4]!.resolve(list);await flush();p.calls[5]!.resolve({messages:messages(A),workRequests:[receipt]});await pending;assert.equal(p.timers.size,1);const text=(e:any):string=>e.textContent+e.children.map(text).join('');assert.match(text(p.nodes.get('project-chat-work')),/LATE COMPLETE ORIGINAL REPORT/);assert.match(text(p.nodes.get('project-chat-work')),/原资源结果仍待核/);
 receipt.original.resourcesSettled=true;pending=p.fireTimer();p.calls[6]!.resolve(list);await flush();p.calls[7]!.resolve({messages:messages(A),workRequests:[receipt]});await pending;assert.equal(p.timers.size,0);assert.equal(p.nodes.get('project-chat-input'),input);assert.equal(input.value,'保留当前草稿');assert.equal(p.sends.length,0);assert.ok(p.calls.every(c=>c.path.startsWith('/api/project-secretary')));
});

test('cancelled work with no original or a settled unstarted terminal does not keep polling',async()=>{
 for(const original of [null,{phase:'returned',status:'cancelled_unstarted',controllerActive:false,resourcesSettled:true,report:null}]){
  const p=await page(),receipt={id:A,text:'cancelled intent',target:{source:'implementation',issueNumber:74},originalRequestId:original?A:null,cancelRequested:true,problem:null,original};p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:messages(A)})})`);const pending=p.run('loadProjectChat()');p.calls[0]!.resolve(list);await flush();p.calls[1]!.resolve({messages:messages(A),workRequests:[receipt]});await pending;assert.equal(p.timers.size,0);assert.equal(p.sends.length,0);
 }
});


test('a tool-limit failure explains both the call budget and allowed tools without a false answer or resend',async()=>{
 const p=await page();p.run(`Object.assign(chatData(),${JSON.stringify({...list,ready:true,initialLoaded:true,conversationId:A,messages:[{id:'limited',question:'q',status:'failed',problem:'project_chat_tool_limit',answer:null,active:false,owned:false}]})});renderProjectChat()`);
 const text=(e:any):string=>e.textContent+e.children.map(text).join('');const result=text(p.nodes.get('project-chat-lines'));assert.match(result,/每轮最多调用24次/);assert.match(result,/当前模式已登记的工具/);assert.match(result,/未形成完整回答/);assert.doesNotMatch(result,/project_chat_tool_limit|正在读取资料并回答/);assert.equal(p.sends.length,0);assert.equal(p.timers.size,0);
});

test('an invalid secretary report explains the final reference requirement without a false answer or resend', async () => {
  const p = await page();
  p.run(`Object.assign(chatData(),${JSON.stringify({ ...list, ready: true, initialLoaded: true, conversationId: A, messages: [{ id: 'invalid', question: 'q', status: 'failed', problem: 'invalid_secretary_report', answer: null, active: false, owned: false }] })});renderProjectChat()`);
  const text = (element: any): string => element.textContent + element.children.map(text).join('');
  const result = text(p.nodes.get('project-chat-lines'));
  assert.match(result, /格式或证据引用不符合要求/);
  assert.match(result, /1至8条/);
  assert.match(result, /未形成完整回答/);
  assert.match(result, /原始记录保留/);
  assert.doesNotMatch(result, /invalid_secretary_report|正在读取资料并回答/);
  assert.equal(p.sends.length, 0);
  assert.equal(p.timers.size, 0);
});
