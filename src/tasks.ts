import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {QueueStore} from './queue-store.js';
import {parseDevelopmentTask} from './task-contract.js';
import {observeTaskWorkspace} from './task-source.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {runMessages} from './messages.js';
import type {MessagePlan} from './message-contract.js';
import {parseTaskOwnerRequest,type TaskOwnerRequest} from './task-inbox.js';
import {exactKeys} from './authority-contract.js';
import {canonical} from './comparison.js';

export async function addDevelopmentTask(store:string,definitionPath:string){const p=parseDevelopmentTask(await regular(definitionPath,64*1024)),o=await observeTaskWorkspace(p),q=await QueueStore.open(store);try{return q.tasks().observe(p,o);}finally{q.close();}}
async function exactFile(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(hash(await regular(path,512*1024))!==hash(bytes))throw new Error('task_prepared_file_changed');}}
export async function prepareTaskOwner(store:string,task:string,id:string){
  const q=await QueueStore.open(store);try{const selected=q.taskInbox().prepare(task,id);await mkdir(selected.directory,{recursive:true,mode:0o700});await exactFile(join(selected.directory,'context.json'),selected.context);const path=join(selected.directory,'plan.json');await exactFile(path,selected.plan);return {id,run:selected.run,plan:path,contextSha256:selected.contextSha256};}finally{q.close();}
}
/** One finite entry drains the responsibility's existing queue, including
 * requests arriving during a preceding turn. Every send uses the original
 * message, authority and resource consumers. There is no detached worker. */
export async function workTaskOwner(store:string,task:string,limit=4,currentBilling?:MessagePlan['billing']){
  if(!Number.isInteger(limit)||limit<1||limit>8)throw new Error('task_worker_limit');const runs=[];
  for(let n=0;n<limit;n++){
    const q=await QueueStore.open(store);let next;try{next=q.taskInbox().status(task).find(x=>!['returned','cancelled'].includes(x.phase));}finally{q.close();}
    if(!next)return {task,runs,pending:[],newModelRequests:runs.reduce((n,r)=>n+r.newModelRequests,0),workerEnded:true};
    if(next.phase==='waiting')return {task,runs,pending:[next],newModelRequests:runs.reduce((n,r)=>n+r.newModelRequests,0),workerEnded:true};
    const p=await prepareTaskOwner(store,task,next.id),result=await runMessages(store,p.plan,false,p.run,currentBilling);runs.push({id:next.id,run:p.run,completed:result.completed,resourcesSettled:result.resourcesSettled,newModelRequests:result.newModelRequests});
    if(!result.completed||!result.resourcesSettled)break;
  }
  const q=await QueueStore.open(store);try{return {task,runs,pending:q.taskInbox().status(task).filter(x=>!['returned','cancelled'].includes(x.phase)),newModelRequests:runs.reduce((n,r)=>n+r.newModelRequests,0),workerEnded:true};}finally{q.close();}
}

/** Fixed A -> B -> A contact, with sender identities filled only from actual
 * returned runs. Templates are operator input; model reports cannot select a
 * new task, executable, question, permission or shell command. */
export async function runTaskContact(store:string,planPath:string,currentBilling?:MessagePlan['billing']){
  const p=JSON.parse((await regular(planPath,256*1024)).toString());if(!exactKeys(p,['schemaVersion','kind','initial','contact','followup'])||p.schemaVersion!==1||p.kind!=='tongxu-task-owner-contact')throw new Error('task_contact_plan_invalid');
  const requests=[p.initial,p.contact,p.followup].map(x=>parseTaskOwnerRequest(Buffer.from(canonical(x))));
  if(requests.some(r=>r.from!==null)||requests[0]!.task!==requests[2]!.task||requests[0]!.task===requests[1]!.task||requests[0]!.id===requests[2]!.id||canonical(requests[0]!.participant)!==canonical(requests[2]!.participant)||requests.some(r=>r.executionKind!==requests[0]!.executionKind))throw new Error('task_contact_routes_invalid');
  const steps=[];let from:TaskOwnerRequest['from']=null;
  for(const template of requests){const request:TaskOwnerRequest={...template,from},q=await QueueStore.open(store);try{q.taskInbox().enqueue(Buffer.from(canonical(request)));}finally{q.close();}
    let selected;try{selected=await prepareTaskOwner(store,request.task,request.id);}catch(e){return {steps,completed:false,waiting:e instanceof Error?e.message:'task_contact_waiting',newModelRequests:steps.reduce((n,s)=>n+s.newModelRequests,0),workerEnded:true};}
    const result=await runMessages(store,selected.plan,false,selected.run,currentBilling);steps.push({task:request.task,id:request.id,run:selected.run,completed:result.completed,resourcesSettled:result.resourcesSettled,newModelRequests:result.newModelRequests});
    if(!result.completed||!result.resourcesSettled)return {steps,completed:false,waiting:'original_task_result_or_resources_unresolved',newModelRequests:steps.reduce((n,s)=>n+s.newModelRequests,0),workerEnded:true};
    from={task:request.task,run:selected.run,messageId:request.id};
  }
  return {steps,completed:true,newModelRequests:steps.reduce((n,s)=>n+s.newModelRequests,0),workerEnded:true,nativeSessionResumed:false};
}
