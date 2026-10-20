import { readFile,realpath,lstat,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LiveProcess,checkCapture } from './live-process.js';
import { canonical } from './comparison.js';
import { hash,privateDirectory } from './snapshot.js';
import { parseLedgerProfile,parseLedgerCommand,parseLedgerReply,type LedgerProfile,type LedgerCommand,type LedgerReply } from './resource-contract.js';
import { regular } from './repair-workspace.js';

export type LedgerObservation={profileSha256:string;inputSha256:string;reply:LedgerReply;directory:string;raw:Buffer;capturedAt:string};
const observed=new WeakSet<object>();
export type ResourceDispatchReference={event:number;phase:'claim'|'result';directory:string;controllerPid:number;controllerReturned:boolean};
export type ResourceUnstartedProof={referenceSha256:string;inputSha256:string;observedAt:string;proof:Buffer};
const unstartedProofs=new WeakSet<object>();
/** Absence is useful only after the original controller has definitely ended.
 * A known launch, process or nonempty stream is never erased into "unsent". */
export async function inspectResourceUnstarted(reference:ResourceDispatchReference):Promise<ResourceUnstartedProof>{
  if(!reference.controllerReturned){
    if(!Number.isSafeInteger(reference.controllerPid)||reference.controllerPid<=0)throw new Error('resource_original_controller_unknown');
    try{process.kill(reference.controllerPid,0);throw new Error('resource_original_controller_active');}catch(e:any){if(e.code!=='ESRCH')throw e;}
  }
  await privateDirectory(reference.directory,false);
  for(const name of ['launch.json','process.json','exit.json']){
    try{await lstat(join(reference.directory,name));throw new Error('resource_provider_started_or_unknown');}catch(e:any){if(e.code!=='ENOENT')throw e;}
  }
  for(const name of ['stdout.ndjson','stderr.txt','stdin.ndjson']){
    try{if((await regular(join(reference.directory,name),16*1024*1024)).length)throw new Error('resource_provider_stream_exists');}catch(e:any){if(e.code!=='ENOENT')throw e;}
  }
  const input=JSON.parse((await regular(join(reference.directory,'fixed-input.json'),128*1024)).toString()),referenceSha256=hash(canonical(reference)),inputSha256=hash(canonical(input)),observedAt=new Date().toISOString();
  const proof=Buffer.from(canonical({reference,inputSha256,observedAt,providerLaunchAbsent:true,nonemptyStreamsAbsent:true})),value=Object.freeze({referenceSha256,inputSha256,observedAt,proof});unstartedProofs.add(value);return value;
}
export function requireResourceUnstarted(value:ResourceUnstartedProof,reference:ResourceDispatchReference,command:LedgerCommand){
  if(!unstartedProofs.has(value)||value.referenceSha256!==hash(canonical(reference))||value.inputSha256!==hash(canonical(command))||Date.now()-Date.parse(value.observedAt)>60000||hash(value.proof)!==hash(canonical({reference,inputSha256:value.inputSha256,observedAt:value.observedAt,providerLaunchAbsent:true,nonemptyStreamsAbsent:true})))throw new Error('resource_original_unstarted_proof_required');
}
export function requireLedgerObservation(x:LedgerObservation,p:LedgerProfile,c:LedgerCommand){
  if(!observed.has(x)||x.profileSha256!==hash(canonical(p))||x.inputSha256!==hash(canonical(c))||Date.now()-Date.parse(x.capturedAt)>60000)throw new Error('actual_resource_provider_observation_required');
  const replay=parseLedgerReply(x.raw,p,c);if(canonical(replay)!==canonical(x.reply))throw new Error('resource_original_reply_changed');
}
/** The existing provider is trusted operator configuration. No report can
 * select its program, arguments, URL, credentials, refund or a new paid route. */
export async function callResourceProvider(profile:LedgerProfile,command:LedgerCommand,directory:string,beforeDispatch?:(directory:string)=>void):Promise<LedgerObservation>{
  const p=parseLedgerProfile(Buffer.from(canonical(profile))),c=parseLedgerCommand(JSON.parse(canonical(command)),p);
  if(['claim','record_result'].includes(c.command)&&!beforeDispatch)throw new Error('resource_persisted_intent_gate_required');
  await privateDirectory(directory,true);const exe=await realpath(p.executable),st=await lstat(exe);
  if(!st.isFile()||!(st.mode&0o111)||hash(await readFile(exe))!==p.executableSha256)throw new Error('resource_provider_executable_changed');
  const input=canonical(c)+'\n';await writeFile(join(directory,'fixed-input.json'),input,{flag:'wx',mode:0o600});
  // Hooks register the exact original request before spawn; no await in between.
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG};
  beforeDispatch?.(directory);const live=new LiveProcess(directory,exe,['--tongxu-ledger-v1'],directory,env);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    live.writeText(input);
    await Promise.race([live.closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('resource_provider_timeout_result_unknown')),p.timeoutMs);})]);
    if(live.exit?.code!==0||live.exit.signal!==null||live.failure)throw new Error('resource_provider_execution_incomplete');
    await checkCapture(directory);
    if(live.events.length!==1)throw new Error('resource_provider_one_reply_required');
    const raw=await readFile(join(directory,'stdout.ndjson')),reply=parseLedgerReply(raw,p,c);
    const observation=Object.freeze({profileSha256:hash(canonical(p)),inputSha256:hash(canonical(c)),reply,directory,raw:Buffer.from(raw),capturedAt:new Date().toISOString()});
    observed.add(observation);return observation;
  }finally{if(timer)clearTimeout(timer);await live.close();}
}
