import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {messagePath} from './message-contract.js';
import {isAuthorityDigest} from './authority-contract.js';
import {runQueueRepair,closeUnstartedQueueRepair} from './queue-repair.js';
import {runMemberRefutation} from './member-refutation.js';
import {save} from './live-process.js';

/** One owned invocation of the original controller. Its lifetime must end
 * independently of the page server so the original writer PID checks retain
 * their meaning during later explicit recovery. No new operation ledger. */
export async function returnWorkWorker(args:string[]){
  const [action,path,sha256]=args;
  if(args.length!==3||!['start','reconcile','close-unstarted','refutation'].includes(action??'')||!messagePath(path)||!isAuthorityDigest(sha256))throw new Error('return_worker_fixed_input_required');
  if(action==='refutation')await runMemberRefutation(path,'run',sha256);
  else if(action==='close-unstarted')await closeUnstartedQueueRepair(path,'fixed-return-control:'+sha256,sha256);
  else await runQueueRepair(path,action==='reconcile',sha256);
  return {kind:'tongxu-return-worker',action,inputSha256:sha256,controllerReturned:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await returnWorkWorker(process.argv.slice(2))));}
  catch(e){const reason=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'original_return_worker_failed';save(join(process.cwd(),'worker-error.json'),{reason,detail:e instanceof Error?e.stack:String(e),automaticResend:false});console.log(JSON.stringify({kind:'tongxu-return-worker',action:process.argv[2],inputSha256:process.argv[4],controllerReturned:false,reason}));process.exitCode=1;}
}
