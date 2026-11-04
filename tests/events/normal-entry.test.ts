import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ready} from '../w3/receiver-authority-fixture.js';
import {monitored} from './backend-fixture.js';
import {sourceTick} from '../../src/event-tick.js';
import {runReception} from '../../src/receiver.js';
import {startWorkbench} from '../../src/workbench.js';
import {hash} from '../../src/snapshot.js';
import type {GitHubReaderFactory} from '../../src/github-projects.js';

async function normal(t:test.TestContext,resources=true,once=false){
  let observed!:Awaited<ReturnType<typeof monitored>>;
  const f=await ready(t,resources,'normal','complete',async context=>{observed=await monitored(context);await sourceTick(observed.store);return observed;});
  if(f.ledger){const db=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite'));try{db.exec('UPDATE capacity SET n=2');}finally{db.close();}}
  const first=await runReception(f.path),original=await readFile(join(first.receiver.directory,'binding-input.json'));
  const delegate=once?f.confirmation:await f.adopt({kind:'delegate',adoption:f.scope.sha,roles:['receiver'],targets:['fixture'],actions:['receive'],paths:[],resourceRefs:f.action.resourceRefs,expiresAt:new Date(Date.now()+3600000).toISOString()});
  const {governance,...template}=f.plan,templatePath=join(f.root,'normal-receiver-template.json');await writeFile(templatePath,JSON.stringify(template));
  const resource=f.ledger?.profile.resources[0],catalogPath=join(f.root,'normal-reception-catalog.json');await writeFile(catalogPath,JSON.stringify({schemaVersion:1,kind:'tongxu-reception-controls',entries:[{id:'receive-current',source:'selected',template:{path:templatePath,sha256:hash(await readFile(templatePath))},authorization:delegate.sha,budgets:f.ledger?[{ledgerId:f.ledger.profile.ledgerId,resourceRef:resource!.ref,unit:resource!.unit,quantity:1}]:[]}]}));
  const planPath=join(f.root,'normal-reception-page.json');await writeFile(planPath,JSON.stringify({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Source reception fixture',goal:'Receive one changed source from normal entry',sources:[{id:'selected',title:'Original selected candidate',store:f.store,item:f.item}],githubProjects:true,receptionControls:{path:catalogPath,sha256:hash(await readFile(catalogPath))}}));
  const repository={id:1,nodeId:'R_1',full_name:'fixture/reception',description:'Explicit source fixture',private:true,archived:false,defaultBranchRef:{name:'fixture',target:{oid:f.H}},updated_at:new Date().toISOString()},account={id:7,login:'fixture'};
  const github:GitHubReaderFactory=async()=>({query:async op=>({status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repository],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository}})})});
  const app=await startWorkbench(planPath,undefined,{githubReader:github});t.after(()=>app.close());const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'X-Tongxu-Account':'7','X-Tongxu-Project':'1'};
  await fetch(url.origin+'/api/github/projects',{headers});
  const get=async()=>{const response=await fetch(url.origin+'/api/state',{headers});assert.equal(response.status,200);return await response.json() as any;};
  const post=async(action:string,body:unknown={})=>{const response=await fetch(url.origin+'/api/reception/receive-current/'+action,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json() as any};};
  const settled=async()=>{for(let i=0;i<500;i++){const state=await get(),entry=state.receptions[0];if(!entry.controllerActive)return {state,entry};await new Promise(r=>setTimeout(r,20));}throw new Error('normal_reception_fixture_timeout');};
  return {...f,observed,first,original,delegate,planPath,app,url,headers,get,post,settled,github};
}

