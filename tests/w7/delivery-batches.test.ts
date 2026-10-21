import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {controlFixture} from './task-controls-fixture.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {QueueStore} from '../../src/queue-store.js';
import {canonical} from '../../src/comparison.js';
import {parseDeliveryBatch,type DeliveryBatch} from '../../src/delivery-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {deliveryMain} from '../../src/delivery-cli.js';
import {parseMessagePlan} from '../../src/message-contract.js';
import type {OwnerObservation} from '../../src/authority-source.js';

const raw=(x:unknown)=>Buffer.from(canonical(x));
const exec=promisify(execFile);
async function fixture(t:test.TestContext){const f=await controlFixture(t),current=f.q.tasks().current(f.task),p:DeliveryBatch={schemaVersion:1,kind:'tongxu-delivery-batch',id:'X1',revision:1,previous:null,repository:'fixture/reception',issue:9,title:'固定本批用户成果',source:'explicit isolated delivery fixture',target:'fixture',scope:{id:f.definition.context.scope.id,version:f.definition.context.scope.version,adoption:null},goals:['固定示例能力'],nonGoals:['不执行真实模型或发布'],members:[{item:f.task,packet:current.packet,fingerprint:current.fingerprint}],scenarios:[{id:'scenario-one',title:'保留实际请求和完整回复',expected:'用户不搬报告，程序完成转交并保留完整原文',members:[f.task]}],related:[]};return {...f,p};}

