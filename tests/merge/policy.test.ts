import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ready,rulesetOnly } from './fixture.js';
import { inspectMergePreflight,evaluateMergePreflight } from '../../src/merge-preflight.js';

test('actual fixture reads bind required app checks and current-head approvals with collaborator permission',async t=>{
  const f=await ready(t),p=f.publisher,b=f.binding,root='/repos/'+b.repository;let n=0;
  const protection={required_pull_request_reviews:{required_approving_review_count:1},required_status_checks:{contexts:['CI'],checks:[{context:'CI',app_id:5}]}};
  const checks={total_count:1,check_runs:[{id:101,name:'CI',head_sha:b.H,status:'completed',conclusion:'success',app:{id:5}}]};
  const reviews=[{id:55,user:{id:55,login:'reviewer'},state:'APPROVED',commit_id:b.H,submitted_at:new Date().toISOString()}];
  const protectionPath=`${root}/branches/${encodeURIComponent(b.targetRef)}/protection`,checksPath=`${root}/commits/${b.H}/check-runs?filter=latest&per_page=100&page=1`,reviewsPath=`${root}/pulls/${b.pr}/reviews?per_page=100&page=1`;
  p.setReply(protectionPath,protection);p.setReply(checksPath,checks);p.setReply(reviewsPath,reviews);p.setReply(root+'/collaborators/reviewer/permission',{permission:'write',user:{id:55,login:'reviewer'}});
  const inspect=()=>inspectMergePreflight(p.profile,b,join(f.root,'policy-'+(++n)));
  assert.equal((await inspect()).result.ready,true);
  p.setReply(root+'/collaborators/reviewer/permission',{permission:'read',user:{id:55,login:'reviewer'}});assert.ok((await inspect()).result.gaps.includes('current_head_approvals_insufficient'));
  p.setReply(root+'/collaborators/reviewer/permission',{permission:'write',user:{id:99,login:'reviewer'}});assert.ok((await inspect()).result.gaps.includes('reviewer_repository_permission_unavailable'));
  p.setReply(root+'/collaborators/reviewer/permission',{permission:'write',user:{id:55,login:'reviewer'}});
  p.setReply(checksPath,{...checks,check_runs:[{...checks.check_runs[0],app:{id:999}}]});assert.ok((await inspect()).result.gaps.includes('required_check_not_successful:CI'));
  p.setReply(checksPath,{...checks,check_runs:[{...checks.check_runs[0],conclusion:'failure'}]});assert.ok((await inspect()).result.gaps.includes('required_check_not_successful:CI'));
  p.setReply(checksPath,checks);p.setReply(reviewsPath,[{...reviews[0],commit_id:'f'.repeat(40)}]);assert.ok((await inspect()).result.gaps.includes('current_head_approvals_insufficient'));
  p.setReply(reviewsPath,reviews);p.setReply(protectionPath,{...protection,required_pull_request_reviews:{required_approving_review_count:1,require_code_owner_reviews:true}});assert.ok((await inspect()).result.gaps.includes('code_owner_resolution_not_supported'));
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
  assert.equal(p.requests.filter(r=>r.path===root+'/actions/permissions').length,0);
});

test('ruleset-only absence needs the same live bounded administration read, including disabled Actions',async t=>{
  const f=await ready(t,'normal','github_app_installation'),p=f.publisher,b=f.binding,paths=rulesetOnly(f);let n=0;
  const inspect=()=>inspectMergePreflight(p.profile,b,join(f.root,'absence-'+(++n)));
  const good=await inspect();assert.equal(good.result.ready,true);assert.equal(good.result.serverEnforcementStillRequired,true);assert.equal(good.result.nonAtomicRemoteObservation,true);
  assert.equal(p.requests.filter(r=>r.path===paths.administration).length,1);
  const admin=good.records.find(r=>r.command.read?.kind==='administration')!;
  for(const records of [good.records.filter(r=>r!==admin),[...good.records,admin],good.records.map(r=>r===admin?{...r,command:{...r.command,binding:{...b,pr:b.pr+1}}}:r)])assert.ok(evaluateMergePreflight(p.profile,b,records).gaps.includes('classic_protection_unavailable'));
  for(const records of [good.records.filter(r=>r.command.read?.kind!=='protection'),[...good.records,good.records.find(r=>r.command.read?.kind==='protection')!]])assert.ok(evaluateMergePreflight(p.profile,b,records).gaps.includes('classic_protection_observation_missing'));
  p.setReply(paths.administration,{enabled:true,allowed_actions:'all'});assert.equal((await inspect()).result.ready,true);
  const {credentialKind:_,...legacy}=p.profile,before=p.requests.length;
  assert.ok((await inspectMergePreflight(legacy,b,join(f.root,'legacy-absence'))).result.gaps.includes('classic_protection_unavailable'));
  assert.equal(p.requests.slice(before).filter(r=>r.path===paths.administration).length,0);
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});

