import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import { parseMergeBinding, mergeBindingHash, inspectMergeResponse, type ManagedMergeBinding } from './merge-contract.js';
import { parseMergeProfile, mergeCommand, mergeWire, requireMergeObservation, type MergeProfile, type MergeObservation } from './merge-provider.js';
import { requireMergePreflight, type MergePreflight, type MergeReadRecord } from './merge-preflight.js';
import { requireMergeReadback, type MergeReadback } from './merge-readback.js';
import { requireMergeControllerProof, type MergeControllerProof, type MergeDispatchReference } from './merge-recovery.js';
import { resourceRequestHash, type ResourceRequest } from './resource-contract.js';
import type { OwnerObservation } from './authority-source.js';
import type { ResourceRecords } from './resource-store.js';
import { requireActualMergeValidation, type ActualMergeValidation } from './merge-validation.js';

type Row=Record<string,any>;
const profileKey='managed_merge_profile';
const claimGuard=`CREATE TRIGGER managed_merge_claim_guard BEFORE DELETE ON claims WHEN EXISTS(SELECT 1 FROM operations WHERE id=OLD.operation AND status='merging') BEGIN SELECT RAISE(ABORT,'managed_merge_original_unresolved'); END`;
const recordGuard=`CREATE TRIGGER managed_merge_record_guard BEFORE UPDATE ON operations WHEN OLD.status='merging' AND (json_extract(NEW.result,'$.merge.bindingHash') IS NOT json_extract(OLD.result,'$.merge.bindingHash') OR json_extract(NEW.result,'$.merge.planSha256') IS NOT json_extract(OLD.result,'$.merge.planSha256') OR NEW.status!='merging' AND (NEW.status!='complete' OR COALESCE(json_extract(NEW.result,'$.merge.phase'),'') NOT IN ('refused','cancelled_before_send','exact_merge_result_verified','actual_merge_result_verified','merged_wrong_target'))) BEGIN SELECT RAISE(ABORT,'managed_merge_original_unresolved'); END`;

/** Later phase of the original reception operation. There is no second queue,
 * target lock service, balance, or implicit retry of a sent merge. */
