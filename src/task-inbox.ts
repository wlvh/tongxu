import type {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {parseMessagePlan,messagePlanId,messageId,type MessagePlan,type MessageParticipant} from './message-contract.js';
import type {TaskRecords} from './task-store.js';
type Row=Record<string,any>;
export type TaskOwnerRequest={schemaVersion:1;kind:'tongxu-task-owner-request';id:string;task:string;source:string;question:string;from:null|{task:string;run:string;messageId:string};participant:MessageParticipant;executionKind:MessagePlan['executionKind'];authorityIntent:string|null;resourceBudget?:MessagePlan['resourceBudget'];billing:MessagePlan['billing'];timeoutMs:number};
function planFor(p:TaskOwnerRequest,path:string,sha256:string):MessagePlan{return {schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:p.executionKind,source:p.source,authorityIntent:p.authorityIntent,...(p.resourceBudget?{resourceBudget:p.resourceBudget}:{}),participants:[p.participant],messages:[{id:p.id,from:null,to:p.participant.id,body:p.question,replies:[]}],material:[{name:'task-owner-context.json',path,sha256}],consumeMaterial:['task-owner-context.json'],billing:p.billing,timeoutMs:p.timeoutMs};}
export function parseTaskOwnerRequest(raw:Buffer):TaskOwnerRequest{
  if(raw.length>64*1024)throw new Error('task_request_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','id','task','source','question','from','participant','executionKind','authorityIntent','billing','timeoutMs',...(p&&Object.hasOwn(p,'resourceBudget')?['resourceBudget']:[])])||p.schemaVersion!==1||p.kind!=='tongxu-task-owner-request'||!messageId(p.id)||!isAuthorityDigest(p.task)||p.participant?.item!==p.task||p.participant?.role!=='issue_owner'||p.participant?.parent!==null||!(p.from===null||exactKeys(p.from,['task','run','messageId'])&&isAuthorityDigest(p.from.task)&&p.from.task!==p.task&&isAuthorityDigest(p.from.run)&&messageId(p.from.messageId)))throw new Error('task_request_invalid');
  parseMessagePlan(Buffer.from(canonical(planFor(p,'/task-context.json','0'.repeat(64)))));return p;
}

/** A finite inbox for a program-owned responsibility. A follow-up gets a new
 * native context only after the preceding exact execution is proven ended.
 * Imported App sessions and caller-written actor names are not control rights. */
