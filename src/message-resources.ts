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
  if(!p.resourceBudget||!complete)return [];
  const binding=q.messageResources().complete(run),results=[];
  for(const id of binding.resourceRequests){try{const previous=q.resources().status(id);if(previous.pendingResultAttempt&&!['consumed','released'].includes(previous.state))await resourceAction(q.directory,id,'lookup',binding.role);results.push(await resourceAction(q.directory,id,'record-result',binding.role));}catch(e){results.push({id,state:'result_pending_or_unknown',reason:e instanceof Error?e.message:'message_resource_result_unavailable'});}}
  return results;
}
export function messageResourcesSettled(q:QueueStore,run:string,p:MessagePlan){
  if(!p.resourceBudget)return true;
  try{const b=q.messageResources().state(run);return b.phase==='returned'&&b.resourceRequests.length===p.resourceBudget.length&&b.resourceRequests.every((id:string)=>q.resources().settledOutcome(id));}catch{return false;}
}
