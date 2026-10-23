import {QueueStore} from './queue-store.js';
import {regular} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys} from './authority-contract.js';
import {messageId,type MessagePlan} from './message-contract.js';
import {parseTaskOwnerRequest,type TaskOwnerRequest} from './task-inbox.js';
import {prepareTaskOwner,reconcileTaskCoordination} from './tasks.js';
import {runMessages} from './messages.js';
import type {MessageNativeHandle} from './message-runtime.js';

type Contact={id:string;title:string;request:TaskOwnerRequest;followup:TaskOwnerRequest};
export type TaskContactChoice={schemaVersion:1;kind:'tongxu-task-owner-choice';initial:TaskOwnerRequest;contacts:Contact[]};
const request=(v:unknown)=>parseTaskOwnerRequest(Buffer.from(canonical(v)));
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\x00-\x1f]/.test(v);
export function parseTaskContactChoice(raw:Buffer):TaskContactChoice{
  if(raw.length>256*1024)throw new Error('task_choice_plan_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','initial','contacts'])||p.schemaVersion!==1||p.kind!=='tongxu-task-owner-choice'||!Array.isArray(p.contacts)||!p.contacts.length||p.contacts.length>8)throw new Error('task_choice_plan_invalid');
  const initial=request(p.initial),ids=new Set(),requests=new Set([canonical([initial.task,initial.id])]);if(initial.from!==null||initial.publicationReturn||initial.contactSelection)throw new Error('task_choice_original_request_required');
  for(const c of p.contacts){
    if(!exactKeys(c,['id','title','request','followup'])||!messageId(c.id)||ids.has(c.id)||!text(c.title,160))throw new Error('task_choice_option_invalid');ids.add(c.id);
    const b=request(c.request),a=request(c.followup);
    if(b.from!==null||a.from!==null||b.publicationReturn||a.publicationReturn||b.contactSelection||a.contactSelection||b.task===initial.task||a.task!==initial.task||canonical(a.participant)!==canonical(initial.participant)||[a,b].some(r=>r.executionKind!==initial.executionKind))throw new Error('task_choice_routes_invalid');
    for(const r of [b,a]){const key=canonical([r.task,r.id]);if(requests.has(key))throw new Error('task_choice_request_ids_not_unique');requests.add(key);}
  }
  // Check the final derived input against the original request/body limits.
  initialContactChoiceRequest(p);return p;
}
export function initialContactChoiceRequest(p:TaskContactChoice):TaskOwnerRequest{
  const planSha256=hash(canonical(p)),options=p.contacts.map(c=>({id:c.id,title:c.title,task:c.request.task,actor:c.request.participant.id,question:c.request.question}));
  return request({...p.initial,contactSelection:{planSha256},question:p.initial.question+'\n\nThe operator permits optional contact with one of the fixed options below. Decide from actual task evidence whether a contact is needed. If none is needed, return your normal complete report (including any supplied coordination response contract); the host will not contact anyone. If needed, the outer message receipt stays unchanged, but its report MUST be a JSON string with exactly {"kind":"tongxu-task-contact-request","planSha256":"'+planSha256+'","contactId":"one listed ID","report":"your complete reasoning and question context"}. A contact request is not a final coordination decision. The host fixes the recipient, question, inputs, permissions and resource limits, then returns the complete reply to your original task responsibility. Reports cannot introduce new actions or authority.\n'+canonical({planSha256,options})});
}
function selection(p:TaskContactChoice,report:string){
  let v:any;try{v=JSON.parse(report);}catch{if(report.includes('tongxu-task-contact-request'))throw new Error('task_choice_request_not_structured');return null;}
  if(v?.kind!=='tongxu-task-contact-request'){if(v&&typeof v==='object'&&(Object.hasOwn(v,'contactId')||Object.hasOwn(v,'planSha256')))throw new Error('task_choice_request_invalid');return null;}
  if(!exactKeys(v,['kind','planSha256','contactId','report'])||v.planSha256!==hash(canonical(p))||!messageId(v.contactId)||typeof v.report!=='string'||!v.report.trim())throw new Error('task_choice_request_invalid');
  const selected=p.contacts.find(c=>c.id===v.contactId);if(!selected)throw new Error('task_choice_option_not_allowed');return selected;
}
type Step={task:string;id:string;run:string;completed:boolean;resourcesSettled:boolean;newModelRequests:number;coordination?:unknown};
export type TaskContactChoiceOptions={beforeStep?:()=>void;onOwnedRuntime?:(request:TaskOwnerRequest,run:string,handle:MessageNativeHandle|null)=>void};

