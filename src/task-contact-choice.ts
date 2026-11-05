import {QueueStore} from './queue-store.js';
import {regular} from './repair-workspace.js';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys} from './authority-contract.js';
import {messageId,type MessagePlan} from './message-contract.js';
import {parseTaskOwnerRequest,type TaskOwnerRequest} from './task-inbox.js';
import {prepareTaskOwner,reconcileTaskCoordination,cancelUnsentTaskOwner} from './tasks.js';
import {runMessages} from './messages.js';
import type {MessageNativeHandle} from './message-runtime.js';
import {readOwnerSource} from './authority-source.js';
import {withAIPreferences,type AIPreferenceSnapshot} from './ai-settings.js';
import {implementationOwnerTarget,type ImplementationOwnerTarget,type ImplementationOwnerProof,type OwnerContactReference} from './implementation-owner-feedback.js';
type Row=Record<string,any>;

type Contact={id:string;title:string;request:TaskOwnerRequest;followup:TaskOwnerRequest;originalImplementation?:ImplementationOwnerTarget};
export type TaskContactChoice={schemaVersion:1|2;kind:'tongxu-task-owner-choice';initial:TaskOwnerRequest;contacts:Contact[];authorization?:{coordinate:string}};
const request=(v:unknown)=>parseTaskOwnerRequest(Buffer.from(canonical(v)));
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\x00-\x1f]/.test(v);
export function parseTaskContactChoice(raw:Buffer):TaskContactChoice{
  if(raw.length>256*1024)throw new Error('task_choice_plan_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','initial','contacts',...(p.schemaVersion===2?['authorization']:[])])||![1,2].includes(p.schemaVersion)||p.kind!=='tongxu-task-owner-choice'||!Array.isArray(p.contacts)||!p.contacts.length||p.contacts.length>8||p.schemaVersion===2&&(!exactKeys(p.authorization,['coordinate'])||!(/^[a-f0-9]{64}$/).test(p.authorization.coordinate)))throw new Error('task_choice_plan_invalid');
  const initial=request(p.initial),ids=new Set(),requests=new Set([canonical([initial.task,initial.id])]);if(initial.from!==null||initial.publicationReturn||initial.contactSelection||initial.ownerContact)throw new Error('task_choice_original_request_required');
  for(const c of p.contacts){
    if(!exactKeys(c,['id','title','request','followup',...(c&&Object.hasOwn(c,'originalImplementation')?['originalImplementation']:[])])||!messageId(c.id)||ids.has(c.id)||!text(c.title,160)||c&&Object.hasOwn(c,'originalImplementation')&&(p.schemaVersion!==2||!implementationOwnerTarget(c.originalImplementation)))throw new Error('task_choice_option_invalid');ids.add(c.id);
    const b=request(c.request),a=request(c.followup);
    if(b.from!==null||a.from!==null||b.publicationReturn||a.publicationReturn||b.contactSelection||a.contactSelection||b.ownerContact||a.ownerContact||b.task===initial.task||a.task!==initial.task||canonical(a.participant)!==canonical(initial.participant)||[a,b].some(r=>r.executionKind!==initial.executionKind)||c.originalImplementation&&(c.originalImplementation.task!==b.task||b.nativeResume||a.nativeResume))throw new Error('task_choice_routes_invalid');
    for(const r of [b,a]){const key=canonical([r.task,r.id]);if(requests.has(key))throw new Error('task_choice_request_ids_not_unique');requests.add(key);}
  }
  if(p.schemaVersion===2&&[initial,...p.contacts.flatMap((c:Contact)=>[c.request,c.followup])].some(r=>typeof r.authorityIntent!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).test(r.authorityIntent)))throw new Error('task_choice_coordinate_intents_required');
  // Check the final derived input against the original request/body limits.
  initialContactChoiceRequest(p);return p;
}
export function initialContactChoiceRequest(p:TaskContactChoice):TaskOwnerRequest{
  const planSha256=hash(canonical(p)),options=p.contacts.map(c=>({id:c.id,title:c.title,task:c.request.task,actor:c.request.participant.id,question:c.request.question,...(c.originalImplementation?{originalImplementation:c.originalImplementation,delivery:'queued until the exact original implementation has a proven safe successful end; no competing writer or native resume'}:{})}));
  return request({...p.initial,contactSelection:{planSha256},question:p.initial.question+'\n\nThe operator permits optional contact with one of the fixed options below. Decide from actual task evidence whether a contact is needed. If none is needed, return your normal complete report (including any supplied coordination response contract); the host will not contact anyone. If needed, the outer message receipt stays unchanged, but its report MUST be a JSON string with exactly {"kind":"tongxu-task-contact-request","planSha256":"'+planSha256+'","contactId":"one listed ID","report":"your complete reasoning and question context"}. A contact request is not a final coordination decision. The host fixes the recipient, question, inputs, permissions and resource limits, then returns the complete reply to your original task responsibility. Reports cannot introduce new actions or authority.\n'+canonical({planSha256,options})});
}
function selection(p:TaskContactChoice,report:string){
  let v:any;try{v=JSON.parse(report);}catch{if(report.includes('tongxu-task-contact-request'))throw new Error('task_choice_request_not_structured');return null;}
  if(v?.kind!=='tongxu-task-contact-request'){if(v&&typeof v==='object'&&(Object.hasOwn(v,'contactId')||Object.hasOwn(v,'planSha256')))throw new Error('task_choice_request_invalid');return null;}
  if(!exactKeys(v,['kind','planSha256','contactId','report'])||v.planSha256!==hash(canonical(p))||!messageId(v.contactId)||typeof v.report!=='string'||!v.report.trim())throw new Error('task_choice_request_invalid');
  const selected=p.contacts.find(c=>c.id===v.contactId);if(!selected)throw new Error('task_choice_option_not_allowed');return selected;
}
type Step={task:string;id:string;run:string;completed:boolean;resourcesSettled:boolean;newModelRequests:number;coordination?:unknown};
export type OriginalImplementationContactHost={target(store:string,target:ImplementationOwnerTarget):Promise<unknown>;proof(store:string,target:ImplementationOwnerTarget):Promise<ImplementationOwnerProof>};
export type TaskContactChoiceOptions={beforeStep?:()=>void;onOwnedRuntime?:(request:TaskOwnerRequest,run:string,handle:MessageNativeHandle|null)=>void;originalImplementation?:OriginalImplementationContactHost;readPreferences?:()=>AIPreferenceSnapshot};
export const ownerContactKey=(p:TaskContactChoice,c:Contact)=>hash(canonical([p.initial.task,p.initial.id,hash(canonical(p)),c.id]));
async function reserveCoordinate(store:string,p:TaskContactChoice,r:TaskOwnerRequest,selected:Awaited<ReturnType<typeof prepareTaskOwner>>){
  if(p.schemaVersion!==2)return;
  const q=await QueueStore.open(store);try{
    const a=q.authority(),grant=p.authorization!.coordinate,decision=a.inspectRecordedDecision(grant),{profile}=a.configuration();if(decision.proposal.kind!=='delegate')throw new Error('task_choice_existing_coordinate_delegation_required');
    const observations=[];for(const source of a.sourceRequests(grant))observations.push(await readOwnerSource(profile,source.proposalSha256,source.commentId,join(dirname(selected.plan),'coordinate-source-'+randomUUID())));
    const current=q.tasks().current(r.task),c=current.manifest.candidate,baseline=a.forScope(current.context.scope.id,{item:r.task,target:c.targetRef}),adoption=a.adoptionBaseline(baseline.currentAdoption,observations);
    a.reserveAction(r.authorityIntent!,{schemaVersion:1,scopeId:current.context.scope.id,scopeVersion:current.context.scope.version,scopeBodySha256:adoption.scopeBodySha256,repository:c.repository,target:c.targetRef,action:'coordinate',item:r.task,candidate:{H:c.H,B:c.B,subjectSha256:null},paths:[],resourceRefs:(r.resourceBudget??[]).map(b=>b.resourceRef),payloadSha256:selected.run},'coordinator',grant,observations);
  }finally{q.close();}
}

