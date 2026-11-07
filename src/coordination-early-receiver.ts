import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {writeFile,realpath} from 'node:fs/promises';
import {QueueStore} from './queue-store.js';
import {parseCoordinationPlan,coordinationPlanId} from './coordination-contract.js';
import {parseCoordinationExecution} from './coordination-execution-contract.js';
import {regular,exists} from './repair-workspace.js';
import {privateDirectory,hash} from './snapshot.js';
import {canonical} from './comparison.js';
import {assembleRolePrompt} from './role-prompts.js';
import {messagePolicy} from './message-runtime.js';
import {runMessages} from './messages.js';
import {authorizeCoordinationMessage} from './coordination-authority.js';

const exec=promisify(execFile);
async function directory(path:string){if(!await exists(path))await privateDirectory(path,true);else await privateDirectory(path,false);}
async function fixed(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}if(!(await regular(path,1024*1024)).equals(bytes))throw new Error('early_receiver_prepared_file_changed');}

/** One original readonly receiver message, not final reception. The original
 * message/resource consumers own every model input and capture recovery. */
export async function runCoordinationEarlyReceiver(store:string,planPath:string,requestPath:string,prepareOnly=false){
 const raw=await regular(planPath,256*1024),plan=parseCoordinationPlan(raw),id=coordinationPlanId(plan),requestBytes=await regular(requestPath,256*1024),request=parseCoordinationExecution(requestBytes,plan);
 if(!request.earlyReceiver)throw new Error('coordination_early_receiver_not_declared');
 const q=await QueueStore.open(store),root=join(store,'coordination-'+id);let lock:DatabaseSync|undefined;
 try{
  await directory(root);const lockPath=join(root,'early-controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}
  await regular(lockPath,4*1024*1024);lock=new DatabaseSync(lockPath);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('early_receiver_controller_active');}
  const records=q.coordination();records.register(raw);const execution=records.execution(id,requestBytes),assembly=await assembleRolePrompt('receiver',messagePolicy),promptSha256=hash(canonical(assembly));
  let selected=records.prepareEarlyAdvice(id,execution.requestSha256,promptSha256);
  if('needsSources' in selected){
   const early=request.earlyReceiver;if(await realpath(early.objects)!==early.objects)throw new Error('early_receiver_object_source_changed');
   const check=await q.refreshSelectedTaskSources([...new Set(plan.tasks.filter(t=>Object.hasOwn(early.sourcePaths,t.id)).map(t=>t.item))]);check();
   const sources=[];
   for(const [task,paths] of Object.entries(early.sourcePaths))for(const path of paths){
    const H=selected.meta.bindings[task].candidate.H;if(typeof H!=='string'||!/^[a-f0-9]{40}$/.test(H))throw new Error('early_receiver_exact_head_required');
    const r=await exec('/usr/bin/git',['--no-replace-objects','--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','show','--no-ext-diff','--no-textconv',H+':'+path],{cwd:early.objects,encoding:'buffer',timeout:10000,maxBuffer:2*1024*1024,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    sources.push({task,path,H,sha256:hash(r.stdout),text:new TextDecoder('utf8',{fatal:true}).decode(r.stdout)});
   }
   check();selected=records.prepareEarlyAdvice(id,execution.requestSha256,promptSha256,sources);
  }
  if('needsSources' in selected)throw new Error('early_receiver_source_preparation_unresolved');
  await directory(selected.directory);await fixed(join(selected.directory,'context.json'),selected.material);await fixed(join(selected.directory,'plan.json'),selected.plan);
  if(prepareOnly)return {coordination:id,prepared:true,run:selected.run,newModelRequests:0,technicalAcceptanceGranted:false};
  const recoverOnly=selected.originPlan!==id;
  if(!recoverOnly&&request.delegatedCoordination){
   let sent=false;try{sent=q.messages().status(selected.run).messages.some(m=>Boolean(m.sent));}catch(e){if(!(e instanceof Error)||e.message!=='original_message_run_required')throw e;}
   if(!sent)await authorizeCoordinationMessage(q,request.delegatedCoordination,JSON.parse(selected.plan.toString()),JSON.parse(selected.material.toString()).bindings[plan.tasks.find(t=>Object.hasOwn(request.earlyReceiver!.sourcePaths,t.id))!.id]);
  }
  const result=await runMessages(store,join(selected.directory,'plan.json'),recoverOnly,selected.run,request.refreshUnsent?request.billing:undefined);
  return {coordination:id,run:selected.run,newModelRequests:result.newModelRequests,result,advice:records.earlyAdvice(id),technicalAcceptanceGranted:false};
 }finally{if(lock?.isTransaction)lock.exec('ROLLBACK');lock?.close();q.close();}
}
