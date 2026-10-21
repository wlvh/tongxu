import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import { parseLedgerProfile,parseResourceRequest,resourceRequestHash,type LedgerProfile,type ResourceRequest,type LedgerCommand } from './resource-contract.js';
import { requireLedgerObservation,requireResourceUnstarted,type LedgerObservation,type ResourceDispatchReference,type ResourceUnstartedProof } from './resource-provider.js';
import type { OwnerObservation } from './authority-source.js';
import type { AuthorityRole } from './authority-contract.js';

type Row=Record<string,any>;
export type ResourceOutcome={state:'completed'|'failed'|'cancelled';source:string;proof:Buffer;executionKind:'fixture'|'external'};
/** Source association only. Quota, competition and consumption belong to the
 * existing provider. No balances or automatic refunds are stored here. */
export class ResourceRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,
    private authority:(id:string,fresh:OwnerObservation[]|null)=>Row,
    private execution:(operation:string,action:Row,claimedAt:string)=>ResourceOutcome){}
  private event(kind:string,object:string,data:unknown){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run(kind,object,JSON.stringify(data),now());}
  private events(key:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'resource_%' ORDER BY id").all('resource:'+key) as Row[]).map(e=>({...e,data:JSON.parse(e.data)}));}
  private blob(b:Buffer){const h=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(h,b);this.bytes(h);return h;}
  private bytes(h:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(h) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==h)throw new Error('resource_original_missing_or_changed');return b;}
  private profile(ledgerId:string){if(![13,14,15,16].includes((this.db.prepare('PRAGMA user_version').get() as Row).user_version))throw new Error('resource_format_not_enabled');const ref=(this.db.prepare('SELECT value FROM meta WHERE key=?').get('resource-ledger:'+ledgerId) as Row)?.value;if(!ref)throw new Error('existing_resource_ledger_not_configured');return parseLedgerProfile(this.bytes(ref));}
  configure(raw:Buffer){return this.transaction(()=>{
    const p=parseLedgerProfile(raw),h=hash(canonical(p)),version=(this.db.prepare('PRAGMA user_version').get() as Row).user_version;
    if(![12,13,14,15,16].includes(version))throw new Error('enable_owner_authority_before_resources');
    const ownerRef=(this.db.prepare("SELECT value FROM meta WHERE key='owner_authority_profile'").get() as Row)?.value;if(!ownerRef)throw new Error('resource_owner_profile_required');const owner=JSON.parse(this.bytes(ownerRef).toString());
    if(owner.repository.toLowerCase()!==p.repository.toLowerCase()||(owner.executionKind==='fixture')!==(p.executionKind==='fixture'))throw new Error('resource_authority_profile_mismatch');
    const key='resource-ledger:'+p.ledgerId,old=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row;
    if(old){if(old.value!==h)throw new Error('resource_ledger_profile_is_fixed');return {ledgerId:p.ledgerId,profileSha256:h,duplicate:true,credentialState:'not_observed',resourceBalanceStored:false};}
    if((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n||(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n)throw new Error('queue_has_active_or_unknown_operation');
    this.blob(raw);this.blob(Buffer.from(canonical(p)));this.db.prepare('INSERT INTO meta VALUES(?,?)').run(key,h);if(version<13)this.db.exec('PRAGMA user_version=13');
    this.event('resource_profile_configured','resource-profile:'+p.ledgerId,{ledgerId:p.ledgerId,profileSha256:h,originalSha256:hash(raw),executionKind:p.executionKind,capabilityVerified:false});return {ledgerId:p.ledgerId,profileSha256:h,duplicate:false,credentialState:'not_observed',resourceBalanceStored:false};
  });}
  configuration(id:string){return this.transaction(()=>this.profile(id));}
  private fixed(id:string){const events=this.events(id),prepared=events.find(e=>e.kind==='resource_request_prepared');if(!prepared)throw new Error('original_resource_request_required');const request=JSON.parse(this.bytes(prepared.data.requestSha256).toString()) as ResourceRequest,p=this.profile(request.ledgerId);parseResourceRequest(request,p);if(resourceRequestHash(request)!==id)throw new Error('resource_request_identity_changed');return {request,profile:p,prepared:prepared.data,events};}
  private statusOf(id:string){
    const f=this.fixed(id),sent=f.events.filter(e=>e.kind==='resource_claim_dispatched'),replies=f.events.filter(e=>e.kind==='resource_reply_observed'),present=replies.filter(e=>e.data.reply.result.state==='present'),last=present.at(-1),refusal=replies.findLast(e=>e.data.command==='claim'&&e.data.reply.result.state==='refused'),outcome=f.events.find(e=>e.kind==='resource_execution_outcome'),settlement=f.events.filter(e=>e.kind==='resource_result_dispatched');
    for(const e of replies)if(canonical(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(this.bytes(e.data.rawSha256))))!==canonical(e.data.reply))throw new Error('resource_saved_reply_changed');
    const claim=last?.data.reply.result.claim??null;
    let state=claim?claim.state:sent.length?'claim_unknown':'prepared_not_sent';
    if(!claim&&refusal&&refusal.id>sent.at(-1)!.id)state='refused';
    if(!claim&&sent.length&&f.events.some(e=>e.kind==='resource_dispatch_closed_unstarted'&&e.data.phase==='claim'&&e.data.dispatchEvent===sent.at(-1)!.id))state='prepared_not_sent';
    const latestReply=replies.at(-1),latestProblem=f.events.findLast(e=>e.kind==='resource_problem');
    // Keep the original claim identity, but never use an earlier held answer
    // after a newer lookup/transport failure makes its current state unknown.
    if(claim?.state==='unknown'||claim?.state==='held'&&(latestReply?.data.reply.result.state!=='present'||latestProblem&&latestProblem.id>(latestReply?.id??0)))state='claim_unknown';
    if(outcome&&(!claim?.outcomeSha256||claim.outcomeSha256!==outcome.data.outcomeSha256))state=claim&&['consumed','released'].includes(claim.state)?'result_conflict':'result_pending';
    const issues=f.events.filter(e=>e.kind==='resource_problem').map(e=>e.data);
    const pendingResultAttempt=Boolean(settlement.length&&!f.events.some(e=>e.kind==='resource_dispatch_closed_unstarted'&&e.data.phase==='result'&&e.data.dispatchEvent===settlement.at(-1)!.id));
    return {id,request:f.request,profileSha256:hash(canonical(f.profile)),executionKind:f.profile.executionKind,state,claim,claimAttempts:sent.length,resultAttempts:settlement.length,pendingResultAttempt,outcome:outcome?.data??null,issues,originalOperation:f.request.operation,resourceBalanceStored:false,automaticRefund:false,newExecutionAllowed:false};
  }
  status(id:string){return this.transaction(()=>this.statusOf(id));}
  settledOutcome(id:string){return this.transaction(()=>{const s=this.statusOf(id);if(!s.outcome)return false;this.validateOutcome(s);return ['consumed','released'].includes(s.state)&&Boolean(s.claim?.outcomeSha256)&&s.claim.outcomeSha256===s.outcome.outcomeSha256;});}
  prepare(request:ResourceRequest,observations:OwnerObservation[],callerRole:AuthorityRole){return this.transaction(()=>{
    const p=this.profile(request.ledgerId);parseResourceRequest(request,p);const id=resourceRequestHash(request);
    if(request.role!==callerRole)throw new Error('resource_trusted_role_mismatch');
    if(this.events(id).some(e=>e.kind==='resource_request_prepared'))return {...this.statusOf(id),duplicate:true};
    const action=this.authority(request.authorityIntent,observations);this.matchAction(request,action);
    const intentBindings=(this.db.prepare("SELECT data FROM events WHERE kind='resource_request_prepared' AND json_extract(data,'$.authorityIntent')=?").all(request.authorityIntent) as Row[]).map(e=>JSON.parse(e.data));
    if(intentBindings.some(e=>e.operation!==request.operation||e.packet!==action.binding?.packet||e.actionSha256!==request.actionSha256))throw new Error('authority_intent_already_bound_to_original_operation');
    const slot=hash(canonical([request.operation,request.ledgerId,request.resourceRef]));
    const prior=(this.db.prepare("SELECT data FROM events WHERE kind='resource_request_prepared'").all() as Row[]).map(e=>JSON.parse(e.data)).filter(e=>e.slot===slot);
    // A different fixed action may use the same provider resource after its
    // predecessor settled, was refused, or never claimed. Unknown/held and
    // same-action requests cannot be replaced with another intent.
    if(prior.some(p=>p.actionSha256===request.actionSha256||!['prepared_not_sent','refused','consumed','released'].includes(this.statusOf(p.requestSha256).state)))throw new Error('original_resource_slot_already_bound');
    this.blob(Buffer.from(canonical(request)));const entry={requestSha256:id,slot,operation:request.operation,authorityIntent:request.authorityIntent,actionSha256:request.actionSha256,role:request.role,packet:action.binding?.packet,profileSha256:hash(canonical(p)),preparedAt:now()};
    this.event('resource_request_prepared','resource:'+id,entry);return {...this.statusOf(id),duplicate:false};
  });}
  private matchAction(request:ResourceRequest,action:Row){
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(request.operation) as Row;
    if(!op||action.requestSha256!==request.actionSha256||action.role!==request.role||!action.request.resourceRefs.includes(request.resourceRef)||action.request.repository.toLowerCase()!==request.repository.toLowerCase()||action.request.item!==op.item||action.binding?.packet!==op.packet)throw new Error('resource_original_action_or_operation_mismatch');
    const result=JSON.parse(op.result??'null'),stage={receive:'receiver',implement:'repair',merge:'merge',coordinate:'secretary',test:'test',publish:'publication'}[action.request.action as string];
    const claim=this.db.prepare('SELECT * FROM claims WHERE target=?').get(op.target) as Row;
    const ownMerge=stage==='merge'&&op.status==='merging'&&result?.merge?.phase==='resources_pending'&&result.merge.authorityIntent===request.authorityIntent&&result.merge.resourceRequests?.includes(resourceRequestHash(request))&&claim?.operation===op.id&&claim.generation===op.generation;
    const message=result?.messageResources?.[action.request.payloadSha256],ownMessage=action.request.action==='coordinate'&&op.status==='messaging'&&message?.phase==='resources_pending'&&message.authorityIntent===request.authorityIntent&&message.resourceRequests?.includes(resourceRequestHash(request));
    if(JSON.parse((this.db.prepare('SELECT candidate FROM items WHERE id=?').get(op.item) as Row).candidate).kind==='development-task'&&!ownMessage)throw new Error('task_resource_requires_bound_consumer');
    if(!ownMerge&&!ownMessage&&(op.status!=='complete'||!stage||result?.[stage]))throw new Error('resource_claim_requires_unstarted_exact_action');
    if(claim&&!ownMerge)throw new Error('resource_target_execution_active_or_unknown');
  }
  requireHeldForExecution(id:string,operation:string,intent:string){return this.transaction(()=>{
    const f=this.fixed(id),s=this.statusOf(id),last=f.events.findLast(e=>e.kind==='resource_reply_observed');
    if(f.request.operation!==operation||f.request.authorityIntent!==intent||s.state!=='held'||s.claim?.state!=='held'||last?.data.reply.result.state!=='present'||last.data.reply.result.claim.state!=='held'||!['claim','lookup'].includes(last.data.command)||Date.now()-Date.parse(last.data.capturedAt)>60000)throw new Error('fresh_original_held_resource_claim_required');
    return s;
  });}
  command(id:string,kind:LedgerCommand['command']):LedgerCommand{return this.transaction(()=>{
    const f=this.fixed(id),state=this.statusOf(id);
    if(kind==='record_result')this.validateOutcome(state);
    return {protocol:f.profile.protocol,ledgerId:f.profile.ledgerId,command:kind,requestId:id,request:kind==='capabilities'?null:f.request,outcome:kind==='record_result'?state.outcome?.outcome??null:null};
  });}
  private validateOutcome(state:Row){
    const record=state.outcome;if(!record||hash(canonical(record.outcome))!==record.outcomeSha256)throw new Error('resource_original_outcome_missing_or_changed');
    this.bytes(record.outcome.evidenceSha256);
  }
  dispatchClaim(id:string,capabilities:LedgerObservation,observations:OwnerObservation[],callerRole:AuthorityRole,directory:string,retryRefused=false){return this.transaction(()=>{
    const f=this.fixed(id),state=this.statusOf(id),capCommand:LedgerCommand={protocol:f.profile.protocol,ledgerId:f.profile.ledgerId,command:'capabilities',requestId:id,request:null,outcome:null};
    if(f.request.role!==callerRole)throw new Error('resource_trusted_role_mismatch');
    requireLedgerObservation(capabilities,f.profile,capCommand);
    if(capabilities.reply.result.credentialState!=='available')throw new Error('original_ledger_credentials_unavailable');
    if(capabilities.reply.result.claim!==true)throw new Error('original_ledger_claim_permission_unavailable');
    if(state.state!=='prepared_not_sent'&&!(state.state==='refused'&&retryRefused))throw new Error('resource_original_request_requires_lookup_not_resend');
    if(state.claimAttempts>=3)throw new Error('resource_refused_retry_bound');
    const action=this.authority(f.request.authorityIntent,observations);this.matchAction(f.request,action);
    const slot=hash(canonical([f.request.operation,f.request.ledgerId,f.request.resourceRef]));for(const row of this.db.prepare("SELECT data FROM events WHERE kind='resource_request_prepared'").all() as Row[]){const prior=JSON.parse(row.data);if(prior.slot===slot&&prior.requestSha256!==id&&!['prepared_not_sent','refused','consumed','released'].includes(this.statusOf(prior.requestSha256).state))throw new Error('resource_previous_action_claim_unresolved');}
    this.blob(capabilities.raw);this.event('resource_claim_dispatched','resource:'+id,{requestSha256:id,originalOperation:f.request.operation,directory,attempt:state.claimAttempts+1,capabilitiesSha256:hash(capabilities.raw),registeredAt:now(),controllerPid:process.pid});
    return this.statusOf(id);
  });}
  observe(id:string,command:LedgerCommand,observation:LedgerObservation){return this.transaction(()=>{
    const f=this.fixed(id);if(command.requestId!==id||command.command==='capabilities')throw new Error('resource_observation_request_mismatch');requireLedgerObservation(observation,f.profile,command);
    if(canonical(command.request)!==canonical(f.request))throw new Error('resource_observation_material_changed');
    const s=this.statusOf(id),r=observation.reply.result,known=s.claim;
    if(command.command==='claim'&&!s.claimAttempts||command.command==='record_result'&&!s.resultAttempts)throw new Error('resource_sent_intent_missing');
    const dispatched=f.events.findLast(e=>e.kind===(command.command==='claim'?'resource_claim_dispatched':'resource_result_dispatched'));
    if(command.command!=='lookup'&&dispatched?.data.directory!==observation.directory)throw new Error('resource_original_dispatch_capture_mismatch');
    if(command.command==='record_result'&&canonical(command.outcome)!==canonical(s.outcome?.outcome))throw new Error('resource_result_request_changed');
    if(r.state==='present'&&known&&(r.claim.id!==known.id||['consumed','released'].includes(known.state)&&(r.claim.state!==known.state||r.claim.outcomeSha256!==known.outcomeSha256)))throw new Error('resource_original_claim_or_terminal_conflict');
    if(r.state==='present'&&known&&known.state==='held'&&r.claim.state==='unknown'){
      this.event('resource_problem','resource:'+id,{kind:'provider_cannot_currently_confirm_claim',rawSha256:this.blob(observation.raw),originalClaim:known.id});
    }
    this.event('resource_reply_observed','resource:'+id,{command:command.command,reply:observation.reply,rawSha256:this.blob(observation.raw),directory:observation.directory,capturedAt:observation.capturedAt});return this.statusOf(id);
  });}
  problem(id:string,reason:string,directory:string){return this.transaction(()=>{this.fixed(id);this.event('resource_problem','resource:'+id,{kind:'provider_request_unresolved',reason:reason.slice(0,512),directory});return this.statusOf(id);});}
  private dispatchReference(id:string,phase:'claim'|'result'):ResourceDispatchReference{
    const f=this.fixed(id),d=f.events.findLast(e=>e.kind===(phase==='claim'?'resource_claim_dispatched':'resource_result_dispatched'));if(!d)throw new Error('resource_original_dispatch_missing');
    return {event:d.id,phase,directory:d.data.directory,controllerPid:d.data.controllerPid,controllerReturned:f.events.some(e=>e.kind==='resource_controller_returned'&&e.data.dispatchEvent===d.id)};
  }
  originalDispatch(id:string,phase:'claim'|'result'){return this.transaction(()=>this.dispatchReference(id,phase));}
  controllerReturned(id:string,phase:'claim'|'result',directory:string){return this.transaction(()=>{
    const ref=this.dispatchReference(id,phase);if(ref.directory!==directory||ref.controllerPid!==process.pid)throw new Error('resource_original_controller_mismatch');
    if(!ref.controllerReturned)this.event('resource_controller_returned','resource:'+id,{dispatchEvent:ref.event,phase,directory});
  });}
  closeUnstarted(id:string,phase:'claim'|'result',proof:ResourceUnstartedProof){return this.transaction(()=>{
    const f=this.fixed(id),ref=this.dispatchReference(id,phase),s=this.statusOf(id),command:LedgerCommand={protocol:f.profile.protocol,ledgerId:f.profile.ledgerId,command:phase==='claim'?'claim':'record_result',requestId:id,request:f.request,outcome:phase==='result'?s.outcome?.outcome??null:null};
    requireResourceUnstarted(proof,ref,command);
    if(f.events.some(e=>e.kind==='resource_dispatch_closed_unstarted'&&e.data.dispatchEvent===ref.event))return {...s,duplicate:true};
    if(phase==='claim'&&s.state!=='claim_unknown'||phase==='result'&&(!s.pendingResultAttempt||s.state!=='result_pending'))throw new Error('resource_unstarted_state_changed');
    this.event('resource_dispatch_closed_unstarted','resource:'+id,{dispatchEvent:ref.event,phase,proofSha256:this.blob(proof.proof),originalRequestPreserved:true,resourceRefunded:false});return {...this.statusOf(id),duplicate:false};
  });}
  prepareOutcome(id:string){return this.transaction(()=>{
    const f=this.fixed(id),s=this.statusOf(id);if(s.outcome){this.validateOutcome(s);return {...s,duplicate:true};}
    if(!s.claim||s.claim.state!=='held')throw new Error('original_held_resource_claim_required');
    const accepted=f.events.find(e=>e.kind==='resource_reply_observed'&&e.data.reply.result.state==='present'&&e.data.reply.result.claim.state==='held');if(!accepted)throw new Error('original_resource_claim_receipt_required');
    const action=this.authority(f.request.authorityIntent,null),evidence=this.execution(f.request.operation,action,accepted.observed_at);
    if(evidence.executionKind!==f.profile.executionKind)throw new Error('resource_execution_kind_mismatch');
    if(!['completed','failed','cancelled'].includes(evidence.state)||!Buffer.isBuffer(evidence.proof)||!evidence.proof.length||evidence.proof.length>4*1024*1024||typeof evidence.source!=='string'||!evidence.source)throw new Error('resource_known_execution_evidence_required');
    const outcome={claimId:s.claim.id,state:evidence.state,evidenceSha256:this.blob(evidence.proof)},record={outcome,outcomeSha256:hash(canonical(outcome)),source:evidence.source,originalOperation:f.request.operation};
    this.event('resource_execution_outcome','resource:'+id,record);return {...this.statusOf(id),duplicate:false};
  });}
  dispatchResult(id:string,capabilities:LedgerObservation,directory:string){return this.transaction(()=>{
    const f=this.fixed(id),s=this.statusOf(id),c:LedgerCommand={protocol:f.profile.protocol,ledgerId:f.profile.ledgerId,command:'capabilities',requestId:id,request:null,outcome:null};requireLedgerObservation(capabilities,f.profile,c);
    this.validateOutcome(s);
    if(capabilities.reply.result.credentialState!=='available'||capabilities.reply.result.recordResult!==true)throw new Error('original_ledger_result_permission_unavailable');
    if(!s.outcome||s.state!=='result_pending')throw new Error('resource_result_unavailable_conflicting_or_already_recorded');
    if(s.pendingResultAttempt)throw new Error('resource_original_result_requires_lookup_not_resend');
    if(s.resultAttempts>=3)throw new Error('resource_result_unstarted_retry_bound');
    this.event('resource_result_dispatched','resource:'+id,{outcomeSha256:s.outcome.outcomeSha256,directory,originalOperation:f.request.operation,registeredAt:now(),controllerPid:process.pid});return this.statusOf(id);
  });}
}
