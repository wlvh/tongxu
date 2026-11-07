import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messagePath} from './message-contract.js';
import {parseIntegrationCandidate,type IntegrationCandidateRequest} from './integration-contract.js';
import {canonical} from './comparison.js';

export type ObservedCandidateRequest=Omit<IntegrationCandidateRequest,'kind'>&{
  kind:'tongxu-observed-integration-candidate';repositoryId:number;ghExecutable:string;ghSha256:string;executionKind?:'github'|'fixture';
  receptionContext?:{coordination:string;entry:string;semanticSha256:string};
};
export function integrationCandidateRequest(p:ObservedCandidateRequest):IntegrationCandidateRequest{
  const {repositoryId,ghExecutable,ghSha256,executionKind,receptionContext,...base}=p;
  return {...base,kind:'tongxu-integration-candidate'};
}
export function parseObservedCandidateRequest(raw:Buffer):ObservedCandidateRequest{
  if(raw.length>32*1024)throw new Error('observed_candidate_request_limit');
  let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('observed_candidate_request_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','integration','item','packet','fingerprint','source','repositoryId','ghExecutable','ghSha256',...(Object.hasOwn(p??{},'executionKind')?['executionKind']:[]),...(Object.hasOwn(p??{},'receptionContext')?['receptionContext']:[])])||Object.hasOwn(p??{},'executionKind')&&!['github','fixture'].includes(p.executionKind)||p.kind!=='tongxu-observed-integration-candidate'||!Number.isSafeInteger(p.repositoryId)||p.repositoryId<1||!messagePath(p.ghExecutable)||!isAuthorityDigest(p.ghSha256))throw new Error('observed_candidate_request_invalid');
  if(Object.hasOwn(p,'receptionContext')&&(!exactKeys(p.receptionContext,['coordination','entry','semanticSha256'])||typeof p.receptionContext.coordination!=='string'||!p.receptionContext.coordination.length||typeof p.receptionContext.entry!=='string'||!p.receptionContext.entry.length||!isAuthorityDigest(p.receptionContext.semanticSha256)))throw new Error('observed_candidate_reception_context_invalid');
  parseIntegrationCandidate(Buffer.from(canonical(integrationCandidateRequest(p))));return p;
}
