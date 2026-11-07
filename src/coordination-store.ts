import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import { exactKeys } from './authority-contract.js';
import { coordinationPartId,coordinationPlanId,parseCoordinationPlan,integrationOutputKind,type CoordinationStage } from './coordination-contract.js';
import { messagePlanId,parseMessagePlan,messageId,messagePath,type MessagePlan } from './message-contract.js';
import {parseEarlyReceiverAdvice,earlyReceiverAdviceInstructions} from './early-receiver-contract.js';
import { parseCoordinationExecution,coordinationExecutionIdentity,coordinationTaskBody,coordinationMessageId,coordinationMessageAuthority,coordinationConsumptionStage,type CoordinationMessagePurpose } from './coordination-execution-contract.js';
import { join, dirname } from 'node:path';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import { projectModelTestResult } from './project-repair.js';
import {parseRepairContinuation} from './repair-continuation-contract.js';
import {requireManagedRepairCapture,type ManagedRepairCapture} from './workspace-handoff-originals.js';
import {selectExternalExecutable} from './external-executable.js';
import {installConditionalEntryGuards} from './conditional-entry-guards.js';

type Row=Record<string,any>;
type StageState={task:string;stage:CoordinationStage;blockers:string[];phasePrerequisitesMet:boolean;executionAuthorized:false};
/** Coordination facts use the original queue. Feedback can satisfy a technical
 * prerequisite; it never supplies a writing grant or an execution receipt. */
