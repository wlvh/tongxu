import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
type FileRef={path:string;sha256:string};
export type DeliveryValidationPlan={
  schemaVersion:1;kind:'tongxu-delivery-validation';id:string;batchSha256:string;member:string;
  source:string;demonstrationFixture:boolean;authorityIntent:string|null;
  snapshots:FileRef[];objects:string;testPlan:FileRef;
  scenarios:Array<{scenario:string;tool:string;samples:string[]}>;
};
export function parseDeliveryValidation(raw:Buffer):DeliveryValidationPlan{
  if(raw.length>64*1024)throw new Error('delivery_validation_plan_size');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  const ref=(x:any)=>exactKeys(x,['path','sha256'])&&messagePath(x.path)&&isAuthorityDigest(x.sha256);
  if(!exactKeys(p,['schemaVersion','kind','id','batchSha256','member','source','demonstrationFixture','authorityIntent','snapshots','objects','testPlan','scenarios'])||p.schemaVersion!==1||p.kind!=='tongxu-delivery-validation'||!messageId(p.id)||!isAuthorityDigest(p.batchSha256)||!isAuthorityDigest(p.member)||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||p.source.includes('\0')||typeof p.demonstrationFixture!=='boolean'||!(p.authorityIntent===null||messageId(p.authorityIntent))||!messagePath(p.objects)||!ref(p.testPlan)||!Array.isArray(p.snapshots)||!p.snapshots.length||p.snapshots.length>8||p.snapshots.some((s:any)=>!ref(s))||new Set(p.snapshots.map((s:any)=>s.path)).size!==p.snapshots.length)throw new Error('delivery_validation_plan_invalid');
  if(!Array.isArray(p.scenarios)||!p.scenarios.length||p.scenarios.length>52||new Set(p.scenarios.map((s:any)=>s.scenario)).size!==p.scenarios.length||p.scenarios.some((s:any)=>!exactKeys(s,['scenario','tool','samples'])||!messageId(s.scenario)||typeof s.tool!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(s.tool)||!Array.isArray(s.samples)||!s.samples.length||s.samples.length>64||new Set(s.samples).size!==s.samples.length||s.samples.some((x:unknown)=>typeof x!=='string'||!x.trim()||x.length>256||x.includes('\0'))))throw new Error('delivery_validation_scenario_invalid');
  return p;
}
export const deliveryValidationSha=(p:DeliveryValidationPlan)=>hash(canonical(p));
