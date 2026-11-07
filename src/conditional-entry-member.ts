import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular} from './repair-workspace.js';
import {loadBundle} from './verification.js';
import type {ConditionalEntryPlan,ConditionalRef,ConditionalBudgetAuthorization} from './conditional-entry-contract.js';
import type {CoordinationPlan} from './coordination-contract.js';
import type {ConditionalMemberCollection} from './conditional-entry-source.js';
import {candidateValidationPayload,type MemberCandidateValidationPlan} from './candidate-validation-contract.js';
import {scopeBodyHash,type ActionRequest} from './authority-contract.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';
import {readOwnerSource} from './authority-source.js';
import {parseMemberRecompositionPlan,type MemberRecompositionPlan} from './member-recomposition-contract.js';
import {recompositionTestPayloadSha} from './recomposition-test-contract.js';
import {parseCandidateValidation} from './candidate-validation-contract.js';
import {readCandidateValidationCapture} from './candidate-validation-capture.js';

type Row=Record<string,any>;
async function fixed(path:string,b:Buffer){try{await writeFile(path,b,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}if(!(await regular(path,2*1024*1024)).equals(b))throw new Error('conditional_entry_member_original_changed');}
async function reference(r:ConditionalRef){const b=await regular(r.path,2*1024*1024);if(hash(b)!==r.sha256)throw new Error('conditional_entry_member_capability_changed');return b;}
const capability=(entry:ConditionalEntryPlan,task:string)=>{const cap=entry.repairs?.find(r=>r.task===task);if(!cap?.postRepair)throw new Error('conditional_entry_member_verification_not_configured');return cap;};

export function memberCollectionInput(q:QueueStore,entry:ConditionalEntryPlan,id:string,root:string,task:string){
 capability(entry,task);const source=q.conditionalRepairedMember(id,entry.id,task,false),key='member-collection-'+task,previous=q.coordination().normalEntryHistory(id,entry.id,key);
 const collection:ConditionalMemberCollection={schemaVersion:1,kind:'tongxu-conditional-member-collection',task,repair:source.repair,snapshot:join(root,'member-source-'+hash(canonical(source.repair)).slice(0,48)),objects:source.objects,candidate:source.candidate,context:source.context};
 if(previous&&!previous.request.equals(Buffer.from(canonical(collection))))throw new Error('conditional_entry_original_member_collection_required');return {key,collection};
}

/** Only background/test actions for these two fixed consumers. The permission
 * names the original source while its payload binds the actual new head. */
async function testAction(q:QueueStore,entry:ConditionalEntryPlan,plan:CoordinationPlan,root:string,source:Row,authorization:ConditionalBudgetAuthorization|null,intent:string,payloadSha256:string){
 const owner=await QueueStore.observeOrganization(entry.store,plan.name,plan.tasks.map(t=>t.item));
 if(!owner.ownerSourceConfigured){if(authorization)throw new Error('conditional_entry_owner_profile_required');return [] as ResourceRequest[];}
 if(!authorization)throw new Error('conditional_entry_member_test_authority_required');
 const a=q.authority(),decision=a.inspectRecordedDecision(authorization.authorization);if(decision.proposal.kind!=='delegate'||decision.proposal.adoption!==authorization.adoption)throw new Error('conditional_entry_existing_test_delegation_required');
 const directory=join(root,'owner-member-test-'+randomUUID());await privateDirectory(directory,true);const observations=[];for(const [i,r] of a.sourceRequests(authorization.authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,r.proposalSha256,r.commentId,join(directory,String(i))));
 const baseline=a.adoptionBaseline(authorization.adoption,observations),c=source.candidate,action:ActionRequest={schemaVersion:1,scopeId:source.context.scope.id,scopeVersion:source.context.scope.version,scopeBodySha256:scopeBodyHash(baseline.body),repository:c.repository,target:c.targetRef,action:'test',item:source.item,candidate:{H:c.H,B:c.B,subjectSha256:null},paths:[],resourceRefs:authorization.budgets.map(b=>b.resourceRef),payloadSha256,...(source.candidateSource?{candidateSource:source.candidateSource}:{})};
 const reserved=a.reserveAction(intent,action,'background',authorization.authorization,observations);if(reserved.mode!=='delegated')throw new Error('conditional_entry_existing_test_delegation_required');return authorization.budgets.map(b=>({schemaVersion:1 as const,...b,repository:c.repository,operation:source.operation,authorityIntent:intent,role:'background' as const,actionSha256:reserved.requestSha256}));
}

export async function memberValidationInput(q:QueueStore,entry:ConditionalEntryPlan,plan:CoordinationPlan,id:string,root:string,task:string){
 const cap=capability(entry,task),key='member-validation-'+task,previous=q.coordination().normalEntryHistory(id,entry.id,key);
 if(previous){const p=parseCandidateValidation(previous.request);if(p.kind!=='tongxu-member-candidate-validation'||p.collection.task!==task)throw new Error('conditional_entry_original_member_validation_required');const path=join(root,'member-validation-'+previous.requestSha256+'.json');await fixed(path,previous.request);return {path,p,resources:(previous.reference.resources??[]) as ResourceRequest[]};}
 const source=q.conditionalRepairedMember(id,entry.id,task,false),collectionKey='member-collection-'+task,step=q.coordination().normalEntryHistory(id,entry.id,collectionKey);
 if(step?.reference.kind!=='member-snapshot')throw new Error('conditional_entry_member_collection_required');const collection=JSON.parse(step.request.toString()) as ConditionalMemberCollection;
 if(canonical(collection.repair)!==canonical(source.repair))throw new Error('conditional_entry_original_member_collection_required');
 const bundle=await loadBundle(collection.snapshot),candidateSource=q.registerMemberCandidateSource(id,entry.id,task,collection,bundle.bytes),subject=q.memberCandidateSource(candidateSource),testPlan=cap.postRepair!.testPlan;await reference(testPlan);const validationId='member-'+hash(canonical([entry.id,task,collection,hash(bundle.bytes),testPlan])).slice(0,48),auth=cap.postRepair!.validationAuthorization;
 const p:MemberCandidateValidationPlan={schemaVersion:1,kind:'tongxu-member-candidate-validation',id:validationId,store:entry.store,entry:entry.id,originPlan:id,collectionKey,collection,candidateSource,manifestSha256:hash(bundle.bytes),testPlan,directory:join(entry.store,'candidate-validation-'+validationId),governance:auth?{authorityIntent:'m-test-'+hash(validationId).slice(0,48),resourceRequests:[]}:null};
 const resources=await testAction(q,entry,plan,root,{...subject,operation:source.repair.operation},auth,p.governance?.authorityIntent??'unconfigured',candidateValidationPayload(p));if(p.governance)p.governance.resourceRequests=resources.map(resourceRequestHash);
 const raw=Buffer.from(canonical(p));parseCandidateValidation(raw);const saved=q.coordination().normalEntryStep(id,entry.id,key,raw,{kind:'validation',id:p.id,task,source:'member-repair',operation:source.repair.operation,resources}),path=join(root,'member-validation-'+saved.requestSha256+'.json');await fixed(path,raw);return {path,p,resources};
}

export async function memberRecompositionInput(q:QueueStore,entry:ConditionalEntryPlan,plan:CoordinationPlan,id:string,root:string,task:string){
 const cap=capability(entry,task),key='member-recomposition-'+task,previous=q.coordination().normalEntryHistory(id,entry.id,key);
 if(previous){const p=parseMemberRecompositionPlan(previous.request),path=join(root,'member-recomposition-'+previous.requestSha256+'.json');await fixed(path,previous.request);return {path,plan:p,resources:(previous.reference.resources??[]) as ResourceRequest[]};}
 const source=q.conditionalRepairedMember(id,entry.id,task,false);if(!source.memberReturn)throw new Error('conditional_entry_original_member_return_required');
 const validation=q.coordination().normalEntryHistory(id,entry.id,'member-validation-'+task);if(validation?.reference.source!=='member-repair')throw new Error('conditional_entry_own_member_validation_required');const v=parseCandidateValidation(validation.request);if(v.kind!=='tongxu-member-candidate-validation')throw new Error('conditional_entry_own_member_validation_required');
 const state=q.candidateValidations().state(v.id);if(state.phase!=='recorded'||!state.captureValidationCurrent||!state.resourcesSettled||!state.binding)throw new Error('conditional_entry_terminal_member_validation_required');
 const capture=await readCandidateValidationCapture(v,state.binding,q.candidateValidations().executions(v.id));
 if(capture.packet.summary.tree!==source.candidate.T||capture.packet.summary.gaps.some(g=>g!=='sample_failure_or_incomplete_comparison'))throw new Error('conditional_entry_complete_member_validation_required');
 const repairPath=join(root,'repair-'+source.step.requestSha256+'.json');await fixed(repairPath,source.step.request);await reference(entry.integration.testPlan);
 const recompositionId='entry-member-'+hash(canonical([entry.id,task,source.repair,v.manifestSha256,entry.integration.testPlan])).slice(0,48),auth=cap.postRepair!.recompositionAuthorization;
 const p:MemberRecompositionPlan={schemaVersion:1,kind:'tongxu-member-recomposition',id:recompositionId,store:entry.store,memberReturn:source.memberReturn,repairPlan:{path:repairPath,sha256:source.step.requestSha256},newMember:{path:v.collection.snapshot,sha256:v.manifestSha256},testPlan:entry.integration.testPlan,source:'Original controlled repair, accurately observed new member and its own registered verification from configured normal entry '+entry.id,...(v.candidateSource?{memberValidation:{id:v.id,requestSha256:hash(validation.request)}}:{}),...(auth?{governance:{testAuthorityIntent:'m-recompose-'+hash(recompositionId).slice(0,48),testResourceRequests:[],integrationAuthorityIntent:'m-integrate-'+hash(recompositionId).slice(0,48),...(entry.integration.authorization?{integrationDelegation:entry.integration.authorization}:{})}}:{})};
 const resources=await testAction(q,entry,plan,root,v.candidateSource?{...q.memberCandidateSource(v.candidateSource),operation:source.repair.operation}:source.original,auth,p.governance?.testAuthorityIntent??'unconfigured',recompositionTestPayloadSha(p));if(p.governance)p.governance.testResourceRequests=resources.map(resourceRequestHash);
 const raw=Buffer.from(canonical(p));parseMemberRecompositionPlan(raw);const saved=q.coordination().normalEntryStep(id,entry.id,key,raw,{kind:'member-recomposition',id:p.id,task,operation:source.repair.operation,validation:v.id,resources}),path=join(root,'member-recomposition-'+saved.requestSha256+'.json');await fixed(path,raw);return {path,plan:p,resources};
}

export async function importRecomposedMember(q:QueueStore,entry:ConditionalEntryPlan,id:string,task:string){
 const records=q.coordination(),v=records.normalEntryHistory(id,entry.id,'member-validation-'+task),r=records.normalEntryHistory(id,entry.id,'member-recomposition-'+task);if(!v||!r)throw new Error('conditional_entry_original_member_recomposition_required');const p=parseCandidateValidation(v.request),recomposition=parseMemberRecompositionPlan(r.request);
 if(p.kind!=='tongxu-member-candidate-validation')throw new Error('conditional_entry_own_member_validation_required');const link=q.memberRecompositions().state(recomposition.id),integration=q.integrations().state(recomposition.id);
 if(integration.phase!=='produced'||!integration.result||link.request.repair.resultSha256!==p.collection.repair.resultSha256)throw new Error('conditional_entry_original_member_recomposition_required');
 const key='member-import-'+task,previous=records.normalEntryHistory(id,entry.id,key);if(previous)return {...previous.reference,duplicate:true,newModelInputs:0};
 const state=q.candidateValidations().state(p.id);if(!state.binding||state.phase!=='recorded'||!state.captureValidationCurrent||!state.resourcesSettled)throw new Error('conditional_entry_terminal_member_validation_required');
 const capture=await readCandidateValidationCapture(p,state.binding,q.candidateValidations().executions(p.id)),result=q.import(capture.packet);if(p.candidateSource){const bound=q.events().reconcilePackets([result.item]);if(bound.items.some((r:any)=>r.waiting?.length))throw new Error('conditional_entry_member_current_material_required');}const current=await QueueStore.observeConditionalCandidate(entry.store,result.item);result.packet=current.packet;
 records.normalEntryStep(id,entry.id,key,Buffer.from(canonical({validation:p.id,recomposition:recomposition.id,manifestSha256:p.manifestSha256,reportSha256:capture.packet.reportHash})),{kind:'member-packet',id:result.item,task,item:result.item,packet:result.packet,fingerprint:current.fingerprint,individualReceptionInferred:false});return {...result,duplicate:false,newModelInputs:0,individualReceptionInferred:false};
}
