import type test from 'node:test';
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
import type {AISettingsConfig} from '../../src/ai-settings.js';
import type {inspectAIProvider} from '../../src/ai-catalog.js';

export async function normal(t:test.TestContext,resources=true,once=false,ai?:{config:AISettingsConfig;probe:typeof inspectAIProvider;billingProviders?:Array<'claude'|'kimi'>},modelMode='complete'){
  let observed!:Awaited<ReturnType<typeof monitored>>;
  const f=await ready(t,resources,'normal',modelMode,async context=>{observed=await monitored(context,modelMode);await sourceTick(observed.store);return observed;});
  if(f.ledger){const db=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite'));try{db.exec('UPDATE capacity SET n=2');}finally{db.close();}}
  if(ai?.billingProviders){f.plan.billing.providers=ai.billingProviders;await writeFile(f.path,JSON.stringify(f.plan));}
  const first=await runReception(f.path),original=await readFile(join(f.q.receiverState(first.operation).receiver.directory,'binding-input.json'));
  const delegate=once?f.confirmation:await f.adopt({kind:'delegate',adoption:f.scope.sha,roles:['receiver'],targets:['fixture'],actions:['receive'],paths:[],resourceRefs:f.action.resourceRefs,expiresAt:new Date(Date.now()+3600000).toISOString()});
  const {governance,...template}=f.plan,templatePath=join(f.root,'normal-receiver-template.json');await writeFile(templatePath,JSON.stringify(template));
  const resource=f.ledger?.profile.resources[0],catalogPath=join(f.root,'normal-reception-catalog.json');await writeFile(catalogPath,JSON.stringify({schemaVersion:1,kind:'tongxu-reception-controls',entries:[{id:'receive-current',source:'selected',template:{path:templatePath,sha256:hash(await readFile(templatePath))},authorization:delegate.sha,budgets:f.ledger?[{ledgerId:f.ledger.profile.ledgerId,resourceRef:resource!.ref,unit:resource!.unit,quantity:1}]:[]}]}));
  const planPath=join(f.root,'normal-reception-page.json');await writeFile(planPath,JSON.stringify({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Source reception fixture',goal:'Receive one changed source from normal entry',sources:[{id:'selected',title:'Original selected candidate',store:f.store,item:f.item}],githubProjects:true,...(ai?{aiSettings:ai.config}:{}),receptionControls:{path:catalogPath,sha256:hash(await readFile(catalogPath))}}));
  const repository={id:1,nodeId:'R_1',full_name:'fixture/reception',description:'Explicit source fixture',private:true,archived:false,defaultBranchRef:{name:'fixture',target:{oid:f.H}},updated_at:new Date().toISOString()},account={id:7,login:'fixture'};
  const github:GitHubReaderFactory=async()=>({query:async op=>({status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repository],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository}})})});
  const app=await startWorkbench(planPath,undefined,{githubReader:github,...(ai?{aiProbe:ai.probe}:{})});t.after(()=>app.close());const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'X-Tongxu-Account':'7','X-Tongxu-Project':'1'};
  await fetch(url.origin+'/api/github/projects',{headers});
  const get=async()=>{const response=await fetch(url.origin+'/api/state',{headers});assert.equal(response.status,200);return await response.json() as any;};
  const post=async(action:string,body:unknown={})=>{const response=await fetch(url.origin+'/api/reception/receive-current/'+action,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json() as any};};
  const settled=async()=>{for(let i=0;i<500;i++){const state=await get(),entry=state.receptions[0];if(!entry.controllerActive)return {state,entry};await new Promise(r=>setTimeout(r,20));}throw new Error('normal_reception_fixture_timeout');};
  return {...f,observed,first,original,delegate,planPath,app,url,headers,get,post,settled,github};
}

