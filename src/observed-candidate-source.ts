import {join} from 'node:path';
import {PublicationHttp,ordinaryFile} from './publication-http.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import type {ObservedCandidateRequest} from './observed-candidate-contract.js';
import {repoPattern,shaPattern,validBranchRef} from './contract.js';

export type ObservedCandidateBinding={repository:string;pr:number;H:string;B:string;T:string;targetRef:string;integration:string;integrationRequestSha256:string;item:string;packet:number;fingerprint:string;manifestSha256:string;reportSha256:string;contextSha256:string};
type Original={name:string;sha256:string;bytes:number;encoding:'base64';text:string};
export type ObservedCandidateCapture={schemaVersion:1;kind:'tongxu-remote-candidate-observation';requestSha256:string;binding:ObservedCandidateBinding;repositoryId:number;executable:{path:string;sha256:string};startedAt:string;observedAt:string;observations:Array<{endpoint:string;status:number;bodySha256:string;body:unknown;originals:Original[]}>;nonAtomicRemoteObservation:true;source:'configured-executable-get';remoteWritePerformed:false;modelInputs:0;testsStarted:0;permissionGranted:false};
const issued=new WeakMap<object,string>();

/** The configured process performs GETs only. The capture proves that exact
 * invocation, not the identity of an arbitrary executable supplied as gh. */
export async function observeRemoteCandidate(p:ObservedCandidateRequest,b:ObservedCandidateBinding,directory:string):Promise<ObservedCandidateCapture>{
  if(!repoPattern.test(b.repository)||!Number.isSafeInteger(b.pr)||b.pr<1||![b.H,b.B,b.T].every(x=>shaPattern.test(x))||!validBranchRef(b.targetRef))throw new Error('observed_candidate_binding_invalid');
  const http=new PublicationHttp(directory,p.ghExecutable,p.ghSha256,b.repository,b.pr,b.H,b.targetRef,true),base=`repos/${b.repository}`,ref=`${base}/git/ref/heads/${encodeURIComponent(b.targetRef)}`,pr=`${base}/pulls/${b.pr}`,startedAt=new Date().toISOString(),observations:ObservedCandidateCapture['observations']=[];
  const read=async(endpoint:string)=>{
    const r=await http.request('GET',endpoint),originals:Original[]=[];
    for(const name of ['request.json','stdin.json','stdout.http','stderr.txt','process.json','exit.json','submission-intent.json','submitted.json','response.json']){const bytes=await ordinaryFile(join(r.directory,name),8*1024*1024);originals.push({name,sha256:hash(bytes),bytes:bytes.length,encoding:'base64',text:bytes.toString('base64')});}
    const exit=JSON.parse(Buffer.from(originals.find(x=>x.name==='exit.json')!.text,'base64').toString());
    if(exit.code!==0||exit.signal!==null||exit.failure!==null)throw new Error('observed_candidate_read_process_failed');
    observations.push({endpoint,status:r.status,bodySha256:hash(r.body),body:r.value,originals});if(r.status!==200)throw new Error('observed_candidate_remote_unavailable');return r.value;
  };
  const before=await read(ref),first=await read(pr),repo=await read(base),last=await read(pr),after=await read(ref);
  const repository=(r:any)=>r?.id===p.repositoryId&&typeof r.full_name==='string'&&r.full_name.toLowerCase()===b.repository.toLowerCase();
  const identity=(v:any)=>({number:v?.number,state:v?.state,merged:v?.merged===true,head:{sha:v?.head?.sha,ref:v?.head?.ref,repositoryId:v?.head?.repo?.id,repository:v?.head?.repo?.full_name},base:{sha:v?.base?.sha,ref:v?.base?.ref,repositoryId:v?.base?.repo?.id,repository:v?.base?.repo?.full_name},html_url:v?.html_url});
  if(!repository(repo))throw new Error('observed_candidate_repository_changed');
  for(const v of [first,last])if(v.number!==b.pr||v.state!=='open'||v.merged===true||!repository(v.head?.repo)||!repository(v.base?.repo)||v.head.sha!==b.H||!validBranchRef(v.head.ref)||v.head.ref===b.targetRef||v.base.ref!==b.targetRef||v.html_url!==`https://github.com/${b.repository}/pull/${b.pr}`)throw new Error('observed_candidate_remote_changed');
  for(const v of [before,after])if(v.ref!==`refs/heads/${b.targetRef}`||v.object?.type!=='commit'||v.object.sha!==b.B)throw new Error('observed_candidate_target_changed');
  if(canonical(identity(first))!==canonical(identity(last)))throw new Error('observed_candidate_changed_during_read');
  const capture:ObservedCandidateCapture={schemaVersion:1,kind:'tongxu-remote-candidate-observation',requestSha256:hash(canonical(p)),binding:b,repositoryId:p.repositoryId,executable:{path:p.ghExecutable,sha256:p.ghSha256},startedAt,observedAt:new Date().toISOString(),observations,nonAtomicRemoteObservation:true,source:'configured-executable-get',remoteWritePerformed:false,modelInputs:0,testsStarted:0,permissionGranted:false};
  issued.set(capture,hash(canonical(capture)));return capture;
}
export function requireObservedCandidate(c:ObservedCandidateCapture,p:ObservedCandidateRequest,b:ObservedCandidateBinding){
  const elapsed=Date.now()-Date.parse(c?.observedAt);
  if(!c||issued.get(c)!==hash(canonical(c))||c.requestSha256!==hash(canonical(p))||canonical(c.binding)!==canonical(b)||elapsed<0||elapsed>30_000)throw new Error('actual_current_candidate_observation_required');return c;
}
