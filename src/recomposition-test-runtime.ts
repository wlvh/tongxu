import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {resourceAction} from './resource-claims.js';
import {scopeBodyHash,type ActionRequest} from './authority-contract.js';
import {readRecompositionTestCapture} from './recomposition-test-capture.js';
import type {QueueStore} from './queue-store.js';
import type {MemberRecompositionPlan} from './member-recomposition-contract.js';

async function observations(q:QueueStore,authorization:string,directory:string){
  const a=q.authority(),root=join(directory,'owner-check-'+randomUUID());await privateDirectory(root,true);const result:OwnerObservation[]=[];
  for(const [i,ref] of a.sourceRequests(authorization).entries())result.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(root,'source-'+i)));return result;
}
function freezeSync(path:string,bytes:Buffer){try{writeFileSync(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!readFileSync(path).equals(bytes))throw new Error('recomposition_test_producer_changed');}}

/** Uses the existing queue, permission and provider records. It never creates
 * a grant, refunds a resource, or guesses whether an interrupted test ran. */
export function recompositionTestRuntime(q:QueueStore,p:MemberRecompositionPlan,directory:string){
  const g=p.governance!,records=q.recompositionTests();let fresh:OwnerObservation[]=[];
  const state=()=>{try{return records.state(p.id);}catch(e){if(!(e instanceof Error)||e.message!=='recomposition_test_not_prepared')throw e;return undefined;}};
  const refresh=async()=>{const a=q.authority().reservedAction(g.testAuthorityIntent);fresh=await observations(q,a.authorization,directory);for(const id of g.testResourceRequests)await resourceAction(q.directory,id,'lookup','background');};
  return {
    state,
    async prepare(raw:Buffer,manifest:Buffer,testPlan:Buffer){
      if(state()?.phase==='recorded')return;
      await refresh();records.prepare(raw,manifest,testPlan,fresh);
      for(const id of g.testResourceRequests){let claim=q.resources().status(id);if(claim.state==='prepared_not_sent')claim=await resourceAction(q.directory,id,'claim','background');if(claim.state!=='held')throw new Error('recomposition_test_original_resource_unresolved');}
      await refresh();records.check(p.id,fresh);
    },
    async refresh(){await refresh();records.check(p.id,fresh);},
    check(){return records.check(p.id,fresh);},
    effect<T>(effect:()=>T){return records.effect(p.id,fresh,effect);},
    registered(run:string,planSha256:string,inputManifests:string[]){const binding=records.registerRun(p.id,run,planSha256,inputManifests,fresh);freezeSync(join(directory,'test-producer.json'),Buffer.from(canonical({kind:'tongxu-managed-recomposition-test',executionMethod:'existing-w2-verifier',newModelInputs:0,binding})));},
    async complete(){const s=records.state(p.id);if(!s.binding)throw new Error('recomposition_test_original_run_required');const c=await readRecompositionTestCapture(directory,s.binding);records.complete(p.id,c);return c.packet;},
    async settle(){
      if(state()?.phase!=='recorded')throw new Error('recomposition_test_original_execution_unknown');const results=[];
      for(const id of g.testResourceRequests){try{const old=q.resources().status(id);if(old.pendingResultAttempt&&!['consumed','released'].includes(old.state))await resourceAction(q.directory,id,'lookup','background');results.push(await resourceAction(q.directory,id,'record-result','background'));}catch(e){results.push({id,state:'result_pending_or_unknown',reason:e instanceof Error?e.message:'resource_result_unavailable'});}}
      return {settled:g.testResourceRequests.every(id=>q.resources().settledOutcome(id)),results};
    }
  };
}

/** The new composition has a different subject. A separate reserved action
 * or an already existing delegation must authorize its private integration. */
export async function reserveRecompositionIntegration(q:QueueStore,p:MemberRecompositionPlan,link:any,directory:string){
  const g=p.governance;if(!g)return {ready:true};const a=q.authority();
  try{a.reservedAction(g.integrationAuthorityIntent);return {ready:true};}catch(e){if(!(e instanceof Error)||e.message!=='authority_original_intent_missing')throw e;}
  const item=q.status().items.find((x:any)=>x.id===link.composition.item);if(!item)throw new Error('recomposition_integration_item_missing');
  const test=a.reservedAction(g.testAuthorityIntent);let bodySha256=test.request.scopeBodySha256;
  let fresh:OwnerObservation[]=[];
  if(g.integrationDelegation){const decision=a.inspectRecordedDecision(g.integrationDelegation.authorization);if(decision.proposal.kind!=='delegate'||decision.proposal.adoption!==g.integrationDelegation.adoption)throw new Error('recomposition_existing_integration_delegation_required');fresh=await observations(q,g.integrationDelegation.authorization,directory);const baseline=a.adoptionBaseline(g.integrationDelegation.adoption,fresh);bodySha256=scopeBodyHash(baseline.body);}
  const request:ActionRequest={schemaVersion:1,scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,scopeBodySha256:bodySha256,repository:item.candidate.repository,target:item.candidate.targetRef,action:'test',item:item.id,candidate:{H:item.candidate.H,B:item.candidate.B,subjectSha256:link.composition.subjectSha256},paths:[],resourceRefs:[]};
  if(!g.integrationDelegation){freezeSync(join(directory,'integration-authorization-pending.json'),Buffer.from(canonical({intent:g.integrationAuthorityIntent,request,newModelInputs:0,permissionGranted:false})));return {ready:false,intent:g.integrationAuthorityIntent,request};}
  const action=a.reserveAction(g.integrationAuthorityIntent,request,'background',g.integrationDelegation.authorization,fresh);
  if(action.mode!=='delegated'||action.adoption!==g.integrationDelegation.adoption)throw new Error('recomposition_existing_integration_delegation_required');return {ready:true};
}
