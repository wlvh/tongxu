import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messagePath} from './message-contract.js';
import {parseIntegrationCandidate,type IntegrationCandidateRequest} from './integration-contract.js';
import {canonical} from './comparison.js';

export type ObservedCandidateRequest=Omit<IntegrationCandidateRequest,'kind'>&{
  kind:'tongxu-observed-integration-candidate';repositoryId:number;ghExecutable:string;ghSha256:string;
};
export function integrationCandidateRequest(p:ObservedCandidateRequest):IntegrationCandidateRequest{
  const {repositoryId,ghExecutable,ghSha256,...base}=p;
  return {...base,kind:'tongxu-integration-candidate'};
}
export function parseObservedCandidateRequest(raw:Buffer):ObservedCandidateRequest{
  if(raw.length>32*1024)throw new Error('observed_candidate_request_limit');
  let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('observed_candidate_request_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','integration','item','packet','fingerprint','source','repositoryId','ghExecutable','ghSha256'])||p.kind!=='tongxu-observed-integration-candidate'||!Number.isSafeInteger(p.repositoryId)||p.repositoryId<1||!messagePath(p.ghExecutable)||!isAuthorityDigest(p.ghSha256))throw new Error('observed_candidate_request_invalid');
  parseIntegrationCandidate(Buffer.from(canonical(integrationCandidateRequest(p))));return p;
}
