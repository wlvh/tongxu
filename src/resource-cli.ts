#!/usr/bin/env node
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QueueStore } from './queue-store.js';
import { regular } from './repair-workspace.js';
import { resourceAction,prepareResourceRequest,closeUnstartedResource } from './resource-claims.js';

const fields:Record<string,string[]>={configure:['store','profile'],prepare:['store','request'],status:['store','id'],claim:['store','id'],'retry-refused':['store','id'],lookup:['store','id'],'record-result':['store','id'],'close-unstarted':['store','id','phase']};
export async function resourceMain(args:string[]):Promise<Record<string,any>>{
  const action=args[0]??'',keys=fields[action],v:Record<string,string>={};if(!keys||args.length!==1+2*keys.length)throw new Error('invalid_resource_command');
  for(let i=1;i<args.length;i+=2){const key=args[i]!.slice(2),value=args[i+1];if(!args[i]!.startsWith('--')||!keys.includes(key)||!value||value.startsWith('--')||Object.hasOwn(v,key))throw new Error('invalid_resource_option');v[key]=value;}
  for(const key of ['store','profile','request'])if(v[key]&&(!isAbsolute(v[key])||resolve(v[key])!==v[key]))throw new Error('resource_path_not_absolute');
  if(v.id&&!/^[a-f0-9]{64}$/.test(v.id))throw new Error('resource_id_invalid');
  if(action==='close-unstarted'){if(!['claim','result'].includes(v.phase!))throw new Error('resource_phase_invalid');return closeUnstartedResource(v.store!,v.id!,v.phase as 'claim'|'result');}
  if(action==='configure'||action==='status'){const q=await QueueStore.open(v.store!);try{return action==='configure'?q.resources().configure(await regular(v.profile!,128*1024)):q.resources().status(v.id!);}finally{q.close();}}
  if(action==='prepare')return prepareResourceRequest(v.store!,await regular(v.request!,128*1024),'background');
  return resourceAction(v.store!,v.id!,action as 'claim'|'retry-refused'|'lookup'|'record-result','background');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{process.stdout.write(JSON.stringify(await resourceMain(process.argv.slice(2)))+'\n');}
  catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'resource_operation_failed',automaticResend:false,automaticRefund:false})+'\n');process.exitCode=1;}
}
