import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {regular,exists} from './repair-workspace.js';
import {parseMemberRefutationPlan} from './member-refutation-contract.js';
import {parseQueueRepairPlan,runQueueRepair} from './queue-repair.js';
import {parseReceiverPlan,runReception,reconcileReception} from './receiver.js';
import {QueueStore} from './queue-store.js';

async function freeze(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,4*1024*1024)).equals(bytes))throw new Error('member_refutation_frozen_input_changed');}}
/** Consume an ended refutation, then use the original receiver. Nothing in a
 * model report can select its program, permissions, candidate or next input. */
export async function runMemberRefutation(path:string,action:'prepare'|'run'='run'){
  const raw=await regular(path,32768),p=parseMemberRefutationPlan(raw),id=hash(canonical({memberReturn:p.memberReturn,repairPlan:p.repairPlan.sha256})),directory=join(p.store,'member-refutation-'+id),q=await QueueStore.open(p.store);let lock:DatabaseSync|undefined;
  try{
    await privateDirectory(directory,!await exists(directory));await freeze(join(directory,'request.json'),raw);
    const lockPath=join(directory,'controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await regular(lockPath);lock=new DatabaseSync(lockPath);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('member_refutation_controller_active');}
    for(const [name,ref] of [['repair-plan.json',p.repairPlan],['receiver-plan.json',p.receiverPlan]] as const){const fixed=join(directory,name);if(!await exists(fixed)){const bytes=await regular(ref.path);if(hash(bytes)!==ref.sha256)throw new Error('member_refutation_input_changed');await freeze(fixed,bytes);}if(hash(await regular(fixed))!==ref.sha256)throw new Error('member_refutation_input_changed');}
    const repairPath=join(directory,'repair-plan.json'),repairPlan=parseQueueRepairPlan(await regular(repairPath)),receiverPath=join(directory,'receiver-plan.json'),receiverBytes=await regular(receiverPath),receiverPlan=parseReceiverPlan(receiverBytes);
    if(repairPlan.store!==p.store||receiverPlan.store!==p.store||canonical(repairPlan.memberReturn)!==canonical(p.memberReturn))throw new Error('member_refutation_store_or_source_changed');
    let repair=q.reviewRecords().state(repairPlan.operation).repair;
    if(repair.phase!=='returned'||repair.result?.status!=='skipped_refuted'||repair.result.actualRepairPerformed!==false)throw new Error('member_refutation_ended_refutation_required');
    // This revalidates the real terminal/capture, with no new repair invocation.
    await runQueueRepair(repairPath);repair=q.reviewRecords().state(repairPlan.operation).repair;
    const original=q.integrationMemberReturns().material(p.memberReturn.id);
    if(receiverPlan.item!==q.receiverState(original.request.reception.operation).result.item)throw new Error('member_refutation_original_parent_plan_required');
    if(receiverPlan.executionKind!==original.proof.parent.executionKind)throw new Error('member_refutation_execution_kind_changed');
    const request=Buffer.from(canonical({schemaVersion:1,kind:'tongxu-member-refutation',id:p.id,memberReturn:p.memberReturn,repair:{operation:repairPlan.operation,planSha256:p.repairPlan.sha256,bindingHash:repair.bindingHash,resultSha256:repair.resultSha256,evidenceSha256:repair.evidenceSha256},source:p.source}));
    await freeze(join(directory,'association.json'),request);const attached=q.attachMemberRefutation(request),state=q.memberRefutation(p.id);
    if(action==='prepare')return {id:p.id,directory,item:attached.item,packet:attached.packet,proofSha256:attached.proofSha256,phase:state.reception?.phase??'prepared_not_sent',originalReception:state.reception,newModelInputs:0,priorAcceptanceTransferred:false};
    let reception:any;
    if(state.reception?.phase){if(state.reception.planSha256!==hash(receiverBytes))throw new Error('member_refutation_original_receiver_plan_changed');reception=await reconcileReception(p.store,state.reception.operation);}
    else{if(!state.current)throw new Error('member_refutation_source_no_longer_current');reception=await runReception(receiverPath);}
    const after=q.memberRefutation(p.id);
    return {id:p.id,directory,item:attached.item,packet:attached.packet,proofSha256:attached.proofSha256,memberUnchanged:true,actualRepairPerformed:false,originalReturnPreserved:true,priorAcceptanceTransferred:false,individualMemberAccepted:false,current:after.current,reception,manualReportCopyRequired:false,manualRepairRequired:false,productionActionAllowed:false};
  }finally{if(lock?.isTransaction)lock.exec('ROLLBACK');lock?.close();q.close();}
}
