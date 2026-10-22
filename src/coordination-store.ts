import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import { exactKeys } from './authority-contract.js';
import { coordinationPartId,coordinationPlanId,parseCoordinationPlan,type CoordinationStage } from './coordination-contract.js';
import { messagePlanId,parseMessagePlan } from './message-contract.js';
import { parseCoordinationExecution,coordinationExecutionIdentity,coordinationTaskBody,coordinationMessageId,coordinationMessageAuthority } from './coordination-execution-contract.js';
import { join } from 'node:path';
import { projectModelTestResult } from './project-repair.js';
import {parseRepairContinuation} from './repair-continuation-contract.js';
import {requireManagedRepairCapture,type ManagedRepairCapture} from './workspace-handoff-originals.js';

type Row=Record<string,any>;
/** Coordination facts use the original queue. Feedback can satisfy a technical
 * prerequisite; it never supplies a writing grant or an execution receipt. */
export class CoordinationRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private item:(id:string)=>Row,private message:(run:string)=>{state:Row;materials:Record<string,Buffer>;submitted:(participant:string)=>Row[]},private directory:string){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('coordination_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(id:string,kind:string,data:Row){const bytes=Buffer.from(canonical(data)),sha=this.blob(bytes);this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('coordination_'+kind,'coordination:'+id,JSON.stringify({value:data,sha256:sha}),now());}
  private events(id:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'coordination_%' ORDER BY id").all('coordination:'+id) as Row[]).map(row=>{const v=JSON.parse(row.data);if(canonical(JSON.parse(this.bytes(v.sha256).toString()))!==canonical(v.value))throw new Error('coordination_index_changed');return {...row,data:v.value};});}
  private fixed(id:string){const events=this.events(id),registration=events.find(e=>e.kind==='coordination_registered')?.data;if(!registration)throw new Error('coordination_plan_not_registered');const plan=parseCoordinationPlan(this.bytes(registration.planSha256));if(coordinationPlanId(plan)!==id)throw new Error('coordination_plan_changed');return {id,plan,registration,events};}
  private latest(name:string){const row=this.db.prepare("SELECT object FROM events WHERE kind='coordination_registered' AND json_extract(data,'$.value.name')=? ORDER BY id DESC LIMIT 1").get(name) as Row;return row?this.fixed(row.object.slice(13)):null;}
  current(name:string){return this.transaction(()=>{const latest=this.latest(name);return latest?this.statusValue(latest.id):null;});}
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
  private stageState(f:ReturnType<CoordinationRecords['fixed']>,taskId:string,stage:CoordinationStage){
    const {task,binding}=this.currentTask(f,taskId);if(!task.stages.includes(stage))throw new Error('coordination_stage_not_planned');const blockers:string[]=[];
    if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='investment' AND stopped=1").get(binding.context.scope.id))blockers.push('new_investment_stopped');
    if(stage==='implement'&&this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='implementation' AND stopped=1").get(binding.context.scope.id))blockers.push('implementation_stopped');
    if(stage!=='investigate'){
      if(this.latest(f.plan.name)?.id!==f.id)blockers.push('new_arrangement_requires_current_stage_binding');
      for(const part of f.plan.shared.filter(p=>p.tasks.includes(taskId)&&p.blockedStages.includes(stage))){for(const stale of this.staleSharedTasks(f,part.id))blockers.push('shared_candidate_or_material_changed:'+part.id+':'+stale);for(const source of part.feedbackFrom){const feedback=this.feedbackFor(f,part.id,source);if(feedback?.position!=='agreed')blockers.push('shared_feedback:'+part.id+':'+source+':'+(feedback?.position??'missing'));}}
    }
    for(const dependency of f.plan.dependencies.filter(d=>d.task===taskId&&d.stage===stage)){
      try{this.currentTask(f,dependency.producer);}catch{blockers.push('capability_producer_changed:'+dependency.producer+':'+dependency.capability);continue;}
      const output=f.events.findLast(e=>e.kind==='coordination_output'&&e.data.task===dependency.producer&&e.data.capability===dependency.capability)?.data;
      if(!output)blockers.push('capability_missing:'+dependency.producer+':'+dependency.capability);
      else if(!f.events.some(e=>e.kind==='coordination_consumed'&&e.data.task===taskId&&e.data.stage===stage&&e.data.outputSha256===output.sha256))blockers.push('capability_not_consumed:'+dependency.producer+':'+dependency.capability);
    }
    return {task:taskId,stage,blockers,phasePrerequisitesMet:blockers.length===0,executionAuthorized:false};
  }
  stage(id:string,task:string,stage:CoordinationStage){return this.transaction(()=>this.stageState(this.fixed(id),task,stage));}
  private contextValue(f:ReturnType<CoordinationRecords['fixed']>){
    for(const t of f.plan.tasks)this.currentTask(f,t.id);
    const outputs=f.events.filter(e=>e.kind==='coordination_output').map(e=>({...e.data,text:this.bytes(e.data.sha256).toString()}));
    return {schemaVersion:1,kind:'tongxu-coordination-context',planId:f.id,name:f.plan.name,revision:f.plan.revision,scope:f.registration.scope,mode:f.plan.mode,tasks:f.plan.tasks,actors:f.plan.actors,bindings:f.registration.bindings,shared:f.plan.shared.map(p=>({...p,hash:f.registration.parts[p.id]})),dependencies:f.plan.dependencies,outputs,permissionsGranted:false,responseContract:{kind:'tongxu-coordination-feedback',task:'exact assigned task id',revision:f.plan.revision,parts:'each affected part: id, hash, position (agreed/conflict/unknown), report',report:'complete substantive report; feedback is not writing authority'}};
  }
  context(id:string){return this.transaction(()=>{const f=this.fixed(id),value=this.contextValue(f),bytes=Buffer.from(canonical(value));if(bytes.length>512*1024)throw new Error('coordination_complete_context_limit');const sha=this.blob(bytes);if(!f.events.some(e=>e.kind==='coordination_context_prepared'&&e.data.sha256===sha))this.event(id,'context_prepared',{sha256:sha});return {value,bytes,sha256:sha};});}
  execution(id:string,request:Buffer){return this.transaction(()=>{
    const f=this.fixed(id),parsed=parseCoordinationExecution(request,f.plan),identity=coordinationExecutionIdentity(parsed),old=f.events.find(e=>e.kind==='coordination_execution_prepared')?.data;if(old&&old.identity!==identity)throw new Error('coordination_original_execution_is_fixed');const requestSha256=this.blob(Buffer.from(canonical(parsed)));
    if(!f.events.some(e=>e.kind==='coordination_execution_prepared'&&e.data.requestSha256===requestSha256))this.event(id,'execution_prepared',{identity,requestSha256});return {identity,requestSha256};
  });}
  private selected(f:ReturnType<CoordinationRecords['fixed']>,task:string,purpose:string){return f.events.findLast(e=>e.kind==='coordination_dispatch_selected'&&e.data.task===task&&e.data.purpose===purpose)?.data??null;}
  dispatchSelection(id:string,task:string,purpose:'investigate'|'consume'){return this.transaction(()=>{const selected=this.selected(this.fixed(id),task,purpose);return selected?{...selected,plan:this.bytes(selected.planSha256),context:this.bytes(selected.contextSha256)}:null;});}
  selectDispatch(id:string,taskId:string,purpose:'investigate'|'consume',requestSha256:string,rawPlan:Buffer,contextSha256:string){return this.transaction(()=>{
    const f=this.fixed(id),{task}=this.currentTask(f,taskId),request=parseCoordinationExecution(this.bytes(requestSha256),f.plan);if(!['investigate','consume'].includes(purpose)||!f.events.some(e=>e.kind==='coordination_execution_prepared'&&e.data.requestSha256===requestSha256))throw new Error('coordination_execution_request_required');
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
    const expected={schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:request.executionKind,source:request.source+'; coordination '+id+' task '+taskId+' '+purpose,...coordinationMessageAuthority(request,id,taskId,purpose,attempt),participants:[{...actor,item:task.item,role:'issue_owner',parent:null}],messages:[{id:coordinationMessageId(taskId,purpose),from:null,to:actor.id,body:coordinationTaskBody(request,taskId,purpose),replies:[]}],material:[{name:'coordination-context.json',path:join(directory,'context.json'),sha256:contextSha256}],consumeMaterial:['coordination-context.json'],billing:request.billing,timeoutMs:request.timeoutMs};
    if(canonical(plan)!==canonical(expected)||!f.events.some(e=>e.kind==='coordination_context_prepared'&&e.data.sha256===contextSha256))throw new Error('coordination_selected_task_changed');
    const value={task:taskId,purpose,attempt,directory,run:messagePlanId(plan),planSha256:this.blob(rawPlan),contextSha256,requestSha256};this.event(id,'dispatch_selected',value);return value;
  });}
  bindMessages(id:string,raw:Buffer,contextSha256:string,mapping:Array<{task:string;messageId:string}>){return this.transaction(()=>{
    const f=this.fixed(id),plan=parseMessagePlan(raw),run=messagePlanId(plan),context=this.bytes(contextSha256);
    if(!f.events.some(e=>e.kind==='coordination_context_prepared'&&e.data.sha256===contextSha256)||!plan.material.some(m=>m.name==='coordination-context.json'&&m.sha256===contextSha256)||!plan.consumeMaterial?.includes('coordination-context.json'))throw new Error('coordination_exact_context_consumption_required');
    if(!Array.isArray(mapping)||!mapping.length||mapping.length>8||new Set(mapping.map(m=>m.messageId)).size!==mapping.length)throw new Error('coordination_message_mapping_invalid');
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
  feedback(id:string,run:string,messageId:string){return this.transaction(()=>{
    const f=this.fixed(id),bound=f.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===run)?.data,mapping=bound?.mapping.find((m:Row)=>m.messageId===messageId);if(!mapping)throw new Error('coordination_original_message_binding_required');
    const {source,message,input}=this.verifiedReply(run,messageId),context=source.materials['coordination-context.json'];
    if(!context||hash(context)!==bound.contextSha256||!input.replyReferences.includes(bound.contextSha256))throw new Error('coordination_original_context_changed');
    const feedback=JSON.parse(message.reply.report);
    if(!exactKeys(feedback,['kind','task','revision','parts','report'])||feedback.kind!=='tongxu-coordination-feedback'||feedback.task!==mapping.task||feedback.revision!==f.plan.revision||typeof feedback.report!=='string'||!feedback.report.trim()||!Array.isArray(feedback.parts)||feedback.parts.length>16||new Set(feedback.parts.map((p:Row)=>p?.id)).size!==feedback.parts.length)throw new Error('coordination_feedback_shape_invalid');
    for(const part of feedback.parts){const expected=f.plan.shared.find(p=>p.id===part.id&&p.feedbackFrom.includes(mapping.task));if(!exactKeys(part,['id','hash','position','report'])||!expected||part.hash!==f.registration.parts[part.id]||!['agreed','conflict','unknown'].includes(part.position)||typeof part.report!=='string'||!part.report.trim())throw new Error('coordination_feedback_part_mismatch');}
    const reportSha256=this.blob(Buffer.from(message.reply.finalText));for(const part of feedback.parts){const entry={task:mapping.task,part:part.id,partHash:part.hash,position:part.position,run,messageId,reportSha256,partReport:part.report},old=f.events.find(e=>e.kind==='coordination_feedback'&&e.data.run===run&&e.data.messageId===messageId&&e.data.part===part.id);if(old){if(canonical(old.data)!==canonical(entry))throw new Error('coordination_feedback_original_changed');}else this.event(id,'feedback',entry);}
    return {planId:id,task:mapping.task,run,messageId,reportSha256,recordedRevision:f.plan.revision,currentRevision:this.latest(f.plan.name)!.plan.revision,writingPermissionGranted:false};
  });}
  /** Called inside the same queue transaction as message runtime registration
   * or send intent. A different task cannot race an active/unknown actor. */
  messageGate(run:string,messageId?:string,participant?:string){return this.transaction(()=>{
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
    if(this.latest(f.plan.name)?.id!==f.id)throw new Error('coordination_new_dispatch_requires_current_revision');
    const selected=bound.mapping.filter((m:Row)=>messageId?m.messageId===messageId:participant?f.plan.tasks.find(t=>t.id===m.task)?.actor===participant:true);if(!selected.length)throw new Error('coordination_message_not_planned');
    const dispatch=f.events.find(e=>e.kind==='coordination_dispatch_selected'&&e.data.run===run)?.data;if(dispatch&&this.selected(f,dispatch.task,dispatch.purpose)?.run!==run)throw new Error('coordination_old_dispatch_selection_superseded');
    for(const m of selected){const {task,binding}=this.currentTask(f,m.task),state=this.stageState(f,m.task,'investigate'),blocked=state.blockers.filter(b=>!b.startsWith('capability_not_consumed:'));if(blocked.length)throw new Error(blocked[0]);
      for(const row of this.db.prepare("SELECT id,object FROM events WHERE kind='coordination_repair_bound'").all() as Row[]){const assignment=this.events(row.object.slice(13)).find(e=>e.id===row.id)!.data;if(assignment.actor===task.actor&&canonical(assignment.scope)===canonical(f.registration.scope)&&!this.repairEnded(assignment.operation))throw new Error('coordination_actor_repair_active_or_unknown');}
      // This readonly message may perform the consumption itself. Its input
      // must already contain the exact available upstream output; later
      // implementation still requires a complete acknowledged reply.
      const context=JSON.parse(this.bytes(bound.contextSha256).toString());for(const d of f.plan.dependencies.filter(d=>d.task===m.task&&d.stage==='investigate')){this.currentTask(f,d.producer);const output=f.events.findLast(e=>e.kind==='coordination_output'&&e.data.task===d.producer&&e.data.capability===d.capability)?.data;if(!output||!context.outputs.some((o:Row)=>o.task===d.producer&&o.capability===d.capability&&o.sha256===output.sha256&&hash(o.text)===output.sha256))throw new Error('coordination_precise_upstream_input_required');}
      for(const other of this.db.prepare("SELECT object,data FROM events WHERE kind='coordination_messages_bound' AND json_extract(data,'$.value.run')!=?").all(run) as Row[]){
        const previous=this.fixed(other.object.slice(13)),link=previous.events.find(e=>e.kind==='coordination_messages_bound'&&e.data.run===JSON.parse(other.data).value.run)!.data;
        if(canonical(previous.registration.scope)!==canonical(binding.context.scope)||!link.mapping.some((x:Row)=>previous.plan.tasks.find(t=>t.id===x.task)?.actor===task.actor))continue;
        let native:Row;try{native=this.message(link.run).state;}catch(e){if(e instanceof Error&&e.message==='original_message_run_required')continue;throw e;}
        const runtime=native.runtimes.find((r:Row)=>r.participant===task.actor);if(runtime?.started&&(!runtime.ended||runtime.captureVerification?.proof.successfulCapture!==true&&runtime.ended.proof.knownUnstarted!==true||native.messages.some((x:Row)=>x.to===task.actor&&['Unknown','Delivered'].includes(x.state))))throw new Error('coordination_actor_active_or_unknown');
      }
    }
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
      this.currentTask(f,d.producer);const output=f.events.findLast(e=>e.kind==='coordination_output'&&e.data.task===d.producer&&e.data.capability===d.capability)?.data,consumed=context.outputs.find((o:Row)=>o.task===d.producer&&o.capability===d.capability);
      if(!output||!consumed||output.sha256!==consumed.sha256||hash(consumed.text)!==output.sha256)throw new Error('coordination_exact_producer_output_not_consumed');this.verifyOutput(output);
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
    const output=task.outputs.find(o=>o.id===ref.capability),actor=f.plan.actors.find(a=>a.id===task.actor);
    if(task.item!==op.item||binding.packet!==op.packet||actor?.tool!=='codex'||output?.kind!=='repair_candidate'||output.stage!=='implement'||!task.workspace||task.workspace!==join(request.executionRoot,'workspace')||!task.publishBranch||request.authorization?.allowRepair!==true)throw new Error('coordination_exact_repair_task_workspace_required');
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
    const entry={task:task.id,capability:ref.capability,operation,item:op.item,packet:op.packet,actor:task.actor,workspace:task.workspace,publishBranch:task.publishBranch,repository:binding.candidate.repository,scope:f.registration.scope,planSha256:hash(raw!),requestSha256:hash(requestBytes),configSha256:hash(configBytes),fromRun:ref.fromRun,fromMessage:ref.fromMessage,priorSessionId:original.message.reply.sessionId,priorTurnId:original.message.reply.turnId,newExecutionContext:true,nativeSessionResumed:false,startMode:'new_managed_workspace'};
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
  private statusValue(id:string){const f=this.fixed(id),current=this.latest(f.plan.name)?.id===id;return {id,plan:f.plan,scope:f.registration.scope,current,parts:f.plan.shared.map(part=>({id:part.id,hash:f.registration.parts[part.id],feedback:part.feedbackFrom.map(task=>({task,reply:this.feedbackFor(f,part.id,task)}))})),tasks:f.plan.tasks.map(task=>({id:task.id,dispatch:task.dispatch,actor:task.actor,originActor:task.originActor,stages:task.stages.map(stage=>{try{return this.stageState(f,task.id,stage);}catch(e){return {stage,phasePrerequisitesMet:false,executionAuthorized:false,blockers:[e instanceof Error?e.message:'coordination_state_unknown']};}})})),writingPermissionGranted:false};}
  status(id:string){return this.transaction(()=>this.statusValue(id));}
}
