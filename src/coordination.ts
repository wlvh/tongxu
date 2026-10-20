import { writeFile } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { regular } from './repair-workspace.js';
import { hash,privateDirectory } from './snapshot.js';
import { canonical } from './comparison.js';
import { QueueStore } from './queue-store.js';
import { coordinationPlanId,parseCoordinationPlan } from './coordination-contract.js';
import { parseCoordinationExecution,coordinationTaskBody,coordinationMessageId } from './coordination-execution-contract.js';
import { runMessages } from './messages.js';
import type { MessagePlan } from './message-contract.js';
async function directory(path:string){try{await privateDirectory(path,true);}catch(e:any){if(e.code!=='EEXIST')throw e;await privateDirectory(path,false);}}
async function fixedFile(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}if(!(await regular(path,512*1024)).equals(bytes))throw new Error('coordination_prepared_file_changed');}

/** A finite readonly task entry. Stages and write ownership remain enforced
 * separately; completing these conversations is not completing implementation. */
export async function runCoordination(store:string,planPath:string,requestPath:string,prepareOnly=false){
  const raw=await regular(planPath,256*1024),plan=parseCoordinationPlan(raw),id=coordinationPlanId(plan),requestBytes=await regular(requestPath,256*1024),request=parseCoordinationExecution(requestBytes,plan),q=await QueueStore.open(store),root=join(store,'coordination-'+id);let lock:DatabaseSync|undefined;
  try{
    await directory(root);const lockPath=join(root,'controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(lockPath,4*1024*1024);lock=new DatabaseSync(lockPath);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{lock.close();lock=undefined;throw new Error('coordination_controller_active');}
    const records=q.coordination();records.register(raw);const execution=records.execution(id,requestBytes),prepared:Record<string,any>={},results:Record<string,any>={},errors:Record<string,string>={};let newModelRequests=0;
    const select=async(taskId:string,purpose:'investigate'|'consume')=>{
      const task=plan.tasks.find(t=>t.id===taskId)!,prior=records.dispatchSelection(id,taskId,purpose),context=records.context(id),actor=request.actors.find(a=>a.id===task.actor)!,attempt=(prior?.attempt??0)+1,path=join(root,'dispatch-'+hash(canonical([taskId,purpose])),'attempt-'+attempt);
      const message:MessagePlan={schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:request.executionKind,source:request.source+'; coordination '+id+' task '+taskId+' '+purpose,authorityIntent:request.authorityIntents[taskId]!,participants:[{...actor,item:task.item,role:'issue_owner',parent:null}],messages:[{id:coordinationMessageId(taskId,purpose),from:null,to:actor.id,body:coordinationTaskBody(request,taskId,purpose),replies:[]}],material:[{name:'coordination-context.json',path:join(path,'context.json'),sha256:context.sha256}],consumeMaterial:['coordination-context.json'],billing:request.billing,timeoutMs:request.timeoutMs};
      records.selectDispatch(id,taskId,purpose,execution.requestSha256,Buffer.from(canonical(message)),context.sha256);const selected=records.dispatchSelection(id,taskId,purpose)!;
      const parsed=JSON.parse(selected.plan.toString());records.bindMessages(id,selected.plan,selected.contextSha256,[{task:taskId,messageId:parsed.messages[0].id}]);await directory(dirname(selected.directory));await directory(selected.directory);await fixedFile(join(selected.directory,'context.json'),selected.context);await fixedFile(join(selected.directory,'plan.json'),selected.plan);const result={task:taskId,purpose,run:selected.run,attempt:selected.attempt,planPath:join(selected.directory,'plan.json'),contextSha256:selected.contextSha256,messageId:parsed.messages[0].id};prepared[taskId+':'+purpose]=result;return result;
    };
    const perform=async(taskId:string,purpose:'investigate'|'consume')=>{
      try{
        const selected=await select(taskId,purpose);if(prepareOnly)return;
        const result=await runMessages(store,selected.planPath,false,selected.run);newModelRequests+=result.newModelRequests;results[taskId+':'+purpose]=result;if(!result.completed)return;
        records.feedback(id,result.run,selected.messageId);
        const task=plan.tasks.find(t=>t.id===taskId)!;if(purpose==='investigate')for(const output of task.outputs.filter(o=>o.stage==='investigate'))records.recordMessageOutput(id,taskId,output.id,result.run,selected.messageId);
        // Consume only the stages whose complete producer outputs were already
        // in this fixed message. Missing later capabilities remain waiting.
        for(const stage of task.stages){try{records.consumeMessageInputs(id,taskId,stage,result.run,selected.messageId);}catch(e){if(!(e instanceof Error)||e.message!=='coordination_exact_producer_output_not_consumed')throw e;}}
      }catch(e){errors[taskId+':'+purpose]=e instanceof Error?e.message:'coordination_task_unresolved';}
    };
    const attempted=new Set<string>();
    for(let pass=0;pass<plan.tasks.length;pass++){
      const actors=new Set<string>(),batch=[];
      for(const task of plan.tasks){if(attempted.has(task.id)||actors.has(task.actor))continue;let gate;try{gate=records.stage(id,task.id,'investigate');}catch(e){errors[task.id]=e instanceof Error?e.message:'coordination_task_unknown';continue;}if(gate.blockers.some(b=>!b.startsWith('capability_not_consumed:')))continue;actors.add(task.actor);batch.push(task.id);attempted.add(task.id);}
      if(!batch.length)break;await Promise.all(batch.map(task=>perform(task,'investigate')));
    }
    if(!prepareOnly){
      // One bounded follow-up per task, only when another task actually
      // produced a precise required result after the initial input froze.
      for(const task of plan.tasks){if(!results[task.id+':investigate']?.completed||errors[task.id+':investigate'])continue;const states=task.stages.map(s=>records.stage(id,task.id,s)),pending=states.some(s=>s.blockers.some(b=>b.startsWith('capability_not_consumed:'))),missing=states.some(s=>s.blockers.some(b=>b.startsWith('capability_missing:')));if(pending&&!missing)await perform(task.id,'consume');}
    }
    const state=records.status(id);return {coordination:id,execution:execution.identity,prepared,results,errors,state,newModelRequests,readonlyTasksCompleted:!prepareOnly&&Object.keys(errors).length===0&&Object.values(results).every(r=>r.completed)&&plan.tasks.every(t=>results[t.id+':investigate']?.completed),implementationCompleted:false,writingPermissionGranted:false,manualReportCopyRequired:false};
  }finally{if(lock){lock.exec('ROLLBACK');lock.close();}q.close();}
}
