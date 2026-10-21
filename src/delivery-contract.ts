import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {repoPattern,validBranchRef} from './contract.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';

export type DeliveryBatch={
  schemaVersion:1;kind:'tongxu-delivery-batch';id:string;revision:number;previous:string|null;
  repository:string;issue:number;title:string;source:string;target:string;
  scope:{id:string;version:string;adoption:string|null};
  goals:string[];nonGoals:string[];
  members:Array<{item:string;packet:number;fingerprint:string}>;
  scenarios:Array<{id:string;title:string;expected:string;members:string[]}>;
  related:Array<{batch:string;relation:'next_batch'|'related'}>;
};
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&!!x.trim()&&x.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x);
const strings=(x:unknown,max:number,length:number):x is string[]=>Array.isArray(x)&&x.length<=max&&new Set(x).size===x.length&&x.every(s=>text(s,length));
export function parseDeliveryBatch(raw:Buffer):DeliveryBatch{
  if(raw.length>256*1024)throw new Error('delivery_batch_size');
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','id','revision','previous','repository','issue','title','source','target','scope','goals','nonGoals','members','scenarios','related'])||p.schemaVersion!==1||p.kind!=='tongxu-delivery-batch'||!messageId(p.id)||!Number.isSafeInteger(p.revision)||p.revision<1||!(p.previous===null||isAuthorityDigest(p.previous))||(p.revision===1)!==(p.previous===null)||typeof p.repository!=='string'||!repoPattern.test(p.repository)||!Number.isSafeInteger(p.issue)||p.issue<1||!text(p.title,160)||!text(p.source,2048)||!validBranchRef(p.target)||!exactKeys(p.scope,['id','version','adoption'])||!text(p.scope.id,128)||!text(p.scope.version,128)||!(p.scope.adoption===null||isAuthorityDigest(p.scope.adoption))||!strings(p.goals,32,2048)||!p.goals.length||!strings(p.nonGoals,32,2048))throw new Error('delivery_batch_invalid');
  if(!Array.isArray(p.members)||!p.members.length||p.members.length>16||new Set(p.members.map((m:any)=>m?.item)).size!==p.members.length||p.members.some((m:any)=>!exactKeys(m,['item','packet','fingerprint'])||!isAuthorityDigest(m.item)||!Number.isSafeInteger(m.packet)||m.packet<1||!isAuthorityDigest(m.fingerprint)))throw new Error('delivery_batch_members_invalid');
  const members=new Set(p.members.map((m:any)=>m.item));
  if(!Array.isArray(p.scenarios)||!p.scenarios.length||p.scenarios.length>52||new Set(p.scenarios.map((s:any)=>s?.id)).size!==p.scenarios.length||p.scenarios.some((s:any)=>!exactKeys(s,['id','title','expected','members'])||!messageId(s.id)||!text(s.title,160)||!text(s.expected,8192)||!Array.isArray(s.members)||!s.members.length||s.members.length>16||new Set(s.members).size!==s.members.length||s.members.some((m:unknown)=>!members.has(m))))throw new Error('delivery_batch_scenarios_invalid');
  if(!Array.isArray(p.related)||p.related.length>16||new Set(p.related.map((r:any)=>r?.batch)).size!==p.related.length||p.related.some((r:any)=>!exactKeys(r,['batch','relation'])||!isAuthorityDigest(r.batch)||!['next_batch','related'].includes(r.relation)))throw new Error('delivery_batch_relation_invalid');
  return p;
}
export const deliveryBatchSha=(batch:DeliveryBatch)=>hash(canonical(batch));
