import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';
import type {MemberRecompositionPlan} from './member-recomposition-contract.js';

export type RecompositionGovernance={
  testAuthorityIntent:string;
  testResourceRequests:string[];
  integrationAuthorityIntent:string;
  integrationDelegation?:{authorization:string;adoption:string};
};

export function parseRecompositionGovernance(value:unknown):RecompositionGovernance{
  const g=value as RecompositionGovernance;
  if(!exactKeys(g,['testAuthorityIntent','testResourceRequests','integrationAuthorityIntent',...(g&&Object.hasOwn(g,'integrationDelegation')?['integrationDelegation']:[])])||!messageId(g.testAuthorityIntent)||!messageId(g.integrationAuthorityIntent)||g.testAuthorityIntent===g.integrationAuthorityIntent||!Array.isArray(g.testResourceRequests)||g.testResourceRequests.length>32||new Set(g.testResourceRequests).size!==g.testResourceRequests.length||!g.testResourceRequests.every(isAuthorityDigest))throw new Error('recomposition_governance_invalid');
  if(Object.hasOwn(g,'integrationDelegation')&&(!exactKeys(g.integrationDelegation,['authorization','adoption'])||![g.integrationDelegation!.authorization,g.integrationDelegation!.adoption].every(isAuthorityDigest)))throw new Error('recomposition_integration_delegation_invalid');
  return g;
}

/** The approved task binds fixed source paths and hashes, not the reservation
 * IDs later used to consume it. Including resource-request IDs here would
 * create a cycle: those IDs already contain this action's payload hash. */
export function recompositionTestPayload(p:MemberRecompositionPlan){
  return {schemaVersion:1,kind:'tongxu-recomposition-test-input',id:p.id,store:p.store,memberReturn:p.memberReturn,repairPlan:p.repairPlan,newMember:p.newMember,testPlan:p.testPlan,source:p.source,...(p.retry?{retry:p.retry}:{})};
}
export const recompositionTestPayloadSha=(p:MemberRecompositionPlan)=>hash(canonical(recompositionTestPayload(p)));
