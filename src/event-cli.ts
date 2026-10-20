#!/usr/bin/env node
import { isAbsolute,resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { QueueStore } from './queue-store.js';
import { regular } from './repair-workspace.js';
import { sourceTick } from './event-tick.js';
import { readOwnerSource } from './authority-source.js';
import { exactKeys } from './authority-contract.js';

const fields:Record<string,string[]>={configure:['store','profile'],hint:['store','input'],preference:['store','input'],status:['store'],rank:['store'],select:['store','run'],tick:['store']};
export async function eventMain(args:string[]){
  const action=args[0]??'',keys=fields[action],v:Record<string,string>={};if(!keys||args.length!==1+keys.length*2)throw new Error('invalid_event_command');
  for(let i=1;i<args.length;i+=2){const key=args[i]!.slice(2),value=args[i+1];if(!args[i]!.startsWith('--')||!keys.includes(key)||!value||value.startsWith('--')||Object.hasOwn(v,key))throw new Error('invalid_event_option');v[key]=value;}
  for(const key of keys.filter(k=>k!=='run'))if(!isAbsolute(v[key]!)||resolve(v[key]!)!==v[key])throw new Error('event_absolute_path_required');
  if(action==='tick')return sourceTick(v.store!,true);
  const q=await QueueStore.open(v.store!);try{
    if(action==='rank')return q.scheduling();
    if(action==='select')return q.selectEvaluation(v.run!);
    if(action==='preference'){
      const input=JSON.parse((await regular(v.input!,16384)).toString());if(!exactKeys(input,['intentId','preference'])||typeof input.intentId!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).test(input.intentId))throw new Error('preference_intent_input_invalid');
      const authority=q.authority(),intent=authority.reservedAction(input.intentId),{profile}=authority.configuration(),observations=[];
      if(profile.executionKind!=='github')throw new Error('preference_cli_requires_actual_owner_source');
      for(const source of authority.sourceRequests(intent.authorization))observations.push(await readOwnerSource(profile,source.proposalSha256,source.commentId,join(v.store!,'preference-source-'+randomUUID())));
      return q.events().applyPreference(input.intentId,Buffer.from(JSON.stringify(input.preference)),observations);
    }
    return action==='configure'?q.events().configure(await regular(v.profile!,128*1024)):action==='hint'?q.events().hint(await regular(v.input!,4096)):q.events().status();
  }finally{q.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await eventMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'event_operation_failed',modelTasksStarted:0,mergeRequestsSent:0})+'\n');process.exitCode=1;}}
