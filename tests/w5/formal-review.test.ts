import test from 'node:test';
import assert from 'node:assert/strict';
import {formalBatch,formalReviewNext,formalSynthesisNext,formalDisagreements,sameFormalCandidate,validateFormalReview,validateFormalVerification,type FormalReview} from '../../src/formal-review-contract.js';
const candidate={repository:'fixture/review',pr:7,H:'a'.repeat(40),B:'b'.repeat(40),target:'main',requirementsSha256:'c'.repeat(64)},input='d'.repeat(64);
const report=(extra:Partial<FormalReview>={}):FormalReview=>({candidateH:candidate.H,reviewedInputSha256:input,verdict:'PASS',report:'Explicit protocol fixture, no real review.',findings:[],coverageGaps:[],ownerQuestions:[],...extra});
for(const findings of [[],[{id:'P2',priority:2 as const,description:'Recorded optional concern',evidence:['fixture:caller']}]] )test('complete direct formal PASS ends without verification or repair: '+findings.length,()=>{
 const r=validateFormalReview(report({findings}),candidate.H,input);assert.equal(formalReviewNext(r).stage,'pass');assert.equal(formalReviewNext(r).newVerificationRequired,false);assert.throws(()=>formalBatch(candidate,r),/empty_batch/);
});
test('empty findings with missing coverage or Owner work cannot manufacture PASS or an empty verification batch',()=>{
 for(const extra of [{coverageGaps:['Need the actual upstream caller']},{ownerQuestions:['Choose the actual business requirement']}])assert.throws(()=>validateFormalReview(report(extra),candidate.H,input),/unresolved_work/);
 const pending=validateFormalReview(report({verdict:'REWORK_REQUIRED',coverageGaps:['Need source']}),candidate.H,input);assert.equal(formalReviewNext(pending).stage,'needs_evidence');assert.throws(()=>formalBatch(candidate,pending),/empty_batch/);
});
test('all P0/P1 enter one immutable batch and each independent verification must cover the exact whole batch',()=>{
 const r=report({verdict:'REWORK_REQUIRED',findings:[{id:'F1',priority:0,description:'First',evidence:['fixture:one']},{id:'F2',priority:1,description:'Second',evidence:['fixture:two']},{id:'P2',priority:2,description:'Optional',evidence:['fixture:three']}]});
 const batch=formalBatch(candidate,validateFormalReview(r,candidate.H,input));assert.deepEqual(batch.findings.map(f=>f.id),['F1','F2']);assert.equal(r.findings.length,3);
 const fact={candidateH:candidate.H,batchSha256:batch.sha256,report:'Fact counterevidence is not permission to skip impact.',assessments:batch.findings.map(f=>({id:f.id,decision:'refuted' as const,report:'Actual controlled fixture evidence',evidence:['fixture:probe']}))};
 assert.equal(validateFormalVerification(fact,batch).assessments.length,2);assert.throws(()=>validateFormalVerification({...fact,assessments:fact.assessments.slice(0,1)},batch),/complete_batch/);assert.throws(()=>validateFormalVerification({...fact,assessments:[fact.assessments[0],fact.assessments[0]]},batch),/complete_batch/);
 const impact={...fact,assessments:fact.assessments.map(a=>({...a,decision:'confirmed' as const}))};assert.deepEqual(formalDisagreements(fact,impact),['F1','F2']);assert.equal(formalSynthesisNext(fact,['F1','F2'],2),'exchange_evidence');assert.equal(formalSynthesisNext(fact,['F1','F2'],3),'needs_evidence');assert.equal(formalSynthesisNext(fact,[],0),'reviewer_refutation_conclusion');assert.equal(formalSynthesisNext(impact,[],0),'authorized_fix');assert.throws(()=>formalSynthesisNext(fact,[],4),/exchange_bound/);
});
test('H, B, target and adopted requirements changes each invalidate the previous formal candidate',()=>{
 for(const change of [{H:'e'.repeat(40)},{B:'e'.repeat(40)},{target:'release'},{requirementsSha256:'f'.repeat(64)}])assert.equal(sameFormalCandidate(candidate,{...candidate,...change}),false);
 assert.equal(sameFormalCandidate(candidate,{...candidate}),true);
});
