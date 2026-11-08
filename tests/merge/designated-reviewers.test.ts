import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {ready,rulesetOnly} from './fixture.js';
import {inspectMergePreflight,evaluateMergePreflight} from '../../src/merge-preflight.js';
import {mergeCommand} from '../../src/merge-provider.js';
import {managedMergeAction} from '../../src/managed-merge.js';
import type {ManagedMergeBinding} from '../../src/merge-contract.js';

function policy(b:ManagedMergeBinding,state='CLEAN',decision:string|null='APPROVED'){
  return {data:{repository:{databaseId:b.repositoryId,nameWithOwner:b.repository,
    ref:{target:{__typename:'Commit',oid:b.B}},
    pullRequest:{number:b.pr,state:'OPEN',isDraft:false,headRefOid:b.H,baseRefName:b.targetRef,mergeStateStatus:state,reviewDecision:decision}}}};
}
const teams=[{reviewer:{id:8,type:'Team'},file_patterns:['src/**','!src/generated/**'],minimum_approvals:2},
  {reviewer:{id:9,type:'Team'},file_patterns:['docs/**'],minimum_approvals:0}];

test('designated parties consume current server policy for owners and multiple teams without inventing approval counts',async t=>{
  const f=await ready(t),p=f.publisher,b=f.binding,root='/repos/'+b.repository;let n=0;
  const protection=`${root}/branches/${encodeURIComponent(b.targetRef)}/protection`;
  const rules=`${root}/rules/branches/${encodeURIComponent(b.targetRef)}?per_page=100&page=1`;
  for(const source of ['classic-owner','ruleset-owner','teams','zero-team'] as const){
    p.setReply(protection,{required_pull_request_reviews:{required_approving_review_count:0,...(source==='classic-owner'?{require_code_owner_reviews:true}:{})}});
    p.setReply(rules,source==='classic-owner'?[]:[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:0,...(source==='ruleset-owner'?{require_code_owner_review:true}:{required_reviewers:source==='zero-team'?[teams[1]]:teams})}}]);
    for(const state of ['CLEAN','UNSTABLE'])for(const decision of ['APPROVED',null]){
      p.setReply('/graphql',policy(b,state,decision));const before=p.requests.length;
      const result=await inspectMergePreflight(p.profile,b,join(f.root,'designated-normal-'+(++n)));
      assert.equal(result.result.ready,true,source+' '+state+' '+decision);
      assert.equal(result.result.designatedReview?.basis,'github_current_merge_policy');
      assert.equal(result.result.currentHeadApprovals,0);
      const reads=p.requests.slice(before).filter(r=>r.path==='/graphql');assert.equal(reads.length,1);assert.equal(reads[0]!.method,'POST');
      assert.deepEqual(JSON.parse(reads[0]!.body).variables,{owner:'fixture',name:'reception',pr:b.pr,ref:'refs/heads/'+b.targetRef});
      if(source==='teams')assert.equal(result.result.designatedReview?.requiredTeams.length,2);
    }
  }
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});

