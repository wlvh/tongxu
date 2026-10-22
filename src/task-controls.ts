import {QueueStore} from './queue-store.js';
import {regular} from './repair-workspace.js';
import {parseTaskOwnerRequest,type TaskOwnerRequest,type TaskControllerReturn} from './task-inbox.js';
import {prepareTaskOwner,cancelUnsentTaskOwner} from './tasks.js';
import {runMessages} from './messages.js';
import {observeTaskWorkspace} from './task-source.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath,messageControlDigest} from './message-contract.js';
import type {MessageNativeHandle} from './message-runtime.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';

type Source={id:string;store:string;item:string};
type Entry={id:string;title:string;source:string;packet:number;sourceSha256:string;request:{path:string;sha256:string}};
type ScopeEntry={id:string;title:string;source:string;scopeSha256:string;control:'implementation'|'investment'|'merge'};
export type TaskControlCatalog={schemaVersion:1;kind:'tongxu-task-controls';contacts:Entry[]}|{schemaVersion:2;kind:'tongxu-task-controls';contacts:Entry[];scopeControls:ScopeEntry[]};
type Frozen={entry:Entry;source:Source;bytes:Buffer;request:TaskOwnerRequest;requestSha256:string};
type FrozenScope={entry:ScopeEntry;source:Source};
type Diagnostic={diagnosticRecorded:boolean;diagnosticError?:string;observationSha256?:string;duplicate?:boolean};
export class TaskControlRegistrationError extends Error{constructor(reason:string,readonly diagnostic:Diagnostic){super(reason);}}
const errorCode=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'task_control_failed';

export function parseTaskControlCatalog(raw:Buffer):TaskControlCatalog{
  if(raw.length>64*1024)throw new Error('task_control_catalog_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','contacts',...(p.schemaVersion===2?['scopeControls']:[])])||![1,2].includes(p.schemaVersion)||p.kind!=='tongxu-task-controls'||!Array.isArray(p.contacts)||p.contacts.length>8||p.schemaVersion===1&&!p.contacts.length)throw new Error('task_control_catalog_invalid');
  const ids=new Set<string>();for(const c of p.contacts){if(!exactKeys(c,['id','title','source','packet','sourceSha256','request'])||!messageId(c.id)||ids.has(c.id)||typeof c.title!=='string'||!c.title.trim()||c.title.length>160||/[\x00-\x1f]/.test(c.title)||typeof c.source!=='string'||!/^[a-z0-9-]{1,64}$/.test(c.source)||!Number.isSafeInteger(c.packet)||c.packet<1||!isAuthorityDigest(c.sourceSha256)||!exactKeys(c.request,['path','sha256'])||!messagePath(c.request.path)||!isAuthorityDigest(c.request.sha256))throw new Error('task_control_contact_invalid');ids.add(c.id);}
  if(p.schemaVersion===2){if(!Array.isArray(p.scopeControls)||p.scopeControls.length>24||!p.contacts.length&&!p.scopeControls.length)throw new Error('scope_control_catalog_invalid');const scopes=new Set();for(const c of p.scopeControls){if(!exactKeys(c,['id','title','source','scopeSha256','control'])||!messageId(c.id)||scopes.has(c.id)||typeof c.title!=='string'||!c.title.trim()||c.title.length>160||/[\x00-\x1f]/.test(c.title)||typeof c.source!=='string'||!/^[a-z0-9-]{1,64}$/.test(c.source)||!isAuthorityDigest(c.scopeSha256)||!['implementation','investment','merge'].includes(c.control))throw new Error('scope_control_catalog_entry_invalid');scopes.add(c.id);}}
  return p;
}

/** A fixed set of operator-supplied readonly requests, backed by the original
 * task inbox and message executor. The access key never becomes Owner proof. */
