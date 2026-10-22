import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';

export type OverallGovernance={authorityIntent:string;resourceRequests:string[]};
export function parseOverallGovernance(value:unknown):OverallGovernance{
  const g=value as any;
  if(!exactKeys(g,['authorityIntent','resourceRequests'])||!messageId(g.authorityIntent)||!Array.isArray(g.resourceRequests)||g.resourceRequests.length>32||new Set(g.resourceRequests).size!==g.resourceRequests.length||!g.resourceRequests.every(isAuthorityDigest))throw new Error('overall_authority_consumer_binding_required');
  return g as OverallGovernance;
}
/** Resource request IDs depend on the reserved action, so the authority binds
 * the complete technical plan before those references are attached. */
export function overallAuthorityPayloadSha(plan:Record<string,unknown>){const {governance,...content}=plan;return hash(canonical(content));}
