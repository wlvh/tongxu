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
    append(...nodes:any[]){this.children.push(...nodes);}
    replaceChildren(...nodes:any[]){this.children=nodes;}
    get firstChild(){return this.children[0];}
    setAttribute(k:string,v:string){this.attributes.set(k,v);}
    removeAttribute(k:string){this.attributes.delete(k);}
    showModal(){this.open=true;}
    close(){this.open=false;}
  }
  const nodes=new Map<string,Element>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id)!;},navigation=['projects','github','local-history','overview','tasks','events'].map(view=>{const n=new Element('button');n.dataset.view=view;return n;});
  const document={getElementById:get,createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>Object.assign(new Element('text'),{textContent:text}),querySelector:(selector:string)=>get(selector),querySelectorAll:()=>navigation};
  const context=createContext({location:{hash:'#'+'a'.repeat(64)},document,setTimeout,clearTimeout});runInContext(full.slice(0,end),context);
  (context as any).fakeRead=(path:string)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject}));
  runInContext("githubApi=fakeRead;gh.account={id:7,login:'fixture'};entryInfo={githubProjects:true};",context);
  const run=(text:string)=>runInContext(text,context),state=()=>JSON.parse(run('JSON.stringify(gh)'));return {calls,run,state,nodes};
}
const data=(id:number,kind:string,number:number)=>({repository:{id,fullName:'fixture/repo'+id,description:'Fixture repository',private:true,archived:false,url:'https://github.com/fixture/repo'+id},kind,items:[{number,title:'repo'+id,labels:[],state:'open',updatedAt:'2026-10-30T00:00:00Z',author:'fixture',url:'https://github.com/fixture/repo'+id+'/issues/'+number}],page:1,hasNext:false,connection:{account:{id:7,login:'fixture'},checkedAt:'2026-10-30T00:00:00Z'}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
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
