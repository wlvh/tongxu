import { join,dirname } from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { MessageRecords } from './message-store.js';
import { QueueStore } from './queue-store.js';
import { regular,exists } from './repair-workspace.js';
import { hash,privateDirectory } from './snapshot.js';
import { canonical } from './comparison.js';
import { parseMessagePlan,messagePlanId,checkMessageBilling,type MessagePlan } from './message-contract.js';
import { assembleRolePrompt } from './role-prompts.js';
import { messagePolicy,ReadonlyDialog,OwnedReadonlyDialog,inspectDialogCapture,inspectUnstartedDialog,type RuntimeSpec,type MessageNativeHandle } from './message-runtime.js';
import { readOwnerSource,type OwnerObservation } from './authority-source.js';
import {prepareMessageResources,refreshMessageResources,completeMessageResources,cancelUnstartedMessageResources,messageResourcesSettled} from './message-resources.js';
type Row=Record<string,any>;
async function ensurePrivate(path:string){try{await privateDirectory(path,true);}catch(e:any){if(e.code!=='EEXIST')throw e;await privateDirectory(path,false);}}
async function observations(q:QueueStore,p:MessagePlan,directory:string):Promise<OwnerObservation[]>{
  if(p.authorityIntent===null)return [];
  const a=q.authority(),intent=a.reservedAction(p.authorityIntent),{profile}=a.configuration(),all=[];
  for(const source of a.sourceRequests(intent.authorization))all.push(await readOwnerSource(profile,source.proposalSha256,source.commentId,join(directory,'owner-read-'+randomUUID())));return all;
}
async function billing(p:MessagePlan,current?:MessagePlan['billing']){const proof=current??p.billing;checkMessageBilling(proof);const b=await regular(proof.evidence,128*1024),age=Date.now()-Date.parse(proof.observedAt);if(hash(b)!==proof.evidenceSha256||age< -60000||age>1800000)throw new Error('message_current_billing_evidence_required');return proof;}
function completed(state:Row){return state.messages.every((m:Row)=>m.state==='Reply'&&m.reply.reportedConsumption)&&state.runtimes.filter((r:Row)=>r.started).every((r:Row)=>r.captureVerification?.proof.successfulCapture===true);}
function nativeSpec(p:MessagePlan,participant:string){const controls=p.nativeControls?.filter(c=>p.messages.find(m=>m.id===c.messageId)?.to===participant);return controls?.length?{nativeControls:controls}:{};}
async function replay(q:QueueStore,run:string,directory:string){
  const r=q.messages(),s=r.status(run),frozen=r.frozen(run),errors:string[]=[];for(const runtime of s.runtimes){if(!runtime.started)continue;const p=runtime.started.directory;try{
    const participant=s.plan.participants.find(a=>a.id===runtime.participant)!;const spec:RuntimeSpec={run,participant,executionKind:s.plan.executionKind,directory:p,assembly:JSON.parse(frozen.assemblies[participant.id]!.toString()),binding:s.registration.bindings[participant.id],timeoutMs:s.plan.timeoutMs,...nativeSpec(s.plan,participant.id),...(s.plan.nativeResume?{nativeResume:r.nativeResumeSource(run)}:{})};
    // Ended capture checks do not interrogate today's executable or credentials.
    if(runtime.ended?.proof.knownUnstarted){r.record(run,runtime.participant,await inspectUnstartedDialog(spec));continue;}
    const result=await inspectDialogCapture(spec,r.submitted(run,runtime.participant),r.nativeControlRequests(run,runtime.participant));for(const proof of result.proofs)r.record(run,runtime.participant,proof);r.record(run,runtime.participant,result.ended);if(result.error){errors.push(result.error);r.problem(run,null,result.error);}
  }catch(e){const reason=e instanceof Error?e.message:'message_original_unavailable';errors.push(reason);r.problem(run,null,reason);}}
  const state=r.status(run);return {...state,directory,completed:errors.length===0&&completed(state),recoveryErrors:errors,newModelRequests:0,recovery:'original_captures_only'};
}
/** One finite program entry; no daemon and no access to arbitrary App chats. */
export async function runMessages(store:string,planPath:string,recoverOnly:boolean|'cancel-unstarted'=false,expectedRun?:string,currentBilling?:MessagePlan['billing'],onOwnedRuntime?:(participant:string,handle:MessageNativeHandle|null)=>void){
  const raw=await regular(planPath,256*1024),p=parseMessagePlan(raw),run=messagePlanId(p);
  // The caller may have selected a frozen operation before handing us a path.
  // Compare before opening the queue or creating/starting any runtime, and use
  // this exact parsed object throughout the execution (no later plan reread).
  if(expectedRun!==undefined&&run!==expectedRun)throw new Error('message_selected_plan_changed');
  const q=await QueueStore.open(store),directory=join(store,'messages-'+run);let lock:DatabaseSync|undefined,parentLock:DatabaseSync|undefined;
  try{
    await ensurePrivate(directory);
    const lockPath=join(directory,'controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(lockPath,4*1024*1024);lock=new DatabaseSync(lockPath);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{lock.close();lock=undefined;throw new Error('message_controller_active');}
    const records=q.messages();let previous:ReturnType<MessageRecords['status']>|null=null;try{previous=records.status(run);}catch(e){if(!(e instanceof Error)||e.message!=='original_message_run_required')throw e;}
    const continuation=records.continuationParent(run);if(continuation&&p.nativeResume)throw new Error('native_resume_and_new_context_cannot_mix');const parent=continuation??p.nativeResume?.run;
    if(parent){const path=join(store,'messages-'+parent,'controller.sqlite');await regular(path,4*1024*1024);parentLock=new DatabaseSync(path);try{parentLock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{parentLock.close();parentLock=undefined;throw new Error('continuation_original_controller_active');}}
    const checkParent=async()=>{if(parent){const recovered=await replay(q,parent,join(store,'messages-'+parent));if(recovered.recoveryErrors.length)throw new Error('continuation_original_capture_unresolved');if(p.nativeResume){if(canonical(records.nativeResumeReference(parent,p.nativeResume.participant,p.nativeResume.messageId))!==canonical(p.nativeResume))throw new Error('native_resume_scope_or_capture_changed');}else records.continuationSource(parent);}};
    if(recoverOnly==='cancel-unstarted'){
      if(!previous)throw new Error('original_message_run_required');const recovered=await replay(q,run,directory);if(recovered.recoveryErrors.length)throw new Error('message_original_capture_unresolved');
      const resources=await cancelUnstartedMessageResources(q,run,p);return {...recovered,resources,resourcesSettled:messageResourcesSettled(q,run,p),cancellationRequested:true};
    }
    if(previous?.runtimes.some((r:Row)=>r.started)){
      const recovered=await replay(q,run,directory);
      // No recipient of a dispatched message may change. A bootstrap with
      // zero submitted messages is different: after verified termination a
      // new caller entry can retry it at most three times, retaining attempts.
      if(recoverOnly||recovered.recoveryErrors.length||recovered.messages.some(m=>m.sent)||recovered.runtimes.some(r=>r.started&&!r.ended)){const resources=recoverOnly?[]:await completeMessageResources(q,run,p,recovered.completed);return {...recovered,resources,resourcesSettled:messageResourcesSettled(q,run,p)};}
    }
    if(recoverOnly){if(!previous)throw new Error('original_message_run_required');return {...previous,directory,completed:false,newModelRequests:0,resources:[],resourcesSettled:messageResourcesSettled(q,run,p)};}
    const materials:Record<string,Buffer>={},assemblies:Record<string,Buffer>={},promptObjects:Record<string,Awaited<ReturnType<typeof assembleRolePrompt>>>={};
    for(const m of p.material){const b=await regular(m.path,512*1024);if(hash(b)!==m.sha256)throw new Error('message_material_changed');new TextDecoder('utf8',{fatal:true}).decode(b);materials[m.name]=b;}
    for(const a of p.participants){const assembly=await assembleRolePrompt(a.role,messagePolicy);promptObjects[a.id]=assembly;assemblies[a.id]=Buffer.from(canonical(assembly));}
    records.register(raw,materials,assemblies);const frozen=records.frozen(run);if(canonical(Object.fromEntries(Object.entries(frozen.assemblies).map(([n,b])=>[n,hash(b)])))!==canonical(Object.fromEntries(Object.entries(assemblies).map(([n,b])=>[n,hash(b)]))))throw new Error('message_frozen_role_prompt_changed');
    const runtimes=new Map<string,ReadonlyDialog|OwnedReadonlyDialog>(),specs=new Map<string,RuntimeSpec>(),turnObservations=new Map<string,OwnerObservation[]>(),turnSourceChecks=new Map<string,()=>void>();let sent=0,activeMessage:string|null=null;
    try{
      await q.refreshMessageTaskSources(run);await checkParent();records.observeBilling(run,await billing(p,currentBilling));await prepareMessageResources(q,run,p,await observations(q,p,directory));
      for(const m of p.messages){activeMessage=m.id;await q.refreshMessageTaskSources(run);await checkParent();records.observeBilling(run,await billing(p,currentBilling));await refreshMessageResources(q,run,p);records.check(run,await observations(q,p,directory),m.id);
        const participant=p.participants.find(a=>a.id===m.to)!;
        if(!runtimes.has(m.to)){
          await ensurePrivate(join(directory,'runtimes'));await ensurePrivate(join(directory,'runtimes',hash(m.to)));
          await refreshMessageResources(q,run,p);const state=records.startRuntime(run,m.to,await observations(q,p,directory)),spec:RuntimeSpec={run,participant,executionKind:p.executionKind,directory:state.runtimes.find(r=>r.participant===m.to)!.started.directory,assembly:promptObjects[m.to]!,binding:state.registration.bindings[m.to],timeoutMs:p.timeoutMs,...nativeSpec(p,m.to),...(p.nativeResume?{nativeResume:records.nativeResumeSource(run)}:{})};await ensurePrivate(dirname(spec.directory));specs.set(m.to,spec);
          const controlObservations=new Map<string,OwnerObservation[]>(),controlSourceChecks=new Map<string,()=>void>(),runtime=spec.nativeControls?await OwnedReadonlyDialog.open(spec,{
            beforeTurnSendSync:()=>{const check=turnSourceChecks.get(participant.id);if(!check)throw new Error('message_task_source_check_required');check();records.check(run,turnObservations.get(participant.id)??[],activeMessage??undefined);},
            control:{beforeControl:async request=>{
              if(request.action==='interrupt'){controlObservations.set(request.id,[]);return;}
              await checkParent();records.observeBilling(run,await billing(p,currentBilling));await refreshMessageResources(q,run,p);controlObservations.set(request.id,await observations(q,p,directory));controlSourceChecks.set(request.id,await q.refreshMessageTaskSources(run));
            },beforeControlSendSync:(request,send)=>{const observed=controlObservations.get(request.id),check=controlSourceChecks.get(request.id);if(!observed||request.action==='steer'&&!check)throw new Error('message_native_control_observation_required');if(request.action==='steer')check!();records.nativeControlIntent(run,participant.id,request,observed);records.nativeControlSend(run,participant.id,request,observed,send,request.action==='steer'?check:undefined);}}
          }):await ReadonlyDialog.open(spec);runtimes.set(m.to,runtime);records.record(run,m.to,runtime.address());
          if(runtime instanceof OwnedReadonlyDialog){const handle=runtime.handle();onOwnedRuntime?.(participant.id,{...handle,control:async(option,expected)=>{const result=await handle.control(option,expected);records.record(run,participant.id,result);return result;}});}
        }
        const state=records.status(run),runtime=runtimes.get(m.to)!,upstream=m.replies.map(id=>{const result=state.messages.find((x:Row)=>x.id===id);if(result?.state!=='Reply'||!result.reply?.reportedConsumption)throw new Error('message_upstream_incomplete_or_not_consumed');return {messageId:id,to:state.runtimes.find((r:Row)=>r.participant===result.to)!.route,receipt:result.reply};});
        const sender=m.from===null?null:state.runtimes.find((r:Row)=>r.participant===m.from)?.route;if(m.from!==null&&!sender)throw new Error('message_sender_route_missing');
        const materialConsumption=(p.consumeMaterial??[]).map(name=>({name,sha256:hash(frozen.materials[name]!)})),references=[...upstream.map(x=>x.receipt.finalSha256),...materialConsumption.map(m=>m.sha256)];
        const envelope={schemaVersion:1,kind:'tongxu-addressed-role-message',run,messageId:m.id,origin:m.from===null?'operator_fixed_plan':'program_forwarding_original_role_reply',from:sender,to:runtime.route,body:m.body,binding:state.registration.bindings[m.to],material:Object.entries(frozen.materials).map(([name,b])=>({name,sha256:hash(b),text:b.toString()})),upstream,replyReferences:references,...(materialConsumption.length?{materialConsumptionReferences:materialConsumption}:{}),responseContract:{messageId:m.id,consumed:references,report:'complete substantive report; full raw final also saved'},permissions:{tools:[],write:false,publish:false,merge:false,formalJudgment:false}};
        const final=await runtime.send(envelope,async()=>{await checkParent();records.observeBilling(run,await billing(p,currentBilling));await refreshMessageResources(q,run,p);const observed=await observations(q,p,directory),check=await q.refreshMessageTaskSources(run);turnObservations.set(participant.id,observed);turnSourceChecks.set(participant.id,check);check();records.intent(run,m.id,Buffer.from(canonical(envelope)),observed);sent++;},proof=>records.record(run,m.to,proof),()=>{const check=turnSourceChecks.get(participant.id);if(!check)throw new Error('message_task_source_check_required');check();records.check(run,turnObservations.get(participant.id)??[],m.id);});records.record(run,m.to,final);
        if(!final.data.reportedConsumption)throw new Error('message_reply_did_not_confirm_input_consumption');
      }
    }catch(e){records.problem(run,activeMessage,e instanceof Error?e.message:'message_delivery_unknown');}
    finally{
      // All children created by this entry are awaited, including ordinary
      // failures. An ended process does not erase an unknown message.
      for(const [id,runtime] of runtimes){onOwnedRuntime?.(id,null);try{await runtime.close();const submitted=records.submitted(run,id);if(!submitted.length){records.record(run,id,await inspectUnstartedDialog(specs.get(id)!));continue;}const inspected=await inspectDialogCapture(specs.get(id)!,submitted,records.nativeControlRequests(run,id));for(const proof of inspected.proofs)records.record(run,id,proof);records.record(run,id,inspected.ended);if(inspected.error)records.problem(run,null,inspected.error);}catch(e){records.problem(run,null,e instanceof Error?e.message:'message_capture_unresolved');}}
      for(const [id,spec] of specs)if(!runtimes.has(id)){try{records.record(run,id,await inspectUnstartedDialog(spec));}catch(e){records.problem(run,null,e instanceof Error?e.message:'message_bootstrap_unknown');}}
    }
    const result=records.status(run),resources=await completeMessageResources(q,run,p,completed(result));return {...result,completed:completed(result),newModelRequests:sent,directory,resources,resourcesSettled:messageResourcesSettled(q,run,p)};
  }finally{if(parentLock){parentLock.exec('ROLLBACK');parentLock.close();}if(lock){lock.exec('ROLLBACK');lock.close();}q.close();}
}
