#!/usr/bin/env node
import { isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { QueueStore } from './queue-store.js';
import { regular } from './repair-workspace.js';
import { parseActionRequest, isAuthorityDigest } from './authority-contract.js';
import { readOwnerSource } from './authority-source.js';

const commands:Record<string,string[]>={configure:['store','profile'],prepare:['store','id','proposal'],apply:['store','proposal-sha','comment','evidence'],status:['store'],check:['store','authorization','request','evidence'],reserve:['store','id','authorization','request','evidence'],baseline:['store','adoption','evidence']};
export async function authorityMain(args:string[]){
  const command=args[0]??'',keys=commands[command],values:Record<string,string>={};
  if(!keys||args.length!==1+keys.length*2)throw new Error('invalid_authority_command');
  for(let i=1;i<args.length;i+=2){const flag=args[i]!,key=flag.slice(2),value=args[i+1];if(!flag.startsWith('--')||!keys.includes(key)||!value||value.startsWith('--')||Object.hasOwn(values,key))throw new Error('invalid_authority_option');values[key]=value;}
  for(const k of ['store','profile','proposal','request','evidence'])if(values[k]&&(!isAbsolute(values[k])||resolve(values[k])!==values[k]))throw new Error('authority_path_not_absolute');
  for(const k of ['proposal-sha','authorization','adoption'])if(values[k]&&!isAuthorityDigest(values[k]))throw new Error('authority_digest_invalid');
  const q=await QueueStore.open(values.store!);
  try{
    const records=q.authority();
    if(command==='configure')return records.configure(await regular(values.profile!,128*1024));
    if(command==='status')return records.status();
    if(command==='prepare')return records.prepare(values.id!,await regular(values.proposal!,128*1024));
    const {profile}=records.configuration();
    if(command==='apply'){
      if(!/^[1-9]\d*$/.test(values.comment!)||!Number.isSafeInteger(Number(values.comment)))throw new Error('authority_comment_invalid');
      const p=records.proposal(values['proposal-sha']!).proposal;
      const observation=await readOwnerSource(profile,values['proposal-sha']!,Number(values.comment),values.evidence!),dependencies=[];
      if(p.kind==='delivery_outcome')for(const [i,ref] of records.sourceRequests(p.adoption).entries())dependencies.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(values.evidence!,'adoption-'+i)));
      return records.apply(values['proposal-sha']!,observation,dependencies);
    }
    // Freeze all request bytes before any provider call. No user pathname is
    // reread after a source observation or an intent has been registered.
    const request=command==='baseline'?null:parseActionRequest(JSON.parse((await regular(values.request!,128*1024)).toString()));
    if(command==='reserve'&&records.status().intents.some(i=>i.requestId===values.id))return records.reserveAction(values.id!,request!,'background',values.authorization!,[]);
    const refs=records.sourceRequests((values.authorization??values.adoption)!);
    await mkdir(values.evidence!,{mode:0o700});const observations=[];
    for(const [i,ref] of refs.entries())observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(values.evidence!,String(i))));
    if(command==='baseline')return records.adoptionBaseline(values.adoption!,observations);
    // This local operator CLI is not a model tool. Role-specific endpoints call
    // the same backend with their fixed role; JSON/flags cannot elevate it.
    return command==='check'?records.checkAction(request!,'background',values.authorization!,observations):records.reserveAction(values.id!,request!,'background',values.authorization!,observations);
  }finally{q.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{process.stdout.write(JSON.stringify(await authorityMain(process.argv.slice(2)))+'\n');}
  catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'authority_failed',externalActionSent:false})+'\n');process.exitCode=1;}
}
