import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from '../../src/queue-store.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {runMemberRefutation} from '../../src/member-refutation.js';
import {memberRepairMain} from '../../src/integration-member-cli.js';
import {runReception,reconcileReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {memberInputFixture} from './repair-fixture.js';
import {raw} from '../integration/fixture.js';
import {git} from '../../src/repair-workspace.js';

const options={skip:!process.env.TONGXU_TEST_DOCKER_CONFIG,timeout:120000};
async function fixture(t:test.TestContext,mode='project-refuted',defect=false){
  const f=await (await memberInputFixture(t,mode,defect)).prepareRepair();
  const repair=await runQueueRepair(f.planPath),ref=async(path:string)=>({path,sha256:hash(await readFile(path))});
  const plan={schemaVersion:1,kind:'tongxu-member-refutation-reception',id:'original-label-refuted',store:f.store,memberReturn:f.memberReturn,repairPlan:await ref(f.planPath),receiverPlan:await ref(f.receiverPath),source:'Explicit isolated refutation fixture; real Git and Docker, scripted model only.'},path=join(f.root,'refutation.json');await writeFile(path,raw(plan));
  return {...f,repair,refutationPlan:plan,refutationPath:path};
}
test('unchanged member refutation creates a fresh parent reception; original judgments, failed member tests and repeated zero input remain',options,async t=>{
  const f=await fixture(t),author=await f.authorState(),parent=canonical(f.q.receiverState(f.parent.operation).receiver.judgment),trace=await readFile(f.model.trace),count=await f.count();
  assert.equal(f.repair.repairStatus,'skipped_refuted');assert.equal(f.repair.after.H,f.A);assert.equal(f.repair.counters.actualFileWrites,0);assert.equal(f.repair.counters.impactReportsCompleted,0);
  const prepared=await memberRepairMain(['refute-prepare','--plan',f.refutationPath]);assert.equal('phase' in prepared&&prepared.phase,'prepared_not_sent');assert.ok((await readFile(f.model.trace)).equals(trace));assert.equal(await f.count(),count);
  assert.equal(f.q.receiverState(f.parent.operation).result.receiver.currentMaterialMatches,false);assert.equal(f.q.integrationMemberReturns().hasPendingForItem(f.member.item),true);assert.equal(f.q.status().schemaVersion,21);
  await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="complete"'));
  const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(result.reception.receiver.currentMaterialMatches,true);assert.notEqual(result.reception.operation,f.parent.operation);assert.equal(result.individualMemberAccepted,false);
  const evidence=f.q.receiverState(result.reception.operation),input=JSON.parse(evidence.input.toString()),proof=input.data.evidence.memberRefutation;assert.equal(input.binding.candidate.H,f.candidate.H);assert.equal(proof.member.candidate.H,f.A);assert.equal(proof.repair.result.after.H,f.A);assert.equal(proof.repair.result.data.factReport.decision,'refuted');assert.equal(proof.parent.fullFinal,JSON.parse(await readFile(join(f.original.receiver.directory,'claude/completed.json'),'utf8')).finalText);assert.equal(evidence.receiver.judgment.consumedMemberRefutation,proof.sha256);assert.equal(input.data.evidence.integration.source.report.stages[1].tools[0].sampleSet.samples[0].status,'fail');
  assert.equal(await f.count(),count+1);assert.ok((await readFile(f.model.trace)).equals(trace));assert.equal(canonical(f.q.receiverState(f.parent.operation).receiver.judgment),parent);assert.deepEqual(await f.authorState(),author);
  const readPrepared=await runMemberRefutation(f.refutationPath,'prepare');assert.equal('phase' in readPrepared&&readPrepared.phase,'returned');
  const receiverTrace=await readFile(f.trace);f.q.control(f.context.scope.id,'investment','stopped','fixture: stop after completed reception');await rm(f.planPath);await rm(f.receiverPath);
  const again=await runMemberRefutation(f.refutationPath);assert.ok('reception' in again);assert.equal(again.reception.operation,result.reception.operation);assert.equal(again.reception.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.ok((await readFile(f.trace)).equals(receiverTrace));assert.ok((await readFile(f.model.trace)).equals(trace));
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());const row=db.prepare('SELECT * FROM packets WHERE id=?').get(result.packet)!;const stripped=JSON.parse(String(row.summary));delete stripped.memberRefutation;assert.throws(()=>db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(String(row.item),'f'.repeat(64),String(row.manifest_hash),String(row.report_hash),String(row.context_hash),JSON.stringify(stripped),new Date().toISOString()),/member_refutation_lineage_required/);
});
test('independent reception may still return after a full fact-impact-synthesis refutation; no automatic acceptance',options,async t=>{
  const f=await fixture(t,'project-refuted-after-impact');assert.equal(f.repair.repairStatus,'skipped_refuted');assert.equal(f.repair.counters.impactReportsCompleted,1);
  const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.receiver.judgment.verdict,'RETURN_FOR_WORK');const input=JSON.parse(f.q.receiverState(result.reception.operation).input.toString());assert.equal(input.data.evidence.memberRefutation.repair.result.data.decision.decision,'refuted');assert.match(input.data.evidence.memberRefutation.repair.result.data.impact.finalText,/Synthetic impact/);const trace=await readFile(f.trace),model=await readFile(f.model.trace);await runMemberRefutation(f.refutationPath);assert.ok((await readFile(f.trace)).equals(trace));assert.ok((await readFile(f.model.trace)).equals(model));
});
test('an actually modified member cannot enter the unchanged refutation path',options,async t=>{
  const f=await fixture(t,'project',true),trace=await readFile(f.trace),model=await readFile(f.model.trace);assert.equal(f.repair.repairStatus,'completed');await assert.rejects(runMemberRefutation(f.refutationPath),/ended_refutation_required/);assert.ok((await readFile(f.trace)).equals(trace));assert.ok((await readFile(f.model.trace)).equals(model));
});
test('stop at the actual receiver dispatch prevents a new input; an unresolved original is never resent',options,async t=>{
  const f=await fixture(t),dispatch=QueueStore.prototype.receiverDispatch,trace=await readFile(f.trace),model=await readFile(f.model.trace);let injected=false;
  QueueStore.prototype.receiverDispatch=function(...args){if(!injected){injected=true;f.q.control(f.context.scope.id,'investment','stopped','fixture: stop at dispatch');}return dispatch.apply(this,args);};t.after(()=>{QueueStore.prototype.receiverDispatch=dispatch;});
  const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.status,'receiver_unknown');assert.equal(result.reception.newTaskSent,false);assert.equal(injected,true);assert.ok((await readFile(f.trace)).equals(trace));assert.ok((await readFile(f.model.trace)).equals(model));
  f.q.control(f.context.scope.id,'investment','open','fixture: reopening does not resend the original');const again=await runMemberRefutation(f.refutationPath);assert.ok('reception' in again);assert.equal(again.reception.operation,result.reception.operation);assert.ok((await readFile(f.trace)).equals(trace));
});
test('changed member observation prevents a prepared fresh reception, while original evidence stays readable',options,async t=>{
  const f=await fixture(t);await runMemberRefutation(f.refutationPath,'prepare');const trace=await readFile(f.trace),model=await readFile(f.model.trace);await f.addPacket({pr:10,H:f.A3,sourceAt:new Date(Date.now()+60000).toISOString()});
  await assert.rejects(runMemberRefutation(f.refutationPath),/source_no_longer_current/);assert.ok((await readFile(f.trace)).equals(trace));assert.ok((await readFile(f.model.trace)).equals(model));const state=f.q.memberRefutation(f.refutationPlan.id);assert.equal(state.current,false);assert.equal(state.proof.repair.result.data.factReport.decision,'refuted');
});
test('a completed final missing the exact refutation receipt is retained as invalid, not accepted',options,async t=>{
  const f=await fixture(t);await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="ignore-refutation"'));const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.status,'receiver_invalid_result');assert.equal(result.reception.receiver.invalidResult.reason,'receiver_member_refutation_not_consumed');const trace=await readFile(f.trace);await runMemberRefutation(f.refutationPath);assert.ok((await readFile(f.trace)).equals(trace));
});
test('MRF-F01: the standard receiver also refuses changed refutation captures and workspace, then restores the exact original without a substitute task',options,async t=>{
  const f=await fixture(t);await runMemberRefutation(f.refutationPath,'prepare');const trace=await readFile(f.trace),model=await readFile(f.model.trace),capture=join(f.request.executionRoot,'operation/attempt-1/fact-and-repair/stdout.ndjson'),original=await readFile(capture),source=join(f.request.executionRoot,'workspace/src/normalize.mjs'),code=await readFile(source);
  await writeFile(capture,Buffer.concat([original,Buffer.from('\nchanged fixture capture\n')]));
  await assert.rejects(runMemberRefutation(f.refutationPath),/completion_evidence_changed/);await assert.rejects(runReception(f.receiverPath),/completion_evidence_changed/);assert.ok((await readFile(f.trace)).equals(trace));assert.equal(f.q.memberRefutation(f.refutationPlan.id).current,false);
  await writeFile(capture,original);await writeFile(source,Buffer.concat([code,Buffer.from('// unaccounted fixture modification\n')]));await assert.rejects(runReception(f.receiverPath),/completed_workspace_changed/);assert.ok((await readFile(f.trace)).equals(trace));await writeFile(source,code);
  const workspace=join(f.request.executionRoot,'workspace'),index=await readFile(join(workspace,'.git/index'));await git(workspace,['update-index','--chmod=+x','src/normalize.mjs']);assert.ok((await readFile(source)).equals(code));assert.equal(f.q.memberRefutation(f.refutationPlan.id).current,false);await assert.rejects(runReception(f.receiverPath),/completed_workspace_changed/);assert.ok((await readFile(f.trace)).equals(trace));await writeFile(join(workspace,'.git/index'),index);
  await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="complete"'));const received=await runReception(f.receiverPath);assert.equal(received.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(received.receiver.currentMaterialMatches,true);assert.ok((await readFile(f.model.trace)).equals(model));
  const after=await readFile(f.trace);await writeFile(capture,Buffer.concat([original,Buffer.from('\nchanged after reception\n')]));const historical=await reconcileReception(f.store,received.operation);assert.equal(historical.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(historical.receiver.currentMaterialMatches,false);assert.ok((await readFile(f.trace)).equals(after));await writeFile(capture,original);
});
test('MRF-F01 actual dispatch rechecks capture integrity after receiver preparation',options,async t=>{
  const f=await fixture(t),dispatch=QueueStore.prototype.receiverDispatch,capture=join(f.request.executionRoot,'operation/attempt-1/fact-and-repair/stdout.ndjson'),original=await readFile(capture),trace=await readFile(f.trace);let injected=false;
  const fs=await import('node:fs');QueueStore.prototype.receiverDispatch=function(...args){if(!injected){injected=true;fs.writeFileSync(capture,Buffer.concat([original,Buffer.from('\nlate changed capture\n')]));}return dispatch.apply(this,args);};t.after(()=>{QueueStore.prototype.receiverDispatch=dispatch;});
  const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.status,'receiver_unknown');assert.equal(result.reception.newTaskSent,false);assert.equal(result.reception.reason,'completion_evidence_changed');assert.ok((await readFile(f.trace)).equals(trace));await writeFile(capture,original);
});
