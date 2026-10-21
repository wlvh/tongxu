import {QueueStore} from './queue-store.js';
import {regular} from './repair-workspace.js';
import {parseTaskOwnerRequest,type TaskOwnerRequest} from './task-inbox.js';
import {prepareTaskOwner} from './tasks.js';
import {runMessages} from './messages.js';
import {observeTaskWorkspace} from './task-source.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';

type Source={id:string;store:string;item:string};
type Entry={id:string;title:string;source:string;packet:number;sourceSha256:string;request:{path:string;sha256:string}};
export type TaskControlCatalog={schemaVersion:1;kind:'tongxu-task-controls';contacts:Entry[]};
type Frozen={entry:Entry;source:Source;bytes:Buffer;request:TaskOwnerRequest;requestSha256:string};
const errorCode=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'task_control_failed';

export function parseTaskControlCatalog(raw:Buffer):TaskControlCatalog{
  if(raw.length>64*1024)throw new Error('task_control_catalog_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','contacts'])||p.schemaVersion!==1||p.kind!=='tongxu-task-controls'||!Array.isArray(p.contacts)||!p.contacts.length||p.contacts.length>8)throw new Error('task_control_catalog_invalid');
  const ids=new Set<string>();for(const c of p.contacts){if(!exactKeys(c,['id','title','source','packet','sourceSha256','request'])||!messageId(c.id)||ids.has(c.id)||typeof c.title!=='string'||!c.title.trim()||c.title.length>160||/[\x00-\x1f]/.test(c.title)||typeof c.source!=='string'||!/^[a-z0-9-]{1,64}$/.test(c.source)||!Number.isSafeInteger(c.packet)||c.packet<1||!isAuthorityDigest(c.sourceSha256)||!exactKeys(c.request,['path','sha256'])||!messagePath(c.request.path)||!isAuthorityDigest(c.request.sha256))throw new Error('task_control_contact_invalid');ids.add(c.id);}
  return p;
}

/** A fixed set of operator-supplied readonly requests, backed by the original
 * task inbox and message executor. The access key never becomes Owner proof. */
