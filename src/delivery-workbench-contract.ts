import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,type MessagePlan,type MessageParticipant} from './message-contract.js';
import {parseDeliveryValidation,type DeliveryValidationPlan} from './delivery-validation-contract.js';
import {parseAssessmentRequest} from './delivery-assessment-contract.js';
import {canonical} from './comparison.js';

type Base={id:string;title:string;source:string};
export type DeliveryValidationProfile=Base&{kind:'validation';snapshots:DeliveryValidationPlan['snapshots'];objects:string;testPlan:DeliveryValidationPlan['testPlan'];demonstrationFixture:boolean};
export type DeliveryAssessmentProfile=Base&{kind:'assessment';runner:Omit<MessageParticipant,'id'|'item'|'role'|'parent'>;executionKind:MessagePlan['executionKind'];timeoutMs:number;billing:MessagePlan['billing'];resourceBudget?:MessagePlan['resourceBudget']};
export type DeliveryExecutionProfile=DeliveryValidationProfile|DeliveryAssessmentProfile;
export type DeliveryExecutionCatalog={schemaVersion:1;kind:'tongxu-delivery-execution-profiles';profiles:DeliveryExecutionProfile[]};
const digest='0'.repeat(64);
export function parseDeliveryProfiles(raw:Buffer,sources:readonly string[]):DeliveryExecutionCatalog{
 if(raw.length>256*1024)throw new Error('delivery_profiles_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
 if(!exactKeys(p,['schemaVersion','kind','profiles'])||p.schemaVersion!==1||p.kind!=='tongxu-delivery-execution-profiles'||!Array.isArray(p.profiles)||!p.profiles.length||p.profiles.length>16)throw new Error('delivery_profiles_invalid');
 const seen=new Set();for(const f of p.profiles){if(!messageId(f?.id)||seen.has(f.id)||typeof f.title!=='string'||!f.title.trim()||f.title.length>160||/[\x00-\x1f]/.test(f.title)||!sources.includes(f.source))throw new Error('delivery_profile_selection_invalid');seen.add(f.id);
  if(f.kind==='validation'){
   if(!exactKeys(f,['id','title','source','kind','snapshots','objects','testPlan','demonstrationFixture']))throw new Error('delivery_profile_invalid');
   parseDeliveryValidation(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-delivery-validation',id:'profile',batchSha256:digest,member:digest,source:'trusted workbench profile',authorityIntent:'profile',snapshots:f.snapshots,objects:f.objects,testPlan:f.testPlan,demonstrationFixture:f.demonstrationFixture,scenarios:[{scenario:'profile',tool:'profile',samples:['profile']}]})));
  }else if(f.kind==='assessment'){
   if(!exactKeys(f,['id','title','source','kind','runner','executionKind','timeoutMs','billing',...(Object.hasOwn(f,'resourceBudget')?['resourceBudget']:[])]))throw new Error('delivery_profile_invalid');
   parseAssessmentRequest(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-delivery-assessment',id:'profile',batchSha256:digest,evidenceSha256:digest,member:digest,source:'trusted workbench profile',authorityIntent:'profile',scenarios:['profile'],validations:['profile'],question:'Check selected originals only.',runner:f.runner,executionKind:f.executionKind,timeoutMs:f.timeoutMs,billing:f.billing,...(f.resourceBudget?{resourceBudget:f.resourceBudget}:{})})));
  }else throw new Error('delivery_profile_kind_invalid');
 }return p;
}
export type DeliveryExecutionPreparation={id:string;batchSha256:string;member:string;profileSha256:string;profile:DeliveryExecutionProfile;evidenceSha256:string;scenarios:string[];validations:string[];mappings:Array<{scenario:string;tool:string;samples:string[]}>;question:string};
export function checkDeliveryExecutionPreparation(p:DeliveryExecutionPreparation){
 if(!exactKeys(p,['id','batchSha256','member','profileSha256','profile','evidenceSha256','scenarios','validations','mappings','question'])||!messageId(p.id)||![p.batchSha256,p.member,p.profileSha256,p.evidenceSha256].every(isAuthorityDigest)||!Array.isArray(p.scenarios)||!p.scenarios.length||p.scenarios.length>52||new Set(p.scenarios).size!==p.scenarios.length||p.scenarios.some(s=>!messageId(s))||!Array.isArray(p.validations)||p.validations.length>8||new Set(p.validations).size!==p.validations.length||p.validations.some(s=>!messageId(s))||!Array.isArray(p.mappings)||p.mappings.length>52||typeof p.question!=='string'||p.question.length>8192||p.question.includes('\0'))throw new Error('delivery_execution_preparation_invalid');
 parseDeliveryProfiles(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-delivery-execution-profiles',profiles:[p.profile]})),[p.profile.source]);
 if(p.profile.kind==='validation'&&(p.validations.length||p.question||canonical(p.scenarios.slice().sort())!==canonical(p.mappings.map(m=>m.scenario).sort())))throw new Error('delivery_validation_selection_invalid');
 if(p.profile.kind==='assessment'&&(!p.validations.length||p.mappings.length||!p.question.trim()))throw new Error('delivery_assessment_selection_invalid');
}
