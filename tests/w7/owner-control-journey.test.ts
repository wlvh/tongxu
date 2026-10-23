import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {deliveryControlsFixture} from './delivery-controls-fixture.js';
import {startWorkbench} from '../../src/workbench.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {SecretaryWorkbench} from '../../src/secretary-workbench.js';
import {SecretaryTools} from '../../src/secretary-tools.js';

test('a stopped outcome can be resumed through the same workbench Owner source; independent stops and revocations survive',async t=>{
  const f=await deliveryControlsFixture(t),item=f.q.status().items.find((x:any)=>x.id===f.item),catalog={schemaVersion:2,kind:'tongxu-task-controls',contacts:[],scopeControls:['investment','implementation','merge'].map(control=>({id:control,title:control,source:'fixture',scopeSha256:hash(canonical(item.context.scope)),control}))},catalogPath=join(f.root,'journey-controls.json');
  await writeFile(catalogPath,canonical(catalog));await writeFile(f.workbenchPath,canonical({...f.workbenchPlan,ownerControls:['fixture'],controls:{path:catalogPath,sha256:hash(canonical(catalog))}}));
  const app=await startWorkbench(f.workbenchPath);t.after(()=>app.close());const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json',Origin:url.origin};
  const state=async()=>await (await fetch(url.origin+'/api/state',{headers})).json() as any;
  const post=async(path:string,body:unknown)=>{const r=await fetch(url.origin+'/api/'+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};
  const owner=(action:string,body:unknown)=>post('owner-control/fixture/'+action,body);
  const apply=async(sha:string)=>owner('apply',{proposalSha256:sha,sourceUrl:'https://github.com/fixture/reception/issues/8#issuecomment-'+await f.originalDecision(sha)});
  const prepare=async(control:string,value:string)=>{const s=(await state()).ownerControls[0],c=s.controls.find((x:any)=>x.control===control);return owner('prepare',{kind:'control',adoption:s.currentAdoption,control,state:value,expectedRevision:c.revision});};
  const initial=await state(),batch=initial.deliveries[0].batch,stopped=await post('delivery/x1/prepare',{outcome:'stopped',rationale:'明确隔离场景：先停止本范围投入，然后通过同一页面核对原来源恢复。',evidenceSha256:batch.evidenceSha256,previousOutcome:null});
  assert.equal(stopped.status,200,JSON.stringify(stopped));
  assert.equal((await post('delivery/x1/apply',{proposalSha256:stopped.value.proposalSha256,commentId:await f.originalDecision(stopped.value.proposalSha256)})).status,200);
  const stoppedState=await state();assert.equal(stoppedState.deliveries[0].batch.outcomes.at(-1).proposal.outcome,'stopped');assert.equal(stoppedState.scopeControls.find((c:any)=>c.control==='investment').verifiedOwnerStop,true);
  const revision=stoppedState.scopeControls.find((c:any)=>c.control==='investment').revision;
  assert.equal((await post('scope-control/investment/open',{revision})).value.error,'verified_owner_stop_requires_verified_resume');
  for(const c of ['implementation','merge']){const p=await prepare(c,'stopped');assert.equal(p.status,200);assert.equal((await apply(p.value.proposalSha256)).status,200);}
  const revoke=await owner('prepare',{kind:'revoke',decision:f.a.confirmed.sha});assert.equal(revoke.status,200);assert.equal((await apply(revoke.value.proposalSha256)).status,200);
  const opened=await prepare('investment','open');assert.equal(opened.status,200,JSON.stringify(opened));assert.equal((await prepare('investment','open')).value.duplicate,true);
  assert.equal((await state()).scopeControls.find((c:any)=>c.control==='investment').state,'stopped');
  const original=f.q.status(),wrong=await owner('apply',{proposalSha256:opened.value.proposalSha256,sourceUrl:'https://github.com/fixture/reception/issues/9#issuecomment-7400000001'});assert.equal(wrong.status,503);assert.deepEqual(f.q.status(),original);
  const applied=await apply(opened.value.proposalSha256);assert.equal(applied.status,200,JSON.stringify(applied));
  const final=await state();assert.equal(final.ownerControls[0].controls.find((c:any)=>c.control==='investment').state,'open');assert.equal(final.scopeControls.find((c:any)=>c.control==='investment').state,'open');
  const selected=await SecretaryWorkbench.load({path:f.workbenchPath,sha256:hash(await readFile(f.workbenchPath)),source:'fixture'},f.store,f.item),c=item.candidate,tools=new SecretaryTools(f.store,f.item,{repository:c.repository,pr:c.pr,H:c.H,B:c.B,target:c.targetRef},join(f.root,'secretary-read'),undefined,false,false,selected);
  const read=await tools.call({tool:'tongxu_owner_controls',arguments:{},callId:'after-direct-resume'});assert.deepEqual(JSON.parse(read.contentItems[0].text).data.owner,final.ownerControls[0]);
  for(const c of ['implementation','merge'])assert.equal(final.scopeControls.find((x:any)=>x.control===c).state,'stopped');
  assert.equal(final.ownerControls[0].requests.find((r:any)=>r.proposalSha256===f.a.confirmed.sha).revoked,true);assert.equal(final.deliveries[0].batch.outcomes.at(-1).proposal.outcome,'stopped');assert.equal(final.deliveries[0].batch.userOutcomeAccepted,false);
  // A second stop/reopen is a new decision, not the already-applied first open.
  const stop2=await prepare('investment','stopped');assert.equal((await apply(stop2.value.proposalSha256)).status,200);
  const open2=await prepare('investment','open');assert.notEqual(open2.value.proposalSha256,opened.value.proposalSha256);assert.equal((await apply(open2.value.proposalSha256)).status,200);
  const oldRequest=final.ownerControls[0].requests.find((r:any)=>r.proposalSha256===opened.value.proposalSha256),beforeReplay=f.q.status();assert.equal((await owner('apply',{proposalSha256:oldRequest.proposalSha256,sourceUrl:oldRequest.sourceUrl})).value.duplicate,true);assert.deepEqual(f.q.status(),beforeReplay);
  // A concurrent local control update cannot be erased by a previously prepared request.
  const stale=await prepare('implementation','open');f.q.control(f.batch.scope.id,'implementation','stopped','second explicit local stop');assert.equal((await apply(stale.value.proposalSha256)).value.error,'owner_control_revision_changed');assert.equal((await state()).scopeControls.find((c:any)=>c.control==='implementation').state,'stopped');
  assert.equal((await owner('prepare',{kind:'control',adoption:f.a.scope.sha,control:'investment',state:'stopped',expectedRevision:revision})).value.error,'owner_control_revision_changed');
  assert.equal((await owner('prepare',{kind:'control',adoption:'f'.repeat(64),control:'investment',state:'open',expectedRevision:0})).value.error,'current_adopted_scope_required');
  assert.equal((await owner('prepare',{kind:'control',adoption:f.a.scope.sha,control:'investment',state:'open',expectedRevision:0,permissionsGranted:true})).value.error,'owner_control_form_invalid');
  assert.equal((await f.calls()).length,0);assert.equal(f.q.status().operations.length,0);
});