export class CoordinationRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private item:(id:string)=>Row,private message:(run:string)=>{state:Row;materials:Record<string,Buffer>;submitted:(participant:string)=>Row[]},private directory:string,private receiverSource:(operation:string,current:boolean)=>Row=()=>{throw new Error('coordination_original_receiver_source_required');},private publicationSource:(operation:string,current:boolean)=>Row=()=>{throw new Error('coordination_original_publication_source_required');},private integrationReceiptSource:(operation:string,current:boolean,published:boolean)=>Row=()=>{throw new Error('coordination_original_integration_reception_required');}){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('coordination_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(id:string,kind:string,data:Row){const bytes=Buffer.from(canonical(data)),sha=this.blob(bytes);this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('coordination_'+kind,'coordination:'+id,JSON.stringify({value:data,sha256:sha}),now());}
  private events(id:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'coordination_%' ORDER BY id").all('coordination:'+id) as Row[]).map(row=>{const v=JSON.parse(row.data);if(canonical(JSON.parse(this.bytes(v.sha256).toString()))!==canonical(v.value))throw new Error('coordination_index_changed');return {...row,data:v.value};});}
  private fixed(id:string){const events=this.events(id),registration=events.find(e=>e.kind==='coordination_registered')?.data;if(!registration)throw new Error('coordination_plan_not_registered');const plan=parseCoordinationPlan(this.bytes(registration.planSha256));if(coordinationPlanId(plan)!==id)throw new Error('coordination_plan_changed');return {id,plan,registration,events};}
  private latest(name:string){const row=this.db.prepare("SELECT object FROM events WHERE kind='coordination_registered' AND json_extract(data,'$.value.name')=? ORDER BY id DESC LIMIT 1").get(name) as Row;return row?this.fixed(row.object.slice(13)):null;}
  current(name:string){return this.transaction(()=>{const latest=this.latest(name);return latest?this.statusValue(latest.id):null;});}
  currentReference(name:string){return this.transaction(()=>{const f=this.latest(name);return f?{id:f.id,plan:f.plan}:null;});}
  reference(id:string){return this.transaction(()=>{const f=this.fixed(id);return {id,plan:f.plan,current:this.latest(f.plan.name)?.id===id};});}
  originalBindings(id:string){return this.transaction(()=>structuredClone(this.fixed(id).registration.bindings));}
  bindNormalEntry(id:string,entryId:string,catalog:Buffer,sourcePath:string){return this.transaction(()=>{
    const f=this.fixed(id),p=JSON.parse(catalog.toString());
    if(!messageId(entryId)||!messagePath(sourcePath)||p.kind!=='tongxu-conditional-delivery-entry'||p.id!==entryId||p.store!==this.directory||p.repository!==f.registration.bindings[f.plan.tasks[0]!.id].candidate.repository)throw new Error('conditional_entry_relation_mismatch');
    installConditionalEntryGuards(this.db);const sha256=this.blob(catalog),old=f.events.find(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===entryId);
    if(old){if(old.data.catalogSha256!==sha256||old.data.sourcePath!==sourcePath)throw new Error('conditional_entry_catalog_is_fixed');return {...old.data,duplicate:true};}
    const entry={entryId,catalogSha256:sha256,sourcePath};this.event(id,'normal_entry_bound',entry);return {...entry,duplicate:false};
  });}
  private normalEntryGate(f:ReturnType<CoordinationRecords['fixed']>){
    const direct=f.events.filter(e=>e.kind==='coordination_normal_entry_bound'),inherited=this.ancestry(f).slice(1).flatMap(p=>p.events.filter(e=>e.kind==='coordination_normal_entry_bound'));
    if(inherited.some(old=>!direct.some(entry=>entry.data.entryId===old.data.entryId)))throw new Error('conditional_entry_current_binding_required');
    for(const entry of f.events.filter(e=>e.kind==='coordination_normal_entry_bound')){
      try{const ref=entry.data,stat=lstatSync(ref.sourcePath);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>128*1024||realpathSync(ref.sourcePath)!==ref.sourcePath||hash(readFileSync(ref.sourcePath))!==ref.catalogSha256)throw new Error('conditional_entry_catalog_changed');
      }catch{throw new Error('conditional_entry_catalog_changed');}
    }
  }
  normalEntryStep(id:string,entryId:string,key:string,request:Buffer,reference:Row){return this.transaction(()=>{
    const f=this.fixed(id);if(!f.events.some(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===entryId)||!messageId(key)||request.length>2*1024*1024||!['message','coordination','receiver','integration','packet','snapshot','validation','repair','member-snapshot','member-recomposition','member-packet','integration-material'].includes(reference.kind))throw new Error('conditional_entry_step_invalid');
    const entry={entryId,key,requestSha256:this.blob(request),reference},old=f.events.find(e=>e.kind==='coordination_normal_entry_step'&&e.data.entryId===entryId&&e.data.key===key);
    if(old){if(canonical(old.data)!==canonical(entry))throw new Error('conditional_entry_step_is_fixed');return {...entry,request:this.bytes(entry.requestSha256),duplicate:true};}
    this.event(id,'normal_entry_step',entry);return {...entry,request,duplicate:false};
  });}
  normalEntry(id:string,entryId:string){return this.transaction(()=>{
    const f=this.fixed(id),bound=f.events.find(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===entryId)?.data;
    if(!bound)return null;this.bytes(bound.catalogSha256);
    return {...bound,steps:f.events.filter(e=>e.kind==='coordination_normal_entry_step'&&e.data.entryId===entryId).map(e=>({...e.data,request:this.bytes(e.data.requestSha256)}))};
  });}
  private entryHistory(id:string,entryId:string,key:string){
    for(const version of this.ancestry(this.fixed(id))){const entry=version.events.find(e=>e.kind==='coordination_normal_entry_step'&&e.data.entryId===entryId&&e.data.key===key)?.data;if(entry)return {...entry,originPlan:version.id,request:this.bytes(entry.requestSha256)};}
    return null;
  }
  normalEntryHistory(id:string,entryId:string,key:string){return this.transaction(()=>this.entryHistory(id,entryId,key));}
  /** Latest matching original in this relation's ancestry. Legacy task-only
   * keys remain readable; callers bind effects to the selected operation. */
  normalEntryTaskStep(id:string,entryId:string,kind:string,task:string,operation?:string){return this.transaction(()=>{
    for(const version of this.ancestry(this.fixed(id))){
      const entry=version.events.findLast(e=>e.kind==='coordination_normal_entry_step'&&e.data.entryId===entryId&&e.data.reference.kind===kind&&e.data.reference.task===task&&(operation===undefined||(e.data.reference.operation??e.data.reference.id)===operation))?.data;
      if(entry)return {...entry,originPlan:version.id,request:this.bytes(entry.requestSha256)};
    }return null;
  });}
  private normalRepairWorkspace(f:ReturnType<CoordinationRecords['fixed']>,task:Row,operation:string,raw:Buffer,request:Row){
    const step=f.events.find(e=>e.kind==='coordination_normal_entry_step'&&e.data.reference.kind==='repair'&&e.data.reference.task===task.id&&e.data.reference.id===operation&&e.data.requestSha256===hash(raw))?.data;
    if(!step||!JSON.parse(raw.toString()).continuation)return task.workspace;
    this.normalEntryGate(f);
    const workspace=join(dirname(dirname(task.workspace)),'conditional-repair-'+hash(canonical([step.entryId,task.id,operation])).slice(0,48),'workspace');
    if(join(request.executionRoot,'workspace')!==workspace)throw new Error('conditional_entry_exact_successor_workspace_required');
    return workspace;
  }

  normalEntryPacket(id:string,entryId:string,integration:string,materialKey:string){return this.transaction(()=>{
    for(const version of this.ancestry(this.fixed(id))){const ref=version.events.findLast(e=>e.kind==='coordination_normal_entry_step'&&e.data.entryId===entryId&&e.data.reference.kind==='packet'&&e.data.reference.integration===integration&&e.data.reference.materialKey===materialKey)?.data;if(ref)return {...ref,originPlan:version.id,request:this.bytes(ref.requestSha256)};}return null;
  });}
  normalEntryAncestor(id:string,entryId:string,origin:string,catalogSha256:string){return this.transaction(()=>{
    const chain=this.ancestry(this.fixed(id));return chain.some(f=>f.id===origin)&&chain.filter(f=>f.id===id||f.id===origin).every(f=>f.events.some(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===entryId&&e.data.catalogSha256===catalogSha256));
  });}
  normalEntryIdentity(entryId:string,catalogSha256:string){return this.transaction(()=>{
    const rows=this.db.prepare("SELECT object FROM events WHERE kind='coordination_normal_entry_bound' AND json_extract(data,'$.value.entryId')=? AND json_extract(data,'$.value.catalogSha256')=? ORDER BY id DESC").all(entryId,catalogSha256) as Row[],versions=rows.map(row=>this.fixed(row.object.slice(13))),names=[...new Set(versions.map(f=>f.plan.name))];
    if(!versions.length)return null;if(names.length!==1)throw new Error('conditional_entry_relation_ambiguous');
    return {name:names[0]!,template:versions[0]!.plan,history:versions.map(f=>{
      const early=this.earlySelected(f);
      const dispatches=f.events.filter(e=>e.kind==='coordination_dispatch_selected').map(e=>({task:e.data.task,purpose:e.data.purpose,run:e.data.run,messageId:e.data.messageId??coordinationMessageId(e.data.task,e.data.purpose)}));
      const outputs=f.events.filter(e=>e.kind==='coordination_output').map(e=>({task:e.data.task,capability:e.data.capability,sha256:e.data.sha256}));
      return {originPlan:f.id,plan:f.plan,entry:this.normalEntry(f.id,entryId),early:early?{originPlan:early.originPlan??f.id,run:early.run,messageId:early.messageId,item:early.item??f.plan.tasks.find(t=>f.plan.shared.some(part=>part.earlyReceiverAdvice&&part.tasks.includes(t.id)))!.item}:null,dispatches,outputs};
    })};
  });}
  requireNormalIntegration(operation:string,members:Row[]){return this.transaction(()=>{
    const rows=this.db.prepare("SELECT object,data FROM events WHERE kind='coordination_normal_entry_step' AND json_extract(data,'$.value.reference.kind') IN ('integration','integration-material') AND json_extract(data,'$.value.reference.operation')=?").all(operation) as Row[],seen=new Set<string>();
    for(const row of rows){const saved=JSON.parse(row.data).value,bound=this.fixed(row.object.slice(13)),current=this.latest(bound.plan.name)!,key=canonical([current.id,saved.entryId]);if(seen.has(key))continue;seen.add(key);this.normalEntryGate(current);
      const entry=bound.events.find(e=>e.kind==='coordination_normal_entry_step'&&e.data.entryId===saved.entryId&&e.data.key===saved.key)!.data,registration=bound.events.find(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===entry.entryId)!.data,catalog=JSON.parse(this.bytes(registration.catalogSha256).toString()),cap=catalog.integration;
      if(this.latest(bound.plan.name)!.id!==current.id||!current.events.some(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===entry.entryId&&e.data.catalogSha256===registration.catalogSha256))throw new Error('conditional_entry_new_relation_requires_integration_binding');
      if(cap.members.length!==members.length)throw new Error('conditional_entry_exact_combination_required');
      for(const [index,taskId] of cap.members.entries()){
        const {binding}=this.currentTask(current,taskId),member=members[index];if(!member||['repository','pr','H','B','targetRef'].some(key=>binding.candidate[key]!==member.candidate[key]))throw new Error('conditional_entry_combination_member_changed');
        const stage=this.stageState(current,taskId,cap.gateStage);if(stage.blockers.length)throw new Error(stage.blockers[0]);
      }
    }
  });}
  requireNormalReceiver(item:string,operation:string,planSha256?:string){return this.transaction(()=>{
    const rows=this.db.prepare("SELECT object,data FROM events WHERE kind='coordination_normal_entry_step' AND json_extract(data,'$.value.reference.kind')='packet' AND json_extract(data,'$.value.reference.item')=? ORDER BY id DESC").all(item) as Row[],seen=new Set<string>(),bindings:Row[]=[];
    for(const row of rows){const saved=JSON.parse(row.data).value,bound=this.fixed(row.object.slice(13)),current=this.latest(bound.plan.name)!,key=canonical([current.id,saved.entryId]);if(seen.has(key))continue;seen.add(key);this.normalEntryGate(current);
      const registration=bound.events.find(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===saved.entryId)!.data;
      if(!current.events.some(e=>e.kind==='coordination_normal_entry_bound'&&e.data.entryId===saved.entryId&&e.data.catalogSha256===registration.catalogSha256))throw new Error('conditional_entry_current_receiver_binding_required');
      const step=this.entryHistory(current.id,saved.entryId,'receiver-'+hash(saved.reference.id).slice(0,48));
      if(!step||step.reference.kind!=='receiver'||step.reference.item!==item||step.reference.operation!==operation||planSha256&&step.requestSha256!==planSha256)throw new Error('conditional_entry_original_receiver_required');
      bindings.push({entryId:saved.entryId,catalogSha256:registration.catalogSha256,originPlan:current.id,item,operation,requestSha256:step.requestSha256});
    }return bindings;
  });}
  private bindingSame(a:Row,b:Row){return b.current===true&&a.packet===b.packet&&a.fingerprint===b.fingerprint&&canonical(a.context.scope)===canonical(b.context.scope);}
  private currentTask(f:ReturnType<CoordinationRecords['fixed']>,taskId:string){const task=f.plan.tasks.find(t=>t.id===taskId);if(!task)throw new Error('coordination_task_missing');const binding=f.registration.bindings[taskId],current=this.item(task.item);if(!this.bindingSame(binding,current))throw new Error('coordination_task_candidate_or_material_changed');return {task,binding};}
  register(raw:Buffer){return this.transaction(()=>{
    const plan=parseCoordinationPlan(raw),id=coordinationPlanId(plan);if(this.events(id).length)return {...this.statusValue(id),duplicate:true};
    const previous=this.latest(plan.name);if((previous?.id??null)!==plan.previous)throw new Error('coordination_exact_previous_revision_required');
    if(previous&&previous.plan.revision===plan.revision)throw new Error('coordination_changed_plan_needs_new_revision');
    const bindings=Object.fromEntries(plan.tasks.map(t=>[t.id,this.item(t.item)])),first=bindings[plan.tasks[0]!.id]!;
    if(Object.values(bindings).some(b=>!b.current||b.candidate.repository!==first.candidate.repository||canonical(b.context.scope)!==canonical(first.context.scope)))throw new Error('coordination_common_current_scope_required');
    if(previous&&canonical(previous.registration.scope)!==canonical(first.context.scope))throw new Error('coordination_scope_change_needs_separate_adopted_plan');
    const parts=Object.fromEntries(plan.shared.map(part=>[part.id,hash(canonical({contract:coordinationPartId(plan,part),bindings:Object.fromEntries(part.tasks.map(t=>[t,bindings[t]]))}))]));
    this.event(id,'registered',{name:plan.name,planSha256:this.blob(Buffer.from(canonical(plan))),originalPlanSha256:this.blob(raw),bindings,parts,scope:first.context.scope,registeredAt:now()});return {...this.statusValue(id),duplicate:false};
  });}
  private ancestry(f:ReturnType<CoordinationRecords['fixed']>){const all=[f];let p=f.plan.previous;while(p){if(all.length>=64||all.some(x=>x.id===p))throw new Error('coordination_history_limit_or_cycle');const old=this.fixed(p);if(old.plan.name!==f.plan.name)throw new Error('coordination_history_name_changed');all.push(old);p=old.plan.previous;}return all;}
  private staleSharedTasks(f:ReturnType<CoordinationRecords['fixed']>,part:string){const shared=f.plan.shared.find(p=>p.id===part);if(!shared)throw new Error('coordination_shared_part_missing');return shared.tasks.filter(task=>{try{this.currentTask(f,task);return false;}catch{return true;}});}
  private feedbackFor(f:ReturnType<CoordinationRecords['fixed']>,part:string,task:string){
    for(const version of this.ancestry(f)){const result=version.events.findLast(e=>e.kind==='coordination_feedback'&&e.data.task===task&&e.data.part===part&&e.data.partHash===f.registration.parts[part]);if(result){this.verifiedReply(result.data.run,result.data.messageId);const staleTasks=this.staleSharedTasks(f,part);return {...result.data,recordedRevision:version.plan.revision,reusedFromPrevious:version.id!==f.id,currentApplicable:staleTasks.length===0,staleTasks};}}return null;
  }
  private earlyParts(f:ReturnType<CoordinationRecords['fixed']>){return f.plan.shared.filter(p=>p.earlyReceiverAdvice);}
  private earlyMeta(f:ReturnType<CoordinationRecords['fixed']>){
    const parts=this.earlyParts(f),ids=[...new Set(parts.flatMap(p=>p.tasks))];
    for(const id of ids)this.currentTask(f,id);
    const tasks=f.plan.tasks.filter(t=>ids.includes(t.id));
    return {schemaVersion:1,kind:'tongxu-early-receiver-material',name:f.plan.name,mode:f.plan.mode,relationSha256:hash(canonical([f.plan.name,parts.map(p=>p.id)])),scope:f.registration.scope,
      tasks,actors:f.plan.actors.filter(a=>tasks.some(t=>t.actor===a.id||t.originActor===a.id)),
      bindings:Object.fromEntries(ids.map(id=>[id,f.registration.bindings[id]])),
      shared:parts.map(p=>({...p,hash:f.registration.parts[p.id]})),
      consumers:f.plan.dependencies.filter(d=>ids.includes(d.task)||ids.includes(d.producer)),
      declaredWriteResponsibilities:tasks.map(t=>({task:t.id,actor:t.actor,workspace:t.workspace,publishBranch:t.publishBranch,independentPaths:t.independentPaths,sharedParts:parts.filter(p=>p.tasks.includes(t.id)).map(p=>p.id),actualWriterTerminationProven:false})),
      permissionsGranted:false,finalTechnicalJudgment:false};
  }
  private earlySelected(f:ReturnType<CoordinationRecords['fixed']>){return f.events.find(e=>e.kind==='coordination_early_advice_selected')?.data??null;}
  private earlyRequest(f:ReturnType<CoordinationRecords['fixed']>,requestSha256:string){
    if(!f.events.some(e=>e.kind==='coordination_execution_prepared'&&e.data.requestSha256===requestSha256))throw new Error('coordination_execution_request_required');
    const request=parseCoordinationExecution(this.bytes(requestSha256),f.plan);
    if(!request.earlyReceiver||!this.earlyParts(f).length)throw new Error('coordination_early_receiver_not_declared');
    return request;
  }
  /** Select one original early message, or the nearest identical historical
   * message. An incomplete nearest original is retained instead of skipped. */
  prepareEarlyAdvice(id:string,requestSha256:string,promptSha256:string,sources?:Array<{task:string;path:string;H:string;sha256:string;text:string}>){return this.transaction(()=>{
    const f=this.fixed(id),request=this.earlyRequest(f,requestSha256),early=request.earlyReceiver!,meta=this.earlyMeta(f),metaSha256=hash(canonical(meta));
    const {authorityIntent:_intent,...earlyCapability}=early;
    const capabilitySha256=hash(canonical({source:request.source,executionKind:request.executionKind,earlyReceiver:earlyCapability,timeoutMs:request.timeoutMs,promptSha256})),old=this.earlySelected(f);
    if(old)return {...old,plan:this.bytes(old.planSha256),material:this.bytes(old.materialSha256),duplicate:true};
    if(this.latest(f.plan.name)?.id!==id)throw new Error('coordination_new_dispatch_requires_current_revision');
    for(const version of this.ancestry(f).slice(1)){
      const selected=this.earlySelected(version);if(!selected||selected.metaSha256!==metaSha256||selected.capabilitySha256!==capabilitySha256)continue;
      const entry={...selected,requestSha256,originPlan:selected.originPlan??version.id,reusedOriginal:true};this.event(id,'early_advice_selected',entry);
      return {...entry,plan:this.bytes(entry.planSha256),material:this.bytes(entry.materialSha256),duplicate:false};
    }
    for(const version of this.ancestry(f).slice(1)){
      const previous=this.earlySelected(version);if(!previous)continue;let state:Row;
      try{state=this.message(previous.run).state;}catch(e){if(e instanceof Error&&e.message==='original_message_run_required')continue;throw e;}
      if(state.messages.some((m:Row)=>['Unknown','Delivered'].includes(m.state))||state.runtimes.some((r:Row)=>r.started&&(!r.ended||r.captureVerification?.proof.successfulCapture!==true&&r.ended.proof.knownUnstarted!==true)))throw new Error('early_receiver_prior_runtime_active_or_unknown');
      if(state.resourcesSettled!==true)throw new Error('early_receiver_prior_resources_unsettled');
    }
    if(!sources)return {needsSources:true,meta,metaSha256};
    const expected=Object.entries(early.sourcePaths).flatMap(([task,paths])=>paths.map(path=>({task,path,H:meta.bindings[task].candidate.H}))),seen=new Set<string>();
    if(sources.length!==expected.length||sources.some(s=>{const key=canonical([s.task,s.path]);if(seen.has(key)||!expected.some(e=>e.task===s.task&&e.path===s.path&&e.H===s.H)||typeof s.text!=='string'||hash(s.text)!==s.sha256)return true;seen.add(key);return false;}))throw new Error('coordination_early_receiver_source_changed');
    const material=Buffer.from(canonical({...meta,sources}));if(material.length>512*1024)throw new Error('coordination_early_receiver_material_limit');
    const materialSha256=this.blob(material),relationSha256=meta.relationSha256,binding={relationSha256,materialSha256,parts:this.earlyParts(f).map(p=>({id:p.id,hash:f.registration.parts[p.id]}))},directory=join(this.directory,'coordination-'+id,'early-receiver'),messageId='early-advice';
    const authority=request.delegatedCoordination?{authorityIntent:'coord-'+hash(canonical([id,'early-receiver',coordinationExecutionIdentity(request)])).slice(0,56),...(request.delegatedCoordination.resources.length?{resourceBudget:request.delegatedCoordination.resources}:{})}:{authorityIntent:early.authorityIntent};
    const plan:MessagePlan={schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:request.executionKind,source:request.source+'; early receiver '+id,...authority,participants:[{...early.actor,item:meta.tasks[0]!.item,role:'receiver',parent:null}],messages:[{id:messageId,from:null,to:early.actor.id,body:earlyReceiverAdviceInstructions(binding),replies:[]}],material:[{name:'early-receiver-context.json',path:join(directory,'context.json'),sha256:materialSha256}],consumeMaterial:['early-receiver-context.json'],billing:request.billing,timeoutMs:request.timeoutMs};
    const raw=Buffer.from(canonical(plan));parseMessagePlan(raw);
    const entry={originPlan:id,requestSha256,run:messagePlanId(plan),messageId,item:plan.participants[0]!.item,actor:early.actor.id,directory,planSha256:this.blob(raw),materialSha256,metaSha256,capabilitySha256,promptSha256,relationSha256,reusedOriginal:false};this.event(id,'early_advice_selected',entry);
    return {...entry,plan:raw,material,duplicate:false};
  });}
  private earlyAdviceValue(f:ReturnType<CoordinationRecords['fixed']>){
    const selected=this.earlySelected(f);if(!selected)throw new Error('early_receiver_advice_missing');
    const material=JSON.parse(this.bytes(selected.materialSha256).toString()),{sources,...meta}=material;
    if(hash(canonical(meta))!==selected.metaSha256||hash(canonical(this.earlyMeta(f)))!==selected.metaSha256)throw new Error('early_receiver_advice_material_changed');
    const {source,message,input}=this.verifiedReply(selected.run,selected.messageId),participant=source.state.plan.participants.find((p:Row)=>p.id===selected.actor);
    if(participant?.role!=='receiver'||participant.tool!=='codex'||source.state.registration.assemblies[selected.actor]?.sha256!==selected.promptSha256||source.state.resourcesSettled!==true||hash(source.materials['early-receiver-context.json']??Buffer.alloc(0))!==selected.materialSha256||!input.replyReferences.includes(selected.materialSha256))throw new Error('early_receiver_complete_original_required');
    const advice=parseEarlyReceiverAdvice(Buffer.from(message.reply.report),{relationSha256:selected.relationSha256,materialSha256:selected.materialSha256,parts:this.earlyParts(f).map(p=>({id:p.id,hash:f.registration.parts[p.id]}))});
    return {available:true as const,originPlan:selected.originPlan,run:selected.run,messageId:selected.messageId,materialSha256:selected.materialSha256,finalSha256:message.reply.finalSha256,fullOriginalReply:message.reply.finalText,advice,reusedOriginal:selected.originPlan!==f.id,readCurrentWholeArrangement:false,technicalAcceptanceGranted:false};
  }
  earlyAdvice(id:string){return this.transaction(()=>{const f=this.fixed(id);try{return this.earlyAdviceValue(f);}catch(e){return {available:false as const,reason:e instanceof Error?e.message:'early_receiver_advice_unknown',technicalAcceptanceGranted:false};}});}
  consumeEarlyAdvice(id:string,taskId:string,run:string,messageId:string){return this.transaction(()=>{
    const f=this.fixed(id),parts=this.earlyParts(f).filter(p=>p.tasks.includes(taskId));if(!parts.length)return {consumed:[],required:false};
    const bound=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===run)?.data;if(!bound?.mapping.some((m:Row)=>m.task===taskId&&m.messageId===messageId))throw new Error('coordination_original_message_binding_required');
    const advice=this.earlyAdviceValue(f),{source,input}=this.verifiedReply(run,messageId),bytes=source.materials['coordination-context.json'];
    if(!bytes||hash(bytes)!==bound.contextSha256||!input.replyReferences.includes(bound.contextSha256))throw new Error('early_receiver_exact_advice_not_consumed');
    const retained=JSON.parse(bytes.toString()).earlyReceiverAdvice;if(!retained?.available)return {consumed:[],required:true,pending:true};
    if(canonical(retained)!==canonical(advice))throw new Error('early_receiver_exact_advice_not_consumed');
    const consumed=parts.map(part=>{const entry={task:taskId,part:part.id,partHash:f.registration.parts[part.id],adviceRun:advice.run,adviceFinalSha256:advice.finalSha256,run,messageId,contextSha256:bound.contextSha256},old=f.events.find(e=>e.kind==='coordination_early_advice_consumed'&&e.data.task===taskId&&e.data.part===part.id&&e.data.adviceFinalSha256===advice.finalSha256);if(!old)this.event(id,'early_advice_consumed',entry);return entry;});
    return {consumed,required:true};
  });}
  private sameNormalEntry(a:ReturnType<CoordinationRecords['fixed']>,b:typeof a){return a.events.some(e=>e.kind==='coordination_normal_entry_bound'&&b.events.some(old=>old.kind===e.kind&&old.data.entryId===e.data.entryId&&old.data.catalogSha256===e.data.catalogSha256));}
  private taskMaterial(f:ReturnType<CoordinationRecords['fixed']>,task:string){
    const relevant=this.relevantTasks(f,[task]),tasks=f.plan.tasks.filter(t=>relevant.has(t.id)),actors=new Set(tasks.flatMap(t=>[t.actor,t.originActor]));
    return {mode:f.plan.mode,scope:f.registration.scope,tasks,actors:f.plan.actors.filter(a=>actors.has(a.id)),bindings:Object.fromEntries(tasks.map(t=>[t.id,f.registration.bindings[t.id]])),parts:f.plan.shared.filter(p=>p.tasks.some(t=>relevant.has(t))).map(part=>({part,hash:f.registration.parts[part.id]})),dependencies:f.plan.dependencies.filter(d=>relevant.has(d.task))};
  }
  private historicalTask(f:ReturnType<CoordinationRecords['fixed']>,task:string){
    const reused=f.events.find(e=>e.kind==='coordination_task_history_reused'&&e.data.task===task)?.data;if(!reused)return null;
    const origin=this.ancestry(f).find(p=>p.id===reused.origin.planId),selected=origin&&this.selected(origin,task,'investigate');
    if(!origin||!selected||!this.sameNormalEntry(f,origin)||canonical(this.taskMaterial(f,task))!==canonical(this.taskMaterial(origin,task))||selected.run!==reused.origin.run||selected.contextSha256!==reused.origin.contextSha256)throw new Error('coordination_original_task_history_changed');
    const original=this.verifiedReply(selected.run,reused.origin.messageId);if(original.source.state.resourcesSettled!==true)throw new Error('coordination_historical_result_or_resources_unresolved');return origin;
  }
  private outputFor(f:ReturnType<CoordinationRecords['fixed']>,task:string,capability:string):Row|undefined{
    const own=f.events.findLast(e=>e.kind==='coordination_output'&&e.data.task===task&&e.data.capability===capability)?.data;if(own)return own;
    const origin=this.historicalTask(f,task),output=origin?.events.findLast(e=>e.kind==='coordination_output'&&e.data.task===task&&e.data.capability===capability)?.data;return output?{...output,originPlan:origin!.id}:undefined;
  }
  private inputConsumed(f:ReturnType<CoordinationRecords['fixed']>,task:string,stage:CoordinationStage,sha256:string){
    const has=(version:typeof f)=>version.events.some(e=>e.kind==='coordination_consumed'&&e.data.task===task&&e.data.stage===stage&&e.data.outputSha256===sha256);
    return has(f)||Boolean(this.historicalTask(f,task)&&has(this.historicalTask(f,task)!));
  }
  private earlyConsumed(f:ReturnType<CoordinationRecords['fixed']>,task:string,part:string,advice:Row){
    const has=(version:typeof f)=>version.events.some(e=>e.kind==='coordination_early_advice_consumed'&&e.data.task===task&&e.data.part===part&&e.data.partHash===f.registration.parts[part]&&e.data.adviceRun===advice.run&&e.data.adviceFinalSha256===advice.finalSha256);
    return has(f)||Boolean(this.historicalTask(f,task)&&has(this.historicalTask(f,task)!));
  }
  private stageState(f:ReturnType<CoordinationRecords['fixed']>,taskId:string,stage:CoordinationStage,memo=new Map<string,StageState>()):StageState{
    const key=taskId+':'+stage,cached=memo.get(key);if(cached)return cached;
    const {task,binding}=this.currentTask(f,taskId);if(!task.stages.includes(stage))throw new Error('coordination_stage_not_planned');const blockers:string[]=[];memo.set(key,{task:taskId,stage,blockers:['coordination_integration_stage_cycle'],phasePrerequisitesMet:false,executionAuthorized:false});
    // The contract already rejects cycles across these at most forty stages.
    // Earlier required inputs must remain applicable; future stages do not gate this one.
    const earlier=task.stages[task.stages.indexOf(stage)-1];if(earlier){const before=this.stageState(f,taskId,earlier,memo);for(const reason of before.blockers)blockers.push('earlier_phase_not_current:'+earlier+':'+reason);}
    if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='investment' AND stopped=1").get(binding.context.scope.id))blockers.push('new_investment_stopped');
    if(stage==='implement'&&this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='implementation' AND stopped=1").get(binding.context.scope.id))blockers.push('implementation_stopped');
    if(stage!=='investigate'){
      if(this.latest(f.plan.name)?.id!==f.id)blockers.push('new_arrangement_requires_current_stage_binding');
      for(const part of f.plan.shared.filter(p=>p.tasks.includes(taskId)&&p.blockedStages.includes(stage))){for(const stale of this.staleSharedTasks(f,part.id))blockers.push('shared_candidate_or_material_changed:'+part.id+':'+stale);for(const source of part.feedbackFrom){const feedback=this.feedbackFor(f,part.id,source);if(feedback?.position!=='agreed')blockers.push('shared_feedback:'+part.id+':'+source+':'+(feedback?.position??'missing'));}}
      for(const part of this.earlyParts(f).filter(p=>p.tasks.includes(taskId)&&p.blockedStages.includes(stage))){
        try{const advice=this.earlyAdviceValue(f),position=advice.advice.parts.find(p=>p.id===part.id)!.position;
          if(position!=='compatible')blockers.push('early_receiver_advice:'+part.id+':'+position);
          if(!this.earlyConsumed(f,taskId,part.id,advice))blockers.push('early_receiver_advice_not_consumed:'+part.id);
        }catch(e){blockers.push('early_receiver_advice:'+part.id+':'+(e instanceof Error?e.message:'unknown'));}
      }
    }
    for(const dependency of f.plan.dependencies.filter(d=>d.task===taskId&&d.stage===stage)){
      try{this.currentTask(f,dependency.producer);}catch{blockers.push('capability_producer_changed:'+dependency.producer+':'+dependency.capability);continue;}
      const output=this.outputFor(f,dependency.producer,dependency.capability);
      if(!output){blockers.push('capability_missing:'+dependency.producer+':'+dependency.capability);continue;}
      let materialChanged=false;for(const task of this.relevantTasks(f,[dependency.producer],output.stage)){try{this.currentTask(f,task);}catch{blockers.push('capability_producer_changed:'+dependency.producer+':'+dependency.capability+':source:'+task);materialChanged=true;}}if(materialChanged)continue;
      try{this.requireCurrentOutput(f,output,memo);}
      catch(e){blockers.push('capability_producer_changed:'+dependency.producer+':'+dependency.capability+':'+(e instanceof Error?e.message:'coordination_source_unknown'));continue;}
      if(!this.inputConsumed(f,taskId,stage,output.sha256))blockers.push('capability_not_consumed:'+dependency.producer+':'+dependency.capability);
    }
    const result:StageState={task:taskId,stage,blockers,phasePrerequisitesMet:blockers.length===0,executionAuthorized:false};memo.set(key,result);return result;
  }
  stage(id:string,task:string,stage:CoordinationStage){return this.transaction(()=>this.stageState(this.fixed(id),task,stage));}
  /** Current eligibility follows the declared producer phase. Historical
   * originals and consumption receipts remain independently readable. */
  private requireCurrentOutput(f:ReturnType<CoordinationRecords['fixed']>,output:Row,memo=new Map<string,StageState>()){
    for(const task of this.relevantTasks(f,[output.task],output.stage))this.currentTask(f,task);
    const value=this.verifyOutput(output),source=this.stageState(f,output.task,output.stage,memo);
    if(source.blockers.length)throw new Error('coordination_producer_stage_not_current:'+source.blockers[0]);
    if(integrationOutputKind(output.kind)){
      const artifact=this.integrationReceiptSource(output.operation,true,output.kind==='integration_publication_readback'),members=this.integrationMembers(f,output.task,output.capability,artifact,memo);
      if(canonical(artifact)!==canonical(value.artifact)||canonical(members)!==canonical(value.members))throw new Error('coordination_integration_output_changed');
    }else if(output.kind==='receiver_judgment'){
      if(canonical(this.receiverSource(output.operation,true))!==canonical(value.artifact))throw new Error('coordination_receiver_output_original_changed');
    }else if(output.kind==='publication_readback'){
      if(canonical(this.publicationSource(output.operation,true))!==canonical(value.artifact))throw new Error('coordination_publication_output_original_changed');
    }
    return value;
  }
  private relevantTasks(f:ReturnType<CoordinationRecords['fixed']>,selectedTasks?:string[],selectedStage?:CoordinationStage){
    const relevant=new Set(selectedTasks??f.plan.tasks.map(t=>t.id));if(!relevant.size||[...relevant].some(id=>!f.plan.tasks.some(t=>t.id===id)))throw new Error('coordination_context_task_missing');
    const visited=new Set<string>();const visit=(id:string,stage:CoordinationStage)=>{
      const key=id+':'+stage;if(visited.has(key))return;visited.add(key);const task=f.plan.tasks.find(t=>t.id===id)!;if(!task.stages.includes(stage))throw new Error('coordination_stage_not_planned');relevant.add(id);
      const earlier=task.stages[task.stages.indexOf(stage)-1];if(earlier)visit(id,earlier);
      for(const output of task.outputs.filter(o=>integrationOutputKind(o.kind)&&o.stage===stage))for(const member of output.members!)visit(member,'investigate');
      for(const part of f.plan.shared.filter(p=>p.tasks.includes(id)&&(stage==='investigate'||p.blockedStages.includes(stage))))for(const peer of part.tasks)visit(peer,'investigate');
      for(const d of f.plan.dependencies.filter(d=>d.task===id&&d.stage===stage)){const producer=f.plan.tasks.find(t=>t.id===d.producer)!;visit(d.producer,producer.outputs.find(o=>o.id===d.capability)!.stage);}
    };for(const id of [...relevant]){const task=f.plan.tasks.find(t=>t.id===id)!;visit(id,selectedStage??task.stages.at(-1)!);}
    return relevant;
  }
  private contextValue(f:ReturnType<CoordinationRecords['fixed']>,selectedTasks?:string[],selectedStage?:CoordinationStage){
    const relevant=this.relevantTasks(f,selectedTasks,selectedStage);
    const nonCurrentTasks:string[]=[];for(const t of f.plan.tasks)try{this.currentTask(f,t.id);}catch(e){if(relevant.has(t.id))throw e;nonCurrentTasks.push(t.id);}
    const outputs:any[]=f.plan.tasks.flatMap(t=>t.outputs.flatMap(o=>{const output=this.outputFor(f,t.id,o.id);if(!output)return [];const row:Row={...output,text:this.bytes(output.sha256).toString()};if(integrationOutputKind(output.kind))row.individualReceptionInferred=false;try{this.requireCurrentOutput(f,output);row.sourceCurrent=true;}catch(e){row.sourceCurrent=false;row.sourceProblem=e instanceof Error?e.message:'coordination_source_unknown';}return [row];}));
    let earlyReceiverAdvice:ReturnType<CoordinationRecords['earlyAdvice']>|undefined;if(this.earlyParts(f).length){try{earlyReceiverAdvice=this.earlyAdviceValue(f);}catch(e){earlyReceiverAdvice={available:false,reason:e instanceof Error?e.message:'early_receiver_advice_unknown',technicalAcceptanceGranted:false};}}
    return {schemaVersion:1,kind:'tongxu-coordination-context',planId:f.id,name:f.plan.name,revision:f.plan.revision,scope:f.registration.scope,mode:f.plan.mode,tasks:f.plan.tasks,actors:f.plan.actors,bindings:f.registration.bindings,shared:f.plan.shared.map(p=>({...p,hash:f.registration.parts[p.id]})),dependencies:f.plan.dependencies,outputs,...(nonCurrentTasks.length?{sourceApplicability:{selectedTasks,...(selectedStage?{selectedStage}:{}),relevantTasks:[...relevant],nonCurrentTasks,originalBindingsPreserved:true,unrelatedOriginalsAreHistorical:true}}:{}),...(earlyReceiverAdvice?{earlyReceiverAdvice}:{}),permissionsGranted:false,responseContract:{kind:'tongxu-coordination-feedback',task:'exact assigned task id',revision:f.plan.revision,parts:'each affected part: id, hash, position (agreed/conflict/unknown), report',report:'complete substantive report; feedback is not writing authority'}};
  }
  context(id:string,selectedTasks?:string[],selectedStage?:CoordinationStage){return this.transaction(()=>{const f=this.fixed(id),value=this.contextValue(f,selectedTasks,selectedStage),bytes=Buffer.from(canonical(value));if(bytes.length>512*1024)throw new Error('coordination_complete_context_limit');const sha=this.blob(bytes);if(!f.events.some(e=>e.kind==='coordination_context_prepared'&&e.data.sha256===sha))this.event(id,'context_prepared',{sha256:sha});return {value,bytes,sha256:sha};});}
  private normalReceptionContextValue(f:ReturnType<CoordinationRecords['fixed']>,entryId:string,includeContext:boolean){
    const entry=f.events.find(event=>event.kind==='coordination_normal_entry_bound'&&event.data.entryId===entryId)?.data;
    if(!entry)throw new Error('conditional_entry_current_receiver_binding_required');
    const catalog=JSON.parse(this.bytes(entry.catalogSha256).toString()),cap=catalog.integration;
    const relevant=this.relevantTasks(f,cap.members,cap.gateStage);
    // Outputs and progress remain in the full context. They cannot make a
    // receiver's own result invalidate the request which produced it.
    const tasks=f.plan.tasks.filter(task=>relevant.has(task.id));
    const actorIds=new Set(tasks.flatMap(task=>[task.actor,task.originActor]));
    const semantic={scope:f.registration.scope,mode:f.plan.mode,tasks,
      actors:f.plan.actors.filter(actor=>actorIds.has(actor.id)),
      bindings:Object.fromEntries(tasks.map(task=>[task.id,f.registration.bindings[task.id]])),
      shared:f.plan.shared.filter(part=>part.tasks.some(task=>relevant.has(task))),
      dependencies:f.plan.dependencies.filter(dependency=>relevant.has(dependency.task)),
      members:cap.members,gateStage:cap.gateStage};
    return {value:includeContext?this.contextValue(f,cap.members,cap.gateStage):null,semanticSha256:hash(canonical(semantic))};
  }
  normalReceptionContext(id:string,entryId:string,includeContext=true){return this.transaction(()=>this.normalReceptionContextValue(this.fixed(id),entryId,includeContext));}
  requireNormalReceptionContext(ref:{coordination:string;entry:string;semanticSha256:string}){return this.transaction(()=>{
    const original=this.fixed(ref.coordination),current=this.latest(original.plan.name);
    const entry=original.events.find(event=>event.kind==='coordination_normal_entry_bound'&&event.data.entryId===ref.entry)?.data;
    if(!current||!entry||!this.ancestry(current).some(version=>version.id===original.id)||!current.events.some(event=>event.kind==='coordination_normal_entry_bound'&&event.data.entryId===ref.entry&&event.data.catalogSha256===entry.catalogSha256))throw new Error('conditional_entry_current_receiver_binding_required');
    const context=this.normalReceptionContextValue(current,ref.entry,false);
    if(context.semanticSha256!==ref.semanticSha256)throw new Error('conditional_entry_receiver_context_changed');
    return context;
  });}
  /** Attach the current arrangement to the original task inbox. An obsolete
   * assignment, ambiguous group or different actor is never silently adopted. */
  ownerContext(item:string,actor:string,tool:string){return this.transaction(()=>{
    const rows=this.db.prepare("SELECT DISTINCT json_extract(data,'$.value.name') AS name FROM events WHERE kind='coordination_registered'").all() as Row[],current=[];
    let historical=false;
    for(const row of rows){const f=this.latest(row.name)!;if(this.ancestry(f).some(p=>p.plan.tasks.some(t=>t.item===item)))historical=true;const task=f.plan.tasks.find(t=>t.item===item);if(task)current.push({f,task});}
    if(!current.length){if(historical)throw new Error('coordinated_task_removed_requires_explicit_followup');return null;}
    if(current.length!==1)throw new Error('task_coordination_selection_ambiguous');const {f,task}=current[0]!;
    if(task.actor!==actor||f.plan.actors.find(a=>a.id===actor)?.tool!==tool)throw new Error('task_coordination_original_actor_mismatch');
    const context=this.context(f.id);return {planId:f.id,task:task.id,sha256:context.sha256,bytes:context.bytes};
  });}
  ownerFeedback(id:string,taskId:string,run:string,messageId:string){return this.transaction(()=>{
    const f=this.fixed(id),{task}=this.currentTask(f,taskId),feedback=this.feedback(id,run,messageId);
    if(feedback.task!==taskId)throw new Error('task_coordination_feedback_mismatch');
    const outputs=task.outputs.filter(o=>o.stage==='investigate').map(o=>{
      const original=f.events.find(e=>e.kind==='coordination_output'&&e.data.task===taskId&&e.data.capability===o.id)?.data;
      if(original){this.verifyOutput(original);return {...original,reusedOriginal:true};}
      return this.recordMessageOutput(id,taskId,o.id,run,messageId);
    }),consumed=[],waiting=[];
    for(const stage of task.stages){try{consumed.push(this.consumeMessageInputs(id,taskId,stage,run,messageId));}catch(e){if((e as Error).message!=='coordination_exact_producer_output_not_consumed')throw e;waiting.push(stage);}}
    return {planId:id,task:taskId,feedback,outputs,consumed,waiting,writingPermissionGranted:false};
  });}
  execution(id:string,request:Buffer){return this.transaction(()=>{
    const f=this.fixed(id),parsed=parseCoordinationExecution(request,f.plan),identity=coordinationExecutionIdentity(parsed),old=f.events.find(e=>e.kind==='coordination_execution_prepared')?.data;if(old&&old.identity!==identity)throw new Error('coordination_original_execution_is_fixed');const requestSha256=this.blob(Buffer.from(canonical(parsed)));
    if(!f.events.some(e=>e.kind==='coordination_execution_prepared'&&e.data.requestSha256===requestSha256))this.event(id,'execution_prepared',{identity,requestSha256});return {identity,requestSha256};
  });}
  private selected(f:ReturnType<CoordinationRecords['fixed']>,task:string,purpose:string){return f.events.findLast(e=>e.kind==='coordination_dispatch_selected'&&e.data.task===task&&e.data.purpose===purpose)?.data??null;}
  private stageInputs(f:ReturnType<CoordinationRecords['fixed']>,task:string,stage:CoordinationStage){return f.plan.dependencies.filter(d=>d.task===task&&d.stage===stage).map(d=>{
    this.currentTask(f,d.producer);const output=this.outputFor(f,d.producer,d.capability);
    if(!output)throw new Error('coordination_precise_stage_output_missing');this.requireCurrentOutput(f,output);return output;
  });}
  private containsInputs(context:Row,outputs:Row[]){return outputs.every(output=>context.outputs.some((o:Row)=>o.task===output.task&&o.capability===output.capability&&o.sha256===output.sha256&&hash(o.text)===output.sha256&&o.sourceCurrent!==false));}
  /** Legacy phases retain one late read. A joint receipt's at most three
   * material versions may each be read only after the prior read ended fully.
   * Every selected original input and its first legacy slot stay immutable. */
  consumptionPurpose(id:string,task:string,stage:CoordinationStage):CoordinationMessagePurpose|null{return this.transaction(()=>{
    const f=this.fixed(id),state=this.stageState(f,task,stage);
    if(!state.blockers.some(b=>b.startsWith('capability_not_consumed:'))||state.blockers.some(b=>b.startsWith('capability_missing:')||b.startsWith('capability_producer_changed:')))return null;
    const outputs=this.stageInputs(f,task,stage),old=this.selected(f,task,'consume');
    if(!old||this.containsInputs(JSON.parse(this.bytes(old.contextSha256).toString()),outputs))return 'consume';
    const original=this.verifiedReply(old.run,coordinationMessageId(task,'consume'));
    if(original.source.state.resourcesSettled!==true)throw new Error('coordination_prior_consumption_resources_unsettled');
    const purposes:CoordinationMessagePurpose[]=['consume_'+stage as CoordinationMessagePurpose];if(outputs.some(o=>integrationOutputKind(o.kind)))purposes.push('consume_'+stage+'_2' as CoordinationMessagePurpose,'consume_'+stage+'_3' as CoordinationMessagePurpose);
    for(const purpose of purposes){const selected=this.selected(f,task,purpose);if(!selected||this.containsInputs(JSON.parse(this.bytes(selected.contextSha256).toString()),outputs))return purpose;const original=this.verifiedReply(selected.run,coordinationMessageId(task,purpose));if(original.source.state.resourcesSettled!==true)throw new Error('coordination_prior_consumption_resources_unsettled');}
    throw new Error('coordination_integration_consumption_limit');
  });}
  dispatchSelection(id:string,task:string,purpose:CoordinationMessagePurpose){return this.transaction(()=>{const selected=this.selected(this.fixed(id),task,purpose);return selected?{...selected,plan:this.bytes(selected.planSha256),context:this.bytes(selected.contextSha256)}:null;});}
  /** Reuse precise original history. Coupled reuse is opt-in through the same
   * fixed normal entry and requires its entire relevant component unchanged. */
  private taskHistoryOf(id:string,taskId:string,requestSha256:string,promptSha256:string){
    const f=this.fixed(id),{task,binding}=this.currentTask(f,taskId);
    const independent=(version:typeof f)=>{const t=version.plan.tasks.find(t=>t.id===taskId);return !!t&&!t.outputs.length&&!version.plan.shared.some(p=>p.tasks.includes(taskId))&&!version.plan.dependencies.some(d=>d.task===taskId||d.producer===taskId);};
    if(this.selected(f,taskId,'investigate')||!independent(f)&&!f.events.some(e=>e.kind==='coordination_normal_entry_bound'))return null;
    if(!f.events.some(e=>e.kind==='coordination_execution_prepared'&&e.data.requestSha256===requestSha256))throw new Error('coordination_execution_request_required');
    const request=parseCoordinationExecution(this.bytes(requestSha256),f.plan);
    const local=(p:ReturnType<typeof parseCoordinationExecution>)=>({source:p.source,executionKind:p.executionKind,actor:p.actors.find(a=>a.id===task.actor),body:p.taskBodies[taskId],timeoutMs:p.timeoutMs,authority:p.delegatedCoordination??p.authorityIntents[taskId]});
    for(const previous of this.ancestry(f).slice(1)){
      const oldTask=previous.plan.tasks.find(t=>t.id===taskId),old=this.selected(previous,taskId,'investigate');
      if(!old||canonical(oldTask)!==canonical(task)||canonical(previous.registration.bindings[taskId])!==canonical(binding))continue;
      if(!(independent(f)&&independent(previous))){if(!this.sameNormalEntry(f,previous)||canonical(this.taskMaterial(f,taskId))!==canonical(this.taskMaterial(previous,taskId)))continue;for(const t of this.relevantTasks(f,[taskId]))this.currentTask(f,t);}
      const before=parseCoordinationExecution(this.bytes(old.requestSha256),previous.plan);
      if(canonical(local(before))!==canonical(local(request)))continue;
      const plan=parseMessagePlan(this.bytes(old.planSha256)),actor=request.actors.find(a=>a.id===task.actor)!;
      if(messagePlanId(plan)!==old.run||plan.executionKind!==request.executionKind||plan.timeoutMs!==request.timeoutMs||canonical(plan.participants)!==canonical([{...actor,item:task.item,role:'issue_owner',parent:null}])||canonical(plan.messages)!==canonical([{id:coordinationMessageId(taskId,'investigate'),from:null,to:task.actor,body:coordinationTaskBody(request,taskId,'investigate'),replies:[]}]))throw new Error('coordination_original_dispatch_changed');
      // A matching selection without its original message is unresolved, not
      // permission to search past it for an older successful result or resend.
      const state=this.message(old.run).state;
      if(state.registration.assemblies[task.actor]?.sha256!==promptSha256)continue;
      const executable=state.runtimes.find((r:Row)=>r.participant===task.actor)?.ended?.originals['executable.json'];
      if(executable){const before=JSON.parse(this.bytes(executable.sha256).toString()),current=selectExternalExecutable(actor.executable);if(before.realpath!==current.realpath||before.sha256!==current.sha256)continue;}
      return {planId:previous.id,revision:previous.plan.revision,run:old.run,messageId:coordinationMessageId(taskId,'investigate'),contextSha256:old.contextSha256,planPath:join(old.directory,'plan.json')};
    }
    return null;
  }
  independentHistory(id:string,taskId:string,requestSha256:string,promptSha256:string){return this.transaction(()=>this.taskHistoryOf(id,taskId,requestSha256,promptSha256));}
  rememberTaskHistory(id:string,task:string,requestSha256:string,promptSha256:string,origin:Row){return this.transaction(()=>{
    const f=this.fixed(id);if(!f.events.some(e=>e.kind==='coordination_normal_entry_bound'))return;
    if(canonical(this.taskHistoryOf(id,task,requestSha256,promptSha256))!==canonical(origin))throw new Error('coordination_historical_source_changed');
    const original=this.verifiedReply(origin.run,origin.messageId);if(original.source.state.resourcesSettled!==true)throw new Error('coordination_historical_result_or_resources_unresolved');this.checkedFeedback(origin.planId,origin.run,origin.messageId);
    const value={task,origin,requestSha256,promptSha256,readCurrentRevision:false,permissionsGranted:false},old=f.events.find(e=>e.kind==='coordination_task_history_reused'&&e.data.task===task);if(old){if(canonical(old.data)!==canonical(value))throw new Error('coordination_original_task_history_changed');}else this.event(id,'task_history_reused',value);
  });}
  selectDispatch(id:string,taskId:string,purpose:CoordinationMessagePurpose,requestSha256:string,rawPlan:Buffer,contextSha256:string){return this.transaction(()=>{
    const f=this.fixed(id),{task}=this.currentTask(f,taskId),request=parseCoordinationExecution(this.bytes(requestSha256),f.plan),consumptionStage=coordinationConsumptionStage(purpose);if(!['investigate','consume','early_advice'].includes(purpose)&&!consumptionStage||consumptionStage&&!task.stages.includes(consumptionStage)||purpose==='early_advice'&&!this.earlyParts(f).some(p=>p.tasks.includes(taskId))||!f.events.some(e=>e.kind==='coordination_execution_prepared'&&e.data.requestSha256===requestSha256))throw new Error('coordination_execution_request_required');
    const prior=this.selected(f,taskId,purpose);if(prior){
      if(prior.requestSha256===requestSha256||!request.refreshUnsent)return prior;
      // A provider request is an actual investment even when no model input
      // has been sent. Keep its original selection; only append fresh billing
      // observations when resuming the same operation and claim.
      const resource=this.db.prepare("SELECT data FROM events WHERE kind='message_resource_bound' AND object=?").get('message-resource:'+prior.run) as Row;
      if(resource){const record=JSON.parse(resource.data);if(canonical(JSON.parse(this.bytes(record.sha256).toString()))!==canonical(record.value))throw new Error('coordination_original_resource_binding_changed');return prior;}
      let state:Row|null=null;try{state=this.message(prior.run).state;}catch(e){if(!(e instanceof Error)||e.message!=='original_message_run_required')throw e;}
      if(state&&(state.messages.some((m:Row)=>m.sent)||state.runtimes.some((r:Row)=>r.started&&r.ended?.proof.knownUnstarted!==true)))return prior;
      if(prior.attempt>=3)throw new Error('coordination_unstarted_preparation_limit');
    }
    const attempt=(prior?.attempt??0)+1,directory=join(this.directory,'coordination-'+id,'dispatch-'+hash(canonical([taskId,purpose])),'attempt-'+attempt),plan=parseMessagePlan(rawPlan),actor=request.actors.find(a=>a.id===task.actor)!;
    if(consumptionStage){const state=this.stageState(f,taskId,consumptionStage);if(!state.blockers.some(b=>b.startsWith('capability_not_consumed:'))||state.blockers.some(b=>b.startsWith('capability_missing:')||b.startsWith('capability_producer_changed:')))throw new Error('coordination_precise_stage_not_ready');}
    const expected={schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:request.executionKind,source:request.source+'; coordination '+id+' task '+taskId+' '+purpose,...coordinationMessageAuthority(request,id,taskId,purpose,attempt),participants:[{...actor,item:task.item,role:'issue_owner',parent:null}],messages:[{id:coordinationMessageId(taskId,purpose),from:null,to:actor.id,body:coordinationTaskBody(request,taskId,purpose),replies:[]}],material:[{name:'coordination-context.json',path:join(directory,'context.json'),sha256:contextSha256}],consumeMaterial:['coordination-context.json'],billing:request.billing,timeoutMs:request.timeoutMs};
    if(canonical(plan)!==canonical(expected)||!f.events.some(e=>e.kind==='coordination_context_prepared'&&e.data.sha256===contextSha256))throw new Error('coordination_selected_task_changed');
    const applicability=JSON.parse(this.bytes(contextSha256).toString()).sourceApplicability;if(applicability&&!applicability.selectedTasks.includes(taskId))throw new Error('coordination_context_not_for_task');
    if(consumptionStage&&!this.containsInputs(JSON.parse(this.bytes(contextSha256).toString()),this.stageInputs(f,taskId,consumptionStage)))throw new Error('coordination_precise_stage_input_required');
    const value={task:taskId,purpose,attempt,directory,run:messagePlanId(plan),messageId:plan.messages[0]!.id,planSha256:this.blob(rawPlan),contextSha256,requestSha256};this.event(id,'dispatch_selected',value);return value;
  });}
  bindMessages(id:string,raw:Buffer,contextSha256:string,mapping:Array<{task:string;messageId:string}>){return this.transaction(()=>{
    const f=this.fixed(id),plan=parseMessagePlan(raw),run=messagePlanId(plan),context=this.bytes(contextSha256);
    if(!f.events.some(e=>e.kind==='coordination_context_prepared'&&e.data.sha256===contextSha256)||!plan.material.some(m=>m.name==='coordination-context.json'&&m.sha256===contextSha256)||!plan.consumeMaterial?.includes('coordination-context.json'))throw new Error('coordination_exact_context_consumption_required');
    if(!Array.isArray(mapping)||!mapping.length||mapping.length>8||new Set(mapping.map(m=>m.messageId)).size!==mapping.length)throw new Error('coordination_message_mapping_invalid');
    const applicability=JSON.parse(context.toString()).sourceApplicability;if(applicability&&mapping.some(m=>!applicability.selectedTasks.includes(m.task)))throw new Error('coordination_context_not_for_task');
    for(const m of mapping){if(!exactKeys(m,['task','messageId']))throw new Error('coordination_message_mapping_invalid');const {task}=this.currentTask(f,m.task),message=plan.messages.find(x=>x.id===m.messageId),participant=plan.participants.find(p=>p.id===message?.to),actor=f.plan.actors.find(a=>a.id===task.actor)!;if(!participant||participant.id!==task.actor||participant.tool!==actor.tool||participant.item!==task.item||participant.role!=='issue_owner')throw new Error('coordination_assigned_role_or_tool_mismatch');}
    if(JSON.parse(context.toString()).planId!==id)throw new Error('coordination_context_plan_mismatch');
    const entry={run,planSha256:this.blob(Buffer.from(canonical(plan))),contextSha256,mapping},prior=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===run);
    if(prior){if(canonical(prior.data)!==canonical(entry))throw new Error('coordination_message_binding_changed');return {...entry,duplicate:true};}
    if(this.db.prepare("SELECT 1 FROM events WHERE kind='coordination_messages_bound' AND json_extract(data,'$.value.run')=?").get(run))throw new Error('coordination_message_run_already_bound');
    this.event(id,'messages_bound',entry);return {...entry,duplicate:false};
  });}
  private verifiedReply(run:string,messageId:string){
    const source=this.message(run),state=source.state,message=state.messages.find((m:Row)=>m.id===messageId),runtime=state.runtimes.find((r:Row)=>r.participant===message?.to);
    if(message?.state!=='Reply'||message.reply?.reportedConsumption!==true||runtime?.captureVerification?.proof.successfulCapture!==true)throw new Error('coordination_complete_original_reply_required');
    const input=source.submitted(message.to).find(x=>x.messageId===messageId);if(!input||hash(message.reply.finalText)!==message.reply.finalSha256)throw new Error('coordination_reply_input_missing');return {source,message,runtime,input};
  }
  private checkedFeedback(id:string,run:string,messageId:string){
    const f=this.fixed(id),bound=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===run)?.data,mapping=bound?.mapping.find((m:Row)=>m.messageId===messageId);if(!mapping)throw new Error('coordination_original_message_binding_required');
    const {source,message,input}=this.verifiedReply(run,messageId),context=source.materials['coordination-context.json'];
    if(!context||hash(context)!==bound.contextSha256||!input.replyReferences.includes(bound.contextSha256))throw new Error('coordination_original_context_changed');
    const feedback=JSON.parse(message.reply.report);
    if(!exactKeys(feedback,['kind','task','revision','parts','report'])||feedback.kind!=='tongxu-coordination-feedback'||feedback.task!==mapping.task||feedback.revision!==f.plan.revision||typeof feedback.report!=='string'||!feedback.report.trim()||!Array.isArray(feedback.parts)||feedback.parts.length>16||new Set(feedback.parts.map((p:Row)=>p?.id)).size!==feedback.parts.length)throw new Error('coordination_feedback_shape_invalid');
    for(const part of feedback.parts){const expected=f.plan.shared.find(p=>p.id===part.id&&p.feedbackFrom.includes(mapping.task));if(!exactKeys(part,['id','hash','position','report'])||!expected||part.hash!==f.registration.parts[part.id]||!['agreed','conflict','unknown'].includes(part.position)||typeof part.report!=='string'||!part.report.trim())throw new Error('coordination_feedback_part_mismatch');}
    return {f,mapping,message,feedback};
  }
  /** Validate the original report without recording feedback for any revision. */
  validateFeedback(id:string,run:string,messageId:string){return this.transaction(()=>{this.checkedFeedback(id,run,messageId);});}
  feedback(id:string,run:string,messageId:string){return this.transaction(()=>{
    const {f,mapping,message,feedback}=this.checkedFeedback(id,run,messageId);
    const reportSha256=this.blob(Buffer.from(message.reply.finalText));for(const part of feedback.parts){const entry={task:mapping.task,part:part.id,partHash:part.hash,position:part.position,run,messageId,reportSha256,partReport:part.report},old=f.events.find(e=>e.kind==='coordination_feedback'&&e.data.run===run&&e.data.messageId===messageId&&e.data.part===part.id);if(old){if(canonical(old.data)!==canonical(entry))throw new Error('coordination_feedback_original_changed');}else this.event(id,'feedback',entry);}
    return {planId:id,task:mapping.task,run,messageId,reportSha256,recordedRevision:f.plan.revision,currentRevision:this.latest(f.plan.name)!.plan.revision,writingPermissionGranted:false};
  });}
  /** Called inside the same queue transaction as message runtime registration
   * or send intent. A different task cannot race an active/unknown actor. */
  messageGate(run:string,messageId?:string,participant?:string){return this.transaction(()=>{
    const earlyLinks=this.db.prepare("SELECT object FROM events WHERE kind='coordination_early_advice_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(earlyLinks.length){
      const originals=earlyLinks.map(row=>this.fixed(row.object.slice(13))).filter(f=>this.earlySelected(f)?.originPlan===f.id);
      if(originals.length!==1)throw new Error('early_receiver_original_binding_ambiguous');const f=originals[0]!,selected=this.earlySelected(f)!;
      this.normalEntryGate(f);
      if(this.latest(f.plan.name)?.id!==f.id)throw new Error('coordination_new_dispatch_requires_current_revision');
      if(messageId&&messageId!==selected.messageId||participant&&participant!==selected.actor)throw new Error('early_receiver_message_not_selected');
      if(hash(canonical(this.earlyMeta(f)))!==selected.metaSha256)throw new Error('early_receiver_advice_material_changed');
      const state=this.message(run).state,expected=parseMessagePlan(this.bytes(selected.planSha256));
      if(canonical(state.plan)!==canonical(expected)||state.registration.assemblies[selected.actor]?.sha256!==selected.promptSha256)throw new Error('early_receiver_original_plan_changed');
      for(const part of this.earlyParts(f))for(const taskId of part.tasks){const {binding}=this.currentTask(f,taskId);if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='investment' AND stopped=1").get(binding.context.scope.id))throw new Error('new_investment_stopped');}
      return;
    }
    const links=this.db.prepare("SELECT object FROM events WHERE kind='coordination_messages_bound' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(!links.length){
      // A caller can change source text (or role/id) to obtain another hash.
      // Coordination follows the actual item/assigned actor, not only a known
      // run hash; the ordinary public message entry must enforce it too.
      const state=this.message(run).state,history=this.db.prepare("SELECT object FROM events WHERE kind='coordination_registered'").all() as Row[];
      // Removing a task from a later arrangement is not evidence that its
      // original execution ended or that its coordination binding was released.
      for(const {object} of history){const known=this.fixed(object.slice(13));for(const p of state.plan.participants){const binding=state.registration.bindings[p.id];if(known.plan.tasks.some(t=>t.item===p.item)||p.role==='issue_owner'&&canonical(binding.context.scope)===canonical(known.registration.scope)&&known.plan.tasks.some(t=>t.actor===p.id))throw new Error('coordinated_item_or_actor_requires_registered_message_binding');}}
      return;
    }
    if(links.length!==1)throw new Error('coordination_message_binding_ambiguous');const f=this.fixed(links[0]!.object.slice(13)),bound=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===run)!.data;
    this.normalEntryGate(f);
    if(this.latest(f.plan.name)?.id!==f.id)throw new Error('coordination_new_dispatch_requires_current_revision');
    const selected=bound.mapping.filter((m:Row)=>messageId?m.messageId===messageId:participant?f.plan.tasks.find(t=>t.id===m.task)?.actor===participant:true);if(!selected.length)throw new Error('coordination_message_not_planned');
    const dispatch=f.events.find(e=>e.kind==='coordination_dispatch_selected'&&e.data.run===run)?.data;if(dispatch&&this.selected(f,dispatch.task,dispatch.purpose)?.run!==run)throw new Error('coordination_old_dispatch_selection_superseded');
    const consumptionStage=dispatch?coordinationConsumptionStage(dispatch.purpose):null;
    if(consumptionStage){
      if(!this.stageState(f,dispatch!.task,consumptionStage).blockers.some(b=>b.startsWith('capability_not_consumed:')))throw new Error('coordination_precise_stage_already_consumed');
      if(!this.containsInputs(JSON.parse(this.bytes(bound.contextSha256).toString()),this.stageInputs(f,dispatch!.task,consumptionStage)))throw new Error('coordination_precise_stage_input_required');
    }
    for(const m of selected){const {task,binding}=this.currentTask(f,m.task),state=this.stageState(f,m.task,'investigate'),blocked=state.blockers.filter(b=>!b.startsWith('capability_not_consumed:'));if(blocked.length)throw new Error(blocked[0]);
      for(const row of this.db.prepare("SELECT id,object FROM events WHERE kind='coordination_repair_bound'").all() as Row[]){const assignment=this.events(row.object.slice(13)).find(e=>e.id===row.id)!.data;if(assignment.actor===task.actor&&canonical(assignment.scope)===canonical(f.registration.scope)&&!this.repairEnded(assignment.operation))throw new Error('coordination_actor_repair_active_or_unknown');}
      // This readonly message may perform the consumption itself. Its input
      // must already contain the exact available upstream output; later
      // implementation still requires a complete acknowledged reply.
      const context=JSON.parse(this.bytes(bound.contextSha256).toString());
      if(dispatch?.purpose==='consume'&&!task.stages.some(stage=>{
        const pending=this.stageState(f,m.task,stage);
        return pending.blockers.some(b=>b.startsWith('capability_not_consumed:'))&&!pending.blockers.some(b=>b.startsWith('capability_missing:')||b.startsWith('capability_producer_changed:'))&&this.containsInputs(context,this.stageInputs(f,m.task,stage));
      }))throw new Error('coordination_precise_stage_not_ready');
      for(const d of f.plan.dependencies.filter(d=>d.task===m.task)){
        const supplied=context.outputs.find((o:Row)=>o.task===d.producer&&o.capability===d.capability);
        if(d.stage==='investigate'&&(!supplied||supplied.sourceCurrent===false))throw new Error('coordination_precise_upstream_input_required');
        // An independent investigation can read explicitly historical future
        // inputs. A frozen input presented as current must remain applicable,
        // including the original legacy consume and contexts without flags.
        if(!supplied||supplied.sourceCurrent===false)continue;
        const output=this.outputFor(f,d.producer,d.capability);
        if(!output||supplied.sha256!==output.sha256||hash(supplied.text)!==output.sha256)throw new Error('coordination_precise_upstream_input_required');
        this.requireCurrentOutput(f,output);
      }
      for(const other of this.db.prepare("SELECT object,data FROM events WHERE kind='coordination_messages_bound' AND json_extract(data,'$.value.run')!=?").all(run) as Row[]){
        const previous=this.fixed(other.object.slice(13)),link=previous.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===JSON.parse(other.data).value.run)!.data;
        const priorActors=[...new Set<string>(link.mapping.flatMap((x:Row)=>{const prior=previous.plan.tasks.find(t=>t.id===x.task)!;return prior.actor===task.actor||previous.plan.name===f.plan.name&&prior.id===task.id?[prior.actor]:[];}))];
        if(canonical(previous.registration.scope)!==canonical(binding.context.scope)||!priorActors.length)continue;
        let native:Row;try{native=this.message(link.run).state;}catch(e){if(e instanceof Error&&e.message==='original_message_run_required')continue;throw e;}
        for(const actor of priorActors){const runtime=native.runtimes.find((r:Row)=>r.participant===actor);if(runtime?.started&&(!runtime.ended||runtime.captureVerification?.proof.successfulCapture!==true&&runtime.ended.proof.knownUnstarted!==true||native.messages.some((x:Row)=>x.to===actor&&['Unknown','Delivered'].includes(x.state))||native.resourcesSettled!==true))throw new Error('coordination_actor_active_or_unknown');}
      }
    }
  });}
  repairHandoff(id:string,taskId:string){return this.transaction(()=>{
    const f=this.fixed(id),{task}=this.currentTask(f,taskId),outputs=task.outputs.filter(o=>o.kind==='repair_candidate'&&o.stage==='implement');
    if(outputs.length!==1||!task.workspace||!task.publishBranch)throw new Error('conditional_entry_repair_task_not_configured');
    const stage=this.stageState(f,task.id,'implement');if(stage.blockers.length)throw new Error(stage.blockers[0]);
    const bound=f.events.findLast(e=>e.kind==='coordination_messages_bound'&&e.data.mapping.some((m:Row)=>m.task===task.id));
    const message=bound?.data.mapping.find((m:Row)=>m.task===task.id);if(!message)throw new Error('coordination_repair_original_task_reply_required');
    const original=this.verifiedReply(bound!.data.run,message.messageId);
    if(original.runtime.participant!==task.actor||!original.runtime.ended||original.source.state.resourcesSettled!==true)throw new Error('coordination_repair_original_task_not_ended');
    return {planId:id,task:task.id,capability:outputs[0]!.id,fromRun:bound!.data.run as string,fromMessage:message.messageId as string};
  });}
  recordMessageOutput(id:string,taskId:string,capability:string,run:string,messageId:string){return this.transaction(()=>{
    const f=this.fixed(id),{task,binding}=this.currentTask(f,taskId),output=task.outputs.find(o=>o.id===capability);if(output?.stage!=='investigate'||output.kind!=='message_report')throw new Error('coordination_message_is_not_implementation_evidence');
    const bound=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===run)?.data;if(!bound?.mapping.some((m:Row)=>m.task===taskId&&m.messageId===messageId))throw new Error('coordination_original_message_binding_required');
    const {message}=this.verifiedReply(run,messageId),value={schemaVersion:1,kind:'message_report',task:taskId,capability,binding,run,messageId,sessionId:message.reply.sessionId,turnId:message.reply.turnId,inputSha256:message.reply.inputSha256,finalSha256:message.reply.finalSha256,finalText:message.reply.finalText},sha256=this.blob(Buffer.from(canonical(value))),entry={task:taskId,capability,stage:'investigate',kind:'message_report',sha256,run,messageId},old=f.events.find(e=>e.kind==='coordination_output'&&e.data.task===taskId&&e.data.capability===capability);
    if(old){if(canonical(old.data)!==canonical(entry))throw new Error('coordination_original_capability_is_fixed');return {...entry,duplicate:true};}this.event(id,'output',entry);return {...entry,duplicate:false};
  });}
  consumeMessageInputs(id:string,taskId:string,stage:CoordinationStage,run:string,messageId:string){return this.transaction(()=>{
    const f=this.fixed(id);this.currentTask(f,taskId);const bound=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===run)?.data;if(!bound?.mapping.some((m:Row)=>m.task===taskId&&m.messageId===messageId))throw new Error('coordination_original_message_binding_required');
    const {source,input}=this.verifiedReply(run,messageId),bytes=source.materials['coordination-context.json'];if(!bytes||hash(bytes)!==bound.contextSha256||!input.replyReferences.includes(bound.contextSha256))throw new Error('coordination_exact_context_consumption_required');const context=JSON.parse(bytes.toString()),recorded=[];
    for(const d of f.plan.dependencies.filter(d=>d.task===taskId&&d.stage===stage)){
      this.currentTask(f,d.producer);const output=this.outputFor(f,d.producer,d.capability),consumed=context.outputs.find((o:Row)=>o.task===d.producer&&o.capability===d.capability);
      if(!output||!consumed||output.sha256!==consumed.sha256||hash(consumed.text)!==output.sha256||consumed.sourceCurrent===false)throw new Error('coordination_exact_producer_output_not_consumed');
      try{this.requireCurrentOutput(f,output);}catch{throw new Error('coordination_exact_producer_output_not_consumed');}
      const entry={task:taskId,stage,producer:d.producer,capability:d.capability,outputSha256:output.sha256,run,messageId,contextSha256:bound.contextSha256};if(!f.events.some(e=>e.kind==='coordination_consumed'&&canonical(e.data)===canonical(entry)))this.event(id,'consumed',entry);recorded.push(entry);
    }
    return {recorded,newPermissionGranted:false};
  });}
  private continuations():Row[]{return (this.db.prepare("SELECT id,object FROM events WHERE kind='coordination_repair_continued' ORDER BY id").all() as Row[]).map(row=>this.events(row.object.slice(13)).find(e=>e.id===row.id)!.data);}
  /** Recorded in the original queue, inside the same transaction as the new
   * repair reservation. A transient capture alone is never a write grant. */
  private continueRepair(entry:Row,plan:Row,request:Row,capture:ManagedRepairCapture|undefined,reserve:boolean){
    const records=this.continuations();
    if(records.some(r=>r.releasedOperations.includes(entry.operation)))throw new Error('coordination_original_responsibility_released');
    if(plan.continuation===undefined)return [] as string[];
    const p=parseRepairContinuation(plan.continuation),oldOp=this.db.prepare('SELECT * FROM operations WHERE id=?').get(p.operation) as Row,oldRepair=oldOp&&JSON.parse(oldOp.result)?.repair;
    if(p.operation===entry.operation||!oldRepair||oldOp.status!=='complete'||oldRepair.phase!=='returned'||oldRepair.controllerReturned!==true||oldRepair.bindingHash!==p.bindingHash||oldRepair.resultSha256!==p.resultSha256||oldRepair.evidenceSha256!==p.evidenceSha256)throw new Error('continuation_original_reconciliation_required');
    const oldPlan=JSON.parse(this.bytes(oldRepair.planSha256).toString()),oldRequest=JSON.parse(this.bytes(oldRepair.requestSha256).toString()),oldResult=JSON.parse(this.bytes(p.resultSha256).toString());this.bytes(p.evidenceSha256);
    if(!oldPlan.coordination)throw new Error('continuation_original_coordination_required');
    const old=this.fixed(oldPlan.coordination.planId),previous=old.events.find(e=>e.kind==='coordination_repair_bound'&&e.data.operation===p.operation)?.data,current=this.fixed(plan.coordination.planId),task=current.plan.tasks.find(t=>t.id===entry.task)!;
    if(!previous||previous.planSha256!==oldRepair.planSha256||previous.requestSha256!==oldRepair.requestSha256||previous.configSha256!==oldRepair.configSha256||entry.task!==previous.task||!this.ancestry(current).some(f=>f.id===old.id)||canonical(previous.scope)!==canonical(entry.scope)||request.candidate.H!==oldResult.after.H||request.candidate.repository!==oldRequest.candidate.repository||request.candidate.pr!==oldRequest.candidate.pr||request.candidate.target!==oldRequest.candidate.target||request.candidate.B!==oldRequest.candidate.B)throw new Error('continuation_exact_task_and_committed_candidate_required');
    if(p.mode==='same_owner'?entry.actor!==previous.actor:entry.actor===previous.actor||task.originActor!==previous.actor||task.dispatch==='owner_backlog')throw new Error('continuation_explicit_responsibility_mismatch');
    const same=(a:string,b:string)=>process.platform==='darwin'?a.toLowerCase()===b.toLowerCase():a===b;
    if(same(entry.workspace,previous.workspace)||same(request.executionRoot,oldRequest.executionRoot)||entry.workspace.startsWith(oldRequest.executionRoot+'/')||previous.workspace.startsWith(request.executionRoot+'/'))throw new Error('continuation_fresh_managed_workspace_required');
    const bound=records.find(r=>r.operation===entry.operation),previousContinuation=records.find(r=>r.operation===p.operation),releasedOperations=[...new Set([p.operation,...previousContinuation?.releasedOperations??[]])];
    if(records.some(r=>r.operation!==entry.operation&&r.priorOperation===p.operation))throw new Error('continuation_unique_successor_required');
    const binding={operation:entry.operation,priorOperation:p.operation,priorBindingHash:p.bindingHash,resultSha256:p.resultSha256,evidenceSha256:p.evidenceSha256,planSha256:entry.planSha256,requestSha256:entry.requestSha256,configSha256:entry.configSha256,priorActor:previous.actor,actor:entry.actor,priorWorkspace:previous.workspace,workspace:entry.workspace,priorPublishBranch:previous.publishBranch,publishBranch:entry.publishBranch,adoptedH:request.candidate.H,mode:p.mode,adoption:p.adoption,workspaceStateSha256:p.workspaceStateSha256,releasedOperations,newExecutionContext:true,nativeSessionResumed:false};
    if(bound){if(canonical(bound.binding)!==canonical(binding))throw new Error('continuation_original_binding_changed');this.bytes(bound.captureSha256);for(const sha of bound.originals)this.bytes(sha);return releasedOperations;}
    if(!capture)throw new Error('continuation_actual_original_capture_required');const c=requireManagedRepairCapture(capture);
    const signature=hash(canonical({operation:oldOp.id,status:oldOp.status,repair:oldRepair,plan:oldRepair.planSha256,request:oldRepair.requestSha256,config:oldRepair.configSha256}));
    if(c.reference.operation!==p.operation||c.reference.bindingHash!==p.bindingHash||c.sourceSignature!==signature||c.workspaceStateSha256!==p.workspaceStateSha256||c.workspace.H!==request.candidate.H||c.workspace.workspace!==previous.workspace||c.workspace.writerLease!==null||c.workspace.unmergedPaths.length||this.db.prepare('SELECT 1 FROM claims WHERE operation=?').get(p.operation))throw new Error('continuation_original_state_changed_or_occupied');
    if(reserve){
      const originals=[...c.originals].map(([sha,b])=>{if(hash(b)!==sha)throw new Error('continuation_original_changed');return this.blob(b);});
      const workspace=c.workspace,changes={staged:workspace.stagedPaths.map(path=>({path,before:workspace.headEntries.filter(e=>e.path===path),after:workspace.indexEntries.filter(e=>e.path===path)})),unstaged:workspace.workingPaths.map(path=>({path,before:workspace.indexEntries.filter(e=>e.path===path),after:workspace.files[path]??null})),untracked:workspace.untrackedPaths};
      const proof={reference:c.reference,sourceSignature:c.sourceSignature,workspace,changes,registeredExecutionsEnded:true,processes:c.processes,dockerExecutions:c.dockerExecutions,originalControllerExclusivelyHeld:true,uncommittedPolicy:'preserved_separately_not_applied',adoptedH:request.candidate.H,writePermissionGranted:false};
      this.event(current.id,'repair_continued',{...binding,binding,captureSha256:this.blob(Buffer.from(canonical(proof))),originals,at:now(),source:p.source});
    }
    return releasedOperations;
  }
  continuation(operation:string):Row|null{return this.transaction(()=>{const row=this.continuations().find(r=>r.operation===operation);if(!row)return null;return {...row,capture:JSON.parse(this.bytes(row.captureSha256).toString()),writePermissionGranted:false};});}
  /** Same-transaction check at repair reservation and every subsequent effect.
   * This accepts only a fresh program-managed workspace after a completed
   * owned readonly task. It does not take over an external writer or App. */
  repairGate(operation:string,proposed?:{plan:Buffer;request:Buffer;config:Buffer},reserve=true,capture?:ManagedRepairCapture){return this.transaction(()=>{
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row;if(!op)throw new Error('operation_not_found');
    const repair=JSON.parse(op.result)?.repair,raw=proposed?.plan??(repair?this.bytes(repair.planSha256):null),p=raw?JSON.parse(raw.toString()):null;
    const history=(this.db.prepare("SELECT object FROM events WHERE kind='coordination_registered'").all() as Row[]).map(x=>this.fixed(x.object.slice(13))).filter(f=>f.plan.tasks.some(t=>t.item===op.item));
    if(!p?.coordination){if(history.length||p?.continuation)throw new Error('coordination_explicit_write_handoff_required');return;}
    const ref=p.coordination,f=this.fixed(ref.planId),{task,binding}=this.currentTask(f,ref.task),requestBytes=proposed?.request??this.bytes(repair.requestSha256),configBytes=proposed?.config??this.bytes(repair.configSha256),request=JSON.parse(requestBytes.toString()),config=JSON.parse(configBytes.toString());
    if(history.some(h=>h.plan.name!==f.plan.name))throw new Error('coordination_item_has_multiple_arrangements');
    const output=task.outputs.find(o=>o.id===ref.capability),actor=f.plan.actors.find(a=>a.id===task.actor),workspace=this.normalRepairWorkspace(f,task,operation,raw!,request);
    if(task.item!==op.item||binding.packet!==op.packet||actor?.tool!=='codex'||output?.kind!=='repair_candidate'||output.stage!=='implement'||!task.workspace||workspace!==join(request.executionRoot,'workspace')||!task.publishBranch||request.authorization?.allowRepair!==true)throw new Error('coordination_exact_repair_task_workspace_required');
    const paths=[...task.independentPaths,...f.plan.shared.filter(s=>s.tasks.includes(task.id)).flatMap(s=>s.paths)];if(!Array.isArray(request.allowedPaths)||!request.allowedPaths.length||request.allowedPaths.some((path:string)=>!paths.includes(path)))throw new Error('coordination_repair_path_not_assigned');
    const stage=this.stageState(f,task.id,'implement');if(stage.blockers.length)throw new Error(stage.blockers[0]);
    const bound=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===ref.fromRun)?.data;
    if(!bound?.mapping.some((m:Row)=>m.task===task.id&&m.messageId===ref.fromMessage))throw new Error('coordination_repair_original_task_reply_required');
    const original=this.verifiedReply(ref.fromRun,ref.fromMessage);
    if(original.runtime.participant!==task.actor||!original.runtime.ended||original.source.state.plan.executionKind!==(config.executionKind??'native_capture'))throw new Error('coordination_repair_original_task_not_ended');
    // A finished report does not erase a separate active or unknown run using
    // the same responsible actor. These are original managed runtime records.
    for(const row of this.db.prepare("SELECT object,data FROM events WHERE kind='coordination_messages_bound'").all() as Row[]){
      const other=this.fixed(row.object.slice(13)),link=JSON.parse(row.data).value;if(canonical(other.registration.scope)!==canonical(f.registration.scope)||!link.mapping.some((m:Row)=>other.plan.tasks.find(t=>t.id===m.task)?.actor===task.actor))continue;
      let state:Row;try{state=this.message(link.run).state;}catch(e){if(e instanceof Error&&e.message==='original_message_run_required')continue;throw e;}
      const runtime=state.runtimes.find((r:Row)=>r.participant===task.actor);if(runtime?.started&&(!runtime.ended||runtime.captureVerification?.proof.successfulCapture!==true&&runtime.ended.proof.knownUnstarted!==true||state.messages.some((m:Row)=>m.to===task.actor&&['Unknown','Delivered'].includes(m.state))))throw new Error('coordination_actor_active_or_unknown');
    }
    const entry={task:task.id,capability:ref.capability,operation,item:op.item,packet:op.packet,actor:task.actor,workspace,publishBranch:task.publishBranch,repository:binding.candidate.repository,scope:f.registration.scope,planSha256:hash(raw!),requestSha256:hash(requestBytes),configSha256:hash(configBytes),fromRun:ref.fromRun,fromMessage:ref.fromMessage,priorSessionId:original.message.reply.sessionId,priorTurnId:original.message.reply.turnId,newExecutionContext:true,nativeSessionResumed:false,startMode:'new_managed_workspace'};
    const released=this.continueRepair(entry,p,request,capture,reserve);
    for(const row of this.db.prepare("SELECT id,object FROM events WHERE kind='coordination_repair_bound'").all() as Row[]){
      const x=this.events(row.object.slice(13)).find(e=>e.id===row.id)!.data;
      if(x.operation===operation){if(canonical(x)!==canonical(entry)&&!(repair?.phase==='closed_unstarted'&&p.replacesClosedBinding===repair.bindingHash&&x.workspace!==entry.workspace))throw new Error('coordination_original_repair_binding_changed');continue;}
      const samePath=(a:string,b:string)=>process.platform==='darwin'?a.toLowerCase()===b.toLowerCase():a===b;
      if(released.includes(x.operation))continue;
      const sameTask=this.fixed(row.object.slice(13)).plan.name===f.plan.name&&x.task===entry.task;
      if(samePath(x.workspace,entry.workspace)||x.repository===entry.repository&&x.publishBranch===entry.publishBranch||canonical(x.scope)===canonical(entry.scope)&&(sameTask||x.actor===entry.actor&&!this.repairEnded(x.operation)))throw new Error('coordination_write_responsibility_held');
    }
    if(reserve&&!f.events.some(e=>e.kind==='coordination_repair_bound'&&e.data.operation===operation))this.event(f.id,'repair_bound',entry);
    return entry;
  });}
  private repairEnded(operation:string){const row=this.db.prepare('SELECT status,result FROM operations WHERE id=?').get(operation) as Row,repair=row&&JSON.parse(row.result)?.repair;return row?.status==='complete'&&repair?.controllerReturned===true&&['returned','closed_unstarted'].includes(repair.phase);}
  private repairResultView(result:Row){return {status:result.status,before:result.before,after:result.after,sourceCandidate:result.sourceCandidate,treeSha256:result.treeSha256,executionKind:result.executionKind,demonstrationFixture:result.demonstrationFixture,actualRepairPerformed:result.actualRepairPerformed,tests:projectModelTestResult(result.data.tests),testCandidateBinding:result.data.testCandidateBinding,review:result.data.review};}
  private verifyOutput(output:Row){
    const value=JSON.parse(this.bytes(output.sha256).toString());
    if(output.kind==='message_report'){this.verifiedReply(output.run,output.messageId);return value;}
    if(integrationOutputKind(output.kind)){if(canonical(this.integrationReceiptSource(output.operation,false,output.kind==='integration_publication_readback'))!==canonical(value.artifact))throw new Error('coordination_integration_output_original_changed');return value;}
    if(output.kind==='receiver_judgment'){
      if(canonical(this.receiverSource(output.operation,false))!==canonical(value.artifact))throw new Error('coordination_receiver_output_original_changed');return value;
    }
    if(output.kind==='publication_readback'){
      if(canonical(this.publicationSource(output.operation,false))!==canonical(value.artifact))throw new Error('coordination_publication_output_original_changed');return value;
    }
    if(output.kind!=='repair_candidate')throw new Error('coordination_output_consumer_not_implemented');
    const op=this.db.prepare('SELECT result FROM operations WHERE id=?').get(output.operation) as Row,repair=op&&JSON.parse(op.result).repair;
    if(!repair||repair.phase!=='returned'||repair.resultSha256!==value.resultSha256||repair.evidenceSha256!==value.evidenceSha256||canonical(this.repairResultView(JSON.parse(this.bytes(repair.resultSha256).toString())))!==canonical(value.artifact.result))throw new Error('coordination_repair_output_original_changed');this.bytes(repair.evidenceSha256);return value;
  }
  recordRepairOutput(operation:string,artifact:Buffer){return this.transaction(()=>{
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row,repair=op&&JSON.parse(op.result).repair;if(!repair||repair.phase!=='returned'||op.status!=='complete')throw new Error('coordination_completed_repair_required');
    const plan=JSON.parse(this.bytes(repair.planSha256).toString()),ref=plan.coordination;if(!ref)throw new Error('coordination_original_repair_binding_required');const f=this.fixed(ref.planId),bound=f.events.find(e=>e.kind==='coordination_repair_bound'&&e.data.operation===operation)?.data,result=JSON.parse(this.bytes(repair.resultSha256).toString()),value=JSON.parse(artifact.toString());
    if(!bound||bound.planSha256!==repair.planSha256||bound.requestSha256!==repair.requestSha256||bound.configSha256!==repair.configSha256||artifact.length>1024*1024||!['completed','completed_recovered_candidate'].includes(result.status)||result.actualRepairPerformed!==true||result.data?.tests?.passed!==true||result.data?.review?.verdict!=='PASS'||result.data.review.candidateH!==result.after.H||canonical(value.result)!==canonical(result)||!value.material||typeof value.diff!=='string')throw new Error('coordination_verified_new_repair_candidate_required');
    // Full test logs stay in the original private result. Consumers get the
    // selected source/diff, complete independent report and host test facts.
    const output={schemaVersion:1,kind:'repair_candidate',task:ref.task,capability:ref.capability,binding:f.registration.bindings[ref.task],operation,workspace:bound.workspace,publishBranch:bound.publishBranch,resultSha256:repair.resultSha256,evidenceSha256:repair.evidenceSha256,artifact:{...value,result:this.repairResultView(result)}},sha256=this.blob(Buffer.from(canonical(output))),entry={task:ref.task,capability:ref.capability,stage:'implement',kind:'repair_candidate',sha256,operation,afterH:result.after.H},old=f.events.find(e=>e.kind==='coordination_output'&&e.data.task===ref.task&&e.data.capability===ref.capability);
    if(old){if(canonical(old.data)!==canonical(entry))throw new Error('coordination_original_capability_is_fixed');return {...entry,duplicate:true};}this.verifyOutput(entry);this.event(f.id,'output',entry);return {...entry,duplicate:false};
  });}
  private integrationMembers(f:ReturnType<CoordinationRecords['fixed']>,taskId:string,capability:string,artifact:Row,memo?:Map<string,StageState>){
    const definition=f.plan.tasks.find(t=>t.id===taskId)?.outputs.find(o=>o.id===capability),proof=artifact.integration;if(!definition||!integrationOutputKind(definition.kind)||!proof||proof.subject.members.length!==definition.members!.length||canonical(artifact.context.scope)!==canonical(f.registration.scope)||artifact.individualReceptionInferred!==false)throw new Error('coordination_exact_integration_scope_required');
    const members=definition.members!.map((id,index)=>{const {task,binding}=this.currentTask(f,id),source=proof.subject.members[index];if(!source||['repository','pr','H','B','targetRef'].some(k=>binding.candidate[k]!==source.candidate[k])||canonical(binding.context)!==canonical(artifact.context))throw new Error('coordination_integration_member_changed');
      if(proof.normal){const normal=proof.normal,origin=this.ancestry(f).find(p=>p.id===normal.planId);if(!origin||!this.sameNormalEntry(f,origin)||canonical(normal.members)!==canonical(definition.members)||canonical(normal.bindings[id])!==canonical(binding)||canonical(origin.registration.bindings[id])!==canonical(binding))throw new Error('coordination_integration_original_member_binding_changed');
        const parts=(version:typeof f)=>version.plan.shared.filter(p=>p.tasks.some(t=>definition.members!.includes(t))).map(p=>({id:p.id,hash:version.registration.parts[p.id]}));if(canonical(parts(f))!==canonical(parts(origin)))throw new Error('coordination_integration_shared_contract_changed');
      }else{const packet=this.db.prepare('SELECT manifest_hash FROM packets WHERE id=? AND item=?').get(binding.packet,task.item) as Row|undefined;if(packet?.manifest_hash!==source.manifestHash)throw new Error('coordination_integration_original_member_manifest_required');}
      if(memo){const gate=proof.normal?.gateStage??(task.stages.includes('implement')?'implement':'investigate');if(!(task.id===taskId&&gate===definition.stage)){const stage=this.stageState(f,task.id,gate,memo);if(stage.blockers.length)throw new Error('coordination_integration_member_stage_not_ready:'+task.id+':'+stage.blockers[0]);}}
      return {task:id,binding};
    });return members;
  }
  integrationOutputMatches(id:string,task:string,capability:string,operation:string,published=false){return this.transaction(()=>{try{const f=this.fixed(id),artifact=this.integrationReceiptSource(operation,true,published);this.integrationMembers(f,task,capability,artifact);return true;}catch{return false;}});}
  /** A joint receipt can advance only its declared group. Material revisions
   * append accurate originals, with the physical candidate's existing limit. */
  recordIntegrationOutput(id:string,taskId:string,capability:string,operation:string,published=false){return this.transaction(()=>{
    const f=this.fixed(id),{task,binding}=this.currentTask(f,taskId),kind=published?'integration_publication_readback':'integration_receiver_judgment',definition=task.outputs.find(o=>o.id===capability);if(definition?.kind!==kind)throw new Error('coordination_integration_capability_not_declared');const stage=this.stageState(f,taskId,definition.stage);if(stage.blockers.length)throw new Error(stage.blockers[0]);
    const artifact=this.integrationReceiptSource(operation,true,published),members=this.integrationMembers(f,taskId,capability,artifact,new Map());
    const previous=f.events.filter(e=>e.kind==='coordination_output'&&e.data.task===taskId&&e.data.capability===capability),old=previous.at(-1)?.data;
    if(old){const value=this.verifyOutput(old);if(old.operation===operation){if(canonical(value.artifact)!==canonical(artifact)||canonical(value.members)!==canonical(members))throw new Error('coordination_original_capability_is_fixed');return {...old,duplicate:true};}if(old.kind!==kind||value.artifact.item!==artifact.item||canonical(value.artifact.integration.privateCandidate)!==canonical(artifact.integration.privateCandidate)||value.artifact.integration.subjectSha256!==artifact.integration.subjectSha256)throw new Error('coordination_integration_new_candidate_requires_revision');}
    if(previous.length>=3)throw new Error('coordination_integration_output_revision_limit');const value={schemaVersion:1,kind,task:taskId,capability,binding,members,operation,artifact,outputRevision:previous.length+1,previousOutputSha256:old?.sha256??null,individualReceptionInferred:false},bytes=Buffer.from(canonical(value));if(bytes.length>768*1024)throw new Error('coordination_integration_output_limit');
    const entry={task:taskId,capability,stage:definition.stage,kind,sha256:this.blob(bytes),operation};this.verifyOutput(entry);this.event(id,'output',entry);return {...entry,duplicate:false};
  });}
  outputOriginal(id:string,sha256:string){return this.transaction(()=>{const f=this.fixed(id),output=f.events.find(e=>e.kind==='coordination_output'&&e.data.sha256===sha256)?.data;if(!output)throw new Error('coordination_original_output_required');return {value:this.verifyOutput(output),complete:true,historicalObservationOnly:true,permissionsGranted:false};});}
  /** Reuse an existing exact accepted candidate. This registers its original
   * receive result; it never manufactures a repair or repeats a model input. */
  recordReceiverOutput(id:string,taskId:string,capability:string,operation:string){return this.transaction(()=>{
    const f=this.fixed(id),{task,binding}=this.currentTask(f,taskId),definition=task.outputs.find(o=>o.id===capability);
    if(definition?.stage!=='receive'||definition.kind!=='receiver_judgment')throw new Error('coordination_receiver_capability_not_declared');
    const stage=this.stageState(f,taskId,'receive');if(stage.blockers.length)throw new Error(stage.blockers[0]);
    const artifact=this.receiverSource(operation,true);
    if(artifact.item!==task.item||artifact.packet!==binding.packet||artifact.fingerprint!==binding.fingerprint||canonical(artifact.candidate)!==canonical(binding.candidate)||canonical(artifact.context)!==canonical(binding.context)||artifact.judgment?.verdict!=='ACCEPT_WITHIN_SCOPE')throw new Error('coordination_exact_accepted_receiver_required');
    const value={schemaVersion:1,kind:'receiver_judgment',task:taskId,capability,binding,operation,artifact},bytes=Buffer.from(canonical(value));
    if(bytes.length>512*1024)throw new Error('coordination_receiver_output_limit');
    const entry={task:taskId,capability,stage:'receive',kind:'receiver_judgment',sha256:this.blob(bytes),operation},old=f.events.find(e=>e.kind==='coordination_output'&&e.data.task===taskId&&e.data.capability===capability);
    if(old){if(canonical(old.data)!==canonical(entry))throw new Error('coordination_original_capability_is_fixed');return {...entry,duplicate:true};}
    this.verifyOutput(entry);this.event(id,'output',entry);return {...entry,duplicate:false};
  });}
  /** Published technical judgment is a distinct original artifact. It does
   * not prove target-branch advancement or authorize an enablement action. */
  recordPublicationOutput(id:string,taskId:string,capability:string,operation:string){return this.transaction(()=>{
    const f=this.fixed(id),{task,binding}=this.currentTask(f,taskId),definition=task.outputs.find(o=>o.id===capability);
    if(definition?.stage!=='publish'||definition.kind!=='publication_readback')throw new Error('coordination_publication_capability_not_declared');
    const stage=this.stageState(f,taskId,'publish');if(stage.blockers.length)throw new Error(stage.blockers[0]);
    const artifact=this.publicationSource(operation,true);
    if(artifact.item!==task.item||artifact.packet!==binding.packet||artifact.fingerprint!==binding.fingerprint||canonical(artifact.candidate)!==canonical(binding.candidate)||canonical(artifact.context)!==canonical(binding.context)||artifact.judgment?.verdict!=='ACCEPT_WITHIN_SCOPE'||artifact.publication?.readbackComplete!==true)throw new Error('coordination_exact_publication_readback_required');
    const bytes=Buffer.from(canonical({schemaVersion:1,kind:'publication_readback',task:taskId,capability,binding,operation,artifact}));if(bytes.length>512*1024)throw new Error('coordination_publication_output_limit');
    const entry={task:taskId,capability,stage:'publish',kind:'publication_readback',sha256:this.blob(bytes),operation},old=f.events.find(e=>e.kind==='coordination_output'&&e.data.task===taskId&&e.data.capability===capability);
    if(old){if(canonical(old.data)!==canonical(entry))throw new Error('coordination_original_capability_is_fixed');return {...entry,duplicate:true};}this.verifyOutput(entry);this.event(id,'output',entry);return {...entry,duplicate:false};
  });}
  private statusValue(id:string){const f=this.fixed(id),current=this.latest(f.plan.name)?.id===id;return {id,plan:f.plan,scope:f.registration.scope,current,currentMaterials:f.plan.tasks.every(t=>{try{this.currentTask(f,t.id);return true;}catch{return false;}}),parts:f.plan.shared.map(part=>({id:part.id,hash:f.registration.parts[part.id],feedback:part.feedbackFrom.map(task=>({task,reply:this.feedbackFor(f,part.id,task)}))})),tasks:f.plan.tasks.map(task=>({id:task.id,dispatch:task.dispatch,actor:task.actor,originActor:task.originActor,stages:task.stages.map(stage=>{try{return this.stageState(f,task.id,stage);}catch(e){return {stage,phasePrerequisitesMet:false,executionAuthorized:false,blockers:[e instanceof Error?e.message:'coordination_state_unknown']};}})})),writingPermissionGranted:false};}
  status(id:string){return this.transaction(()=>this.statusValue(id));}
}
