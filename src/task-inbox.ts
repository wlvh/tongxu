import type {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {parseMessagePlan,messagePlanId,messageId,type MessagePlan,type MessageParticipant} from './message-contract.js';
import type {TaskRecords} from './task-store.js';
import {publicationReturnReference,type PublicationReturnReference} from './publication-return-contract.js';
type Row=Record<string,any>;
type InboxCoordination={context:(task:string,actor:string,tool:string)=>{planId:string;task:string;sha256:string;bytes:Buffer}|null;bind:(id:string,plan:Buffer,sha256:string,mapping:Array<{task:string;messageId:string}>)=>unknown;feedback:(id:string,task:string,run:string,messageId:string)=>unknown};
export type TaskOwnerRequest={schemaVersion:1;kind:'tongxu-task-owner-request';id:string;task:string;source:string;question:string;from:null|{task:string;run:string;messageId:string};participant:MessageParticipant;executionKind:MessagePlan['executionKind'];authorityIntent:string|null;resourceBudget?:MessagePlan['resourceBudget'];nativeControls?:MessagePlan['nativeControls'];nativeResume?:MessagePlan['nativeResume'];billing:MessagePlan['billing'];timeoutMs:number;publicationReturn?:PublicationReturnReference};
export type TaskControllerReturn={catalogSha256:string;actionId:string;stage:'registration'|'execution';expectedPacket:number;expectedSourceSha256:string;run:string|null;completed:boolean;resourcesSettled:boolean|null;newModelRequests:number|null;reason:string|null};
function planFor(p:TaskOwnerRequest,path:string,sha256:string):MessagePlan{return {schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:p.executionKind,source:p.source,authorityIntent:p.authorityIntent,...(p.resourceBudget?{resourceBudget:p.resourceBudget}:{}),...(p.nativeControls?{nativeControls:p.nativeControls}:{}),...(p.nativeResume?{nativeResume:p.nativeResume}:{}),participants:[p.participant],messages:[{id:p.id,from:null,to:p.participant.id,body:p.question,replies:[]}],material:[{name:'task-owner-context.json',path,sha256}],consumeMaterial:['task-owner-context.json'],billing:p.billing,timeoutMs:p.timeoutMs};}
export function parseTaskOwnerRequest(raw:Buffer):TaskOwnerRequest{
  if(raw.length>64*1024)throw new Error('task_request_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','id','task','source','question','from','participant','executionKind','authorityIntent','billing','timeoutMs',...(p&&Object.hasOwn(p,'resourceBudget')?['resourceBudget']:[]),...(p&&Object.hasOwn(p,'nativeControls')?['nativeControls']:[]),...(p&&Object.hasOwn(p,'publicationReturn')?['publicationReturn']:[]),...(p&&Object.hasOwn(p,'nativeResume')?['nativeResume']:[])])||p.schemaVersion!==1||p.kind!=='tongxu-task-owner-request'||!messageId(p.id)||!isAuthorityDigest(p.task)||p.participant?.item!==p.task||p.participant?.role!=='issue_owner'||p.participant?.parent!==null||!(p.from===null||exactKeys(p.from,['task','run','messageId'])&&isAuthorityDigest(p.from.task)&&p.from.task!==p.task&&isAuthorityDigest(p.from.run)&&messageId(p.from.messageId))||Object.hasOwn(p,'publicationReturn')&&(!publicationReturnReference(p.publicationReturn)||p.from!==null))throw new Error('task_request_invalid');
  parseMessagePlan(Buffer.from(canonical(planFor(p,'/task-context.json','0'.repeat(64)))));return p;
}

/** A finite inbox for a program-owned responsibility. A follow-up gets a new
 * native context only after the preceding exact execution is proven ended.
 * Imported App sessions and caller-written actor names are not control rights. */
