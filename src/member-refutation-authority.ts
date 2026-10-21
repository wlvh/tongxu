import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular} from './repair-workspace.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {scopeBodyHash,actionHash,type ActionRequest} from './authority-contract.js';
import {parseResourceRequest,resourceRequestHash} from './resource-contract.js';
import {prepareResourceRequest} from './resource-claims.js';
import {parseReceiverPlan,type ReceiverPlan} from './receiver.js';
import type {QueueStore} from './queue-store.js';
import type {MemberRefutationPlan} from './member-refutation-contract.js';

async function freeze(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path)).equals(bytes))throw new Error('refutation_receiver_preparation_changed');}}
async function refresh(q:QueueStore,decision:string,directory:string){const a=q.authority(),root=join(directory,'receiver-source-'+randomUUID());await privateDirectory(root,true);const out:OwnerObservation[]=[];for(const [i,ref] of a.sourceRequests(decision).entries())out.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(root,'source-'+i)));return out;}

/** New material gets a new receive action. The fixed template selects tools
 * and inputs; only existing grants and provider profiles supply permissions. */
export async function prepareRefutationReceiver(q:QueueStore,p:MemberRefutationPlan,template:ReceiverPlan,directory:string){
  const g=p.governance!;if(template.governance!==undefined)throw new Error('refutation_receiver_template_must_not_borrow_authority');
  const state=q.memberRefutation(p.id);if(!state.current)throw new Error('member_refutation_source_no_longer_current');const item=q.status().items.find((x:any)=>x.id===state.item);if(!item||item.currentPacket!==state.packet||item.id!==template.item)throw new Error('refutation_receiver_exact_packet_required');
  const a=q.authority(),baseline=a.adoptionBaseline(g.adoption,await refresh(q,g.adoption,directory));
  const request:ActionRequest={schemaVersion:1,scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,scopeBodySha256:scopeBodyHash(baseline.body),repository:item.candidate.repository,target:item.candidate.targetRef,action:'receive',item:item.id,candidate:{H:item.candidate.H,B:item.candidate.B,subjectSha256:item.summary.composition?.sha256??null},paths:[],resourceRefs:g.resourceBudget.map(x=>x.resourceRef)};
  let action:ReturnType<ReturnType<QueueStore['authority']>['reservedAction']>|undefined;
  try{action=a.reservedAction(g.authorityIntent);}catch(e){if(!(e instanceof Error)||e.message!=='authority_original_intent_missing')throw e;}
  if(!action&&g.delegation){const decision=a.inspectRecordedDecision(g.delegation);if(decision.proposal.kind!=='delegate'||decision.proposal.adoption!==g.adoption)throw new Error('refutation_existing_receiver_delegation_required');action=a.reserveAction(g.authorityIntent,request,'receiver',g.delegation,await refresh(q,g.delegation,directory));}
  if(!action){await freeze(join(directory,'receiver-authorization-pending.json'),Buffer.from(canonical({intent:g.authorityIntent,request,item:item.id,packet:item.currentPacket,fingerprint:state.fingerprint,refutationSha256:state.proofSha256,permissionGranted:false,newModelInputs:0})));return {ready:false as const,phase:'refutation_receiver_authority_pending',request,intent:g.authorityIntent};}
  if(action.adoption!==g.adoption||action.role!=='receiver'||action.requestSha256!==actionHash(request)||action.binding?.packet!==state.packet||action.binding?.fingerprint!==state.fingerprint||(action.executionKind==='fixture')!==(template.executionKind==='fixture'))throw new Error('refutation_receiver_exact_authority_required');
  a.refreshReservedAction(g.authorityIntent,await refresh(q,action.authorization,directory));
  const begun=q.begin(item.id,'member-refutation-receiver:'+p.id);if(!begun.operation||begun.blocked)throw new Error('refutation_receiver_queue_occupied');if(begun.status==='running')q.evaluate(begun.operation);
  const requests=g.resourceBudget.map(b=>parseResourceRequest({schemaVersion:1,...b,repository:request.repository,operation:begun.operation,authorityIntent:g.authorityIntent,role:'receiver',actionSha256:action!.requestSha256},q.resources().configuration(b.ledgerId))),resourceRequests=requests.map(resourceRequestHash),derived={...template,governance:{authorityIntent:g.authorityIntent,resourceRequests}},bytes=Buffer.from(canonical(derived));parseReceiverPlan(bytes);
  const record={kind:'tongxu-refutation-receiver-preparation',sourcePlanSha256:hash(canonical(p)),templateSha256:p.receiverPlan.sha256,refutationSha256:state.proofSha256,item:item.id,packet:state.packet,fingerprint:state.fingerprint,operation:begun.operation,authorityIntent:g.authorityIntent,actionSha256:action.requestSha256,resourceRequests,planSha256:hash(bytes),newModelInputs:0};
  await freeze(join(directory,'receiver-preparation.json'),Buffer.from(canonical(record)));
  for(const r of requests)await prepareResourceRequest(q.directory,Buffer.from(canonical(r)),'receiver');
  const path=join(directory,'governed-receiver-plan.json');await freeze(path,bytes);return {ready:true as const,path,bytes,operation:begun.operation,resourceRequests};
}

export async function readRefutationReceiver(p:MemberRefutationPlan,directory:string){
  const path=join(directory,'governed-receiver-plan.json'),bytes=await regular(path),record=JSON.parse((await regular(join(directory,'receiver-preparation.json'))).toString()),plan=parseReceiverPlan(bytes),g=p.governance!;
  if(record.sourcePlanSha256!==hash(canonical(p))||record.templateSha256!==p.receiverPlan.sha256||record.planSha256!==hash(bytes)||plan.governance?.authorityIntent!==g.authorityIntent||canonical(plan.governance?.resourceRequests)!==canonical(record.resourceRequests))throw new Error('refutation_receiver_preparation_changed');return {path,bytes,plan,record};
}
