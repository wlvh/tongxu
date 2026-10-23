#!/usr/bin/env node
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QueueStore } from './queue-store.js';
import { regular } from './repair-workspace.js';
import { prepareManagedMerge,managedMergeAction,validateManagedMerge } from './managed-merge.js';

const fields:Record<string,string[]>={configure:['store','profile'],prepare:['store','plan'],status:['store','operation'],run:['store','operation'],'retry-refused':['store','operation'],reconcile:['store','operation'],'recover-controller':['store','operation'],'cancel-unstarted':['store','operation'],'validation-input':['store','operation'],validate:['store','operation','validation-store','validation-operation']};
export async function mergeMain(args:string[]){
  const action=args[0]??'',keys=fields[action],v:Record<string,string>={};if(!keys||args.length!==1+keys.length*2)throw new Error('invalid_managed_merge_command');
  for(let i=1;i<args.length;i+=2){const key=args[i]!.slice(2),value=args[i+1];if(!args[i]!.startsWith('--')||!keys.includes(key)||!value||value.startsWith('--')||Object.hasOwn(v,key))throw new Error('invalid_managed_merge_option');v[key]=value;}
  for(const key of ['store','profile','plan','validation-store'])if(v[key]&&(!isAbsolute(v[key])||resolve(v[key])!==v[key]))throw new Error('managed_merge_absolute_path_required');
  for(const key of ['operation','validation-operation'])if(v[key]&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v[key]))throw new Error('managed_merge_operation_invalid');
  if(['configure','status','validation-input'].includes(action)){const q=await QueueStore.open(v.store!);try{return action==='configure'?q.merges().configure(await regular(v.profile!,128*1024)):action==='status'?q.merges().status(v.operation!):JSON.parse(q.merges().validationInput(v.operation!).toString());}finally{q.close();}}
  if(action==='prepare')return prepareManagedMerge(v.store!,await regular(v.plan!,128*1024));
  if(action==='validate')return validateManagedMerge(v.store!,v.operation!,v['validation-store']!,v['validation-operation']!);
  return managedMergeAction(v.store!,v.operation!,action as 'run'|'retry-refused'|'reconcile'|'recover-controller'|'cancel-unstarted');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await mergeMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'managed_merge_failed',automaticResend:false,automaticRollback:false})+'\n');process.exitCode=1;}}
