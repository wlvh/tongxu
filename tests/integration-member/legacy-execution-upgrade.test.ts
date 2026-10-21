import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from '../../src/queue-store.js';
import {runMemberRecomposition} from '../../src/member-recomposition.js';
import {runDeliveryValidation} from '../../src/delivery-validation.js';
import {deliveryValidationSha} from '../../src/delivery-validation-contract.js';
import {raw} from '../integration/fixture.js';
import {installW2ExecutionGuards} from '../../src/w2-execution-store.js';

const legacyRoot=process.env.TONGXU_RECOMPOSITION_LEGACY_ROOT;
const registryLegacyRoot=process.env.TONGXU_W2_V1_LEGACY_ROOT;
const old=(path:string)=>import(pathToFileURL(join(legacyRoot!,'dist',path+'.js')).href);
function guards(store:string){const db=new DatabaseSync(join(store,'queue.sqlite'),{readOnly:true});try{return db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'w2_execution_%' ORDER BY name").all().map(r=>r.name);}finally{db.close();}}
async function hideOriginal(root:string){
  const reportPath=join(root,'verification.json'),reportBytes=await readFile(reportPath),report=JSON.parse(reportBytes.toString()),tool=report.stages[0].tools[0],directory=join(root,tool.dockerExecutionDirectory),execution=await readFile(join(directory,'execution.json')),retained=join(root,'retained-unknown-tool-original');
  await writeFile(join(directory,'execution.json'),raw({...JSON.parse(execution.toString()),cleanup:'unknown'}));await rename(directory,retained);report.executionComplete=false;report.stages[0].tools=[{id:tool.id,argv:tool.argv,status:'blocked',startedAt:tool.startedAt,gaps:['explicit_missing_original_fixture']}];await writeFile(reportPath,raw(report));
  return async()=>{await rename(retained,directory);await writeFile(join(directory,'execution.json'),execution);await writeFile(reportPath,reportBytes);};
}

test('the exact prior registry guards upgrade without removing original events',{skip:!registryLegacyRoot},async()=>{
  const legacy=await import(pathToFileURL(join(registryLegacyRoot!,'dist/src/w2-execution-store.js')).href),db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,object TEXT,data TEXT,observed_at TEXT)');db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('original_fixture','original','{"preserved":true}','fixed');legacy.installW2ExecutionGuards(db);const events=db.prepare('SELECT * FROM events').all();assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'w2_execution_%'").all().length,2);db.exec('BEGIN IMMEDIATE');installW2ExecutionGuards(db);db.exec('COMMIT');assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'w2_execution_%'").all().length,3);assert.deepEqual(db.prepare('SELECT * FROM events').all(),events);}finally{db.close();}
});

for(const entry of ['run','repeat-prepare'])test('legacy already-started recomposition keeps upgrade protection after rejected capture: '+entry,{skip:!legacyRoot,timeout:180000},async t=>{
  const fixture=await old('tests/integration-member/governed-recomposition-fixture'),runtime=await old('src/member-recomposition'),store=await old('src/recomposition-test-store'),f=await fixture.governedRecompositionFixture(t),complete=store.RecompositionTestRecords.prototype.complete;
  store.RecompositionTestRecords.prototype.complete=function(){throw new Error('fixture_legacy_before_consumption');};try{await assert.rejects(runtime.runMemberRecomposition(f.recompositionPath),/fixture_legacy_before_consumption/);}finally{store.RecompositionTestRecords.prototype.complete=complete;}
  const original=f.q.recompositionTests().state(f.recompositionPlan.id),settlements=f.ledger.state().settlements.length,trace=await readFile(f.model.trace);assert.equal(original.binding.executionRegistryVersion,undefined);assert.deepEqual(guards(f.store),[]);const restore=await hideOriginal(join(original.directory,'verification'));
  if(entry==='repeat-prepare'){const q=await QueueStore.open(f.store);try{const p=f.recompositionPlan;assert.equal(q.recompositionTests().prepare(await readFile(f.recompositionPath),await readFile(join(f.newMember.path,'manifest.json')),await readFile(p.testPlan.path),[]).duplicate,true);}finally{q.close();}assert.equal(guards(f.store).length,3);await assert.rejects(runtime.runMemberRecomposition(f.recompositionPath),/w2_execution_registry_capture_required/);}
  await assert.rejects(runMemberRecomposition(f.recompositionPath),/w2_original_execution_unknown/);assert.deepEqual(guards(f.store),['w2_execution_registration_guard','w2_execution_resource_guard','w2_execution_result_guard']);assert.equal(f.q.resources().status(f.testResource).state,'held');
  await assert.rejects(runtime.runMemberRecomposition(f.recompositionPath),/w2_execution_registry_capture_required/);assert.equal(f.q.recompositionTests().state(f.recompositionPlan.id).phase,'started_or_unknown');assert.equal(f.ledger.state().settlements.length,settlements);assert.ok((await readFile(f.model.trace)).equals(trace));
  await restore();const recovered=await runMemberRecomposition(f.recompositionPath);assert.equal(recovered.phase,'new_integration_candidate_requires_own_reception');assert.equal(f.q.recompositionTests().state(f.recompositionPlan.id).binding.run,original.binding.run);assert.equal(f.ledger.state().settlements.length,settlements+1);assert.equal((await runMemberRecomposition(f.recompositionPath) as any).newGitProcesses,0);assert.ok((await readFile(f.model.trace)).equals(trace));
  await writeFile(join(f.root,'upgrade-proof.json'),raw({entry,originalRun:original.binding.run,guards:guards(f.store),legacyBlocked:true,restoredSameRun:true,resource:f.q.resources().status(f.testResource),newModelInputs:0}));
});

test('legacy already-started delivery validation installs protection before rejecting its old capture',{skip:!legacyRoot,timeout:180000},async t=>{
  const fixture=await old('tests/delivery-validation/fixture'),runtime=await old('src/delivery-validation'),store=await old('src/delivery-validation-store'),f=await fixture.deliveryFixture(t),complete=store.DeliveryValidationRecords.prototype.complete;
  store.DeliveryValidationRecords.prototype.complete=function(){throw new Error('fixture_legacy_delivery_before_consumption');};try{await assert.rejects(runtime.runDeliveryValidation(f.store,f.planPath),/fixture_legacy_delivery_before_consumption/);}finally{store.DeliveryValidationRecords.prototype.complete=complete;}
  const before=f.q.deliveryValidations().state(f.plan.id),directory=join(f.store,'delivery-validation-'+deliveryValidationSha(f.plan));assert.deepEqual(guards(f.store),[]);const restore=await hideOriginal(join(directory,'verification'));
  await assert.rejects(runDeliveryValidation(f.store,f.planPath,'reconcile'),/delivery_validation_original_execution_unknown/);assert.equal(guards(f.store).length,3);await assert.rejects(runtime.runDeliveryValidation(f.store,f.planPath,'reconcile'),/w2_execution_registry_capture_required/);assert.equal(f.q.deliveryValidations().state(f.plan.id).phase,'started_or_unknown');
  await restore();const recovered=await runDeliveryValidation(f.store,f.planPath,'reconcile');assert.ok('result' in recovered);assert.equal(recovered.result.scenarioAssertionsPassed,true);assert.equal(recovered.run,before.run);assert.equal(recovered.newVerificationRuns,0);assert.equal((await f.calls()).length,0);
});

test('a legacy invalid result already recorded but not settled cannot escape through the old resource consumer',{skip:!legacyRoot,timeout:180000},async t=>{
  const fixture=await old('tests/integration-member/governed-recomposition-fixture'),runtime=await old('src/member-recomposition'),store=await old('src/recomposition-test-store'),resource=await old('src/resource-claims'),f=await fixture.governedRecompositionFixture(t),complete=store.RecompositionTestRecords.prototype.complete,outcome=store.RecompositionTestRecords.prototype.outcome;
  store.RecompositionTestRecords.prototype.complete=function(){throw new Error('fixture_old_result_not_consumed');};try{await assert.rejects(runtime.runMemberRecomposition(f.recompositionPath),/fixture_old_result_not_consumed/);}finally{store.RecompositionTestRecords.prototype.complete=complete;}
  const initial=f.q.recompositionTests().state(f.recompositionPlan.id),restore=await hideOriginal(join(initial.directory,'verification')),settlements=f.ledger.state().settlements.length;
  store.RecompositionTestRecords.prototype.outcome=function(){throw new Error('fixture_old_result_not_reported');};try{assert.equal((await runtime.runMemberRecomposition(f.recompositionPath)).phase,'recomposition_test_resource_result_pending');}finally{store.RecompositionTestRecords.prototype.outcome=outcome;}
  assert.equal(f.q.recompositionTests().state(f.recompositionPlan.id).phase,'recorded');assert.equal(f.q.resources().status(f.testResource).state,'held');
  await assert.rejects(runMemberRecomposition(f.recompositionPath),/w2_original_execution_unknown/);await assert.rejects(resource.resourceAction(f.store,f.testResource,'record-result','background'),/w2_verified_original_result_required/);assert.equal(f.ledger.state().settlements.length,settlements);assert.equal(f.q.resources().status(f.testResource).state,'held');
  const q=await QueueStore.open(f.store);try{assert.equal(q.recompositionTests().state(f.recompositionPlan.id).captureValidationCurrent,false);}finally{q.close();}
  // Preserve the bad historical result; restoration is not permission to
  // overwrite it or report a different result under its old accounting ID.
  await restore();await assert.rejects(runMemberRecomposition(f.recompositionPath),/recomposition_test_result_changed/);assert.equal(f.ledger.state().settlements.length,settlements);
});

test('a complete legacy result gets current capture validation without replaying execution',{skip:!legacyRoot,timeout:180000},async t=>{
  const fixture=await old('tests/delivery-validation/fixture'),runtime=await old('src/delivery-validation'),f=await fixture.deliveryFixture(t),original=await runtime.runDeliveryValidation(f.store,f.planPath);assert.equal(original.phase,'recorded');
  const q=await QueueStore.open(f.store);try{assert.equal(q.deliveryValidations().state(f.plan.id).captureValidationCurrent,false);}finally{q.close();}
  const current=await runDeliveryValidation(f.store,f.planPath,'reconcile');assert.ok('result' in current);assert.equal(current.captureValidationCurrent,true);assert.equal(current.run,original.run);assert.equal(current.newVerificationRuns,0);assert.equal(current.result.scenarioAssertionsPassed,true);assert.equal((await f.calls()).length,0);
});
