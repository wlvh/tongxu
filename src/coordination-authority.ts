import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDirectory} from './snapshot.js';
import {readOwnerSource} from './authority-source.js';
import type {QueueStore} from './queue-store.js';
import type {CoordinationExecution} from './coordination-execution-contract.js';
import {messagePlanId,type MessagePlan} from './message-contract.js';
import type {ActionRequest} from './authority-contract.js';

/** A pre-existing Owner delegation is checked, never created or broadened.
 * The trusted scheduler binds each newly prepared message's exact payload. */
export async function authorizeCoordinationMessage(q:QueueStore,d:NonNullable<CoordinationExecution['delegatedCoordination']>,p:MessagePlan,binding:any){
  if(!p.authorityIntent)throw new Error('coordination_exact_intent_required');const a=q.authority();let old:any;
  try{old=a.reservedAction(p.authorityIntent);}catch(e){if(!(e instanceof Error)||e.message!=='authority_original_intent_missing')throw e;}
  let scopeBodySha256:string,observations=[];
  if(old){if(old.adoption!==d.adoption||old.authorization!==d.authorization)throw new Error('coordination_original_delegation_changed');scopeBodySha256=old.request.scopeBodySha256;}
  else{const root=join(q.directory,'coordination-authority-'+randomUUID());await privateDirectory(root,true);const {profile}=a.configuration();for(const [i,source] of a.sourceRequests(d.authorization).entries())observations.push(await readOwnerSource(profile,source.proposalSha256,source.commentId,join(root,String(i))));scopeBodySha256=a.adoptionBaseline(d.adoption,observations).scopeBodySha256;}
  const c=binding.candidate,request:ActionRequest={schemaVersion:1,scopeId:binding.context.scope.id,scopeVersion:binding.context.scope.version,scopeBodySha256,repository:c.repository,target:c.targetRef,action:'coordinate',item:binding.item,candidate:{H:c.H,B:c.B,subjectSha256:binding.subjectSha256??null},paths:[],resourceRefs:(p.resourceBudget??[]).map(r=>r.resourceRef),payloadSha256:messagePlanId(p)};
  return a.reserveAction(p.authorityIntent,request,'coordinator',d.authorization,observations);
}
