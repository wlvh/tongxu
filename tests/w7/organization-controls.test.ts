import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {OrganizationControls} from '../../src/organization-controls.js';
import {startWorkbench,parseWorkbenchPlan} from '../../src/workbench.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';

async function setup(t:test.TestContext){
  const f=await messageFixture(t),second=await f.packet({pr:2});
  const sources=[{id:'a',title:'任务A',store:f.store,item:f.item},{id:'b',title:'任务B',store:f.store,item:second.item}];
  const base:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'selected-two-tasks',revision:'template',previous:null,source:'Explicit organization fixture; no models and no transfer granted',authorityIntent:null,mode:'parallel',actors:[{id:'A',tool:'codex'},{id:'B',tool:'claude'}],tasks:[{id:'A',item:f.item,actor:'A',originActor:'A',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['src/a.ts'],workspace:'/private/fixture-A-private-workspace',publishBranch:'fixture-a',outputs:[{id:'A-report',stage:'investigate',kind:'message_report'}]},{id:'B',item:second.item,actor:'B',originActor:'B',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['src/b.ts'],workspace:'/private/fixture-B-private-workspace',publishBranch:'fixture-b',outputs:[]}],shared:[{id:'shared-api',tasks:['A','B'],paths:['src/shared.ts'],contract:'Both tasks must acknowledge the fixed shared contract before implementation.',feedbackFrom:['A','B'],blockedStages:['implement']}],dependencies:[]};
  const serial=structuredClone(base);serial.mode='stage_serial';serial.dependencies=[{task:'B',stage:'implement',producer:'A',capability:'A-report'}];const unified=structuredClone(base);unified.mode='unified_owner';unified.tasks[1]!.actor='A';unified.tasks[1]!.dispatch='other_tool_new';
  const templates=[base,serial,unified],choices=[];for(const [index,plan] of templates.entries()){const path=join(f.root,'organization-'+index+'.json');await writeFile(path,canonical(plan));choices.push({id:['parallel','serial','unified'][index]!,title:['分别推进','依赖阶段串行','明确统一负责人'][index]!,plan:{path,sha256:hash(await readFile(path))}});}
  const group={id:'pair',title:'两个原任务',sources:['a','b'],choices,delegation:null as {adoption:string;authorization:string}|null},catalog={schemaVersion:1,kind:'tongxu-workbench-organization',groups:[group]},catalogPath=join(f.root,'organization.json'),path=join(f.root,'organization-workbench.json');
  const load=async()=>{await writeFile(catalogPath,canonical(catalog));const sha256=hash(await readFile(catalogPath)),plan={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'组织方式明确夹具',goal:'No model request or actual write handoff',sources,organization:{path:catalogPath,sha256}};await writeFile(path,canonical(plan));return OrganizationControls.load(catalogPath,sha256,sources);};
  const controls=await load();return {...f,sources,base,templates,group,catalog,catalogPath,path,load,controls};
}

test('HTTP choices use original coordination revisions and precise serial gates; reads and duplicates dispatch no models',async t=>{
  const f=await setup(t),app=await startWorkbench(f.path);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json',Origin:u.origin};
  const state=async()=>await(await fetch(u.origin+'/api/state',{headers})).json() as any,post=async(body:any,extra:Record<string,string>=headers)=>{const r=await fetch(u.origin+'/api/organization/pair/apply',{method:'POST',headers:extra,body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};
  const before=f.q.status(),initial=await state();assert.deepEqual(f.q.status(),before);assert.equal(initial.mode,'bounded_organization');assert.equal(initial.organization[0].expectedPrevious,null);assert.ok(!JSON.stringify(initial.organization).includes('private-workspace'));
  assert.equal((await post({choice:'parallel',expectedPrevious:null},{...headers,Origin:'https://other.example'})).status,403);assert.equal((await post({choice:'parallel',expectedPrevious:null},{'Content-Type':'application/json',Origin:u.origin})).status,401);assert.equal((await post({choice:'parallel',expectedPrevious:null,workspace:'/arbitrary'})).status,503);
  const first=await post({choice:'parallel',expectedPrevious:null});assert.equal(first.status,200,JSON.stringify(first));const a=first.value.planId;assert.equal(f.q.coordination().status(a).plan.mode,'parallel');assert.equal(f.q.coordination().stage(a,'A','implement').phasePrerequisitesMet,false);assert.equal(f.q.coordination().stage(a,'B','investigate').phasePrerequisitesMet,true);
  const recorded=f.q.status();assert.equal((await post({choice:'parallel',expectedPrevious:null})).value.duplicate,true);assert.deepEqual(f.q.status(),recorded);
  assert.equal((await post({choice:'parallel',expectedPrevious:a})).value.planId,a);assert.deepEqual(f.q.status(),recorded);assert.equal((await state()).organization[0].currentChoice,'parallel');
  const next=await post({choice:'serial',expectedPrevious:a});assert.equal(next.status,200,JSON.stringify(next));const b=next.value.planId;assert.equal(f.q.coordination().status(b).plan.previous,a);assert.ok(f.q.coordination().stage(b,'B','implement').blockers.some((x:string)=>x.includes('capability_missing')));
  assert.equal((await post({choice:'unified',expectedPrevious:a})).status,503);assert.equal(f.q.coordination().current(f.base.name)!.id,b);
  const duplicateOld=await post({choice:'parallel',expectedPrevious:null});assert.equal(duplicateOld.value.duplicate,true);assert.equal(duplicateOld.value.current,false);assert.equal(f.q.coordination().current(f.base.name)!.id,b);
  const competing=await Promise.all([post({choice:'unified',expectedPrevious:b}),post({choice:'parallel',expectedPrevious:b})]);assert.deepEqual(competing.map(x=>x.status).sort(),[200,503]);assert.equal((await f.calls()).length,0);assert.equal(f.q.status().events.filter((e:any)=>e.kind==='coordination_registered').length,3);
});

test('unselected tasks and changed template files cannot be introduced; selected state objects cannot mutate the frozen plan',async t=>{
  const f=await setup(t);await assert.rejects(OrganizationControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),f.sources.slice(0,1)),/source_not_selected/);await assert.rejects(f.controls.apply('unselected',{choice:'parallel',expectedPrevious:null}),/group_not_selected/);
  const shown=await f.controls.state();(shown[0]!.choices[0]!.tasks[0]!.independentPaths as string[]).push('src/forged.ts');await writeFile(f.group.choices[0]!.plan.path,canonical({...f.base,source:'changed caller file'}));await assert.rejects(f.load(),/template_changed/);
  const result=await f.controls.apply('pair',{choice:'parallel',expectedPrevious:null});assert.deepEqual(f.q.coordination().status(result.planId).plan.tasks[0]!.independentPaths,['src/a.ts']);assert.equal((await f.calls()).length,0);
  const workbenchPlan=JSON.parse(await readFile(f.path,'utf8'));
  assert.throws(()=>parseWorkbenchPlan(Buffer.from(canonical({...workbenchPlan,kind:'tongxu-local-workbench'}))),/invalid_workbench_controls/);
});

