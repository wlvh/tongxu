#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { messagePath } from './message-contract.js';
import { continueMessage } from './message-continuation.js';
export async function continuationMain(args:string[]){
  const action=args[0],keys=['store','plan','request'],v:Record<string,string>={};if(!['prepare','run'].includes(action??'')||args.length!==7)throw new Error('continuation_command_invalid');
  for(let i=1;i<args.length;i+=2){const key=args[i]!.slice(2);if(!args[i]!.startsWith('--')||!keys.includes(key)||Object.hasOwn(v,key)||!messagePath(args[i+1]))throw new Error('continuation_option_invalid');v[key]=args[i+1]!;}
  return continueMessage(v.store!,v.plan!,v.request!,action==='prepare');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await continuationMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'continuation_operation_failed'})+'\n');process.exitCode=1;}}
