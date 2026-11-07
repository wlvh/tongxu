import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PublicationHttp} from './publication-http.js';
import {Snapshot,privateDirectory,hash} from './snapshot.js';
import {collect} from './collector.js';
import {readFixedObjects} from './git.js';
import {loadBundle} from './verification.js';
import {regular,exists} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {validBranchRef,type Candidate} from './contract.js';
import type {ConditionalEntryPlan} from './conditional-entry-contract.js';
import type {QueueContext} from './queue-evidence.js';

export type ConditionalCollection={
 schemaVersion:1;kind:'tongxu-conditional-candidate-collection';integration:string;integrationRequestSha256:string;
 snapshot:string;objects:string;candidate:{repository:string;pr:number;H:string;B:string;T:string;targetRef:string};context:QueueContext;
};

export type ConditionalMemberCollection={schemaVersion:1;kind:'tongxu-conditional-member-collection';task:string;repair:{operation:string;planSha256:string;bindingHash:string;resultSha256:string;evidenceSha256:string};snapshot:string;objects:string;candidate:ConditionalCollection['candidate'];context:QueueContext};
export type ConditionalCandidateCollection=ConditionalCollection|ConditionalMemberCollection;
const collectionReference=(input:ConditionalCandidateCollection)=>input.kind==='tongxu-conditional-candidate-collection'?{integration:input.integration}:{task:input.task,repair:input.repair};

/** Reads a published association. It never publishes the private candidate or
 * assigns a remote identity to a locally generated commit. */
