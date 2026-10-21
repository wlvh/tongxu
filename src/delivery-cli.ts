#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {QueueStore} from './queue-store.js';
import {regular} from './repair-workspace.js';
import {messagePath,messageId} from './message-contract.js';
import {isAuthorityDigest} from './authority-contract.js';
import {runDeliveryValidation} from './delivery-validation.js';

export async function deliveryMain(args:string[]){
  const command=args[0],keys=command==='register'?['store','batch']:command==='state'?['store','batch-sha']:command==='verify'||command==='reconcile'||command==='close-unstarted'?['store','plan']:command==='validation-state'?['store','id']:null,values:Record<string,string>={};
  if(!keys||args.length!==5)throw new Error('delivery_command_invalid');
  for(let i=1;i<args.length;i+=2){const flag=args[i]!,key=flag.slice(2),value=args[i+1];if(!flag.startsWith('--')||!keys.includes(key)||!value||value.startsWith('--')||Object.hasOwn(values,key))throw new Error('delivery_option_invalid');values[key]=value;}
  if(!messagePath(values.store)||command==='register'&&!messagePath(values.batch)||command==='state'&&!isAuthorityDigest(values['batch-sha'])||(command==='verify'||command==='reconcile'||command==='close-unstarted')&&!messagePath(values.plan)||command==='validation-state'&&!messageId(values.id))throw new Error('delivery_reference_invalid');
  if(command==='verify'||command==='reconcile'||command==='close-unstarted')return runDeliveryValidation(values.store!,values.plan!,command==='verify'?'run':command);
  if(command==='validation-state')return QueueStore.observeDeliveryValidation(values.store!,values.id!);
  if(command==='state')return (await QueueStore.observeDeliveries(values.store!,[values['batch-sha']!]))[0]!;
  const bytes=await regular(values.batch!,256*1024),q=await QueueStore.open(values.store!);try{return q.deliveries().register(bytes);}finally{q.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await deliveryMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'delivery_failed',externalActionSent:false})+'\n');process.exitCode=1;}}
