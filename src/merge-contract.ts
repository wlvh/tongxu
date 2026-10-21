import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { repoPattern,shaPattern,validBranchRef } from './contract.js';
import { exactKeys,isAuthorityDigest } from './authority-contract.js';

export type ManagedMergeBinding={schemaVersion:1;operation:string;item:string;packet:number;repository:string;repositoryId:number;pr:number;H:string;B:string;targetRef:string;T:string;receptionOperation:string;judgmentId:string;receptionBindingHash:string;authorityIntent:string;resourceRequests:string[];scope:{id:string;version:string;bodySha256:string};arrangement:{id:string;version:string};subjectSha256:string|null;integrationReference:string|null;method:'merge'};
export type MergeWire={status:number;body:Buffer};
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseMergeBinding(x:any):ManagedMergeBinding{
  if(!exactKeys(x,['schemaVersion','operation','item','packet','repository','repositoryId','pr','H','B','targetRef','T','receptionOperation','judgmentId','receptionBindingHash','authorityIntent','resourceRequests','scope','arrangement','subjectSha256','integrationReference','method'])||x.schemaVersion!==1||x.method!=='merge'||!uuid.test(x.operation)||!uuid.test(x.receptionOperation)||!isAuthorityDigest(x.item)||!isAuthorityDigest(x.receptionBindingHash)||!text(x.judgmentId,128)||!text(x.authorityIntent,128)||![x.packet,x.repositoryId,x.pr].every(n=>Number.isSafeInteger(n)&&n>0)||!repoPattern.test(x.repository)||![x.H,x.B,x.T].every(s=>typeof s==='string'&&shaPattern.test(s))||!validBranchRef(x.targetRef)||!Array.isArray(x.resourceRequests)||!x.resourceRequests.length||x.resourceRequests.length>8||new Set(x.resourceRequests).size!==x.resourceRequests.length||!x.resourceRequests.every(isAuthorityDigest)||!(x.subjectSha256===null||isAuthorityDigest(x.subjectSha256))||!(x.integrationReference===null||isAuthorityDigest(x.integrationReference)))throw new Error('managed_merge_binding_invalid');
  if(!exactKeys(x.scope,['id','version','bodySha256'])||!text(x.scope.id,128)||!text(x.scope.version,128)||!isAuthorityDigest(x.scope.bodySha256)||!exactKeys(x.arrangement,['id','version'])||!text(x.arrangement.id,128)||!text(x.arrangement.version,128))throw new Error('managed_merge_scope_binding_invalid');
  // A materialized integration has its own individual PR reception. Its
  // source composition is carried by integrationReference, not an invented
  // composition subject for the new PR. The consumer verifies that reference.
  return x;
}
export const mergeBindingHash=(b:ManagedMergeBinding)=>hash(canonical(b));
export function mergePayload(b:ManagedMergeBinding){
  parseMergeBinding(b);return {sha:b.H,merge_method:'merge',commit_title:`tongxu: receive PR #${b.pr}`,commit_message:`tongxu-merge-operation:${b.operation}\ntongxu-merge-binding:${mergeBindingHash(b)}`};
}
function object(wire:MergeWire){if(wire.status!==200)throw new Error('merge_read_unavailable');const x=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(wire.body));if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('merge_read_invalid');return x;}
function target(wire:MergeWire,b:ManagedMergeBinding){const x=object(wire);if(x.ref!==`refs/heads/${b.targetRef}`||x.object?.type!=='commit'||!shaPattern.test(x.object.sha))throw new Error('merge_target_ref_invalid');return x.object.sha as string;}

/** Reads are observations only. This parser grants no permission, credential,
 * resource or writer ownership and cannot certify its input's provenance. */
export function inspectMergeCurrent(b:ManagedMergeBinding,pr:MergeWire,before:MergeWire,after:MergeWire){
  parseMergeBinding(b);const gaps:string[]=[];let data:any=null,actualB:string|null=null;
  try{const a=target(before,b),z=target(after,b);actualB=z;if(a!==z)gaps.push('target_moved_during_preflight');if(z!==b.B)gaps.push('current_base_differs_from_tested_base');}catch(e){gaps.push(e instanceof Error?e.message:'target_unavailable');}
  try{data=object(pr);if(data.number!==b.pr||data.head?.repo?.id!==b.repositoryId||data.base?.repo?.id!==b.repositoryId||data.base?.repo?.full_name?.toLowerCase()!==b.repository.toLowerCase())gaps.push('merge_pr_repository_identity_mismatch');
    if(data.state!=='open'||data.merged!==false||data.draft!==false)gaps.push('merge_pr_not_open_ready');if(data.head?.sha!==b.H)gaps.push('merge_head_changed');if(data.base?.ref!==b.targetRef)gaps.push('merge_target_changed');
    if(data.mergeable!==true)gaps.push('mergeability_unresolved_or_conflicting');
  }catch(e){gaps.push(e instanceof Error?e.message:'merge_pr_unavailable');}
  if(b.subjectSha256&&!b.integrationReference)gaps.push('composition_requires_exact_integration_candidate');
  return {candidateMatches:gaps.length===0,gaps,actualB,prReportedBase:data?.base?.sha??null,nonAtomicRemoteObservation:true,permissionGranted:false,resourceClaimVerified:false,writerOwnershipVerified:false};
}
export function inspectMergeResponse(wire:MergeWire){
  let x:any;try{x=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(wire.body));}catch{return {state:'sent_unknown',reason:'merge_response_incomplete',mergeCommit:null};}
  if(wire.status===200&&x?.merged===true&&typeof x.sha==='string'&&shaPattern.test(x.sha))return {state:'merged_response_pending_readback',reason:null,mergeCommit:x.sha};
  if([400,401,403,404,405,409,410,422,429].includes(wire.status)&&x&&typeof x==='object'&&!Array.isArray(x)&&typeof x.message==='string'&&(x.merged===undefined||x.merged===false))return {state:'refused',reason:'merge_endpoint_rejected',mergeCommit:null};
  return {state:'sent_unknown',reason:'merge_response_not_definitive',mergeCommit:null};
}

