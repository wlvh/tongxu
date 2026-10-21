import {pathToFileURL} from 'node:url';
import {QueueStore} from './queue-store.js';
import {regular} from './repair-workspace.js';
import {messagePath,messageId} from './message-contract.js';
import {addDevelopmentTask,prepareTaskOwner,workTaskOwner,runTaskContact} from './tasks.js';
export async function taskMain(args:string[]){
  const action=args[0],fields:Record<string,string[]>={contact:['store','plan'],cancel:['store','task','id','source'],enable:['store'],add:['store','definition'],enqueue:['store','request'],prepare:['store','task','id'],work:['store','task','limit'],status:['store','task'],context:['store','task']},keys=fields[action??''],v:Record<string,string>={};
  if(!keys||args.length!==keys.length*2+1)throw new Error('task_command_invalid');for(let i=1;i<args.length;i+=2){const k=args[i]!.slice(2);if(!args[i]!.startsWith('--')||!keys.includes(k)||v[k]||!args[i+1])throw new Error('task_option_invalid');v[k]=args[i+1]!;}
  for(const k of ['store','definition','request','plan'])if(v[k]&&!messagePath(v[k]))throw new Error('task_path_invalid');if(v.task&&!/^[a-f0-9]{64}$/.test(v.task)||v.id&&!messageId(v.id))throw new Error('task_identity_invalid');
  if(action==='contact')return runTaskContact(v.store!,v.plan!);
  if(action==='add')return addDevelopmentTask(v.store!,v.definition!);if(action==='prepare')return prepareTaskOwner(v.store!,v.task!,v.id!);if(action==='work')return workTaskOwner(v.store!,v.task!,Number(v.limit));
  const q=await QueueStore.open(v.store!);try{if(action==='enable'){q.enableReceiver();q.enableSupplements();q.reviewRecords().enable();q.enableCompositions();q.enableReceiverCorrections();return q.enableTasks();}if(action==='enqueue')return q.taskInbox().enqueue(await regular(v.request!,64*1024));if(action==='cancel')return q.taskInbox().cancelUnsent(v.task!,v.id!,v.source!);if(action==='context')return JSON.parse(q.tasks().context(v.task!).toString());return {...q.tasks().status(v.task!),inbox:q.taskInbox().status(v.task!)};}finally{q.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await taskMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'task_operation_failed'})+'\n');process.exitCode=1;}}
