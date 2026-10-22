import type {QueueStore} from './queue-store.js';
import type {MessagePlan} from './message-contract.js';
import type {OwnerObservation} from './authority-source.js';
import {resourceAction} from './resource-claims.js';

export async function prepareMessageResources(q:QueueStore,run:string,p:MessagePlan,observations:OwnerObservation[]){
  if(!p.resourceBudget)return;
  q.messages().admission(run,observations);
  const begun=q.begin(p.participants[0]!.item,'messages-resource:'+run);
  if(!begun.operation)throw new Error('message_original_local_operation_unavailable');
  if(begun.status==='running')q.evaluate(begun.operation);
  const binding=q.messageResources().prepare(run,begun.operation,observations);
  for(const id of binding.resourceRequests){let state=await resourceAction(q.directory,id,'lookup',binding.role);if(state.state==='prepared_not_sent')state=await resourceAction(q.directory,id,'claim',binding.role);if(state.state!=='held')throw new Error('message_original_resource_unresolved');}
}
export async function refreshMessageResources(q:QueueStore,run:string,p:MessagePlan){
  if(!p.resourceBudget)return;const binding=q.messageResources().state(run);
  for(const id of binding.resourceRequests)await resourceAction(q.directory,id,'lookup',binding.role);
}
/** Completion reporting is factual cleanup. It grants no new input and can
 * run after revocation; partial/unknown messages keep their original claim. */
export async function completeMessageResources(q:QueueStore,run:string,p:MessagePlan,complete:boolean){
  if(!p.resourceBudget)return [];
  const state=q.messages().status(run),interrupted=!complete&&state.messages.length===1&&state.messages[0]!.state==='Interrupted'&&state.runtimes.filter(r=>r.started).every(r=>r.captureVerification?.proof.successfulCapture===true);
  if(!complete&&!interrupted)return [];
  const binding=interrupted?q.messageResources().closeInterrupted(run):q.messageResources().complete(run),results=[];
  for(const id of binding.resourceRequests){try{const previous=q.resources().status(id);if(previous.pendingResultAttempt&&!['consumed','released'].includes(previous.state))await resourceAction(q.directory,id,'lookup',binding.role);results.push(await resourceAction(q.directory,id,'record-result',binding.role));}catch(e){results.push({id,state:'result_pending_or_unknown',reason:e instanceof Error?e.message:'message_resource_result_unavailable'});}}
  return results;
}
/** Account for an exactly captured prefix before handing the one never-sent
 * final message to another consumer. This never refunds or retries a claim. */
export async function settlePartialMessageResources(q:QueueStore,run:string,nextRun:string,p:MessagePlan){
  if(!p.resourceBudget)return [];
  const binding=q.messageResources().closePartialForContinuation(run,nextRun),results=[];
  for(const id of binding.resourceRequests){const current=await resourceAction(q.directory,id,'lookup',binding.role);
    if(q.resources().settledOutcome(id)){results.push(current);continue;}
    if(!['held','result_pending'].includes(current.state))throw new Error('message_original_partial_resource_state_unresolved');
    results.push(await resourceAction(q.directory,id,'record-result',binding.role));if(!q.resources().settledOutcome(id))throw new Error('message_original_partial_resource_result_unresolved');
  }return results;
}
/** Called under the original message controller, after strict capture replay.
 * Lost provider replies keep the original request for lookup on the next entry. */
export async function cancelUnstartedMessageResources(q:QueueStore,run:string,p:MessagePlan){
  if(!p.resourceBudget)throw new Error('message_fixed_resource_budget_required');
  const b=q.messageResources().cancelUnstarted(run),results=[];
  for(const id of b.resourceRequests){try{const old=await resourceAction(q.directory,id,'lookup',b.role);results.push(q.resources().settledOutcome(id)?old:await resourceAction(q.directory,id,'record-result',b.role));}catch(e){results.push({id,state:'result_pending_or_unknown',reason:e instanceof Error?e.message:'message_resource_result_unavailable'});}}
  return results;
}
export function messageResourcesSettled(q:QueueStore,run:string,p:MessagePlan){
  if(!p.resourceBudget)return true;
  try{const b=q.messageResources().state(run);return ['returned','partial_returned','interrupted_returned','cancelled_unstarted'].includes(b.phase)&&b.resourceRequests.length===p.resourceBudget.length&&b.resourceRequests.every((id:string)=>q.resources().settledOutcome(id));}catch{return false;}
}
