import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';
import type {ConditionalCollection,ConditionalMemberCollection} from './conditional-entry-source.js';
import type {AuthorityCandidateSource} from './authority-contract.js';
import type {ConditionalRef} from './conditional-entry-contract.js';

type CandidateValidationBase={
 schemaVersion:1;id:string;store:string;entry:string;originPlan:string;collectionKey:string;
 manifestSha256:string;testPlan:ConditionalRef;directory:string;
 governance:{authorityIntent:string;resourceRequests:string[]}|null;
};
export type IntegrationCandidateValidationPlan=CandidateValidationBase&{kind:'tongxu-integration-candidate-validation';collection:ConditionalCollection};
export type MemberCandidateValidationPlan=CandidateValidationBase&{kind:'tongxu-member-candidate-validation';collection:ConditionalMemberCollection;candidateSource?:AuthorityCandidateSource};
export type CandidateValidationPlan=IntegrationCandidateValidationPlan|MemberCandidateValidationPlan;
export const candidateValidationSourceKey=(p:CandidateValidationPlan)=>p.kind==='tongxu-integration-candidate-validation'?p.collection.integration:'member-'+hash(canonical(p.collection.repair));
export const candidateValidationProducerKind=(p:CandidateValidationPlan)=>p.kind==='tongxu-integration-candidate-validation'?'tongxu-integration-candidate-test':'tongxu-member-candidate-test';
export const candidateValidationPayload=(p:CandidateValidationPlan)=>hash(canonical({kind:p.kind,entry:p.entry,collection:p.collection,manifestSha256:p.manifestSha256,testPlanSha256:p.testPlan.sha256,...(p.kind==='tongxu-member-candidate-validation'&&p.candidateSource?{candidateSource:p.candidateSource}:{})}));
export function parseCandidateValidation(raw:Buffer):CandidateValidationPlan{
 if(raw.length>128*1024)throw new Error('candidate_validation_request_limit');let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('candidate_validation_request_invalid');}
 if(!exactKeys(p,['schemaVersion','kind','id','store','entry','originPlan','collectionKey','collection','manifestSha256','testPlan','directory','governance',...(Object.hasOwn(p??{},'candidateSource')?['candidateSource']:[])])||p.schemaVersion!==1||!['tongxu-integration-candidate-validation','tongxu-member-candidate-validation'].includes(p.kind)||![p.id,p.entry,p.collectionKey].every(messageId)||!isAuthorityDigest(p.originPlan)||!isAuthorityDigest(p.manifestSha256)||![p.store,p.directory].every(messagePath)||!exactKeys(p.testPlan,['path','sha256'])||!messagePath(p.testPlan.path)||!isAuthorityDigest(p.testPlan.sha256)||p.collection?.kind!==(p.kind==='tongxu-integration-candidate-validation'?'tongxu-conditional-candidate-collection':'tongxu-conditional-member-collection'))throw new Error('candidate_validation_request_invalid');
 if(Object.hasOwn(p,'candidateSource')&&(p.kind!=='tongxu-member-candidate-validation'||!exactKeys(p.candidateSource,['kind','sha256'])||p.candidateSource.kind!=='controlled-member-observation'||!isAuthorityDigest(p.candidateSource.sha256)))throw new Error('candidate_validation_source_invalid');
 const g=p.governance;if(g!==null&&(!exactKeys(g,['authorityIntent','resourceRequests'])||!messageId(g.authorityIntent)||!Array.isArray(g.resourceRequests)||g.resourceRequests.length>16||new Set(g.resourceRequests).size!==g.resourceRequests.length||!g.resourceRequests.every(isAuthorityDigest)))throw new Error('candidate_validation_governance_invalid');return p;
}

export function parseIntegrationCandidateValidation(raw:Buffer):IntegrationCandidateValidationPlan{const p=parseCandidateValidation(raw);if(p.kind!=='tongxu-integration-candidate-validation')throw new Error('candidate_validation_integration_required');return p;}
