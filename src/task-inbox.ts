import type {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {parseMessagePlan,messagePlanId,messageId,type MessagePlan,type MessageParticipant} from './message-contract.js';
import type {TaskRecords} from './task-store.js';
import {publicationReturnReference,type PublicationReturnReference} from './publication-return-contract.js';
import {participantWithAI} from './ai-settings.js';
import {TaskHistoryProjection,type OriginalTaskExecution} from './task-history.js';
import {ownerContactReference,implementationOwnerTarget,requireIssuedImplementationOwnerProof,checkImplementationOwnerSnapshot,assertImplementationOwnerSourceSync,type OwnerContactReference,type ImplementationOwnerTarget,type ImplementationOwnerProof,type ImplementationOwnerSnapshot} from './implementation-owner-feedback.js';
type Row=Record<string,any>;
type InboxCoordination={context:(task:string,actor:string,tool:string)=>{planId:string;task:string;sha256:string;bytes:Buffer}|null;bind:(id:string,plan:Buffer,sha256:string,mapping:Array<{task:string;messageId:string}>)=>unknown;feedback:(id:string,task:string,run:string,messageId:string)=>unknown};
export type TaskOwnerRequest={schemaVersion:1;kind:'tongxu-task-owner-request';id:string;task:string;source:string;question:string;from:null|{task:string;run:string;messageId:string};participant:MessageParticipant;executionKind:MessagePlan['executionKind'];authorityIntent:string|null;resourceBudget?:MessagePlan['resourceBudget'];nativeControls?:MessagePlan['nativeControls'];nativeResume?:MessagePlan['nativeResume'];billing:MessagePlan['billing'];timeoutMs:number;publicationReturn?:PublicationReturnReference;contactSelection?:{planSha256:string};ownerContact?:OwnerContactReference};
export type TaskControllerReturn={catalogSha256:string;actionId:string;stage:'registration'|'execution';expectedPacket:number;expectedSourceSha256:string;run:string|null;completed:boolean;resourcesSettled:boolean|null;newModelRequests:number|null;reason:string|null};
function planFor(p:TaskOwnerRequest,path:string,sha256:string):MessagePlan{return {schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:p.executionKind,source:p.source,authorityIntent:p.authorityIntent,...(p.resourceBudget?{resourceBudget:p.resourceBudget}:{}),...(p.nativeControls?{nativeControls:p.nativeControls}:{}),...(p.nativeResume?{nativeResume:p.nativeResume}:{}),participants:[p.participant],messages:[{id:p.id,from:null,to:p.participant.id,body:p.question,replies:[]}],material:[{name:'task-owner-context.json',path,sha256}],consumeMaterial:['task-owner-context.json'],billing:p.billing,timeoutMs:p.timeoutMs};}
export function parseTaskOwnerRequest(raw:Buffer):TaskOwnerRequest{
  if(raw.length>64*1024)throw new Error('task_request_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','id','task','source','question','from','participant','executionKind','authorityIntent','billing','timeoutMs',...(p&&Object.hasOwn(p,'resourceBudget')?['resourceBudget']:[]),...(p&&Object.hasOwn(p,'nativeControls')?['nativeControls']:[]),...(p&&Object.hasOwn(p,'publicationReturn')?['publicationReturn']:[]),...(p&&Object.hasOwn(p,'nativeResume')?['nativeResume']:[]),...(p&&Object.hasOwn(p,'contactSelection')?['contactSelection']:[]),...(p&&Object.hasOwn(p,'ownerContact')?['ownerContact']:[])])||p.schemaVersion!==1||p.kind!=='tongxu-task-owner-request'||!messageId(p.id)||!isAuthorityDigest(p.task)||p.participant?.item!==p.task||p.participant?.role!=='issue_owner'||p.participant?.parent!==null||!(p.from===null||exactKeys(p.from,['task','run','messageId'])&&isAuthorityDigest(p.from.task)&&p.from.task!==p.task&&isAuthorityDigest(p.from.run)&&messageId(p.from.messageId))||Object.hasOwn(p,'publicationReturn')&&(!publicationReturnReference(p.publicationReturn)||p.from!==null)||Object.hasOwn(p,'contactSelection')&&(!exactKeys(p.contactSelection,['planSha256'])||!isAuthorityDigest(p.contactSelection.planSha256)||p.from!==null||p.publicationReturn)||Object.hasOwn(p,'ownerContact')&&(!ownerContactReference(p.ownerContact)||p.from===null||p.publicationReturn||p.contactSelection||p.nativeResume))throw new Error('task_request_invalid');
  parseMessagePlan(Buffer.from(canonical(planFor(p,'/task-context.json','0'.repeat(64)))));return p;
}

