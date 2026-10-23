import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TaskControls} from '../../src/task-controls.js';
import {hash} from '../../src/snapshot.js';
import {taskChoicePageFixture as page,waitForTaskChoicePage as wait} from './task-choice-page-fixture.js';

test('one original task page starts an optional contact, shows all original reports and reopens without manual copies',async t=>{
  const f=await page(t),before=await readFile(f.trace);assert.equal((await f.post({recipient:'someone-else'})).status,400);assert.deepEqual(await readFile(f.trace),before);
  assert.equal((await f.post()).status,202);const done=await wait(f,v=>!v.controllerActive&&v.contactChoice.complete);assert.equal(done.phase,'returned');assert.equal(done.contactChoice.selectedContact,'contract');assert.equal(done.contactChoice.steps.length,3);
  const events=f.q.status().events,full=await f.report();assert.equal(full.kind,'original-task-contact-choice-reports');assert.equal(full.complete,true);assert.equal(full.steps.length,3);for(const s of full.steps){assert.ok(s.report.report);assert.equal(s.report.completeCapture,true);assert.equal(s.report.consumptionConfirmed,true);}assert.deepEqual(f.q.status().events,events);
  const trace=await readFile(f.trace);await f.post();await wait(f,v=>!v.controllerActive);assert.deepEqual(await readFile(f.trace),trace);const reopened=await f.load(),saved=await reopened.report('choose-contact');assert.ok('steps' in saved);assert.equal(saved.steps.length,3);assert.deepEqual(await readFile(f.trace),trace);await reopened.drain();
});

test('only selected task recipients are admitted and original investment stop blocks the whole contact flow',async t=>{
  const f=await page(t);await assert.rejects(TaskControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),[f.sources[0]!]),/recipient_not_selected/);
  f.q.control(f.definition.context.scope.id,'investment','stopped','explicit choice fixture stop');await f.post();const held=await wait(f,v=>!v.controllerActive&&v.lastControllerReturn);assert.equal(held.contactChoice.complete,false);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,0);assert.equal(f.q.taskInbox().status(f.b.item).length,0);
});

test('a partial B reply remains unresolved on the page and explicit replay sends no new input',async t=>{
  const f=await page(t,'unknown-b');await f.post();const held=await wait(f,v=>!v.controllerActive&&v.phase==='unresolved');assert.equal(held.contactChoice.steps.length,2);assert.equal(held.contactChoice.complete,false);const full=await f.report();assert.equal(full.complete,false);assert.ok(full.steps[0].report.report);assert.equal(full.steps[1].report,null);
  const trace=await readFile(f.trace);await f.post();await wait(f,v=>!v.controllerActive);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.q.taskInbox().status(f.a.item).length,1);
});

test('closing an actual task controller during A does not start B; another explicit entry reuses A',async t=>{
  const f=await page(t,'contact-delay'),controls=await f.load();await controls.begin('choose-contact');const end=Date.now()+4000;while(!(await f.calls()).some(c=>c.kind==='input')){if(Date.now()>end)throw new Error('fixture_initial_input_missing');await new Promise(r=>setTimeout(r,10));}await controls.drain();
  assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);assert.equal(f.q.taskInbox().status(f.b.item).length,0);const next=await f.load(),result=await next.execute('choose-contact'),execution=result.execution as {completed:boolean;newModelRequests:number};assert.equal(execution.completed,true);assert.equal(execution.newModelRequests,2);await next.drain();
});
