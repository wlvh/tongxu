import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMergeBinding,mergePayload,inspectMergeCurrent,inspectMergeResponse,inspectMergedResult,type ManagedMergeBinding,type MergeWire } from '../../src/merge-contract.js';

const H='a'.repeat(40),B='b'.repeat(40),T='c'.repeat(40),M='d'.repeat(40),later='e'.repeat(40);
const binding:ManagedMergeBinding={schemaVersion:1,operation:'00000000-0000-4000-8000-000000000001',item:'a'.repeat(64),packet:1,repository:'fixture/merge',repositoryId:10,pr:4,H,B,targetRef:'main',T,receptionOperation:'00000000-0000-4000-8000-000000000002',judgmentId:'explicit-fixture-judgment',receptionBindingHash:'b'.repeat(64),authorityIntent:'explicit-fixture-permission',resourceRequests:['c'.repeat(64)],scope:{id:'scope',version:'S1',bodySha256:'d'.repeat(64)},arrangement:{id:'team',version:'r1'},subjectSha256:null,integrationReference:null,method:'merge'};
const wire=(x:unknown,status=200):MergeWire=>({status,body:Buffer.from(JSON.stringify(x))});
const ref=(sha:string)=>wire({ref:'refs/heads/main',object:{type:'commit',sha}});
const pr=(merged=false)=>({number:4,state:merged?'closed':'open',draft:false,merged,mergeable:true,merge_commit_sha:merged?M:null,merged_by:merged?{id:12}:null,head:{sha:H,repo:{id:10}},base:{ref:'main',sha:'0'.repeat(40),repo:{id:10,full_name:'fixture/merge'}}});
const commit=()=>({sha:M,tree:{sha:T},parents:[{sha:B},{sha:H}],message:'tongxu: receive PR #4\n\n'+mergePayload(binding).commit_message});
const result=()=>({pr:wire(pr(true)),commit:wire(commit()),targetBefore:ref(M),targetAfter:ref(M),expectedActorId:12});
test('current direct target ref binds B while historical PR base remains separately reported',()=>{
  const checked=inspectMergeCurrent(binding,wire(pr()),ref(B),ref(B));assert.equal(checked.candidateMatches,true);assert.equal(checked.prReportedBase,'0'.repeat(40));assert.equal(checked.permissionGranted,false);
  assert.ok(inspectMergeCurrent(binding,wire(pr()),ref(B),ref(later)).gaps.includes('target_moved_during_preflight'));
  for(const changed of [{...pr(),draft:true},{...pr(),head:{sha:later,repo:{id:10}}},{...pr(),mergeable:null},{...pr(),base:{...pr().base,ref:'other'}}])assert.equal(inspectMergeCurrent(binding,wire(changed),ref(B),ref(B)).candidateMatches,false);
  assert.equal(inspectMergeCurrent(binding,wire(pr()),ref(B),wire({message:'unavailable'},403)).candidateMatches,false);
});
test('only fixed head merge payload is emitted and composition anchor alone is not an integration target',()=>{
  const payload=mergePayload(binding);assert.equal(payload.sha,H);assert.equal(payload.merge_method,'merge');assert.deepEqual(Object.keys(payload).sort(),['commit_message','commit_title','merge_method','sha']);
  assert.throws(()=>parseMergeBinding({...binding,method:'squash'}),/binding_invalid/);assert.throws(()=>parseMergeBinding({...binding,bypass:true}),/binding_invalid/);
  assert.ok(inspectMergeCurrent({...binding,subjectSha256:'e'.repeat(64)},wire(pr()),ref(B),ref(B)).gaps.includes('composition_requires_exact_integration_candidate'));
});
test('200/exit-like success is insufficient, contradictions and incomplete error replies stay unknown',()=>{
  assert.equal(inspectMergeResponse(wire({merged:true,sha:M})).state,'merged_response_pending_readback');
  assert.equal(inspectMergeResponse(wire({message:'head changed'},409)).state,'refused');
  for(const w of [wire({merged:false,message:'unclear'}),wire({merged:true,sha:M,message:'conflicting'},409),wire({message:'gateway timeout'},504),{status:200,body:Buffer.from('{"merged":')}])assert.equal(inspectMergeResponse(w).state,'sent_unknown');
});
test('exact actual merge must correlate original actor, request, commit, head, base, tree and target',()=>{
  const good=inspectMergedResult(binding,result());assert.equal(good.state,'exact_merge_result_observed');assert.equal((good as any).providerProvenanceVerified,false);assert.equal(good.productionActionAllowed,false);
  assert.equal(inspectMergedResult(binding,{...result(),expectedActorId:99}).state,'merged_pending_verification');
  assert.equal(inspectMergedResult(binding,{...result(),commit:wire({...commit(),message:'an unrelated merge'})}).state,'merged_pending_verification');
  assert.equal(inspectMergedResult(binding,{...result(),response:wire({merged:true,sha:later})}).state,'merged_pending_verification');
  assert.equal(inspectMergedResult(binding,{...result(),commit:wire({...commit(),parents:[{sha:B},{sha:later}]})}).state,'merged_pending_verification');
});
test('a changed actual base or tree requires actual-version validation, while wrong target cannot be legalized by a new test',()=>{
  for(const c of [{...commit(),parents:[{sha:later},{sha:H}]},{...commit(),tree:{sha:later}}])assert.equal(inspectMergedResult(binding,{...result(),commit:wire(c)}).reason,'actual_version_requires_own_validation');
  const other={...pr(true),base:{...pr(true).base,ref:'wrong-target'}};assert.equal(inspectMergedResult(binding,{...result(),pr:wire(other)}).state,'merged_wrong_target');
  assert.equal(inspectMergedResult(binding,{...result(),pr:wire(pr())}).state,'sent_unknown');
});
test('later target tip needs a complete ancestry observation; later source head is not adopted as the merged candidate',()=>{
  const r={...result(),targetBefore:ref(later),targetAfter:ref(later)};assert.equal(inspectMergedResult(binding,r).reason,'actual_merge_not_proven_in_target');
  const comparison={status:'ahead',ahead_by:1,behind_by:0,base_commit:{sha:M},merge_base_commit:{sha:M}};
  assert.equal(inspectMergedResult(binding,{...r,comparison:wire(comparison)}).state,'exact_merge_result_observed');
  assert.equal(inspectMergedResult(binding,{...r,comparison:wire({...comparison,ahead_by:undefined})}).state,'merged_pending_verification');
  const laterSource={...pr(true),head:{sha:later,repo:{id:10}}};const observed=inspectMergedResult(binding,{...result(),pr:wire(laterSource)});assert.equal(observed.state,'exact_merge_result_observed');assert.equal((observed as any).sourceCurrent,false);assert.equal((observed as any).actualHead,H);
});