export class TaskControls{
  private active=new Map<string,Promise<unknown>>();
  private unsavedReturns=new Map<string,{stage:string;reason:string|null;diagnosticRecorded:false;diagnosticError:string;persisted:false}>();
  private preparing=new Set<Promise<unknown>>();
  private accepting=true;
  private native=new Map<string,MessageNativeHandle>();
  private constructor(private readonly frozen:Frozen[],readonly catalogSha256:string,private readonly scopes:FrozenScope[]){}
  static async load(path:string,sha256:string,sources:Source[]){
    if(!messagePath(path)||!isAuthorityDigest(sha256))throw new Error('task_control_catalog_reference_invalid');const raw=await regular(path,64*1024);if(hash(raw)!==sha256)throw new Error('task_control_catalog_changed');const p=parseTaskControlCatalog(raw),frozen:Frozen[]=[],requests=new Set<string>();
    for(const entry of p.contacts){const source=sources.find(s=>s.id===entry.source);if(!source)throw new Error('task_control_source_not_selected');const bytes=await regular(entry.request.path,64*1024);if(hash(bytes)!==entry.request.sha256)throw new Error('task_control_request_changed');const request=parseTaskOwnerRequest(bytes);if(request.task!==source.item||request.from!==null)throw new Error('task_control_request_route_invalid');const identity=source.store+':'+request.task+':'+request.id;if(requests.has(identity))throw new Error('task_control_duplicate_request');requests.add(identity);frozen.push({entry,source:{...source},bytes:Buffer.from(bytes),request,requestSha256:hash(canonical(request))});}
    const scopes:FrozenScope[]=[],keys=new Set();for(const entry of p.schemaVersion===2?p.scopeControls:[]){const source=sources.find(s=>s.id===entry.source);if(!source)throw new Error('scope_control_source_not_selected');const key=canonical([source.store,entry.scopeSha256,entry.control]);if(keys.has(key))throw new Error('scope_control_duplicate_binding');keys.add(key);scopes.push({entry,source:{...source}});}return new TaskControls(frozen,sha256,scopes);
  }
  get mode(){return this.scopes.length?'bounded_task_controls':'bounded_task_contacts';}
  async scopeState(){return Promise.all(this.scopes.map(async f=>{const base={id:f.entry.id,title:f.entry.title,source:f.entry.source,control:f.entry.control,ownerApproval:false,permissionsGranted:false};try{const q=await QueueStore.observe(f.source.store),item=q.items.find((x:any)=>x.id===f.source.item);if(!item||hash(canonical(item.context.scope))!==f.entry.scopeSha256)throw new Error('local_scope_control_scope_changed');const scope=item.context.scope,c=q.controls.find((c:any)=>c.scope===scope.id&&c.kind===f.entry.control),owner=q.events.filter((e:any)=>e.kind==='authority_control_applied'&&e.object===scope.id&&JSON.parse(e.data).control===f.entry.control).at(-1),adoption=q.events.filter((e:any)=>e.kind==='authority_scope_adopted'&&e.object==='authority-scope:'+scope.id).at(-1);if(adoption&&JSON.parse(adoption.data).scopeVersion!==scope.version)throw new Error('local_scope_control_adopted_version_changed');return {...base,available:true,scopeId:scope.id,scopeVersion:scope.version,scopeSha256:f.entry.scopeSha256,recorded:!!c,state:c?.stopped?'stopped':'open',revision:c?.revision??0,verifiedOwnerStop:!!owner&&JSON.parse(owner.data).state==='stopped',sourceSha256:c?hash(c.source):null,effectiveAt:c?.effective_at??null,affectsScope:true,externalStateRechecked:false};}catch(e){return {...base,available:false,reason:errorCode(e)};}}));}
  async setScope(id:string,state:string,revision:number){if(!this.accepting)throw new Error('task_control_server_closing');const f=this.scopes.find(f=>f.entry.id===id);if(!f)throw new Error('scope_control_action_not_selected');if(!['stopped','open'].includes(state)||!Number.isSafeInteger(revision)||revision<0)throw new Error('scope_control_request_invalid');const request={schemaVersion:1,kind:'tongxu-local-scope-control',id:'ui-'+hash(canonical([this.catalogSha256,id,state,revision])).slice(0,56),item:f.source.item,scopeSha256:f.entry.scopeSha256,control:f.entry.control,state,expectedRevision:revision,source:'fixed-local-scope-control:'+this.catalogSha256+':'+id},q=await QueueStore.open(f.source.store);try{if(!this.accepting)throw new Error('task_control_server_closing');return q.scopeControls().apply(Buffer.from(canonical(request)));}finally{q.close();}}
  private selected(id:string){const f=this.frozen.find(f=>f.entry.id===id);if(!f)throw new Error('task_control_action_not_selected');return f;}
  private async recordReturn(f:Frozen,result:Omit<TaskControllerReturn,'catalogSha256'|'actionId'|'expectedPacket'|'expectedSourceSha256'>,detail:unknown){let q:QueueStore|undefined;try{q=await QueueStore.open(f.source.store);const value={...result,catalogSha256:this.catalogSha256,actionId:f.entry.id,expectedPacket:f.entry.packet,expectedSourceSha256:f.entry.sourceSha256},record=q.taskInbox().recordControllerReturn(f.bytes,value,Buffer.from(typeof detail==='string'?detail:canonical(detail)));this.unsavedReturns.delete(f.entry.id);return {diagnosticRecorded:true,...record};}catch(e){const failure={stage:result.stage,reason:result.reason,diagnosticRecorded:false as const,diagnosticError:errorCode(e),persisted:false as const};this.unsavedReturns.set(f.entry.id,failure);return {diagnosticRecorded:false,diagnosticError:failure.diagnosticError};}finally{q?.close();}}
  manifest(){return {catalogSha256:this.catalogSha256,contacts:this.frozen.map(f=>({id:f.entry.id,title:f.entry.title,source:f.entry.source,task:f.source.item,requestId:f.request.id,requestSha256:f.requestSha256,question:f.request.question,actor:f.request.participant.id,tool:f.request.participant.tool,role:'issue_owner',executionKind:f.request.executionKind,permissionsGranted:false}))};}
  private async stateOf(f:Frozen){
    const q=await QueueStore.observe(f.source.store,[f.source.item],[],[f.source.item]),item=q.items.find((x:any)=>x.id===f.source.item);if(!item?.developmentTask)throw new Error('task_control_development_task_required');
    const request=item.developmentTask.inbox.find((x:any)=>x.id===f.request.id);if(request&&request.requestSha256!==f.requestSha256)throw new Error('task_control_original_request_changed');
    const returns=(item.developmentTask.controllerReturns??[]).filter((r:any)=>r.id===f.request.id&&r.requestSha256===f.requestSha256);return {id:f.entry.id,title:f.entry.title,source:f.entry.source,task:f.source.item,requestId:f.request.id,requestSha256:f.requestSha256,catalogSha256:this.catalogSha256,executionKind:f.request.executionKind,...(f.request.nativeResume?{nativeResumeRequested:f.request.nativeResume,nativeSessionResumed:request?.nativeSessionResumed===true,resumedFrom:request?.resumedFrom??null}:{}),currentMaterial:item.currentPacket===f.entry.packet&&item.candidate.sourceSha256===f.entry.sourceSha256,phase:request?.phase??'not_registered',reason:request?.reason??null,run:request?.run??null,sessionId:request?.sessionId??null,...(f.request.nativeControls?{nativeControl:this.native.get(f.entry.id)?.state()??null,nativeControlHistory:request?.nativeControls??[]}:{}),lastControllerReturn:returns.at(-1)??null,controllerReturnCount:returns.length,unsavedControllerReturn:this.unsavedReturns.get(f.entry.id)??null,controllerActive:this.active.has(f.entry.id),permissionsGranted:false,ownerApproval:false,externalSessionControl:false};
  }
  async state(id?:string){const selected=id?[this.selected(id)]:this.frozen;return Promise.all(selected.map(async f=>{try{return {...await this.stateOf(f),available:true};}catch(e){return {id:f.entry.id,title:f.entry.title,source:f.entry.source,available:false,reason:errorCode(e),permissionsGranted:false,ownerApproval:false};}}));}
  async begin(id:string,beforeRegistration?:()=>void){return (await this.start(id,beforeRegistration)).registration;}
  private async start(id:string,beforeRegistration?:()=>void){
    if(!this.accepting)throw new Error('task_control_server_closing');const f=this.selected(id),pending=this.beginPrepared(id,beforeRegistration).catch(async e=>{const diagnostic=await this.recordReturn(f,{stage:'registration',run:null,completed:false,resourcesSettled:null,newModelRequests:null,reason:errorCode(e)},e instanceof Error?e.stack??e.message:String(e));throw new TaskControlRegistrationError(errorCode(e),diagnostic);});this.preparing.add(pending);try{return await pending;}finally{this.preparing.delete(pending);}
  }
  private async beginPrepared(id:string,beforeRegistration?:()=>void){
    if(!this.accepting)throw new Error('task_control_server_closing');const f=this.selected(id),running=this.active.get(id);if(running)return {work:running,registration:{accepted:true,duplicate:true,action:id,state:await this.state(id)}};
    const q=await QueueStore.open(f.source.store);try{
      if(q.taskLinks().hasSource(f.source.item))await q.refreshTaskLinkSource(f.source.item);else{const p=q.tasks().definition(f.source.item);q.tasks().observe(p,await observeTaskWorkspace(p));}
      const current=q.tasks().current(f.source.item);if(current.packet!==f.entry.packet||current.fingerprint!==f.entry.sourceSha256)throw new Error('task_control_candidate_changed');
      if(!this.accepting)throw new Error('task_control_server_closing');beforeRegistration?.();q.taskInbox().enqueue(f.bytes,{packet:f.entry.packet,sourceSha256:f.entry.sourceSha256});
    }finally{q.close();}
    // No new scheduler state: repeated and competing controllers encounter the
    // same original request, selection, runtime lock and capture checks.
    let work=this.active.get(id);if(!work){work=this.executeFrozen(f).finally(()=>this.active.delete(id));this.active.set(id,work);}
    // Retain this invocation's exact execution promise across a slow state read.
    // A later replay may finish before this caller returns; it is a different observation.
    return {work,registration:{accepted:true,action:id,state:await this.state(id),registrationIsNotDelivery:true}};
  }
  private async executeFrozen(f:Frozen){let run:string|null=null;try{const p=await prepareTaskOwner(f.source.store,f.source.item,f.request.id);run=p.run;const result=await runMessages(f.source.store,p.plan,false,p.run,undefined,(_participant,handle)=>{if(handle)this.native.set(f.entry.id,handle);else this.native.delete(f.entry.id);}),reason=result.completed?null:typeof result.problems?.at(-1)?.reason==='string'&&/^[a-z0-9_]+$/.test(result.problems.at(-1)!.reason)?result.problems.at(-1)!.reason:'task_execution_incomplete',diagnostic=await this.recordReturn(f,{stage:'execution',run,completed:result.completed,resourcesSettled:result.resourcesSettled??null,newModelRequests:result.newModelRequests??null,reason},result.problems??[]);return {action:f.entry.id,run:p.run,completed:result.completed,resourcesSettled:result.resourcesSettled,newModelRequests:result.newModelRequests,...diagnostic};}catch(e){const diagnostic=await this.recordReturn(f,{stage:'execution',run,completed:false,resourcesSettled:null,newModelRequests:null,reason:errorCode(e)},e instanceof Error?e.stack??e.message:String(e));return {action:f.entry.id,completed:false,reason:errorCode(e),automaticResend:false,...diagnostic};}finally{this.native.delete(f.entry.id);}}
  async controlNative(id:string,body:any){
    if(!exactKeys(body,['option','threadId','sessionId','turnId'])||!messageId(body.option)||['threadId','sessionId','turnId'].some(k=>typeof body[k]!=='string'||!/^[-A-Za-z0-9_.:]{1,128}$/.test(body[k])))throw new Error('task_native_control_exact_request_required');
    const f=this.selected(id),state=await this.stateOf(f),option=f.request.nativeControls?.find(c=>c.id===body.option);if(!option||!state.run)throw new Error('task_native_control_not_selected');
    const prior=state.nativeControlHistory?.find((c:any)=>c.request.id===messageControlDigest(state.run!,option));
    if(prior){if(['threadId','sessionId','turnId'].some(k=>prior.request[k]!==body[k]))throw new Error('task_native_control_original_target_changed');return {action:id,duplicate:true,acknowledged:prior.acknowledged,turnTerminationVerified:prior.turnTerminationVerified,automaticResend:false};}
    const handle=this.native.get(id);if(!handle||!this.accepting)throw new Error('task_native_control_original_controller_required');
    const result=await handle.control(body.option,{threadId:body.threadId,sessionId:body.sessionId,turnId:body.turnId});return {action:id,duplicate:false,...result.data};
  }
  async execute(id:string,beforeRegistration?:()=>void){const {registration,work}=await this.start(id,beforeRegistration),execution=await work;return {registration,execution,state:await this.state(id)};}
  async report(id:string){const f=this.selected(id),state=await this.stateOf(f);if(!state.run)throw new Error('task_control_report_not_returned');return QueueStore.observeMessageReport(f.source.store,f.source.item,state.run,f.request.id);}
  async cancel(id:string){const f=this.selected(id),result=await cancelUnsentTaskOwner(f.source.store,f.source.item,f.request.id,'fixed-task-control:'+this.catalogSha256+':'+id,f.requestSha256);return {action:id,result,state:await this.state(id),cancelIsNotProcessTermination:true};}
  async closeInterrupted(id:string){
    const f=this.selected(id);if(this.active.has(id)||this.native.has(id))throw new Error('task_native_control_original_controller_active');
    // Recover the same frozen run under its existing controller lock. This
    // does not submit input or settle a new investment on the user's behalf.
    const selected=await prepareTaskOwner(f.source.store,f.source.item,f.request.id),recovered=await runMessages(f.source.store,selected.plan,true,selected.run);
    if('recoveryErrors' in recovered&&recovered.recoveryErrors?.length)throw new Error('task_original_interruption_capture_unresolved');
    const q=await QueueStore.open(f.source.store);try{return {action:id,result:q.taskInbox().closeInterrupted(f.source.item,f.request.id,'fixed-task-control:'+this.catalogSha256+':'+id,f.requestSha256),newModelRequests:0};}finally{q.close();}
  }
  async drain(){this.accepting=false;while(this.preparing.size||this.active.size)await Promise.allSettled([...this.preparing,...this.active.values()]);}
}
