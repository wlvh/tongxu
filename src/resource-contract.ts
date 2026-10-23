import { isAbsolute,resolve } from 'node:path';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { exactKeys,isAuthorityDigest,authorityTime,type AuthorityRole } from './authority-contract.js';
import { repoPattern } from './contract.js';

/** An adapter to an existing ledger. No local balance or refund calculation. */
export type LedgerProfile={schemaVersion:1;kind:'tongxu-existing-resource-ledger';ledgerId:string;repository:string;executionKind:'fixture'|'external';executable:string;executableSha256:string;protocol:'tongxu-existing-ledger-v1';timeoutMs:number;resources:Array<{ref:string;unit:string;maxPerClaim:number}>};
export type ResourceRequest={schemaVersion:1;ledgerId:string;repository:string;operation:string;authorityIntent:string;resourceRef:string;unit:string;quantity:number;role:AuthorityRole;actionSha256:string};
export type LedgerCommand={protocol:'tongxu-existing-ledger-v1';ledgerId:string;command:'capabilities'|'lookup'|'claim'|'record_result';requestId:string;request:ResourceRequest|null;outcome:null|{claimId:string;state:'completed'|'failed'|'cancelled';evidenceSha256:string}};
export type LedgerClaim={id:string;requestId:string;requestSha256:string;resourceRef:string;unit:string;quantity:number;state:'held'|'consumed'|'released'|'unknown';outcomeSha256:string|null};
export type LedgerReply={protocol:'tongxu-existing-ledger-v1';ledgerId:string;executionKind:'fixture'|'external';command:LedgerCommand['command'];requestId:string;inputSha256:string;observedAt:string;revision:string;result:any};
const text=(x:unknown,max=256):x is string=>typeof x==='string'&&Boolean(x.trim())&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
export const resourceRequestHash=(r:ResourceRequest)=>hash(canonical(r));
export function parseLedgerProfile(raw:Buffer):LedgerProfile{
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','ledgerId','repository','executionKind','executable','executableSha256','protocol','timeoutMs','resources'])||p.schemaVersion!==1||p.kind!=='tongxu-existing-resource-ledger'||!text(p.ledgerId,128)||!repoPattern.test(p.repository)||!['fixture','external'].includes(p.executionKind)||!text(p.executable,2048)||!isAbsolute(p.executable)||resolve(p.executable)!==p.executable||!isAuthorityDigest(p.executableSha256)||p.protocol!=='tongxu-existing-ledger-v1'||!Number.isSafeInteger(p.timeoutMs)||p.timeoutMs<1000||p.timeoutMs>60000||!Array.isArray(p.resources)||!p.resources.length||p.resources.length>32||new Set(p.resources.map((r:any)=>r?.ref)).size!==p.resources.length||p.resources.some((r:any)=>!exactKeys(r,['ref','unit','maxPerClaim'])||!text(r.ref)||!text(r.unit,64)||!Number.isSafeInteger(r.maxPerClaim)||r.maxPerClaim<1||r.maxPerClaim>1000000))throw new Error('resource_ledger_profile_invalid');
  return p;
}
export function parseResourceRequest(r:any,p:LedgerProfile):ResourceRequest{
  if(!exactKeys(r,['schemaVersion','ledgerId','repository','operation','authorityIntent','resourceRef','unit','quantity','role','actionSha256'])||r.schemaVersion!==1||r.ledgerId!==p.ledgerId||r.repository!==p.repository||!text(r.authorityIntent,128)||!/^[a-f0-9-]{36}$/.test(r.operation)||!['background','implementer','receiver','secretary','coordinator'].includes(r.role)||!isAuthorityDigest(r.actionSha256))throw new Error('resource_request_invalid');
  const spec=p.resources.find(x=>x.ref===r.resourceRef);
  if(!spec||r.unit!==spec.unit||!Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>spec.maxPerClaim)throw new Error('resource_request_outside_fixed_boundary');return r;
}
export function parseLedgerCommand(c:any,p:LedgerProfile):LedgerCommand{
  if(!exactKeys(c,['protocol','ledgerId','command','requestId','request','outcome'])||c.protocol!==p.protocol||c.ledgerId!==p.ledgerId||!['capabilities','lookup','claim','record_result'].includes(c.command)||!isAuthorityDigest(c.requestId))throw new Error('resource_command_invalid');
  if(c.command==='capabilities'){if(c.request!==null||c.outcome!==null)throw new Error('resource_capability_request_invalid');}
  else{parseResourceRequest(c.request,p);if(c.requestId!==resourceRequestHash(c.request))throw new Error('resource_request_identity_mismatch');}
  if(c.command==='record_result'){
    if(!exactKeys(c.outcome,['claimId','state','evidenceSha256'])||!text(c.outcome.claimId)||!['completed','failed','cancelled'].includes(c.outcome.state)||!isAuthorityDigest(c.outcome.evidenceSha256))throw new Error('resource_known_execution_outcome_required');
  }else if(c.outcome!==null)throw new Error('resource_unplanned_outcome');return c;
}
export function parseLedgerReply(raw:Buffer,p:LedgerProfile,c:LedgerCommand):LedgerReply{
  const x=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(x,['protocol','ledgerId','executionKind','command','requestId','inputSha256','observedAt','revision','result'])||x.protocol!==p.protocol||x.ledgerId!==p.ledgerId||x.executionKind!==p.executionKind||x.command!==c.command||x.requestId!==c.requestId||x.inputSha256!==hash(canonical(c))||!authorityTime(x.observedAt)||Math.abs(Date.now()-Date.parse(x.observedAt))>60000||!text(x.revision,128)||!x.result||typeof x.result!=='object'||Array.isArray(x.result))throw new Error('resource_reply_identity_or_frame_invalid');
  const r=x.result;
  if(c.command==='capabilities'){
    if(!exactKeys(r,['credentialState','claim','recordResult','idempotency','lookup'])||!['available','unavailable'].includes(r.credentialState)||typeof r.claim!=='boolean'||typeof r.recordResult!=='boolean'||r.idempotency!=='same_request_same_effect'||r.lookup!=='durable_request_id')throw new Error('resource_provider_capability_unknown');
  }else{
    if(!exactKeys(r,['state','reason','claim'])||!['present','absent','refused','unknown'].includes(r.state)||!(r.reason===null||text(r.reason,512)))throw new Error('resource_reply_state_invalid');
    if(r.state==='present'){
      const v=r.claim,q=c.request!;
      if(!exactKeys(v,['id','requestId','requestSha256','resourceRef','unit','quantity','state','outcomeSha256'])||!text(v.id)||v.requestId!==c.requestId||v.requestSha256!==resourceRequestHash(q)||v.resourceRef!==q.resourceRef||v.unit!==q.unit||v.quantity!==q.quantity||!['held','consumed','released','unknown'].includes(v.state)||!(v.outcomeSha256===null||isAuthorityDigest(v.outcomeSha256)))throw new Error('resource_original_claim_mismatch');
      if(c.command==='record_result'&&(v.id!==c.outcome!.claimId||v.outcomeSha256!==hash(canonical(c.outcome))))throw new Error('resource_outcome_receipt_mismatch');
    }else if(r.claim!==null)throw new Error('resource_claim_state_contradiction');
    if(c.command==='claim'&&r.state==='absent')throw new Error('resource_claim_response_incomplete');
  }
  return x;
}
