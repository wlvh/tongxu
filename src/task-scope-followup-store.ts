import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {exactKeys,isAuthorityDigest,type ActionRequest} from './authority-contract.js';
import type {AuthorityRecords} from './authority-store.js';
import type {OwnerObservation} from './authority-source.js';
import {parseDevelopmentTask,developmentTaskId,type DevelopmentTask} from './task-contract.js';
import {requireTaskObservation,type TaskObservation} from './task-source.js';
import type {TaskRecords} from './task-store.js';
import {parseTaskOwnerRequest,type TaskInbox,type TaskOwnerRequest} from './task-inbox.js';

type Row=Record<string,any>;
export type ScopeFollowupRequest={schemaVersion:1;kind:'tongxu-task-scope-followup';task:string;adoption:string;expectedPacket:number;expectedSourceSha256:string;goal:string;acceptance:string[]};
export function parseScopeFollowup(bytes:Buffer):ScopeFollowupRequest{
  if(bytes.length>64*1024)throw new Error('task_scope_followup_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  const text=(x:unknown,max:number)=>typeof x==='string'&&!!x.trim()&&x.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x);
  if(!exactKeys(p,['schemaVersion','kind','task','adoption','expectedPacket','expectedSourceSha256','goal','acceptance'])||p.schemaVersion!==1||p.kind!=='tongxu-task-scope-followup'||![p.task,p.adoption,p.expectedSourceSha256].every(isAuthorityDigest)||!Number.isSafeInteger(p.expectedPacket)||p.expectedPacket<1||!text(p.goal,16000)||!Array.isArray(p.acceptance)||!p.acceptance.length||p.acceptance.length>32||p.acceptance.some((v:unknown)=>!text(v,2048)))throw new Error('task_scope_followup_invalid');return p;
}
/** An explicit subsequent task in the same queue. Old task definitions,
 * packets and results remain immutable. No directory migration or model runs. */
export class TaskScopeFollowups{
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private tasks:TaskRecords,private inbox:TaskInbox,private authority:AuthorityRecords){}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('task_scope_original_changed');return b;}
  private blob(bytes:Buffer){const sha=hash(bytes);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,bytes);this.bytes(sha);return sha;}
  private events():Row[]{return (this.db.prepare("SELECT * FROM events WHERE kind IN ('task_scope_followup_bound','task_scope_followup_prepared') ORDER BY id").all() as Row[]).map(e=>{const p=JSON.parse(e.data);if(canonical(p.value)!==this.bytes(p.sha256).toString())throw new Error('task_scope_history_changed');return {...e,data:p.value};});}
  private event(kind:string,task:string,value:Row){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run(kind,task,canonical({value,sha256:this.blob(Buffer.from(canonical(value)))}),now());}
  private original(p:ScopeFollowupRequest){const old=this.events().find(e=>e.kind==='task_scope_followup_prepared'&&e.data.requestSha256===hash(canonical(p)));return old?.data??null;}
  originalFor(raw:Buffer){return this.transaction(()=>this.original(parseScopeFollowup(raw)));}
  context(task:string){return this.transaction(()=>this.contextValue(task));}
  private contextValue(task:string){const rows=this.events().filter(e=>e.kind==='task_scope_followup_bound'&&e.object===task);if(!rows.length)return null;if(rows.length!==1)throw new Error('task_scope_context_ambiguous');return JSON.parse(this.bytes(rows[0]!.data.contextSha256).toString());}
  private family(task:string){const bound=this.events().filter(e=>e.kind==='task_scope_followup_bound'),root=bound.find(e=>e.object===task)?.data.rootTask??task;return {root,items:[root,...bound.filter(e=>e.data.rootTask===root).map(e=>e.object)]};}
  preview(raw:Buffer){return this.transaction(()=>this.previewValue(raw));}
  private previewValue(raw:Buffer){
    const p=parseScopeFollowup(raw),current=this.tasks.current(p.task);
    if(current.packet!==p.expectedPacket||current.fingerprint!==p.expectedSourceSha256)throw new Error('task_scope_original_source_changed');
    const state=this.authority.forScope(current.context.scope.id,{item:p.task,target:current.definition.target}),decision=this.authority.inspectRecordedDecision(p.adoption),scope=decision.proposal;
    if(scope.kind!=='adopt_scope'||state.currentAdoption!==p.adoption||scope.scopeId!==current.context.scope.id||scope.scopeVersion===current.context.scope.version)throw new Error('task_scope_new_adopted_scope_required');
    const family=this.family(p.task);if(family.items.length>=32)throw new Error('task_scope_family_limit');
    for(const task of family.items){
      this.inbox.scopeContinuationSource(task);
      if(this.db.prepare("SELECT 1 FROM operations WHERE item=? AND status!='complete'").get(task))throw new Error('task_scope_original_operation_not_ended');
    }
    const source=this.inbox.scopeContinuationSource(p.task),id='scope-'+hash(canonical(p)).slice(0,48),definition:DevelopmentTask=parseDevelopmentTask(Buffer.from(canonical({...current.definition,id,goal:p.goal,acceptance:p.acceptance,source:'Explicit subsequent work of '+p.task+' under adopted scope '+p.adoption,context:{...current.context,scope:{id:scope.scopeId,version:scope.scopeVersion,source:decision.source.sourceUrl},arrangement:{...current.context.arrangement,source:'Retained prior arrangement reference; applicability to the new scope is not established. '+current.context.arrangement.source},decisionKind:'owner_adoption_report'}})));
    return {request:p,requestSha256:hash(canonical(p)),current,definition,nextTask:developmentTaskId(definition),rootTask:family.root,source,adoption:decision};
  }
  prepare(raw:Buffer,original:TaskObservation,next:TaskObservation,observations:OwnerObservation[],checkSources:()=>void){return this.transaction(()=>{
    const p=parseScopeFollowup(raw),prior=this.original(p);if(prior)return {...prior,duplicate:true,newModelRequests:0};
    const prepared=this.previewValue(raw),baseline=this.authority.adoptionBaseline(p.adoption,observations);
    requireTaskObservation(original,prepared.current.definition);requireTaskObservation(next,prepared.definition);
    if(original.materialSha256!==p.expectedSourceSha256)throw new Error('task_scope_original_source_changed');checkSources();
    const added=this.tasks.observe(prepared.definition,next),scopeContext={kind:'tongxu-task-scope-followup-context',predecessor:p.task,rootTask:prepared.rootTask,oldScope:prepared.current.context.scope,newScope:baseline,originalDefinition:prepared.current.definition,originalRequests:prepared.source.originalRequests,latestOriginal:prepared.source.latest??this.contextValue(p.task)?.latestOriginal??null,otherOriginalsRetained:true,originalOwnerAssignmentRetained:true,newNativeContext:true,nativeSessionResumed:false,workspaceControlGranted:false,permissionGranted:false};
    const contextSha256=this.blob(Buffer.from(canonical(scopeContext))),bound={rootTask:prepared.rootTask,predecessor:p.task,predecessorPacket:p.expectedPacket,predecessorSourceSha256:p.expectedSourceSha256,task:added.item,adoption:p.adoption,requestSha256:this.blob(Buffer.from(canonical(p))),contextSha256};
    this.event('task_scope_followup_bound',added.item,bound);
    const template=prepared.source.template,requestId='scope-'+prepared.requestSha256.slice(0,48),authorityIntent=requestId;
    const interrupts=template.nativeControls?.filter(c=>c.action==='interrupt').map(c=>({...c,messageId:requestId,title:'中断这次受管后续核查'}));
    const request:TaskOwnerRequest=parseTaskOwnerRequest(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-task-owner-request',id:requestId,task:added.item,source:'Explicit original-owner followup under adopted scope '+p.adoption,question:p.goal,from:null,participant:{...template.participant,item:added.item},executionKind:template.executionKind,authorityIntent,...(template.resourceBudget?{resourceBudget:template.resourceBudget}:{}),...(interrupts?.length?{nativeControls:interrupts}:{}),billing:template.billing,timeoutMs:template.timeoutMs})));
    this.inbox.enqueue(Buffer.from(canonical(request)),{packet:added.packet,sourceSha256:added.sourceSha256});const selected=this.inbox.prepare(added.item,requestId),current=this.tasks.current(added.item),candidate=current.manifest.candidate;
    const action:ActionRequest={schemaVersion:1,scopeId:baseline.scopeId,scopeVersion:baseline.scopeVersion,scopeBodySha256:baseline.scopeBodySha256,repository:prepared.definition.repository,target:prepared.definition.target,action:'coordinate',item:added.item,candidate:{H:candidate.H,B:candidate.B,subjectSha256:null},paths:[],resourceRefs:(request.resourceBudget??[]).map(r=>r.resourceRef),payloadSha256:selected.run};
    const profile=this.authority.configuration().profile,proposal=this.authority.prepare(requestId,Buffer.from(canonical({kind:'confirm_action',adoption:p.adoption,performerRole:'coordinator',request:action,expiresAt:new Date(Date.now()+Math.min(profile.maxGrantDurationMs,3600000)).toISOString()})));
    const result={...bound,packet:added.packet,sourceSha256:added.sourceSha256,ownerRequestSha256:this.blob(Buffer.from(canonical(request))),ownerRequest:requestId,run:selected.run,authorityIntent,proposalSha256:proposal.proposalSha256,workspacePreserved:true,originalOwnerAssignmentRetained:true,newNativeContext:true,permissionGranted:false};this.event('task_scope_followup_prepared',added.item,result);return {...result,duplicate:false,newModelRequests:0};
  });}
  private descendants(task:string){const rows=this.events().filter(e=>e.kind==='task_scope_followup_prepared'),known=new Set([task]);for(let i=0;i<32;i++){const old=known.size;for(const e of rows)if(known.has(e.data.predecessor))known.add(e.object);if(known.size===old)return rows.filter(e=>e.object!==task&&known.has(e.object));}throw new Error('task_scope_family_limit');}
  contains(parent:string,task:string){return this.transaction(()=>{this.tasks.current(parent);return parent===task||this.descendants(parent).some(e=>e.object===task);});}
  view(task:string){return this.transaction(()=>this.viewValue(task));}
  private viewValue(task:string){const c=this.tasks.current(task);return {task,packet:c.packet,sourceSha256:c.fingerprint,title:c.definition.title,goal:c.definition.goal,acceptance:c.definition.acceptance,scope:c.context.scope,candidateH:c.manifest.candidate.H,sourceObservedAt:c.report.observedAt};}
  status(task:string){return this.transaction(()=>{this.tasks.current(task);return this.descendants(task).map(e=>({...e.data,recordedAt:e.observed_at,inbox:this.inbox.status(e.object),currentTask:this.tasks.status(e.object),view:this.viewValue(e.object)}));});}
  request(task:string){return this.transaction(()=>{const found=this.events().find(e=>e.kind==='task_scope_followup_prepared'&&e.object===task);if(!found)throw new Error('task_scope_followup_not_prepared');return {prepared:found.data,input:this.bytes(found.data.requestSha256),bytes:this.bytes(found.data.ownerRequestSha256)};});}
}
