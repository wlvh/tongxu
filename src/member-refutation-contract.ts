import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath,checkMessageResources,type MessageResourceBudget} from './message-contract.js';
import {memberReturnReference,type MemberReturnReference} from './integration-member-contract.js';

export type MemberRefutationRequest={schemaVersion:1;kind:'tongxu-member-refutation';id:string;memberReturn:MemberReturnReference;repair:{operation:string;planSha256:string;bindingHash:string;resultSha256:string;evidenceSha256:string};source:string};
export function parseMemberRefutationRequest(raw:Buffer):MemberRefutationRequest{
  let p:any;try{if(raw.length>32768)throw new Error();p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('member_refutation_request_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','id','memberReturn','repair','source'])||p.schemaVersion!==1||p.kind!=='tongxu-member-refutation'||!messageId(p.id)||!memberReturnReference(p.memberReturn)||!exactKeys(p.repair,['operation','planSha256','bindingHash','resultSha256','evidenceSha256'])||typeof p.repair.operation!=='string'||!/^[a-f0-9-]{36}$/.test(p.repair.operation)||!['planSha256','bindingHash','resultSha256','evidenceSha256'].every(k=>isAuthorityDigest(p.repair[k]))||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||/[\x00-\x1f\x7f]/.test(p.source))throw new Error('member_refutation_request_invalid');
  return p;
}
type Ref={path:string;sha256:string};
export type RefutationGovernance={authorityIntent:string;adoption:string;delegation?:string;resourceBudget:MessageResourceBudget[]};
export type MemberRefutationPlan={schemaVersion:1;kind:'tongxu-member-refutation-reception';id:string;store:string;memberReturn:MemberReturnReference;repairPlan:Ref;receiverPlan:Ref;source:string;governance?:RefutationGovernance};
export function parseMemberRefutationPlan(raw:Buffer):MemberRefutationPlan{
  let p:any;try{if(raw.length>32768)throw new Error();p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('member_refutation_plan_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','id','store','memberReturn','repairPlan','receiverPlan','source',...(p&&Object.hasOwn(p,'governance')?['governance']:[])])||p.schemaVersion!==1||p.kind!=='tongxu-member-refutation-reception'||!messageId(p.id)||!messagePath(p.store)||!memberReturnReference(p.memberReturn)||![p.repairPlan,p.receiverPlan].every(r=>exactKeys(r,['path','sha256'])&&messagePath(r.path)&&isAuthorityDigest(r.sha256))||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||/[\x00-\x1f\x7f]/.test(p.source))throw new Error('member_refutation_plan_invalid');
  if(Object.hasOwn(p,'governance')){const g=p.governance;if(!exactKeys(g,['authorityIntent','adoption','resourceBudget',...(g&&Object.hasOwn(g,'delegation')?['delegation']:[])])||!messageId(g.authorityIntent)||!isAuthorityDigest(g.adoption)||Object.hasOwn(g,'delegation')&&!isAuthorityDigest(g.delegation)||!Array.isArray(g.resourceBudget))throw new Error('member_refutation_governance_invalid');if(g.resourceBudget.length)checkMessageResources(g.resourceBudget);}
  return p;
}
