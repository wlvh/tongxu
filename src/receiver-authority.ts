import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDirectory} from './snapshot.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {resourceAction} from './resource-claims.js';
import type {AuthorityRole} from './authority-contract.js';
import type {QueueStore} from './queue-store.js';
import type {ReceiverPlan} from './receiver.js';

/** Refresh only the already selected Owner decision and original claims.
 * This never creates an authorization or chooses another billing route. */
export function receiverGovernance(q:QueueStore,p:ReceiverPlan){
  let observations:OwnerObservation[]=[],role:AuthorityRole='receiver';
  return {
    get observations(){return observations;},
    async refresh(resources=true){
      observations=[];if(!p.governance)return;
      const a=q.authority(),reserved=a.reservedAction(p.governance.authorityIntent),profile=a.configuration().profile;role=reserved.role;
      if(!['receiver','background'].includes(role))throw new Error('receiver_authority_role_mismatch');
      const root=join(q.directory,'receiver-authority-'+randomUUID());await privateDirectory(root,true);
      for(const [i,ref] of a.sourceRequests(reserved.authorization).entries())observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,'source-'+i)));
      if(resources)for(const id of p.governance.resourceRequests)await resourceAction(q.directory,id,'lookup',role);
    },
    async claim(operation:string,bytes:Buffer){
      if(!p.governance)return;
      q.receiverResourceAdmission(operation,bytes,observations);
      for(const id of p.governance.resourceRequests){let state=await resourceAction(q.directory,id,'lookup',role);if(state.state==='prepared_not_sent')state=await resourceAction(q.directory,id,'claim',role);if(state.state!=='held')throw new Error('receiver_original_resource_unresolved');}
    }
  };
}

/** Factual cleanup is permitted after a completed original even if the grant
 * has since expired/revoked. Unknown output keeps the original claim held. */
export async function settleReceiverResources(q:QueueStore,operation:string,p:ReceiverPlan){
  if(!p.governance)return [];
  const r=q.receiverState(operation).receiver;
  if(!r?.controllerReturned||r.phase!=='returned'&&!r.invalidResult)return [];
  const role=q.authority().reservedAction(p.governance.authorityIntent).role as AuthorityRole,results=[];
  for(const id of p.governance.resourceRequests){try{const old=q.resources().status(id);if(old.pendingResultAttempt&&!['consumed','released'].includes(old.state))await resourceAction(q.directory,id,'lookup',role);results.push(await resourceAction(q.directory,id,'record-result',role));}
    catch(e){results.push({id,state:'result_pending_or_unknown',reason:e instanceof Error?e.message:'receiver_resource_result_unavailable',newExecutionAllowed:false});}
  }return results;
}
