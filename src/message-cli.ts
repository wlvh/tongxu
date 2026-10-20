#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { messagePath } from './message-contract.js';
import { runMessages } from './messages.js';
import { QueueStore } from './queue-store.js';
export async function messageMain(args:string[]){
  const action=args[0],keys=action==='status'?['store','run']:action==='run'||action==='reconcile'?['store','plan']:null,v:Record<string,string>={};if(!keys||args.length!==5)throw new Error('message_command_invalid');
  for(let i=1;i<args.length;i+=2){const k=args[i]!.slice(2);if(!args[i]!.startsWith('--')||!keys.includes(k)||Object.hasOwn(v,k)||!args[i+1])throw new Error('message_option_invalid');v[k]=args[i+1]!;}
  if(!messagePath(v.store)||v.plan!==undefined&&!messagePath(v.plan)||v.run!==undefined&&!/^[a-f0-9]{64}$/.test(v.run))throw new Error('message_path_or_run_invalid');
  if(action==='status'){const q=await QueueStore.open(v.store);try{return q.messages().status(v.run!);}finally{q.close();}}
  return runMessages(v.store,v.plan!,action==='reconcile');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await messageMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'message_operation_failed'})+'\n');process.exitCode=1;}}
