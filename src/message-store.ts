import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import { parseMessagePlan,messagePlanId,continuationMessagePrefix,checkMessageBilling,type MessagePlan } from './message-contract.js';
import type { OwnerObservation } from './authority-source.js';
import { requireDialogProof,type DialogProof } from './message-runtime.js';
import { inspectRolePrompt } from './role-prompts.js';
import { join } from 'node:path';
type Row=Record<string,any>;
/** Transport records beside the original queue. They are neither formal
 * judgments nor resource balances and never confer writing/merge authority. */
export class MessageRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private directory:string,private item:(id:string)=>Row,private authority:(id:string,observations:OwnerObservation[])=>Row,private coordinationGate?:(run:string,messageId?:string,participant?:string,effect?:'message_runtime_started'|'message_send_registered')=>void,private resourceGate?:(run:string,action:Row)=>void,private resourceResult?:(run:string)=>boolean){}
  private events(run:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'message_%' ORDER BY id").all('messages:'+run) as Row[]).map(e=>({...e,data:JSON.parse(e.data)}));}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('message_original_missing_or_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(run:string,kind:string,data:unknown){const b=Buffer.from(canonical(data)),sha=this.blob(b);this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('message_'+kind,'messages:'+run,JSON.stringify({value:data,sha256:sha}),now());}
  private entries(run:string):Row[]{return this.events(run).map(e=>{if(canonical(JSON.parse(this.bytes(e.data.sha256).toString()))!==canonical(e.data.value))throw new Error('message_index_changed');return {...e,data:e.data.value};});}
  private fixed(run:string){const e=this.entries(run),r=e.find(e=>e.kind==='message_registered')?.data;if(!r)throw new Error('original_message_run_required');const plan=parseMessagePlan(this.bytes(r.planSha256));if(messagePlanId(plan)!==run)throw new Error('message_plan_changed');return {r,plan,e};}
  private runtime(f:ReturnType<MessageRecords['fixed']>,participant:string){const starts=f.e.filter(e=>e.kind==='message_runtime_started'&&e.data.participant===participant),started=starts.at(-1)?.data??null,attempt=started?.attempt??0,ended=f.e.find(e=>e.kind==='message_runtime_ended'&&e.data.participant===participant&&e.data.attempt===attempt)?.data??null,revalidation=f.e.findLast(e=>e.kind==='message_runtime_revalidated'&&e.data.participant===participant&&e.data.attempt===attempt)?.data??null;if(revalidation&&(!ended||revalidation.originalEndedSha256!==hash(canonical(ended))||revalidation.originalRefsSha256!==hash(canonical(ended.originals))))throw new Error('message_revalidation_original_changed');return {participant,attempt,started,route:f.e.find(e=>e.kind==='message_route_bound'&&e.data.participant===participant&&e.data.attempt===attempt)?.data.route??null,ended,captureVerification:revalidation?{source:revalidation.contract==='exact-original-refusal-v2'?'strict_original_refusal_recheck':'strict_original_claude_input_recheck',proof:revalidation.proof,record:revalidation}:ended?{source:'original_capture_check',proof:ended.proof}:null};}
  register(raw:Buffer,materials:Record<string,Buffer>,assemblies:Record<string,Buffer>){return this.transaction(()=>{
    const p=parseMessagePlan(raw),run=messagePlanId(p);if(this.events(run).length)return {...this.view(run),duplicate:true};
    if(canonical(Object.keys(materials).sort())!==canonical(p.material.map(m=>m.name).sort())||canonical(Object.keys(assemblies).sort())!==canonical(p.participants.map(a=>a.id).sort()))throw new Error('message_complete_material_required');
    let total=0;for(const m of p.material){const b=materials[m.name]!;total+=b.length;if(hash(b)!==m.sha256||b.length>512*1024||total>1024*1024)throw new Error('message_material_changed_or_limit');}for(const a of p.participants)inspectRolePrompt(JSON.parse(assemblies[a.id]!.toString()),a.role);
    const bindings=Object.fromEntries(p.participants.map(a=>[a.id,this.item(a.item)])),first=Object.values(bindings)[0]!;
    if(Object.values(bindings).some(b=>b.candidate.repository!==first.candidate.repository||canonical(b.context.scope)!==canonical(first.context.scope)))throw new Error('message_participants_scope_mismatch');
    const refs=(objects:Record<string,Buffer>)=>Object.fromEntries(Object.entries(objects).map(([name,b])=>[name,{sha256:this.blob(b),bytes:b.length}]));
    this.event(run,'registered',{run,planSha256:this.blob(Buffer.from(canonical(p))),originalPlanSha256:this.blob(raw),bindings,materials:refs(materials),assemblies:refs(assemblies),registeredAt:now()});return {...this.view(run),duplicate:false};
  });}
  private gate(run:string,observations:OwnerObservation[],requireResources=true){
    const f=this.fixed(run);for(const a of f.plan.participants){const before=f.r.bindings[a.id],current=this.item(a.item);if(!current.current||current.packet!==before.packet||current.fingerprint!==before.fingerprint)throw new Error('message_candidate_or_material_changed');if((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(current.context.scope.id) as Row)?.stopped)throw new Error('new_investment_stopped');}
    const parent=this.continuationParentValue(run);if(parent)this.continuationSourceValue(parent);
    const configured=this.db.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get();if(configured&&!f.plan.resourceBudget)throw new Error('message_configured_resource_consumer_not_yet_bound');
    if(this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get()){
      if(f.plan.authorityIntent===null)throw new Error('message_coordination_authority_required');const a=this.authority(f.plan.authorityIntent,observations),request=a.request,first=f.r.bindings[f.plan.participants[0]!.id];
      if(!['background','coordinator','secretary'].includes(a.role)||request.action!=='coordinate'||request.payloadSha256!==run||request.paths.length||canonical([...request.resourceRefs].sort())!==canonical((f.plan.resourceBudget??[]).map(x=>x.resourceRef).sort())||request.scopeId!==first.context.scope.id||request.scopeVersion!==first.context.scope.version||(a.executionKind==='fixture')!==(f.plan.executionKind==='fixture'))throw new Error('message_coordination_authority_mismatch');
      if(f.plan.resourceBudget&&requireResources){if(!this.resourceGate)throw new Error('message_resource_consumer_unavailable');this.resourceGate(run,a);}
    }else if(f.plan.authorityIntent!==null)throw new Error('message_authority_profile_missing');
    return f;
  }
  admission(run:string,observations:OwnerObservation[]){return this.transaction(()=>{this.gate(run,observations,false);this.coordinationGate?.(run);return this.view(run);});}
  observeBilling(run:string,billing:MessagePlan['billing']){return this.transaction(()=>{const f=this.fixed(run);checkMessageBilling(billing);const raw=Buffer.from(canonical(billing)),sha256=hash(raw),latest=f.e.findLast(e=>e.kind==='message_billing_observed');if(latest&&Date.parse(billing.observedAt)<Date.parse(latest.data.billing.observedAt))throw new Error('message_billing_observation_older');if(!latest||latest.data.sha256!==sha256)this.event(run,'billing_observed',{sha256:this.blob(raw),billing,originalPlanUnmodified:true});return sha256;});}
  check(run:string,observations:OwnerObservation[],messageId?:string){return this.transaction(()=>{this.gate(run,observations);this.coordinationGate?.(run,messageId);return this.view(run);});}
  startRuntime(run:string,participant:string,observations:OwnerObservation[]){return this.transaction(()=>{
    const f=this.gate(run,observations),p=f.plan.participants.find(p=>p.id===participant);if(!p)throw new Error('message_participant_missing');const prior=this.runtime(f,participant);
    if(prior.started&&(!prior.ended||!prior.ended.proof.successfulCapture&&!prior.ended.proof.knownUnstarted||f.e.some(e=>e.kind==='message_send_registered'&&f.plan.messages.find(m=>m.id===e.data.id)?.to===participant)))throw new Error('message_original_runtime_must_be_reconciled');
    if(prior.attempt>=3)throw new Error('message_unstarted_bootstrap_retry_limit');
    const starts:Row[]=(this.db.prepare("SELECT object,data FROM events WHERE kind='message_runtime_started'").all() as Row[]).map(e=>({...e,data:JSON.parse(e.data).value}));for(const s of starts)if(s.data.item===p.item&&s.data.role===p.role){const oldRun=s.object.slice(9),state=this.view(oldRun),runtime=state.runtimes.find(r=>r.participant===s.data.participant)!;if(runtime.attempt!==s.data.attempt)continue;const unresolved=state.messages.some(m=>m.to===s.data.participant&&['Unknown','Delivered'].includes(m.state));if(!runtime.ended||unresolved)throw new Error('message_prior_role_runtime_active_or_unknown');}
    this.coordinationGate?.(run,undefined,participant,'message_runtime_started');
    const attempt=prior.attempt+1,directory=join(this.directory,'messages-'+run,'runtimes',hash(participant),'attempt-'+attempt);this.event(run,'runtime_started',{participant,attempt,directory,item:p.item,role:p.role,controllerPid:process.pid,startedAt:now()});return this.view(run);
  });}
  private route(run:string,participant:string,route:Row){return this.transaction(()=>{const f=this.fixed(run),r=this.runtime(f,participant);if(!r.started)throw new Error('message_runtime_not_started');if(r.route){if(canonical(r.route)!==canonical(route))throw new Error('message_original_recipient_is_fixed');return this.view(run);}this.event(run,'route_bound',{participant,attempt:r.attempt,route});return this.view(run);});}
  intent(run:string,id:string,envelope:Buffer,observations:OwnerObservation[]){return this.transaction(()=>{
    const f=this.gate(run,observations),m=f.plan.messages.find(m=>m.id===id);if(!m)throw new Error('message_missing');if(f.e.some(e=>e.kind==='message_send_registered'&&e.data.id===id))throw new Error('message_unknown_or_sent_never_resend');this.coordinationGate?.(run,id,undefined,'message_send_registered');
    const runtime=this.runtime(f,m.to),route=runtime.route;if(!route||runtime.ended)throw new Error('message_recipient_not_running');
    const parsed=JSON.parse(envelope.toString());if(parsed.messageId!==id||canonical(parsed.to)!==canonical(route)||parsed.run!==run)throw new Error('message_envelope_address_mismatch');
    const current=this.view(run),references:string[]=[];for(const prior of m.replies){const upstream=current.messages.find(m=>m.id===prior);if(upstream?.state!=='Reply'||!upstream.reply?.reportedConsumption)throw new Error('message_upstream_reply_required');references.push(upstream.reply.finalSha256);}for(const name of f.plan.consumeMaterial??[])references.push(f.r.materials[name].sha256);if(canonical(parsed.replyReferences)!==canonical(references)||canonical(parsed.responseContract?.consumed)!==canonical(references))throw new Error('message_consumption_references_changed');
    const billing=f.e.findLast(e=>e.kind==='message_billing_observed')?.data.sha256;
    this.event(run,'send_registered',{id,recipient:route,inputSha256:this.blob(envelope),registeredAt:now(),...(billing?{billingObservationSha256:billing}:{})});return this.view(run);
  });}
  private delivered(run:string,id:string,receipt:Row){return this.transaction(()=>{const f=this.fixed(run),sent=f.e.find(e=>e.kind==='message_send_registered'&&e.data.id===id)?.data;if(!sent||receipt.inputSha256!==sent.inputSha256||receipt.sessionId!==sent.recipient.sessionId||receipt.threadId!==sent.recipient.threadId)throw new Error('message_send_intent_required');const old=f.e.find(e=>e.kind==='message_delivered'&&e.data.id===id);if(old){if(canonical(old.data.receipt)!==canonical(receipt))throw new Error('message_delivery_receipt_changed');return this.view(run);}this.event(run,'delivered',{id,receipt});return this.view(run);});}
  private refused(run:string,id:string,receipt:Row){return this.transaction(()=>{const f=this.fixed(run),sent=f.e.find(e=>e.kind==='message_send_registered'&&e.data.id===id)?.data;if(!sent||receipt.inputSha256!==sent.inputSha256||receipt.sessionId!==sent.recipient.sessionId||f.e.some(e=>e.kind==='message_delivered'&&e.data.id===id))throw new Error('message_refusal_does_not_match_unsuccessful_send');const old=f.e.find(e=>e.kind==='message_refused'&&e.data.id===id);if(old){if(canonical(old.data.receipt)!==canonical(receipt))throw new Error('message_refusal_changed');return this.view(run);}this.event(run,'refused',{id,receipt});return this.view(run);});}
  private reply(run:string,id:string,receipt:Row){return this.transaction(()=>{const f=this.fixed(run),d=f.e.find(e=>e.kind==='message_delivered'&&e.data.id===id)?.data.receipt;if(!d||['sessionId','threadId','turnId','inputSha256'].some(k=>d[k]!==receipt[k])||hash(receipt.finalText)!==receipt.finalSha256)throw new Error('message_delivery_receipt_required');const old=f.e.find(e=>e.kind==='message_reply'&&e.data.id===id);if(old){if(canonical(old.data.receipt)!==canonical(receipt))throw new Error('message_reply_changed');return this.view(run);}this.event(run,'reply',{id,receipt});return this.view(run);});}
  private ended(run:string,participant:string,proof:Row,originals:Record<string,Buffer>,verifiedRefusalIds:string[]=[],verifiedClaudeMessageIds:string[]=[]){return this.transaction(()=>{
    const f=this.fixed(run),runtime=this.runtime(f,participant);if(!runtime.started)throw new Error('original_message_runtime_required');if(proof.knownUnstarted&&f.e.some(e=>e.kind==='message_send_registered'&&f.plan.messages.find(m=>m.id===e.data.id)?.to===participant))throw new Error('message_registered_send_not_unstarted');const refs=Object.fromEntries(Object.entries(originals).map(([n,b])=>[n,{sha256:this.blob(b),bytes:b.length}])),data={participant,attempt:runtime.attempt,proof,originals:refs};
    if(runtime.ended){
      if(canonical(runtime.ended)===canonical(data))return this.view(run);
      // Preserve earlier failed classifications. Only strict replays of the
      // identical bytes/exit can append a known protocol-specific correction:
      // the old invalid-parameter refusal or 304's per-input initialization.
      const old=runtime.ended;if(old.proof.successfulCapture!==false||proof.successfulCapture!==true||proof.knownUnstarted||old.proof.knownUnstarted||canonical(old.originals)!==canonical(refs)||canonical(old.proof.exit)!==canonical(proof.exit))throw new Error('message_closed_capture_changed');
      const refusal=verifiedRefusalIds.length>0&&verifiedRefusalIds.every(id=>f.plan.messages.some(m=>m.id===id&&m.to===participant)&&f.e.some(e=>e.kind==='message_refused'&&e.data.id===id));
      const submitted=f.e.filter(e=>e.kind==='message_send_registered'&&f.plan.messages.find(m=>m.id===e.data.id)?.to===participant).map(e=>e.data.id),claude=f.plan.participants.find(a=>a.id===participant)!.tool==='claude'&&verifiedClaudeMessageIds.length>1&&canonical(verifiedClaudeMessageIds)===canonical(submitted)&&verifiedClaudeMessageIds.every(id=>f.e.some(e=>e.kind==='message_reply'&&e.data.id===id));
      if(!refusal&&!claude)throw new Error('message_closed_capture_changed');
      const value={participant,attempt:runtime.attempt,originalEndedSha256:hash(canonical(old)),originalRefsSha256:hash(canonical(refs)),proof,...(refusal?{verifiedRefusalIds,contract:'exact-original-refusal-v2'}:{verifiedMessageIds:verifiedClaudeMessageIds,contract:'claude-304-per-input-init-v1'})};const prior=f.e.find(e=>e.kind==='message_runtime_revalidated'&&e.data.participant===participant&&e.data.attempt===runtime.attempt);
      if(prior){if(canonical(prior.data)!==canonical(value))throw new Error('message_original_revalidation_changed');return this.view(run);}this.event(run,'runtime_revalidated',value);return this.view(run);
    }
    this.event(run,'runtime_ended',data);return this.view(run);
  });}
  record(run:string,participant:string,p:DialogProof){requireDialogProof(p,run,participant);const f=this.fixed(run);if(p.directory!==this.runtime(f,participant).started?.directory||!f.plan.participants.some(a=>a.id===participant)||p.messageId!==null&&!f.plan.messages.some(m=>m.id===p.messageId&&m.to===participant))throw new Error('message_runtime_role_mismatch');return p.kind==='route'?this.route(run,participant,p.data):p.kind==='ended'?this.ended(run,participant,p.data,p.originals,p.verifiedRefusalIds,p.verifiedClaudeMessageIds):p.kind==='delivered'?this.delivered(run,p.messageId!,p.data):p.kind==='refused'?this.refused(run,p.messageId!,p.data):this.reply(run,p.messageId!,p.data);}
  problem(run:string,id:string|null,reason:string){return this.transaction(()=>{this.fixed(run);this.event(run,'problem',{id,reason:reason.slice(0,512),at:now()});return this.view(run);});}
  private continuationSourceValue(run:string,requireCurrent=true){
    const f=this.fixed(run),s=this.view(run),pending=s.messages.filter(m=>!m.sent),last=s.messages.at(-1)!;
    if(s.messages.length<2||pending.length!==1||pending[0]!.id!==last.id||s.messages.slice(0,-1).some(m=>m.state!=='Reply'||m.reply?.reportedConsumption!==true))throw new Error('continuation_requires_completed_prefix_and_one_unsent_final');
    for(const r of s.runtimes){
      if(!r.started)continue;
      if(!r.started.directory.startsWith(join(this.directory,'messages-'+run)+'/'))throw new Error('copied_queue_cannot_take_original_control');
      if(!r.ended||r.captureVerification?.proof.successfulCapture!==true&&r.ended.proof.knownUnstarted!==true)throw new Error('continuation_original_runtime_active_or_unknown');
    }
    if(requireCurrent)for(const a of f.plan.participants){const before=f.r.bindings[a.id],current=this.item(a.item);if(!current.current||current.packet!==before.packet||current.fingerprint!==before.fingerprint)throw new Error('continuation_original_candidate_or_material_changed');}
    const participant=f.plan.participants.find(a=>a.id===last.to)!;
    const roleInputs=f.e.filter(e=>e.kind==='message_send_registered'&&f.plan.messages.find(m=>m.id===e.data.id)?.to===last.to).map(e=>({messageId:e.data.id,sha256:e.data.inputSha256,text:this.bytes(e.data.inputSha256).toString()}));
    const originalRoute=s.runtimes.find(r=>r.participant===last.to)?.route??null,reports=s.messages.slice(0,-1).map(m=>({messageId:m.id,recipient:m.sent.recipient,receipt:m.reply}));
    const context={schemaVersion:1,kind:'retained-original-message-context',originalRun:run,originalMessage:{id:last.id,body:last.body,to:last.to},originalRecipient:originalRoute,nativeSessionResumed:false,originalBinding:f.r.bindings[last.to],originalRoleInputs:roleInputs,reports,material:Object.entries(f.r.materials).map(([name,ref]:[string,any])=>({name,sha256:ref.sha256,text:this.bytes(ref.sha256).toString()}))};
    return {run,plan:f.plan,pending:last,participant,context,newNativeContextRequired:true,nativeSessionResumed:false};
  }
  continuationSource(run:string){return this.transaction(()=>this.continuationSourceValue(run));}
  partialExecutionProof(run:string){return this.transaction(()=>{const source=this.continuationSourceValue(run,false),m=this.view(run);return {run,executionKind:m.plan.executionKind,pendingMessage:source.pending.id,originalRunCompleted:false,messages:m.messages.slice(0,-1).map(x=>({id:x.id,sessionId:x.reply.sessionId,turnId:x.reply.turnId,inputSha256:x.sent.inputSha256,sentAt:x.sent.registeredAt,finalSha256:x.reply.finalSha256,reportedConsumption:x.reply.reportedConsumption})),captures:m.runtimes.filter(r=>r.started).map(r=>({participant:r.participant,originals:r.ended.originals,proof:r.captureVerification!.proof}))};});}
  private continuationParentValue(run:string){
    const links=this.db.prepare("SELECT object FROM events WHERE kind='message_continuation_selected' AND json_extract(data,'$.value.nextRun')=?").all(run) as Row[];
    if(!links.length)return null;if(links.length!==1)throw new Error('continuation_parent_ambiguous');const parent=links[0]!.object.slice(9),f=this.fixed(parent),selected=f.e.findLast(e=>e.kind==='message_continuation_selected')?.data;if(selected?.nextRun!==run)throw new Error('continuation_selection_superseded');return parent as string;
  }
  continuationParent(run:string){return this.transaction(()=>this.continuationParentValue(run));}
  continuation(run:string){return this.transaction(()=>{
    const f=this.fixed(run),selected=f.e.findLast(e=>e.kind==='message_continuation_selected')?.data;
    if(!selected)return null;
    const request=this.bytes(selected.requestSha256);this.bytes(selected.contextSha256);const plan=this.bytes(selected.planSha256);if(messagePlanId(parseMessagePlan(plan))!==selected.nextRun)throw new Error('continuation_plan_changed');return {...selected,plan,request};
  });}
  selectContinuation(run:string,request:Buffer,context:Buffer,plan:Buffer,directory:string,replaceKnownUnstarted:boolean){return this.transaction(()=>{
    const f=this.fixed(run),prior=f.e.findLast(e=>e.kind==='message_continuation_selected')?.data,parsed=parseMessagePlan(plan),nextRun=messagePlanId(parsed),requestSha256=hash(request);
    if(prior){
      if(prior.requestSha256===requestSha256){if(prior.planSha256!==hash(plan)||prior.contextSha256!==hash(context)||prior.directory!==directory)throw new Error('continuation_original_preparation_changed');return prior;}
      if(!replaceKnownUnstarted)throw new Error('continuation_original_selection_is_fixed');
      const invested=this.db.prepare("SELECT data FROM events WHERE kind='message_resource_bound' AND object=?").get('message-resource:'+prior.nextRun) as Row|undefined;
      const handoff=this.db.prepare("SELECT data FROM events WHERE kind='message_resource_partial_returned' AND object=?").get('message-resource:'+run) as Row|undefined;
      if(invested||handoff){for(const record of [invested,handoff])if(record){const x=JSON.parse(record.data);if(canonical(JSON.parse(this.bytes(x.sha256).toString()))!==canonical(x.value))throw new Error('continuation_original_resource_binding_changed');}
        const old=JSON.parse(this.bytes(prior.requestSha256).toString()),next=JSON.parse(request.toString());delete old.billing;delete next.billing;delete old.replaceKnownUnstarted;delete next.replaceKnownUnstarted;const same=canonical(old)===canonical(next);
        // A settled original prefix is history. It must not permanently pin
        // an unstarted, unclaimed successor to a revoked grant. Any actual
        // successor investment, or unresolved original accounting, stays fixed.
        if(invested||this.resourceResult?.(run)!==true){if(!same)throw new Error('continuation_invested_request_is_fixed');return prior;}if(same)return prior;}
      if(this.events(prior.nextRun).length){const previous=this.view(prior.nextRun);if(previous.messages.some(m=>m.sent)||previous.runtimes.some(r=>r.started&&r.ended?.proof.knownUnstarted!==true))throw new Error('continuation_unknown_or_sent_never_replace');}
      if(prior.attempt>=3)throw new Error('continuation_preparation_attempt_limit');
    }
    if(directory!==join(this.directory,'continuation-'+run,'attempt-'+((prior?.attempt??0)+1)))throw new Error('continuation_original_slot_required');
    const source=this.continuationSourceValue(run),last=source.pending,expectedMessage={id:last.id,from:null,to:last.to,body:continuationMessagePrefix+last.body,replies:[]};
    if(canonical(parsed.resourceBudget??[])!==canonical(f.plan.resourceBudget??[]))throw new Error('continuation_original_resource_budget_changed');
    if(nextRun===run||canonical(JSON.parse(context.toString()))!==canonical(source.context)||canonical(parsed.participants)!==canonical([{...source.participant,parent:null}])||canonical(parsed.messages)!==canonical([expectedMessage])||parsed.executionKind!==f.plan.executionKind||parsed.timeoutMs!==f.plan.timeoutMs||canonical(parsed.consumeMaterial)!==canonical(['retained-context.json'])||canonical(parsed.material)!==canonical([{name:'retained-context.json',path:join(directory,'context.json'),sha256:hash(context)}]))throw new Error('continuation_final_message_changed');
    const value={originalRun:run,originalMessage:f.plan.messages.at(-1)!.id,attempt:(prior?.attempt??0)+1,nextRun,directory,requestSha256:this.blob(request),contextSha256:this.blob(context),planSha256:this.blob(plan),nativeSessionResumed:false,selectedAt:now()};this.event(run,'continuation_selected',value);return value;
  });}
  continuationResult(run:string,nextRun:string,result:Row){return this.transaction(()=>{
    const f=this.fixed(run),selected=f.e.findLast(e=>e.kind==='message_continuation_selected')?.data;if(!selected||selected.nextRun!==nextRun)throw new Error('continuation_selection_changed');
    const actual=this.view(nextRun),complete=actual.messages.length===1&&actual.messages[0]!.state==='Reply'&&actual.messages[0]!.reply?.reportedConsumption===true&&actual.runtimes.filter(r=>r.started).every(r=>r.captureVerification?.proof.successfulCapture===true);
    if(result.completed!==complete||result.run!==nextRun)throw new Error('continuation_actual_result_mismatch');const resourcesSettled=!actual.plan.resourceBudget||this.resourceResult?.(nextRun)===true;
    const value={nextRun,completed:complete&&resourcesSettled,messagesCompleted:complete,resourcesSettled,nativeSessionResumed:false,finalSha256:actual.messages[0]!.reply?.finalSha256??null,originalMessageUnmodified:true},old=f.e.findLast(e=>e.kind==='message_continuation_result');if(!old||canonical(old.data)!==canonical(value))this.event(run,'continuation_result',value);return value;
  });}
  private view(run:string){const f=this.fixed(run);for(const category of ['materials','assemblies'])for(const r of Object.values(f.r[category]) as Row[])if(this.bytes(r.sha256).length!==r.bytes)throw new Error('message_frozen_input_changed');for(const e of f.e.filter(e=>e.kind==='message_runtime_ended'))for(const r of Object.values(e.data.originals) as Row[])if(this.bytes(r.sha256).length!==r.bytes)throw new Error('message_closed_capture_changed');
    const messages=f.plan.messages.map(m=>{const sent=f.e.find(e=>e.kind==='message_send_registered'&&e.data.id===m.id)?.data,delivered=f.e.find(e=>e.kind==='message_delivered'&&e.data.id===m.id)?.data,reply=f.e.find(e=>e.kind==='message_reply'&&e.data.id===m.id)?.data,refused=f.e.find(e=>e.kind==='message_refused'&&e.data.id===m.id)?.data;const invalidCapture=sent&&this.runtime(f,m.to).captureVerification?.proof.successfulCapture===false;return {...m,state:invalidCapture?'Unknown':reply?'Reply':delivered?'Delivered':refused?'Refused':sent?'Unknown':'Held',sent:sent??null,delivery:delivered?.receipt??null,reply:reply?.receipt??null,refusal:refused?.receipt??null};});
    return {run,plan:f.plan,registration:f.r,messages,runtimes:f.plan.participants.map(p=>this.runtime(f,p.id)),status:messages.every(m=>m.state==='Reply')?'replies_recorded':'pending_or_unresolved',problems:f.e.filter(e=>e.kind==='message_problem').map(e=>e.data),continuation:f.e.findLast(e=>e.kind==='message_continuation_result')?.data??f.e.findLast(e=>e.kind==='message_continuation_selected')?.data??null,automaticResend:false,writingPermissionGranted:false,formalJudgmentGranted:false};}
  status(run:string){return this.transaction(()=>this.view(run));}
  frozen(run:string){return this.transaction(()=>{const {r,plan}=this.fixed(run),load=(field:string)=>Object.fromEntries(Object.entries(r[field]).map(([name,v]:[string,any])=>[name,this.bytes(v.sha256)]));return {plan,materials:load('materials'),assemblies:load('assemblies')};});}
  submitted(run:string,participant:string){return this.transaction(()=>{const f=this.fixed(run);return f.e.filter(e=>e.kind==='message_send_registered'&&f.plan.messages.find(m=>m.id===e.data.id)?.to===participant).map(e=>JSON.parse(this.bytes(e.data.inputSha256).toString()));});}
}