export class TaskControls{
  private active=new Map<string,Promise<unknown>>();
  private preparing=new Set<Promise<unknown>>();
  private accepting=true;
  private constructor(private readonly frozen:Frozen[],readonly catalogSha256:string){}
  static async load(path:string,sha256:string,sources:Source[]){
    if(!messagePath(path)||!isAuthorityDigest(sha256))throw new Error('task_control_catalog_reference_invalid');const raw=await regular(path,64*1024);if(hash(raw)!==sha256)throw new Error('task_control_catalog_changed');const p=parseTaskControlCatalog(raw),frozen:Frozen[]=[],requests=new Set<string>();
    for(const entry of p.contacts){const source=sources.find(s=>s.id===entry.source);if(!source)throw new Error('task_control_source_not_selected');const bytes=await regular(entry.request.path,64*1024);if(hash(bytes)!==entry.request.sha256)throw new Error('task_control_request_changed');const request=parseTaskOwnerRequest(bytes);if(request.task!==source.item||request.from!==null)throw new Error('task_control_request_route_invalid');const identity=source.store+':'+request.task+':'+request.id;if(requests.has(identity))throw new Error('task_control_duplicate_request');requests.add(identity);frozen.push({entry,source:{...source},bytes:Buffer.from(bytes),request,requestSha256:hash(canonical(request))});}
    return new TaskControls(frozen,sha256);
  }
  private selected(id:string){const f=this.frozen.find(f=>f.entry.id===id);if(!f)throw new Error('task_control_action_not_selected');return f;}
  manifest(){return {catalogSha256:this.catalogSha256,contacts:this.frozen.map(f=>({id:f.entry.id,title:f.entry.title,source:f.entry.source,task:f.source.item,requestId:f.request.id,requestSha256:f.requestSha256,question:f.request.question,actor:f.request.participant.id,tool:f.request.participant.tool,role:'issue_owner',executionKind:f.request.executionKind,permissionsGranted:false}))};}
  private async stateOf(f:Frozen){
    const q=await QueueStore.observe(f.source.store,[f.source.item],[],[f.source.item]),item=q.items.find((x:any)=>x.id===f.source.item);if(!item?.developmentTask)throw new Error('task_control_development_task_required');
    const request=item.developmentTask.inbox.find((x:any)=>x.id===f.request.id);if(request&&request.requestSha256!==f.requestSha256)throw new Error('task_control_original_request_changed');
    return {id:f.entry.id,title:f.entry.title,source:f.entry.source,task:f.source.item,requestId:f.request.id,requestSha256:f.requestSha256,catalogSha256:this.catalogSha256,executionKind:f.request.executionKind,currentMaterial:item.currentPacket===f.entry.packet&&item.candidate.sourceSha256===f.entry.sourceSha256,phase:request?.phase??'not_registered',reason:request?.reason??null,run:request?.run??null,sessionId:request?.sessionId??null,controllerActive:this.active.has(f.entry.id),permissionsGranted:false,ownerApproval:false,externalSessionControl:false};
  }
  async state(id?:string){const selected=id?[this.selected(id)]:this.frozen;return Promise.all(selected.map(async f=>{try{return {...await this.stateOf(f),available:true};}catch(e){return {id:f.entry.id,title:f.entry.title,source:f.entry.source,available:false,reason:errorCode(e),permissionsGranted:false,ownerApproval:false};}}));}
  async begin(id:string,beforeRegistration?:()=>void){
    if(!this.accepting)throw new Error('task_control_server_closing');const pending=this.beginPrepared(id,beforeRegistration);this.preparing.add(pending);try{return await pending;}finally{this.preparing.delete(pending);}
  }
  private async beginPrepared(id:string,beforeRegistration?:()=>void){
    if(!this.accepting)throw new Error('task_control_server_closing');const f=this.selected(id),running=this.active.get(id);if(running)return {accepted:true,duplicate:true,action:id,state:await this.state(id)};
    const q=await QueueStore.open(f.source.store);try{
      if(q.taskLinks().hasSource(f.source.item))await q.refreshTaskLinkSource(f.source.item);else{const p=q.tasks().definition(f.source.item);q.tasks().observe(p,await observeTaskWorkspace(p));}
      const current=q.tasks().current(f.source.item);if(current.packet!==f.entry.packet||current.fingerprint!==f.entry.sourceSha256)throw new Error('task_control_candidate_changed');
      if(!this.accepting)throw new Error('task_control_server_closing');beforeRegistration?.();q.taskInbox().enqueue(f.bytes,{packet:f.entry.packet,sourceSha256:f.entry.sourceSha256});
    }finally{q.close();}
    // No new scheduler state: repeated and competing controllers encounter the
    // same original request, selection, runtime lock and capture checks.
    if(!this.active.has(id)){const work=this.executeFrozen(f).finally(()=>this.active.delete(id));this.active.set(id,work);}
    return {accepted:true,action:id,state:await this.state(id),registrationIsNotDelivery:true};
  }
  private async executeFrozen(f:Frozen){try{const p=await prepareTaskOwner(f.source.store,f.source.item,f.request.id);const result=await runMessages(f.source.store,p.plan,false,p.run);return {action:f.entry.id,run:p.run,completed:result.completed,resourcesSettled:result.resourcesSettled,newModelRequests:result.newModelRequests};}catch(e){return {action:f.entry.id,completed:false,reason:errorCode(e),automaticResend:false};}}
  async execute(id:string,beforeRegistration?:()=>void){const registration=await this.begin(id,beforeRegistration),running=this.active.get(id),execution=running?await running:null;return {registration,execution,state:await this.state(id)};}
  async report(id:string){const f=this.selected(id),state=await this.stateOf(f);if(!state.run)throw new Error('task_control_report_not_returned');return QueueStore.observeMessageReport(f.source.store,f.source.item,state.run,f.request.id);}
  async cancel(id:string){const f=this.selected(id),q=await QueueStore.open(f.source.store);try{const result=q.taskInbox().cancelUnsent(f.source.item,f.request.id,'fixed-task-control:'+this.catalogSha256+':'+id,f.requestSha256);return {action:id,result,state:await this.state(id),cancelIsNotProcessTermination:true};}finally{q.close();}}
  async drain(){this.accepting=false;while(this.preparing.size||this.active.size)await Promise.allSettled([...this.preparing,...this.active.values()]);}
}
