import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

async function page(){
  class Element{[key:string]:any;children:Element[]=[];dataset:Record<string,string>={};value='';textContent='';constructor(readonly tag:string){}append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(...nodes:Element[]){this.children=nodes;}setAttribute(k:string,v:string){this[k]=v;}set id(v:string){nodes.set(v,this);}get id(){return [...nodes].find(([,n])=>n===this)?.[0]??'';}}
  const nodes=new Map<string,Element>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id)!;},calls:Array<{path:string;resolve:(v:any)=>void;reject:(e:Error)=>void}>=[];
  const context=createContext({crypto:{randomUUID},gh:{account:{id:7},selected:{id:1,fullName:'fixture/project'},epoch:1},view:'secretary',key:'key',state:null,document:{activeElement:null},setTimeout,clearTimeout,githubErrors:{},readableReason:(x:any)=>x,date:(x:any)=>x,openSecretaryReport:()=>{},$:get,el:(tag:string,text?:string)=>Object.assign(new Element(tag),{textContent:text??''}),append:(e:Element,...items:Element[])=>{e.append(...items);return e;},intro:()=>new Element('intro'),renderGithub:()=>{},api:(path:string)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject})),render:()=>runInContext('renderProjectChat()',context)});
  runInContext(await readFile(new URL('../../../web/workbench/project-chat.js',import.meta.url),'utf8'),context);return {run:(s:string)=>runInContext(s,context),calls,nodes};
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
