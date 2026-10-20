#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { messagePath } from './message-contract.js';
import { QueueStore } from './queue-store.js';
import { runCoordination } from './coordination.js';
export async function coordinationMain(args:string[]){
  const action=args[0],keys=action==='status'?['store','run']:['store','plan','request'],values:Record<string,string>={};if(!['prepare','run','status'].includes(action??'')||args.length!==keys.length*2+1)throw new Error('coordination_command_invalid');
  for(let i=1;i<args.length;i+=2){const k=args[i]!.slice(2);if(!args[i]!.startsWith('--')||!keys.includes(k)||Object.hasOwn(values,k)||!args[i+1])throw new Error('coordination_option_invalid');values[k]=args[i+1]!;}
  for(const k of keys)if(k==='run'?!/^[a-f0-9]{64}$/.test(values[k]!):!messagePath(values[k]))throw new Error('coordination_path_or_identity_invalid');
  if(action==='status'){const q=await QueueStore.open(values.store!);try{return q.coordination().status(values.run!);}finally{q.close();}}
  return runCoordination(values.store!,values.plan!,values.request!,action==='prepare');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await coordinationMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'coordination_operation_failed'})+'\n');process.exitCode=1;}}
