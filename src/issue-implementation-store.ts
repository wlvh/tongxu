import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import type {AuthorityRecords} from './authority-store.js';
import type {OwnerObservation} from './authority-source.js';
import type {TaskRecords} from './task-store.js';
import type {ResourceRecords,ResourceOutcome} from './resource-store.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';
import type {ImplementationRequest} from './issue-implementation.js';
type Row=Record<string,any>;

// Older shadow evaluators must not finish an active implementation or release
// its claim. Completion is admitted only by this consumer's exact terminal
// record, in the same transaction as the operation update.
export const implementationOperationGuard=`CREATE TRIGGER issue_implementation_operation_guard BEFORE UPDATE ON operations
WHEN json_type(OLD.result,'$.implementation')='object' AND (NEW.status!='running' OR NEW.result!=OLD.result)
AND NOT EXISTS(SELECT 1 FROM events WHERE kind='issue_implementation_operation_admitted' AND object=OLD.id AND json_extract(data,'$.value.resultSha256') IS NOT NULL AND json_extract(data,'$.value.resultSha256')=json_extract(NEW.result,'$.implementation.recordSha256') AND json_extract(data,'$.value.status')=NEW.status)
BEGIN SELECT RAISE(ABORT,'original_issue_implementation_consumer_required'); END`;

/** Bind initial implementation to the existing task, operation, authority,
 * resources and blobs. This is not another queue or permission source. */
