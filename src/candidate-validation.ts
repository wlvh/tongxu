import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from './queue-store.js';
import {parseCandidateValidation,candidateValidationProducerKind} from './candidate-validation-contract.js';
import {readCandidateValidationCapture} from './candidate-validation-capture.js';
import {verify,loadBundle} from './verification.js';
import {regular,exists} from './repair-workspace.js';
import {privateDirectory,hash} from './snapshot.js';
import {canonical} from './comparison.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {prepareResourceRequest,resourceAction} from './resource-claims.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';

async function directory(path:string){await privateDirectory(path,!await exists(path));}
async function fixed(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}if(!(await regular(path,64*1024*1024)).equals(bytes))throw new Error('candidate_validation_frozen_original_changed');}

/** One original verifier and execution registry. Recovery consumes its actual
 * captures; an existing/unknown run never starts another verifier. */
export async function runCandidateValidation(store:string,requestPath:string,requests:ResourceRequest[]=[]){
 const raw=await regular(requestPath,128*1024),p=parseCandidateValidation(raw),q=await QueueStore.open(store);let lock:DatabaseSync|undefined;
 try{
  if(p.store!==store)throw new Error('candidate_validation_original_store_required');
  const records=q.candidateValidations();records.protect();await directory(p.directory);await fixed(join(p.directory,'request.json'),raw);
  const lockPath=join(p.directory,'controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(lockPath);lock=new DatabaseSync(lockPath);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('candidate_validation_controller_active');}
  let prior:ReturnType<typeof records.state>|undefined;try{prior=records.state(p.id);}catch(e){if(!(e instanceof Error)||e.message!=='candidate_validation_not_prepared')throw e;}
  if(prior&&prior.requestSha256!==hash(raw))throw new Error('candidate_validation_request_is_fixed');
  const refresh=async()=>{const observations:OwnerObservation[]=[];if(p.governance){const a=q.authority(),reserved=a.reservedAction(p.governance.authorityIntent),root=join(p.directory,'owner-'+randomUUID());await directory(root);for(const [index,ref] of a.sourceRequests(reserved.authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(root,String(index))));}return observations;};
  const freezeSources=async()=>{const originals=records.originals(p.id);for(const name of ['snapshot','snapshot/raw','snapshot/git'])await directory(join(p.directory,name));await fixed(join(p.directory,'snapshot','manifest.json'),originals.manifest);await fixed(join(p.directory,'test-plan.json'),originals.testPlan);await fixed(join(p.directory,'context.json'),originals.context);for(const ref of originals.artifacts)await fixed(join(p.directory,'snapshot',ref.path),ref.bytes);};
  const settle=async()=>{const results=[];for(const id of p.governance?.resourceRequests??[]){try{const old=q.resources().status(id);if(old.pendingResultAttempt&&!q.resources().settledOutcome(id))await resourceAction(store,id,'lookup','background');results.push(await resourceAction(store,id,'record-result','background'));}catch(e){results.push({id,state:'result_pending_or_unknown',reason:e instanceof Error?e.message:'resource_result_unavailable'});}}return {settled:(p.governance?.resourceRequests??[]).every(id=>q.resources().settledOutcome(id)),results};};
  const complete=async()=>{const state=records.state(p.id);if(!state.binding)throw new Error('candidate_validation_original_run_required');const capture=await readCandidateValidationCapture(p,state.binding,records.executions(p.id));records.complete(p.id,capture);const resources=await settle();return {state:records.state(p.id),resources};};
  if(prior?.binding){await freezeSources();return {...await complete(),newVerificationRuns:0,newModelInputs:0,duplicate:true,technicalAcceptanceGranted:false};}
  if(await exists(join(p.directory,'verification'))||await exists(join(p.directory,'producer.json')))throw new Error('candidate_validation_original_start_unknown');
  if(!prior){
   const bundle=await loadBundle(p.collection.snapshot),testPlan=await regular(p.testPlan.path,64*1024),m=JSON.parse(bundle.bytes.toString()),artifacts=new Map<string,Buffer>();
   if(hash(bundle.bytes)!==p.manifestSha256||hash(testPlan)!==p.testPlan.sha256)throw new Error('candidate_validation_fixed_inputs_changed');
   for(const ref of m.artifacts)artifacts.set(ref.sha256,await regular(join(p.collection.snapshot,ref.path),64*1024*1024));
   if(canonical(requests.map(resourceRequestHash))!==canonical(p.governance?.resourceRequests??[]))throw new Error('candidate_validation_resource_request_set_changed');
   for(const request of requests)await prepareResourceRequest(store,Buffer.from(canonical(request)),'background');
   records.prepare(raw,bundle.bytes,testPlan,artifacts,await refresh());
  }
  for(const id of p.governance?.resourceRequests??[]){let state=q.resources().status(id);if(state.state==='prepared_not_sent')state=await resourceAction(store,id,'claim','background');else if(state.state==='claim_unknown')state=await resourceAction(store,id,'lookup','background');if(state.state!=='held')throw new Error('candidate_validation_original_resources_unresolved');}
  let observations=await refresh();records.check(p.id,observations);await freezeSources();
  await verify({snapshots:[join(p.directory,'snapshot')],objects:p.collection.objects,plan:join(p.directory,'test-plan.json'),output:join(p.directory,'verification')},{
   registered:(run,testPlanSha256,manifests)=>{const binding=records.registerRun(p.id,run,testPlanSha256,manifests);writeFileSync(join(p.directory,'producer.json'),canonical({kind:candidateValidationProducerKind(p),executionMethod:'existing-w2-verifier',newModelInputs:0,binding}),{flag:'wx',mode:0o600});},
   executionRegistered:async intent=>{observations=await refresh();records.registerExecution(p.id,intent,observations);},
   startGate:{refresh:async()=>{observations=await refresh();for(const id of p.governance?.resourceRequests??[])await resourceAction(store,id,'lookup','background');records.check(p.id,observations);},start:effect=>records.effect(p.id,observations,effect)}
  });
  return {...await complete(),newVerificationRuns:1,newModelInputs:0,duplicate:false,technicalAcceptanceGranted:false};
 }finally{if(lock?.isTransaction)lock.exec('ROLLBACK');lock?.close();q.close();}
}