export class TaskInbox {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private directory:string,private tasks:TaskRecords,private messages:(run:string)=>Row){}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('task_inbox_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(task:string,kind:string,value:unknown){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('task_inbox_'+kind,task,canonical({value,sha256:this.blob(Buffer.from(canonical(value)))}),now());}
  private events(task:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'task_inbox_%' ORDER BY id").all(task) as Row[]).map(e=>{const r=JSON.parse(e.data);if(canonical(JSON.parse(this.bytes(r.sha256).toString()))!==canonical(r.value))throw new Error('task_inbox_history_changed');return {...e,data:r.value};});}
  private entry(task:string,id:string){this.tasks.current(task);const events=this.events(task),q=events.find(e=>e.kind==='task_inbox_queued'&&e.data.id===id)?.data;if(!q)throw new Error('task_request_not_queued');const request=parseTaskOwnerRequest(this.bytes(q.requestSha256));if(request.task!==task||request.id!==id)throw new Error('task_request_identity_changed');return {events,queued:q,request,selected:events.find(e=>e.kind==='task_inbox_selected'&&e.data.id===id)?.data??null};}
  private completed(run:string){let s:Row;try{s=this.messages(run).state;}catch(e){if((e as Error).message==='original_message_run_required')return false;throw e;}return s.messages.length>0&&s.messages.every((m:Row)=>m.state==='Reply'&&m.reply?.reportedConsumption===true)&&s.runtimes.filter((r:Row)=>r.started).every((r:Row)=>r.captureVerification?.proof.successfulCapture===true)&&s.resourcesSettled!==false;}
  private captured(from:NonNullable<TaskOwnerRequest['from']>){const source=this.messages(from.run),s=source.state,m=s.messages.find((m:Row)=>m.id===from.messageId),p=s.plan.participants.find((p:Row)=>p.id===m?.to),r=s.runtimes.find((r:Row)=>r.participant===p?.id),current=this.tasks.current(from.task),binding=s.registration.bindings[p?.id];
    if(p?.item!==from.task||m?.state!=='Reply'||!m.reply?.reportedConsumption||r?.captureVerification?.proof.successfulCapture!==true||binding?.packet!==current.packet||binding?.fingerprint!==current.fingerprint)throw new Error('task_contact_requires_current_captured_sender');
    return {task:from.task,run:from.run,messageId:from.messageId,sourceSha256:current.fingerprint,route:r.route,reply:m.reply};
  }
  enqueue(raw:Buffer){return this.transaction(()=>{
    const p=parseTaskOwnerRequest(raw),current=this.tasks.current(p.task),events=this.events(p.task),requestSha256=hash(canonical(p)),old=events.find(e=>e.kind==='task_inbox_queued'&&e.data.id===p.id)?.data;
    if(old){if(old.requestSha256!==requestSha256)throw new Error('task_request_id_is_fixed');return {...old,duplicate:true};}
    const owner=events.find(e=>e.kind==='task_inbox_queued')?.data;if(owner){const first=parseTaskOwnerRequest(this.bytes(owner.requestSha256));if(canonical(first.participant)!==canonical(p.participant)||first.executionKind!==p.executionKind)throw new Error('task_original_responsibility_is_fixed');}
    if(events.filter(e=>e.kind==='task_inbox_queued').length>=32)throw new Error('task_inbox_bound');
    if(p.from&&canonical(this.tasks.current(p.from.task).context.scope)!==canonical(current.context.scope))throw new Error('task_contact_scope_mismatch');
    const sender=p.from?this.captured(p.from):null,value={id:p.id,requestSha256:this.blob(Buffer.from(canonical(p))),packet:current.packet,sourceSha256:current.fingerprint,sender};this.event(p.task,'queued',value);return {...value,duplicate:false};
  });}
  private available(task:string,id:string){
    const f=this.entry(task,id),current=this.tasks.current(task);if(f.events.some(e=>e.kind==='task_inbox_cancelled'&&e.data.id===id))throw new Error('task_request_cancelled');if(current.packet!==f.queued.packet||current.fingerprint!==f.queued.sourceSha256)throw new Error('task_queued_source_changed');if(f.request.from&&canonical(this.captured(f.request.from))!==canonical(f.queued.sender))throw new Error('task_contact_source_changed');
    for(const e of f.events.filter(e=>e.kind==='task_inbox_queued')){if(e.data.id===id)break;if(f.events.some(c=>c.kind==='task_inbox_cancelled'&&c.data.id===e.data.id))continue;const previous=this.entry(task,e.data.id);if(!previous.selected||!this.completed(previous.selected.run))throw new Error('task_original_responsibility_pending');}
    return f;
  }
  cancelUnsent(task:string,id:string,source:string){return this.transaction(()=>{
    if(typeof source!=='string'||!source.trim()||source.length>2048)throw new Error('task_cancel_source_required');const f=this.entry(task,id),prior=f.events.find(e=>e.kind==='task_inbox_cancelled'&&e.data.id===id);if(prior)return {...prior.data,duplicate:true};
    let proof:Row={selectionCreated:false};
    if(f.selected){
      if(this.db.prepare("SELECT 1 FROM events WHERE kind='message_resource_bound' AND object=?").get('message-resource:'+f.selected.run))throw new Error('task_original_resource_investment_must_be_resolved');
      let s:Row|null=null;try{s=this.messages(f.selected.run).state;}catch(e){if((e as Error).message!=='original_message_run_required')throw e;}
      if(s&&(s.messages.some((m:Row)=>m.sent)||s.runtimes.some((r:Row)=>r.started&&r.ended?.proof.knownUnstarted!==true)))throw new Error('task_original_execution_active_or_unknown');
      proof={selectionCreated:true,run:f.selected.run,registered:!!s,knownUnstarted:s?.runtimes.map((r:Row)=>({participant:r.participant,attempt:r.attempt,ended:r.ended}))??[]};
    }
    const value={id,source,proof,newModelRequests:0,originalRetained:true};this.event(task,'cancelled',value);return {...value,duplicate:false};
  });}
  prepare(task:string,id:string){return this.transaction(()=>{
    const f=this.entry(task,id);if(f.selected)return this.selection(f.selected);
    this.available(task,id);const history=f.events.filter(e=>e.kind==='task_inbox_selected'&&!f.events.some(c=>c.kind==='task_inbox_cancelled'&&c.data.id===e.data.id)).map(e=>{const original=this.messages(e.data.run),s=original.state;return {originalRoleInputs:original.inputs,request:e.data.id,run:e.data.run,bindings:s.registration.bindings,reports:s.messages.map((m:Row)=>({id:m.id,recipient:m.sent.recipient,receipt:m.reply})),nativeSessionResumed:false};});
    const context=Buffer.from(canonical({schemaVersion:1,kind:'tongxu-task-owner-context',task:JSON.parse(this.tasks.context(task).toString()),request:{id,question:f.request.question,source:f.request.source},sender:f.queued.sender,previousExecutions:history,newNativeContext:true,nativeSessionResumed:false,externalSessionControl:false,permissionsGranted:false}));
    if(context.length>512*1024)throw new Error('task_complete_context_limit');const directory=join(this.directory,'task-inbox',task,id),contextSha256=this.blob(context),plan=planFor(f.request,join(directory,'context.json'),contextSha256),value={id,run:messagePlanId(plan),directory,contextSha256,planSha256:this.blob(Buffer.from(canonical(plan)))};
    this.event(task,'selected',value);return this.selection(value);
  });}
  private selection(v:Row):Row&{plan:Buffer;context:Buffer}{const plan=this.bytes(v.planSha256),context=this.bytes(v.contextSha256);if(messagePlanId(parseMessagePlan(plan))!==v.run)throw new Error('task_selected_run_changed');return {...v,plan,context};}
  gate(run:string){
    const state=this.messages(run).state,taskParticipants=state.plan.participants.filter((p:Row)=>state.registration.bindings[p.id].candidate.kind==='development-task');if(!taskParticipants.length)return;
    const links=this.db.prepare("SELECT object,data FROM events WHERE kind='task_inbox_selected' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(links.length!==1||taskParticipants.length!==1||state.plan.participants.length!==1)throw new Error('task_registered_owner_dispatch_required');
    const task=links[0]!.object,selected=JSON.parse(links[0]!.data).value,f=this.available(task,selected.id),exact=this.selection(f.selected);
    if(canonical(state.plan)!==canonical(parseMessagePlan(exact.plan))||taskParticipants[0].item!==task||state.registration.materials['task-owner-context.json']?.sha256!==selected.contextSha256)throw new Error('task_owner_dispatch_changed');
  }
  status(task:string){this.tasks.current(task);return this.transaction(()=>this.events(task).filter(e=>e.kind==='task_inbox_queued').map(e=>{
    const f=this.entry(task,e.data.id);let phase='queued',reason:string|null=null,route:Row|null=null;
    if(f.events.some(e=>e.kind==='task_inbox_cancelled'&&e.data.id===f.request.id))phase='cancelled';
    else if(f.selected){try{const s=this.messages(f.selected.run).state;route=s.runtimes[0]?.route??null;phase=this.completed(f.selected.run)?'returned':s.runtimes.some((r:Row)=>r.started&&!r.ended)?'active_or_unknown':s.messages.some((m:Row)=>m.sent)?'unresolved':'prepared';}catch(error){if((error as Error).message==='original_message_run_required')phase='prepared';else{phase='unresolved';reason=(error as Error).message;}}}
    if(phase==='queued'||phase==='prepared')try{this.available(task,e.data.id);}catch(error){phase='waiting';reason=(error as Error).message;}
    return {id:e.data.id,task,packet:e.data.packet,currentMaterial:this.tasks.current(task).packet===e.data.packet,sourceSha256:e.data.sourceSha256,phase,reason,run:f.selected?.run??null,role:'issue_owner',actor:f.request.participant.id,tool:f.request.participant.tool,sessionId:route?.sessionId??null,nativeSessionResumed:false,externalSessionControl:false};
  }));}
}