/** A finite inbox for a program-owned responsibility. A follow-up gets a new
 * native context only after the preceding exact execution is proven ended.
 * Imported App sessions and caller-written actor names are not control rights. */
export class TaskInbox {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private directory:string,private tasks:TaskRecords,private messages:(run:string)=>Row,private association?:(task:string,link?:string)=>Row|null,private checkAssociation?:(task:string,link:string)=>void,private associationHistory?:(task:string)=>Row[],private publicationSource?:(task:string,reference:PublicationReturnReference)=>Row,private coordination?:InboxCoordination,private scopeContinuation?:(task:string)=>Row|null,private scopeFamilyIdle?:(task:string)=>void,private ownerSnapshot?:(target:ImplementationOwnerTarget)=>ImplementationOwnerSnapshot){}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('task_inbox_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(task:string,kind:string,value:unknown){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('task_inbox_'+kind,task,canonical({value,sha256:this.blob(Buffer.from(canonical(value)))}),now());}
  private events(task:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'task_inbox_%' ORDER BY id").all(task) as Row[]).map(e=>{const r=JSON.parse(e.data);if(canonical(JSON.parse(this.bytes(r.sha256).toString()))!==canonical(r.value))throw new Error('task_inbox_history_changed');return {...e,data:r.value};});}
  originalResponsibility(task:string){return this.transaction(()=>{this.tasks.current(task);const first=this.events(task).find(e=>e.kind==='task_inbox_queued');if(!first)throw new Error('task_original_responsibility_required');const p=parseTaskOwnerRequest(this.bytes(first.data.requestSha256));return {participant:p.participant,executionKind:p.executionKind,firstRequest:p.id,firstRequestSha256:first.data.requestSha256};});}
  scopeContinuationSource(task:string){return this.transaction(()=>{
    const states=this.status(task);if(states.some(s=>!['returned','cancelled','interrupted_closed'].includes(s.phase)))throw new Error('task_scope_original_work_not_ended');
    const owner=this.originalResponsibility(task),first=this.entry(task,owner.firstRequest),latest=states.filter(s=>s.run&&['returned','interrupted_closed'].includes(s.phase)).at(-1);
    const original=latest?this.messages(latest.run!):null;
    return {owner,template:first.request,originalRequests:states.map(s=>({id:s.id,run:s.run,phase:s.phase,requestSha256:s.requestSha256})),latest:original?{task,request:latest!.id,run:latest!.run,phase:latest!.phase,originalRoleInputReferences:original.state.messages.filter((m:Row)=>m.sent).map((m:Row)=>({task,run:latest!.run,messageId:m.id,sha256:m.sent.inputSha256})),replies:original.state.messages,nativeControlHistory:original.state.nativeControls??[],bindings:original.state.registration.bindings,nativeSessionResumed:original.state.runtimes.some((r:Row)=>r.route?.nativeSessionResumed===true)}:null,otherOriginalsRetained:true,newNativeContext:true,externalSessionControl:false};
  });}
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
    const selected=this.events(from.task).find(e=>e.kind==='task_inbox_selected'&&e.data.run===from.run);if(selected){const original=this.entry(from.task,selected.data.id).request;if(original.ownerContact)this.ownerContactMaterial(original);}
    return {task:from.task,run:from.run,messageId:from.messageId,sourceSha256:current.fingerprint,route:r.route,reply:m.reply};
  }
  enqueue(raw:Buffer,expected?:{packet:number;sourceSha256:string}){return this.transaction(()=>this.enqueueValue(raw,expected));}
  private enqueueValue(raw:Buffer,expected?:{packet:number;sourceSha256:string}){
    const p=parseTaskOwnerRequest(raw),current=this.tasks.current(p.task),events=this.events(p.task),requestSha256=hash(canonical(p)),old=events.find(e=>e.kind==='task_inbox_queued'&&e.data.id===p.id)?.data;
    if(expected&&(current.packet!==expected.packet||current.fingerprint!==expected.sourceSha256))throw new Error('task_request_expected_source_changed');
    if(old){if(old.requestSha256!==requestSha256)throw new Error('task_request_id_is_fixed');return {...old,duplicate:true};}
    if(p.ownerContact)this.ownerContactMaterial(p);
    this.scopeFamilyIdle?.(p.task);
    const owner=events.find(e=>e.kind==='task_inbox_queued')?.data;if(owner){const first=parseTaskOwnerRequest(this.bytes(owner.requestSha256));if(canonical(first.participant)!==canonical(p.participant)||first.executionKind!==p.executionKind)throw new Error('task_original_responsibility_is_fixed');}else if(p.publicationReturn)throw new Error('task_original_responsibility_required');
    if(p.nativeResume&&!events.some(e=>e.kind==='task_inbox_selected'&&e.data.run===p.nativeResume!.run&&e.data.id===p.nativeResume!.messageId))throw new Error('task_native_resume_original_request_required');
    if(p.publicationReturn){
      this.publicationMaterial(p.task,p.publicationReturn);
      for(const e of events.filter(e=>e.kind==='task_inbox_queued'&&!events.some(c=>c.kind==='task_inbox_cancelled'&&c.data.id===e.data.id))){const previous=parseTaskOwnerRequest(this.bytes(e.data.requestSha256));if(previous.publicationReturn?.operation===p.publicationReturn.operation)throw new Error('task_publication_return_already_queued');}
    }
    if(events.filter(e=>e.kind==='task_inbox_queued').length>=32)throw new Error('task_inbox_bound');
    if(p.from&&canonical(this.tasks.current(p.from.task).context.scope)!==canonical(current.context.scope))throw new Error('task_contact_scope_mismatch');
    const sender=p.from?this.captured(p.from):null,value={id:p.id,requestSha256:this.blob(Buffer.from(canonical(p))),packet:current.packet,sourceSha256:current.fingerprint,sender};this.event(p.task,'queued',value);return {...value,duplicate:false};
  }
  private available(task:string,id:string){
    const f=this.entry(task,id),current=this.tasks.current(task);if(f.events.some(e=>['task_inbox_cancelled','task_inbox_interrupted_closed'].includes(e.kind)&&e.data.id===id))throw new Error('task_request_cancelled');if(current.packet!==f.queued.packet||current.fingerprint!==f.queued.sourceSha256)throw new Error('task_queued_source_changed');if(f.request.from&&canonical(this.captured(f.request.from))!==canonical(f.queued.sender))throw new Error('task_contact_source_changed');
    if(f.selected){const associated=JSON.parse(this.bytes(f.selected.contextSha256).toString()).candidateAssociation;if(associated)this.checkAssociation?.(task,associated.association.link);}
    if(f.request.publicationReturn){const material=this.publicationMaterial(task,f.request.publicationReturn);if(f.selected&&canonical(JSON.parse(this.bytes(f.selected.contextSha256).toString()).publicationReturn)!==canonical(material))throw new Error('task_publication_return_material_changed');}
    if(f.request.ownerContact)this.ownerContactMaterial(f.request);
    for(const e of f.events.filter(e=>e.kind==='task_inbox_queued')){if(e.data.id===id)break;if(f.events.some(c=>['task_inbox_cancelled','task_inbox_interrupted_closed'].includes(c.kind)&&c.data.id===e.data.id))continue;const previous=this.entry(task,e.data.id);if(!previous.selected||!this.completed(previous.selected.run))throw new Error('task_original_responsibility_pending');}
    return f;
  }
  /** A waiting contact is an intent in the original B history, never an A send
   * or another queue. Cancel and the first A enqueue share this transaction. */
  deferOwnerContact(task:string,initial:string,planSha256:string,contactId:string,target:ImplementationOwnerTarget,recipient:TaskOwnerRequest,followup:TaskOwnerRequest,rawPlan:Buffer){return this.transaction(()=>{
    const key=hash(canonical([task,initial,planSha256,contactId])),old=this.ownerContact(task,key);if(old)return old;
    const first=this.entry(task,initial);if(first.request.contactSelection?.planSha256!==planSha256||!first.selected||!this.completed(first.selected.run))throw new Error('owner_contact_original_choice_required');
    const sender={task,run:first.selected.run,messageId:initial},captured=this.captured(sender),choice=JSON.parse(captured.reply.report);
    const plan=JSON.parse(rawPlan.toString()),option=plan.contacts?.find((c:Row)=>c.id===contactId);
    if(hash(canonical(plan))!==planSha256||plan.initial?.task!==task||plan.initial?.id!==initial||canonical(option?.request)!==canonical(recipient)||canonical(option?.followup)!==canonical(followup)||canonical(option?.originalImplementation)!==canonical(target))throw new Error('owner_contact_fixed_plan_changed');
    if(choice.kind!=='tongxu-task-contact-request'||choice.planSha256!==planSha256||choice.contactId!==contactId||!implementationOwnerTarget(target)||recipient.task!==target.task||recipient.from!==null||recipient.ownerContact||followup.task!==task||followup.from!==null||followup.ownerContact||canonical(followup.participant)!==canonical(first.request.participant))throw new Error('owner_contact_original_choice_changed');
    if(!this.ownerSnapshot)throw new Error('owner_contact_implementation_consumer_required');const source=this.ownerSnapshot(target);
    if(source.state.operation!==target.operation||source.state.requestSha256!==target.requestSha256||source.state.task!==target.task||canonical(source.definition.context.scope)!==canonical(this.tasks.current(task).context.scope))throw new Error('owner_feedback_original_target_changed');
    if(this.events(task).filter(e=>e.kind==='task_inbox_owner_contact_waiting').length>=32)throw new Error('owner_contact_history_bound');
    this.event(task,'owner_contact_waiting',{key,initial,planSha256,contactId,target,sender,question:first.request.question,recipientSha256:this.blob(Buffer.from(canonical(recipient))),followupSha256:this.blob(Buffer.from(canonical(followup)))});return this.ownerContact(task,key)!;
  });}
  ownerContact(task:string,key:string){
    if(!isAuthorityDigest(key))throw new Error('owner_contact_identity_invalid');this.tasks.current(task);const events=this.events(task),record=events.find(e=>e.kind==='task_inbox_owner_contact_waiting'&&e.data.key===key)?.data,compiled=events.find(e=>e.kind==='task_inbox_owner_contact_bound'&&e.data.key===key)?.data,cancelled=events.find(e=>e.kind==='task_inbox_owner_contact_cancelled'&&e.data.key===key)?.data;
    if(!record)return cancelled?{key,cancelled:true,cancellation:cancelled,compiled:null}:null;
    return {...record,cancelled:!!cancelled,cancellation:cancelled??null,compiled:compiled?{...compiled,request:parseTaskOwnerRequest(this.bytes(compiled.requestSha256)),proof:JSON.parse(this.bytes(compiled.proofSha256).toString()) as ImplementationOwnerProof}:null};
  }
  bindOwnerContact(task:string,key:string,proof:ImplementationOwnerProof){return this.transaction(()=>{
    const record=this.ownerContact(task,key);if(!record||record.cancelled)throw new Error('owner_contact_cancelled_or_missing');if(record.compiled)return record.compiled.request as TaskOwnerRequest;
    requireIssuedImplementationOwnerProof(proof);if(!this.ownerSnapshot||canonical(record.target)!==canonical(proof.target))throw new Error('owner_feedback_original_target_changed');checkImplementationOwnerSnapshot(this.ownerSnapshot(record.target),proof);
    const current=this.tasks.current(proof.target.task);if(current.fingerprint!==proof.observation.materialSha256||current.manifest.candidate.H!==proof.H)throw new Error('owner_feedback_current_observation_required');
    const template=parseTaskOwnerRequest(this.bytes(record.recipientSha256)),request:TaskOwnerRequest={...template,from:record.sender,ownerContact:{task,key}},raw=Buffer.from(canonical(request));
    // The proof is visible to enqueue validation only within this same original
    // transaction; a failure rolls back both binding and recipient enqueue.
    this.event(task,'owner_contact_bound',{key,requestSha256:this.blob(raw),proofSha256:this.blob(Buffer.from(canonical(proof)))});this.enqueueValue(raw);return request;
  });}
  ownerContactCancelTarget(task:string,key:string){
    const record=this.ownerContact(task,key);if(!record||record.cancelled||!record.compiled)return null;
    const recipient=record.compiled.request as TaskOwnerRequest,entry=this.entry(recipient.task,recipient.id),answered=entry.selected&&this.completed(entry.selected.run),next=answered?parseTaskOwnerRequest(this.bytes(record.followupSha256)):recipient;
    const queued=this.events(next.task).find(e=>e.kind==='task_inbox_queued'&&e.data.id===next.id)?.data;
    if(!queued)return null;
    const selected=this.entry(next.task,next.id);if(selected.events.some(e=>e.kind==='task_inbox_cancelled'&&e.data.id===next.id))return null;
    if(answered&&selected.selected&&this.completed(selected.selected.run))throw new Error('owner_contact_already_completed');
    return {task:next.task,id:next.id,requestSha256:queued.requestSha256};
  }
  ownerContactApplicability(task:string,key:string){
    const record=this.ownerContact(task,key);if(!record||record.cancelled)return {current:false,reason:record?.cancelled?'owner_contact_cancelled':'owner_contact_not_registered'};
    try{if(!this.ownerSnapshot)throw new Error('owner_contact_implementation_consumer_required');const snapshot=this.ownerSnapshot(record.target);checkImplementationOwnerSnapshot(snapshot,record.compiled?.proof);if(record.compiled)assertImplementationOwnerSourceSync(record.compiled.proof);return {current:!!record.compiled,reason:record.compiled?null:'owner_contact_current_proof_required'};}catch(e){return {current:false,reason:e instanceof Error?e.message:'owner_contact_original_unavailable'};}
  }
  cancelOwnerContact(task:string,key:string,source:string){return this.transaction(()=>{
    if(!isAuthorityDigest(key)||!source.trim()||source.length>2048)throw new Error('owner_contact_cancel_invalid');const record=this.ownerContact(task,key);if(record?.cancelled)return {cancelled:true,duplicate:true,newModelRequests:0};
    if(this.ownerContactCancelTarget(task,key))throw new Error('owner_contact_original_inbox_cancel_required');
    this.event(task,'owner_contact_cancelled',{key,source,knownContactNotEnqueued:!record?.compiled,originalsRetained:true,newModelRequests:0});return {cancelled:true,duplicate:false,newModelRequests:0};
  });}
  private ownerContactMaterial(request:TaskOwnerRequest):Row{
    const ref=request.ownerContact!,record=this.ownerContact(ref.task,ref.key);if(!record||record.cancelled||!record.compiled||!this.ownerSnapshot)throw new Error('owner_contact_cancelled_or_missing');
    const original=record.compiled.request as TaskOwnerRequest,recipient=request.task===record.target.task&&request.id===original.id,template=parseTaskOwnerRequest(this.bytes(recipient?record.recipientSha256:record.followupSha256)),{ownerContact,from,...plain}=request;
    if(canonical({...plain,from:null})!==canonical(template)||!recipient&&request.task!==ref.task)throw new Error('owner_contact_request_changed');
    const expected=recipient?record.sender:(()=>{const a=this.entry(original.task,original.id);if(!a.selected||!this.completed(a.selected.run))throw new Error('owner_contact_original_reply_or_resources_unresolved');return {task:original.task,run:a.selected.run,messageId:original.id};})();
    if(canonical(from)!==canonical(expected))throw new Error('owner_contact_sender_changed');
    const proof=record.compiled.proof as ImplementationOwnerProof;checkImplementationOwnerSnapshot(this.ownerSnapshot(record.target),proof);assertImplementationOwnerSourceSync(proof);
    if(this.tasks.current(record.target.task).fingerprint!==proof.observation.materialSha256)throw new Error('owner_feedback_source_no_longer_current');
    return {...proof.material,contact:{planSha256:record.planSha256,contactId:record.contactId,initialB:record.sender},originalBQuestion:record.question};
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
    if(!f.selected)throw new Error('task_original_interruption_required');const s=this.messages(f.selected.run).state;if(!f.request.nativeControls&&s.messages[0]?.interruption?.source!=='claude-authentication-cancellation-v1')throw new Error('task_original_interruption_required');
    if(s.messages.length!==1||s.messages[0].state!=='Interrupted'||s.runtimes.filter((r:Row)=>r.started).length!==1||s.runtimes.some((r:Row)=>r.started&&r.captureVerification?.proof.successfulCapture!==true)||s.resourcesSettled===false)throw new Error('task_original_interruption_or_resources_unresolved');
    const value={id,run:f.selected.run,source,originalRunCompleted:false,originalRetained:true,newModelRequests:0,interruption:s.messages[0].interruption,captures:s.runtimes.filter((r:Row)=>r.started).map((r:Row)=>({participant:r.participant,originals:r.ended.originals,proof:r.captureVerification.proof}))};this.event(task,'interrupted_closed',value);return {...value,duplicate:false};
  });}
  prepare(task:string,id:string){return this.transaction(()=>{
    const f=this.entry(task,id);if(f.selected)return this.selection(f.selected);
    const ai=f.request.nativeResume?{participant:f.request.participant,selection:null}:participantWithAI(f.request.participant,this.tasks.definition(task).repository);
    if(f.request.nativeControls&&ai.participant.tool!=='codex')throw new Error('ai_existing_control_profile_not_supported');
    this.scopeFamilyIdle?.(task);
    this.available(task,id);const currentTask=JSON.parse(this.tasks.context(task).toString()),projection=new TaskHistoryProjection(run=>this.historyExecution(run),{task,value:currentTask});
    const history=f.events.filter(e=>e.kind==='task_inbox_selected'&&!f.events.some(c=>c.kind==='task_inbox_cancelled'&&c.data.id===e.data.id)).map(e=>projection.execution(task,e.data.run,e.data.id));
    const coordination=this.coordination?.context(task,f.request.participant.id,f.request.participant.tool)??null,link=coordination?{planId:coordination.planId,task:coordination.task,contextSha256:coordination.sha256}:null;
    const scopeContinuation=projection.scope(this.scopeContinuation?.(task)??null),ownerFeedback=f.request.ownerContact?projection.ownerFeedback(this.ownerContactMaterial(f.request)):null;
    const context=Buffer.from(canonical({schemaVersion:2,kind:'tongxu-task-owner-context',task:currentTask,candidateAssociation:this.association?.(task,f.request.publicationReturn?.taskLink)??null,candidateAssociationHistory:this.associationHistory?.(task)??[],request:{id,question:f.request.question,source:f.request.source},sender:projection.sender(f.queued.sender),...(f.request.publicationReturn?{publicationReturn:this.publicationMaterial(task,f.request.publicationReturn)}:{}),...(link?{coordination:link}:{}),...(scopeContinuation?{scopeContinuation}:{}),...(ownerFeedback?{ownerFeedback}:{}),previousExecutions:history,historyProjection:projection.value(),newNativeContext:!f.request.nativeResume,nativeSessionResumed:false,...(f.request.nativeResume?{nativeSessionResumeRequested:f.request.nativeResume}:{}),externalSessionControl:false,permissionsGranted:false}));
    if(context.length>512*1024)throw new Error('task_complete_context_limit');const directory=join(this.directory,'task-inbox',task,id),contextSha256=this.blob(context),plan=planFor({...f.request,participant:ai.participant},join(directory,'context.json'),contextSha256);
    if(ai.selection){const aiBytes=Buffer.from(canonical({kind:'tongxu-local-role-selection',requestSha256:f.queued.requestSha256,selection:ai.selection,originalParticipant:f.request.participant,actualParticipant:ai.participant,permissionsGranted:false}));plan.material.push({name:'ai-selection.json',path:join(directory,'ai-selection.json'),sha256:this.blob(aiBytes)});}
    if(coordination){plan.material.push({name:'coordination-context.json',path:join(directory,'coordination-context.json'),sha256:coordination.sha256});plan.consumeMaterial!.push('coordination-context.json');plan.messages[0]!.body+='\n\nThis task remains with its original assigned actor. Read the supplied coordination-context.json as data for assigned task '+coordination.task+'. Return the required outer message receipt; its report must be a JSON string matching context.responseContract. Preserve complete reasoning, name each affected part and its exact hash, and use agreed, conflict or unknown based on evidence. Feedback grants no writing authority.';
      if(f.request.contactSelection)plan.messages[0]!.body+='\nThis is the initial optional-contact inquiry for fixed plan '+f.request.contactSelection.planSha256+'. If a listed contact is needed, use the exact contact-request report format in the original question instead of claiming final coordination feedback. The later original-owner synthesis supplies that feedback. If no contact is needed, return normal complete coordination feedback now. Contact selection itself grants no stage or writing permission.';}
    if(ownerFeedback)plan.messages[0]!.body+='\nRead ownerFeedback and its complete original report in the supplied historyProjection tables. This is a NEW readonly context bound to the exact original implementation responsibility and current committed result, not recovery of that old native session or approval of an uncommitted plan. Address the actual sender question and state which head/contract your feedback applies to; preserve unknown or conflict. Return the original complete message receipt, including any current coordination response contract. No write, test, publication or merge permission is granted.';
    const value={id,run:messagePlanId(plan),directory,contextSha256,planSha256:this.blob(Buffer.from(canonical(plan))),...(link?{coordination:link}:{})};
    if(coordination)this.coordination!.bind(coordination.planId,Buffer.from(canonical(plan)),coordination.sha256,[{task:coordination.task,messageId:id}]);
    this.event(task,'selected',value);return this.selection(value);
  });}
  private historyExecution(run:string):OriginalTaskExecution{
    const links=this.db.prepare("SELECT object,data FROM events WHERE kind='task_inbox_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(links.length!==1)throw new Error('task_history_original_selection_required');
    const task=links[0]!.object,value=JSON.parse(links[0]!.data).value,f=this.entry(task,value.id),selected=this.selection(f.selected),original=this.messages(run);
    if(selected.run!==run||canonical(original.state.plan)!==canonical(parseMessagePlan(selected.plan)))throw new Error('task_history_original_binding_changed');
    return {task,request:f.request.id,context:selected.context,inputs:original.inputs,state:original.state,interrupted:f.events.some(e=>e.kind==='task_inbox_interrupted_closed'&&e.data.id===f.request.id)};
  }
  originalInput(task:string,run:string,messageId:string,sha256:string){return this.transaction(()=>{
    const original=this.historyExecution(run);
    if(original.task!==task)throw new Error('task_history_execution_identity_changed');
    const input=original.inputs.find((input:Row)=>input.messageId===messageId),sent=original.state.messages.find((m:Row)=>m.id===messageId)?.sent;
    if(!input||!sent||sent.inputSha256!==sha256||hash(canonical(input))!==sha256)throw new Error('task_history_input_identity_changed');
    return Buffer.from(canonical(input));
  });}
  private selection(v:Row):Row&{plan:Buffer;context:Buffer;coordinationContext?:Buffer;aiSelection?:Buffer}{const plan=this.bytes(v.planSha256),context=this.bytes(v.contextSha256),parsed=parseMessagePlan(plan);if(messagePlanId(parsed)!==v.run)throw new Error('task_selected_run_changed');const ai=parsed.material.find(m=>m.name==='ai-selection.json');return {...v,plan,context,...(ai?{aiSelection:this.bytes(ai.sha256)}:{}),...(v.coordination?{coordinationContext:this.bytes(v.coordination.contextSha256)}:{})};}
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
    this.scopeFamilyIdle?.(task);
    const associated=JSON.parse(exact.context.toString()).candidateAssociation;if(associated)this.checkAssociation?.(task,associated.association.link);
    if(canonical(state.plan)!==canonical(parseMessagePlan(exact.plan))||taskParticipants[0].item!==task||state.registration.materials['task-owner-context.json']?.sha256!==selected.contextSha256)throw new Error('task_owner_dispatch_changed');
  }
  ownerContactResourceTarget(run:string,operation:string){
    this.gate(run);
    const rows=this.db.prepare("SELECT object,data FROM events WHERE kind='task_inbox_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(rows.length!==1)throw new Error('owner_contact_original_resource_binding_required');
    const selected=JSON.parse(rows[0]!.data).value,request=this.entry(rows[0]!.object,selected.id).request;
    if(!request.ownerContact)throw new Error('owner_contact_original_resource_binding_required');
    const material=this.ownerContactMaterial(request),target=material.originalTarget as ImplementationOwnerTarget;
    if(target.operation!==operation||target.task!==request.task)throw new Error('owner_contact_original_resource_binding_required');return target;
  }
  status(task:string){this.tasks.current(task);return this.transaction(()=>this.events(task).filter(e=>e.kind==='task_inbox_queued').map(e=>{
    const f=this.entry(task,e.data.id);let phase='queued',reason:string|null=null,route:Row|null=null,nativeControls:Row[]=[];
    if(f.events.some(e=>e.kind==='task_inbox_cancelled'&&e.data.id===f.request.id))phase='cancelled';
    else if(f.selected){try{const s=this.messages(f.selected.run).state;route=s.runtimes[0]?.route??null;nativeControls=s.nativeControls??[];phase=this.completed(f.selected.run)?'returned':s.runtimes.some((r:Row)=>r.started&&!r.ended)?'active_or_unknown':s.messages.some((m:Row)=>m.state==='Interrupted')?'interrupted':s.messages.some((m:Row)=>m.sent)?'unresolved':'prepared';}catch(error){if((error as Error).message==='original_message_run_required')phase='prepared';else{phase='unresolved';reason=(error as Error).message;}}}
    if(phase==='queued'||phase==='prepared')try{this.available(task,e.data.id);}catch(error){phase='waiting';reason=(error as Error).message;}
    if(f.events.some(e=>e.kind==='task_inbox_interrupted_closed'&&e.data.id===f.request.id))phase='interrupted_closed';
    return {id:e.data.id,task,requestSha256:e.data.requestSha256,packet:e.data.packet,currentMaterial:this.tasks.current(task).packet===e.data.packet&&(!f.selected||this.associationStatus(f.selected.run)?.current!==false),sourceSha256:e.data.sourceSha256,phase,reason,run:f.selected?.run??null,...(f.selected?.coordination?{coordination:f.selected.coordination}:{}),role:'issue_owner',actor:f.request.participant.id,tool:f.request.participant.tool,sessionId:route?.sessionId??null,...(f.request.nativeControls?{nativeControls}:{}),nativeSessionResumed:route?.nativeSessionResumed===true,...(f.request.nativeResume?{nativeResumeRequested:f.request.nativeResume,resumedFrom:route?.resumedFrom??null}:{}),externalSessionControl:false};
  }));}
}
