import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';

/** Select original queue facts, not a report-authored recipe. The workspace is
 * derived by the controller from this request; no caller-supplied output path,
 * shell command, target update, acceptance or merge grant is accepted here. */
export type IntegrationRequest={
  schemaVersion:1;
  kind:'tongxu-minimal-integration';
  id:string;
  operation:string;
  subjectSha256:string;
  scopeSha256:string;
  arrangementSha256:string;
  objects:string;
  selectionReason:string;
  source:string;
  authorityIntent:string|null;
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&Boolean(x.trim())&&x.length<=max&&!x.includes('\0');
export function parseIntegrationRequest(raw:Buffer):IntegrationRequest{
  if(raw.length>32*1024)throw new Error('integration_request_too_large');
  let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('integration_request_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','id','operation','subjectSha256','scopeSha256','arrangementSha256','objects','selectionReason','source','authorityIntent'])||p.schemaVersion!==1||p.kind!=='tongxu-minimal-integration'||!messageId(p.id)||typeof p.operation!=='string'||!uuid.test(p.operation)||![p.subjectSha256,p.scopeSha256,p.arrangementSha256].every(isAuthorityDigest)||!messagePath(p.objects)||!text(p.selectionReason,8192)||!text(p.source,2048)||!(p.authorityIntent===null||messageId(p.authorityIntent)))throw new Error('integration_request_invalid');
  return p;
}
export const integrationRequestSha256=(p:IntegrationRequest)=>hash(canonical(p));
export type IntegrationCandidateRequest={schemaVersion:1;kind:'tongxu-integration-candidate';integration:string;item:string;packet:number;fingerprint:string;source:string};
export function parseIntegrationCandidate(raw:Buffer):IntegrationCandidateRequest{
  if(raw.length>32*1024)throw new Error('integration_candidate_request_invalid');let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('integration_candidate_request_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','integration','item','packet','fingerprint','source'])||p.schemaVersion!==1||p.kind!=='tongxu-integration-candidate'||!messageId(p.integration)||!isAuthorityDigest(p.item)||!isAuthorityDigest(p.fingerprint)||!Number.isSafeInteger(p.packet)||p.packet<1||!text(p.source,2048))throw new Error('integration_candidate_request_invalid');return p;
}
