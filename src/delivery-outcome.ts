import {exactKeys,isAuthorityDigest,type DeliveryOutcomeProposal} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {canonical} from './comparison.js';
import type {QueueStore} from './queue-store.js';

export type DeliveryOutcomeRequest={schemaVersion:1;kind:'tongxu-delivery-outcome-request';id:string;batchSha256:string;evidenceSha256:string;previousOutcome:string|null;outcome:DeliveryOutcomeProposal['outcome'];rationale:string};
export function parseDeliveryOutcomeRequest(raw:Buffer):DeliveryOutcomeRequest{
  if(raw.length>16384)throw new Error('delivery_outcome_request_size');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','id','batchSha256','evidenceSha256','previousOutcome','outcome','rationale'])||p.schemaVersion!==1||p.kind!=='tongxu-delivery-outcome-request'||!messageId(p.id)||!isAuthorityDigest(p.batchSha256)||!isAuthorityDigest(p.evidenceSha256)||!(p.previousOutcome===null||isAuthorityDigest(p.previousOutcome))||!['accepted','rejected','needs_evidence','stopped'].includes(p.outcome)||typeof p.rationale!=='string'||!p.rationale.trim()||p.rationale.length>4096||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p.rationale))throw new Error('delivery_outcome_request_invalid');return p;
}
/** Preparing a fixed request only exposes the exact Owner decision text.
 * It neither writes a provider comment nor adopts the executor's own text. */
export function prepareDeliveryOutcome(q:QueueStore,raw:Buffer){
  const p=parseDeliveryOutcomeRequest(raw),state=q.deliveries().state(p.batchSha256);if(!state.scope.adoption)throw new Error('delivery_outcome_scope_adoption_required');
  const proposal:DeliveryOutcomeProposal={kind:'delivery_outcome',adoption:state.scope.adoption,batchSha256:p.batchSha256,evidenceSha256:p.evidenceSha256,previousOutcome:p.previousOutcome,outcome:p.outcome,rationale:p.rationale};
  const result=q.authority().prepare(p.id,Buffer.from(canonical(proposal)));return {...result,requestPrepared:true,ownerDecisionApplied:false,permissionsGranted:false};
}
