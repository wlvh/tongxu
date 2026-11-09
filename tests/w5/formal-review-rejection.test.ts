import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {formalFixture,ended} from './formal-round-fixture.js';
import {QueueFormalRoundHost} from '../../src/formal-review-host.js';
import {runFormalReviewRound} from '../../src/formal-review.js';
import {FormalReviewControls} from '../../src/formal-review-controls.js';
import {hash} from '../../src/snapshot.js';

for(const corruption of ['none','stdout','inputs','binding','unreconciled-tool','active-process']){
  test('cold formal controller retains a rejected complete reviewer and settles only verified originals; corruption='+corruption,async t=>{
    const f=await formalFixture(t,'pass',true);
    const script=await readFile(f.n.config.codexExecutable,'utf8');
    const contradictory=script.replace("coverageGaps:incomplete?['Fixture missing caller evidence']:[]",
      "coverageGaps:['Explicit fixture missing scoped evidence']");
    assert.notEqual(contradictory,script);
    await writeFile(f.n.config.codexExecutable,contradictory);
    const prepared=await f.controls.prepare(f.entry.id,'rejected-original');
    const original=f.q.formalReviews().state(prepared.operation);
    // Run the real registered transport without the controller's new catch
    // handling, reproducing an old unreturned stage from before this repair.
    const host=new QueueFormalRoundHost(f.q,prepared.operation,original.request,async()=>{},()=>{});
    await assert.rejects(runFormalReviewRound(host),/formal_pass_has_unresolved_work/);
    const stage=f.q.formalReviews().state(prepared.operation).stages[0]!;
    assert.equal(stage.dispatched,true);
    assert.equal(stage.returned,null);
    assert.equal(f.q.status().claims.length,1);
    const rawPath=join(stage.stage.directory,'stdout.ndjson');
    const raw=await readFile(rawPath);
    assert.equal((await f.calls()).length,1);
    assert.equal(f.ledger!.state().settlements.length,0);
    const corrupt=corruption!=='none';
    if(corruption==='stdout')await writeFile(rawPath,Buffer.concat([raw,Buffer.from('{}\n')]));
    if(corruption==='inputs'){
      const path=join(stage.stage.directory,'inputs.json');
      const inputs=JSON.parse(await readFile(path,'utf8'));
      inputs[0].input+=' Changed fixture input after execution.';
      await writeFile(path,JSON.stringify(inputs));
    }
    if(corruption==='binding'){
      const path=join(stage.stage.directory,'binding.json');
      const binding=JSON.parse(await readFile(path,'utf8'));
      binding.candidate.H='f'.repeat(40);
      await writeFile(path,JSON.stringify(binding));
    }
    if(corruption==='unreconciled-tool')await writeFile(join(stage.stage.directory,'reconciled-tools.json'),JSON.stringify([
      {request:{id:'unmatched',params:{tool:'tongxu_read_file'}},response:{id:'unmatched',result:{}}},
    ]));
    if(corruption==='active-process')await writeFile(join(stage.stage.directory,'process.json'),JSON.stringify({pid:process.pid}));
    const retained=await readFile(rawPath);
    await f.controls.drain();
    const cold=await FormalReviewControls.load(f.catalog,hash(await readFile(f.catalog)),f.sources,undefined,async()=>f.live);
    t.after(()=>cold.drain());
    await cold.begin(f.entry.id,prepared.operation);
    const report=await ended({...f,controls:cold},prepared.operation);
    assert.equal(report.phase,corrupt?'waiting':'needs_evidence',JSON.stringify(report.detail));
    assert.equal(report.resourcesSettled,!corrupt);
    assert.equal(f.q.status().claims.length,corrupt?1:0);
    assert.equal(f.ledger!.state().settlements.length,corrupt?0:1);
    if(!corrupt){
      assert.equal(report.fullStages[0].result.formalJudgmentAccepted,false);
      assert.equal(report.fullStages[0].result.protocolRejection,'formal_pass_has_unresolved_work');
      assert.equal(typeof report.fullStages[0].result.report,'string','the normal report panel consumes complete original text');
      assert.equal(JSON.parse(report.fullStages[0].result.report).verdict,'PASS');
      assert.equal(report.result.reason,'formal_pass_has_unresolved_work');
    }
    assert.deepEqual(await readFile(rawPath),retained);
    await cold.begin(f.entry.id,prepared.operation);
    await ended({...f,controls:cold},prepared.operation);
    assert.equal((await f.calls()).length,1);
    assert.equal(f.ledger!.state().settlements.length,corrupt?0:1);
    assert.deepEqual(f.q.formalReviews().state(prepared.operation).request,original.request);
  });
}

test('a newly rejected complete formal reviewer terminates as needs_evidence without sending a replacement',async t=>{
  const f=await formalFixture(t);
  const script=await readFile(f.n.config.codexExecutable,'utf8');
  await writeFile(f.n.config.codexExecutable,script.replace("coverageGaps:incomplete?['Fixture missing caller evidence']:[]",
    "coverageGaps:['Explicit fixture incomplete scope']"));
  const prepared=await f.controls.prepare(f.entry.id,'hot-rejection');
  await f.controls.begin(f.entry.id,prepared.operation);
  const report=await ended(f,prepared.operation);
  assert.equal(report.phase,'needs_evidence',JSON.stringify(report.detail));
  assert.equal(JSON.parse(report.fullStages[0].result.report).verdict,'PASS');
  assert.equal(report.fullStages[0].result.formalJudgmentAccepted,false);
  assert.equal(f.q.status().claims.length,0);
  assert.equal((await f.calls()).length,1);
});

if(process.env.TONGXU_TEST_DOCKER_CONFIG)test('rejected reviewer cleanup reconciles actual registered Docker tests and its exact read-only workspace lease',async t=>{
  const f=await formalFixture(t,'pass',true);
  let script=await readFile(f.n.config.codexExecutable,'utf8');
  script=script.replace("coverageGaps:incomplete?['Fixture missing caller evidence']:[]",
    "coverageGaps:['Explicit fixture incomplete scope after registered tests']");
  script=script.replace(/finishReview=r=>[^;]+;/,
    "finishReview=r=>{context.rejectedFormal=r;tool('tongxu_read_file',{path:'sample.js'});};");
  script=script.replace('const v=JSON.parse(m.result.contentItems[0].text);',
    'const v=JSON.parse(m.result.contentItems[0].text);if(context.rejectedFormal&&stage===\'tongxu_run_tests\'){finish(context.rejectedFormal);return;}');
  await writeFile(f.n.config.codexExecutable,script);
  const prepared=await f.controls.prepare(f.entry.id,'rejected-after-tests');
  const original=f.q.formalReviews().state(prepared.operation);
  const host=new QueueFormalRoundHost(f.q,prepared.operation,original.request,async()=>{},()=>{});
  await assert.rejects(runFormalReviewRound(host),/formal_pass_has_unresolved_work/);
  const directory=original.request.directory;
  const lock=join(directory,'project','workspace','.git','tongxu-writer.json');
  const lease=await readFile(lock);
  assert.ok(lease.length);
  await f.controls.begin(f.entry.id,prepared.operation);
  const report=await ended(f,prepared.operation);
  assert.equal(report.phase,'needs_evidence',JSON.stringify(report.detail));
  assert.equal(report.resourcesSettled,true);
  assert.equal(f.q.status().claims.length,0);
  assert.equal(f.ledger!.state().settlements.length,1);
  await assert.rejects(readFile(lock),{code:'ENOENT'});
  assert.equal((await f.calls()).length,1);
});
