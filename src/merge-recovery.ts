import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from './comparison.js';
import { hash,privateDirectory } from './snapshot.js';
import { regular } from './repair-workspace.js';
import type { MergeCommand } from './merge-provider.js';

export type MergeDispatchReference={attempt:number;directory:string;controllerPid:number;controllerReturned:boolean};
export type MergeControllerProof={referenceSha256:string;inputSha256:string;unstarted:boolean;proof:Buffer;observedAt:string};
const proofs=new WeakSet<object>();
const alive=(pid:unknown)=>{if(!Number.isSafeInteger(pid)||(pid as number)<=0)throw new Error('merge_original_process_identity_unknown');try{process.kill(pid as number,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}};
export async function inspectMergeController(reference:MergeDispatchReference):Promise<MergeControllerProof>{
  if(!reference.controllerReturned&&alive(reference.controllerPid))throw new Error('merge_original_controller_active');
  await privateDirectory(reference.directory,false);
  const input=await regular(join(reference.directory,'fixed-input.json'),128*1024),files:Record<string,string>={};
  let unstarted=true;
  for(const name of ['launch.json','process.json','exit.json','stdout.ndjson','stderr.txt','stdin.ndjson']){
    try{await lstat(join(reference.directory,name));const b=await regular(join(reference.directory,name),16*1024*1024);files[name]=hash(b);if(['launch.json','process.json','exit.json'].includes(name)||b.length)unstarted=false;}
    catch(e:any){if(e.code!=='ENOENT')throw e;}
  }
  if(!unstarted&&!reference.controllerReturned){
    const processRecord=JSON.parse((await regular(join(reference.directory,'process.json'),4096)).toString());
    // A process may have acted even when exit.json was never written. Once both
    // owner and child are gone it can be queried, but never declared unsent.
    if(alive(processRecord.pid))throw new Error('merge_original_publisher_active');
  }
  const referenceSha256=hash(canonical(reference)),inputSha256=hash(canonical(JSON.parse(input.toString()))),observedAt=new Date().toISOString();
  const proof=Buffer.from(canonical({reference,inputSha256,files,unstarted,observedAt}));
  const value=Object.freeze({referenceSha256,inputSha256,unstarted,proof,observedAt});proofs.add(value);return value;
}
export function requireMergeControllerProof(p:MergeControllerProof,ref:MergeDispatchReference,command:MergeCommand){
  if(!proofs.has(p)||p.referenceSha256!==hash(canonical(ref))||p.inputSha256!==hash(canonical(command))||Date.now()-Date.parse(p.observedAt)>60000)throw new Error('original_merge_controller_proof_required');
  const raw=JSON.parse(p.proof.toString());if(canonical(raw.reference)!==canonical(ref)||raw.inputSha256!==p.inputSha256||raw.unstarted!==p.unstarted||raw.observedAt!==p.observedAt)throw new Error('original_merge_controller_proof_changed');
}
