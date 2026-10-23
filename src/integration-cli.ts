#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {messageId,messagePath} from './message-contract.js';
import {QueueStore} from './queue-store.js';
import {runIntegration} from './integration.js';
import {regular} from './repair-workspace.js';
import {runObservedCandidate} from './observed-candidate.js';
export async function integrationMain(args:string[]){
  const command=args[0],read=command==='state',keys=read?['store','id']:['prepare','run','reconcile','close-unstarted','continue-ended','attach-candidate','observe-candidate'].includes(command??'')?['store','request']:null,values:Record<string,string>={};if(!keys||args.length!==5)throw new Error('integration_command_invalid');
  for(let i=1;i<args.length;i+=2){const k=args[i]!.slice(2),v=args[i+1];if(!args[i]!.startsWith('--')||!keys.includes(k)||!v||Object.hasOwn(values,k))throw new Error('integration_option_invalid');values[k]=v;}
  if(!messagePath(values.store)||read&&!messageId(values.id)||!read&&!messagePath(values.request))throw new Error('integration_reference_invalid');
  if(command==='observe-candidate')return runObservedCandidate(values.store!,values.request!);
  if(command==='attach-candidate'){const q=await QueueStore.open(values.store!);try{return q.attachIntegrationCandidate(await regular(values.request!,32*1024));}finally{q.close();}}
  return read?QueueStore.observeIntegration(values.store!,values.id!):runIntegration(values.store!,values.request!,command as 'prepare'|'run'|'reconcile'|'close-unstarted'|'continue-ended');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await integrationMain(process.argv.slice(2))));}catch(e){console.error(JSON.stringify({error:e instanceof Error?e.message:'integration_failed',automaticResend:false}));process.exitCode=1;}}
