import {canonical} from './comparison.js';
import {exactKeys} from './authority-contract.js';
import {shaPattern} from './contract.js';
import {parseMergeBinding,mergePayload,type ManagedMergeBinding} from './merge-contract.js';

export type MergeRead = { kind: 'repository' | 'pr' | 'target' | 'branch' | 'protection' | 'administration' | 'rules' | 'checks' | 'statuses' | 'reviews' | 'reviewer' | 'review_policy' | 'commit' | 'comparison'; page: number; commit: string | null; tip: string | null; reviewer?:string };
export type MergeCommand = {
  protocol: 'tongxu-managed-merge-v1'; command: 'capabilities' | 'read' | 'merge';
  binding: ManagedMergeBinding; read: MergeRead | null;
};
export function parseMergeCommand(c: MergeCommand, p: {repository:string;repositoryId:number;targets:string[]}): MergeCommand {
  if (!exactKeys(c, ['protocol','command','binding','read']) || c.protocol !== 'tongxu-managed-merge-v1' || !['capabilities','read','merge'].includes(c.command)) throw new Error('managed_merge_command_invalid');
  const b = parseMergeBinding(c.binding);
  if (b.repository.toLowerCase() !== p.repository.toLowerCase() || b.repositoryId !== p.repositoryId || !p.targets.includes(b.targetRef)) throw new Error('managed_publisher_scope_mismatch');
  if (c.command !== 'read') { if (c.read !== null) throw new Error('unplanned_merge_read'); return c; }
  const r = c.read;
  if (!r || !exactKeys(r, ['kind','page','commit','tip',...(r.kind==='reviewer'?['reviewer']:[])]) || !['repository','pr','target','branch','protection','administration','rules','checks','statuses','reviews','reviewer','review_policy','commit','comparison'].includes(r.kind) || !Number.isSafeInteger(r.page) || r.page < 1 || r.page > 10) throw new Error('managed_merge_read_invalid');
  if(r.kind==='reviewer'&&(typeof r.reviewer!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(r.reviewer)))throw new Error('merge_reviewer_identity_invalid');
  if (!['rules','checks','statuses','reviews'].includes(r.kind) && r.page !== 1) throw new Error('unplanned_merge_read_page');
  if (r.kind === 'commit' || r.kind === 'comparison') {
    if (typeof r.commit !== 'string' || !shaPattern.test(r.commit)) throw new Error('actual_merge_commit_required');
  } else if (r.commit !== null) throw new Error('unplanned_merge_commit');
  if (r.kind === 'comparison') { if (typeof r.tip !== 'string' || !shaPattern.test(r.tip)) throw new Error('actual_merge_target_tip_required'); }
  else if (r.tip !== null) throw new Error('unplanned_merge_target_tip');
  return c;
}
/** The endpoint and payload are constructed here. Even a trusted transport
 * cannot be asked by a report to run a shell, change a target or use bypass. */
export function mergeHttpRequest(c: MergeCommand): { method: 'GET' | 'POST' | 'PUT'; path: string; body: string | null } {
  const b = parseMergeBinding(c.binding), root = `/repos/${b.repository}`;
  parseMergeCommand(c,{repository:b.repository,repositoryId:b.repositoryId,targets:[b.targetRef]});
  if (c.command === 'merge') return { method: 'PUT', path: `${root}/pulls/${b.pr}/merge`, body: canonical(mergePayload(b)) };
  if (c.command !== 'read' || !c.read) throw new Error('publisher_capability_source_is_not_an_http_plan');
  const r = c.read, page = `per_page=100&page=${r.page}`, target = encodeURIComponent(b.targetRef);
  if(r.kind==='review_policy'){
    const [owner,name]=b.repository.split('/');
    const query=`query TongxuMergeReviewPolicy($owner:String!,$name:String!,$pr:Int!,$ref:String!){
      repository(owner:$owner,name:$name){
        databaseId nameWithOwner
        ref(qualifiedName:$ref){target{__typename ... on Commit{oid}}}
        pullRequest(number:$pr){
          number state isDraft headRefOid baseRefName mergeStateStatus reviewDecision
        }
      }
    }`;
    return {method:'POST',path:'/graphql',body:canonical({query,variables:{owner,name,pr:b.pr,ref:'refs/heads/'+b.targetRef}})};
  }
  const paths = {
    repository: root, pr: `${root}/pulls/${b.pr}`, target: `${root}/git/ref/heads/${target}`,
    branch: `${root}/branches/${target}`, protection: `${root}/branches/${target}/protection`,
    administration: `${root}/actions/permissions`,
    rules: `${root}/rules/branches/${target}?${page}`,
    checks: `${root}/commits/${b.H}/check-runs?filter=latest&${page}`,
    statuses: `${root}/commits/${b.H}/statuses?${page}`, reviews: `${root}/pulls/${b.pr}/reviews?${page}`,
    reviewer: `${root}/collaborators/${encodeURIComponent(r.reviewer??'')}/permission`,
    commit: `${root}/git/commits/${r.commit}`, comparison: `${root}/compare/${r.commit}...${r.tip}`,
  };
  return { method: 'GET', path: paths[r.kind], body: null };
}
