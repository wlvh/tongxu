import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {candidateFixture,raw} from './fixture.js';
import {runReception} from '../../src/receiver.js';
import {readyFromReception} from '../merge/fixture.js';
import {git} from '../../src/repair-workspace.js';
import {managedMergeAction} from '../../src/managed-merge.js';
import {mergePayload,type ManagedMergeBinding} from '../../src/merge-contract.js';

for(const mode of ['normal','lost-after-merge'])test('one actual isolated target update consumes the new integration reception: '+mode,async t=>{
  const f=await candidateFixture(t),author=await f.authorState(),link=f.q.attachIntegrationCandidate(raw(f.link)),received=await runReception(f.receiverPath);assert.equal(received.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');
  const target=join(f.root,'isolated-delivery-target.git');await git(f.root,['clone','--bare',join(f.produced.directory,'candidate.git'),target]);await git(target,['update-ref','refs/heads/fixture',f.B]);const updates:string[]=[];let binding:ManagedMergeBinding;
  const merge=await readyFromReception(t,{...f,item:f.candidateItem,path:f.receiverPath,plan:f.receiverPlan,packet:f.addPacket,H:f.candidate.H},received,mode,async()=>{const M=await git(target,['-c','user.name=isolated fixture publisher','-c','user.email=fixture@example.invalid','commit-tree',f.candidate.T,'-p',f.B,'-p',f.candidate.H,'-m','tongxu: receive PR #99','-m',mergePayload(binding).commit_message]);await git(target,['update-ref','refs/heads/fixture',M,f.B]);updates.push(M);return M;});binding=merge.binding;
  assert.equal(binding.integrationReference,link.integrationSha256);assert.equal(binding.H,f.candidate.H);assert.equal(await git(target,['rev-parse','refs/heads/fixture']),f.B);assert.equal(merge.ledger.state().claims.length,0);
  if(mode==='lost-after-merge'){await assert.rejects(managedMergeAction(f.store,merge.operation,'run'),/execution_incomplete/);assert.equal(f.q.merges().status(merge.operation).merge.phase,'sent_unknown');assert.equal((await managedMergeAction(f.store,merge.operation,'run')).newMergeCall,false);}
  const result=await managedMergeAction(f.store,merge.operation,mode==='normal'?'run':'reconcile');assert.equal(result.merge.phase,'exact_merge_result_verified');assert.equal(updates.length,1);assert.equal(merge.publisher.requests.filter(x=>x.method==='PUT').length,1);assert.equal(await git(target,['rev-parse','refs/heads/fixture']),updates[0]);assert.equal(await git(target,['rev-parse','refs/heads/fixture^{tree}']),f.candidate.T);assert.equal(await git(target,['show','refs/heads/fixture:scale.json']),'1000');assert.equal(await git(target,['show','refs/heads/fixture:consumer.json']),'1000');await assert.rejects(git(target,['show','refs/heads/fixture:unselected-extra.txt']));
  assert.equal((await managedMergeAction(f.store,merge.operation,'run')).newMergeCall,false);assert.equal(updates.length,1);assert.equal(merge.ledger.state().settlements.length,1);assert.equal(f.q.status().claims.length,0);assert.deepEqual(await f.authorState(),author);assert.equal(await f.count(),1);assert.equal(result.executionKind,'fixture');
});
