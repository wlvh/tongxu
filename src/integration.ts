import {readFile,writeFile,realpath,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {parseIntegrationRequest,integrationRequestSha256} from './integration-contract.js';
import {captureIntegrationGit,readIntegrationGit} from './integration-git.js';
import {integrationContinuationProtocol,integrationRuntimeHashes,recordIntegrationBoundary,integrationControllerReturned,inspectIntegrationContinuation,recordIntegrationContinuation,checkIntegrationContinuationBoundary,checkIntegrationPrefixCapture} from './integration-continuation.js';
import {integrationRecipe,readIntegrationCapture} from './integration-producer.js';
import {inspectObjectSource} from './integration-objects.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';

const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]{1,160}$/.test(e.message)?e.message:'integration_failed';
async function frozen(path:string,b:Buffer){try{await writeFile(path,b,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,64*1024*1024)).equals(b))throw new Error('integration_frozen_file_changed');}}
export async function runIntegration(store:string,requestPath:string,action:'prepare'|'run'|'reconcile'|'close-unstarted'|'continue-ended'='run'){
  const raw=await regular(requestPath,32*1024),p=parseIntegrationRequest(raw),requestSha256=integrationRequestSha256(p),directory=join(store,'integration-'+requestSha256),q=await QueueStore.open(store);let lock:DatabaseSync|undefined,observations:OwnerObservation[]=[],controllerId:string|undefined,producerSha256:string|undefined;
  try{
    if(!await exists(directory))await privateDirectory(directory,true);else await privateDirectory(directory,false);
    await frozen(join(directory,'request.json'),raw);const lockPath=join(directory,'controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await regular(lockPath);lock=new DatabaseSync(lockPath);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('integration_controller_active');}
    const records=q.integrations(),refresh=async()=>{observations=[];if(p.authorityIntent){const a=q.authority(),reserved=a.reservedAction(p.authorityIntent),{profile}=a.configuration();for(const ref of a.sourceRequests(reserved.authorization))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(directory,'source-check-'+randomUUID())));}};
    let state:ReturnType<typeof records.state>|undefined;try{state=records.state(p.id);}catch(e){if(reason(e)!=='integration_not_prepared')throw e;}
    if(state&&state.requestSha256!==requestSha256)throw new Error('integration_request_id_changed');
    if(state&&['produced','closed_unstarted','failed_ended'].includes(state.phase))return {...state,newGitProcesses:0,newModelInputs:0,duplicate:true};
    if(!state){if(action==='reconcile'||action==='close-unstarted'||action==='continue-ended')return {id:p.id,phase:'not_prepared',newGitProcesses:0,newModelInputs:0};await refresh();records.prepare(raw,observations);}
    const m=records.sourceMaterial(p.id);if(m.directory!==directory)throw new Error('integration_original_workspace_required');
    if(action==='prepare')return {...records.state(p.id),newGitProcesses:0,newModelInputs:0};
    if(action==='close-unstarted'){if(await exists(join(directory,'producer.json'))||await exists(join(directory,'candidate.bundle')))throw new Error('integration_original_output_unresolved');for(const name of ['steps','candidate.git'])if(await exists(join(directory,name))&&(await readdir(join(directory,name))).length)throw new Error('integration_original_output_unresolved');return {...records.closeUnstarted(p.id),newGitProcesses:0,newModelInputs:0};}
    if(state?.phase==='started_or_unknown'){
      if(action!=='continue-ended'){const capture=await readIntegrationCapture(m);return {...records.complete(p.id,capture),newGitProcesses:0,newModelInputs:0,recovery:'original_complete_captures_only'};}
      let complete:Awaited<ReturnType<typeof readIntegrationCapture>>|undefined;try{complete=await readIntegrationCapture(m);}catch{/* The prefix probe below must prove the exact safe missing boundary. */}
      if(complete)return {...records.complete(p.id,complete),newGitProcesses:0,newModelInputs:0,recovery:'original_complete_captures_only'};
      const proof=await inspectIntegrationContinuation(m);await refresh();const nextController=randomUUID();records.continueEnded(p.id,proof,nextController,observations);controllerId=nextController;producerSha256=proof.producerSha256;await recordIntegrationContinuation(directory,controllerId,proof);
      let processes=0,lastBoundary=proof.lastBoundarySha256;const prefix=new Set(proof.completedSteps);
      try{await integrationRecipe(proof.material,async(name,step)=>{
        const root=join(directory,'steps',name);if(prefix.has(name)){const result=await readIntegrationGit(root,step);checkIntegrationPrefixCapture(proof,name,result);return result;}if(await exists(root))throw new Error('integration_continuation_unexplained_step');
        const result=await captureIntegrationGit(root,step,effect=>records.effect(p.id,observations,()=>{if(processes===0)checkIntegrationContinuationBoundary(proof);const value=effect();if(Number.isSafeInteger((value as any)?.pid))processes++;return value;}),refresh);
        if(result.successful){const boundary=await recordIntegrationBoundary(m,name,result,lastBoundary);records.boundary(p.id,boundary.bytes);lastBoundary=boundary.sha256;}return result;
      });}catch(e){records.problem(p.id,reason(e));}
      const capture=await readIntegrationCapture(m);return {...records.complete(p.id,capture),newGitProcesses:processes,newModelInputs:0,recovery:'continued_verified_ended_prefix',reusedGitSteps:proof.completedSteps.length,continuation:controllerId};
    }
    if(action==='reconcile')return {...records.state(p.id),newGitProcesses:0,newModelInputs:0};
    if(await realpath(p.objects)!==p.objects||!(await lstat(p.objects)).isDirectory())throw new Error('integration_object_source_invalid');
    const objectSource=await inspectObjectSource(p.objects);await frozen(join(directory,'object-source.json'),Buffer.from(canonical(objectSource)));
    for(const name of ['steps','candidate.git']){const path=join(directory,name);if(await exists(path)){await privateDirectory(path,false);if((await readdir(path)).length)throw new Error('integration_original_output_unresolved');}else await privateDirectory(path,true);}
    await refresh();records.start(p.id,observations);
    const runtimeModules=await integrationRuntimeHashes();controllerId=randomUUID();
    const producer=Buffer.from(canonical({kind:'tongxu-fixed-git-integration',requestSha256,sourceSha256:hash(canonical(m.source)),objectSourceSha256:hash(canonical(objectSource)),directory,controllerPid:process.pid,controllerId,continuationProtocol:integrationContinuationProtocol,runtimeModules,node:{executable:process.execPath,version:process.version},startedAt:new Date().toISOString(),newModelInputs:0,targetUpdates:0}));await frozen(join(directory,'producer.json'),producer);producerSha256=hash(producer);
    const initialBoundary=await recordIntegrationBoundary(m,'initial',null,null);records.boundary(p.id,initialBoundary.bytes);let lastBoundary=initialBoundary.sha256,processes=0;
    try{await integrationRecipe({...m,objectSource},async(name,step)=>{const result=await captureIntegrationGit(join(directory,'steps',name),step,effect=>records.effect(p.id,observations,()=>{const value=effect();if(Number.isSafeInteger((value as any)?.pid))processes++;return value;}),refresh);if(result.successful){const boundary=await recordIntegrationBoundary(m,name,result,lastBoundary);records.boundary(p.id,boundary.bytes);lastBoundary=boundary.sha256;}return result;});}catch(e){records.problem(p.id,reason(e));}
    const capture=await readIntegrationCapture(m);return {...records.complete(p.id,capture),newGitProcesses:processes,newModelInputs:0};
  }catch(e){try{q.integrations().problem(p.id,reason(e));}catch{}throw e;}
  finally{try{if(controllerId&&producerSha256)await integrationControllerReturned(directory,controllerId,producerSha256);}finally{if(lock?.isTransaction)lock.exec('ROLLBACK');lock?.close();q.close();}}
}
