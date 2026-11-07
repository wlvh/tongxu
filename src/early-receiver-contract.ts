import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {canonical} from './comparison.js';

/** The host binds complete current material, including consumers and declared
 * write responsibilities. A model can advise on it; it cannot choose another
 * source, create a final receiver judgment, or grant implementation authority. */
export type EarlyReceiverAdviceBinding={relationSha256:string;materialSha256:string;parts:Array<{id:string;hash:string}>};
export type EarlyReceiverAdvice={
 schemaVersion:1;kind:'tongxu-early-receiver-advice';relationSha256:string;materialSha256:string;
 parts:Array<{id:string;hash:string;position:'compatible'|'conflict'|'unknown';report:string}>;
 report:string;
};
const report=(v:unknown,max:number):v is string=>typeof v==='string'&&Boolean(v.trim())&&!v.includes('\0')&&Buffer.byteLength(v)<=max;
export function parseEarlyReceiverAdvice(raw:Buffer,binding:EarlyReceiverAdviceBinding):EarlyReceiverAdvice{
 if(raw.length>128*1024)throw new Error('early_receiver_advice_limit');
 if(!isAuthorityDigest(binding.relationSha256)||!isAuthorityDigest(binding.materialSha256)||!Array.isArray(binding.parts)||!binding.parts.length||binding.parts.length>16||new Set(binding.parts.map(p=>p.id)).size!==binding.parts.length||binding.parts.some(p=>!messageId(p.id)||!isAuthorityDigest(p.hash)))throw new Error('early_receiver_host_binding_invalid');
 let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('early_receiver_advice_invalid');}
 if(!exactKeys(p,['schemaVersion','kind','relationSha256','materialSha256','parts','report'])||p.schemaVersion!==1||p.kind!=='tongxu-early-receiver-advice'||p.relationSha256!==binding.relationSha256||p.materialSha256!==binding.materialSha256||!Array.isArray(p.parts)||p.parts.length!==binding.parts.length||!report(p.report,48*1024))throw new Error('early_receiver_advice_binding_invalid');
 const ids=new Set<string>();for(const part of p.parts){
  if(!exactKeys(part,['id','hash','position','report'])||ids.has(part.id)||!binding.parts.some(expected=>expected.id===part.id&&expected.hash===part.hash)||!['compatible','conflict','unknown'].includes(part.position)||!report(part.report,16*1024))throw new Error('early_receiver_part_binding_invalid');ids.add(part.id);
 }
 // Canonical host order avoids treating an arbitrary model ordering as a new
 // member selection. Original raw reply bytes remain in the message capture.
 return {...p,parts:binding.parts.map(expected=>p.parts.find((part:EarlyReceiverAdvice['parts'][number])=>part.id===expected.id))};
}
export const earlyReceiverAdviceSchema=(binding:EarlyReceiverAdviceBinding)=>({
 type:'object',additionalProperties:false,
 properties:{schemaVersion:{type:'integer',enum:[1]},kind:{type:'string',enum:['tongxu-early-receiver-advice']},relationSha256:{type:'string',enum:[binding.relationSha256]},materialSha256:{type:'string',enum:[binding.materialSha256]},parts:{type:'array',minItems:binding.parts.length,maxItems:binding.parts.length,items:{type:'object',additionalProperties:false,properties:{id:{type:'string',enum:binding.parts.map(p=>p.id)},hash:{type:'string',enum:binding.parts.map(p=>p.hash)},position:{type:'string',enum:['compatible','conflict','unknown']},report:{type:'string'}},required:['id','hash','position','report']}},report:{type:'string'}},
 required:['schemaVersion','kind','relationSha256','materialSha256','parts','report']
});
export const earlyReceiverAdviceInstructions=(binding:EarlyReceiverAdviceBinding)=>'Give early compatibility and handoff advice on the complete fixed material. Consumers and declared write responsibilities are data to challenge, not verified ownership or permissions. Return your complete report as JSON matching '+canonical(earlyReceiverAdviceSchema(binding))+'. Use conflict or unknown when evidence is insufficient. This is early advice only: no final technical acceptance, PASS, implementation permission or owner decision. Keep complete substantive reasoning in report and each part report.';
