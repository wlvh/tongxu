import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {shaPattern} from './contract.js';

/** This selects original evidence for a member return. It does not grant
 * writes, nominate a new command or manufacture an individual reception. */
export type IntegrationMemberReturn={
  schemaVersion:1;kind:'tongxu-integration-member-return';id:string;integration:string;
  reception:{operation:string;packet:number;bindingHash:string;judgmentId:string;inputSha256:string;finalSha256:string};
  member:{index:number;H:string;B:string;manifestSha256:string;item:string;packet:number;fingerprint:string};
  scopeSha256:string;arrangementSha256:string;findingIndexes:number[];source:string;
};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const positive=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>0;
export function parseIntegrationMemberReturn(raw:Buffer):IntegrationMemberReturn{
  if(raw.length>32*1024)throw new Error('integration_member_return_invalid');let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('integration_member_return_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','id','integration','reception','member','scopeSha256','arrangementSha256','findingIndexes','source'])||p.schemaVersion!==1||p.kind!=='tongxu-integration-member-return'||!messageId(p.id)||!messageId(p.integration)||!isAuthorityDigest(p.scopeSha256)||!isAuthorityDigest(p.arrangementSha256)||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||p.source.includes('\0'))throw new Error('integration_member_return_invalid');
  const r=p.reception,m=p.member;
  if(!exactKeys(r,['operation','packet','bindingHash','judgmentId','inputSha256','finalSha256'])||!uuid(r.operation)||!uuid(r.judgmentId)||!positive(r.packet)||![r.bindingHash,r.inputSha256,r.finalSha256].every(isAuthorityDigest)||!exactKeys(m,['index','H','B','manifestSha256','item','packet','fingerprint'])||!Number.isSafeInteger(m.index)||m.index<0||m.index>7||![m.H,m.B].every(x=>typeof x==='string'&&shaPattern.test(x))||![m.manifestSha256,m.item,m.fingerprint].every(isAuthorityDigest)||!positive(m.packet))throw new Error('integration_member_original_reference_invalid');
  if(!Array.isArray(p.findingIndexes)||!p.findingIndexes.length||p.findingIndexes.length>30||p.findingIndexes.some((x:unknown,i:number)=>!Number.isSafeInteger(x)||Number(x)<0||Number(x)>29||i>0&&p.findingIndexes[i-1]>=Number(x)))throw new Error('integration_member_finding_selection_invalid');
  return p;
}
export const integrationMemberReturnSha256=(p:IntegrationMemberReturn)=>hash(canonical(p));
export type MemberReturnReference={id:string;requestSha256:string;sourceSha256:string};
export function memberReturnReference(x:unknown):x is MemberReturnReference{return exactKeys(x,['id','requestSha256','sourceSha256'])&&messageId((x as MemberReturnReference).id)&&isAuthorityDigest((x as MemberReturnReference).requestSha256)&&isAuthorityDigest((x as MemberReturnReference).sourceSha256);}
