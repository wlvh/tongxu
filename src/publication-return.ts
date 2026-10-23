import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {regular} from './repair-workspace.js';
import {parsePublicationReturnPlan} from './publication-return-contract.js';
import {parseTaskOwnerRequest,type TaskOwnerRequest} from './task-inbox.js';
import {parsePublicationPlan} from './publication-contract.js';
import {readPublicationDispatchCapture} from './publication-dispatch-capture.js';
import {prepareTaskOwner} from './tasks.js';
import {runMessages} from './messages.js';
import type {MessagePlan} from './message-contract.js';

/** One bounded controller; actual role execution remains the original message,
 * authority and resource path, with no recipient derived from report text. */
export async function publicationReturn(planPath:string,action:'prepare'|'deliver',currentBilling?:MessagePlan['billing']){
  const p=parsePublicationReturnPlan(await regular(planPath,64*1024)),q=await QueueStore.open(p.store);let request:TaskOwnerRequest,receiptSha256:string;
  try{
    const owner=q.taskInbox().originalResponsibility(p.task);await q.refreshTaskLinkSource(p.task);
    // Validate all role fields before saving a receipt; replace the temporary
    // digest only with the exact original capture produced below.
    const input={schemaVersion:1,kind:'tongxu-task-owner-request',id:p.id,task:p.task,source:p.source,question:p.question,from:null,participant:owner.participant,executionKind:owner.executionKind,authorityIntent:p.authorityIntent,...(p.resourceBudget?{resourceBudget:p.resourceBudget}:{}),billing:p.billing,timeoutMs:p.timeoutMs,publicationReturn:{operation:p.operation,receiptSha256:'0'.repeat(64),taskLink:p.taskLink}};
    parseTaskOwnerRequest(Buffer.from(canonical(input)));
    const state=q.publicationState(p.operation),publicationPlan=parsePublicationPlan(Buffer.from(canonical(state.plan))),captures=[];
    for(const original of q.publicationReturnDispatches(p.operation))captures.push(await readPublicationDispatchCapture(publicationPlan,original.prepared,original.request,original.registered));
    receiptSha256=q.publicationReturns().record(p.operation,captures).receiptSha256;
    request=parseTaskOwnerRequest(Buffer.from(canonical({...input,publicationReturn:{...input.publicationReturn,receiptSha256}})));q.taskInbox().enqueue(Buffer.from(canonical(request)));
  }finally{q.close();}
  let selected;
  try{selected=await prepareTaskOwner(p.store,p.task,p.id);}catch(error){return {operation:p.operation,task:p.task,id:p.id,receiptSha256,formalPublicationVerified:true,contact:'waiting',reason:error instanceof Error?error.message:'original_task_waiting',newModelRequests:0,nativeSessionResumed:false,workerEnded:true};}
  if(action==='prepare'){
    const observed=await QueueStore.open(p.store);try{let original;try{original=observed.messages().status(selected.run);}catch(e){if((e as Error).message!=='original_message_run_required')throw e;}
      const message=original?.messages.find(m=>m.id===p.id);return {...selected,operation:p.operation,task:p.task,receiptSha256,formalPublicationVerified:true,contact:original?'prepared_original_run_exists':'prepared_not_sent',inputRegistered:Boolean(message?.sent),inputSubmitted:message?.delivery?true:message?.sent?null:false,deliveryObserved:Boolean(message?.delivery),newModelRequests:0,nativeSessionResumed:false,workerEnded:true};
    }finally{observed.close();}
  }
  const result=await runMessages(p.store,selected.plan,false,selected.run,currentBilling),after=await QueueStore.open(p.store);
  try{
    const state=after.messages().status(selected.run),message=state.messages.find(m=>m.id===p.id),report=message?.reply,route=state.runtimes.find(r=>r.participant===request.participant.id)?.route;
    return {operation:p.operation,task:p.task,id:p.id,run:selected.run,receiptSha256,formalPublicationVerified:true,contact:message?.state??'pending',inputRegistered:Boolean(message?.sent),inputSubmitted:message?.delivery?true:message?.sent?null:false,deliveryObserved:Boolean(message?.delivery),completeMaterialConsumptionReported:report?.reportedConsumption===true,replyReturned:message?.state==='Reply',runtimeCaptureComplete:state.runtimes.find(r=>r.participant===request.participant.id)?.captureVerification?.proof.successfulCapture===true,fullReply:report?.finalText??null,resourcesSettled:result.resourcesSettled,completed:result.completed,newModelRequests:result.newModelRequests,currentMaterial:after.taskInbox().associationStatus(selected.run)?.current===true,originalOwner:request.participant.id,sessionId:route?.sessionId??null,nativeSessionResumed:false,workerEnded:true,writePermissionGranted:false};
  }finally{after.close();}
}
