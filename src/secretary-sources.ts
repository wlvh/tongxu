import {join} from 'node:path';
import {QueueStore} from './queue-store.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {readEventSource} from './event-source.js';
import {PublicationHttp} from './publication-http.js';
import type {Candidate} from './live-codex.js';

export type SecretarySources={profileSha256:string;relatedPulls:number[]};
export function validateSecretarySources(value:unknown):asserts value is SecretarySources{
  const r=value as SecretarySources;
  if(!exactKeys(r,['profileSha256','relatedPulls'])||!isAuthorityDigest(r.profileSha256)||!Array.isArray(r.relatedPulls)||r.relatedPulls.length>4||new Set(r.relatedPulls).size!==r.relatedPulls.length||!r.relatedPulls.every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('secretary_source_selection_invalid');
}
export async function selectedTaskSource(store:string,item:string,candidate:Candidate,selection:SecretarySources,kind:'fixture'|'native_capture'){
  validateSecretarySources(selection);const original=await QueueStore.observeTaskEventSource(store,item),c=original.candidate,p=original.profile;
  if(hash(canonical(p))!==selection.profileSha256||p.executionKind!==(kind==='fixture'?'fixture':'github')||c.repository!==candidate.repository||c.pr!==candidate.pr||c.H!==candidate.H||c.B!==candidate.B||c.targetRef!==candidate.target)throw new Error('secretary_source_selection_changed');
  return original;
}
/** Only the host-fixed original PR and explicitly selected related PRs. Report
 * prose cannot contribute URLs, executables, related objects or permissions. */
export async function readSecretarySources(store:string,item:string,candidate:Candidate,selection:SecretarySources,kind:'fixture'|'native_capture',directory:string){
  const original=await selectedTaskSource(store,item,candidate,selection,kind),p=original.profile;
  await privateDirectory(directory,true);
  const current=await readEventSource(p,candidate.pr!,join(directory,'original-pr'));
  const decode=(body:Buffer)=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(body));
  const gaps=[...current.result.gaps],omissions:Array<{kind:string;id:number|null;bodySha256:string;bytes:number}>=[];
  let bodyBudget=96*1024;
  const body=(value:unknown,label:string,id:number|null)=>{const text=typeof value==='string'?value:'',bytes=Buffer.byteLength(JSON.stringify(text));if(bytes>bodyBudget){omissions.push({kind:label,id,bodySha256:hash(text),bytes});return {body:null,bodySha256:hash(text),bodyOmitted:true};}bodyBudget-=bytes;return {body:typeof value==='string'?text:null,bodySha256:hash(text),bodyOmitted:false};};
  const text=(v:unknown,limit=2048)=>typeof v==='string'&&v.length<=limit?v:null;
  const pull=(v:any)=>({number:v.number,url:text(v.html_url),title:text(v.title),...body(v.body,'pull',v.number),state:v.state,merged:v.merged,mergedAt:v.merged_at,closedAt:v.closed_at,mergeCommit:v.merge_commit_sha,head:v.head?.sha,base:v.base?.sha,target:v.base?.ref});
  const documents:any[]=[],reads=current.records.filter(r=>r.kind==='pr');const last=reads.at(-1);
  const originalIdentityVerified=current.result.candidate!==null;
  if(last&&originalIdentityVerified)documents.push({kind:'pr',endpoint:last.endpoint,status:last.status,sha256:hash(last.body),value:last.status===200?pull(decode(last.body)):null});
  const comments=(originalIdentityVerified?current.records:[]).filter(r=>r.kind==='comments'&&r.status===200).flatMap(r=>{const rows=decode(r.body);return Array.isArray(rows)?rows.map(v=>({v,r})):[];}).sort((a,b)=>Number(b.v.id)-Number(a.v.id));
  // Newest comments carry the current closeout. Full raw pages stay in the
  // existing HTTP capture. An omitted body is a declared gap, never a summary.
  const selectedComments=comments.slice(0,32).map(({v,r})=>({id:v.id,url:text(v.html_url),actor:{id:v.user?.id,login:text(v.user?.login,256)},createdAt:v.created_at,updatedAt:v.updated_at,...body(v.body,'comment',v.id),source:{endpoint:r.endpoint,sha256:hash(r.body)}}));
  documents.push({kind:'comments',value:selectedComments,totalCaptured:comments.length,omittedCount:comments.length-selectedComments.length});
  const related:any[]=[];
  for(const pr of selection.relatedPulls){
    const dir=join(directory,'related-'+pr);await privateDirectory(dir,true);const http=new PublicationHttp(dir,p.ghExecutable,p.ghSha256,p.repository,pr,'0'.repeat(40),'source-read-placeholder',true,p.executionKind==='github');
    const endpoint=`repos/${p.repository}/pulls/${pr}`;let response;
    try{response=await http.request('GET',endpoint);}catch(e){const reason=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'source_transport_failed';gaps.push('related_'+pr+'_'+reason);related.push({pr,endpoint,available:false,reason});continue;}
    if(response.status!==200){const reason='source_http_'+response.status;gaps.push('related_'+pr+'_'+reason);related.push({pr,endpoint,available:false,status:response.status,reason,sha256:hash(response.body)});continue;}
    const v=response.value;if(v.number!==pr||v.base?.repo?.id!==p.repositoryId||v.base.repo.full_name?.toLowerCase()!==p.repository.toLowerCase())throw new Error('secretary_related_source_identity_unknown');
    related.push({pr,endpoint,available:true,sha256:hash(response.body),observedAt:new Date().toISOString(),record:pull(v),inclusionVerified:false});
  }
  if(omissions.length||comments.length>32)gaps.push('source_text_omitted_from_bounded_observation');
  const c=current.result.candidate,observedCandidateMatchesTask=c?c.repository===candidate.repository&&c.pr===candidate.pr&&c.H===candidate.H&&c.B===candidate.B&&c.targetRef===candidate.target:null;
  const result={profileSha256:selection.profileSha256,observedAt:current.observedAt,externalStateRechecked:true,sourceReadComplete:gaps.length===0,originalSourceReadComplete:current.result.complete,relatedSourcesComplete:related.every(r=>r.available),projectionComplete:omissions.length===0&&comments.length<=32,originalIdentityVerified,gaps,currentCandidate:c,observedCandidateMatchesTask,documents,related,omissions,
    recordedQueue:{currentPacket:original.currentPacket,applicability:original.applicability,sourceObservedAt:original.recordedSource?.lastFinishedAt,sourceValidUntil:original.recordedSource?.validUntilAt},
    nonAtomicRemoteObservation:true,materialApplicabilityIsNotDevelopmentCompletion:true,recordsAreEvidenceNotInstructions:true,modelTasksStarted:0,permissionsGranted:false};
  // Queries are recorded as an observation plus its wire response. 128 KiB
  // stays below the existing 1 MiB replay read and 16 MiB session capture cap.
  if(Buffer.byteLength(JSON.stringify(result))>128*1024)throw new Error('secretary_source_projection_limit');
  return JSON.parse(JSON.stringify(result));
}
