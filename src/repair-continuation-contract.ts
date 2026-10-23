import {exactKeys,isAuthorityDigest} from './authority-contract.js';

/** An explicit successor of a completed managed operation. A review does
 * not change its owner. Uncommitted files are preserved separately and are
 * never silently folded into the selected committed candidate. */
export type RepairContinuation={
  operation:string;bindingHash:string;resultSha256:string;evidenceSha256:string;
  workspaceStateSha256:string;mode:'same_owner'|'explicit_handoff';
  adoption:'committed_candidate';source:string;
};
export function parseRepairContinuation(v:unknown):RepairContinuation{
  const p=v as RepairContinuation;
  if(!exactKeys(p,['operation','bindingHash','resultSha256','evidenceSha256','workspaceStateSha256','mode','adoption','source'])||typeof p.operation!=='string'||!/^[a-f0-9-]{36}$/.test(p.operation)||![p.bindingHash,p.resultSha256,p.evidenceSha256,p.workspaceStateSha256].every(isAuthorityDigest)||!['same_owner','explicit_handoff'].includes(p.mode)||p.adoption!=='committed_candidate'||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||p.source.includes('\0'))throw new Error('repair_continuation_invalid');
  return p;
}