test('unknown classic absence and incomplete administration observations never become an empty policy',async t=>{
  const f=await ready(t,'normal','fine_grained_pat'),p=f.publisher,b=f.binding,paths=rulesetOnly(f);let n=0;
  const cases:Array<{kind:'protection'|'administration';value:unknown;status?:number;nextPage?:boolean}>=[
    {kind:'protection',value:{message:'Branch not protected'},status:403},
    {kind:'protection',value:{message:'Not Found'},status:404},
    {kind:'protection',value:{message:'prefix Branch not protected'},status:404},
    {kind:'protection',value:[{message:'Branch not protected'}],status:404},
    {kind:'protection',value:'{"message":',status:404},
    {kind:'protection',value:{message:'Branch not protected'},status:404,nextPage:true},
    {kind:'administration',value:{message:'Forbidden'},status:403},
    {kind:'administration',value:{message:'Not Found'},status:404},
    {kind:'administration',value:{enabled:false},nextPage:true},
    {kind:'administration',value:[]},{kind:'administration',value:null},
    {kind:'administration',value:{}},{kind:'administration',value:{enabled:'false'}},
  ];
  for(const c of cases){rulesetOnly(f);p.setReply(paths[c.kind],c.value,c.status??200,c.nextPage??false);const before=p.requests.length,r=await inspectMergePreflight(p.profile,b,join(f.root,'invalid-proof-'+(++n)));assert.ok(r.result.gaps.includes('classic_protection_unavailable'),JSON.stringify(c));if(c.kind==='protection')assert.equal(p.requests.slice(before).filter(r=>r.path===paths.administration).length,0);}
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});

test('proven classic absence still evaluates effective rule semantics, full pages and the current candidate',async t=>{
  const f=await ready(t,'normal','github_app_user'),p=f.publisher,b=f.binding,paths=rulesetOnly(f);let n=0;
  const inspect=()=>inspectMergePreflight(p.profile,b,join(f.root,'ruleset-gates-'+(++n)));
  for(const [parameters,gap] of [[{require_code_owner_review:true},'code_owner_resolution_not_supported'],[{required_reviewers:[{team_id:8}]},'required_team_reviewers_not_supported'],[{required_approving_review_count:1,require_extra_approval_for_unattributed_changes:true},'unattributed_extra_approval_not_supported']] as const){p.setReply(paths.rules,[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:0,...parameters}}]);assert.ok((await inspect()).result.gaps.includes(gap));}
  p.setReply(paths.rules,[{type:'merge_queue',ruleset_id:7}]);assert.ok((await inspect()).result.gaps.includes('unsupported_active_rule:merge_queue'));
  p.setReply(paths.rules,[]);assert.ok((await inspect()).result.gaps.includes('managed_target_pull_request_rule_missing'));
  rulesetOnly(f);p.setReply(paths.rules,[],200,true);assert.ok((await inspect()).result.gaps.includes('rules_coverage_incomplete'));
  rulesetOnly(f);p.setMode('head-changed');assert.equal((await inspect()).result.ready,false);
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});
test('unavailable classic protection, excluded merge method and incomplete list coverage cannot be treated as empty success',async t=>{
  const f=await ready(t),p=f.publisher,b=f.binding,root='/repos/'+b.repository;let n=0;const inspect=()=>inspectMergePreflight(p.profile,b,join(f.root,'coverage-'+(++n)));
  p.setReply(`${root}/branches/${encodeURIComponent(b.targetRef)}/protection`,{message:'hidden or absent'},404);assert.ok((await inspect()).result.gaps.includes('classic_protection_unavailable'));
  p.setReply(`${root}/branches/${encodeURIComponent(b.targetRef)}/protection`,{required_pull_request_reviews:{required_approving_review_count:0}});
  p.setReply(`${root}/rules/branches/${encodeURIComponent(b.targetRef)}?per_page=100&page=1`,[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:0,allowed_merge_methods:['squash']}}]);assert.ok((await inspect()).result.gaps.includes('merge_commit_not_allowed_by_rule'));
  p.setReply(`${root}/rules/branches/${encodeURIComponent(b.targetRef)}?per_page=100&page=1`,[]);
  p.setReply(`${root}/pulls/${b.pr}/reviews?per_page=100&page=1`,[],200,true);assert.ok((await inspect()).result.gaps.includes('reviews_coverage_incomplete'));
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});
