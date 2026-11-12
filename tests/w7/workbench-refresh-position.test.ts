import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

// These tests run both actual page scripts together. Only the DOM renderer and
// network are fixtures. No implementation helper or storage key is prescribed.
// Paths are relative to the registered project root so Node 24 can also execute
// this protected TypeScript file directly inside the existing Docker executor.
const A={id:1,nodeId:'repo-node-a',fullName:'fixture/project-a',description:'A',private:true,archived:false};
const B={id:2,nodeId:'repo-node-b',fullName:'fixture/project-b',description:'B',private:true,archived:false};
const OLD='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',RECENT='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function flush(){for(let n=0;n<8;n++)await tick();}
type Options={account?:number;repos?:any[];conversations?:any[];listError?:boolean;storageError?:boolean;holdProjects?:boolean;holdConversations?:boolean;legacy?:boolean};
async function page(saved=new Map<string,string>(),options:Options={}){
  const calls:Array<{path:string;method:string;project?:string}>=[],held=new Map<string,()=>void>();
  const nodes=new Map<string,any>();
  const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{open:false,dataset:{},textContent:'',replaceChildren(){},close(){this.open=false;}});return nodes.get(id);};
  const document={getElementById:get,querySelector:get,querySelectorAll:()=>[],createElement:()=>({append(){},setAttribute(){}}),createTextNode:(s:string)=>s};
  const storage={getItem:(k:string)=>{if(options.storageError)throw Error('storage disabled');return saved.get(k)??null;},setItem:(k:string,v:string)=>{if(options.storageError)throw Error('storage disabled');saved.set(k,String(v));},removeItem:(k:string)=>{if(options.storageError)throw Error('storage disabled');saved.delete(k);},key:(i:number)=>[...saved.keys()][i]??null,get length(){return saved.size;}};
  const connection={account:{id:options.account??7,login:'fixture'},checkedAt:'2026-11-11T00:00:00Z'};
  const reply=(body:any,ok=true)=>({ok,status:ok?200:503,json:async()=>body});
  const fetch=async(path:string,request:any={})=>{
    calls.push({path,method:request.method??'GET',project:request.headers?.['X-Tongxu-Project']});
    if(path==='/api/entry')return reply({githubProjects:!options.legacy,runtime:null});
    if(path.startsWith('/api/github/projects')){
      if(options.holdProjects)await new Promise<void>(resolve=>held.set('projects',resolve));
      if(options.listError)return reply({error:'github_connection_unavailable'},false);
      return reply({connection,repositories:options.repos??[A,B],page:1,hasNext:false,nextCursor:null});
    }
    if(path.startsWith('/api/github/repositories/')){
      const repo=Number(path.split('/')[4])===2?B:A;
      return reply({connection,repository:repo,kind:path.includes('/pulls')?'pulls':'issues',items:[],page:1,hasNext:false,nextCursor:null});
    }
    if(path==='/api/project-secretary'){
      if(options.holdConversations)await new Promise<void>(resolve=>held.set('conversations',resolve));
      return reply({available:true,conversations:options.conversations??[{id:RECENT,title:'Recent'},{id:OLD,title:'Original'}],busy:[],supplementTargets:[],work:{options:[]},executionKind:'fixture'});
    }
    if(path.startsWith('/api/project-secretary/conversations/')){
      const id=path.split('/').at(-1);
      return reply({messages:[{id:'saved-answer',question:'原问题 '+id,status:'completed',answer:'完整原回答 '+id,active:false}],supplements:[],workRequests:[{id:'saved-work',original:{historical:true,completeCapture:true,report:{report:{report:'原实施完整结果 '+id}}}}]});
    }
    if(path==='/api/state')return reply({tasks:[]});
    throw Error('unexpected request '+path);
  };
  const context=createContext({document,location:{hash:'#'+'a'.repeat(64)},crypto:{randomUUID},sessionStorage:storage,fetch,setTimeout:()=>1,clearTimeout:()=>{},queueMicrotask});
  const app=await readFile('web/workbench/app.js','utf8'),end=app.lastIndexOf("document.querySelectorAll('[data-view]').forEach");assert.ok(end>0);
  runInContext(app.slice(0,end),context);runInContext(await readFile('web/workbench/project-chat.js','utf8'),context);
  runInContext('render=()=>{};renderProjectChat=()=>{};',context);
  const run=(code:string)=>runInContext(code,context),json=(code:string)=>JSON.parse(run('JSON.stringify('+code+')'));
  return {run,json,calls,saved,held,start:async()=>{await run('startEntry()');await flush();}};
}
function onlyReads(p:{calls:Array<{path:string;method:string}>}){assert.ok(p.calls.every(c=>c.method==='GET'));assert.ok(p.calls.filter(c=>c.path.startsWith('/api/github/projects')).every(c=>c.path==='/api/github/projects?page=1'));}
async function seed(){
  const p=await page();await p.start();p.run('chooseGithubProject('+JSON.stringify(A)+')');await flush();
  p.run('chooseProjectConversation('+JSON.stringify(OLD)+')');await flush();
  assert.equal(p.run('chatData().conversationId'),OLD);onlyReads(p);return new Map(p.saved);
}