/** A role chooses only a fixed contact ID. The original inbox and message
 * executor own identities, sends, resources, captures and recovery. */
export async function runTaskContactChoice(store:string,raw:Buffer,currentBilling?:MessagePlan['billing'],options:TaskContactChoiceOptions={}){
  const p=parseTaskContactChoice(raw),initial=initialContactChoiceRequest(p),steps:Step[]=[];
  const run=async(template:TaskOwnerRequest,from:TaskOwnerRequest['from'],beforeNewInput?:()=>Promise<ImplementationOwnerProof>)=>{
    options.beforeStep?.();const r={...template,from},q=await QueueStore.open(store);try{options.beforeStep?.();q.taskInbox().enqueue(Buffer.from(canonical(r)));}finally{q.close();}
    const selected=await (options.readPreferences?withAIPreferences(options.readPreferences(),()=>prepareTaskOwner(store,r.task,r.id)):prepareTaskOwner(store,r.task,r.id));options.beforeStep?.();await reserveCoordinate(store,p,r,selected);
    const result=await runMessages(store,selected.plan,false,selected.run,currentBilling,(_id,handle)=>options.onOwnedRuntime?.(r,selected.run,handle),beforeNewInput),step:Step={task:r.task,id:r.id,run:selected.run,completed:result.completed,resourcesSettled:result.resourcesSettled,newModelRequests:result.newModelRequests};steps.push(step);
    return {result,step,from:{task:r.task,run:selected.run,messageId:r.id}};
  };
  const summary=(completed:boolean,contact:string|null,waiting:string|null)=>({kind:'tongxu-task-contact-choice-result',planSha256:hash(canonical(p)),steps,completed,selectedContact:contact,waiting,newModelRequests:steps.reduce((n,s)=>n+s.newModelRequests,0),workerEnded:true,manualReportCopyRequired:false,ownerApproval:false});
  let chosen:string|null=null;
  try{
    for(const c of p.contacts)if(c.originalImplementation){if(!options.originalImplementation)throw new Error('owner_contact_implementation_consumer_required');await options.originalImplementation.target(store,c.originalImplementation);}
    const a=await run(initial,null);if(!a.result.completed||!a.result.resourcesSettled)return summary(false,null,'original_task_result_or_resources_unresolved');
    const final=await QueueStore.observeMessageReport(store,initial.task,a.step.run,initial.id);
    if(!final.completeCapture||!final.consumptionConfirmed||final.state!=='Reply')throw new Error('task_choice_complete_original_required');
    const contact=selection(p,final.reportText);if(!contact){a.step.coordination=await reconcileTaskCoordination(store,initial.task,initial.id);return summary(true,null,null);}chosen=contact.id;
    let recipient=contact.request,owner:OwnerContactReference|undefined;
    if(contact.originalImplementation){
      owner={task:initial.task,key:ownerContactKey(p,contact)};let q=await QueueStore.open(store),record;try{record=q.taskInbox().deferOwnerContact(initial.task,initial.id,hash(canonical(p)),contact.id,contact.originalImplementation,contact.request,contact.followup,raw);}finally{q.close();}
      if(record.cancelled)return summary(false,chosen,'owner_contact_cancelled');
      if(record.compiled)recipient=record.compiled.request;
      else{const proof=await options.originalImplementation!.proof(store,contact.originalImplementation);q=await QueueStore.open(store);try{recipient=q.taskInbox().bindOwnerContact(initial.task,owner.key,proof);}finally{q.close();}}
    }
    const currentOwner=contact.originalImplementation?()=>options.originalImplementation!.proof(store,contact.originalImplementation!):undefined;
    const b=await run(recipient,a.from,currentOwner);if(!b.result.completed||!b.result.resourcesSettled)return summary(false,chosen,('dispatchBlockedReason' in b.result?b.result.dispatchBlockedReason:null)??'original_contact_result_or_resources_unresolved');
    b.step.coordination=await reconcileTaskCoordination(store,contact.request.task,contact.request.id);
    if(contact.originalImplementation)await options.originalImplementation!.proof(store,contact.originalImplementation);
    const returned=await run({...contact.followup,...(owner?{ownerContact:owner}:{})},b.from,currentOwner);if(returned.result.completed&&returned.result.resourcesSettled)returned.step.coordination=await reconcileTaskCoordination(store,contact.followup.task,contact.followup.id);
    return summary(returned.result.completed&&returned.result.resourcesSettled,chosen,returned.result.completed&&returned.result.resourcesSettled?null:('dispatchBlockedReason' in returned.result?returned.result.dispatchBlockedReason:null)??'original_return_result_or_resources_unresolved');
  }catch(e){return summary(false,chosen,e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'task_choice_original_unavailable');}
}

