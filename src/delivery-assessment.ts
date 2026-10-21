import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {regular,exists} from './repair-workspace.js';
import {privateDirectory} from './snapshot.js';
import {parseAssessmentRequest,assessmentRequestSha} from './delivery-assessment-contract.js';
import {runMessages} from './messages.js';
import type {MessagePlan} from './message-contract.js';
import {canonical} from './comparison.js';

async function directory(path:string){if(await exists(path))await privateDirectory(path,false);else await privateDirectory(path,true);}
async function immutable(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,1024*1024)).equals(bytes))throw new Error('delivery_assessment_preparation_changed');}}
export async function runDeliveryAssessment(store:string,requestPath:string,action:'run'|'prepare'|'reconcile'|'close-unstarted'='run',currentBilling?:MessagePlan['billing']){
  const raw=await regular(requestPath,128*1024),p=parseAssessmentRequest(raw),root=join(store,'delivery-assessment-'+assessmentRequestSha(p)),q=await QueueStore.open(store);let lock:DatabaseSync|undefined;
  try{
    await directory(root);const path=join(root,'controller.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await regular(path);lock=new DatabaseSync(path);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('delivery_assessment_controller_active');}
    const records=q.deliveryAssessments();let state:ReturnType<typeof records.state>|undefined;try{state=records.state(p.id);}catch(e){if(!(e instanceof Error)||e.message!=='delivery_assessment_not_prepared')throw e;}if(state&&state.requestSha256!==assessmentRequestSha(p))throw new Error('delivery_assessment_request_id_changed');
    if(state&&['recorded','returned_invalid','closed_unstarted'].includes(state.phase)){if(action==='prepare')records.prepare(raw);return {...state,newModelRequests:0,duplicate:true};}
    if(!state){if(action==='reconcile'||action==='close-unstarted')return {id:p.id,phase:'not_prepared',newModelRequests:0,userOutcomeAccepted:false};records.prepare(raw);}else if(action==='prepare')records.prepare(raw);
    const fixed=records.files(p.id);if(fixed.directory!==root){if(action==='reconcile')return {...records.consume(p.id),newModelRequests:0,recovery:'original_workspace_required_for_further_execution'};throw new Error('delivery_assessment_original_workspace_required');}await immutable(join(root,'request.json'),fixed.request);await immutable(join(root,'plan.json'),fixed.plan);for(const m of fixed.material)await immutable(join(root,m.name),m.bytes);
    if(action==='close-unstarted')return {...records.closeUnstarted(p.id),newModelRequests:0};
    if(action==='prepare')return {...records.state(p.id),planPath:join(root,'plan.json'),newModelRequests:0};
    if(action==='reconcile'&&records.state(p.id).phase==='prepared_not_started')return {...records.state(p.id),knownNotStarted:true,newModelRequests:0};
    // runMessages owns the exact native session and captures. It never resends
    // an original submitted input, even if this higher-level consumer crashed.
    const result=await runMessages(store,join(root,'plan.json'),action==='reconcile',fixed.run,currentBilling),consumed=records.consume(p.id);return {...consumed,newModelRequests:result.newModelRequests,originalMessageRun:fixed.run,messageCompleted:result.completed};
  }catch(e){const reason=e instanceof Error&&/^[a-z0-9_]{1,160}$/.test(e.message)?e.message:'delivery_assessment_failed';try{const records=q.deliveryAssessments();if(records.state(p.id).requestSha256===assessmentRequestSha(p))records.problem(p.id,reason);}catch{}try{const id=randomUUID();await writeFile(join(root,'failure-'+id+'.json'),canonical({reason,requestSha256:assessmentRequestSha(p),automaticResend:false,observedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});await writeFile(join(root,'failed-request-'+id+'.json'),raw,{flag:'wx',mode:0o600});}catch{}throw e;}
  finally{if(lock?.isTransaction)lock.exec('ROLLBACK');lock?.close();q.close();}
}
