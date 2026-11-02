import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

async function page(){
  class Element{[key:string]:any;children:Element[]=[];dataset:Record<string,string>={};value='';textContent='';constructor(readonly tag:string){}append(...children:Element[]){for(const child of children)child.parentElement=this;this.children.push(...children);}replaceChildren(...children:Element[]){const detach=(n:Element)=>{if(n.id&&nodes.get(n.id)===n)nodes.delete(n.id);for(const c of n.children)detach(c);};for(const child of this.children)if(!children.includes(child))detach(child);this.children=[];this.append(...children);}setAttribute(k:string,v:string){this[k]=v;}set id(v:string){this.elementId=v;nodes.set(v,this);}get id(){return this.elementId??'';}focus(){document.activeElement=this;}setSelectionRange(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;}}
  const nodes=new Map<string,Element>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id)!;},calls:Array<{path:string;resolve:(v:any)=>void;reject:(e:Error)=>void}>=[];
  const document:any={activeElement:null,body:{classList:{toggle:()=>{}}}},timers=new Map<number,()=>unknown>();let sequence=0,mainRenders=0;
  const context=createContext({crypto:{randomUUID},entryInfo:{githubProjects:true},gh:{account:{id:7},selected:{id:1,fullName:'fixture/project'},epoch:1},view:'github',key:'key',state:null,document,setTimeout:(fn:()=>unknown)=>{timers.set(++sequence,fn);return sequence;},clearTimeout:(id:number)=>timers.delete(id),githubErrors:{},readableReason:(x:any)=>x,date:(x:any)=>x,openSecretaryReport:()=>{},$:get,el:(tag:string,text?:string)=>Object.assign(new Element(tag),{textContent:text??''}),append:(e:Element,...items:Element[])=>{e.append(...items);return e;},intro:()=>new Element('intro'),renderGithub:()=>{mainRenders++;},api:(path:string)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject})),render:()=>{mainRenders++;}});
  runInContext(await readFile(new URL('../../../web/workbench/project-chat.js',import.meta.url),'utf8'),context);return {run:(s:string)=>runInContext(s,context),calls,nodes,document,timers,mainRenders:()=>mainRenders,fireTimer:()=>{const [id,fn]=[...timers][0]!;timers.delete(id);return fn();}};
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
