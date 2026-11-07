import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {parseConditionalEntry,type ConditionalEntryPlan,type ConditionalRef} from './conditional-entry-contract.js';
import {parseCoordinationPlan,coordinationPlanId,type CoordinationPlan} from './coordination-contract.js';
import {parseCoordinationExecution} from './coordination-execution-contract.js';
import {QueueStore} from './queue-store.js';
import {regular,exists} from './repair-workspace.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {runCoordination} from './coordination.js';
import {runCoordinationEarlyReceiver} from './coordination-early-receiver.js';
import {runIntegration} from './integration.js';
import {parseIntegrationRequest,type IntegrationRequest} from './integration-contract.js';
import {parsePlan} from './verification.js';
import {parseReceiverPlan,runReception,type ReceiverPlan} from './receiver.js';
import {scopeBodyHash,type ActionRequest} from './authority-contract.js';
import {readOwnerSource} from './authority-source.js';
import {collectConditionalCandidate,reportConditionalCollection,type ConditionalCollection,type ConditionalMemberCollection} from './conditional-entry-source.js';
import {runCandidateValidation} from './candidate-validation.js';
import {parseIntegrationCandidateValidation as parseCandidateValidation,candidateValidationPayload,type IntegrationCandidateValidationPlan as CandidateValidationPlan} from './candidate-validation-contract.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';
import {loadBundle} from './verification.js';
import {readCandidateValidationCapture} from './candidate-validation-capture.js';
import {runObservedCandidate} from './observed-candidate.js';
import type {ObservedCandidateRequest} from './observed-candidate-contract.js';
import {prepareResourceRequest} from './resource-claims.js';
import {readEventSource} from './event-source.js';
import {memberCollectionInput,memberValidationInput,memberRecompositionInput,importRecomposedMember} from './conditional-entry-member.js';
import {runMemberRecomposition} from './member-recomposition.js';
import {prepareConditionalRepair} from './conditional-entry-repair.js';
import {runQueueRepair} from './queue-repair.js';

type Row=Record<string,any>;
const sameCandidate=(a:Row,b:Row)=>['repository','pr','H','B','targetRef'].every(k=>a[k]===b[k]);
const layout=(plan:CoordinationPlan)=>{const {revision:_r,previous:_p,authorityIntent:_a,source:_s,...value}=plan;return canonical({...value,tasks:plan.tasks.map(({item:_item,...task})=>task)});};
async function dir(path:string){if(!await exists(path))await privateDirectory(path,true);else await privateDirectory(path,false);}
async function fixed(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}if(!(await regular(path,2*1024*1024)).equals(bytes))throw new Error('conditional_entry_original_request_changed');}
async function reference(ref:ConditionalRef,max=2*1024*1024){const bytes=await regular(ref.path,max);if(hash(bytes)!==ref.sha256)throw new Error('conditional_entry_capability_changed');return bytes;}

/** A fixed project entry. Child consumers retain their own authorization,
 * process/capture state and idempotency. This object does not hold a queue. */
