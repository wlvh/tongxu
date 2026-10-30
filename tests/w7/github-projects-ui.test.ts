import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

/** Execute the actual page's request/state functions with a controlled network.
 * Browser rendering and real GitHub are checked separately in the local trial. */
async function page(){
  const full=await readFile(new URL('../../../web/workbench/app.js',import.meta.url),'utf8'),end=full.lastIndexOf("document.querySelectorAll('[data-view]').forEach");assert.ok(end>0);
  const calls:Array<{path:string;resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
  class Element{
    [key:string]:any;children:any[]=[];attributes=new Map<string,string>();dataset:Record<string,string>={};open=false;textContent='';
    constructor(readonly tag:string){}
    append(...children:any[]){this.children.push(...children);}
    contains(node:any):boolean{return this===node||this.children.some(c=>c?.contains?.(node));}
    replaceChildren(...children:any[]){if(this.children.some(c=>c?.contains?.(document.activeElement)))document.activeElement=null;this.children=children;}
    get id(){return this.elementId;}
    set id(value:string){this.elementId=value;nodes.set(value,this);}
    focus(){document.activeElement=this;}
    setSelectionRange(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;}

    get firstChild(){return this.children[0];}
    setAttribute(k:string,v:string){this.attributes.set(k,v);}
    removeAttribute(k:string){this.attributes.delete(k);}
    showModal(){this.open=true;}
    close(){this.open=false;}
  }
  const nodes=new Map<string,Element>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id)!;},navigation=['projects','github','local-history','overview','tasks','events'].map(view=>{const n=new Element('button');n.dataset.view=view;return n;});
  const document:{[key:string]:any}={activeElement:null,getElementById:get,createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>Object.assign(new Element('text'),{textContent:text}),querySelector:(selector:string)=>get(selector),querySelectorAll:()=>navigation};
  const fetchCalls:Array<{path:string;options:any;resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
  const context=createContext({fetch:(path:string,options:any)=>new Promise((resolve,reject)=>fetchCalls.push({path,options,resolve,reject})),location:{hash:'#'+'a'.repeat(64)},document,setTimeout,clearTimeout});runInContext(full.slice(0,end),context);
  (context as any).fakeRead=(path:string)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject}));
  runInContext("githubApi=fakeRead;gh.account={id:7,login:'fixture'};entryInfo={githubProjects:true};",context);
  const run=(text:string)=>runInContext(text,context),state=()=>JSON.parse(run('JSON.stringify(gh)'));const findFilter=():Element=>{const visit=(n:Element):Element|undefined=>n.tag==='input'&&n.type==='search'?n:n.children.map((x:Element)=>visit(x)).find(Boolean);return visit(get('content'))!;};return {calls,fetchCalls,run,state,nodes,document,findFilter};
}
const data=(id:number,kind:string,number:number)=>({repository:{id,fullName:'fixture/repo'+id,description:'Fixture repository',private:true,archived:false,url:'https://github.com/fixture/repo'+id},kind,items:[{number,title:'repo'+id,labels:[],state:'open',updatedAt:'2026-10-30T00:00:00Z',author:'fixture',url:'https://github.com/fixture/repo'+id+'/issues/'+number}],page:1,hasNext:false,connection:{account:{id:7,login:'fixture'},checkedAt:'2026-10-30T00:00:00Z'}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('project workspace reads and writes carry the chosen account and repository, and discard late JSON bodies',async()=>{
  const p=await page();p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'})");
  const pending=p.run("api('/api/state')");assert.equal(p.fetchCalls[0]!.options.headers['X-Tongxu-Project'],'1');assert.equal(p.fetchCalls[0]!.options.headers['X-Tongxu-Account'],'7');
  let release!:(value:any)=>void;p.fetchCalls[0]!.resolve({ok:true,status:200,json:()=>new Promise(r=>release=r)});await flush();
  p.run("state={tasks:[{id:'original'}]};selected='original';chooseGithubProject({id:2,fullName:'fixture/repo2'})");
  assert.equal(p.run('state'),null);assert.equal(p.run('selected'),null);const rejected=assert.rejects(pending,/workbench_project_changed/);release({tasks:[{id:'original'}]});await rejected;
  const action=p.run("workspaceFetch('/api/secretary/new/ask',{method:'POST',headers:{Authorization:'Bearer test'},body:'{}'})");assert.equal(p.fetchCalls[1]!.options.headers['X-Tongxu-Project'],'2');assert.equal(p.fetchCalls[1]!.options.method,'POST');p.fetchCalls[1]!.resolve({ok:true,status:202,json:async()=>({})});await action;
});
test('changing project closes an original report and a late task-state reply cannot repopulate the new project',async()=>{
  const p=await page();p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'});view='overview';render=()=>{}");
  const pending=p.run('refresh()');p.run("$('report-dialog').showModal();chooseGithubProject({id:2,fullName:'fixture/repo2'})");assert.equal(p.nodes.get('report-dialog')!.open,false);
  p.fetchCalls[0]!.resolve({ok:true,status:200,json:async()=>({tasks:[{id:'wrong-project'}]})});await pending;assert.equal(p.run('state'),null);assert.equal(p.state().selected.id,2);
});
test('a project without tasks renders an explicit task/report empty state instead of indexing an absent task',async()=>{
  const p=await page();p.run("state={tasks:[],project:{repository:{fullName:'fixture/empty'}}};selected=null");
  assert.ok(p.run('taskView()'));assert.ok(p.run('overview()'));assert.equal(p.run('selected'),null);
});
test('switching projects while both lists are pending cannot let old responses overwrite the chosen repository',async()=>{
  const p=await page();p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'})");assert.equal(p.calls.length,2);p.run("chooseGithubProject({id:2,fullName:'fixture/repo2'})");assert.equal(p.calls.length,4);
  p.calls[2]!.resolve(data(2,'issues',22));p.calls[3]!.resolve(data(2,'pulls',23));await flush();p.calls[0]!.resolve(data(1,'issues',11));p.calls[1]!.resolve(data(1,'pulls',12));await flush();
  assert.equal(p.state().selected.id,2);assert.deepEqual(p.state().issues.items.map((x:any)=>x.number),[22]);assert.deepEqual(p.state().pulls.items.map((x:any)=>x.number),[23]);
});
test('one failed list preserves the other successful list and retry remains scoped to the selected project',async()=>{
  const p=await page();p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'})");p.calls[0]!.resolve(data(1,'issues',9));p.calls[1]!.reject(new Error('github_access_denied'));await flush();
  assert.equal(p.state().issues.items.length,1);assert.equal(p.run('gh.pulls.error.message'),'github_access_denied');const retry=p.run("loadGithubItems('pulls')");assert.match(p.calls[2]!.path,/repositories\/1\/pulls\?account=7/);p.calls[2]!.resolve(data(1,'pulls',65));await retry;assert.equal(p.state().pulls.items.length,1);
});
test('an account-change error clears prior private repository state and late successful responses cannot restore it',async()=>{
  const p=await page();p.run("gh.projects=[{id:1,fullName:'fixture/private'}];chooseGithubProject(gh.projects[0])");p.calls[0]!.reject(new Error('github_account_changed'));await flush();p.calls[1]!.resolve(data(1,'pulls',65));await flush();
  assert.equal(p.state().account,null);assert.equal(p.state().selected,null);assert.deepEqual(p.state().projects,[]);assert.equal(p.state().pulls,null);assert.equal(p.run('view'),'projects');
});
test('filter changes discard previously loaded rows and duplicate pending requests do not create another read',async()=>{
  const p=await page();p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'})");p.run("loadGithubItems('issues')");assert.equal(p.calls.length,2);p.calls[0]!.resolve(data(1,'issues',9));p.calls[1]!.resolve(data(1,'pulls',65));await flush();
  const pending=p.run("gh.issues.state='closed';gh.issues.items=[];gh.issues.page=0;loadGithubItems('issues')");assert.match(p.calls[2]!.path,/state=closed&page=1$/);assert.deepEqual(p.state().issues.items,[]);p.calls[2]!.resolve({...data(1,'issues',3),items:[]});await pending;assert.equal(p.state().issues.loading,false);
});


test('a stale detail dialog error cannot erase the new account after a successful recheck',async()=>{
  const p=await page();p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'})");p.calls[0]!.resolve(data(1,'issues',9));p.calls[1]!.resolve(data(1,'pulls',65));await flush();
  const detail=p.run("openGithubItem('issues',{number:9,title:'Old account detail'})");assert.equal(p.nodes.get('report-dialog')!.open,true);
  const recheck=p.run('loadGithubProjects()');p.calls[3]!.resolve({connection:{account:{id:8,login:'new-account'},checkedAt:'2026-10-30T00:00:01Z'},repositories:[{id:3,fullName:'new-account/private',description:'new',private:true,archived:false,updatedAt:'2026-10-30T00:00:00Z',url:'https://github.com/new-account/private'}],page:1,hasNext:false});await recheck;
  assert.equal(p.nodes.get('report-dialog')!.open,false);p.calls[2]!.reject(new Error('github_account_changed'));await detail;
  assert.equal(p.state().account.id,8);assert.equal(p.state().projects[0].id,3);assert.equal(p.state().error,null);assert.equal(p.run('view'),'projects');
});


test('an old project response does not replace the project filter while the user is typing',async()=>{
  const p=await page();p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'});void enterView('projects')");const input=p.findFilter();input.value='repo';input.oninput();input.focus();input.setSelectionRange(2,2);
  p.calls[0]!.resolve(data(1,'issues',9));p.calls[1]!.resolve(data(1,'pulls',65));await flush();assert.equal(p.findFilter(),input);assert.equal(p.document.activeElement,input);assert.equal(input.selectionStart,2);
});

test('project discovery preserves typed filter and caret when its asynchronous result arrives',async()=>{
  const p=await page();p.run("view='projects';render()");const pending=p.run('loadGithubProjects()'),input=p.findFilter();input.value='repo';input.oninput();input.focus();input.setSelectionRange(1,3);
  p.calls[0]!.resolve({connection:{account:{id:7,login:'fixture'},checkedAt:'2026-10-30T00:00:00Z'},repositories:[],page:1,hasNext:false,nextCursor:null});await pending;
  assert.equal(p.document.activeElement,p.findFilter());assert.equal(p.findFilter().value,'repo');assert.equal(p.findFilter().selectionStart,1);assert.equal(p.findFilter().selectionEnd,3);
});

test('retry after startup metadata failure retries the GitHub entry instead of silently loading legacy state',async()=>{
  const p=await page();p.run("entryInfo=null;view='overview';api=fakeRead");const first=p.run('startEntry()');assert.equal(p.calls[0]!.path,'/api/entry');p.calls[0]!.reject(new Error('temporary_unavailable'));await first;
  const retry=p.run('refresh()');assert.equal(p.calls[1]!.path,'/api/entry');p.calls[1]!.resolve({githubProjects:true,hasLocalSources:true,runtime:null});await flush();assert.equal(p.calls[2]!.path,'/api/github/projects?page=1');p.calls[2]!.resolve({connection:{account:{id:7,login:'fixture'},checkedAt:'2026-10-30T00:00:00Z'},repositories:[],page:1,hasNext:false,nextCursor:null});await retry;assert.equal(p.run('view'),'projects');assert.equal(p.calls.some(c=>c.path==='/api/state'),false);
});


test('each project and item load-more request carries the cursor returned to that view',async()=>{
  const p=await page();p.run("view='projects';gh.page=1;gh.hasNext=true;gh.nextCursor='projects/cursor A'");const projects=p.run('loadGithubProjects(true)');assert.match(p.calls[0]!.path,/cursor=projects%2Fcursor%20A$/);p.calls[0]!.resolve({connection:{account:{id:7,login:'fixture'},checkedAt:'2026-10-30T00:00:00Z'},repositories:[],page:2,hasNext:false,nextCursor:null});await projects;
  p.run("chooseGithubProject({id:1,fullName:'fixture/repo1'})");p.calls[1]!.resolve({...data(1,'issues',9),hasNext:true,nextCursor:'issues/cursor A'});p.calls[2]!.resolve(data(1,'pulls',65));await flush();const items=p.run("loadGithubItems('issues',true)");assert.match(p.calls[3]!.path,/cursor=issues%2Fcursor%20A$/);p.calls[3]!.resolve({...data(1,'issues',10),page:2,hasNext:false,nextCursor:null});await items;assert.deepEqual(p.state().issues.items.map((x:any)=>x.number),[9,10]);
});