/** Rebuild a view from the original task entries; no model, file write or new
 * permission is involved. Only the selected contact's historical reports read. */
export async function observeTaskContactChoice(store:string,raw:Buffer,full=false){
  const p=parseTaskContactChoice(raw),initial=initialContactChoiceRequest(p),steps:any[]=[];
  const read=async(r:TaskOwnerRequest,from:TaskOwnerRequest['from'])=>{
    const state=await QueueStore.observe(store,[],[],[r.task]),item=state.items.find((x:any)=>x.id===r.task);if(!item?.developmentTask)throw new Error('task_choice_task_missing');
    const entry=item.developmentTask.inbox.find((x:any)=>x.id===r.id);if(entry&&entry.requestSha256!==hash(canonical({...r,from})))throw new Error('task_choice_original_request_changed');
    let report:any=null;if(entry?.run)try{report=await QueueStore.observeMessageReport(store,r.task,entry.run,r.id);}catch(e){if((e as Error).message!=='report_not_found')throw e;}
    const step={task:r.task,id:r.id,requestSha256:hash(canonical({...r,from})),phase:entry?.phase??'not_registered',run:entry?.run??null,sessionId:entry?.sessionId??null,currentMaterial:entry?.currentMaterial??true,nativeControlHistory:entry?.nativeControls??[],reason:entry?.reason??null,complete:entry?.phase==='returned'&&report?.completeCapture===true&&report?.consumptionConfirmed===true,...(full?{report}:{})};steps.push(step);return {step,report,from:entry?.run?{task:r.task,run:entry.run,messageId:r.id}:null};
  };
  let chosen:Contact|null=null;
  try{const a=await read(initial,null);if(!a.step.complete)return {steps,complete:false,selectedContact:null,waiting:a.step.reason??a.step.phase,modelCallsStartedByThisRead:0};chosen=selection(p,a.report.reportText);
    if(!chosen)return {steps,complete:true,selectedContact:null,waiting:null,modelCallsStartedByThisRead:0};
    let recipient=chosen.request,owner:OwnerContactReference|undefined,ownerView:Row|undefined;
    if(chosen.originalImplementation){
      owner={task:initial.task,key:ownerContactKey(p,chosen)};const value=await QueueStore.observeOwnerContact(store,owner.task,owner.key),record=value.record;
      ownerView={target:chosen.originalImplementation,key:owner.key,cancelled:record?.cancelled??false,bound:!!record?.compiled,...value.applicability,...(full&&record?.compiled?{source:record.compiled.proof.material}:{})};
      if(!record?.compiled||record.cancelled){const reason=record?.cancelled?'owner_contact_cancelled':value.applicability.reason;steps.push({task:recipient.task,id:recipient.id,phase:record?.cancelled?'cancelled':'waiting',run:null,reason,complete:false,deliveryRegistered:false});return {steps,complete:false,selectedContact:chosen.id,waiting:reason,ownerFeedback:ownerView,modelCallsStartedByThisRead:0};}
      recipient=record.compiled.request;
    }
    const b=await read(recipient,a.from);if(!b.step.complete)return {steps,complete:false,selectedContact:chosen.id,waiting:b.step.reason??b.step.phase,...(ownerView?{ownerFeedback:ownerView}:{}),modelCallsStartedByThisRead:0};
    const returned=await read({...chosen.followup,...(owner?{ownerContact:owner}:{})},b.from);return {steps,complete:returned.step.complete,selectedContact:chosen.id,waiting:returned.step.complete?null:returned.step.reason??returned.step.phase,...(ownerView?{ownerFeedback:ownerView}:{}),modelCallsStartedByThisRead:0};
  }catch(e){return {steps,complete:false,selectedContact:chosen?.id??null,waiting:e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'task_choice_original_unavailable',modelCallsStartedByThisRead:0};}
}

/** Cancel only the next proven-unsent segment. Earlier actual B/A captures and
 * claims remain original, including an A reply already returned to the host. */
export async function cancelTaskChoiceOwnerContact(store:string,raw:Buffer,source:string){
  const p=parseTaskContactChoice(raw),view=await observeTaskContactChoice(store,raw),contact=p.contacts.find(c=>c.id===view.selectedContact);if(!contact?.originalImplementation)return null;
  const key=ownerContactKey(p,contact),q=await QueueStore.open(store);let next;try{next=q.taskInbox().ownerContactCancelTarget(p.initial.task,key);}finally{q.close();}
  if(next)await cancelUnsentTaskOwner(store,next.task,next.id,source,next.requestSha256);
  const original=await QueueStore.open(store);try{return original.taskInbox().cancelOwnerContact(p.initial.task,key,source);}finally{original.close();}
}

export async function runTaskContactChoiceFile(store:string,path:string,expectedSha256?:string,currentBilling?:MessagePlan['billing'],options?:TaskContactChoiceOptions){const raw=await regular(path,256*1024);if(expectedSha256!==undefined&&hash(raw)!==expectedSha256)throw new Error('task_choice_selected_plan_changed');return runTaskContactChoice(store,raw,currentBilling,options);}
