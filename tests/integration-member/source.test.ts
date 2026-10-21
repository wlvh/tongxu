import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {candidateFixture,raw} from '../integration/fixture.js';
import {runReception} from '../../src/receiver.js';
import {verify} from '../../src/verification.js';
import {readPacket} from '../../src/queue-evidence.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';

async function source(t:test.TestContext,verdict='return'){
  const f=await candidateFixture(t);f.q.attachIntegrationCandidate(raw(f.link));if(verdict==='return')await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="complete"','mode="return"'));
  const parent=await runReception(f.receiverPath),memberVerification=join(f.root,'member-a-own-verification');await verify({snapshots:[f.snapshots[0]!],objects:f.objects,plan:join(f.root,'units-test.json'),output:memberVerification});const packet=await readPacket(f.snapshots[0]!,memberVerification,join(f.root,'integration-context.json')),member=f.q.import(packet);assert.equal(packet.summary.evidenceComplete,false);assert.deepEqual(packet.summary.gaps,['sample_failure_or_incomplete_comparison']);
  const r=f.q.receiverState(parent.operation),receipt=JSON.parse(await readFile(join(r.receiver.directory,'claude/completed.json'),'utf8')),request={schemaVersion:1,kind:'tongxu-integration-member-return',id:'selected-return',integration:f.request.id,reception:{operation:parent.operation,packet:r.result.packet,bindingHash:r.receiver.bindingHash,judgmentId:r.receiver.judgmentId,inputSha256:r.receiver.inputSha256,finalSha256:hash(receipt.finalText)},member:{index:0,H:f.A,B:f.B,manifestSha256:f.packet.summary.composition!.subject.members[0]!.manifestHash,item:member.item,packet:member.packet,fingerprint:packet.fingerprint},scopeSha256:hash(canonical(f.context.scope)),arrangementSha256:hash(canonical(f.context.arrangement)),findingIndexes:[0],source:'explicit evidence association fixture; finding has not yet passed fact verification and grants no writing'};
  return {...f,parent,member,request,receipt};
}
test('exact member return retains full parent originals and failing standalone evidence without inventing a reception or permission',async t=>{
  const f=await source(t),before=f.q.status(),r=f.q.integrationMemberReturns(),recorded=r.record(raw(f.request));assert.equal(recorded.current,true);assert.equal(recorded.repairStarted,false);assert.equal(recorded.writePermissionGranted,false);assert.equal(recorded.individualReceptionInferred,false);const saved=r.material(f.request.id);assert.equal(saved.proof.parent.fullFinal,f.receipt.finalText);assert.equal(saved.proof.parent.judgment.verdict,'RETURN_FOR_WORK');assert.equal(saved.proof.member.report.stages[1].tools[0].sampleSet.samples[0].status,'fail');assert.ok(saved.originals.some(x=>x.sha256===f.request.reception.inputSha256));assert.equal(saved.proof.selectedFindings[0].index,0);assert.equal(r.record(raw(f.request)).duplicate,true);assert.equal(await f.count(),1);assert.deepEqual(f.q.status().operations,before.operations);assert.deepEqual(f.q.status().claims,before.claims);assert.throws(()=>r.record(raw({...f.request,findingIndexes:[0,1]})),/request_changed/);
  await f.addPacket({pr:10,H:f.A3,sourceAt:new Date(Date.now()+60000).toISOString()});assert.equal(r.state(f.request.id).current,false);assert.equal(r.material(f.request.id).proof.parent.fullFinal,f.receipt.finalText);assert.equal(await f.count(),1);
});
test('changed final, wrong member and unsupported finding index cannot become a member return',async t=>{
  const f=await source(t),r=f.q.integrationMemberReturns();for(const request of [{...f.request,id:'changed-final',reception:{...f.request.reception,finalSha256:'0'.repeat(64)}},{...f.request,id:'wrong-member',member:{...f.request.member,index:1}},{...f.request,id:'missing-finding',findingIndexes:[1]}])assert.throws(()=>r.record(raw(request)));assert.equal(await f.count(),1);
});
test('an accepted integration cannot be converted to repair merely by selecting text from its report',async t=>{
  const f=await source(t,'accept');assert.equal(f.parent.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.throws(()=>f.q.integrationMemberReturns().record(raw(f.request)),/original_return_required/);assert.equal(await f.count(),1);assert.equal(f.q.status().claims.length,0);
});