export class ConditionalDeliveryEntry{
 private options=new Map<string,{id:string;plan:CoordinationPlan;execution:Buffer}>();
 private constructor(readonly path:string,private bytes:Buffer,readonly plan:ConditionalEntryPlan,private template:CoordinationPlan,private execution:Buffer){this.options.set('default',{id:'default',plan:template,execution});}
 static async load(path:string,readOnly=false){
  const bytes=await regular(path,128*1024),p=parseConditionalEntry(bytes);
  if(readOnly){const saved=await QueueStore.observeConditionalEntryCatalog(p.store,p.id,hash(bytes),false);if(saved.identity)return new ConditionalDeliveryEntry(path,bytes,p,saved.identity.template,Buffer.alloc(0));}
  const template=parseCoordinationPlan(await reference(p.coordination.plan,256*1024)),execution=await reference(p.coordination.execution,256*1024);
  parseCoordinationExecution(execution,template);parsePlan(JSON.parse((await reference(p.integration.testPlan,64*1024)).toString()));
  const receiver=parseReceiverPlan(await reference(p.integration.receiverTemplate));
  if(receiver.store!==p.store||receiver.schemaVersion!==1||receiver.governance||p.integration.members.some(id=>!template.tasks.some(t=>t.id===id&&t.stages.includes(p.integration.gateStage))))throw new Error('conditional_entry_capability_scope_invalid');
  return new ConditionalDeliveryEntry(path,bytes,p,template,execution);
 }
 private async current(live=true){if(!(await regular(this.path,128*1024)).equals(this.bytes))throw new Error('conditional_entry_catalog_changed');if(live){await reference(this.plan.coordination.plan,256*1024);await reference(this.plan.coordination.execution,256*1024);}}
 private async option(id:string){
  if(id==='default')return this.options.get(id)!;
  const ref=this.plan.coordination.choices?.find(c=>c.id===id);if(!ref)throw new Error('conditional_entry_choice_not_configured');
  const plan=parseCoordinationPlan(await reference(ref.plan,256*1024)),execution=await reference(ref.execution,256*1024);parseCoordinationExecution(execution,plan);
  if(plan.name!==this.template.name||canonical(plan.tasks.map(t=>[t.id,t.item]).sort())!==canonical(this.template.tasks.map(t=>[t.id,t.item]).sort())||this.plan.integration.members.some(id=>!plan.tasks.some(t=>t.id===id&&t.stages.includes(this.plan.integration.gateStage))))throw new Error('conditional_entry_choice_scope_invalid');
  const value={id,plan,execution};this.options.set(id,value);return value;
 }
 private async optionFor(plan:CoordinationPlan){
  const candidates=['default',...(this.plan.coordination.choices??[]).map(c=>c.id)];
  for(const id of candidates){const option=await this.option(id);if(layout(plan)===layout(option.plan))return option;}
  throw new Error('conditional_entry_current_relation_not_supported');
 }
 private compatible(plan:CoordinationPlan,q:QueueStore,option:{plan:CoordinationPlan;execution:Buffer}){
  if(layout(plan)!==layout(option.plan))throw new Error('conditional_entry_current_relation_not_supported');q.verifyConditionalTaskIdentity(this.template,plan);parseCoordinationExecution(option.execution,plan);
 }
 private materialBinding(q:QueueStore,plan:CoordinationPlan,choice:string,registered?:string){
  const bindings=registered?q.coordination().originalBindings(registered):Object.fromEntries(q.resolveConditionalTaskBindings(this.template,this.plan.repository,this.plan.target).map(b=>[b.task,b]));
  let integrationSource:Row|null=null;try{const source=q.resolveConditionalComposition(this.plan.integration.item,this.plan.integration.members.map(id=>plan.tasks.find(t=>t.id===id)!.item));if(source)integrationSource={item:source.item,packet:source.packet,fingerprint:source.fingerprint};}catch(e){if(!(e instanceof Error)||e.message!=='conditional_entry_current_revalidated_combination_required')throw e;}
  return {choice,tasks:plan.tasks.map(t=>({task:t.id,item:t.item,packet:bindings[t.id].packet,fingerprint:bindings[t.id].fingerprint})),integrationSource};
 }
 private root(){return join(this.plan.store,'conditional-entry-'+hash(canonical([this.plan.id,this.template.name])).slice(0,48));}
 private async derive<T>(action:(q:QueueStore,plan:CoordinationPlan,id:string,root:string)=>Promise<T>,refresh?:{choice?:string}){
  await this.current();const root=this.root();await dir(root);const lockPath=join(root,'derivation.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}
  await regular(lockPath,4*1024*1024);const lock=new DatabaseSync(lockPath);let q:QueueStore|undefined;
  try{
   try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('conditional_entry_derivation_active');}
   q=await QueueStore.open(this.plan.store);const records=q.coordination(),known=records.current(this.template.name),currentOption=known?await this.optionFor(known.plan):await this.option('default');let plan=known?.plan??this.template,option=currentOption;if(known)this.compatible(plan,q,currentOption);
   if(refresh){
    option=refresh.choice?await this.option(refresh.choice):currentOption;
    const selected=q.resolveConditionalTaskBindings(this.template,this.plan.repository,this.plan.target),next=structuredClone(option.plan);next.tasks=next.tasks.map(t=>({...t,item:selected.find(b=>b.task===t.id)!.item}));
    const material=this.materialBinding(q,next,option.id),previous=known&&records.normalEntryHistory(known.id,this.plan.id,'materials'),same=known?.currentMaterials===true&&layout(known.plan)===layout(next)&&previous?.request.equals(Buffer.from(canonical(material)));
    if(!same){
     const seed=hash(canonical([hash(this.bytes),known?.id??null,material,layout(next)])),execution=parseCoordinationExecution(option.execution,next),delegation=execution.delegatedCoordination?{adoption:execution.delegatedCoordination.adoption,authorization:execution.delegatedCoordination.authorization}:null,observations=[];
     next.previous=known?.id??null;next.revision='entry-'+seed.slice(0,40);next.authorityIntent=delegation?'entry-org-'+seed.slice(0,48):null;next.source=option.plan.source+'\nConfigured conditional entry '+this.plan.id+'/'+option.id;
     if(delegation){const a=q.authority(),directory=join(root,'owner-organization-'+randomUUID());await dir(directory);for(const [index,ref] of a.sourceRequests(delegation.authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(directory,String(index))));}
     const check=await q.refreshSelectedTaskSources(next.tasks.map(t=>t.item));q.registerWorkbenchOrganization(Buffer.from(canonical(next)),next.tasks.map(t=>t.item),delegation,observations,check,known?{previous:known.id,bindings:known.plan.tasks.map(t=>({task:t.id,from:t.item,to:next.tasks.find(n=>n.id===t.id)!.item}))}:undefined);plan=next;
    }
   }
   this.execution=option.execution;this.compatible(plan,q,option);
   const items=q.status().items;
   for(const task of plan.tasks){const item=items.find((i:Row)=>i.id===task.item);if(!item||item.candidate.repository!==this.plan.repository||item.candidate.targetRef!==this.plan.target)throw new Error('conditional_entry_project_or_target_changed');}
   const id=coordinationPlanId(plan);if(!known&&!refresh)records.register(Buffer.from(canonical(plan)));
   records.execution(id,this.execution);records.bindNormalEntry(id,this.plan.id,this.bytes,this.path);
   if(!records.normalEntry(id,this.plan.id)!.steps.some((s:Row)=>s.key==='materials'))records.normalEntryStep(id,this.plan.id,'materials',Buffer.from(canonical(this.materialBinding(q,plan,option.id,id))),{kind:'coordination',id,choice:option.id});
   await this.current();return await action(q,plan,id,root);
  }finally{q?.close();if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
 }
 private async inputs(){return this.derive(async(_q,plan,id,root)=>{
  const planPath=join(root,'coordination-'+id+'.json'),requestPath=join(root,'execution-'+hash(this.execution)+'.json');await fixed(planPath,Buffer.from(canonical(plan)));await fixed(requestPath,this.execution);return {id,planPath,requestPath};
 });}
 async state(){
  await this.current(false);const state=await QueueStore.observeConditionalEntryCatalog(this.plan.store,this.plan.id,hash(this.bytes));
  const early=state.earlyAdvice,collectionSources=[],seen=new Set<string>();for(const history of state.identity?.history??[])for(const step of history.entry?.steps??[])if(['snapshot','member-snapshot'].includes(step.reference.kind)&&!seen.has(step.reference.kind+step.reference.id)){seen.add(step.reference.kind+step.reference.id);const collection=JSON.parse(step.request.toString()) as ConditionalCollection|ConditionalMemberCollection;collectionSources.push({...('integration' in collection?{integration:collection.integration}:{kind:'member-source',task:collection.task,repair:collection.repair}),pr:collection.candidate.pr,...await QueueStore.observeConditionalCollectionSource(this.plan.store,collection)});}
  return {id:this.plan.id,title:this.plan.title,repository:this.plan.repository,target:this.plan.target,
    currentReference:state.currentReference,currentProblem:state.currentProblem,collectionSources,children:state.children,
    coordination:state.current?{id:state.current.id,name:state.current.plan.name,revision:state.current.plan.revision,current:state.current.current,currentMaterials:state.current.currentMaterials,tasks:state.current.tasks}:null,
    entry:state.entry?{entryId:state.entry.entryId,catalogSha256:state.entry.catalogSha256,steps:state.entry.steps.map((step:Row)=>({key:step.key,requestSha256:step.requestSha256,reference:step.reference}))}:null,
    earlyAdvice:early?.available?{available:true,run:early.run,messageId:early.messageId,finalSha256:early.finalSha256,parts:early.advice.parts.map(p=>({id:p.id,position:p.position})),technicalAcceptanceGranted:false}:early,
    history:(state.identity?.history??[]).map(h=>({originPlan:h.originPlan,revision:h.plan.revision,stepCount:h.entry?.steps.length??0})),newModelInputs:0,
    choices:[{id:'default',title:this.template.name},...(this.plan.coordination.choices??[]).map(c=>({id:c.id,title:c.title}))],
    steps:['refresh','arrange','advice','investigate','reuse','reuse-publication',...(this.plan.repairs?.length?['repair','repair-member','collect-member','validate-member','recompose-member']:[]),'integrate','collect','validate','attach','receive'],sourceFreshness:'local_snapshot_rechecked_by_original_consumers_before_effects',technicalAcceptanceGranted:false,permissionsGranted:false};
 }
 async collectMember(task:string){
  const input=await this.derive(async(q,_plan,id,root)=>({...memberCollectionInput(q,this.plan,id,root,task),root}));
  const guard=async()=>{await this.derive(async(q,_plan,id,root)=>{const current=memberCollectionInput(q,this.plan,id,root,task);if(canonical(current.collection)!==canonical(input.collection))throw new Error('conditional_entry_member_source_changed');});};
  const collected=await collectConditionalCandidate(this.plan,input.collection,input.root,guard,async()=>this.derive(async(q,_plan,id)=>{q.coordination().normalEntryStep(id,this.plan.id,input.key,Buffer.from(canonical(input.collection)),{kind:'member-snapshot',id:input.collection.repair.operation,task,source:'member-repair'});}));
  const source=await this.derive(async(q,_plan,id)=>{const configured=q.events().configureCollectedSource({originPlan:id,entry:this.plan.id,collectionKey:input.key}),directory=join(this.plan.store,'source-poll-'+input.collection.candidate.pr+'-'+randomUUID()),poll=q.events().beginPoll(input.collection.candidate.pr,directory,true);if(!poll.started)throw new Error('conditional_entry_source_read_not_started');return {profile:configured.profile,poll,directory};});
  const actual=await readEventSource(source.profile,input.collection.candidate.pr,source.directory,source.poll.knownPublished);
  const materialReconciliation=await this.derive(async(q)=>{q.events().observe(input.collection.candidate.pr,source.poll.sequence,actual);if(!actual.result.complete)throw new Error('conditional_entry_source_read_incomplete');for(const r of actual.records.filter(r=>r.kind==='pr')){const p=JSON.parse(r.body.toString());if(p.head?.repo?.id!==source.profile.repositoryId||p.base?.repo?.id!==source.profile.repositoryId||p.head.repo.full_name?.toLowerCase()!==source.profile.repository.toLowerCase()||p.base.repo.full_name?.toLowerCase()!==source.profile.repository.toLowerCase()){q.events().problem(input.collection.candidate.pr,source.poll.sequence,'conditional_entry_published_repository_changed');throw new Error('conditional_entry_published_repository_changed');}}const c=actual.result.candidate;if(!c||c.state!=='open'||['repository','pr','H','B','targetRef'].some(k=>(c as Row)[k]!== (input.collection.candidate as Row)[k]))throw new Error('conditional_entry_published_candidate_mismatch');const items=q.status().items.filter((i:Row)=>{const candidates=i.summary.composition?.subject.members.map((m:Row)=>m.candidate)??[i.candidate];return candidates.some((c:Row)=>['repository','pr','H','B','targetRef'].every(k=>c[k]=== (input.collection.candidate as Row)[k]));}).map((i:Row)=>i.id);return items.length?q.events().reconcilePackets(items):{items:[],modelTasksStarted:0};});
  return {...collected,sourceObservation:{sequence:source.poll.sequence,complete:true,directory:source.directory,materialReconciliation}};
 }
 async validateMember(task:string){
  const input=await this.derive(async(q,plan,id,root)=>{const input=await memberValidationInput(q,this.plan,plan,id,root,task);let problem:string|null=null,started=false;if(input.p.candidateSource){try{q.memberCandidateSource(input.p.candidateSource);}catch(e){problem=e instanceof Error?e.message:'member_source_unavailable';}try{started=Boolean(q.candidateValidations().state(input.p.id).binding);}catch(e){if(!(e instanceof Error)||e.message!=='candidate_validation_not_prepared')throw e;}}return {...input,problem,started};});
  if(input.problem&&!input.started)return {phase:'waiting_for_current_member_source',waiting:input.problem,sourceCurrent:false,newVerificationRuns:0,newModelInputs:0};
  await this.current();const result=await runCandidateValidation(this.plan.store,input.path,input.resources);let problem:string|null=null;if(input.p.candidateSource){const q=await QueueStore.open(this.plan.store);try{try{q.memberCandidateSource(input.p.candidateSource);}catch(e){problem=e instanceof Error?e.message:'member_source_unavailable';}}finally{q.close();}}return {...result,sourceCurrent:problem===null,...(problem?{waiting:problem,historicalResultOnly:true}:{})};
 }
 async recomposeMember(task:string){
  const input=await this.derive(async(q,plan,id,root)=>{const p=await memberRecompositionInput(q,this.plan,plan,id,root,task);let terminal=false,problem:string|null=null;try{terminal=q.integrations().state(p.plan.id).phase==='produced';}catch(e){if(!(e instanceof Error)||e.message!=='integration_not_prepared')throw e;}if(p.plan.memberValidation){const v=q.candidateValidations().originals(p.plan.memberValidation.id).plan;if(v.kind==='tongxu-member-candidate-validation'&&v.candidateSource)try{q.memberCandidateSource(v.candidateSource);}catch(e){problem=e instanceof Error?e.message:'member_source_unavailable';}}return {...p,terminal,problem};});
  if(input.problem)return {phase:'waiting_for_current_member_source',waiting:input.problem,sourceCurrent:false,original:input.terminal?await QueueStore.observeConditionalMemberRecomposition(this.plan.store,input.plan.id):null,newModelInputs:0,newGitProcesses:0};
  if(!input.terminal)for(const request of input.resources)await prepareResourceRequest(this.plan.store,Buffer.from(canonical(request)),'background');await this.current();const result=await runMemberRecomposition(input.path);
  if(result.phase!=='new_integration_candidate_requires_own_reception')return result;if(!('integration' in result)||!result.integration||!('currentSource' in result.integration)||result.integration.currentSource!==true)return {...result,phase:'waiting_for_current_combination_material',historicalPhase:result.phase,newModelInputs:0};const imported=await this.derive(async(q,_plan,id)=>importRecomposedMember(q,this.plan,id,task));return {...result,memberImport:imported};
 }
 async repair(task:string,finding?:number,reconcileEnded=false){
  const input=await this.derive(async(q,plan,id,root)=>{const prepared=await prepareConditionalRepair(q,this.plan,plan,id,root,task,finding);let terminal=false;try{terminal=['returned','closed_unstarted'].includes(q.reviewRecords().state(prepared.plan.operation).repair.phase);}catch(e){if(!(e instanceof Error)||e.message!=='queue_repair_not_registered')throw e;}return {...prepared,terminal};});
  if(!input.terminal)for(const request of input.resources)await prepareResourceRequest(this.plan.store,Buffer.from(canonical(request)),'implementer');await this.current();return {entry:this.plan.id,operation:input.plan.operation,original:input.original,repairPlan:input.path,result:await runQueueRepair(input.path,reconcileEnded),manualReportCopyRequired:false};
 }
 async prepare(){const input=await this.inputs();return {...await this.state(),preparedCoordination:input.id,newModelInputs:0};}
 async refresh(choice?:string){return this.derive(async(q,_plan,id)=>({id:this.plan.id,coordination:id,current:q.coordination().status(id),newModelInputs:0,writingPermissionGranted:false,ownerAdoptionCreated:false}),{...(choice?{choice}:{})});}
 async advice(){const input=await this.inputs();await this.current();return runCoordinationEarlyReceiver(this.plan.store,input.planPath,input.requestPath);}
 async investigate(){
  const input=await this.inputs();await this.current();const result=await runCoordination(this.plan.store,input.planPath,input.requestPath);
  const refs=Object.entries(result.prepared).map(([key,p]:[string,any])=>({key,run:p.run,messageId:p.messageId??null,task:key.split(':')[0],historicalReuse:p.historicalReuse??null})),q=await QueueStore.open(this.plan.store);
  try{q.coordination().normalEntryStep(input.id,this.plan.id,'investigate-'+hash(canonical(refs)).slice(0,32),Buffer.from(canonical({coordination:input.id,requestSha256:hash(this.execution)})),{kind:'coordination',id:input.id,runs:refs});}finally{q.close();}
  return result;
 }
 private linkOriginalReceiver(q:QueueStore,id:string,task:string,capability:string,operation:string){
  const original=q.receiverState(operation),plan=parseReceiverPlan(original.plan),key='reused-receiver-'+hash(canonical([task,capability,operation])).slice(0,48);q.coordination().normalEntryStep(id,this.plan.id,key,original.plan,{kind:'receiver',id:key,item:plan.item,operation,reusedOriginal:true});
 }
 async reuse(taskId:string){return this.derive(async(q,plan,id)=>{
  const task=plan.tasks.find(t=>t.id===taskId),output=task?.outputs.filter(o=>o.kind==='receiver_judgment'||o.kind==='integration_receiver_judgment');if(!task||output?.length!==1)throw new Error('conditional_entry_receiver_capability_not_selected');
  if(output[0]!.kind==='integration_receiver_judgment'){const matches=q.status().operations.filter((o:Row)=>q.coordination().integrationOutputMatches(id,task.id,output[0]!.id,o.id));if(matches.length!==1)throw new Error('conditional_entry_exact_integration_receiver_required');const registered=q.coordination().recordIntegrationOutput(id,task.id,output[0]!.id,matches[0]!.id);this.linkOriginalReceiver(q,id,task.id,output[0]!.id,matches[0]!.id);return registered;}
  const matches=q.status().operations.filter((o:Row)=>o.item===task.item&&o.packet===q.status().items.find((i:Row)=>i.id===task.item)?.currentPacket&&o.result?.receiver?.phase==='returned'&&o.result.receiver.judgment?.verdict==='ACCEPT_WITHIN_SCOPE');
  if(matches.length!==1)throw new Error('conditional_entry_exact_receiver_result_required');
  const registered=q.coordination().recordReceiverOutput(id,task.id,output[0]!.id,matches[0]!.id);this.linkOriginalReceiver(q,id,task.id,output[0]!.id,matches[0]!.id);return registered;
 });}
 async reusePublication(taskId:string){return this.derive(async(q,plan,id)=>{
  const task=plan.tasks.find(t=>t.id===taskId),output=task?.outputs.filter(o=>o.kind==='publication_readback'||o.kind==='integration_publication_readback');if(!task||output?.length!==1)throw new Error('conditional_entry_publication_capability_not_selected');
  if(output[0]!.kind==='integration_publication_readback'){const matches=q.status().operations.filter((o:Row)=>q.coordination().integrationOutputMatches(id,task.id,output[0]!.id,o.id,true));if(matches.length!==1)throw new Error('conditional_entry_exact_integration_publication_required');const registered=q.coordination().recordIntegrationOutput(id,task.id,output[0]!.id,matches[0]!.id,true);this.linkOriginalReceiver(q,id,task.id,output[0]!.id,matches[0]!.id);return registered;}
  const state=q.status(),matches=state.operations.filter((o:Row)=>o.item===task.item&&o.packet===state.items.find((i:Row)=>i.id===task.item)?.currentPacket&&o.result?.receiver?.phase==='returned'&&o.result.receiver.judgment?.verdict==='ACCEPT_WITHIN_SCOPE');
  if(matches.length!==1)throw new Error('conditional_entry_exact_publication_result_required');const registered=q.coordination().recordPublicationOutput(id,task.id,output[0]!.id,matches[0]!.id);this.linkOriginalReceiver(q,id,task.id,output[0]!.id,matches[0]!.id);return registered;
 });}
 private async integrationInput(){return this.derive(async(q,plan,id,root)=>{
  const cap=this.plan.integration,state=q.coordination().status(id),members=cap.members.map(name=>plan.tasks.find(t=>t.id===name)!);
  for(const task of members){const stage=state.tasks.find(t=>t.id===task.id)!.stages.find(s=>s.stage===cap.gateStage);if(!stage?.phasePrerequisitesMet)throw new Error(stage?.blockers[0]??'conditional_entry_integration_stage_missing');}
  const source=q.resolveConditionalComposition(cap.item,members.map(t=>t.item));if(!source||source.candidate.repository!==this.plan.repository||source.candidate.targetRef!==this.plan.target||canonical(source.context.scope)!==canonical(state.scope))throw new Error('conditional_entry_integration_source_changed');
  const begun=q.begin(source.item,'conditional-entry:'+this.plan.id);if(begun.blocked)throw new Error('conditional_entry_original_operation_waiting');q.evaluate(begun.operation);
  const e=q.receiverEvidence(begun.operation);if(!e.composition||e.composition.subject.members.length!==members.length)throw new Error('conditional_entry_exact_combination_required');
  for(const [index,task] of members.entries()){const item=q.status().items.find((i:Row)=>i.id===task.item);if(!item||!sameCandidate(e.composition.subject.members[index].candidate,item.candidate))throw new Error('conditional_entry_combination_member_changed');}
  const history=q.coordination().normalEntryHistory(id,this.plan.id,'integration');let request:IntegrationRequest|undefined;
  if(history){const old=parseIntegrationRequest(history.request);if(old.operation===begun.operation&&old.subjectSha256===e.composition.sha256)request=old;else{const state=q.integrations().state(history.reference.id);if(!['produced','failed_ended','closed_unstarted'].includes(state.phase))throw new Error('conditional_entry_original_integration_requires_reconciliation');}}
  if(!request){
   // A recomposition or a component entry may already own this exact private
   // producer. Restore its request before creating an authority intent or ID.
   const originals=q.integrations().forOperation(begun.operation),live=originals.filter(x=>!['failed_ended','closed_unstarted'].includes(x.state.phase));
   if(live.length>1)throw new Error('conditional_entry_original_integration_ambiguous');
   if(live.length){const original=live[0]!;if(original.request.subjectSha256!==e.composition.sha256||original.request.scopeSha256!==hash(canonical(e.context.scope))||original.request.arrangementSha256!==hash(canonical(e.context.arrangement)))throw new Error('conditional_entry_original_integration_source_changed');request=original.request;}
  }
  if(!request){
   const equivalent=q.integrations().equivalentProduced(begun.operation,history?.reference.id);
   if(equivalent){
    const original=q.integrations().sourceMaterial(equivalent);
    const materialKey='im-'+hash(canonical([equivalent,begun.operation,e.fingerprint])).slice(0,48);
    q.coordination().normalEntryStep(id,this.plan.id,materialKey,Buffer.from(canonical({integration:equivalent,operation:begun.operation,packet:e.packet,fingerprint:e.fingerprint})),{kind:'integration-material',id:equivalent,operation:begun.operation});
    q.integrations().bindCurrentMaterial(equivalent,begun.operation);
    request=original.request;
   }
  }
  if(!request){
   const intent=cap.authorization?'entry-test-'+hash(canonical([this.plan.id,begun.operation,e.composition.sha256])).slice(0,48):null;
   request={schemaVersion:1,kind:'tongxu-minimal-integration',id:'entry-'+hash(canonical([this.plan.id,begun.operation,e.composition.sha256])).slice(0,48),operation:begun.operation,subjectSha256:e.composition.sha256,scopeSha256:hash(canonical(e.context.scope)),arrangementSha256:hash(canonical(e.context.arrangement)),objects:cap.objects,selectionReason:cap.selectionReason,source:'Configured normal conditional entry '+this.plan.id,authorityIntent:intent};
   const observed=await QueueStore.observeOrganization(this.plan.store,plan.name,plan.tasks.map(t=>t.item));
   if(observed.ownerSourceConfigured){
    if(!cap.authorization||!intent)throw new Error('conditional_entry_integration_authority_required');const a=q.authority(),auth=cap.authorization,decision=a.inspectRecordedDecision(auth.authorization),observations=[],directory=join(root,'owner-'+randomUUID());
    if(decision.proposal.kind!=='delegate'||decision.proposal.adoption!==auth.adoption)throw new Error('conditional_entry_existing_test_delegation_required');await dir(directory);
    for(const [index,ref] of a.sourceRequests(auth.authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(directory,String(index))));
    const baseline=a.adoptionBaseline(auth.adoption,observations),c=e.composition.subject.members.at(-1)!.candidate;
    const action:ActionRequest={schemaVersion:1,scopeId:e.context.scope.id,scopeVersion:e.context.scope.version,scopeBodySha256:scopeBodyHash(baseline.body),repository:c.repository,target:c.targetRef,action:'test',item:source.item,candidate:{H:c.H,B:c.B,subjectSha256:e.composition.sha256},paths:[],resourceRefs:[]};
    const reserved=a.reserveAction(intent,action,'background',auth.authorization,observations);if(reserved.mode!=='delegated'||reserved.adoption!==auth.adoption)throw new Error('conditional_entry_existing_test_delegation_required');
   }else if(cap.authorization)throw new Error('conditional_entry_owner_profile_required');
  }
  const bytes=Buffer.from(canonical(request)),step=q.coordination().normalEntryStep(id,this.plan.id,'integration',bytes,{kind:'integration',id:request.id,operation:request.operation}),path=join(root,'integration-'+step.requestSha256+'.json');await fixed(path,step.request);return {path,id:request.id};
 });}
 async integrate(reconcile=false){
  const input=reconcile?await this.derive(async(q,_plan,id,root)=>{const step=q.coordination().normalEntryHistory(id,this.plan.id,'integration');if(!step)throw new Error('conditional_entry_original_integration_required');const path=join(root,'integration-'+step.requestSha256+'.json');await fixed(path,step.request);return {path};}):await this.integrationInput();
  await this.current();return runIntegration(this.plan.store,input.path,reconcile?'reconcile':'run');
 }
 async collect(pr:number){
  if(!Number.isSafeInteger(pr)||pr<1)throw new Error('conditional_entry_pr_invalid');
  const input=await this.derive(async(q,_plan,id,root)=>{
   const ref=q.coordination().normalEntryHistory(id,this.plan.id,'integration');if(!ref)throw new Error('conditional_entry_private_candidate_required');
   const state=q.integrations().state(ref.reference.id);if(state.phase!=='produced'||!state.currentSource)throw new Error('conditional_entry_current_private_candidate_required');
   const c=state.result!.candidate,e=q.receiverEvidence(state.operation);if(c.repository!==this.plan.repository||c.target!==this.plan.target)throw new Error('conditional_entry_private_candidate_scope_changed');
   const request:ConditionalCollection={schemaVersion:1,kind:'tongxu-conditional-candidate-collection',integration:state.id,integrationRequestSha256:state.requestSha256,snapshot:join(root,'collection-'+hash(canonical([state.id,pr]))),objects:join(state.directory,'candidate.git'),candidate:{repository:c.repository,pr,H:c.H,B:c.B,T:c.T,targetRef:c.target},context:e.context};
   const key='collection-'+hash(state.id).slice(0,48),original=q.coordination().normalEntryHistory(id,this.plan.id,key);
   if(original&&!original.request.equals(Buffer.from(canonical(request))))throw new Error('conditional_entry_step_is_fixed');
   return {request,root,key,bound:Boolean(original)};
  });
  const guard=async()=>{await this.current();const state=await QueueStore.observeIntegration(this.plan.store,input.request.integration);if(state.phase!=='produced'||!state.currentSource||state.requestSha256!==input.request.integrationRequestSha256)throw new Error('conditional_entry_current_private_candidate_required');};
  let source:Awaited<ReturnType<ConditionalDeliveryEntry['beginCollectionSource']>>|undefined;
  try{
   if(input.bound)source=await this.beginCollectionSource(input.key);
   const collected=await collectConditionalCandidate(this.plan,input.request,input.root,guard,async()=>this.derive(async(q,_plan,id)=>{await guard();q.coordination().normalEntryStep(id,this.plan.id,input.key,Buffer.from(canonical(input.request)),{kind:'snapshot',id:input.request.integration,directory:input.request.snapshot,pr});}));
   if(!collected.collectionComplete)throw new Error('conditional_entry_own_current_collection_required');source??=await this.beginCollectionSource(input.key);
   const sourceObservation=await this.observeCollectionSource(source);return {...collected,sourceObservation,originalSnapshotPreserved:true};
  }catch(e){if(source&&!source.recorded){const q=await QueueStore.open(this.plan.store);try{q.events().problem(pr,source.poll.sequence,e instanceof Error?e.message:'collected_source_unknown');}finally{q.close();}}throw e;}

 }
 private async beginCollectionSource(key:string){return this.derive(async(q,_plan,id)=>{
  const original=q.coordination().normalEntryHistory(id,this.plan.id,key);if(original?.reference.kind!=='snapshot')throw new Error('conditional_entry_own_collection_required');const collection=JSON.parse(original.request.toString()) as ConditionalCollection,pr=collection.candidate.pr;
  const source=q.events().configureCollectedSource({originPlan:id,entry:this.plan.id,collectionKey:key}),directory=join(this.plan.store,'source-poll-'+pr+'-'+randomUUID()),poll=q.events().beginPoll(pr,directory,true);if(!poll.started)throw new Error('conditional_entry_source_read_not_started');return {collection,profile:source.profile,poll,directory,recorded:false};
 });}
 private async observeCollectionSource(source:Awaited<ReturnType<ConditionalDeliveryEntry['beginCollectionSource']>>){
  const pr=source.collection.candidate.pr,actual=await readEventSource(source.profile,pr,source.directory,source.poll.knownPublished),q=await QueueStore.open(this.plan.store);
  try{const recorded=q.events().observe(pr,source.poll.sequence,actual);source.recorded=true;if(recorded.archived)throw new Error('conditional_entry_source_read_superseded');if(!actual.result.complete)throw new Error('conditional_entry_source_read_incomplete');
   for(const ref of actual.records.filter(r=>r.kind==='pr')){const pr=JSON.parse(ref.body.toString());if(pr.head?.repo?.id!==source.profile.repositoryId||pr.head.repo.full_name?.toLowerCase()!==source.profile.repository.toLowerCase()||pr.base?.repo?.id!==source.profile.repositoryId||pr.base.repo.full_name?.toLowerCase()!==source.profile.repository.toLowerCase()){q.events().problem(source.collection.candidate.pr,source.poll.sequence,'conditional_entry_published_repository_changed');throw new Error('conditional_entry_published_repository_changed');}}
   const c=actual.result.candidate;if(!c||['repository','pr','H','B','targetRef'].some(k=>(c as Row)[k]!== (source.collection.candidate as Row)[k]))throw new Error('conditional_entry_published_candidate_mismatch');
   const items=q.status().items.filter((i:Row)=>['repository','pr','H','B','targetRef'].every(k=>i.candidate[k]===(source.collection.candidate as Row)[k])).map((i:Row)=>i.id),reconciled=items.length?q.events().reconcilePackets(items):{items:[],modelTasksStarted:0};
   await this.current();const integration=q.integrations().state(source.collection.integration);if(integration.phase!=='produced'||!integration.currentSource||integration.requestSha256!==source.collection.integrationRequestSha256)throw new Error('conditional_entry_current_private_candidate_required');
   return {sequence:source.poll.sequence,directory:source.directory,complete:true,semanticSha256:actual.result.semanticSha256,materialReconciliation:reconciled};
  }finally{q.close();}
 }
 private async hasCollectedSource(pr:number){const q=await QueueStore.open(this.plan.store);try{try{q.events().configurationFor(pr);return true;}catch(e){if(e instanceof Error&&e.message==='event_subject_not_registered')return false;throw e;}}finally{q.close();}}
 private async refreshCollectionSource(key:string){const source=await this.beginCollectionSource(key);try{return await this.observeCollectionSource(source);}catch(e){if(!source.recorded){const q=await QueueStore.open(this.plan.store);try{q.events().problem(source.collection.candidate.pr,source.poll.sequence,e instanceof Error?e.message:'collected_source_unknown');}finally{q.close();}}throw e;}}
 private async validationInput(){return this.derive(async(q,plan,id,root)=>{
  const records=q.coordination(),integration=records.normalEntryHistory(id,this.plan.id,'integration');if(!integration)throw new Error('conditional_entry_private_candidate_required');
  const collectionKey='collection-'+hash(integration.reference.id).slice(0,48),collected=records.normalEntryHistory(id,this.plan.id,collectionKey);if(collected?.reference.kind!=='snapshot')throw new Error('conditional_entry_own_collection_required');
  const collection=JSON.parse(collected.request.toString()) as ConditionalCollection,bundle=await loadBundle(collection.snapshot),testPlan=this.plan.integration.testPlan;await reference(testPlan,64*1024);
  if(bundle.sourceGaps.length||['repository','pr','H','B','targetRef'].some(k=>(bundle.candidate as Row)[k]!== (collection.candidate as Row)[k]))throw new Error('conditional_entry_own_current_collection_required');
  const key='validation-'+hash(collection.integration).slice(0,48),previous=records.normalEntryHistory(id,this.plan.id,key),resources:ResourceRequest[]=[];let p:CandidateValidationPlan;
  if(previous){p=parseCandidateValidation(previous.request);if(p.manifestSha256!==hash(bundle.bytes)||canonical(p.testPlan)!==canonical(testPlan)||canonical(p.collection)!==canonical(collection))throw new Error('conditional_entry_original_validation_requires_reconciliation');}
  else{
   const validationId='entry-'+hash(canonical([this.plan.id,collection,hash(bundle.bytes),testPlan.sha256])).slice(0,48),auth=this.plan.integration.validationAuthorization,observed=await QueueStore.observeOrganization(this.plan.store,plan.name,plan.tasks.map(t=>t.item));
   p={schemaVersion:1,kind:'tongxu-integration-candidate-validation',id:validationId,store:this.plan.store,entry:this.plan.id,originPlan:id,collectionKey,collection,manifestSha256:hash(bundle.bytes),testPlan,directory:join(this.plan.store,'candidate-validation-'+validationId),governance:auth?{authorityIntent:'entry-validate-'+hash(validationId).slice(0,48),resourceRequests:[]}:null};
   if(observed.ownerSourceConfigured){
    if(!auth||!p.governance)throw new Error('conditional_entry_validation_authority_required');const a=q.authority(),decision=a.inspectRecordedDecision(auth.authorization);if(decision.proposal.kind!=='delegate'||decision.proposal.adoption!==auth.adoption)throw new Error('conditional_entry_existing_test_delegation_required');
    const observations=[],directory=join(root,'owner-validation-'+randomUUID());await dir(directory);for(const [index,ref] of a.sourceRequests(auth.authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(directory,String(index))));
    const source=q.integrations().currentMaterialSource(integration.reference.id).source;
    const baseline=a.adoptionBaseline(auth.adoption,observations),e=q.receiverEvidence(source.operation),c=e.composition!.subject.members.at(-1)!.candidate;
    // Permission names the original composition and binds the new candidate,
    // collection and registered test through its exact purpose payload.
    const action:ActionRequest={schemaVersion:1,scopeId:e.context.scope.id,scopeVersion:e.context.scope.version,scopeBodySha256:scopeBodyHash(baseline.body),repository:c.repository,target:c.targetRef,action:'test',item:q.integrations().sourceMaterial(integration.reference.id).source.item,candidate:{H:c.H,B:c.B,subjectSha256:e.composition!.sha256},paths:[],resourceRefs:auth.budgets.map(b=>b.resourceRef),payloadSha256:candidateValidationPayload(p)};
    const reserved=a.reserveAction(p.governance.authorityIntent,action,'background',auth.authorization,observations);if(reserved.mode!=='delegated')throw new Error('conditional_entry_existing_test_delegation_required');
    resources.push(...auth.budgets.map(b=>({schemaVersion:1 as const,...b,repository:c.repository,operation:source.operation,authorityIntent:p.governance!.authorityIntent,role:'background' as const,actionSha256:hash(canonical(action))})));p.governance.resourceRequests=resources.map(resourceRequestHash);
   }else if(auth)throw new Error('conditional_entry_owner_profile_required');
  }
  if(previous&&p.governance){
   const a=q.authority().reservedAction(p.governance.authorityIntent),auth=this.plan.integration.validationAuthorization,operation=previous.reference.sourceOperation??q.integrations().state(p.collection.integration).operation;if(!auth||a.authorization!==auth.authorization||a.request.payloadSha256!==candidateValidationPayload(p))throw new Error('conditional_entry_original_validation_authority_changed');
   resources.push(...auth.budgets.map(b=>({schemaVersion:1 as const,...b,repository:p.collection.candidate.repository,operation,authorityIntent:p.governance!.authorityIntent,role:'background' as const,actionSha256:a.requestSha256})));if(canonical(resources.map(resourceRequestHash))!==canonical(p.governance.resourceRequests))throw new Error('conditional_entry_original_validation_resources_changed');
  }
  const sourceOperation=previous?.reference.sourceOperation??q.integrations().currentMaterialSource(p.collection.integration).source.operation;
  const step=records.normalEntryStep(id,this.plan.id,key,Buffer.from(canonical(p)),{kind:'validation',id:p.id,integration:p.collection.integration,...(!previous||previous.reference.sourceOperation?{sourceOperation}:{})}),path=join(root,'validation-'+step.requestSha256+'.json');await fixed(path,step.request);return {path,resources};
 });}
 async validate(){const input=await this.validationInput();await this.current();return runCandidateValidation(this.plan.store,input.path,input.resources);}
 async attach(){
  const original=await this.derive(async(q,_plan,id,root)=>{
   const integration=q.coordination().normalEntryHistory(id,this.plan.id,'integration'),step=integration&&q.coordination().normalEntryHistory(id,this.plan.id,'validation-'+hash(integration.reference.id).slice(0,48));if(step?.reference.kind!=='validation')throw new Error('conditional_entry_own_validation_required');
   const p=parseCandidateValidation(step.request),state=q.candidateValidations().state(p.id);if(state.phase!=='recorded'||!state.captureValidationCurrent)throw new Error('conditional_entry_own_terminal_validation_required');const path=join(root,'validation-'+step.requestSha256+'.json');await fixed(path,step.request);return {p,path};
  });
  const sourceKey=original.p.collectionKey;if(await this.hasCollectedSource(original.p.collection.candidate.pr))await this.refreshCollectionSource(sourceKey);
  const reconciled=await runCandidateValidation(this.plan.store,original.path);if(!reconciled.state.result?.evidenceComplete||!reconciled.resources.settled)throw new Error('conditional_entry_own_validation_or_resources_incomplete');
  const input=await this.derive(async(q,_plan,id,root)=>{
   const state=q.candidateValidations().state(original.p.id);if(!state.binding)throw new Error('conditional_entry_own_terminal_validation_required');
   const capture=await readCandidateValidationCapture(original.p,state.binding,q.candidateValidations().executions(original.p.id));if(!capture.packet.summary.evidenceComplete)throw new Error('conditional_entry_own_validation_or_resources_incomplete');
   const imported=q.import(capture.packet);if(await this.hasCollectedSource(original.p.collection.candidate.pr))q.events().reconcilePackets([imported.item]);
   const reception=q.coordination().normalReceptionContext(id,this.plan.id);
   const receptionContext={coordination:id,entry:this.plan.id,semanticSha256:reception.semanticSha256};
   const selected=q.conditionalCandidatePacket(original.p.collection,reception.semanticSha256),child='candidate-'+hash(canonical([original.p.id,selected.materialKey])).slice(0,48),key='observation-'+hash(child).slice(0,48),old=q.coordination().normalEntryHistory(id,this.plan.id,key);let request:ObservedCandidateRequest;
   if(old)request=JSON.parse(old.request.toString()) as ObservedCandidateRequest;
   else{const reader=this.plan.integration.sourceReader;request={schemaVersion:1,kind:'tongxu-observed-integration-candidate',integration:original.p.collection.integration,item:selected.item,packet:selected.packet,fingerprint:selected.fingerprint,source:'Normal conditional entry '+this.plan.id+'; own W1/W2 and configured GET observation',repositoryId:reader.repositoryId,ghExecutable:reader.ghExecutable,ghSha256:reader.ghSha256,...(reader.executionKind?{executionKind:reader.executionKind}:{}),receptionContext};}
   const step=q.coordination().normalEntryStep(id,this.plan.id,key,Buffer.from(canonical(request)),{kind:'packet',id:child,validation:original.p.id,item:request.item,packet:request.packet,fingerprint:request.fingerprint,integration:request.integration,materialKey:selected.materialKey}),path=join(root,'observation-'+step.requestSha256+'.json');await fixed(path,step.request);return {path};
  });
  await this.current();return runObservedCandidate(this.plan.store,input.path);
 }
 private async receptionInput(){return this.derive(async(q,plan,id,root)=>{
  const records=q.coordination(),integration=records.normalEntryHistory(id,this.plan.id,'integration'),validation=integration&&records.normalEntryHistory(id,this.plan.id,'validation-'+hash(integration.reference.id).slice(0,48));
  if(!validation)throw new Error('conditional_entry_observed_own_candidate_required');const own=parseCandidateValidation(validation.request),reception=records.normalReceptionContext(id,this.plan.id);let selected;try{selected=q.conditionalCandidatePacket(own.collection,reception.semanticSha256);}catch{throw new Error('conditional_entry_observed_own_candidate_required');}
  const candidate=records.normalEntryPacket(id,this.plan.id,own.collection.integration,selected.materialKey);
  if(candidate?.reference.kind!=='packet')throw new Error('conditional_entry_observed_own_candidate_required');const key='receiver-'+hash(candidate.reference.id).slice(0,48),previous=records.normalEntryHistory(id,this.plan.id,key),resources:ResourceRequest[]=[];let receiver:ReceiverPlan,operation:string;
  if(previous){receiver=parseReceiverPlan(previous.request);operation=previous.reference.operation;}
  else{
   const observed=await QueueStore.observeConditionalCandidate(this.plan.store,candidate.reference.item);if(!observed.complete)throw new Error('conditional_entry_observed_own_candidate_required');
   const begin=q.begin(candidate.reference.item,'conditional-entry-receiver:'+this.plan.id);if(begin.blocked)throw new Error('conditional_entry_receiver_original_operation_waiting');operation=begin.operation;q.evaluate(operation);
   const e=q.receiverEvidence(operation),template=parseReceiverPlan(await reference(this.plan.integration.receiverTemplate)),context=Buffer.from(canonical({kind:'tongxu-normal-entry-reception-context',entryId:this.plan.id,coordination:id,relation:reception.value,semanticSha256:reception.semanticSha256,validation:validation!.reference.id,ownCandidate:observed.manifest.candidate,adviceIsNotFinalAcceptance:true}));
   if(context.length>512*1024)throw new Error('conditional_entry_receiver_context_limit');const contextPath=join(root,'reception-context-'+hash(context)+'.json');await fixed(contextPath,context);
   receiver={...template,store:this.plan.store,item:candidate.reference.item,objects:join(q.integrations().state(integration!.reference.id).directory,'candidate.git'),material:[...template.material,{path:contextPath,sha256:hash(context)}]};parseReceiverPlan(Buffer.from(canonical(receiver)));
   const auth=this.plan.integration.receiverAuthorization,owner=await QueueStore.observeOrganization(this.plan.store,plan.name,plan.tasks.map(t=>t.item));
   if(owner.ownerSourceConfigured){
    if(!auth)throw new Error('conditional_entry_receiver_authority_required');const a=q.authority(),decision=a.inspectRecordedDecision(auth.authorization);if(decision.proposal.kind!=='delegate'||decision.proposal.adoption!==auth.adoption)throw new Error('conditional_entry_existing_receiver_delegation_required');
    const directory=join(root,'owner-receiver-'+randomUUID()),observations=[];await dir(directory);for(const [index,ref] of a.sourceRequests(auth.authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(directory,String(index))));
    const baseline=a.adoptionBaseline(auth.adoption,observations),intent='entry-receive-'+hash(canonical([this.plan.id,operation,e.fingerprint,hash(canonical(receiver))])).slice(0,48),c=e.manifest.candidate;
    const action:ActionRequest={schemaVersion:1,scopeId:e.context.scope.id,scopeVersion:e.context.scope.version,scopeBodySha256:scopeBodyHash(baseline.body),repository:c.repository,target:c.targetRef,action:'receive',item:receiver.item,candidate:{H:c.H,B:c.B,subjectSha256:null},paths:[],resourceRefs:auth.budgets.map(b=>b.resourceRef)};
    const reserved=a.reserveAction(intent,action,'receiver',auth.authorization,observations);if(reserved.mode!=='delegated')throw new Error('conditional_entry_existing_receiver_delegation_required');
    resources.push(...auth.budgets.map(b=>({schemaVersion:1 as const,...b,repository:c.repository,operation,authorityIntent:intent,role:'receiver' as const,actionSha256:hash(canonical(action))})));receiver.governance={authorityIntent:intent,resourceRequests:resources.map(resourceRequestHash)};
   }else if(auth)throw new Error('conditional_entry_owner_profile_required');
  }
  if(previous&&receiver.governance){const auth=this.plan.integration.receiverAuthorization,reserved=q.authority().reservedAction(receiver.governance.authorityIntent);if(!auth||reserved.authorization!==auth.authorization)throw new Error('conditional_entry_original_receiver_authority_changed');resources.push(...auth.budgets.map(b=>({schemaVersion:1 as const,...b,repository:this.plan.repository,operation,authorityIntent:receiver.governance!.authorityIntent,role:'receiver' as const,actionSha256:reserved.requestSha256})));if(canonical(resources.map(resourceRequestHash))!==canonical(receiver.governance.resourceRequests))throw new Error('conditional_entry_original_receiver_resources_changed');}
  const bytes=Buffer.from(canonical(receiver));parseReceiverPlan(bytes);const step=records.normalEntryStep(id,this.plan.id,key,bytes,{kind:'receiver',id:candidate.reference.id,item:receiver.item,operation}),path=join(root,'receiver-'+step.requestSha256+'.json');await fixed(path,step.request);return {path,resources};
 });}
 async receive(){const input=await this.receptionInput();for(const request of input.resources)await prepareResourceRequest(this.plan.store,Buffer.from(canonical(request)),'receiver');await this.current();return runReception(input.path);}
 async report(){
  await this.current(false);const state=await QueueStore.observeConditionalEntryCatalog(this.plan.store,this.plan.id,hash(this.bytes),false),reports=[],seenMessages=new Set<string>();
  const original=async(read:()=>Promise<any>)=>{try{const result=await read();return {available:true,complete:result.phase==='produced'||result.complete===true||result.collectionComplete===true||result.completeCapture===true&&result.consumptionConfirmed===true&&result.state==='Reply',result};}catch(e){return {available:false,complete:false,reason:e instanceof Error&&/^[a-z0-9_:.-]+$/.test(e.message)?e.message:'original_report_unavailable'};}};
  const message=async(originPlan:string,item:string,key:string,run:string,messageId:string)=>{const identity=canonical([run,messageId]);if(seenMessages.has(identity))return;seenMessages.add(identity);reports.push({originPlan,key,kind:'message',...await original(()=>QueueStore.observeMessageReport(this.plan.store,item,run,messageId))});};
  const seenOutputs=new Set<string>();
  for(const history of state.identity?.history??[]){
   for(const output of history.outputs)if(!seenOutputs.has(output.sha256)){seenOutputs.add(output.sha256);reports.push({originPlan:history.originPlan,key:'capability:'+output.task+':'+output.capability+':'+output.sha256,kind:'capability',...await original(()=>QueueStore.observeCoordinationOutput(this.plan.store,history.originPlan,output.sha256))});}
   if(history.early)await message(history.early.originPlan,history.early.item,'early-advice',history.early.run,history.early.messageId);
   for(const step of history.entry?.steps??[]){
   if(step.reference.kind==='integration')reports.push({key:step.key,kind:'integration',...await original(()=>QueueStore.observeIntegration(this.plan.store,step.reference.id))});
   if(step.reference.kind==='member-recomposition')reports.push({originPlan:history.originPlan,key:step.key,kind:'member-recomposition',...await original(()=>QueueStore.observeConditionalMemberRecomposition(this.plan.store,step.reference.id))});
   if(step.reference.kind==='member-snapshot')reports.push({originPlan:history.originPlan,key:step.key,kind:'member-collection',...await original(async()=>{const collection=JSON.parse(step.request.toString()) as ConditionalMemberCollection;return {...await reportConditionalCollection(collection),latestSource:await QueueStore.observeConditionalCollectionSource(this.plan.store,collection,true)};})});
   if(step.reference.kind==='member-packet')reports.push({originPlan:history.originPlan,key:step.key,kind:'member-candidate',...await original(async()=>{const result=await QueueStore.observeConditionalCandidate(this.plan.store,step.reference.item);return {...result,complete:result.verification.executionComplete===true,individualReceptionInferred:false};})});
   if(step.reference.kind==='snapshot')reports.push({originPlan:history.originPlan,key:step.key,kind:'collection',...await original(async()=>{const collection=JSON.parse(step.request.toString()) as ConditionalCollection;return {...await reportConditionalCollection(collection),latestSource:await QueueStore.observeConditionalCollectionSource(this.plan.store,collection,true)};})});
   if(step.reference.kind==='validation')reports.push({originPlan:history.originPlan,key:step.key,kind:'validation',...await original(()=>QueueStore.observeCandidateValidationReport(this.plan.store,step.reference.id))});
   if(step.reference.kind==='packet')reports.push({originPlan:history.originPlan,key:step.key,kind:'candidate',...await original(()=>QueueStore.observeConditionalCandidate(this.plan.store,step.reference.item))});
   if(step.reference.kind==='repair')reports.push({originPlan:history.originPlan,key:step.key,kind:'repair',...await original(async()=>{const result=await QueueStore.observeQueueRepair(this.plan.store,step.reference.item,step.request,true);return {...result,complete:result.phase==='returned'&&result.controllerReturned===true&&Boolean(result.originalResult)&&Boolean(result.originalEvidence)};})});
   if(step.reference.kind==='receiver')reports.push({originPlan:history.originPlan,key:step.key,kind:'receiver',...await original(()=>QueueStore.observeConditionalReception(this.plan.store,step.reference.item,step.reference.operation))});
   if(step.reference.kind==='coordination')for(const ref of step.reference.runs??[]){const task=history.plan.tasks.find(t=>t.id===ref.task);if(!task)throw new Error('conditional_entry_report_task_changed');const messageId=ref.messageId??ref.historicalReuse?.messageId;if(messageId)await message(ref.historicalReuse?.planId??history.originPlan,task.item,ref.key,ref.run,messageId);}
   }
   for(const ref of history.dispatches){const task=history.plan.tasks.find(t=>t.id===ref.task);if(!task)throw new Error('conditional_entry_report_task_changed');await message(history.originPlan,task.item,ref.task+':'+ref.purpose,ref.run,ref.messageId);}
  }
  return {id:this.plan.id,earlyAdvice:state.earlyAdvice,reports,newModelInputs:0,technicalAcceptanceGranted:false};
 }
}
