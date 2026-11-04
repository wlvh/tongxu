import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';

export type FormalCandidate={repository:string;pr:number;H:string;B:string;target:string;requirementsSha256:string};
export type FormalFinding={id:string;priority:0|1|2;description:string;evidence:string[]};
export type FormalReview={candidateH:string;reviewedInputSha256:string;verdict:'PASS'|'REWORK_REQUIRED'|'OWNER_DECISION_REQUIRED';report:string;findings:FormalFinding[];coverageGaps:string[];ownerQuestions:string[]};
export type BatchAssessment={id:string;decision:'confirmed'|'refuted'|'needs_evidence';report:string;evidence:string[]};
export type FormalVerification={candidateH:string;batchSha256:string;report:string;assessments:BatchAssessment[]};
const text=(v:unknown,max=128000):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!v.includes('\0');
const strings=(v:unknown,max:number):v is string[]=>Array.isArray(v)&&v.length<=max&&v.every(s=>text(s,16000));
const object=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str={type:'string'},texts={type:'array',items:str};
export const formalReviewSchema=object({candidateH:str,reviewedInputSha256:str,verdict:{type:'string',enum:['PASS','REWORK_REQUIRED','OWNER_DECISION_REQUIRED']},report:str,findings:{type:'array',items:object({id:str,priority:{type:'integer',enum:[0,1,2]},description:str,evidence:texts})},coverageGaps:texts,ownerQuestions:texts});
export const formalVerificationSchema=object({candidateH:str,batchSha256:str,report:str,assessments:{type:'array',items:object({id:str,decision:{type:'string',enum:['confirmed','refuted','needs_evidence']},report:str,evidence:texts})}});

export function validateFormalReview(value:unknown,H:string,inputSha256:string):FormalReview{
  const r=value as FormalReview;
  if(!exactKeys(r,['candidateH','reviewedInputSha256','verdict','report','findings','coverageGaps','ownerQuestions'])||r.candidateH!==H||r.reviewedInputSha256!==inputSha256||!isAuthorityDigest(inputSha256)||!['PASS','REWORK_REQUIRED','OWNER_DECISION_REQUIRED'].includes(r.verdict)||!text(r.report)||!Array.isArray(r.findings)||r.findings.length>20||r.findings.some(f=>!exactKeys(f,['id','priority','description','evidence'])||!text(f.id,128)||![0,1,2].includes(f.priority)||!text(f.description,16000)||!strings(f.evidence,20)||!f.evidence.length)||new Set(r.findings.map(f=>f.id)).size!==r.findings.length||!strings(r.coverageGaps,20)||!strings(r.ownerQuestions,20))throw new Error('formal_review_binding_or_report_invalid');
  if(r.verdict==='PASS'&&(r.findings.some(f=>f.priority<2)||r.coverageGaps.length||r.ownerQuestions.length))throw new Error('formal_pass_has_unresolved_work');
  if(r.verdict==='OWNER_DECISION_REQUIRED'&&!r.ownerQuestions.length)throw new Error('formal_owner_question_required');
  return structuredClone(r);
}
/** An empty blocking list is not PASS. Never create an empty verification batch
 * to manufacture a route around missing review coverage or an Owner decision. */
export function formalReviewNext(review:FormalReview){
  if(review.verdict==='PASS')return {stage:'pass' as const,findings:[],newVerificationRequired:false};
  if(review.ownerQuestions.length)return {stage:'owner_decision' as const,findings:[],newVerificationRequired:false};
  const findings=review.findings.filter(f=>f.priority<2);
  return {stage:findings.length?'verify_batch' as const:'needs_evidence' as const,findings,newVerificationRequired:!!findings.length};
}
export function formalBatch(candidate:FormalCandidate,review:FormalReview){
  const findings=formalReviewNext(review).findings;if(!findings.length)throw new Error('formal_empty_batch_not_allowed');
  const value={candidate,reviewSha256:hash(canonical(review)),findings};return {...value,sha256:hash(canonical(value))};
}
export function validateFormalVerification(value:unknown,batch:ReturnType<typeof formalBatch>):FormalVerification{
  const r=value as FormalVerification;
  if(!exactKeys(r,['candidateH','batchSha256','report','assessments'])||r.candidateH!==batch.candidate.H||r.batchSha256!==batch.sha256||!text(r.report)||!Array.isArray(r.assessments)||r.assessments.length!==batch.findings.length||new Set(r.assessments.map(a=>a.id)).size!==batch.findings.length||r.assessments.some(a=>!exactKeys(a,['id','decision','report','evidence'])||!batch.findings.some(f=>f.id===a.id)||!['confirmed','refuted','needs_evidence'].includes(a.decision)||!text(a.report)||!strings(a.evidence,20)))throw new Error('formal_complete_batch_verification_required');
  return structuredClone(r);
}
export function sameFormalCandidate(a:FormalCandidate,b:FormalCandidate){return canonical(a)===canonical(b);}
export function formalDisagreements(fact:FormalVerification,impact:FormalVerification){
  return fact.assessments.filter(f=>f.decision!==impact.assessments.find(i=>i.id===f.id)?.decision).map(f=>f.id);
}
export function formalSynthesisNext(synthesis:FormalVerification,disagreements:string[],exchangeRounds:number){
  if(!Number.isSafeInteger(exchangeRounds)||exchangeRounds<0||exchangeRounds>3)throw new Error('formal_exchange_bound');
  if(disagreements.length&&exchangeRounds<3)return 'exchange_evidence' as const;
  if(disagreements.length||synthesis.assessments.some(a=>a.decision==='needs_evidence'))return 'needs_evidence' as const;
  return synthesis.assessments.some(a=>a.decision==='confirmed')?'authorized_fix' as const:'reviewer_refutation_conclusion' as const;
}