export class MergeRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,
    private authority:(id:string,observations:OwnerObservation[]|null)=>Row,
    private source:(operation:string,current:boolean)=>Row,
    private resources:()=>ResourceRecords){}
  private event(kind:string,id:string,data:unknown){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('managed_merge_'+kind,'merge:'+id,JSON.stringify(data),now());}
  private blob(b:Buffer){const h=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(h,b);this.bytes(h);return h;}
  private bytes(h:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(h) as Row;const b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==h)throw new Error('managed_merge_original_missing_or_changed');return b;}
  /** Capture bytes are stored once. Never canonicalize Buffer itself: that
   * turns every byte into a JSON property and can multiply a valid page by
   * an order of magnitude. The index retains exact provenance and blob refs. */
  private capturedRecords(records:MergeReadRecord[]){return records.map(({command,observation:o})=>({command,observation:{profileSha256:o.profileSha256,inputSha256:o.inputSha256,directory:o.directory,capturedAt:o.capturedAt,rawSha256:this.blob(o.raw),rawBytes:o.raw.length}}));}
  private preflightEvidence(value:MergePreflight){return {profileSha256:value.profileSha256,bindingSha256:value.bindingSha256,records:this.capturedRecords(value.records),result:value.result,checkedAt:value.checkedAt};}
  private readbackEvidence(value:MergeReadback){return {profileSha256:value.profileSha256,bindingSha256:value.bindingSha256,records:this.capturedRecords(value.records),result:value.result,checkedAt:value.checkedAt};}
  private originalCapture(record:Row){
    const o=record.observation;
    if(o.rawSha256){const raw=this.bytes(o.rawSha256);if(raw.length!==o.rawBytes)throw new Error('managed_merge_capture_length_changed');return {raw,sha256:o.rawSha256};}
    // Read-only compatibility with the initial 073fae0 index. Its expanded
    // representation is never rewritten over the historical evidence. Every
    // reconstructed byte must equal a separately saved original provider blob.
    const entries=o.raw&&typeof o.raw==='object'&&!Array.isArray(o.raw)?Object.entries(o.raw):[];
    if(!entries.length||entries.length>4*1024*1024)throw new Error('legacy_merge_capture_index_invalid');
    const raw=Buffer.alloc(entries.length);
    for(const [key,value] of entries){if(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=entries.length||!Number.isInteger(value)||(value as number)<0||(value as number)>255)throw new Error('legacy_merge_capture_index_invalid');raw[Number(key)]=value as number;}
    const sha256=hash(raw);if(!this.bytes(sha256).equals(raw)||canonical(JSON.parse(raw.toString()))!==canonical(o.reply))throw new Error('legacy_merge_original_capture_changed');return {raw,sha256};
  }
  private mode(){if(![14,15].includes((this.db.prepare('PRAGMA user_version').get() as Row).user_version)||![["managed_merge_claim_guard",claimGuard],["managed_merge_record_guard",recordGuard]].every(([name,sql])=>(this.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name!) as Row)?.sql===sql))throw new Error('managed_merge_not_enabled');}
  private profile():MergeProfile{this.mode();const ref=(this.db.prepare('SELECT value FROM meta WHERE key=?').get(profileKey) as Row)?.value;if(!ref)throw new Error('managed_publisher_not_configured');return parseMergeProfile(this.bytes(ref));}
  configure(raw:Buffer){return this.transaction(()=>{
    const p=parseMergeProfile(raw),ref=hash(canonical(p)),old=this.db.prepare('SELECT value FROM meta WHERE key=?').get(profileKey) as Row;
    if(old){this.mode();if(old.value!==ref)throw new Error('managed_publisher_profile_is_fixed');return {duplicate:true,profileSha256:ref,credentialVerified:false};}
    if(![13,15].includes((this.db.prepare('PRAGMA user_version').get() as Row).user_version))throw new Error('original_authority_and_resources_required');
    const authorityRef=(this.db.prepare("SELECT value FROM meta WHERE key='owner_authority_profile'").get() as Row)?.value,owner=authorityRef&&JSON.parse(this.bytes(authorityRef).toString());
    if(!owner||owner.repository.toLowerCase()!==p.repository.toLowerCase()||(owner.executionKind==='fixture')!==(p.executionKind==='fixture')||[owner.ownerId,owner.executorId].includes(p.actorId))throw new Error('separate_managed_publisher_identity_required');
    if((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n||(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n)throw new Error('queue_has_active_or_unknown_operation');
    this.blob(raw);this.blob(Buffer.from(canonical(p)));this.db.prepare('INSERT INTO meta VALUES(?,?)').run(profileKey,ref);this.db.exec(claimGuard+';'+recordGuard+';');if((this.db.prepare('PRAGMA user_version').get() as Row).user_version<14)this.db.exec('PRAGMA user_version=14;');
    this.event('configured','profile',{profileSha256:ref,executionKind:p.executionKind,credentialVerified:false});return {duplicate:false,profileSha256:ref,credentialVerified:false};
  });}
  configuration(){return this.transaction(()=>this.profile());}
  private original(id:string){
    this.mode();const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row,result=op&&JSON.parse(op.result??'null'),stage=result?.merge;
    if(!op||!stage)throw new Error('original_managed_merge_required');
    const plan=JSON.parse(this.bytes(stage.planSha256).toString()),binding=parseMergeBinding(plan.binding);
    if(mergeBindingHash(binding)!==stage.bindingHash||id!==binding.operation)throw new Error('managed_merge_original_binding_changed');
    for(const e of this.db.prepare("SELECT data FROM events WHERE object=? AND kind LIKE 'managed_merge_%'").all('merge:'+id) as Row[]){const data=JSON.parse(e.data);for(const sha of data.blobs??[])this.bytes(sha);}
    if(stage.response){const original=JSON.parse(this.bytes(stage.response.sha256).toString());if(original.result?.status!==stage.response.status||original.result?.body!==stage.response.body||canonical(inspectMergeResponse({status:original.result.status,body:Buffer.from(original.result.body)}))!==canonical(stage.response.classification))throw new Error('managed_merge_response_metadata_changed');}
    if(stage.readback&&canonical(JSON.parse(this.bytes(stage.readback.sha256).toString()).result)!==canonical(stage.readback.result))throw new Error('managed_merge_readback_metadata_changed');
    return {op,result,stage,plan,binding};
  }
  private view(id:string){const x=this.original(id);return {operation:id,status:x.op.status,binding:x.binding,resources:x.plan.resources,merge:x.stage,executionKind:this.profile().executionKind,duplicate:false,automaticResend:false,automaticRollback:false,productionActionAllowed:false};}
  status(id:string){return this.transaction(()=>this.view(id));}
  private current(b:ManagedMergeBinding,observations:OwnerObservation[]){
    const a=this.authority(b.authorityIntent,observations),s=this.source(b.receptionOperation,true),j=s.receiver.judgment,c=s.candidate;
    if(b.operation!==b.receptionOperation||s.packet!==b.packet||a.binding?.packet!==b.packet||a.role!=='background'||a.request.action!=='merge'||a.request.item!==b.item||a.request.repository.toLowerCase()!==b.repository.toLowerCase()||a.request.target!==b.targetRef||a.request.candidate?.H!==b.H||a.request.candidate?.B!==b.B||a.request.candidate?.subjectSha256!==b.subjectSha256)throw new Error('managed_merge_original_authority_mismatch');
    if(a.request.scopeId!==b.scope.id||a.request.scopeVersion!==b.scope.version||a.request.scopeBodySha256!==b.scope.bodySha256||s.context.scope.id!==b.scope.id||s.context.scope.version!==b.scope.version||s.context.arrangement.id!==b.arrangement.id||s.context.arrangement.version!==b.arrangement.version)throw new Error('managed_merge_scope_or_arrangement_changed');
    if(c.repository.toLowerCase()!==b.repository.toLowerCase()||c.pr!==b.pr||c.H!==b.H||c.B!==b.B||c.targetRef!==b.targetRef||s.tree!==b.T||!s.evidenceComplete||s.receiver.bindingHash!==b.receptionBindingHash||j.judgmentId!==b.judgmentId||j.verdict!=='ACCEPT_WITHIN_SCOPE'||j.findings.some((f:Row)=>f.priority<2))throw new Error('managed_merge_exact_accepted_judgment_required');
    if((this.profile().executionKind==='fixture')!==(s.receiver.executionKind==='fixture'))throw new Error('managed_merge_execution_kind_mismatch');
    if(b.subjectSha256!==null)throw new Error('composition_requires_verified_integration_reception');
    return a;
  }
  prepare(raw:Buffer,observations:OwnerObservation[]){return this.transaction(()=>{
    const p=this.profile(),plan=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
    if(!plan||Object.keys(plan).sort().join()!=='binding,resources'||!Array.isArray(plan.resources))throw new Error('managed_merge_plan_invalid');
    const b=parseMergeBinding(plan.binding),canonicalPlan=Buffer.from(canonical(plan)),op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(b.operation) as Row,result=op&&JSON.parse(op.result??'null');
    if(result?.merge){const old=this.original(b.operation);if(old.stage.planSha256!==hash(canonicalPlan))throw new Error('managed_merge_plan_changed');return {...this.view(b.operation),duplicate:true};}
    if(!op||op.status!=='complete'||op.packet!==b.packet||op.item!==b.item)throw new Error('managed_merge_original_complete_operation_required');
    if(b.repository.toLowerCase()!==p.repository.toLowerCase()||b.repositoryId!==p.repositoryId||!p.targets.includes(b.targetRef))throw new Error('managed_publisher_scope_mismatch');
    const a=this.current(b,observations);
    if(canonical(plan.resources.map(resourceRequestHash))!==canonical(b.resourceRequests)||plan.resources.some((r:ResourceRequest)=>r.operation!==b.operation||r.authorityIntent!==b.authorityIntent||r.role!=='background'||r.actionSha256!==a.requestSha256||!a.request.resourceRefs.includes(r.resourceRef))||new Set(plan.resources.map((r:ResourceRequest)=>r.resourceRef)).size!==a.request.resourceRefs.length)throw new Error('managed_merge_resource_plan_mismatch');
    if((this.db.prepare("SELECT data FROM events WHERE kind='managed_merge_prepared'").all() as Row[]).some(e=>JSON.parse(e.data).authorityIntent===b.authorityIntent))throw new Error('managed_merge_intent_already_bound');
    if(this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(op.target))throw new Error('target_occupied_or_unknown');
    const generation=(this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM operations WHERE target=?').get(op.target) as Row).n+1;
    const stage={phase:'resources_pending',requestState:'not_sent',bindingHash:mergeBindingHash(b),authorityIntent:b.authorityIntent,resourceRequests:b.resourceRequests,planSha256:this.blob(canonicalPlan),priorResultSha256:this.blob(Buffer.from(canonical(result))),executionKind:p.executionKind,registeredAt:now(),attempts:[],controllerReturned:true};
    this.db.prepare("UPDATE operations SET status='merging',generation=?,finished_at=NULL,result=? WHERE id=?").run(generation,JSON.stringify({...result,generation,merge:stage}),b.operation);
    this.db.prepare('INSERT INTO claims VALUES(?,?,?)').run(op.target,b.operation,generation);
    // Resource providers are contacted only after this exact target owner exists.
    for(const r of plan.resources)this.resources().prepare(r,observations,'background');
    this.event('prepared',b.operation,{authorityIntent:b.authorityIntent,bindingHash:stage.bindingHash,generation,blobs:[stage.planSha256,stage.priorResultSha256]});return this.view(b.operation);
  });}
  private own(x:ReturnType<MergeRecords['original']>){const claim=this.db.prepare('SELECT * FROM claims WHERE target=?').get(x.op.target) as Row;if(x.op.status!=='merging'||claim?.operation!==x.op.id||claim.generation!==x.op.generation)throw new Error('managed_merge_unique_target_owner_required');}
  dispatch(id:string,preflight:MergePreflight,observations:OwnerObservation[],directory:string,retryRefused=false){return this.transaction(()=>{
    const x=this.original(id),p=this.profile();
    if(x.stage.phase==='refused'&&retryRefused){
      if(x.op.status!=='complete'||this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(x.op.target))throw new Error('target_occupied_or_unknown');
      const generation=(this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM operations WHERE target=?').get(x.op.target) as Row).n+1;
      this.db.prepare("UPDATE operations SET status='merging',generation=?,finished_at=NULL WHERE id=?").run(generation,id);this.db.prepare('INSERT INTO claims VALUES(?,?,?)').run(x.op.target,id,generation);x.op.status='merging';x.op.generation=generation;
    }else if(x.stage.phase!=='resources_pending')throw new Error('original_merge_requires_query_not_resend');
    this.own(x);if(x.stage.attempts.length>=3)throw new Error('managed_merge_attempt_bound');
    const authorization=this.current(x.binding,observations);requireMergePreflight(preflight,p,x.binding);
    const resources=x.binding.resourceRequests.map(requestId=>this.resources().requireHeldForExecution(requestId,id,x.binding.authorityIntent));
    const evidence=this.preflightEvidence(preflight),originals=evidence.records.map(r=>r.observation.rawSha256),preflightSha=this.blob(Buffer.from(canonical(evidence)));
    const executionBindingSha256=this.blob(Buffer.from(canonical({kind:'managed_merge_dispatch_evidence',operation:id,binding:x.binding,authorization,resources,profile:p,preflightSha256:preflightSha,command:mergeCommand(x.binding,'merge'),registeredAt:now()})));
    delete x.stage.response;delete x.stage.readback;delete x.stage.latestObservationGap;
    x.stage.phase='sent_unknown';x.stage.requestState='registered_outcome_unknown';x.stage.controllerReturned=false;x.stage.dispatchedAt=now();
    x.result.externalActionKind='managed_pull_request_merge';x.result.externalActionSent=p.executionKind==='fixture'?false:'unknown';x.result.externalProductionActionSent=p.executionKind==='fixture'?false:'unknown';
    x.stage.attempts.push({attempt:x.stage.attempts.length+1,directory,controllerPid:process.pid,controllerReturned:false,registeredAt:now(),preflightSha256:preflightSha,executionBindingSha256});
    this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(x.result),id);
    this.event('dispatched',id,{attempt:x.stage.attempts.length,directory,bindingHash:x.stage.bindingHash,blobs:[executionBindingSha256,preflightSha,...originals]});return this.view(id);
  });}
  preflightObserved(id:string,value:MergePreflight){return this.transaction(()=>{
    const x=this.original(id);if(value.bindingSha256!==x.stage.bindingHash||value.profileSha256!==hash(canonical(this.profile())))throw new Error('managed_merge_preflight_binding_mismatch');
    for(const r of value.records)requireMergeObservation(r.observation,this.profile(),r.command);
    const evidence=this.preflightEvidence(value);
    this.event('preflight',id,{ready:value.result.ready,gaps:value.result.gaps,blobs:[this.blob(Buffer.from(canonical(evidence))),...evidence.records.map(r=>r.observation.rawSha256)]});return value.result;
  });}
  private reference(x:ReturnType<MergeRecords['original']>):MergeDispatchReference {const a=x.stage.attempts.at(-1);if(!a)throw new Error('original_merge_dispatch_missing');return {attempt:a.attempt,directory:a.directory,controllerPid:a.controllerPid,controllerReturned:a.controllerReturned};}
  originalDispatch(id:string){return this.transaction(()=>this.reference(this.original(id)));}
  controllerReturned(id:string,directory:string){return this.transaction(()=>{
    const x=this.original(id),a=x.stage.attempts.at(-1);if(!a||a.directory!==directory||a.controllerPid!==process.pid)throw new Error('original_merge_controller_mismatch');
    a.controllerReturned=true;x.stage.controllerReturned=true;this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(x.result),id);this.event('controller_returned',id,{attempt:a.attempt});
  });}
  recoverController(id:string,proof:MergeControllerProof){return this.transaction(()=>{
    const x=this.original(id),ref=this.reference(x);requireMergeControllerProof(proof,ref,mergeCommand(x.binding,'merge'));this.own(x);
    const a=x.stage.attempts.at(-1);a.controllerReturned=true;x.stage.controllerReturned=true;
    if(proof.unstarted){if(x.stage.response||x.stage.readback)throw new Error('observed_merge_cannot_be_unsent');x.stage.phase='resources_pending';x.stage.requestState='known_not_sent';x.result.externalActionSent=false;x.result.externalProductionActionSent=false;a.closedUnstarted=true;}
    this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(x.result),id);this.event('controller_recovered',id,{attempt:a.attempt,unstarted:proof.unstarted,blobs:[this.blob(proof.proof)]});return this.view(id);
  });}
  response(id:string,observation:MergeObservation){return this.transaction(()=>{
    const x=this.original(id),c=mergeCommand(x.binding,'merge');requireMergeObservation(observation,this.profile(),c);const a=x.stage.attempts.at(-1);
    if(!a||a.directory!==observation.directory||!a.controllerReturned)throw new Error('original_merge_response_capture_mismatch');
    const reply=inspectMergeResponse(mergeWire(observation));
    if(a.responseSha256&&a.responseSha256!==hash(observation.raw))throw new Error('original_merge_response_conflict');
    a.responseSha256=this.blob(observation.raw);x.stage.response={status:mergeWire(observation).status,body:mergeWire(observation).body.toString(),classification:reply,sha256:a.responseSha256};
    x.stage.requestState='response_observed';x.result.externalActionSent=this.profile().executionKind==='external';x.result.externalProductionActionSent=this.profile().executionKind==='external';
    if(x.stage.phase==='sent_unknown')x.stage.phase=reply.state;
    this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(x.result),id);this.event('response',id,{attempt:a.attempt,classification:reply,blobs:[a.responseSha256]});
    // Definitive refusal is releasable only after a readback of the original PR.
    return this.view(id);
  });}
  observe(id:string,value:MergeReadback){return this.transaction(()=>{
    const x=this.original(id),p=this.profile(),response=x.stage.response&&{status:x.stage.response.status,body:Buffer.from(x.stage.response.body)};
    requireMergeReadback(value,p,x.binding,response);
    if(!x.stage.attempts.length)throw new Error('original_merge_dispatch_missing');
    if(x.stage.readback?.result?.mergeCommit&&value.result.mergeCommit&&x.stage.readback.result.mergeCommit!==value.result.mergeCommit)throw new Error('actual_merge_identity_conflict');
    const prior=x.stage.phase;
    const terminal=['exact_merge_result_verified','actual_merge_result_verified','merged_wrong_target'];
    const evidence=this.readbackEvidence(value),raw=this.blob(Buffer.from(canonical(evidence)));
    x.stage.readback={sha256:raw,result:value.result,checkedAt:value.checkedAt};
    if(value.result.mergeCommit&&value.result.state!=='sent_unknown'){x.stage.requestState='merge_effect_observed';x.result.externalActionSent=p.executionKind==='external';x.result.externalProductionActionSent=p.executionKind==='external';}
    if(!terminal.includes(prior)){
      if(value.result.state==='exact_merge_result_observed')x.stage.phase='exact_merge_result_verified';
      else if(value.result.state==='merged_wrong_target')x.stage.phase='merged_wrong_target';
      else if(value.result.state==='merged_pending_verification')x.stage.phase='merged_pending_verification';
      else if(x.stage.response?.classification.state==='refused'&&value.result.reason==='original_pr_not_yet_proven_merged')x.stage.phase='refused';
      else x.stage.phase='sent_unknown';
    }else if(value.result.state!=='exact_merge_result_observed'&&prior==='exact_merge_result_verified')x.stage.latestObservationGap=value.result;
    this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(x.result),id);
    this.event('readback',id,{state:x.stage.phase,blobs:[raw,...evidence.records.map(r=>r.observation.rawSha256)]});
    if(x.stage.controllerReturned&&['refused',...terminal].includes(x.stage.phase)&&x.op.status==='merging')this.finish(x);
    return this.view(id);
  });}
  private finish(x:ReturnType<MergeRecords['original']>){
    this.own(x);this.db.prepare("UPDATE operations SET status='complete',finished_at=?,result=? WHERE id=?").run(now(),JSON.stringify(x.result),x.op.id);
    this.db.prepare('DELETE FROM claims WHERE target=? AND operation=? AND generation=?').run(x.op.target,x.op.id,x.op.generation);
  }
  cancelUnstarted(id:string){return this.transaction(()=>{
    const x=this.original(id);if(x.stage.phase==='cancelled_before_send')return {...this.view(id),duplicate:true};
    this.own(x);if(x.stage.phase!=='resources_pending'||!x.stage.controllerReturned||x.stage.attempts.some((a:Row)=>!a.closedUnstarted))throw new Error('merge_started_or_unknown_cannot_cancel_as_unsent');
    for(const request of x.binding.resourceRequests)if(!['prepared_not_sent','held','refused'].includes(this.resources().status(request).state))throw new Error('original_resource_state_requires_reconciliation');
    x.stage.phase='cancelled_before_send';x.stage.requestState='known_not_sent';x.stage.cancelledAt=now();x.result.externalActionSent=false;x.result.externalProductionActionSent=false;this.finish(x);this.event('cancelled_before_send',id,{originalRequestsPreserved:true,automaticRefund:false});return this.view(id);
  });}
  validationInput(id:string){return this.transaction(()=>{
    return this.validationBytes(id);
  });}
  validationReferences(id:string){return this.transaction(()=>this.validationReferenceBytes(id));}
  private validationReferenceBytes(id:string){
    const current=this.validationBytes(id),x=this.original(id),readback=JSON.parse(this.bytes(x.stage.readback.sha256).toString());
    // An already completed receiver may have consumed the exact 073fae0
    // representation. Keep that historical reference eligible only when it
    // comes from this unchanged original index and all its raw blobs match.
    if(!readback.records.length||!readback.records.every((r:Row)=>r.observation.raw!==undefined&&r.observation.rawSha256===undefined))return [current];
    for(const r of readback.records)this.originalCapture(r);
    const legacy=Buffer.from(canonical({kind:'tongxu-actual-merge-validation',operation:id,binding:x.binding,bindingSha256:x.stage.bindingHash,actual:readback.result,readback}));
    return hash(legacy)===hash(current)?[current]:[current,legacy];
  }
  private validationBytes(id:string){
    const x=this.original(id);if(x.stage.phase!=='merged_pending_verification'||x.stage.readback?.result?.reason!=='actual_version_requires_own_validation')throw new Error('actual_merge_version_validation_not_applicable');
    const readback=JSON.parse(this.bytes(x.stage.readback.sha256).toString());
    const captures=readback.records.map((r:Row)=>({record:r,captured:this.originalCapture(r)}));
    const originals=captures.map(({record:r,captured}:{record:Row;captured:{raw:Buffer;sha256:string}})=>({command:r.command,rawSha256:captured.sha256,rawText:new TextDecoder('utf8',{fatal:true}).decode(captured.raw)}));
    const index={...readback,originalIndexSha256:x.stage.readback.sha256,records:captures.map(({record:r,captured}:{record:Row;captured:{raw:Buffer;sha256:string}})=>({command:r.command,observation:{profileSha256:r.observation.profileSha256,inputSha256:r.observation.inputSha256,directory:r.observation.directory,capturedAt:r.observation.capturedAt,rawSha256:captured.sha256,rawBytes:captured.raw.length}}))};
    return Buffer.from(canonical({kind:'tongxu-actual-merge-validation',operation:id,binding:x.binding,bindingSha256:x.stage.bindingHash,actual:readback.result,readback:index,originals}));
  }
  completeValidation(id:string,value:ActualMergeValidation){return this.transaction(()=>{
    const references=this.validationReferenceBytes(id),reference=references.find(r=>hash(r)===value.referenceSha256),x=this.original(id);if(!reference)throw new Error('actual_independent_merge_validation_required');requireActualMergeValidation(value,reference,this.profile().executionKind);this.own(x);
    if(!x.stage.controllerReturned)throw new Error('original_merge_controller_still_unknown');
    x.stage.validationSha256=this.blob(value.proof);x.stage.phase='actual_merge_result_verified';this.finish(x);
    this.event('actual_version_validated',id,{blobs:[x.stage.validationSha256],originalMergeRepeated:false});return this.view(id);
  });}
  completedValidation(id:string,store:string,operation:string){return this.transaction(()=>{
    const x=this.original(id);if(x.stage.phase!=='actual_merge_result_verified')return null;
    const proof=JSON.parse(this.bytes(x.stage.validationSha256).toString());if(proof.store!==store||proof.operation!==operation)throw new Error('actual_merge_validation_already_bound');
    return {...this.view(id),duplicate:true,newModelCalls:0,newMergeCall:false};
  });}
  problem(id:string,reason:string){return this.transaction(()=>{this.original(id);this.event('problem',id,{reason:reason.slice(0,512)});return this.view(id);});}
}
