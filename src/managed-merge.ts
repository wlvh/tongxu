import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from './queue-store.js';
import { privateDirectory } from './snapshot.js';
import { regular } from './repair-workspace.js';
import { readOwnerSource,type OwnerObservation } from './authority-source.js';
import { resourceAction } from './resource-claims.js';
import { callMergeProvider,readMergeProviderCapture,mergeCommand } from './merge-provider.js';
import { inspectMergePreflight } from './merge-preflight.js';
import { inspectMergeReadback } from './merge-readback.js';
import { inspectMergeController } from './merge-recovery.js';
import { inspectActualMergeValidation } from './merge-validation.js';
import { parseMergeBinding } from './merge-contract.js';

async function ownerSources(q:QueueStore,intent:string,directory:string){
  const a=q.authority(),record=a.reservedAction(intent),profile=a.configuration().profile,values:OwnerObservation[]=[];
  for(const ref of a.sourceRequests(record.authorization))values.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(directory,'owner-'+randomUUID())));
  return values;
}
async function locked<T>(store:string,operation:string,run:(directory:string)=>Promise<T>){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation))throw new Error('managed_merge_operation_invalid');
  const directory=join(store,'managed-merge-'+operation);try{await mkdir(directory,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}await privateDirectory(directory,false);
  const path=join(directory,'controller.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(path,4*1024*1024);
  const db=new DatabaseSync(path);try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}catch{db.close();throw new Error('managed_merge_controller_active');}
  try{return await run(directory);}finally{db.exec('ROLLBACK');db.close();}
}
export async function prepareManagedMerge(store:string,raw:Buffer){
  // Freeze the complete plan before the first source read. Reentry reads the
  // saved operation even when a source or credential is now unavailable.
  const q=await QueueStore.open(store),plan=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  try{
    parseMergeBinding(plan.binding);
    try{q.merges().status(plan.binding?.operation);return q.merges().prepare(raw,[]);}catch(e){if(!(e instanceof Error)||e.message!=='original_managed_merge_required')throw e;}
    return await locked(store,plan.binding.operation,async directory=>q.merges().prepare(raw,await ownerSources(q,plan.binding.authorityIntent,directory)));
  }finally{q.close();}
}
export async function managedMergeAction(store:string,operation:string,action:'run'|'retry-refused'|'reconcile'|'recover-controller'|'cancel-unstarted'){
  const q=await QueueStore.open(store);
  try{return await locked(store,operation,async directory=>{
    const m=q.merges(),p=m.configuration();let state=m.status(operation),newMergeCall=false;
    if(action==='cancel-unstarted'){
      state=m.cancelUnstarted(operation);const resourceResults=[];
      for(const id of state.binding.resourceRequests)if(q.resources().status(id).state==='held')try{resourceResults.push(await resourceAction(store,id,'record-result','background'));}catch(e){resourceResults.push({id,state:'original_result_pending',reason:e instanceof Error?e.message:'resource_result_unavailable'});}
      return {...state,newMergeCall:false,resourceResults};
    }
    if(action==='run'&&state.merge.phase!=='resources_pending')return {...state,duplicate:true,newMergeCall:false,next:state.status==='complete'?'read_original_result':'reconcile_original_merge'};
    if(action==='recover-controller'){
      state=m.recoverController(operation,await inspectMergeController(m.originalDispatch(operation)));
      if(state.merge.phase==='resources_pending')return {...state,newMergeCall:false,next:'run_original_prepared_merge'};
    }
    if(action==='run'||action==='retry-refused'){
      if(action==='retry-refused'&&state.merge.phase!=='refused')throw new Error('explicit_definitive_merge_refusal_required');
      for(const id of state.binding.resourceRequests){
        let resource=q.resources().status(id);
        resource=resource.state==='prepared_not_sent'?await resourceAction(store,id,'claim','background'):await resourceAction(store,id,'lookup','background');
        if(resource.state!=='held')return {...m.status(operation),newMergeCall:false,waitingForResource:id,resourceState:resource.state};
      }
      const preflight=await inspectMergePreflight(p,state.binding,join(directory,'preflight-'+randomUUID()));m.preflightObserved(operation,preflight);
      if(!preflight.result.ready)return {...m.status(operation),newMergeCall:false,preflight:preflight.result};
      const observations=await ownerSources(q,state.binding.authorityIntent,directory),capture=join(directory,'send-'+randomUUID());let registered=false;
      try{
        const reply=await callMergeProvider(p,mergeCommand(state.binding,'merge'),capture,dir=>{m.dispatch(operation,preflight,observations,dir,action==='retry-refused');registered=true;newMergeCall=true;});
        m.controllerReturned(operation,capture);m.response(operation,reply);
      }catch(e){m.problem(operation,e instanceof Error?e.message:'merge_request_unknown');throw e;}
      finally{if(registered)m.controllerReturned(operation,capture);}
    }
    state=m.status(operation);
    if(!state.merge.attempts.length)return {...state,newMergeCall:false,next:'run_original_prepared_merge'};
    if(!state.merge.controllerReturned){
      try{m.recoverController(operation,await inspectMergeController(m.originalDispatch(operation)));}catch(e){m.problem(operation,e instanceof Error?e.message:'merge_controller_unknown');}
      state=m.status(operation);
    }
    // Late complete stdout is correlated with the original capture, not sent again.
    if(state.merge.controllerReturned&&!state.merge.response&&state.merge.phase!=='resources_pending'){
      try{m.response(operation,await readMergeProviderCapture(p,mergeCommand(state.binding,'merge'),m.originalDispatch(operation).directory));}catch(e){m.problem(operation,e instanceof Error?e.message:'merge_response_still_unknown');}
      state=m.status(operation);
    }
    const response=state.merge.response&&{status:state.merge.response.status,body:Buffer.from(state.merge.response.body)};
    const readback=await inspectMergeReadback(p,state.binding,join(directory,'readback-'+randomUUID()),response);state=m.observe(operation,readback);
    const resourceResults=[];
    // A definitive rejection may be explicitly retried inside the original
    // held allocation. Recording its failed outcome explicitly closes that
    // resource path; no replacement claim or assumed refund is created.
    if(state.status==='complete'&&state.merge.phase!=='refused')for(const id of state.binding.resourceRequests){
      try{resourceResults.push(await resourceAction(store,id,'record-result','background'));}catch(e){resourceResults.push({id,state:'original_result_pending',reason:e instanceof Error?e.message:'resource_result_unavailable'});}
    }
    return {...state,newMergeCall,resourceResults};
  });}finally{q.close();}
}
export async function validateManagedMerge(store:string,operation:string,validationStore:string,validationOperation:string){
  const q=await QueueStore.open(store);try{return await locked(store,operation,async()=>{
    const m=q.merges(),completed=m.completedValidation(operation,validationStore,validationOperation);if(completed)return completed;
    const references=m.validationReferences(operation);let missing:unknown;
    for(const reference of references){
      try{const proof=await inspectActualMergeValidation(validationStore,validationOperation,reference,m.configuration().executionKind);return m.completeValidation(operation,proof);}
      catch(e){if(!(e instanceof Error)||e.message!=='actual_version_original_readback_not_consumed')throw e;missing=e;}
    }
    throw missing??new Error('actual_version_original_readback_not_consumed');
  });}finally{q.close();}
}
