import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../w3/receiver-fixture.js';
import { fixture } from '../w5/repair-fixture.js';
import { runReception } from '../../src/receiver.js';
import { overallReview } from '../../src/overall-review.js';
import { hash } from '../../src/snapshot.js';
async function ready(t:test.TestContext){
  const f=await setup(t),m=await fixture(t),received=await runReception(f.path);f.q.enableSupplements();f.q.reviewRecords().enable();
  const original=f.q.receiverState(received.operation),context=f.q.receiverEvidence(received.operation).context;
  const path=join(f.root,'evidence.txt'),body='Explicit four-category comparison fixture. No adopted baseline or actual supplier execution.';await writeFile(path,body);
  const material={name:'fixed fixture',path,sha256:hash(Buffer.from(body))};
  const plan={schemaVersion:1,kind:'tongxu-overall-review',store:f.store,operation:received.operation,judgmentId:original.receiver.judgmentId,bindingHash:original.receiver.bindingHash,context,config:m.configPath,configSha256:hash(await readFile(m.configPath)),trigger:{kind:'owner_request',source:'fixture:request',reason:'bounded overall review'},material:{acceptedBaseline:[],cumulativeChanges:[material],currentBehavior:[material],currentDocuments:[material]},baselineAcceptance:{kind:'missing',source:null}};
  const planPath=join(f.root,'overall-plan.json');await writeFile(planPath,JSON.stringify(plan));return {...f,m,plan,planPath,path};
}
test('on-demand reviewer receives four fixed material categories; missing adoption cannot become no drift, and repeat reads original capture',async t=>{
  const f=await ready(t),before=await readFile(f.m.trace),preview=await overallReview(f.planPath);assert.equal(preview.status,'prepared_not_sent');assert.deepEqual(await readFile(f.m.trace),before);
  const result=await overallReview(f.planPath,'run');assert.equal(result.status,'review_recorded');assert.equal(result.noOverallDriftEstablished,false);assert.deepEqual(result.gaps,['accepted_baseline_missing']);
  const original=await readFile(f.m.trace),again=await overallReview(f.planPath,'reconcile');assert.equal('duplicate' in again && again.duplicate,true);assert.deepEqual(await readFile(f.m.trace),original);
  const state=f.q.status();assert.equal(state.events.filter((e:any)=>e.kind==='overall_review_dispatched').length,1);assert.equal(state.events.filter((e:any)=>e.kind==='overall_review_result').length,1);
await writeFile(f.plan.material.currentBehavior[0]!.path,'changed material');await assert.rejects(overallReview(f.planPath,'run'),/overall_material_changed/);assert.deepEqual(await readFile(f.m.trace),original);
});
test('unknown review is retained and a changed plan cannot resend it; investment stop sends no new model turn',async t=>{
  const f=await ready(t),before=await readFile(f.m.trace);f.q.control('scope','investment','stopped','fixture:stop');await assert.rejects(overallReview(f.planPath,'run'),/new_investment_stopped/);assert.deepEqual(await readFile(f.m.trace),before);
  f.q.control('scope','investment','open','fixture:resume');
  const fake=f.m.config.codexExecutable;await writeFile(fake,(await readFile(fake,'utf8')).replace("verdict:'PASS'","verdict:'PASS'").replace("report:'Independent synthetic review of current candidate.'","candidateH:'0'.repeat(40),report:'Explicit wrong-candidate fixture.'"));
  await assert.rejects(overallReview(f.planPath,'run'),/structured_report_wrong_candidate/);
  const after=await readFile(f.m.trace);await assert.rejects(overallReview(f.planPath,'reconcile'));assert.deepEqual(await readFile(f.m.trace),after);
  await writeFile(f.planPath,JSON.stringify({...f.plan,trigger:{...f.plan.trigger,reason:'changed to bypass unknown'}}));await assert.rejects(overallReview(f.planPath,'run'),/overall_original_pending_or_unknown/);assert.deepEqual(await readFile(f.m.trace),after);
});
