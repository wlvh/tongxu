import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {setup} from '../w3/receiver-fixture.js';
import {secretaryEntryFixture} from './secretary-entry-fixture.js';
import {runReception} from '../../src/receiver.js';
import {startWorkbench} from '../../src/workbench.js';
import type {GitHubReaderFactory} from '../../src/github-projects.js';
import {hash} from '../../src/snapshot.js';

function github(){
  let account={id:7,login:'fixture'};
  const repositories=['fixture/reception','fixture/other','fixture/empty'].map((full_name,index)=>({id:index+1,nodeId:'R_'+(index+1),full_name,description:'Explicit fixture',private:true,archived:false,defaultBranchRef:{name:'main',target:{oid:'a'.repeat(40)}},updated_at:'2026-10-30T00:00:00Z'}));
  let unavailable=false;const factory:GitHubReaderFactory=async()=>({query:async(op,variables)=>{assert.ok(['projects','project'].includes(op));return {status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:repositories,pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository:unavailable?null:repositories.find(r=>r.nodeId===variables.id)}})};}});
  return {factory,removeAccess:()=>{unavailable=true;},changeAccount:()=>{account={id:8,login:'new-account'};}};
}
async function mixed(t:test.TestContext){
  const a=await secretaryEntryFixture(t),b=await setup(t,'complete',1,true,'fixture/other'),received=await runReception(b.path),originalPlan=JSON.parse(await readFile(a.path,'utf8'));
  const plan={...originalPlan,githubProjects:true,sources:[...originalPlan.sources,{id:'other',title:'Other project original',store:b.store,item:b.item}]},path=join(a.fixtureRoot,'project-workbench.json');await writeFile(path,JSON.stringify(plan));
  const gh=github(),app=await startWorkbench(path,undefined,{githubReader:gh.factory});let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};t.after(close);const u=new URL(app.url),auth={Authorization:'Bearer '+u.hash.slice(1)};
  const headers=(project:number)=>({...auth,'X-Tongxu-Account':'7','X-Tongxu-Project':String(project)});
  const get=(project:number,path='/api/state')=>fetch(u.origin+path,{headers:headers(project)});
  const post=(project:number,path:string,body:unknown)=>fetch(u.origin+path,{method:'POST',headers:{...headers(project),Origin:u.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(u.origin+'/api/github/projects',{headers:auth})).status,200);
  return {a,b,received,plan,path,gh,app,u,auth,get,post,close};
}
test('selected repository scopes tasks, original full reports, secretary and repeated independent page reads',async t=>{
  const f=await mixed(t),beforeA=await readFile(f.a.trace),beforeB=await readFile(f.b.trace);
  const a=await(await f.get(1)).json() as any,b=await(await f.get(2)).json() as any;
  assert.deepEqual(a.tasks.map((x:any)=>x.id),['selected']);assert.deepEqual(b.tasks.map((x:any)=>x.id),['other']);
  assert.equal(a.project.repository.fullName,'fixture/reception');assert.equal(b.project.repository.fullName,'fixture/other');
  assert.deepEqual(a.secretaries.map((x:any)=>x.source),['selected']);assert.deepEqual(b.secretaries,[]);
  assert.ok(!JSON.stringify(a).includes(f.b.item));assert.ok(!JSON.stringify(b).includes(f.a.item));
  const report=await(await f.get(2,'/api/report/other/'+f.received.operation)).json() as any;assert.equal(report.report,f.received.receiver.judgment.report);
  assert.equal((await f.get(1,'/api/report/other/'+f.received.operation)).status,404);
  assert.equal((await f.get(2,'/api/secretary-report/selected/foreign')).status,503);
  const again=await(await f.get(1)).json() as any;assert.deepEqual(again.tasks.map((x:any)=>x.id),['selected']);
  assert.deepEqual(await readFile(f.a.trace),beforeA);assert.deepEqual(await readFile(f.b.trace),beforeB);
});
test('a project without local tasks is empty; missing or changed identity cannot use original read or write routes',async t=>{
  const f=await mixed(t),empty=await(await f.get(3)).json() as any;
  assert.deepEqual(empty.tasks,[]);assert.deepEqual(empty.events,[]);assert.equal(empty.project.repository.fullName,'fixture/empty');assert.equal(empty.secretaries,undefined);
  assert.equal((await fetch(f.u.origin+'/api/state',{headers:f.auth})).status,503);
  assert.equal((await f.post(2,'/api/secretary/selected/ask',{requestId:'wrong-project',question:'must not be sent'})).status,503);
  assert.equal((await f.post(3,'/api/secretary/selected/ask',{requestId:'empty-project',question:'must not be sent'})).status,405);
  assert.equal((await f.a.logs()).length,0);
  f.gh.changeAccount(); // No discovery refresh: the original routes must observe the actual changed viewer.
  assert.equal((await f.get(1)).status,503);assert.equal((await f.post(1,'/api/secretary/selected/ask',{requestId:'old-account',question:'must not be sent'})).status,503);assert.equal((await f.a.logs()).length,0);
});
test('original routes recheck actual repository access instead of accepting a previously discovered private repository',async t=>{
  const f=await mixed(t);assert.equal((await f.get(1)).status,200);f.gh.removeAccess();
  assert.equal((await f.get(1)).status,503);assert.equal((await f.get(1,'/api/secretary-report/selected/original')).status,503);
  assert.equal((await f.post(1,'/api/secretary/selected/ask',{requestId:'revoked',question:'must not run'})).status,503);assert.equal((await f.a.logs()).length,0);
});
test('a source unknown on first entry can recover in the same server without an empty project cache blocking it',async t=>{
  const f=await mixed(t),path=join(f.a.store,'queue.sqlite'),saved=join(f.a.store,'preserved.sqlite');await rename(path,saved);
  try{const response=await f.get(1);assert.equal(response.status,200);const unknown=await response.json() as any;assert.deepEqual(unknown.tasks,[]);assert.equal(unknown.project.unresolvedSourceCount,1);}
  finally{await rename(saved,path);}
  const response=await f.get(1);assert.equal(response.status,200);const recovered=await response.json() as any;
  assert.deepEqual(recovered.tasks.map((x:any)=>x.id),['selected']);assert.equal(recovered.project.unresolvedSourceCount,0);assert.equal(recovered.secretaries[0].source,'selected');assert.equal((await f.a.logs()).length,0);
});
test('one project secretary retains its original result on switch, duplicate and cold re-entry without another model input',async t=>{
  const f=await mixed(t),body={requestId:'project-question',question:'Read this project original report'};
  assert.equal((await f.post(1,'/api/secretary/selected/ask',body)).status,202);
  let question:any;for(let i=0;i<150;i++){const state=await(await f.get(1)).json() as any;question=state.secretaries[0].questions[0];if(question?.phase==='completed')break;await new Promise(r=>setTimeout(r,40));}
  assert.equal(question?.phase,'completed');const report=await(await f.get(1,'/api/secretary-report/selected/'+body.requestId)).json() as any;assert.ok(report.result.report.length>0);
  assert.deepEqual((await(await f.get(2)).json() as any).secretaries,[]);assert.equal((await f.post(1,'/api/secretary/selected/ask',body)).status,202);
  assert.equal((await f.a.logs()).filter((x:any)=>x.kind==='model-input').length,1);await f.close();
  const reopened=await startWorkbench(f.path,undefined,{githubReader:f.gh.factory});t.after(()=>reopened.close());const u=new URL(reopened.url),headers={Authorization:'Bearer '+u.hash.slice(1)};await fetch(u.origin+'/api/github/projects',{headers});
  const after=await(await fetch(u.origin+'/api/secretary-report/selected/'+body.requestId,{headers:{...headers,'X-Tongxu-Account':'7','X-Tongxu-Project':'1'}})).json() as any;
  assert.equal(after.result.report,report.result.report);assert.equal((await f.a.logs()).filter((x:any)=>x.kind==='model-input').length,1);
});
test('unreadable unselected source and template do not hide the selected project or become its task',async t=>{
  const f=await mixed(t),raw=JSON.parse(await readFile(f.a.catalogPath,'utf8'));raw.entries.push({source:'other',title:'Unavailable other template',template:{path:join(f.b.root,'absent-template'),sha256:'a'.repeat(64)},outputRoot:join(f.b.root,'questions')});
  const catalog=join(f.a.fixtureRoot,'mixed-catalog.json');await writeFile(catalog,JSON.stringify(raw));const path=join(f.a.fixtureRoot,'bad-other-plan.json');await writeFile(path,JSON.stringify({...f.plan,secretary:{path:catalog,sha256:hash(await readFile(catalog))}}));
  const app=await startWorkbench(path,undefined,{githubReader:f.gh.factory});t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)};await fetch(u.origin+'/api/github/projects',{headers});
  const selected=await fetch(u.origin+'/api/state',{headers:{...headers,'X-Tongxu-Account':'7','X-Tongxu-Project':'1'}});assert.equal(selected.status,200);assert.deepEqual(((await selected.json()) as any).tasks.map((x:any)=>x.id),['selected']);
  await rename(join(f.b.store,'queue.sqlite'),join(f.b.store,'preserved.sqlite'));try{
    const state=await(await fetch(u.origin+'/api/state',{headers:{...headers,'X-Tongxu-Account':'7','X-Tongxu-Project':'3'}})).json() as any;assert.deepEqual(state.tasks,[]);assert.equal(state.project.unresolvedSourceCount,0); // Previously observed as another repository.
  }finally{await rename(join(f.b.store,'preserved.sqlite'),join(f.b.store,'queue.sqlite'));}
});
