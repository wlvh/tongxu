import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {repoPattern,validBranchRef} from './contract.js';

export type ConditionalRef={path:string;sha256:string};
export type ConditionalDelegation={adoption:string;authorization:string};
export type ConditionalBudgetAuthorization=ConditionalDelegation&{budgets:Array<{ledgerId:string;resourceRef:string;unit:string;quantity:number}>};
export type ConditionalRepairCapability={task:string;profile:ConditionalRef;authorization:ConditionalBudgetAuthorization|null;postRepair?:{testPlan:ConditionalRef;validationAuthorization:ConditionalBudgetAuthorization|null;recompositionAuthorization:ConditionalBudgetAuthorization|null}};
export type ConditionalChoice={id:string;title:string;plan:ConditionalRef;execution:ConditionalRef};
export type ConditionalEntryPlan={
 schemaVersion:1;kind:'tongxu-conditional-delivery-entry';id:string;title:string;store:string;repository:string;target:string;
 coordination:{plan:ConditionalRef;execution:ConditionalRef;choices?:ConditionalChoice[]};
 repairs?:ConditionalRepairCapability[];
 integration:{item:string;members:string[];gateStage:'implement'|'receive';objects:string;selectionReason:string;authorization:ConditionalDelegation|null;
  testPlan:ConditionalRef;receiverTemplate:ConditionalRef;
  receiverAuthorization:ConditionalBudgetAuthorization|null;validationAuthorization?:ConditionalBudgetAuthorization|null;
  sourceReader:{repositoryId:number;ghExecutable:string;ghSha256:string;issues:number[];executionKind?:'github'|'fixture'}};
};
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!v.includes('\0');
const ref=(v:any):v is ConditionalRef=>exactKeys(v,['path','sha256'])&&messagePath(v.path)&&isAuthorityDigest(v.sha256);
const delegation=(v:any):v is ConditionalDelegation=>exactKeys(v,['adoption','authorization'])&&isAuthorityDigest(v.adoption)&&isAuthorityDigest(v.authorization);
/** A finite installed capability, not an editable list of workflow commands.
 * Future packet, operation, candidate and resource identities are absent. */
export function parseConditionalEntry(raw:Buffer):ConditionalEntryPlan{
 if(raw.length>128*1024)throw new Error('conditional_entry_limit');
 let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('conditional_entry_invalid');}
 if(!exactKeys(p,['schemaVersion','kind','id','title','store','repository','target','coordination','integration',...(Object.hasOwn(p??{},'repairs')?['repairs']:[])])||p.schemaVersion!==1||p.kind!=='tongxu-conditional-delivery-entry'||!messageId(p.id)||!text(p.title,160)||!messagePath(p.store)||!repoPattern.test(p.repository)||!validBranchRef(p.target)||!exactKeys(p.coordination,['plan','execution',...(Object.hasOwn(p.coordination??{},'choices')?['choices']:[])])||!ref(p.coordination.plan)||!ref(p.coordination.execution))throw new Error('conditional_entry_invalid');
 if(Object.hasOwn(p.coordination,'choices')&&(!Array.isArray(p.coordination.choices)||p.coordination.choices.length>2||new Set(p.coordination.choices.map((c:any)=>c?.id)).size!==p.coordination.choices.length||p.coordination.choices.some((c:any)=>!exactKeys(c,['id','title','plan','execution'])||!messageId(c.id)||c.id==='default'||!text(c.title,160)||!ref(c.plan)||!ref(c.execution))))throw new Error('conditional_entry_choice_invalid');
 if(Object.hasOwn(p,'repairs')&&(!Array.isArray(p.repairs)||p.repairs.length>8||new Set(p.repairs.map((r:any)=>r?.task)).size!==p.repairs.length||p.repairs.some((r:any)=>!exactKeys(r,['task','profile','authorization',...(Object.hasOwn(r??{},'postRepair')?['postRepair']:[])])||!messageId(r.task)||!ref(r.profile)||Object.hasOwn(r,'postRepair')&&(!exactKeys(r.postRepair,['testPlan','validationAuthorization','recompositionAuthorization'])||!ref(r.postRepair.testPlan)))))throw new Error('conditional_entry_repair_capability_invalid');
 const i=p.integration;
 if(!exactKeys(i,['item','members','gateStage','objects','selectionReason','authorization','testPlan','receiverTemplate','receiverAuthorization','sourceReader',...(Object.hasOwn(i??{},'validationAuthorization')?['validationAuthorization']:[])])||!isAuthorityDigest(i.item)||!Array.isArray(i.members)||i.members.length<2||i.members.length>8||new Set(i.members).size!==i.members.length||i.members.some((id:unknown)=>!messageId(id))||!['implement','receive'].includes(i.gateStage)||!messagePath(i.objects)||!text(i.selectionReason,8192)||!(i.authorization===null||delegation(i.authorization))||!ref(i.testPlan)||!ref(i.receiverTemplate))throw new Error('conditional_entry_integration_invalid');
 for(const a of [i.receiverAuthorization,...(Object.hasOwn(i,'validationAuthorization')?[i.validationAuthorization]:[]),...(p.repairs??[]).flatMap((r:any)=>[r.authorization,...(r.postRepair?[r.postRepair.validationAuthorization,r.postRepair.recompositionAuthorization]:[])])])if(a!==null&&(!exactKeys(a,['adoption','authorization','budgets'])||!delegation({adoption:a.adoption,authorization:a.authorization})||!Array.isArray(a.budgets)||a.budgets.length>16||new Set(a.budgets.map((b:any)=>b.resourceRef)).size!==a.budgets.length||a.budgets.some((b:any)=>!exactKeys(b,['ledgerId','resourceRef','unit','quantity'])||![b.ledgerId,b.resourceRef,b.unit].every(x=>text(x,256))||!Number.isSafeInteger(b.quantity)||b.quantity<1)))throw new Error('conditional_entry_receiver_authority_invalid');
 const s=i.sourceReader;if(!exactKeys(s,['repositoryId','ghExecutable','ghSha256','issues',...(Object.hasOwn(s??{},'executionKind')?['executionKind']:[])])||Object.hasOwn(s??{},'executionKind')&&!['github','fixture'].includes(s.executionKind)||!Number.isSafeInteger(s.repositoryId)||s.repositoryId<1||!messagePath(s.ghExecutable)||!isAuthorityDigest(s.ghSha256)||!Array.isArray(s.issues)||s.issues.length>32||new Set(s.issues).size!==s.issues.length||s.issues.some((n:unknown)=>!Number.isSafeInteger(n)||Number(n)<1))throw new Error('conditional_entry_source_reader_invalid');
 return p;
}