test('blocked contradictory unknown and incomplete designated-review observations never authorize a merge',async t=>{
  const f=await ready(t,'normal','github_app_installation'),p=f.publisher,b=f.binding,paths=rulesetOnly(f);let n=0;
  p.setReply(paths.rules,[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:0,require_code_owner_review:true}}]);
  assert.equal((await inspectMergePreflight(p.profile,b,join(f.root,'designated-valid-baseline'))).result.ready,true);
  const values:any[]=[policy(b,'BLOCKED'),policy(b,'UNKNOWN'),policy(b,'HAS_HOOKS'),policy(b,'CLEAN','REVIEW_REQUIRED'),policy(b,'CLEAN','CHANGES_REQUESTED'),policy(b,'CLEAN','unknown'),{errors:[{message:'hidden'}],...policy(b)}, {data:null}, {data:{repository:null}}];
  for(const change of [
    (r:any)=>{r.databaseId++;},(r:any)=>{r.nameWithOwner='other/repo';},(r:any)=>{r.ref.target.oid='f'.repeat(40);},
    (r:any)=>{r.ref.target.__typename='Tag';},(r:any)=>{r.pullRequest.number++;},(r:any)=>{r.pullRequest.headRefOid='f'.repeat(40);},
    (r:any)=>{r.pullRequest.baseRefName='other';},(r:any)=>{r.pullRequest.isDraft=true;},(r:any)=>{r.pullRequest.state='MERGED';},
    (r:any)=>{delete r.pullRequest.reviewDecision;},(r:any)=>{delete r.pullRequest.mergeStateStatus;}
  ]){const v=policy(b);change(v.data.repository);values.push(v);}
  for(const value of values){p.setReply('/graphql',value);const result=await inspectMergePreflight(p.profile,b,join(f.root,'designated-invalid-'+(++n)));assert.equal(result.result.ready,false);assert.ok(result.result.gaps.some(gap=>gap.startsWith('designated_review_')));}
  for(const status of [403,404,500]){p.setReply('/graphql',{message:'unavailable'},status);assert.equal((await inspectMergePreflight(p.profile,b,join(f.root,'designated-http-'+(++n)))).result.ready,false);}
  p.setReply('/graphql',policy(b),200,true);assert.equal((await inspectMergePreflight(p.profile,b,join(f.root,'designated-page-'+(++n)))).result.ready,false);
  p.setReply('/graphql',policy(b));const good=await inspectMergePreflight(p.profile,b,join(f.root,'designated-source-'+(++n))),observation=good.records.find(r=>r.command.read?.kind==='review_policy')!;
  for(const records of [good.records.filter(r=>r!==observation),[...good.records,observation],good.records.map(r=>r===observation?{...r,command:mergeCommand({...b,pr:b.pr+1},'read',{kind:'review_policy'})}:r)])assert.equal(evaluateMergePreflight(p.profile,b,records).ready,false);
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});

test('malformed designated requirements and every original review or check guard remain blocking',async t=>{
  const f=await ready(t,'normal','github_app_installation'),p=f.publisher,b=f.binding,paths=rulesetOnly(f),root='/repos/'+b.repository;let n=0;
  const invalid:any[]=[{require_code_owner_review:'true'},{require_code_owner_review:true,require_code_owner_reviews:false},{required_reviewers:null},
    {required_reviewers:[{team_id:8}]},{required_reviewers:[{...teams[0],reviewer:{type:'User',id:8}}]},
    {required_reviewers:[{...teams[0],minimum_approvals:11}]},{required_reviewers:[{...teams[0],minimum_approvals:-1}]},
    {required_reviewers:[{...teams[0],minimum_approvals:1.5}]},{required_reviewers:[{...teams[0],file_patterns:[]}]},
    {required_reviewers:[{...teams[0],file_patterns:[null]}]},{required_reviewers:Array(16).fill(teams[0])}];
  const inspect=()=>inspectMergePreflight(p.profile,b,join(f.root,'designated-guards-'+(++n)));
  for(const parameters of invalid){p.setReply(paths.rules,[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:0,...parameters}}]);assert.equal((await inspect()).result.ready,false);}
  p.setReply(paths.rules,[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:0,required_reviewers:teams}}]);
  p.setReply(root,{id:b.repositoryId,full_name:b.repository,owner:{type:'User'},archived:false,disabled:false,allow_merge_commit:true});assert.equal((await inspect()).result.ready,false);
  p.setReply(root,{id:b.repositoryId,full_name:b.repository,owner:{type:'Organization'},archived:false,disabled:false,allow_merge_commit:true});
  p.setReply(paths.rules,[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:1,require_code_owner_review:true}}]);assert.ok((await inspect()).result.gaps.includes('current_head_approvals_insufficient'));
  const reviews=`${root}/pulls/${b.pr}/reviews?per_page=100&page=1`;
  p.setReply(reviews,[{id:55,user:{id:55,login:'reviewer'},state:'APPROVED',commit_id:b.H,submitted_at:new Date().toISOString()}]);
  p.setReply(root+'/collaborators/reviewer/permission',{permission:'read',user:{id:55,login:'reviewer'}});assert.equal((await inspect()).result.ready,false);
  p.setReply(root+'/collaborators/reviewer/permission',{permission:'write',user:{id:55,login:'reviewer'}});assert.equal((await inspect()).result.ready,true);
  p.setReply(reviews,[{id:55,user:{id:55,login:'reviewer'},state:'APPROVED',commit_id:'f'.repeat(40),submitted_at:new Date().toISOString()}]);assert.equal((await inspect()).result.ready,false);
  p.setReply(reviews,[{id:55,user:{id:55,login:'reviewer'},state:'CHANGES_REQUESTED',commit_id:b.H,submitted_at:new Date().toISOString()}]);assert.ok((await inspect()).result.gaps.includes('changes_requested_not_resolved'));
  p.setReply(paths.rules,[{type:'pull_request',ruleset_id:7,parameters:{required_approving_review_count:0,require_code_owner_review:true}},{type:'merge_queue',ruleset_id:7}]);assert.ok((await inspect()).result.gaps.includes('unsupported_active_rule:merge_queue'));
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});

