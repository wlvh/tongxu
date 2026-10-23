import { QueueStore } from './queue-store.js';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { reconcileReception } from './receiver.js';

export type ActualMergeValidation={referenceSha256:string;executionKind:'fixture'|'external';proof:Buffer;observedAt:string;proofSha256:string};
const validations=new WeakSet<object>();
/** Consume an independently completed receiver operation and its validated W2
 * originals. No CLI boolean, detached report or old PASS is accepted here. */
export async function inspectActualMergeValidation(store:string,operation:string,reference:Buffer,kind:'fixture'|'external'):Promise<ActualMergeValidation>{
  const expected=JSON.parse(reference.toString()),b=expected.binding,actual=expected.actual;
  if(expected.kind!=='tongxu-actual-merge-validation'||operation===expected.operation||actual.reason!=='actual_version_requires_own_validation'||actual.target!==b.targetRef)throw new Error('separate_actual_version_validation_required');
  await reconcileReception(store,operation);
  const q=await QueueStore.open(store);
  try{
    const state=q.receiverState(operation),e=q.receiverEvidence(operation),r=state.receiver,j=r?.judgment,c=e.manifest.candidate;
    if(state.status!=='complete'||r?.phase!=='returned'||j?.verdict!=='ACCEPT_WITHIN_SCOPE'||j.findings.some((x:any)=>x.priority<2)||!state.result.evidenceComplete||r.bindingHash!==j.bindingHash||(kind==='fixture')!==(r.executionKind==='fixture'))throw new Error('actual_version_accepted_independent_result_required');
    if(c.repository!==b.repository||c.pr!==b.pr||c.H!==actual.actualHead||c.B!==actual.actualBase||c.targetRef!==actual.target||e.report.stages.at(-1)?.tree!==actual.actualTree||e.report.status!=='complete'||e.report.executionComplete!==true||e.report.observedSampleFailures!==0)throw new Error('actual_version_test_binding_mismatch');
    if(e.context.scope.id!==b.scope.id||e.context.scope.version!==b.scope.version||e.context.arrangement.id!==b.arrangement.id||e.context.arrangement.version!==b.arrangement.version)throw new Error('actual_version_scope_mismatch');
    const input=JSON.parse(state.input.toString());
    if(!input.data.material.some((m:any)=>m.sha256===hash(reference)&&m.text===reference.toString())||Date.parse(r.registeredAt)<Date.parse(expected.readback.checkedAt)||Date.parse(e.report.startedAt)<Date.parse(expected.readback.checkedAt))throw new Error('actual_version_original_readback_not_consumed');
    const proof=Buffer.from(canonical({kind:'independent_actual_merge_validation',store,operation,referenceSha256:hash(reference),executionKind:kind,candidate:c,actualTree:actual.actualTree,judgment:j,receiverBindingHash:r.bindingHash,input:input,receiverBlobs:r.blobs,verification:e.report}));
    const value=Object.freeze({referenceSha256:hash(reference),executionKind:kind,proof,proofSha256:hash(proof),observedAt:new Date().toISOString()});validations.add(value);return value;
  }finally{q.close();}
}
export function requireActualMergeValidation(v:ActualMergeValidation,reference:Buffer,kind:'fixture'|'external'){
  if(!validations.has(v)||v.referenceSha256!==hash(reference)||v.executionKind!==kind||hash(v.proof)!==v.proofSha256||Date.now()-Date.parse(v.observedAt)>60000)throw new Error('actual_independent_merge_validation_required');
  const proof=JSON.parse(v.proof.toString());if(proof.referenceSha256!==v.referenceSha256||proof.executionKind!==kind)throw new Error('actual_merge_validation_proof_changed');
}