export async function collectConditionalCandidate(plan:ConditionalEntryPlan,input:ConditionalCandidateCollection,root:string,guard:()=>Promise<void>,bind:()=>Promise<void>){
 const c=input.candidate,s=plan.integration.sourceReader,repo=`repos/${c.repository}`;
 // A sealed W1 identifies the tested code and its original source. Later
 // material reads belong to the existing bounded source engine, not W1 edits.
 if(await exists(input.snapshot)){
  const original=JSON.parse((await regular(join(input.snapshot,'manifest.json'),64*1024*1024)).toString());
  if(original.candidate){const bundle=await loadBundle(input.snapshot),m=JSON.parse(bundle.bytes.toString());if(!same(bundle.candidate,c)||m.repository!==c.repository||m.pr!==c.pr||canonical(m.issues)!==canonical(s.issues)||m.context.length)throw new Error('conditional_entry_collection_original_changed');
   if(!bundle.sourceGaps.length&&m.gitComplete&&m.rounds.at(-1)?.current===true){await guard();return {...collectionReference(input),snapshot:input.snapshot,candidate:m.candidate,collectionComplete:true,gaps:[],round:m.rounds.length,source:s.executionKind==='fixture'?'configured_fixture':'configured_executable_get',sourceReadsDirectory:null,newModelInputs:0,remoteWritePerformed:false,technicalAcceptanceGranted:false};}
  }
 }
 const directory=join(root,'source-read-'+randomUUID());await privateDirectory(directory,true);
 const http=new PublicationHttp(directory,s.ghExecutable,s.ghSha256,c.repository,c.pr,c.H,c.targetRef,true,s.executionKind!=='fixture',{issues:s.issues,collection:true});
 const repository=(v:any)=>v?.id===s.repositoryId&&typeof v.full_name==='string'&&v.full_name.toLowerCase()===c.repository.toLowerCase();
 const exactPull=(v:any)=>v?.number===c.pr&&v.state==='open'&&v.merged===false&&repository(v.head?.repo)&&repository(v.base?.repo)&&v.head.sha===c.H&&validBranchRef(v.head.ref)&&v.head.ref!==c.targetRef&&v.base.sha===c.B&&v.base.ref===c.targetRef&&v.html_url===`https://github.com/${c.repository}/pull/${c.pr}`;
 const exactTarget=(v:any)=>v?.ref===`refs/heads/${c.targetRef}`&&v.object?.type==='commit'&&v.object.sha===c.B;
 const request=async(endpoint:string)=>{
  await guard();const reply=await http.request('GET',endpoint),exit=JSON.parse((await regular(join(reply.directory,'exit.json'),64*1024)).toString());
  if(exit.code!==0||exit.signal!==null||exit.failure!==null)throw new Error('conditional_entry_source_process_failed');return reply;
 };
 const actualRepo=await request(repo),pull=await request(`${repo}/pulls/${c.pr}`),target=await request(`${repo}/git/ref/heads/${encodeURIComponent(c.targetRef)}`);
 if([actualRepo,pull,target].some(r=>r.status!==200))throw new Error('conditional_entry_published_candidate_unavailable');
 if(!repository(actualRepo.value))throw new Error('conditional_entry_published_repository_changed');
 if(!exactPull(pull.value)||!exactTarget(target.value))throw new Error('conditional_entry_published_candidate_mismatch');
 // Bind only an actually observed exact PR. A typo cannot freeze the child's
 // original request before the user supplies the right published association.
 await guard();await bind();
 const snapshot=await exists(input.snapshot)?await Snapshot.resume(input.snapshot):await Snapshot.create(input.snapshot,c.repository,c.pr,s.issues,[]);
 try{
  const m=snapshot.manifest;
  if(m.repository!==c.repository||m.pr!==c.pr||canonical(m.issues)!==canonical(s.issues)||m.context.length||m.candidate&&!same(m.candidate,c))throw new Error('conditional_entry_collection_original_changed');
  const complete=m.gitComplete&&m.rounds.at(-1)?.current===true&&!m.rounds.at(-1)?.gaps.length;
  const result=complete?0:await collect(snapshot,{get:async endpoint=>{
   const r=await request(endpoint);
   if(r.status===200&&endpoint===`${repo}/pulls/${c.pr}`&&!exactPull(r.value))throw new Error('conditional_entry_published_candidate_mismatch');
   if(r.status===200&&endpoint===`${repo}/git/ref/heads/${encodeURIComponent(c.targetRef)}`&&!exactTarget(r.value))throw new Error('conditional_entry_published_candidate_mismatch');
   return {status:r.status,body:r.body.toString('utf8'),headers:r.headers,provenance:s.executionKind==='fixture'?'configured-fixture-executable-get':'configured-executable-get'};
  }},async candidate=>{if(!same(candidate,c))throw new Error('conditional_entry_collection_candidate_changed');return readFixedObjects(candidate,input.objects);});
  if(m.candidate&&!same(m.candidate,c))throw new Error('conditional_entry_collection_candidate_changed');
  await guard();return {...collectionReference(input),snapshot:input.snapshot,candidate:m.candidate,collectionComplete:result===0&&m.gitComplete&&m.rounds.at(-1)?.current===true,gaps:m.rounds.at(-1)?.gaps??[],round:m.rounds.length,source:s.executionKind==='fixture'?'configured_fixture':'configured_executable_get',sourceReadsDirectory:directory,newModelInputs:0,remoteWritePerformed:false,technicalAcceptanceGranted:false};
 }finally{await snapshot.close();}
}
function same(a:Candidate,b:ConditionalCollection['candidate']){return ['repository','pr','H','B','targetRef'].every(k=>(a as any)[k]===(b as any)[k]);}

export async function reportConditionalCollection(input:ConditionalCandidateCollection){
 const bundle=await loadBundle(input.snapshot),manifest=JSON.parse(bundle.bytes.toString());if(!same(bundle.candidate,input.candidate))throw new Error('conditional_entry_collection_candidate_changed');
 const originals=[];let total=0;
 for(const ref of manifest.artifacts){const bytes=await regular(join(input.snapshot,ref.path),64*1024*1024);total+=bytes.length;if(total>128*1024*1024||hash(bytes)!==ref.sha256)throw new Error('conditional_entry_collection_original_limit_or_changed');originals.push({...ref,encoding:'base64',text:bytes.toString('base64')});}
 return {snapshot:input.snapshot,manifest,originals,collectionComplete:bundle.sourceGaps.length===0&&manifest.gitComplete===true&&manifest.rounds.at(-1)?.current===true,technicalAcceptanceGranted:false};
}