export class TaskInbox {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private directory:string,private tasks:TaskRecords,private messages:(run:string)=>Row,private association?:(task:string,link?:string)=>Row|null,private checkAssociation?:(task:string,link:string)=>void,private associationHistory?:(task:string)=>Row[],private publicationSource?:(task:string,reference:PublicationReturnReference)=>Row,private coordination?:InboxCoordination){}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('task_inbox_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(task:string,kind:string,value:unknown){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('task_inbox_'+kind,task,canonical({value,sha256:this.blob(Buffer.from(canonical(value)))}),now());}
  private events(task:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'task_inbox_%' ORDER BY id").all(task) as Row[]).map(e=>{const r=JSON.parse(e.data);if(canonical(JSON.parse(this.bytes(r.sha256).toString()))!==canonical(r.value))throw new Error('task_inbox_history_changed');return {...e,data:r.value};});}
  originalResponsibility(task:string){return this.transaction(()=>{this.tasks.current(task);const first=this.events(task).find(e=>e.kind==='task_inbox_queued');if(!first)throw new Error('task_original_responsibility_required');const p=parseTaskOwnerRequest(this.bytes(first.data.requestSha256));return {participant:p.participant,executionKind:p.executionKind,firstRequest:p.id,firstRequestSha256:first.data.requestSha256};});}
  private publicationMaterial(task:string,ref:PublicationReturnReference){if(!this.publicationSource)throw new Error('task_publication_return_consumer_required');return this.publicationSource(task,ref);}
  private entry(task:string,id:string){this.tasks.current(task);const events=this.events(task),q=events.find(e=>e.kind==='task_inbox_queued'&&e.data.id===id)?.data;if(!q)throw new Error('task_request_not_queued');const request=parseTaskOwnerRequest(this.bytes(q.requestSha256));if(request.task!==task||request.id!==id)throw new Error('task_request_identity_changed');return {events,queued:q,request,selected:events.find(e=>e.kind==='task_inbox_selected'&&e.data.id===id)?.data??null};}
  recordControllerReturn(raw:Buffer,result:TaskControllerReturn,detail:Buffer){return this.transaction(()=>{
    const p=parseTaskOwnerRequest(raw);this.tasks.current(p.task);if(!exactKeys(result,['catalogSha256','actionId','stage','expectedPacket','expectedSourceSha256','run','completed','resourcesSettled','newModelRequests','reason'])||!isAuthorityDigest(result.catalogSha256)||!messageId(result.actionId)||!['registration','execution'].includes(result.stage)||!Number.isSafeInteger(result.expectedPacket)||result.expectedPacket<1||!isAuthorityDigest(result.expectedSourceSha256)||!(result.run===null||isAuthorityDigest(result.run))||typeof result.completed!=='boolean'||!(result.resourcesSettled===null||typeof result.resourcesSettled==='boolean')||!(result.newModelRequests===null||Number.isSafeInteger(result.newModelRequests)&&result.newModelRequests>=0&&result.newModelRequests<=8)||!(result.reason===null||typeof result.reason==='string'&&/^[a-z0-9_]{1,200}$/.test(result.reason))||detail.length>128*1024)throw new Error('task_controller_return_invalid');
    const events=this.events(p.task),requestSha256=hash(canonical(p)),queued=events.find(e=>e.kind==='task_inbox_queued'&&e.data.id===p.id)?.data;if(queued&&queued.requestSha256!==requestSha256)throw new Error('task_control_original_request_changed');
    if(result.run!==null&&events.find(e=>e.kind==='task_inbox_selected'&&e.data.id===p.id)?.data.run!==result.run)throw new Error('task_controller_return_run_mismatch');
    const value={id:p.id,requestSha256:this.blob(Buffer.from(canonical(p))),result,detailSha256:this.blob(detail),meaning:'controller_return_not_dispatch_proof'},previous=events.filter(e=>e.kind==='task_inbox_controller_returned'&&e.data.id===p.id).at(-1);if(previous&&canonical(previous.data)===canonical(value))return {observationSha256:hash(canonical(value)),duplicate:true};if(events.filter(e=>e.kind==='task_inbox_controller_returned').length>=256)throw new Error('task_controller_history_bound');this.event(p.task,'controller_returned',value);return {observationSha256:hash(canonical(value)),duplicate:false};
  });}
  controllerReturns(task:string){this.tasks.current(task);return this.events(task).filter(e=>e.kind==='task_inbox_controller_returned').map(e=>{const p=parseTaskOwnerRequest(this.bytes(e.data.requestSha256));this.bytes(e.data.detailSha256);if(p.task!==task||p.id!==e.data.id)throw new Error('task_controller_history_changed');return {id:e.data.id,requestSha256:e.data.requestSha256,observationSha256:hash(canonical(e.data)),recordedAt:e.observed_at,meaning:e.data.meaning,...e.data.result,detailSha256:e.data.detailSha256};});}
  private completed(run:string){let s:Row;try{s=this.messages(run).state;}catch(e){if((e as Error).message==='original_message_run_required')return false;throw e;}return s.messages.length>0&&s.messages.every((m:Row)=>m.state==='Reply'&&m.reply?.reportedConsumption===true)&&s.runtimes.filter((r:Row)=>r.started).every((r:Row)=>r.captureVerification?.proof.successfulCapture===true)&&s.resourcesSettled!==false;}
  private captured(from:NonNullable<TaskOwnerRequest['from']>){const source=this.messages(from.run),s=source.state,m=s.messages.find((m:Row)=>m.id===from.messageId),p=s.plan.participants.find((p:Row)=>p.id===m?.to),r=s.runtimes.find((r:Row)=>r.participant===p?.id),current=this.tasks.current(from.task),binding=s.registration.bindings[p?.id];
    if(p?.item!==from.task||m?.state!=='Reply'||!m.reply?.reportedConsumption||r?.captureVerification?.proof.successfulCapture!==true||binding?.packet!==current.packet||binding?.fingerprint!==current.fingerprint)throw new Error('task_contact_requires_current_captured_sender');
    const input=source.inputs.find((x:Row)=>x.messageId===from.messageId),context=input?.material?.find((m:Row)=>m.name==='task-owner-context.json');if(context){const associated=JSON.parse(context.text).candidateAssociation;if(associated)this.checkAssociation?.(from.task,associated.association.link);}
    return {task:from.task,run:from.run,messageId:from.messageId,sourceSha256:current.fingerprint,route:r.route,reply:m.reply};
  }
  enqueue(raw:Buffer,expected?:{packet:number;sourceSha256:string}){return this.transaction(()=>{
    const p=parseTaskOwnerRequest(raw),current=this.tasks.current(p.task),events=this.events(p.task),requestSha256=hash(canonical(p)),old=events.find(e=>e.kind==='task_inbox_queued'&&e.data.id===p.id)?.data;
    if(expected&&(current.packet!==expected.packet||current.fingerprint!==expected.sourceSha256))throw new Error('task_request_expected_source_changed');
    if(old){if(old.requestSha256!==requestSha256)throw new Error('task_request_id_is_fixed');return {...old,duplicate:true};}
    const owner=events.find(e=>e.kind==='task_inbox_queued')?.data;if(owner){const first=parseTaskOwnerRequest(this.bytes(owner.requestSha256));if(canonical(first.participant)!==canonical(p.participant)||first.executionKind!==p.executionKind)throw new Error('task_original_responsibility_is_fixed');}else if(p.publicationReturn)throw new Error('task_original_responsibility_required');
    if(p.nativeResume&&!events.some(e=>e.kind==='task_inbox_selected'&&e.data.run===p.nativeResume!.run&&e.data.id===p.nativeResume!.messageId))throw new Error('task_native_resume_original_request_required');
    if(p.publicationReturn){
      this.publicationMaterial(p.task,p.publicationReturn);
      for(const e of events.filter(e=>e.kind==='task_inbox_queued'&&!events.some(c=>c.kind==='task_inbox_cancelled'&&c.data.id===e.data.id))){const previous=parseTaskOwnerRequest(this.bytes(e.data.requestSha256));if(previous.publicationReturn?.operation===p.publicationReturn.operation)throw new Error('task_publication_return_already_queued');}
    }
    if(events.filter(e=>e.kind==='task_inbox_queued').length>=32)throw new Error('task_inbox_bound');
    if(p.from&&canonical(this.tasks.current(p.from.task).context.scope)!==canonical(current.context.scope))throw new Error('task_contact_scope_mismatch');
    const sender=p.from?this.captured(p.from):null,value={id:p.id,requestSha256:this.blob(Buffer.from(canonical(p))),packet:current.packet,sourceSha256:current.fingerprint,sender};this.event(p.task,'queued',value);return {...value,duplicate:false};
  });}
  private available(task:string,id:string){
    const f=this.entry(task,id),current=this.tasks.current(task);if(f.events.some(e=>['task_inbox_cancelled','task_inbox_interrupted_closed'].includes(e.kind)&&e.data.id===id))throw new Error('task_request_cancelled');if(current.packet!==f.queued.packet||current.fingerprint!==f.queued.sourceSha256)throw new Error('task_queued_source_changed');if(f.request.from&&canonical(this.captured(f.request.from))!==canonical(f.queued.sender))throw new Error('task_contact_source_changed');
    if(f.selected){const associated=JSON.parse(this.bytes(f.selected.contextSha256).toString()).candidateAssociation;if(associated)this.checkAssociation?.(task,associated.association.link);}
    if(f.request.publicationReturn){const material=this.publicationMaterial(task,f.request.publicationReturn);if(f.selected&&canonical(JSON.parse(this.bytes(f.selected.contextSha256).toString()).publicationReturn)!==canonical(material))throw new Error('task_publication_return_material_changed');}
    for(const e of f.events.filter(e=>e.kind==='task_inbox_queued')){if(e.data.id===id)break;if(f.events.some(c=>['task_inbox_cancelled','task_inbox_interrupted_closed'].includes(c.kind)&&c.data.id===e.data.id))continue;const previous=this.entry(task,e.data.id);if(!previous.selected||!this.completed(previous.selected.run))throw new Error('task_original_responsibility_pending');}
    return f;
  }
  cancelUnsent(task:string,id:string,source:string,expectedRequestSha256?:string){return this.transaction(()=>{
    if(typeof source!=='string'||!source.trim()||source.length>2048)throw new Error('task_cancel_source_required');const f=this.entry(task,id),prior=f.events.find(e=>e.kind==='task_inbox_cancelled'&&e.data.id===id);if(expectedRequestSha256!==undefined&&f.queued.requestSha256!==expectedRequestSha256)throw new Error('task_control_original_request_changed');if(prior)return {...prior.data,duplicate:true};
    let proof:Row={selectionCreated:false};
    if(f.selected){
      let s:Row|null=null;try{s=this.messages(f.selected.run).state;}catch(e){if((e as Error).message!=='original_message_run_required')throw e;}
      if(this.db.prepare("SELECT 1 FROM events WHERE kind='message_resource_bound' AND object=?").get('message-resource:'+f.selected.run)&&(s?.resourcesSettled!==true||s.resourcePhase!=='cancelled_unstarted'))throw new Error('task_original_resource_investment_must_be_resolved');
      if(s&&(s.messages.some((m:Row)=>m.sent)||s.runtimes.some((r:Row)=>r.started&&r.ended?.proof.knownUnstarted!==true)))throw new Error('task_original_execution_active_or_unknown');
      proof={selectionCreated:true,run:f.selected.run,registered:!!s,knownUnstarted:s?.runtimes.map((r:Row)=>({participant:r.participant,attempt:r.attempt,ended:r.ended}))??[]};
    }
    const value={id,source,proof,newModelRequests:0,originalRetained:true};this.event(task,'cancelled',value);return {...value,duplicate:false};
  });}
  closeInterrupted(task:string,id:string,source:string,expectedRequestSha256:string){return this.transaction(()=>{
    const f=this.entry(task,id);if(f.queued.requestSha256!==expectedRequestSha256||!source.trim()||source.length>2048)throw new Error('task_control_original_request_changed');
    const old=f.events.find(e=>e.kind==='task_inbox_interrupted_closed'&&e.data.id===id);if(old)return {...old.data,duplicate:true};
    if(!f.selected||!f.request.nativeControls)throw new Error('task_original_interruption_required');const s=this.messages(f.selected.run).state;
    if(s.messages.length!==1||s.messages[0].state!=='Interrupted'||s.runtimes.filter((r:Row)=>r.started).length!==1||s.runtimes.some((r:Row)=>r.started&&r.captureVerification?.proof.successfulCapture!==true)||s.resourcesSettled===false)throw new Error('task_original_interruption_or_resources_unresolved');
    const value={id,run:f.selected.run,source,originalRunCompleted:false,originalRetained:true,newModelRequests:0,interruption:s.messages[0].interruption,captures:s.runtimes.filter((r:Row)=>r.started).map((r:Row)=>({participant:r.participant,originals:r.ended.originals,proof:r.captureVerification.proof}))};this.event(task,'interrupted_closed',value);return {...value,duplicate:false};
  });}
  prepare(task:string,id:string){return this.transaction(()=>{
    const f=this.entry(task,id);if(f.selected)return this.selection(f.selected);
    this.available(task,id);const history=f.events.filter(e=>e.kind==='task_inbox_selected'&&!f.events.some(c=>c.kind==='task_inbox_cancelled'&&c.data.id===e.data.id)).map(e=>{const original=this.messages(e.data.run),s=original.state;return {originalRoleInputs:original.inputs,request:e.data.id,run:e.data.run,bindings:s.registration.bindings,reports:s.messages.map((m:Row)=>({id:m.id,recipient:m.sent.recipient,receipt:m.reply,...(m.interruption?{state:m.state,interruption:m.interruption}:{})})),...(f.events.some(c=>c.kind==='task_inbox_interrupted_closed'&&c.data.id===e.data.id)?{interruptedRequestClosed:true,originalRunCompleted:false}:{}),nativeSessionResumed:s.runtimes.some((r:Row)=>r.route?.nativeSessionResumed===true)};});
    const coordination=this.coordination?.context(task,f.request.participant.id,f.request.participant.tool)??null,link=coordination?{planId:coordination.planId,task:coordination.task,contextSha256:coordination.sha256}:null;
    const context=Buffer.from(canonical({schemaVersion:1,kind:'tongxu-task-owner-context',task:JSON.parse(this.tasks.context(task).toString()),candidateAssociation:this.association?.(task,f.request.publicationReturn?.taskLink)??null,candidateAssociationHistory:this.associationHistory?.(task)??[],request:{id,question:f.request.question,source:f.request.source},sender:f.queued.sender,...(f.request.publicationReturn?{publicationReturn:this.publicationMaterial(task,f.request.publicationReturn)}:{}),...(link?{coordination:link}:{}),previousExecutions:history,newNativeContext:!f.request.nativeResume,nativeSessionResumed:false,...(f.request.nativeResume?{nativeSessionResumeRequested:f.request.nativeResume}:{}),externalSessionControl:false,permissionsGranted:false}));
    if(context.length>512*1024)throw new Error('task_complete_context_limit');const directory=join(this.directory,'task-inbox',task,id),contextSha256=this.blob(context),plan=planFor(f.request,join(directory,'context.json'),contextSha256);
    if(coordination){plan.material.push({name:'coordination-context.json',path:join(directory,'coordination-context.json'),sha256:coordination.sha256});plan.consumeMaterial!.push('coordination-context.json');plan.messages[0]!.body+='\n\nThis task remains with its original assigned actor. Read the supplied coordination-context.json as data for assigned task '+coordination.task+'. Return the required outer message receipt; its report must be a JSON string matching context.responseContract. Preserve complete reasoning, name each affected part and its exact hash, and use agreed, conflict or unknown based on evidence. Feedback grants no writing authority.';}
    const value={id,run:messagePlanId(plan),directory,contextSha256,planSha256:this.blob(Buffer.from(canonical(plan))),...(link?{coordination:link}:{})};
    if(coordination)this.coordination!.bind(coordination.planId,Buffer.from(canonical(plan)),coordination.sha256,[{task:coordination.task,messageId:id}]);
    this.event(task,'selected',value);return this.selection(value);
  });}
  private selection(v:Row):Row&{plan:Buffer;context:Buffer;coordinationContext?:Buffer}{const plan=this.bytes(v.planSha256),context=this.bytes(v.contextSha256);if(messagePlanId(parseMessagePlan(plan))!==v.run)throw new Error('task_selected_run_changed');return {...v,plan,context,...(v.coordination?{coordinationContext:this.bytes(v.coordination.contextSha256)}:{})};}
  reconcileCoordination(task:string,id:string){return this.transaction(()=>{
    const f=this.entry(task,id);if(!f.selected?.coordination)return null;if(!this.completed(f.selected.run))throw new Error('task_coordination_complete_reply_required');
    const selected=this.selection(f.selected),link=selected.coordination;if(!this.coordination)throw new Error('task_coordination_consumer_required');
    return this.coordination.feedback(link.planId,link.task,selected.run,id);
  });}
  sourceTasks(run:string){
    const links=this.db.prepare("SELECT object,data FROM events WHERE kind='task_inbox_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(!links.length)return [];if(links.length!==1)throw new Error('task_contact_binding_ambiguous');const selected=JSON.parse(links[0]!.data).value,f=this.entry(links[0]!.object,selected.id);return f.request.from?[f.request.from.task]:[];
  }
  associationStatus(run:string){
    const rows=this.db.prepare("SELECT object,data FROM events WHERE kind='task_inbox_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];if(!rows.length)return null;if(rows.length!==1)throw new Error('task_contact_binding_ambiguous');
    const value=JSON.parse(rows[0]!.data).value,f=this.entry(rows[0]!.object,value.id),selected=this.selection(f.selected),association=JSON.parse(selected.context.toString()).candidateAssociation?.association;if(!association)return null;
    try{this.checkAssociation?.(rows[0]!.object,association.link);if(f.request.publicationReturn&&canonical(this.publicationMaterial(rows[0]!.object,f.request.publicationReturn))!==canonical(JSON.parse(selected.context.toString()).publicationReturn))throw new Error('task_publication_return_material_changed');return {link:association.link,current:true,reason:null};}catch(e){return {link:association.link,current:false,reason:e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'original_association_unavailable'};}
  }
  messageClosedUnstarted(run:string){
    const rows=this.db.prepare("SELECT object,data FROM events WHERE kind='task_inbox_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];if(!rows.length)return false;if(rows.length!==1)throw new Error('task_contact_binding_ambiguous');
    const value=JSON.parse(rows[0]!.data).value,f=this.entry(rows[0]!.object,value.id),closed=f.events.find(e=>e.kind==='task_inbox_cancelled'&&e.data.id===f.request.id);if(!closed)return false;
    const selected=this.selection(f.selected),s=this.messages(run).state,captures=s.runtimes.map((r:Row)=>({participant:r.participant,attempt:r.attempt,ended:r.ended}));
    if(selected.run!==run||closed.data.proof?.run!==run||closed.data.proof.registered!==true||s.messages.some((m:Row)=>m.sent)||s.runtimes.some((r:Row)=>r.started&&r.ended?.proof.knownUnstarted!==true)||canonical(closed.data.proof.knownUnstarted)!==canonical(captures)||s.plan.resourceBudget&&(s.resourcePhase!=='cancelled_unstarted'||s.resourcesSettled!==true))throw new Error('task_cancelled_original_changed');
    return true;
  }
  gate(run:string){
    const state=this.messages(run).state,taskParticipants=state.plan.participants.filter((p:Row)=>state.registration.bindings[p.id].candidate.kind==='development-task');if(!taskParticipants.length)return;
    const links=this.db.prepare("SELECT object,data FROM events WHERE kind='task_inbox_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(links.length!==1||taskParticipants.length!==1||state.plan.participants.length!==1)throw new Error('task_registered_owner_dispatch_required');
    const task=links[0]!.object,selected=JSON.parse(links[0]!.data).value,f=this.available(task,selected.id),exact=this.selection(f.selected);
    const associated=JSON.parse(exact.context.toString()).candidateAssociation;if(associated)this.checkAssociation?.(task,associated.association.link);
    if(canonical(state.plan)!==canonical(parseMessagePlan(exact.plan))||taskParticipants[0].item!==task||state.registration.materials['task-owner-context.json']?.sha256!==selected.contextSha256)throw new Error('task_owner_dispatch_changed');
  }
  status(task:string){this.tasks.current(task);return this.transaction(()=>this.events(task).filter(e=>e.kind==='task_inbox_queued').map(e=>{
    const f=this.entry(task,e.data.id);let phase='queued',reason:string|null=null,route:Row|null=null,nativeControls:Row[]=[];
    if(f.events.some(e=>e.kind==='task_inbox_cancelled'&&e.data.id===f.request.id))phase='cancelled';
    else if(f.selected){try{const s=this.messages(f.selected.run).state;route=s.runtimes[0]?.route??null;nativeControls=s.nativeControls??[];phase=this.completed(f.selected.run)?'returned':s.runtimes.some((r:Row)=>r.started&&!r.ended)?'active_or_unknown':s.messages.some((m:Row)=>m.state==='Interrupted')?'interrupted':s.messages.some((m:Row)=>m.sent)?'unresolved':'prepared';}catch(error){if((error as Error).message==='original_message_run_required')phase='prepared';else{phase='unresolved';reason=(error as Error).message;}}}
    if(phase==='queued'||phase==='prepared')try{this.available(task,e.data.id);}catch(error){phase='waiting';reason=(error as Error).message;}
    if(f.events.some(e=>e.kind==='task_inbox_interrupted_closed'&&e.data.id===f.request.id))phase='interrupted_closed';
    return {id:e.data.id,task,requestSha256:e.data.requestSha256,packet:e.data.packet,currentMaterial:this.tasks.current(task).packet===e.data.packet&&(!f.selected||this.associationStatus(f.selected.run)?.current!==false),sourceSha256:e.data.sourceSha256,phase,reason,run:f.selected?.run??null,role:'issue_owner',actor:f.request.participant.id,tool:f.request.participant.tool,sessionId:route?.sessionId??null,...(f.request.nativeControls?{nativeControls}:{}),nativeSessionResumed:route?.nativeSessionResumed===true,...(f.request.nativeResume?{nativeResumeRequested:f.request.nativeResume,resumedFrom:route?.resumedFrom??null}:{}),externalSessionControl:false};
  }));}
}
