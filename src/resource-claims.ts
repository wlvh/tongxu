import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { QueueStore } from './queue-store.js';
import { privateDirectory } from './snapshot.js';
import { readOwnerSource,type OwnerObservation } from './authority-source.js';
import { callResourceProvider,inspectResourceUnstarted } from './resource-provider.js';
import { parseResourceRequest,resourceRequestHash,type ResourceRequest } from './resource-contract.js';
import type { AuthorityRole } from './authority-contract.js';

async function sourceObservations(q:QueueStore,intent:string,directory:string){
  const a=q.authority(),record=a.reservedAction(intent),profile=a.configuration().profile,observations:OwnerObservation[]=[];
  for(const ref of a.sourceRequests(record.authorization))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(directory,'owner-'+randomUUID())));
  return observations;
}
/** Role is selected by the trusted entry point, never a request-file override. */
export async function prepareResourceRequest(store:string,raw:Buffer,callerRole:AuthorityRole){
  const q=await QueueStore.open(store);
  try{
    const decoded=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw)),p=q.resources().configuration(decoded?.ledgerId),request=parseResourceRequest(decoded,p);
    if(request.role!==callerRole)throw new Error('resource_trusted_role_mismatch');
    let original=false;try{q.resources().status(resourceRequestHash(request));original=true;}catch(e){if(!(e instanceof Error)||e.message!=='original_resource_request_required')throw e;}
    if(original)return q.resources().prepare(request,[],callerRole);
    const directory=join(store,'resource-preparation-'+randomUUID());await privateDirectory(directory,true);
    return q.resources().prepare(request,await sourceObservations(q,request.authorityIntent,directory),callerRole);
  }finally{q.close();}
}
export async function resourceAction(store:string,id:string,action:'claim'|'retry-refused'|'lookup'|'record-result',callerRole:AuthorityRole){
  const q=await QueueStore.open(store);
  try{
    const r=q.resources(),old=r.status(id),p=r.configuration(old.request.ledgerId),request=old.request as ResourceRequest;
    if(request.role!==callerRole&&!(callerRole==='background'&&['lookup','record-result'].includes(action)))throw new Error('resource_trusted_role_mismatch');
    if(action==='claim'&&old.state!=='prepared_not_sent')return {...old,duplicate:true,next:old.state==='claim_unknown'?'lookup_original_ledger_request':'read_original_resource_state',newProviderCall:false};
    if(action==='retry-refused'&&old.state!=='refused')throw new Error('explicit_resource_refused_retry_only');
    if(action==='record-result'){
      const prepared=r.prepareOutcome(id);
      if(prepared.state==='result_conflict')throw new Error('resource_original_result_conflict_requires_inspection');
      if(prepared.claim?.outcomeSha256===prepared.outcome?.outcomeSha256)return {...prepared,duplicate:true,newProviderCall:false};
      if(prepared.pendingResultAttempt)return {...prepared,next:'lookup_original_ledger_request',newProviderCall:false};
    }
    const directory=join(store,'resource-'+id);try{await mkdir(directory,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}await privateDirectory(directory,false);
    if(action==='lookup'){
      const command=r.command(id,'lookup'),capture=join(directory,'lookup-'+randomUUID());
      try{return {...r.observe(id,command,await callResourceProvider(p,command,capture)),newProviderCall:true,providerWrite:false};}
      catch(e){r.problem(id,e instanceof Error?e.message:'original_ledger_lookup_failed',capture);throw e;}
    }
    const capDir=join(directory,'capabilities-'+randomUUID()),cap=await callResourceProvider(p,r.command(id,'capabilities'),capDir),kind=action==='record-result'?'record_result':'claim',command=r.command(id,kind),capture=join(directory,kind+'-'+randomUUID());
    // New claims need fresh source checks; reporting a proven old execution is
    // factual cleanup even after revocation, never permission to start work.
    const observations=kind==='claim'?await sourceObservations(q,request.authorityIntent,directory):[];
    let registered=false;
    try{
      const reply=await callResourceProvider(p,command,capture,dir=>{if(kind==='claim')r.dispatchClaim(id,cap,observations,callerRole,dir,action==='retry-refused');else r.dispatchResult(id,cap,dir);registered=true;},cap.executableSelection);
      return {...r.observe(id,command,reply),newProviderCall:true,providerWrite:true};
    }catch(e){r.problem(id,e instanceof Error?e.message:'original_ledger_request_unknown',capture);throw e;}
    finally{if(registered)r.controllerReturned(id,kind==='claim'?'claim':'result',capture);}
  }finally{q.close();}
}
export async function closeUnstartedResource(store:string,id:string,phase:'claim'|'result'){
  const q=await QueueStore.open(store);
  try{const r=q.resources(),ref=r.originalDispatch(id,phase),proof=await inspectResourceUnstarted(ref);return r.closeUnstarted(id,phase,proof);}finally{q.close();}
}