test('new arrangements preserve an original active claim and do not grant the proposed unified owner writing rights',async t=>{
  const f=await setup(t),original=f.q.begin(f.item,'explicit-held-original-operation');assert.ok(original.operation);const before=f.q.status().claims;
  const result=await f.controls.apply('pair',{choice:'unified',expectedPrevious:null});assert.equal(result.writingPermissionGranted,false);assert.deepEqual(f.q.status().claims,before);const stage=f.q.coordination().stage(result.planId,'B','implement');assert.equal(stage.executionAuthorized,false);assert.equal((await f.calls()).length,0);
});

test('the same arrangement can explicitly bind a newer packet of the same task without discarding its old evidence',async t=>{
  const f=await setup(t),first=await f.controls.apply('pair',{choice:'parallel',expectedPrevious:null}),changed=await f.packet();assert.equal(changed.item,f.item);
  const before=await f.controls.state();assert.equal(before[0]!.available,true);assert.equal('currentChoice' in before[0]!&&before[0]!.currentChoice,null);assert.equal(f.q.coordination().status(first.planId).currentMaterials,false);
  const claims=f.q.status().claims,second=await f.controls.apply('pair',{choice:'parallel',expectedPrevious:first.planId});assert.notEqual(second.planId,first.planId);assert.equal(second.duplicate,false);assert.equal(f.q.coordination().stage(second.planId,'A','investigate').phasePrerequisitesMet,true);assert.equal(f.q.coordination().status(first.planId).current,false);assert.deepEqual(f.q.status().claims,claims);assert.equal((await f.calls()).length,0);
  const repeated=await f.controls.apply('pair',{choice:'parallel',expectedPrevious:second.planId});assert.equal(repeated.planId,second.planId);assert.equal(repeated.duplicate,true);
});

test('existing Owner delegation binds every selected task; revocation prevents a new revision but not an exact original read',async t=>{
  const f=await setup(t),authority=await messageAuthority(f);const target=f.q.status().items.find((i:any)=>i.id===f.item).candidate.targetRef;
  const delegate=await authority.adopt({kind:'delegate',adoption:authority.scope.sha,roles:['coordinator'],targets:[target],actions:['coordinate'],paths:[],resourceRefs:[],expiresAt:new Date(Date.now()+3600000).toISOString()});
  await assert.rejects(f.controls.apply('pair',{choice:'parallel',expectedPrevious:null}),/existing_delegation_required/);
  f.group.delegation={adoption:authority.scope.sha,authorization:delegate.sha};const controls=await f.load(),first=await controls.apply('pair',{choice:'parallel',expectedPrevious:null}),current=f.q.coordination().status(first.planId),intent=f.q.authority().reservedAction(current.plan.authorityIntent!);assert.equal(intent.request.payloadSha256,first.planId);assert.equal(intent.request.item,f.item);
  const orgIntents=f.q.authority().status().intents.filter((i:any)=>i.request.payloadSha256===first.planId);assert.equal(orgIntents.length,2);assert.deepEqual(orgIntents.map((i:any)=>i.request.item).sort(),f.sources.map(s=>s.item).sort());assert.equal((await f.calls()).length,0);
  await authority.adopt({kind:'revoke',decision:delegate.sha});await assert.rejects(controls.apply('pair',{choice:'serial',expectedPrevious:first.planId}),/revoked/);assert.equal(f.q.coordination().current(f.base.name)!.id,first.planId);assert.equal((await controls.apply('pair',{choice:'parallel',expectedPrevious:null})).duplicate,true);
});