for(const mode of ['normal','lost-after-merge','refused'] as const)test('designated-review normal consumer preserves original send and recovery '+mode,async t=>{
  const f=await ready(t,mode),p=f.publisher,b=f.binding,root='/repos/'+b.repository;
  p.setReply(`${root}/branches/${encodeURIComponent(b.targetRef)}/protection`,{required_pull_request_reviews:{required_approving_review_count:0,require_code_owner_reviews:true}});
  let first;
  if(mode==='lost-after-merge'){
    await assert.rejects(managedMergeAction(f.store,f.operation,'run'),/managed_publisher_execution_incomplete/);
    assert.equal(f.q.merges().status(f.operation).merge.phase,'sent_unknown');
  }else{
    first=await managedMergeAction(f.store,f.operation,'run');assert.equal(first.newMergeCall,true);
  }
  assert.equal(p.state().merges,mode==='refused'?0:1);
  const before=p.requests.length;
  if(mode==='normal')assert.equal(first!.merge.phase,'exact_merge_result_verified');
  if(mode!=='refused'){
    await managedMergeAction(f.store,f.operation,'run');await managedMergeAction(f.store,f.operation,'reconcile');
    assert.equal(p.requests.filter(r=>r.method==='PUT').length,1);
    assert.equal(p.requests.slice(before).filter(r=>r.path==='/graphql').length,0);
  }else{
    p.setMode('normal');p.setReply('/graphql',policy(b,'BLOCKED','REVIEW_REQUIRED'));
    const waiting=await managedMergeAction(f.store,f.operation,'retry-refused');assert.equal(waiting.newMergeCall,false);assert.equal(p.requests.filter(r=>r.method==='PUT').length,1);
    p.setReply('/graphql',policy(b));const next=await managedMergeAction(f.store,f.operation,'retry-refused');assert.equal(next.newMergeCall,true);assert.equal(p.state().merges,1);assert.equal(p.requests.filter(r=>r.method==='PUT').length,2);
  }
});

test('ordinary legacy policy consumes no additional query and rule changes use a fresh preflight',async t=>{
  const f=await ready(t),p=f.publisher,b=f.binding,root='/repos/'+b.repository;let n=0;
  const inspect=()=>inspectMergePreflight(p.profile,b,join(f.root,'designated-evolution-'+(++n)));
  const initial=await inspect();assert.equal(initial.result.ready,true);assert.equal(initial.result.designatedReview,undefined);assert.equal(p.requests.filter(r=>r.method==='POST').length,0);
  p.setReply(`${root}/branches/${encodeURIComponent(b.targetRef)}/protection`,{required_pull_request_reviews:{required_approving_review_count:0,require_code_owner_reviews:true}});assert.equal((await inspect()).result.ready,true);
  p.setReply('/graphql',policy(b,'BLOCKED'));assert.equal((await inspect()).result.ready,false);
  p.setMode('head-changed');p.setReply('/graphql',policy(b));assert.equal((await inspect()).result.ready,false);
  assert.equal(p.requests.filter(r=>r.method==='PUT').length,0);
});