export function inspectMergedResult(b:ManagedMergeBinding,input:{pr:MergeWire;commit:MergeWire;targetBefore:MergeWire;targetAfter:MergeWire;comparison?:MergeWire;response?:MergeWire;expectedActorId:number}){
  parseMergeBinding(b);let pr:any,commit:any,first:string,last:string;
  const pending=(reason:string,extra:Record<string,unknown>={})=>({state:'merged_pending_verification',reason,...extra,productionActionAllowed:false});
  try{pr=object(input.pr);}catch{return {state:'sent_unknown',reason:'original_pr_readback_unavailable',productionActionAllowed:false};}
  if(pr.number!==b.pr||pr.base?.repo?.id!==b.repositoryId||pr.head?.repo?.id!==b.repositoryId||pr.base?.repo?.full_name?.toLowerCase()!==b.repository.toLowerCase())return {state:'sent_unknown',reason:'original_pr_identity_mismatch',productionActionAllowed:false};
  if(pr.state!=='closed'||pr.merged!==true||!shaPattern.test(pr.merge_commit_sha??''))return {state:'sent_unknown',reason:'original_pr_not_yet_proven_merged',productionActionAllowed:false};
  if(pr.base.ref!==b.targetRef)return {state:'merged_wrong_target',reason:'wrong_target_cannot_be_repaired_by_tests',actualTarget:pr.base.ref,mergeCommit:pr.merge_commit_sha,productionActionAllowed:false};
  try{commit=object(input.commit);first=target(input.targetBefore,b);last=target(input.targetAfter,b);}catch(e){return pending(e instanceof Error?e.message:'actual_merge_readback_unavailable',{mergeCommit:pr.merge_commit_sha});}
  if(commit.sha!==pr.merge_commit_sha||!shaPattern.test(commit.tree?.sha??'')||!Array.isArray(commit.parents)||commit.parents.length!==2||commit.parents.some((x:any)=>!shaPattern.test(x?.sha??'')))return pending('actual_merge_commit_or_method_unverified',{mergeCommit:pr.merge_commit_sha});
  if(input.response){const response=inspectMergeResponse(input.response);if(response.mergeCommit&&response.mergeCommit!==commit.sha)return pending('merge_response_commit_conflict',{mergeCommit:commit.sha});}
  const markers=mergePayload(b).commit_message.split('\n'),lines=typeof commit.message==='string'?commit.message.split(/\r?\n/):[];
  if(pr.merged_by?.id!==input.expectedActorId||!Number.isSafeInteger(input.expectedActorId)||input.expectedActorId<=0||!markers.every(m=>lines.filter((l:string)=>l===m).length===1))return pending('original_sender_or_request_correlation_unverified',{mergeCommit:commit.sha});
  if(commit.parents[1].sha!==b.H)return pending('actual_merged_head_differs_from_requested_head',{mergeCommit:commit.sha,actualHead:commit.parents[1].sha});
  if(first!==last)return pending('target_changed_during_readback',{mergeCommit:commit.sha});
  if(last!==commit.sha){
    try{const comparison=object(input.comparison!);if(comparison.status!=='ahead'||comparison.behind_by!==0||!Number.isSafeInteger(comparison.ahead_by)||comparison.ahead_by<1||comparison.base_commit?.sha!==commit.sha||comparison.merge_base_commit?.sha!==commit.sha)throw new Error('actual_merge_not_proven_in_target');}
    catch{return pending('actual_merge_not_proven_in_target',{mergeCommit:commit.sha,targetTip:last});}
  }
  const actual={mergeCommit:commit.sha,actualBase:commit.parents[0].sha,actualHead:commit.parents[1].sha,actualTree:commit.tree.sha,target:b.targetRef,targetTip:last,sourceCurrent:pr.head?.sha===b.H};
  if(actual.actualBase!==b.B||actual.actualTree!==b.T)return pending('actual_version_requires_own_validation',actual);
  return {state:'exact_merge_result_observed',...actual,providerProvenanceVerified:false,authorityVerified:false,productionActionAllowed:false};
}
