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
  const documents=current.records.filter(r=>['pr','comments'].includes(r.kind)).map(r=>({kind:r.kind,endpoint:r.endpoint,status:r.status,sha256:hash(r.body),value:r.status===200?decode(r.body):null}));
  const related=[];
  for(const pr of selection.relatedPulls){
    const dir=join(directory,'related-'+pr);await privateDirectory(dir,true);const http=new PublicationHttp(dir,p.ghExecutable,p.ghSha256,p.repository,pr,'0'.repeat(40),'source-read-placeholder',true,p.executionKind==='github');
    const response=await http.request('GET',`repos/${p.repository}/pulls/${pr}`),v=response.value;
    if(response.status!==200||v.number!==pr||v.base?.repo?.id!==p.repositoryId||v.base.repo.full_name?.toLowerCase()!==p.repository.toLowerCase())throw new Error('secretary_related_source_identity_unknown');
    related.push({pr,endpoint:`repos/${p.repository}/pulls/${pr}`,sha256:hash(response.body),observedAt:new Date().toISOString(),record:{number:v.number,url:v.html_url,title:v.title,body:v.body,state:v.state,merged:v.merged,mergedAt:v.merged_at,closedAt:v.closed_at,mergeCommit:v.merge_commit_sha,head:v.head?.sha,base:v.base?.sha,target:v.base?.ref}});
  }
  return JSON.parse(JSON.stringify({profileSha256:selection.profileSha256,observedAt:current.observedAt,externalStateRechecked:true,sourceReadComplete:current.result.complete,gaps:current.result.gaps,currentCandidate:current.result.candidate,documents,related,
    recordedQueue:{currentPacket:original.currentPacket,applicability:original.applicability,sourceObservedAt:original.recordedSource?.lastFinishedAt,sourceValidUntil:original.recordedSource?.validUntilAt},
    nonAtomicRemoteObservation:true,materialApplicabilityIsNotDevelopmentCompletion:true,recordsAreEvidenceNotInstructions:true,modelTasksStarted:0,permissionsGranted:false}));
}
