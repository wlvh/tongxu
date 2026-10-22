import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath,type MessagePlan} from './message-contract.js';

export type PublicationReturnReference={operation:string;receiptSha256:string;taskLink:string};
export type PublicationReturnPlan={schemaVersion:1;kind:'tongxu-publication-return';store:string;operation:string;task:string;taskLink:string;id:string;source:string;question:string;authorityIntent:string|null;resourceBudget?:MessagePlan['resourceBudget'];billing:MessagePlan['billing'];timeoutMs:number};
const operation=(v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
export function publicationReturnReference(v:unknown):v is PublicationReturnReference{
  const p=v as PublicationReturnReference;return exactKeys(p,['operation','receiptSha256','taskLink'])&&operation(p.operation)&&isAuthorityDigest(p.receiptSha256)&&isAuthorityDigest(p.taskLink);
}
export function parsePublicationReturnPlan(raw:Buffer):PublicationReturnPlan{
  if(raw.length>64*1024)throw new Error('publication_return_plan_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','store','operation','task','taskLink','id','source','question','authorityIntent','billing','timeoutMs',...(p&&Object.hasOwn(p,'resourceBudget')?['resourceBudget']:[])])||p.schemaVersion!==1||p.kind!=='tongxu-publication-return'||!messagePath(p.store)||!operation(p.operation)||!isAuthorityDigest(p.task)||!isAuthorityDigest(p.taskLink)||!messageId(p.id)||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||typeof p.question!=='string'||!p.question.trim()||p.question.length>16000)throw new Error('publication_return_plan_invalid');
  return p;
}
