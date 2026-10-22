import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {deliveryControlsFixture} from './delivery-controls-fixture.js';
import {scopeFollowupFixture} from './scope-followup-fixture.js';
import {DeliveryWorkspaceControls} from '../../src/delivery-workspace-controls.js';
import {prepareScopeFollowup} from '../../src/task-scope-followup.js';
import {startWorkbench} from '../../src/workbench.js';
import {canonical} from '../../src/comparison.js';
const raw=(v:unknown)=>Buffer.from(canonical(v));
function request(m:any,id='normal-batch'){return {requestId:id,title:'从所选任务准备成果，不伪造验收',issue:9,adoption:m.currentAdoption,previous:null,members:[{source:m.source,packet:m.packet,fingerprint:m.fingerprint}],scenarios:[{id:'fixed-contract',title:'固定契约场景',expected:'准确原候选与实际结果分别核对；无结果保持待验证。',sources:[m.source]}]};}

test('normal selected sources prepare and discover a fixed batch, keep history, and reuse original outcome controls without dispatch',async t=>{
 const f=await deliveryControlsFixture(t),c=new DeliveryWorkspaceControls([],['fixture'],f.workbenchPlan.sources,true),m=(await c.preparation())[0] as any,body=request(m.members[0]),trace=await f.calls();
 const first=await c.register('fixture',body);assert.equal(first.newModelRequests,0);assert.equal(first.newVerificationRuns,0);assert.equal(first.userOutcomeAccepted,false);assert.equal(first.scenarioExecutionVerified,false);assert.deepEqual(first.goals,f.batch.goals);assert.deepEqual(first.nonGoals,f.batch.nonGoals);
 const saved=f.q.status(),again=await c.register('fixture',body);assert.equal(again.duplicate,true);assert.deepEqual(f.q.status(),saved);assert.deepEqual(await f.calls(),trace);
 let entries=await c.state();const selected=entries.find((x:any)=>x.batch?.batchSha256===first.batchSha256) as any;assert.ok(selected?.canPrepare);const outcome=await c.prepare(selected.id,{outcome:'needs_evidence',rationale:'尚需实际验证，不代签本人。',evidenceSha256:first.evidenceSha256,previousOutcome:null});assert.ok(outcome.proposalSha256);
 const second=await c.register('fixture',{...body,previous:first.batchSha256,title:'明确下一版'});assert.equal(second.id,first.id);assert.equal(second.revision,2);entries=await c.state();assert.equal((entries.find((x:any)=>x.batch?.batchSha256===first.batchSha256) as any).batch.currentVersion,false);assert.ok(entries.some((x:any)=>x.batch?.batchSha256===second.batchSha256));
 await assert.rejects(c.register('fixture',{...body,previous:first.batchSha256,title:'竞争旧前版'}),/previous_version_changed/);assert.deepEqual(await f.calls(),trace);
});
test('new adopted scope selects only its recorded subsequent task and preserves the older task and batch',async t=>{
 const f=await scopeFollowupFixture(t,true),c=new DeliveryWorkspaceControls([],['task'],f.plan.sources,true),root=(await c.preparation())[0] as any,old=request(root.members[0]);await assert.rejects(c.register('task',old),/current_adoption_required/);
 const prepared=await prepareScopeFollowup(f.store,raw(f.request)),values=(await c.preparation())[0] as any,child=values.members.find((v:any)=>v.item===prepared.task);assert.ok(child);assert.notEqual(child.source,'task');const trace=await f.calls();const batch=await c.register(child.source,request(child,'new-goal-batch'));assert.equal(batch.scope.version,'S2');assert.equal(batch.members[0].item,prepared.task);assert.ok((await c.state()).some((v:any)=>v.batch?.batchSha256===batch.batchSha256));assert.equal(f.q.tasks().current(f.task).context.scope.version,'S1');assert.deepEqual(await f.calls(),trace);
});
test('HTTP preparation rejects unselected source, permission fields, stale members, and cross-origin requests; reopens original batches',async t=>{
 const f=await deliveryControlsFixture(t),{deliveries,...base}=f.workbenchPlan;await writeFile(f.workbenchPath,raw({...base,ownerControls:['fixture']}));const app=await startWorkbench(f.workbenchPath);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),Origin:u.origin,'Content-Type':'application/json'},state=async()=>await (await fetch(u.origin+'/api/state',{headers})).json() as any,post=async(source:string,body:any,h=headers)=>{const r=await fetch(u.origin+'/api/delivery-preparation/'+source+'/register',{method:'POST',headers:h,body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};
 const current=await state(),m=current.deliveryPreparation[0].members[0],body=request(m),before=f.q.status();assert.equal((await post('fixture',body,{...headers,Origin:'https://elsewhere.invalid'})).status,403);assert.equal((await post('outside',body)).status,503);assert.equal((await post('fixture',{...body,executable:'/bin/sh'})).status,503);assert.equal((await post('fixture',{...body,members:[{...body.members[0],fingerprint:'f'.repeat(64)}]})).status,503);assert.deepEqual(f.q.status(),before);
 const created=await post('fixture',body);assert.equal(created.status,200,JSON.stringify(created));const reopened=await startWorkbench(f.workbenchPath);t.after(()=>reopened.close());const r=new URL(reopened.url),read=await (await fetch(r.origin+'/api/state',{headers:{Authorization:'Bearer '+r.hash.slice(1)}})).json() as any;assert.ok(read.deliveries.some((x:any)=>x.batch?.batchSha256===created.value.batchSha256));assert.equal((await f.calls()).length,0);
});