export class IssueImplementations {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private tasks:TaskRecords,private authority:AuthorityRecords,private resources:()=>ResourceRecords,private begin:(task:string,run:string)=>Row){}
  private mode(){
    const old=this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='issue_implementation_operation_guard'").get() as Row|undefined;
    if(!old){if(this.db.prepare("SELECT 1 FROM events WHERE kind='issue_implementation_registered'").get())throw new Error('implementation_consumer_guard_missing');this.db.exec(implementationOperationGuard);}
    else if(old.sql!==implementationOperationGuard)throw new Error('implementation_consumer_guard_changed');
  }
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('implementation_original_changed');return b;}
  private blob(value:unknown){const b=Buffer.from(canonical(value)),sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(kind:string,object:string,value:Row){const sha256=this.blob(value);this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('issue_implementation_'+kind,object,canonical({value,sha256}),now());}
  private events(object:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'issue_implementation_%' ORDER BY id").all(object) as Row[]).map(row=>{const e=JSON.parse(row.data);if(canonical(e.value)!==this.bytes(e.sha256).toString())throw new Error('implementation_history_changed');return {...row,data:e.value};});}
  private key(source:string,id:string){return 'issue-implementation:'+hash(canonical([source,id]));}
  private fixed(source:string,id:string){
    const events=this.events(this.key(source,id)),registered=events.find(e=>e.kind==='issue_implementation_registered')?.data;
    if(!registered)throw new Error('implementation_request_not_registered');
    const request=JSON.parse(this.bytes(registered.requestSha256).toString()) as ImplementationRequest;
    if(request.id!==id||request.task!==registered.task)throw new Error('implementation_request_identity_changed');
    const selected=events.find(e=>e.kind==='issue_implementation_prepared')?.data,terminal=events.find(e=>e.kind==='issue_implementation_terminal')?.data;
    return {events,registered,request,selected,terminal,dispatched:events.some(e=>e.kind==='issue_implementation_dispatched')};
  }
  register(source:string,request:ImplementationRequest){return this.transaction(()=>{
    this.mode();const key=this.key(source,request.id),old=this.events(key).find(e=>e.kind==='issue_implementation_registered')?.data;
    if(old){if(old.requestSha256!==hash(canonical(request)))throw new Error('implementation_request_id_is_fixed');return this.state(source,request.id);}
    const pending=(this.db.prepare("SELECT object,data FROM events WHERE kind='issue_implementation_registered'").all() as Row[]).filter(e=>JSON.parse(e.data).value.source===source);
    if(pending.length>=32)throw new Error('implementation_request_bound');
    for(const entry of pending){const record=JSON.parse(entry.data).value,prior=this.fixed(source,record.id);if(!prior.terminal)throw new Error('implementation_original_responsibility_pending');for(const resource of prior.selected?.resourceRequests??[]){const state=this.terminalResource(source,record.id,resource);if(state&&!['prepared_not_sent','refused'].includes(state.state)&&!this.resources().settledOutcome(resource))throw new Error('implementation_original_resources_unresolved');}}
    const current=this.tasks.current(request.task);
    if(current.manifest.candidate.H!==request.workspaceRequest.candidate.H)throw new Error('implementation_fixed_commit_required');
    this.event('registered',key,{source,id:request.id,task:request.task,packet:current.packet,fingerprint:current.fingerprint,requestSha256:this.blob(request)});
    return this.state(source,request.id);
  });}
  bind(source:string,id:string,plan:Row){return this.transaction(()=>{
    this.mode();const f=this.fixed(source,id);if(f.selected){if(f.selected.inputPlanSha256!==hash(canonical(plan)))throw new Error('implementation_prepared_plan_is_fixed');return this.state(source,id);}
    if(f.terminal)throw new Error('implementation_request_ended');
    if(f.events.some(e=>e.kind==='issue_implementation_stopped'))throw new Error('implementation_stopped');
    const op=this.begin(f.request.task,'issue-implementation:'+id);
    if(!op.operation||op.status!=='running'||op.duplicate)throw new Error(op.blocked?.[0]??'implementation_original_operation_unavailable');
    const resourceRequestDefinitions=(plan.budgets??[]).map((budget:Row)=>({schemaVersion:1,ledgerId:budget.ledgerId,repository:plan.actions[budget.action].repository,operation:op.operation,authorityIntent:budget.action==='test'?plan.testIntent:plan.implementIntent,resourceRef:budget.resourceRef,unit:budget.unit,quantity:budget.quantity,role:'implementer',actionSha256:hash(canonical(plan.actions[budget.action]))}));
    const resourceRequests=resourceRequestDefinitions.map((request:ResourceRequest)=>resourceRequestHash(request)),compiled={...plan,resourceRequests,resourceRequestDefinitions};
    this.event('prepared',this.key(source,id),{operation:op.operation,inputPlanSha256:hash(canonical(plan)),plan:compiled,implementIntent:plan.implementIntent,testIntent:plan.testIntent,resourceRequests});
    this.updateOperation(op.operation,{source,id,phase:'resources_pending',requestSha256:f.registered.requestSha256,implementIntent:plan.implementIntent,testIntent:plan.testIntent,resourceRequests,controllerReturned:false});
    return this.state(source,id);
  });}
  private updateOperation(operation:string,value:Row,terminal=false){
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row,result=JSON.parse(op.result??'{}')??{},record=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='recordSha256')),recordSha256=this.blob(record),implementation={...record,recordSha256};
    this.event('operation_admitted',operation,{resultSha256:recordSha256,status:terminal?'complete':'running'});
    this.db.prepare('UPDATE operations SET status=?,result=?,finished_at=? WHERE id=?').run(terminal?'complete':'running',canonical({...result,implementation}),terminal?now():null,operation);
    if(terminal)this.db.prepare('DELETE FROM claims WHERE operation=? AND generation=?').run(operation,op.generation);
  }
  check(source:string,id:string,observations:OwnerObservation[],effect?:()=>void){return this.transaction(()=>this.checkValue(source,id,observations,effect));}
  original(source:string,id:string){return this.fixed(source,id).request;}
  unsent(source:string,id:string,observations:OwnerObservation[]){return this.transaction(()=>{
    if(this.fixed(source,id).dispatched)throw new Error('implementation_sent_or_unknown_never_resend');
    return this.checkValue(source,id,observations);
  });}
  private checkValue(source:string,id:string,observations:OwnerObservation[],effect?:()=>void){
    this.mode();
    const f=this.fixed(source,id),s=f.selected;
    if(!s||f.terminal)throw new Error('implementation_request_not_active');
    if(f.events.some(e=>e.kind==='issue_implementation_stopped'))throw new Error('implementation_stopped');
    const current=this.tasks.current(f.request.task),op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(s.operation) as Row,claim=this.db.prepare('SELECT * FROM claims WHERE operation=?').get(s.operation) as Row;
    if(!op||op.status!=='running'||!claim||claim.generation!==op.generation||current.packet!==f.registered.packet||current.fingerprint!==f.registered.fingerprint)throw new Error('implementation_original_binding_changed');
    if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind IN ('implementation','investment') AND stopped=1").get(current.context.scope.id))throw new Error('implementation_stopped');
    for(const [kind,intent] of [['implement',s.implementIntent],['test',s.testIntent]]){
      const action=this.authority.refreshReservedAction(intent,observations),expected=s.plan.actions[kind];
      if(action.adoption!==f.request.adoptedScope.adoption||action.request.scopeBodySha256!==f.request.adoptedScope.bodySha256||action.role!=='implementer'||canonical(action.request)!==canonical(expected)||(action.executionKind==='fixture')!==(s.plan.executionKind==='fixture'))throw new Error('implementation_exact_authority_required');
    }
    for(const request of s.resourceRequests as string[]){const r=this.resources().status(request);this.resources().requireHeldForExecution(request,s.operation,r.request.authorityIntent);}
    if(this.db.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get()&&!s.resourceRequests.length)throw new Error('implementation_resource_binding_required');
    effect?.();return {operation:s.operation};
  }
  dispatch(source:string,id:string,observations:OwnerObservation[]){return this.transaction(()=>{
    const f=this.fixed(source,id);if(f.dispatched)throw new Error('implementation_sent_or_unknown_never_resend');
    this.checkValue(source,id,observations);this.event('dispatched',this.key(source,id),{operation:f.selected!.operation,newNativeContext:true,nativeSessionResumed:false});
    this.updateOperation(f.selected!.operation,{...this.operation(f.selected!.operation),phase:'active_or_unknown'});
  });}
  complete(source:string,id:string,result:Row){return this.transaction(()=>{
    const f=this.fixed(source,id);if(f.terminal){if(f.terminal.resultSha256!==hash(canonical(result)))throw new Error('implementation_terminal_is_fixed');return this.state(source,id);}
    if(!f.dispatched||!result.completeCapture||result.task!==f.request.task||result.requestId!==id||!['completed','no_change','owner_decision_required'].includes(result.status))throw new Error('implementation_complete_capture_required');
    if(result.H0!==f.request.workspaceRequest.candidate.H||result.status==='completed'&&(!/^[a-f0-9]{40}$/.test(result.H1)||result.H1===result.H0||result.testCandidateBinding?.candidate?.H!==result.H1))throw new Error('implementation_success_commit_required');
    const resultSha256=this.blob(result);this.event('terminal',this.key(source,id),{operation:f.selected!.operation,resultSha256});
    this.updateOperation(f.selected!.operation,{...this.operation(f.selected!.operation),phase:'returned',resultSha256,controllerReturned:true},true);return this.state(source,id);
  });}
  cancel(source:string,id:string){return this.transaction(()=>{
    const f=this.fixed(source,id);if(f.dispatched)throw new Error('implementation_sent_or_unknown_cannot_cancel');if(f.terminal)return this.state(source,id);
    const result={status:'cancelled_unstarted',requestId:id,task:f.request.task,H0:f.request.workspaceRequest.candidate.H,H1:null,newModelRequests:0,modelExecutionStarted:false,originalsRetained:true},resultSha256=this.blob(result);
    this.event('terminal',this.key(source,id),{operation:f.selected?.operation??null,resultSha256});
    if(f.selected)this.updateOperation(f.selected.operation,{...this.operation(f.selected.operation),phase:'returned',resultSha256,controllerReturned:true},true);return this.state(source,id);
  });}
  terminalResource(source:string,id:string,resource:string){return this.transaction(()=>{
    const f=this.fixed(source,id);
    if(!f.terminal||!f.selected?.resourceRequests.includes(resource))throw new Error('implementation_terminal_resource_binding_required');
    try{return this.resources().status(resource);}catch(error){
      // bind records future definitions; only start registers resource requests.
      // An unstarted cancellation may therefore have no original to settle.
      if(error instanceof Error&&error.message==='original_resource_request_required'&&!f.dispatched&&JSON.parse(this.bytes(f.terminal.resultSha256).toString()).status==='cancelled_unstarted')return null;
      throw error;
    }
  });}
  stop(source:string,id:string){return this.transaction(()=>{const f=this.fixed(source,id);if(!f.terminal&&!f.events.some(e=>e.kind==='issue_implementation_stopped'))this.event('stopped',this.key(source,id),{operation:f.selected?.operation??null,existingFilesRetained:true,newModelRequests:0});return this.state(source,id);});}
  problem(source:string,id:string,reason:string){return this.transaction(()=>{this.fixed(source,id);this.event('problem',this.key(source,id),{reason:reason.slice(0,256)});return this.state(source,id);});}
  private operation(id:string){const row=this.db.prepare('SELECT result FROM operations WHERE id=?').get(id) as Row|undefined,value=row&&JSON.parse(row.result??'null')?.implementation;if(!value||this.bytes(value.recordSha256).toString()!==canonical(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='recordSha256'))))throw new Error('implementation_operation_changed');return value;}
  resourceGate(action:Row,request:ResourceRequest){
    const value=this.operation(request.operation);
    if(value.phase!=='resources_pending'||!value.resourceRequests.includes(resourceRequestHash(request))||![value.implementIntent,value.testIntent].includes(action.requestId))throw new Error('implementation_resource_action_mismatch');return value;
  }
  outcome(operation:string,action:Row):ResourceOutcome{
    const value=this.operation(operation);if(!value.controllerReturned||value.phase!=='returned'||![value.implementIntent,value.testIntent].includes(action.requestId))throw new Error('implementation_original_outcome_unknown');
    const result=JSON.parse(this.bytes(value.resultSha256).toString()),state=result.status==='completed'?'completed':['no_change','cancelled_unstarted'].includes(result.status)?'cancelled':'failed';
    return {state,executionKind:action.executionKind==='fixture'?'fixture':'external',source:'verified_issue_implementation_capture',proof:Buffer.from(canonical({operation,resultSha256:value.resultSha256,state,completeCapture:result.completeCapture,H1:result.H1}))};
  }
  state(source:string,id:string){const f=this.fixed(source,id);return {source,id,task:f.request.task,issue:f.request.issue.number,H0:f.request.workspaceRequest.candidate.H,phase:f.terminal?'returned':f.dispatched?'active_or_unknown':f.selected?'prepared':'registered',stopped:f.events.some(e=>e.kind==='issue_implementation_stopped'),reason:f.events.filter(e=>e.kind==='issue_implementation_problem').at(-1)?.data.reason??null,operation:f.selected?.operation??null,requestSha256:f.registered.requestSha256,plan:f.selected?.plan??null,result:f.terminal?JSON.parse(this.bytes(f.terminal.resultSha256).toString()):null};}
  requests(source:string){return (this.db.prepare("SELECT data FROM events WHERE kind='issue_implementation_registered' ORDER BY id").all() as Row[]).map(e=>JSON.parse(e.data).value).filter(e=>e.source===source).map(e=>this.state(source,e.id));}
}
