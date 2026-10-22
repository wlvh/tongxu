import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {parseResourceRequest,resourceRequestHash} from './resource-contract.js';
import type {ResourceRecords,ResourceOutcome} from './resource-store.js';
import type {OwnerObservation} from './authority-source.js';
type Row=Record<string,any>;

/** Consumer bindings in the original operations/events/blobs. The provider
 * remains the only owner of quantity, competition and accounting. */
export class MessageResourceRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private message:(run:string)=>Row,private authority:(intent:string,observations:OwnerObservation[])=>Row,private resources:()=>ResourceRecords,private continuation:(run:string)=>Row|null,private continuationSource:(run:string)=>Row,private prefixProof:(run:string)=>Row,private admission?:(run:string,observations:OwnerObservation[])=>void){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('message_resource_original_changed');return b;}
  private blob(bytes:Buffer){const sha=hash(bytes);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,bytes);this.bytes(sha);return sha;}
  private event(kind:string,run:string,value:Row){const sha256=this.blob(Buffer.from(canonical(value)));this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('message_resource_'+kind,'message-resource:'+run,JSON.stringify({value,sha256}),now());}
  private binding(run:string){const row=this.db.prepare("SELECT data FROM events WHERE object=? AND kind='message_resource_bound'").get('message-resource:'+run) as Row;if(!row)throw new Error('message_resource_binding_required');const x=JSON.parse(row.data);if(canonical(JSON.parse(this.bytes(x.sha256).toString()))!==canonical(x.value))throw new Error('message_resource_binding_changed');return {...x.value,bindingSha256:x.sha256};}
  private operation(id:string){const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row;if(!op)throw new Error('message_resource_operation_required');return {op,result:JSON.parse(op.result)};}
  private stateValue(run:string){const b=this.binding(run),{op,result}=this.operation(b.operation),stage=result.messageResources?.[run];if(!stage||stage.bindingSha256!==b.bindingSha256||stage.authorityIntent!==b.authorityIntent||canonical(stage.resourceRequests)!==canonical(b.resourceRequests))throw new Error('message_resource_operation_changed');return {...b,phase:stage.phase,operationStatus:op.status};}
  state(run:string){return this.transaction(()=>this.stateValue(run));}
  prepare(run:string,operation:string,observations:OwnerObservation[]){return this.transaction(()=>{
    // Binding a resource request is an investment boundary. Serialize this
    // current admission check and its binding with cancellation in one DB
    // transaction; a prior check before begin/evaluate is insufficient.
    this.admission?.(run,observations);
    const m=this.message(run),p=m.plan,first=m.registration.bindings[p.participants[0].id];if(!p.resourceBudget||!p.authorityIntent)throw new Error('message_fixed_resource_budget_required');
    const action=this.authority(p.authorityIntent,observations),r=this.resources(),{op,result}=this.operation(operation);
    if(action.request.action!=='coordinate'||action.request.payloadSha256!==run||action.request.item!==op.item||op.item!==first.item||op.packet!==first.packet||action.binding?.packet!==op.packet||canonical([...action.request.resourceRefs].sort())!==canonical(p.resourceBudget.map((b:Row)=>b.resourceRef).sort()))throw new Error('message_resource_exact_action_required');
    const requests=p.resourceBudget.map((b:Row)=>parseResourceRequest({schemaVersion:1,ledgerId:b.ledgerId,repository:action.request.repository,operation,authorityIntent:p.authorityIntent,resourceRef:b.resourceRef,unit:b.unit,quantity:b.quantity,role:action.role,actionSha256:action.requestSha256},r.configuration(b.ledgerId))),resourceRequests=requests.map(resourceRequestHash);
    let old:Row|null=null;try{old=this.binding(run);}catch(e){if(!(e instanceof Error)||e.message!=='message_resource_binding_required')throw e;}
    if(old){if(old.operation!==operation||old.authorityIntent!==p.authorityIntent||canonical(old.resourceRequests)!==canonical(resourceRequests))throw new Error('message_original_resource_binding_fixed');return {...this.stateValue(run),requests,duplicate:true};}
    if(op.status!=='complete'||Object.values(result.messageResources??{}).some((x:any)=>x.phase!=='returned'&&!(['partial_returned','interrupted_returned','cancelled_unstarted'].includes(x.phase)&&x.resourceRequests.every((id:string)=>r.settledOutcome(id)))))throw new Error('message_resource_operation_active_or_unknown');
    const value={run,operation,item:op.item,packet:op.packet,authorityIntent:p.authorityIntent,role:action.role,resourceRequests,planSha256:run,registeredAt:now()},bindingSha256=hash(canonical(value));this.event('bound',run,value);
    result.messageResources={...(result.messageResources??{}),[run]:{bindingSha256,phase:'resources_pending',authorityIntent:p.authorityIntent,resourceRequests}};this.db.prepare("UPDATE operations SET status='messaging',result=? WHERE id=?").run(JSON.stringify(result),operation);
    for(const request of requests)r.prepare(request,observations,action.role);
    return {...this.stateValue(run),requests,duplicate:false};
  });}
  requireHeld(run:string,action:Row){return this.transaction(()=>{
    const b=this.stateValue(run),{op,result}=this.operation(b.operation),stage=result.messageResources?.[run];
    if(op.status!=='messaging'||stage?.bindingSha256!==b.bindingSha256||stage.phase!=='resources_pending'||action.requestId!==b.authorityIntent||action.request.payloadSha256!==run||action.role!==b.role)throw new Error('message_resource_operation_mismatch');
    for(const id of b.resourceRequests)this.resources().requireHeldForExecution(id,b.operation,b.authorityIntent);
    return b;
  });}
  private completedProof(run:string){
    const m=this.message(run);if(!m.messages.length||m.messages.some((x:Row)=>x.state!=='Reply'||!x.reply?.reportedConsumption)||m.runtimes.filter((x:Row)=>x.started).some((x:Row)=>x.captureVerification?.proof.successfulCapture!==true))throw new Error('message_resource_execution_still_unknown');
    return {run,executionKind:m.plan.executionKind,messages:m.messages.map((x:Row)=>({id:x.id,sessionId:x.reply.sessionId,turnId:x.reply.turnId,inputSha256:x.sent.inputSha256,sentAt:x.sent.registeredAt,finalSha256:x.reply.finalSha256,reportedConsumption:x.reply.reportedConsumption})),captures:m.runtimes.filter((x:Row)=>x.started).map((x:Row)=>({participant:x.participant,originals:x.ended.originals,proof:x.captureVerification.proof}))};
  }
  complete(run:string){return this.transaction(()=>{
    const b=this.binding(run),{op,result}=this.operation(b.operation),stage=result.messageResources?.[run],proof=this.completedProof(run);
    if(stage?.bindingSha256!==b.bindingSha256)throw new Error('message_resource_operation_changed');
    const proofSha256=this.blob(Buffer.from(canonical(proof)));if(stage.phase==='returned'){if(stage.proofSha256!==proofSha256)throw new Error('message_resource_result_changed');return {...this.stateValue(run),duplicate:true};}
    if(op.status!=='messaging')throw new Error('message_resource_operation_mismatch');Object.assign(stage,{phase:'returned',proofSha256,finishedAt:now()});this.db.prepare("UPDATE operations SET status='complete',result=? WHERE id=?").run(JSON.stringify(result),op.id);this.event('completed',run,{operation:op.id,proofSha256});return {...this.stateValue(run),duplicate:false};
  });}
  closePartialForContinuation(run:string,nextRun:string){return this.transaction(()=>{
    const b=this.stateValue(run),{op,result}=this.operation(b.operation),stage=result.messageResources[run],selection=this.continuation(run);if(selection?.nextRun!==nextRun)throw new Error('message_resource_exact_continuation_required');
    const proof={...this.prefixProof(run),nextRun:stage.phase==='partial_returned'?stage.nextRun:nextRun},proofSha256=hash(canonical(proof));
    if(stage.phase==='partial_returned'){if(stage.proofSha256!==proofSha256)throw new Error('message_partial_resource_result_changed');this.bytes(proofSha256);return {...this.stateValue(run),currentSelectedNextRun:nextRun,duplicate:true};}
    this.continuationSource(run);if(op.status!=='messaging'||stage.phase!=='resources_pending')throw new Error('message_resource_original_partial_operation_required');
    Object.assign(stage,{phase:'partial_returned',nextRun,proofSha256:this.blob(Buffer.from(canonical(proof))),finishedAt:now(),originalRunCompleted:false});this.db.prepare("UPDATE operations SET status='complete',result=? WHERE id=?").run(JSON.stringify(result),op.id);this.event('partial_returned',run,{operation:op.id,nextRun,proofSha256,originalRunCompleted:false});return {...this.stateValue(run),duplicate:false};
  });}
  private interruptedProof(run:string){
    const m=this.message(run);if(!m.plan.nativeControls||m.messages.length!==1||m.messages[0].state!=='Interrupted'||m.runtimes.filter((r:Row)=>r.started).length!==1||m.runtimes.some((r:Row)=>r.started&&r.captureVerification?.proof.successfulCapture!==true))throw new Error('message_original_interruption_not_proven');
    return {run,executionKind:m.plan.executionKind,originalRunCompleted:false,messages:m.messages.map((x:Row)=>({id:x.id,sentAt:x.sent.registeredAt,inputSha256:x.sent.inputSha256,interruption:x.interruption})),captures:m.runtimes.filter((r:Row)=>r.started).map((r:Row)=>({participant:r.participant,originals:r.ended.originals,proof:r.captureVerification.proof}))};
  }
  closeInterrupted(run:string){return this.transaction(()=>{
    const b=this.binding(run),{op,result}=this.operation(b.operation),stage=result.messageResources?.[run],proof=this.interruptedProof(run),proofSha256=hash(canonical(proof));
    if(stage?.bindingSha256!==b.bindingSha256)throw new Error('message_resource_operation_changed');
    if(stage.phase==='interrupted_returned'){if(stage.proofSha256!==proofSha256)throw new Error('message_resource_result_changed');return {...this.stateValue(run),duplicate:true};}
    if(op.status!=='messaging'||stage.phase!=='resources_pending')throw new Error('message_resource_original_interruption_required');
    Object.assign(stage,{phase:'interrupted_returned',proofSha256:this.blob(Buffer.from(canonical(proof))),finishedAt:now(),originalRunCompleted:false});this.db.prepare("UPDATE operations SET status='complete',result=? WHERE id=?").run(JSON.stringify(result),op.id);this.event('interrupted_returned',run,{operation:op.id,proofSha256,originalRunCompleted:false});return {...this.stateValue(run),duplicate:false};
  });}
  private unstartedProof(run:string){
    const m=this.message(run);if(!m.plan.nativeControls||m.messages.length!==1||m.messages.some((x:Row)=>x.sent)||m.runtimes.some((r:Row)=>r.started&&r.ended?.proof.knownUnstarted!==true))throw new Error('message_original_zero_input_not_proven');
    return {run,executionKind:m.plan.executionKind,originalRunCompleted:false,modelInputs:0,messages:[],captures:m.runtimes.filter((r:Row)=>r.started).map((r:Row)=>({participant:r.participant,attempt:r.attempt,originals:r.ended.originals,proof:r.ended.proof}))};
  }
  /** Only factual cancellation of a verified, ended zero-input owned run.
   * Provider accounting remains authoritative; this does not refund a claim. */
  cancelUnstarted(run:string){return this.transaction(()=>{
    const b=this.binding(run),{op,result}=this.operation(b.operation),stage=result.messageResources?.[run],proof=this.unstartedProof(run),proofSha256=hash(canonical(proof));
    if(stage?.bindingSha256!==b.bindingSha256)throw new Error('message_resource_operation_changed');
    if(stage.phase==='cancelled_unstarted'){if(stage.proofSha256!==proofSha256)throw new Error('message_resource_result_changed');return {...this.stateValue(run),duplicate:true};}
    if(op.status!=='messaging'||stage.phase!=='resources_pending')throw new Error('message_resource_unstarted_operation_required');
    Object.assign(stage,{phase:'cancelled_unstarted',proofSha256:this.blob(Buffer.from(canonical(proof))),finishedAt:now(),originalRunCompleted:false});this.db.prepare("UPDATE operations SET status='complete',result=? WHERE id=?").run(JSON.stringify(result),op.id);this.event('cancelled_unstarted',run,{operation:op.id,proofSha256,modelInputs:0,resourceRefunded:false});return {...this.stateValue(run),duplicate:false};
  });}
  outcome(operation:string,action:Row,claimedAt:string):ResourceOutcome {
    const run=action.request.payloadSha256,b=this.stateValue(run),{op,result}=this.operation(operation),stage=result.messageResources?.[run],partial=stage?.phase==='partial_returned',interrupted=stage?.phase==='interrupted_returned',unstarted=stage?.phase==='cancelled_unstarted',proof:Row=unstarted?this.unstartedProof(run):partial?{...this.prefixProof(run),nextRun:stage.nextRun}:interrupted?this.interruptedProof(run):this.completedProof(run);
    if(b.operation!==operation||b.authorityIntent!==action.requestId||op.status!=='complete'||!['returned','partial_returned','interrupted_returned','cancelled_unstarted'].includes(stage?.phase)||hash(canonical(proof))!==stage.proofSha256||proof.messages.some((m:Row)=>Date.parse(m.sentAt)<Date.parse(claimedAt)))throw new Error('message_resource_execution_still_unknown');this.bytes(stage.proofSha256);
    return {state:unstarted?'cancelled':partial||interrupted?'failed':'completed',source:unstarted?'verified_unstarted_message':partial?'verified_partial_message_handoff':interrupted?'verified_interrupted_message':'verified_message_captures',executionKind:proof.executionKind==='fixture'?'fixture':'external',proof:Buffer.from(canonical({operation,authorityIntent:action.requestId,bindingSha256:b.bindingSha256,proofSha256:stage.proofSha256,run,...(partial?{nextRun:stage.nextRun,originalRunCompleted:false}:interrupted||unstarted?{originalRunCompleted:false,...(unstarted?{modelInputs:0}:{})}:{})}))};
  }
}
