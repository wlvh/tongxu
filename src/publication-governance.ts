import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDirectory} from './snapshot.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {resourceAction} from './resource-claims.js';
import {readPublicationDispatchCapture} from './publication-dispatch-capture.js';
import type {PublicationPlan} from './publication-contract.js';
import type {QueueStore} from './queue-store.js';

export function publicationGovernance(q:QueueStore,p:PublicationPlan){
  let observations:OwnerObservation[]=[];
  return {
    get observations(){return observations;},
    async beforeWrite(){
      if(!p.governance)return;
      const a=q.authority(),reserved=a.reservedAction(p.governance.authorityIntent),profile=a.configuration().profile;
      if(reserved.role!=='background'||reserved.request.action!=='publish')throw new Error('publication_authority_role_mismatch');
      const refresh=async()=>{const root=join(q.directory,'publication-authority-'+randomUUID());await privateDirectory(root,true);observations=[];for(const [i,ref] of a.sourceRequests(reserved.authorization).entries())observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,'source-'+i)));};
      await refresh();
      q.publicationResourceAdmission(p.operation,observations);
      for(const id of p.governance.resourceRequests){let state=await resourceAction(q.directory,id,'lookup','background');if(state.state==='prepared_not_sent')state=await resourceAction(q.directory,id,'claim','background');if(state.state!=='held')throw new Error('publication_original_resource_unresolved');}
      // A claim refreshes Owner observations itself. The actual POST must use
      // observations newer than that claim, not replay the earlier binding read.
      await refresh();
    },
    async recover(){
      if(!p.governance)return;
      for(const original of q.publicationDispatchMaterial(p.operation))q.publicationRecoverDispatch(p.operation,await readPublicationDispatchCapture(p,original.prepared,original.request));
    },
    async settle(){
      if(!p.governance)return [];
      const state=q.publicationState(p.operation);if(!['comment','status'].every(stage=>state.stages[stage].lastState==='verified'))return [];
      const captures=[];for(const original of q.publicationOriginalDispatches(p.operation))captures.push(await readPublicationDispatchCapture(p,original.prepared,original.request,original.registered));q.publicationRecordResult(p.operation,captures);
      const result=[];for(const id of p.governance.resourceRequests)try{const old=q.resources().status(id);if(old.pendingResultAttempt&&!['consumed','released'].includes(old.state))await resourceAction(q.directory,id,'lookup','background');result.push(await resourceAction(q.directory,id,'record-result','background'));}catch(e){result.push({id,state:'result_pending_or_unknown',reason:e instanceof Error?e.message:'publication_resource_result_unavailable'});}return result;
    }
  };
}
