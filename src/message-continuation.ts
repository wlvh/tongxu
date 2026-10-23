import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exactKeys } from './authority-contract.js';
import { canonical } from './comparison.js';
import { hash,privateDirectory } from './snapshot.js';
import { regular } from './repair-workspace.js';
import { QueueStore } from './queue-store.js';
import { runMessages } from './messages.js';
import {settlePartialMessageResources} from './message-resources.js';
import { checkMessageBilling,continuationMessagePrefix,messageId,messagePlanId,parseMessagePlan,type MessagePlan } from './message-contract.js';

export type ContinuationRequest={schemaVersion:1;kind:'tongxu-complete-unsent-message';source:string;allowNewContext:true;authorityIntent:string|null;billing:MessagePlan['billing'];replaceKnownUnstarted:boolean};
export function parseContinuationRequest(raw:Buffer):ContinuationRequest{
  if(raw.length>128*1024)throw new Error('continuation_request_limit');
  const r=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(r,['schemaVersion','kind','source','allowNewContext','authorityIntent','billing','replaceKnownUnstarted'])||r.schemaVersion!==1||r.kind!=='tongxu-complete-unsent-message'||typeof r.source!=='string'||!r.source.trim()||r.source.length>1024||r.allowNewContext!==true||!(r.authorityIntent===null||messageId(r.authorityIntent))||typeof r.replaceKnownUnstarted!=='boolean')throw new Error('continuation_request_invalid');
  checkMessageBilling(r.billing);return r;
}
async function directory(path:string){try{await privateDirectory(path,true);}catch(e:any){if(e.code!=='EEXIST')throw e;await privateDirectory(path,false);}}
async function immutable(path:string,bytes:Buffer){
  try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}
  if(!(await regular(path,512*1024)).equals(bytes))throw new Error('continuation_preparation_file_changed');
}
/** The original run has one continuation slot. A new native context can only
 * complete its final never-submitted message; old tasks are never resubmitted. */
export async function continueMessage(store:string,originalPlanPath:string,requestPath:string,prepareOnly=false){
  const original=parseMessagePlan(await regular(originalPlanPath,256*1024)),run=messagePlanId(original),request=parseContinuationRequest(await regular(requestPath,128*1024)),requestBytes=Buffer.from(canonical(request));
  const slot=join(store,'continuation-'+run);await privateDirectory(store,false);await directory(slot);
  const lockPath=join(slot,'controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(lockPath,4*1024*1024);
  const lock=new DatabaseSync(lockPath);let locked=false,q:QueueStore|undefined;
  try{
    try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');locked=true;}catch{throw new Error('continuation_controller_active');}
    const recovered=await runMessages(store,originalPlanPath,true,run);
    if('recoveryErrors' in recovered&&recovered.recoveryErrors.length)throw new Error('continuation_original_capture_unresolved');
    q=await QueueStore.open(store);const records=q.messages(),source=records.continuationSource(run),prior=records.continuation(run);
    let selected=prior;
    if(!prior||prior.requestSha256!==hash(requestBytes)){
      // selectContinuation rechecks the same source and the previous attempt
      // in the queue transaction. Preparation never grants model permission.
      const attempt=(prior?.attempt??0)+1,path=join(slot,'attempt-'+attempt),context=Buffer.from(canonical(source.context));
      if(context.length>512*1024)throw new Error('continuation_complete_context_too_large');
      const plan:MessagePlan={schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:original.executionKind,source:request.source+'; explicit new context for original '+run,authorityIntent:request.authorityIntent,participants:[{...source.participant,parent:null}],messages:[{id:source.pending.id,from:null,to:source.pending.to,body:continuationMessagePrefix+source.pending.body,replies:[]}],material:[{name:'retained-context.json',path:join(path,'context.json'),sha256:hash(context)}],consumeMaterial:['retained-context.json'],timeoutMs:original.timeoutMs,billing:request.billing};
      if(original.resourceBudget)plan.resourceBudget=original.resourceBudget;
      const planBytes=Buffer.from(canonical(plan));parseMessagePlan(planBytes);
      // Reserve first, so rejected replacements cannot create new path-based
      // opportunities. The immutable blobs recover an interrupted preparation.
      selected=records.selectContinuation(run,requestBytes,context,planBytes,path,request.replaceKnownUnstarted);
    }
    const fixed=records.continuation(run)!;if(fixed.nextRun!==selected!.nextRun)throw new Error('continuation_selection_changed');
    const path=fixed.directory;await directory(path);
    const context=Buffer.from(canonical(source.context));if(hash(context)!==fixed.contextSha256)throw new Error('continuation_original_context_changed');
    await immutable(join(path,'context.json'),context);await immutable(join(path,'plan.json'),fixed.plan);await immutable(join(path,'request.json'),fixed.request);
    const preparation={originalRun:run,nextRun:fixed.nextRun,originalMessage:fixed.originalMessage,attempt:fixed.attempt,directory:path,planPath:join(path,'plan.json'),contextSha256:fixed.contextSha256,nativeSessionResumed:false,newNativeContextRequired:true,originalMessageUnmodified:true};
    if(prepareOnly)return {...preparation,prepared:true,newModelRequests:0};
    const originalResources=await settlePartialMessageResources(q,run,fixed.nextRun,original);
    const result=await runMessages(store,preparation.planPath,false,fixed.nextRun,request.replaceKnownUnstarted?request.billing:undefined);const link=records.continuationResult(run,fixed.nextRun,result);
    return {...preparation,prepared:true,completed:link.completed,newModelRequests:result.newModelRequests,originalRunCompleted:false,originalResources,result};
  }finally{q?.close();if(locked)lock.exec('ROLLBACK');lock.close();}
}
