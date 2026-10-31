import {pathToFileURL,fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {messagePath} from './message-contract.js';
import {isAuthorityDigest,exactKeys} from './authority-contract.js';
import {runQueueRepair,closeUnstartedQueueRepair} from './queue-repair.js';
import {runMemberRefutation} from './member-refutation.js';
import {save} from './live-process.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {withAIPreferences,parseAIPreferences} from './ai-settings.js';

/** One owned invocation of the original controller. Its lifetime must end
 * independently of the page server so the original writer PID checks retain
 * their meaning during later explicit recovery. No new operation ledger. */
export async function returnWorkWorker(args:string[],controllers={repair:runQueueRepair,refutation:runMemberRefutation,close:closeUnstartedQueueRepair}){
  const [action,path,sha256]=args;
  if(![3,5].includes(args.length)||!['start','reconcile','close-unstarted','refutation'].includes(action??'')||!messagePath(path)||!isAuthorityDigest(sha256))throw new Error('return_worker_fixed_input_required');
  const execute=async()=>{if(action==='refutation')await controllers.refutation(path,'run',sha256);
    else if(action==='close-unstarted')await controllers.close(path,'fixed-return-control:'+sha256,sha256);
    else await controllers.repair(path,action==='reconcile',sha256);};
  if(args.length===5){
    if(!messagePath(args[3])||!isAuthorityDigest(args[4]))throw new Error('return_worker_fixed_input_required');
    const raw=await regular(args[3],256*1024);if(hash(raw)!==args[4])throw new Error('return_worker_preferences_changed');const input=JSON.parse(raw.toString());
    if(!exactKeys(input,['kind','action','plan','operation','item','workerSha256','originalQueueIsAuthoritative','aiPreferences'])||input.kind!=='fixed-original-return-invocation'||input.action!==action||!exactKeys(input.plan,['path','sha256'])||input.plan.path!==path||input.plan.sha256!==sha256||input.originalQueueIsAuthoritative!==true||input.workerSha256!==hash(await regular(fileURLToPath(import.meta.url),128*1024)))throw new Error('return_worker_preferences_changed');
    await withAIPreferences(parseAIPreferences(input.aiPreferences),execute);
  }else await execute();
  return {kind:'tongxu-return-worker',action,inputSha256:sha256,controllerReturned:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await returnWorkWorker(process.argv.slice(2))));}
  catch(e){const reason=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'original_return_worker_failed';save(join(process.cwd(),'worker-error.json'),{reason,detail:e instanceof Error?e.stack:String(e),automaticResend:false});console.log(JSON.stringify({kind:'tongxu-return-worker',action:process.argv[2],inputSha256:process.argv[4],controllerReturned:false,reason}));process.exitCode=1;}
}
