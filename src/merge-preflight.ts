import {selectExternalExecutable} from './external-executable.js';
import { join } from 'node:path';
import { canonical } from './comparison.js';
import { hash,privateDirectory } from './snapshot.js';
import { inspectMergeCurrent, type ManagedMergeBinding } from './merge-contract.js';
import { callMergeProvider, mergeCommand, mergeWire, requireMergeObservation, type MergeCommand, type MergeObservation, type MergeProfile, type MergeRead } from './merge-provider.js';

type Row = Record<string,any>;
export type MergeReadRecord = { command: MergeCommand; observation: MergeObservation };
export type MergePreflight = { profileSha256:string; bindingSha256:string; records:MergeReadRecord[]; result:ReturnType<typeof evaluateMergePreflight>; checkedAt:string };
const preflights = new WeakSet<object>();
const decode = (r:MergeReadRecord) => {
  const w=mergeWire(r.observation); if(w.status!==200)throw new Error('unavailable');
  return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(w.body));
};

/** A bounded set of rule semantics. Unsupported rules remain visible gaps;
 * GitHub's own enforcement remains necessary after this non-atomic read. */
export function evaluateMergePreflight(p:MergeProfile,b:ManagedMergeBinding,records:MergeReadRecord[]) {
  const gaps:string[]=[], by=(kind:MergeRead['kind'])=>records.filter(r=>r.command.read?.kind===kind);
  const one=(kind:MergeRead['kind']):Row|null=>{try{const rs=by(kind);if(rs.length!==1)throw new Error('count');const v=decode(rs[0]!);if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('shape');return v;}catch{gaps.push(`${kind}_observation_unavailable`);return null;}};
  const caps=records.filter(r=>r.command.command==='capabilities');
  const cap=caps.length===1?caps[0]!.observation.reply.result:null;
  if(!cap||cap.kind!=='capabilities'||cap.credentialState!=='available'||cap.actorId!==p.actorId||cap.identity!==(p.executionKind==='fixture'?'fixture':'isolated_publisher')||canonical(cap.repositoryIds)!==canonical([p.repositoryId])||!cap.targetRefs.includes(b.targetRef)||cap.targetRefs.some(t=>!p.targets.includes(t))||!cap.merge||cap.bypass!==false||!cap.synchronousHeadCondition||!cap.sourceReference)gaps.push('bounded_publisher_identity_or_permission_unavailable');
  const pr=one('pr'),repo=one('repository'),branch=one('branch');
  const targets=by('target');
  let current:ReturnType<typeof inspectMergeCurrent>|null=null;
  if(pr&&targets.length===2){current=inspectMergeCurrent(b,mergeWire(by('pr')[0]!.observation),mergeWire(targets[0]!.observation),mergeWire(targets[1]!.observation));gaps.push(...current.gaps);}else gaps.push('stable_target_observation_missing');
  if(!repo||repo.id!==b.repositoryId||repo.full_name?.toLowerCase()!==b.repository.toLowerCase()||repo.archived!==false||repo.disabled!==false||repo.allow_merge_commit!==true)gaps.push('repository_merge_method_unavailable');
  if(!branch||branch.name!==b.targetRef||branch.commit?.sha!==b.B||typeof branch.protected!=='boolean')gaps.push('branch_identity_or_protection_unknown');
  function pages(kind:MergeRead['kind'],field?:string):Row[]{
    const rs=by(kind),values:Row[]=[],ids=new Set<number>();let total:number|undefined;
    if(!rs.length){gaps.push(`${kind}_pages_missing`);return values;}
    try{
      for(const [i,r] of rs.entries()){
        if(r.command.read?.page!==i+1||r.observation.reply.result.kind!=='http'||r.observation.reply.result.nextPage!==(i<rs.length-1))throw new Error('pagination');
        const v=decode(r),items=field?v[field]:v;
        if(!Array.isArray(items)||items.length>100||i<rs.length-1&&items.length!==100)throw new Error('page_shape');
        if(field){if(!Number.isSafeInteger(v.total_count)||v.total_count<0||total!==undefined&&total!==v.total_count)throw new Error('count');total=v.total_count;}
        for(const item of items){if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('entry');if(kind!=='rules'){if(!Number.isSafeInteger(item.id)||item.id<=0||ids.has(item.id))throw new Error('duplicate_or_missing_id');ids.add(item.id);}values.push(item);}
      }
      if(total!==undefined&&total!==values.length)throw new Error('total');
    }catch{gaps.push(`${kind}_coverage_incomplete`);}
    return values;
  }
  const rules=pages('rules'),checks=pages('checks','check_runs'),statuses=pages('statuses'),reviews=pages('reviews');
  const required:Array<{context:string;appId:number|null}>=[];
  let approvalCount=0,prRule=false;
  const requireReviews=(r:Row)=>{
    prRule=true;
    if(!Number.isSafeInteger(r.required_approving_review_count)||r.required_approving_review_count<0)gaps.push('review_count_unknown');
    else approvalCount=Math.max(approvalCount,r.required_approving_review_count);
    if(r.require_code_owner_review===true||r.require_code_owner_reviews===true)gaps.push('code_owner_resolution_not_supported');
    if(r.require_last_push_approval===true)gaps.push('last_pusher_identity_not_supported');
    if(r.required_review_thread_resolution===true)gaps.push('review_thread_resolution_not_supported');
    if(r.required_reviewers?.length)gaps.push('required_team_reviewers_not_supported');
    if(r.allowed_merge_methods!==undefined&&(!Array.isArray(r.allowed_merge_methods)||!r.allowed_merge_methods.includes('merge')))gaps.push('merge_commit_not_allowed_by_rule');
  };
  if(branch?.protected===true){
    const found=by('protection');
    if(found.length!==1)gaps.push('classic_protection_observation_missing');
    else if(mergeWire(found[0]!.observation).status===200){
      const v=decode(found[0]!);
      if(v.required_pull_request_reviews)requireReviews(v.required_pull_request_reviews);
      const s=v.required_status_checks;
      if(s){
        if(!Array.isArray(s.contexts)||!Array.isArray(s.checks))gaps.push('classic_status_requirement_unknown');
        else {
          for(const c of s.checks){if(typeof c.context!=='string'||!(c.app_id===null||c.app_id===-1||Number.isSafeInteger(c.app_id)&&c.app_id>0))gaps.push('check_requirement_unknown');else required.push({context:c.context,appId:c.app_id===-1?null:c.app_id});}
          for(const context of s.contexts)if(typeof context!=='string')gaps.push('check_context_unknown');else if(!required.some(c=>c.context===context))required.push({context,appId:null});
        }
        if(s.strict===true&&pr?.mergeable_state!=='clean')gaps.push('strict_status_base_currentness_unverified');
      }
      if(v.required_linear_history?.enabled===true)gaps.push('linear_history_requires_a_different_merge_protocol');
      if(v.required_signatures?.enabled===true)gaps.push('managed_merge_signing_not_verified');
      if(v.required_conversation_resolution?.enabled===true)gaps.push('review_thread_resolution_not_supported');
      if(v.lock_branch?.enabled===true)gaps.push('target_branch_locked');
      // A scoped publisher is not permitted to use an exemption even if a
      // server configuration would allow it. Unknown bypass settings fail shut.
      const bypass=v.required_pull_request_reviews?.bypass_pull_request_allowances;
      if(bypass&&(!['users','teams','apps'].every(k=>Array.isArray(bypass[k]))||Object.values(bypass).some((a:any)=>!Array.isArray(a)||a.length)))gaps.push('classic_bypass_allowance_present_or_unknown');
    } else gaps.push('classic_protection_unavailable');
  }
  for(const rule of rules){
    if(typeof rule.type!=='string'||!Number.isSafeInteger(rule.ruleset_id)||rule.ruleset_id<=0){gaps.push('active_rule_source_unknown');continue;}
    if(['deletion','non_fast_forward'].includes(rule.type))continue;
    if(rule.type==='pull_request'){if(!rule.parameters)gaps.push('pull_request_rule_unknown');else requireReviews(rule.parameters);continue;}
    if(rule.type==='required_status_checks'){
      if(!Array.isArray(rule.parameters?.required_status_checks))gaps.push('status_rule_unknown');
      else for(const c of rule.parameters.required_status_checks){if(typeof c.context!=='string'||!(c.integration_id===undefined||c.integration_id===null||Number.isSafeInteger(c.integration_id)&&c.integration_id>0))gaps.push('check_requirement_unknown');else required.push({context:c.context,appId:c.integration_id??null});}
      if(rule.parameters?.strict_required_status_checks_policy===true&&pr?.mergeable_state!=='clean')gaps.push('strict_status_base_currentness_unverified');
      continue;
    }
    gaps.push(`unsupported_active_rule:${rule.type}`);
  }
  if(!prRule)gaps.push('managed_target_pull_request_rule_missing');
  if(prRule&&branch?.protected!==true)gaps.push('protection_observations_disagree');
  const latestStatuses=new Map<string,Row>();
  for(const s of statuses){if(typeof s.context!=='string'||typeof s.created_at!=='string'||!Number.isFinite(Date.parse(s.created_at))){gaps.push('status_identity_unknown');continue;}const key=s.context.toLowerCase(),old=latestStatuses.get(key);if(!old||Date.parse(s.created_at)>Date.parse(old.created_at)||s.created_at===old.created_at&&s.id>old.id)latestStatuses.set(key,s);}
  for(const c of required){
    const named=checks.filter(x=>typeof x.name==='string'&&x.name.toLowerCase()===c.context.toLowerCase()&&(c.appId===null||x.app?.id===c.appId));
    const newest=new Map<number,Row>();for(const x of named){if(!Number.isSafeInteger(x.app?.id)||x.head_sha!==b.H){gaps.push('required_check_identity_unknown');continue;}const old=newest.get(x.app.id);if(!old||x.id>old.id)newest.set(x.app.id,x);}
    const checkPass=newest.size>0&&[...newest.values()].every(x=>x.status==='completed'&&['success','neutral','skipped'].includes(x.conclusion));
    const status=latestStatuses.get(c.context.toLowerCase());
    if(c.appId!==null?!checkPass:!checkPass&&status?.state!=='success'||Boolean(status&&status.state!=='success')||named.length>0&&!checkPass)gaps.push(`required_check_not_successful:${c.context}`);
  }
  const latestReviews=new Map<number,Row>();
  for(const r of reviews){
    if(!Number.isSafeInteger(r.user?.id)||!['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(r.state)){gaps.push('review_identity_or_state_unknown');continue;}
    if(r.state==='PENDING')continue;
    if(!Number.isFinite(Date.parse(r.submitted_at))){gaps.push('review_identity_or_state_unknown');continue;}
    if(r.state==='COMMENTED')continue;
    const old=latestReviews.get(r.user.id);if(!old||Date.parse(r.submitted_at)>Date.parse(old.submitted_at)||r.submitted_at===old.submitted_at&&r.id>old.id)latestReviews.set(r.user.id,r);
  }
  if([...latestReviews.values()].some(r=>r.state==='CHANGES_REQUESTED'))gaps.push('changes_requested_not_resolved');
  const approvalCandidates=[...latestReviews.values()].filter(r=>r.state==='APPROVED'&&r.commit_id===b.H&&r.user.id!==pr?.user?.id);
  const approvals=approvalCandidates.filter(r=>{
    if(approvalCount===0)return false;
    try{
      const sources=by('reviewer').filter(x=>x.command.read?.reviewer===r.user.login);if(sources.length!==1)throw new Error('missing');
      const v=decode(sources[0]!);if(v.user?.id!==r.user.id||v.user?.login?.toLowerCase()!==r.user.login?.toLowerCase())throw new Error('identity');
      return ['admin','write','maintain'].includes(v.permission);
    }catch{gaps.push('reviewer_repository_permission_unavailable');return false;}
  }).length;
  if(approvals<approvalCount)gaps.push('current_head_approvals_insufficient');
  return { ready:gaps.length===0,gaps:[...new Set(gaps)],current,requiredChecks:required,requiredApprovals:approvalCount,currentHeadApprovals:approvals,nonAtomicRemoteObservation:true,serverEnforcementStillRequired:true,productionActionAllowed:false };
}

export async function inspectMergePreflight(p:MergeProfile,b:ManagedMergeBinding,directory:string):Promise<MergePreflight>{
  await privateDirectory(directory,true);
  const records:MergeReadRecord[]=[],selected=selectExternalExecutable(p.executable);
  const capture=async(c:MergeCommand)=>{const observation=await callMergeProvider(p,c,join(directory,String(records.length).padStart(3,'0')),undefined,selected);records.push({command:c,observation});return observation;};
  await capture(mergeCommand(b,'capabilities'));
  for(const kind of ['target','repository','pr','branch'] as const)await capture(mergeCommand(b,'read',{kind}));
  for(const kind of ['rules','checks','statuses','reviews'] as const){for(let page=1;page<=10;page++){const r=await capture(mergeCommand(b,'read',{kind,page}));if(r.reply.result.kind!=='http'||!r.reply.result.nextPage)break;}}
  const reviewers=new Set<string>();
  for(const r of records.filter(r=>r.command.read?.kind==='reviews'))try{for(const v of decode(r))if(v.state==='APPROVED'&&v.commit_id===b.H&&typeof v.user?.login==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(v.user.login))reviewers.add(v.user.login);}catch{}
  // The requirement evaluator refuses missing permission observations; excess
  // identities never become inferred approvals when this read bound is hit.
  for(const reviewer of [...reviewers].slice(0,32))await capture(mergeCommand(b,'read',{kind:'reviewer',reviewer}));
  await capture(mergeCommand(b,'read',{kind:'protection'}));
  await capture(mergeCommand(b,'read',{kind:'target'}));
  const value=Object.freeze({profileSha256:hash(canonical(p)),bindingSha256:hash(canonical(b)),records,result:evaluateMergePreflight(p,b,records),checkedAt:new Date().toISOString()});
  preflights.add(value);return value;
}
export function requireMergePreflight(value:MergePreflight,p:MergeProfile,b:ManagedMergeBinding){
  if(!preflights.has(value)||value.profileSha256!==hash(canonical(p))||value.bindingSha256!==hash(canonical(b))||Date.now()-Date.parse(value.checkedAt)>60000)throw new Error('actual_managed_merge_preflight_required');
  for(const r of value.records)requireMergeObservation(r.observation,p,r.command);
  const result=evaluateMergePreflight(p,b,value.records);if(canonical(result)!==canonical(value.result)||!result.ready)throw new Error('managed_merge_preflight_blocked:'+result.gaps.join(','));
}