/** A role chooses only a fixed contact ID. The original inbox and message
 * executor own identities, sends, resources, captures and recovery. */
export async function runTaskContactChoice(store:string,raw:Buffer,currentBilling?:MessagePlan['billing'],options:TaskContactChoiceOptions={}){
  const p=parseTaskContactChoice(raw),initial=initialContactChoiceRequest(p),steps:Step[]=[];
  const run=async(template:TaskOwnerRequest,from:TaskOwnerRequest['from'])=>{
    options.beforeStep?.();const r={...template,from},q=await QueueStore.open(store);try{options.beforeStep?.();q.taskInbox().enqueue(Buffer.from(canonical(r)));}finally{q.close();}
    const selected=await prepareTaskOwner(store,r.task,r.id);options.beforeStep?.();
    const result=await runMessages(store,selected.plan,false,selected.run,currentBilling,(_id,handle)=>options.onOwnedRuntime?.(r,selected.run,handle)),step:Step={task:r.task,id:r.id,run:selected.run,completed:result.completed,resourcesSettled:result.resourcesSettled,newModelRequests:result.newModelRequests};steps.push(step);
    return {result,step,from:{task:r.task,run:selected.run,messageId:r.id}};
  };
  const summary=(completed:boolean,contact:string|null,waiting:string|null)=>({kind:'tongxu-task-contact-choice-result',planSha256:hash(canonical(p)),steps,completed,selectedContact:contact,waiting,newModelRequests:steps.reduce((n,s)=>n+s.newModelRequests,0),workerEnded:true,manualReportCopyRequired:false,ownerApproval:false});
  let chosen:string|null=null;
  try{
    const a=await run(initial,null);if(!a.result.completed||!a.result.resourcesSettled)return summary(false,null,'original_task_result_or_resources_unresolved');
    const final=await QueueStore.observeMessageReport(store,initial.task,a.step.run,initial.id);
    if(!final.completeCapture||!final.consumptionConfirmed||final.state!=='Reply')throw new Error('task_choice_complete_original_required');
    const contact=selection(p,final.reportText);if(!contact){a.step.coordination=await reconcileTaskCoordination(store,initial.task,initial.id);return summary(true,null,null);}chosen=contact.id;
    const b=await run(contact.request,a.from);if(!b.result.completed||!b.result.resourcesSettled)return summary(false,chosen,'original_contact_result_or_resources_unresolved');
    b.step.coordination=await reconcileTaskCoordination(store,contact.request.task,contact.request.id);
    const returned=await run(contact.followup,b.from);if(returned.result.completed&&returned.result.resourcesSettled)returned.step.coordination=await reconcileTaskCoordination(store,contact.followup.task,contact.followup.id);
    return summary(returned.result.completed&&returned.result.resourcesSettled,chosen,returned.result.completed&&returned.result.resourcesSettled?null:'original_return_result_or_resources_unresolved');
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
    const b=await read(chosen.request,a.from);if(!b.step.complete)return {steps,complete:false,selectedContact:chosen.id,waiting:b.step.reason??b.step.phase,modelCallsStartedByThisRead:0};
    const returned=await read(chosen.followup,b.from);return {steps,complete:returned.step.complete,selectedContact:chosen.id,waiting:returned.step.complete?null:returned.step.reason??returned.step.phase,modelCallsStartedByThisRead:0};
  }catch(e){return {steps,complete:false,selectedContact:chosen?.id??null,waiting:e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'task_choice_original_unavailable',modelCallsStartedByThisRead:0};}
}

export async function runTaskContactChoiceFile(store:string,path:string,expectedSha256?:string,currentBilling?:MessagePlan['billing'],options?:TaskContactChoiceOptions){const raw=await regular(path,256*1024);if(expectedSha256!==undefined&&hash(raw)!==expectedSha256)throw new Error('task_choice_selected_plan_changed');return runTaskContactChoice(store,raw,currentBilling,options);}
