import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from './queue-store.js';
import {runCoordination} from './coordination.js';
import {runQueueRepair,parseQueueRepairPlan} from './queue-repair.js';
import {parseCoordinationPlan,coordinationPlanId} from './coordination-contract.js';
import {regular} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';

/** One bounded entry: owned readonly task -> explicitly authorized original
 * queue repair -> exact new candidate consumed by the dependent task. */
export async function runCoordinatedRepair(store:string,planPath:string,requestPath:string,repairPath:string,reconcileEnded=false){
  const plan=parseCoordinationPlan(await regular(planPath)),id=coordinationPlanId(plan),raw=await regular(repairPath),repair=parseQueueRepairPlan(raw),expected={plan:id,request:hash(await regular(requestPath))};
  if(repair.store!==store)throw new Error('coordination_repair_store_changed');
  const q=await QueueStore.open(store);let task;
  try{const original=q.receiverState(repair.operation),originalPlan=JSON.parse(original.plan.toString()),tasks=plan.tasks.filter(t=>t.item===originalPlan.item&&t.outputs.some(o=>o.kind==='repair_candidate'));if(tasks.length!==1)throw new Error('coordination_repair_task_ambiguous');task=tasks[0]!;}finally{q.close();}
  const outputs=task.outputs.filter(o=>o.kind==='repair_candidate');if(outputs.length!==1)throw new Error('coordination_repair_output_ambiguous');
  const directory=join(store,'coordination-'+id);try{await privateDirectory(directory,true);}catch(e:any){if(e.code!=='EEXIST')throw e;await privateDirectory(directory,false);}
  const lockPath=join(directory,'repair-workflow.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(lockPath);const lock=new DatabaseSync(lockPath);
  try{
    try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('coordination_repair_workflow_active');}
    const investigation=await runCoordination(store,planPath,requestPath,false,expected),selected=investigation.prepared[task.id+':investigate'];
    if(!selected||!investigation.results[task.id+':investigate']?.completed||investigation.errors[task.id+':investigate'])return {completed:false,status:'original_task_waiting',investigation,repair:null,readonlyModelRequests:investigation.newModelRequests,manualReportCopyRequired:false};
    const coordination={planId:id,task:task.id,capability:outputs[0]!.id,fromRun:selected.run,fromMessage:selected.messageId};
    if(repair.coordination&&canonical(repair.coordination)!==canonical(coordination))throw new Error('coordination_repair_original_reply_changed');
    const bound=Buffer.from(canonical({...repair,coordination})),path=join(directory,'repair-'+repair.operation+'.json');
    try{await writeFile(path,bound,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}
    if(!(await regular(path)).equals(bound))throw new Error('coordination_fixed_repair_changed');
    const result=await runQueueRepair(path,reconcileEnded);
    if(!result.coordinationOutput)return {completed:false,status:'repair_has_no_accepted_new_candidate',investigation,repair:result,readonlyModelRequests:investigation.newModelRequests,manualReportCopyRequired:false};
    const consumption=await runCoordination(store,planPath,requestPath,false,expected),state=consumption.state;
    const dependencies=plan.dependencies.filter(d=>d.producer===task.id&&d.capability===outputs[0]!.id);
    const consumed=dependencies.length>0&&dependencies.every(d=>state.tasks.find(t=>t.id===d.task)?.stages.find(s=>s.stage===d.stage)?.phasePrerequisitesMet===true);
    const resourcesSettled=[...Object.values(investigation.results),...Object.values(consumption.results)].every(r=>r.resourcesSettled!==false)&&(result.resources??[]).every((r:any)=>['consumed','released'].includes(r.state));
    return {completed:consumed&&consumption.readonlyTasksCompleted&&resourcesSettled,status:!resourcesSettled?'original_resource_result_pending':consumed?'candidate_consumed':'dependent_task_waiting',resourcesSettled,coordination:id,investigation,repair:result,consumption,readonlyModelRequests:investigation.newModelRequests+consumption.newModelRequests,manualReportCopyRequired:false,manualRepairRequired:false,productionActionAllowed:false};
  }finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
}