test('normal selected project checks a changed source, starts exact governed reception, and reads the original result after reopen',async t=>{
  const f=await normal(t),initial=await f.get();assert.equal(initial.receptions[0].phase,'returned');assert.equal(await f.count(),1);
  await f.observed.source.change({comments:[{id:81,user:{id:15},body:'The empty input is an important counterexample.'}]});
  assert.equal((await f.post('check')).status,200);const changed=await f.get();assert.notEqual(changed.tasks[0].currentPacket,initial.tasks[0].currentPacket);assert.equal(await f.count(),1);
  assert.equal((await f.post('start',{expectedPacket:initial.tasks[0].currentPacket})).status,202);assert.equal((await f.settled()).entry.problem,'reception_material_changed_refresh_required');assert.equal(await f.count(),1);
  await f.post('start',{expectedPacket:changed.tasks[0].currentPacket});const done=await f.settled();assert.equal(done.entry.phase,'returned',JSON.stringify(done.entry));assert.notEqual(done.entry.operation,f.first.operation);assert.equal(await f.count(),2);
  const report=await fetch(f.url.origin+'/api/report/selected/'+done.entry.operation,{headers:f.headers}),value=await report.json() as any;assert.equal(report.status,200);assert.match(value.report,/模拟接收/);
  const q=f.q.receiverState(done.entry.operation);const actual=await readFile(join(q.receiver.directory,'binding-input.json'),'utf8');assert.match(actual,/important counterexample/);assert.deepEqual(await readFile(join(f.first.receiver.directory,'binding-input.json')),f.original);
  assert.equal(f.ledger!.state().claims.length,2);assert.equal(f.ledger!.state().settlements.length,2);assert.notEqual(q.receiver.resourceRequests[0],f.first.receiver.resourceRequests[0]);
  await f.post('start',{expectedPacket:done.state.tasks[0].currentPacket});await f.settled();assert.equal(await f.count(),2);
  const reopened=await startWorkbench(f.planPath,undefined,{githubReader:f.github});t.after(()=>reopened.close());const u=new URL(reopened.url),headers={...f.headers,Authorization:'Bearer '+u.hash.slice(1)};await fetch(u.origin+'/api/github/projects',{headers});const again=await(await fetch(u.origin+'/api/report/selected/'+done.entry.operation,{headers})).json() as any;assert.equal(again.report,value.report);assert.equal(await f.count(),2);
});

test('normal reception does not reuse an old one-shot confirmation for a changed packet',async t=>{
  const f=await normal(t,false,true);await f.observed.source.change({comments:[{id:82,user:{id:15},body:'New material requires its own receive permission.'}]});await f.post('check');const state=await f.get();await f.post('start',{expectedPacket:state.tasks[0].currentPacket});const ended=await f.settled();assert.match(ended.entry.problem,/confirmation_already_reserved|confirmation_exact_action_mismatch/);assert.equal(await f.count(),1);
});

test('check-only changes and temporary source loss never dispatch or replace the original reception',async t=>{
  const f=await normal(t,false),before=await f.get();await f.observed.source.change({checks:[{id:1,name:'unit',app:{id:4},head_sha:f.H,status:'completed',conclusion:'failure'}]});await f.post('check');const checks=await f.get();assert.equal(checks.tasks[0].currentPacket,before.tasks[0].currentPacket);await f.post('start',{expectedPacket:checks.tasks[0].currentPacket});assert.equal((await f.settled()).entry.operation,f.first.operation);assert.equal(await f.count(),1);
  await f.observed.source.change({mode:'forbidden-comments'});await f.post('check');await f.post('start',{expectedPacket:checks.tasks[0].currentPacket});await f.settled();assert.equal(await f.count(),1);
  await f.observed.source.change({mode:'normal'});await f.post('check');await f.post('start',{expectedPacket:checks.tasks[0].currentPacket});assert.equal((await f.settled()).entry.operation,f.first.operation);assert.equal(await f.count(),1);
  for(const change of [{H:'c'.repeat(40)},{B:'d'.repeat(40)},{target:'different-target'}]){await f.observed.source.change({H:f.first.candidate?.H??before.tasks[0].candidate.H,B:before.tasks[0].candidate.B,target:'fixture',...change});await f.post('check');await f.post('start',{expectedPacket:checks.tasks[0].currentPacket});const historical=await f.settled();assert.ok(historical.entry.eventSource.some((e:any)=>e.current===false));assert.equal(await f.count(),1);}
});


test('normal entry refuses stopped, revoked or unavailable-resource new receptions without replacing prior evidence',async t=>{
 const f=await normal(t,true),before=await f.count();await f.observed.source.change({comments:[{id:83,user:{id:15},body:'A new material packet needs fresh admission.'}]});await f.post('check');const state=await f.get(),packet=state.tasks[0].currentPacket;
 f.q.control('scope','investment','stopped','explicit fixture stop through original control');await f.post('start',{expectedPacket:packet});assert.equal((await f.settled()).entry.problem,'new_investment_stopped');assert.equal(await f.count(),before);assert.equal((await f.get()).receptions[0].investmentStopped,true);
 f.q.control('scope','investment','open','explicit fixture reopen without an Owner-stop override');
 const db=new DatabaseSync(join(f.ledger!.root,'original-fixture.sqlite'));try{db.exec('UPDATE capacity SET n=0');}finally{db.close();}
 await f.post('start',{expectedPacket:packet});const denied=await f.settled();assert.match(denied.entry.problem,/resource/);assert.equal(await f.count(),before);assert.equal(f.ledger!.state().claims.length,1);
 await f.adopt({kind:'revoke',decision:f.delegate.sha});await f.post('start',{expectedPacket:packet});assert.equal((await f.settled()).entry.problem,'owner_decision_revoked');assert.equal(await f.count(),before);assert.deepEqual(await readFile(join(f.first.receiver.directory,'binding-input.json')),f.original);
});