test('X2 remains a separate batch and repeated X1 registration preserves original material and false acceptance',async t=>{
  const f=await fixture(t),x1=f.q.deliveries().register(raw(f.p)),before=f.q.status();assert.equal(x1.currentMaterials,true);assert.equal(x1.scope.adoptionRecorded,false);assert.equal(x1.scenarioExecutionVerified,false);assert.equal(x1.userOutcomeAccepted,false);
  const repeated=f.q.deliveries().register(Buffer.from(JSON.stringify(f.p,null,2)));assert.equal(repeated.duplicate,true);assert.deepEqual(f.q.status(),before);
  const x2=f.q.deliveries().register(raw({...f.p,id:'X2',title:'后续另一批',goals:['明确下一批的新能力'],related:[{batch:x1.batchSha256,relation:'related'}]}));assert.notEqual(x1.batchSha256,x2.batchSha256);assert.deepEqual(f.q.deliveries().state(x1.batchSha256),(({duplicate,...rest})=>rest)(x1));
  const unchanged=f.q.status();assert.throws(()=>f.q.deliveries().register(raw({...f.p,revision:2,previous:x1.batchSha256,goals:['把新目标偷放X1']})),/scope_change_requires_adoption/);assert.deepEqual(f.q.status(),unchanged);assert.equal((await f.calls()).length,0);
});
test('changed exact member material requires a new batch revision; old receipts stay historical',async t=>{
  const f=await fixture(t),x1=f.q.deliveries().register(raw(f.p)),original=f.q.deliveries().manifest(x1.batchSha256);await writeFile(join(f.definition.workspace,'sample.js'),'export const changedForDelivery=122;\n');f.q.tasks().observe(f.definition,await observeTaskWorkspace(f.definition));const current=f.q.tasks().current(f.task),historical=f.q.deliveries().state(x1.batchSha256);assert.equal(historical.currentMaterials,false);assert.deepEqual(f.q.deliveries().manifest(x1.batchSha256),original);
  assert.throws(()=>f.q.deliveries().register(raw({...f.p,revision:2,previous:x1.batchSha256})),/current_material_mismatch/);const next=f.q.deliveries().register(raw({...f.p,revision:2,previous:x1.batchSha256,members:[{item:f.task,packet:current.packet,fingerprint:current.fingerprint}]}));assert.equal(next.currentMaterials,true);assert.equal(next.revision,2);const before=f.q.status(),old=f.q.deliveries().register(raw(f.p));assert.equal(old.duplicate,true);assert.equal(old.currentVersion,false);assert.equal(old.currentMaterials,false);assert.deepEqual(f.q.status(),before);assert.equal((await f.calls()).length,0);
});
test('two actual CLI writers cannot both replace the same batch revision',async t=>{
  const f=await fixture(t),x1=f.q.deliveries().register(raw(f.p)),paths=[join(f.root,'version-a.json'),join(f.root,'version-b.json')];await Promise.all(paths.map((p,i)=>writeFile(p,raw({...f.p,title:'并发候选 '+i,revision:2,previous:x1.batchSha256}))));
  const outcomes=await Promise.allSettled(paths.map(p=>exec(process.execPath,[fileURLToPath(new URL('../../src/delivery-cli.js',import.meta.url)),'register','--store',f.store,'--batch',p])));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);const failed=outcomes.find(x=>x.status==='rejected') as PromiseRejectedResult;assert.match(failed.reason.stderr,/delivery_previous_version_changed/);assert.equal(f.q.status().events.filter((e:any)=>e.kind==='delivery_batch_registered').length,2);assert.equal((await f.calls()).length,0);
});
test('recorded adopted goals remain exact and a later scope adoption preserves the historical batch',async t=>{
  const f=await fixture(t),plan=parseMessagePlan(await readFile(f.path)),a=await messageAuthority({...f,plan,write:async()=>writeFile(f.path,raw(plan))}),scope=a.a.proposal(a.scope.sha).proposal as any;{const p={...f.p,scope:{...f.p.scope,adoption:a.scope.sha},goals:scope.body.goals,nonGoals:scope.body.nonGoals};const x=f.q.deliveries().register(raw(p));assert.equal(x.scope.adoptionRecorded,true);assert.equal(x.scope.currentAdoption,true);assert.equal(x.userOutcomeAccepted,false);assert.throws(()=>f.q.deliveries().register(raw({...p,id:'unadopted-extra',goals:[...p.goals,'unadopted goal']})),/adopted_goals_mismatch/);
    assert.equal(x.scope.executionKind,'fixture');assert.ok(x.scope.decisionSource?.includes('issuecomment-'));await a.adopt({...scope,scopeVersion:'S2',previousAdoption:a.scope.sha});const old=f.q.deliveries().state(x.batchSha256);assert.equal(old.scope.adoptionRecorded,true);assert.equal(old.scope.currentAdoption,false);assert.equal(old.scope.executionKind,'fixture');assert.equal(old.scope.reason,'delivery_current_scope_adoption_required');assert.equal(old.userOutcomeAccepted,false);assert.equal(old.scope.adoption,a.scope.sha);}
});
test('an explicitly adopted new scope and current member allow the same batch to advance',async t=>{
  const f=await fixture(t),plan=parseMessagePlan(await readFile(f.path)),a=await messageAuthority({...f,plan,write:async()=>writeFile(f.path,raw(plan))}),s1=a.a.proposal(a.scope.sha).proposal as any,p={...f.p,scope:{...f.p.scope,adoption:a.scope.sha},goals:s1.body.goals,nonGoals:s1.body.nonGoals},x1=f.q.deliveries().register(raw(p));
  const body={...s1.body,goals:['Explicitly adopted next scope capability']},s2=await a.adopt({...s1,scopeVersion:'S2',body,previousAdoption:a.scope.sha}),member=await f.packet({scopeVersion:'S2'}),event=f.q.status().events.filter((e:any)=>e.object===member.item&&e.kind==='material_changed').at(-1),fingerprint=JSON.parse(event.data).fingerprint;
  const next=f.q.deliveries().register(raw({...p,revision:2,previous:x1.batchSha256,scope:{...p.scope,version:'S2',adoption:s2.sha},goals:body.goals,members:[{item:member.item,packet:member.packet,fingerprint}],scenarios:p.scenarios.map(s=>({...s,members:[member.item]}))}));
  assert.equal(next.currentMaterials,true);assert.equal(next.scope.currentAdoption,true);assert.equal(next.scope.adoption,s2.sha);assert.equal(next.userOutcomeAccepted,false);const old=f.q.deliveries().state(x1.batchSha256);assert.equal(old.currentVersion,false);assert.equal(old.scope.currentAdoption,false);assert.equal(old.scope.adoption,a.scope.sha);assert.equal((await f.calls()).length,0);
});
test('readonly exact selection changes no queue values and corrupt source cannot become a cached success',async t=>{
  const f=await fixture(t),path=join(f.root,'batch.json');await writeFile(path,raw(f.p));const x=await deliveryMain(['register','--store',f.store,'--batch',path]),before=f.q.status();assert.equal((await deliveryMain(['state','--store',f.store,'--batch-sha',x.batchSha256])).currentVersion,true);assert.deepEqual(f.q.status(),before);await assert.rejects(QueueStore.observeDeliveries(f.store,[x.batchSha256,x.batchSha256]),/selection_invalid/);await assert.rejects(QueueStore.observeDeliveries(f.store,['f'.repeat(64)]),/original_missing/);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());const e=before.events.find((e:any)=>e.kind==='delivery_batch_registered'),sha=JSON.parse(e.data).snapshotSha256;db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('explicit corrupted snapshot'),sha);assert.throws(()=>f.q.deliveries().state(x.batchSha256),/original_changed/);assert.equal((await f.calls()).length,0);
});
test('batch contract cannot add authority, select unlisted scenario members or omit version ancestry',async t=>{
  const f=await fixture(t);assert.throws(()=>parseDeliveryBatch(raw({...f.p,accepted:true})),/batch_invalid/);assert.throws(()=>parseDeliveryBatch(raw({...f.p,revision:2})),/batch_invalid/);assert.throws(()=>parseDeliveryBatch(raw({...f.p,scenarios:[{...f.p.scenarios[0],members:['f'.repeat(64)]}]})),/scenarios_invalid/);const before=f.q.status();assert.throws(()=>f.q.deliveries().register(raw({...f.p,members:[{...f.p.members[0],fingerprint:'0'.repeat(64)}]})),/current_material_mismatch/);assert.deepEqual(f.q.status(),before);
});
test('missing stored Owner originals invalidate current adoption while preserving historical registration',async t=>{
  for(const variant of ['comment','editor','profile'] as const){const f=await fixture(t),plan=parseMessagePlan(await readFile(f.path)),a=await messageAuthority({...f,plan,write:async()=>writeFile(f.path,raw(plan))}),adopted=a.a.proposal(a.scope.sha),scope=adopted.proposal as any,p={...f.p,scope:{...f.p.scope,adoption:a.scope.sha},goals:scope.body.goals,nonGoals:scope.body.nonGoals},x=f.q.deliveries().register(raw(p));
    const entry=f.q.status().events.find((e:any)=>e.kind==='authority_decision_applied'&&e.object==='authority-decision:'+a.scope.sha),source=JSON.parse(entry.data).source,sha=variant==='profile'?adopted.profileSha256:variant==='comment'?source.originalCommentSha256:source.originalEditorSha256,db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());const original=(db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as any).bytes;if(variant==='editor')db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('explicit damaged editor fixture'),sha);else db.prepare('DELETE FROM blobs WHERE hash=?').run(sha);
    const state=await deliveryMain(['state','--store',f.store,'--batch-sha',x.batchSha256]);assert.equal(state.scope.adoptionRecorded,true);assert.equal(state.scope.currentAdoption,false);assert.equal(state.scope.sourceOriginalsVerified,false);assert.equal(state.scope.reason,'authority_original_changed');const before=f.q.status();assert.throws(()=>f.q.deliveries().register(raw({...p,id:'X2'})),/authority_original_changed/);assert.deepEqual(f.q.status(),before);
    db.prepare('INSERT OR REPLACE INTO blobs VALUES(?,?)').run(sha,original);assert.equal(f.q.deliveries().state(x.batchSha256).scope.currentAdoption,true);assert.equal((await f.calls()).length,0);
  }
});
test('a locally inspected historical source cannot act as a fresh provider observation',async t=>{
  const f=await fixture(t),plan=parseMessagePlan(await readFile(f.path)),a=await messageAuthority({...f,plan,write:async()=>writeFile(f.path,raw(plan))}),before=f.q.status(),inspected=a.a.inspectRecordedDecision(a.scope.sha);assert.equal(inspected.originalBytesVerified,true);assert.equal(inspected.freshForAction,false);assert.deepEqual(f.q.status(),before);assert.throws(()=>a.a.adoptionBaseline(a.scope.sha,[inspected.source as unknown as OwnerObservation]),/fresh_provider_owner_observation_required/);
});
