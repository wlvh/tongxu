import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ready } from './fixture.js';
import { inspectMergePreflight } from '../../src/merge-preflight.js';

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
