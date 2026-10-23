import {exactKeys,isAuthorityDigest} from './authority-contract.js';

/** An association request supplies identities and provenance only. It cannot
 * replace either source packet, create a PR, or grant execution authority. */
export type TaskCandidateLink={schemaVersion:1;kind:'tongxu-task-candidate-link';task:string;candidateItem:string;source:string};
export function parseTaskCandidateLink(raw:Buffer):TaskCandidateLink{
  if(raw.length>8192)throw new Error('task_candidate_link_limit');
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','task','candidateItem','source'])||p.schemaVersion!==1||p.kind!=='tongxu-task-candidate-link'||!isAuthorityDigest(p.task)||!isAuthorityDigest(p.candidateItem)||p.task===p.candidateItem||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||p.source.includes('\0'))throw new Error('task_candidate_link_invalid');
  return p;
}
