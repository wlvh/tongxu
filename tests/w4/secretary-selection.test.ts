import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {secretaryFixture} from './secretary-fixture.js';
import {selectSecretaryRuntime,runSecretary,readSecretaryResult} from '../../src/secretary.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

test('atomic selection survives interruption before projections; missing projections do not require a new CLI selection or input',async t=>{
  const f=await secretaryFixture(t),source=await readFile(f.secretaryPlan),selected=Buffer.from(canonical(await selectSecretaryRuntime(f.p)));
  await mkdir(f.output,{mode:0o700});
  const record=Buffer.from(JSON.stringify({schemaVersion:1,kind:'tongxu-secretary-runtime-selection',source:{sha256:hash(source),base64:source.toString('base64')},selected:{sha256:hash(selected),base64:selected.toString('base64')}}));
  await writeFile(join(f.output,'runtime-selection.json'),record);
  assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
  const result=await runSecretary(f.secretaryPlan,f.output);assert.equal(result.status,'completed');
  const trace=await readFile(f.trace);
  await rm(join(f.output,'plan.json'));await rm(join(f.output,'source-plan.json'));
  assert.equal((await readSecretaryResult(f.secretaryPlan,f.output)).report,result.report);
  const again=await runSecretary(f.secretaryPlan,f.output);assert.equal(again.report,result.report);assert.equal(again.newModelTasks,0);
  assert.deepEqual(await readFile(f.trace),trace);assert.deepEqual(await readFile(join(f.output,'plan.json')),selected);assert.deepEqual(await readFile(join(f.output,'source-plan.json')),source);assert.deepEqual(await readFile(join(f.output,'runtime-selection.json')),record);
  const corrupt=Buffer.from(canonical({...JSON.parse(selected.toString()),question:'not the original request'}));await writeFile(join(f.output,'plan.json'),corrupt);
  await assert.rejects(runSecretary(f.secretaryPlan,f.output),/secretary_plan_changed/);assert.deepEqual(await readFile(join(f.output,'plan.json')),corrupt);assert.deepEqual(await readFile(f.trace),trace);
});
test('lost original selection with execution evidence is unknown, not a fresh model task',async t=>{
  const f=await secretaryFixture(t);await runSecretary(f.secretaryPlan,f.output);const trace=await readFile(f.trace);
  for(const name of ['runtime-selection.json','source-plan.json','plan.json'])await rm(join(f.output,name));
  await assert.rejects(runSecretary(f.secretaryPlan,f.output),/secretary_original_selection_missing/);
  assert.deepEqual(await readFile(f.trace),trace);
});