test('two cold page refreshes recover the verified project, nonlatest conversation and full original result with only GETs',async()=>{
  const saved=await seed();assert.ok(saved.size>0,'the page must retain a navigation hint');
  for(let cold=0;cold<2;cold++){
    const p=await page(saved);await p.start();
    assert.equal(p.run('gh.selected?.id'),A.id);assert.equal(p.run('chatData()?.conversationId'),OLD);
    assert.equal(p.run('chatData().messages[0].answer'),'完整原回答 '+OLD);
    assert.equal(p.run('chatData().workRequests[0].original.report.report.report'),'原实施完整结果 '+OLD);onlyReads(p);
    const serialized=[...saved.values()].join('');assert.ok(!serialized.includes('a'.repeat(64)));assert.ok(!serialized.includes('原问题'));assert.ok(!serialized.includes('完整原回答'));
  }
});
for(const kind of ['account','repo-id','node','name','missing','failed'])test('a saved project is rejected after current '+kind+' changes',async()=>{
  const saved=await seed();const options:Options={};
  if(kind==='account')options.account=8;
  if(kind==='repo-id')options.repos=[{...A,id:9}];
  if(kind==='node')options.repos=[{...A,nodeId:'replacement-node'}];
  if(kind==='name')options.repos=[{...A,fullName:'fixture/renamed'}];
  if(kind==='missing')options.repos=[B];
  if(kind==='failed')options.listError=true;
  const p=await page(saved,options);await p.start();assert.equal(p.run('gh.selected'),null);assert.equal(p.run('view'),'projects');
  assert.ok(!p.calls.some(c=>c.path.startsWith('/api/project-secretary')));onlyReads(p);
});
test('a missing saved conversation follows the existing recent conversation and never requests the stale ID',async()=>{
  const p=await page(await seed(),{conversations:[{id:RECENT,title:'Recent'}]});await p.start();
  assert.equal(p.run('chatData()?.conversationId'),RECENT);assert.ok(!p.calls.some(c=>c.path.endsWith('/'+OLD)));onlyReads(p);
});
test('a manual project choice wins over a delayed cold-start restore',async()=>{
  const p=await page(await seed(),{holdProjects:true});const pending=p.run('startEntry()');await flush();assert.ok(p.held.has('projects'));
  p.run('gh.account={id:7,login:"fixture"};chooseGithubProject('+JSON.stringify(B)+')');await flush();
  p.held.get('projects')!();await pending;await flush();assert.equal(p.run('gh.selected?.id'),B.id);onlyReads(p);
});
test('a manual conversation choice wins over a delayed conversation-list restore',async()=>{
  const p=await page(await seed(),{holdConversations:true});await p.run('startEntry()');await flush();assert.ok(p.held.has('conversations'));
  p.run('chooseProjectConversation('+JSON.stringify(RECENT)+')');p.held.get('conversations')!();await flush();
  // The real loader queues one fresh read when a selection changes in flight.
  if(p.held.has('conversations'))p.held.get('conversations')!();await flush();
  assert.equal(p.run('chatData()?.conversationId'),RECENT);assert.ok(!p.calls.some(c=>c.path.endsWith('/'+OLD)));onlyReads(p);
});
test('bad or unavailable session storage does not stop normal project and conversation selection',async()=>{
  for(const kind of ['bad-json','wrong-type','unavailable']){
    const saved=await seed();for(const key of saved.keys())saved.set(key,kind==='bad-json'?'{':JSON.stringify({account:'7',repository:'1',conversation:42}));
    const p=await page(saved,{storageError:kind==='unavailable'});await p.start();assert.equal(p.run('gh.selected'),null);
    p.run('chooseGithubProject('+JSON.stringify(A)+')');await flush();p.run('chooseProjectConversation('+JSON.stringify(OLD)+')');await flush();
    assert.equal(p.run('chatData().conversationId'),OLD);assert.equal(p.run('chatData().messages[0].answer'),'完整原回答 '+OLD);onlyReads(p);
  }
});
test('legacy non-GitHub entry reads its local state without attempting project restoration',async()=>{
  const p=await page(await seed(),{legacy:true});await p.start();assert.ok(p.calls.some(c=>c.path==='/api/state'));
  assert.ok(!p.calls.some(c=>c.path.startsWith('/api/github/')||c.path.startsWith('/api/project-secretary')));onlyReads(p);
});
