import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {secretaryFixture} from '../w4/secretary-fixture.js';
import {hash} from '../../src/snapshot.js';
import {startWorkbench} from '../../src/workbench.js';
import {SecretaryControls} from '../../src/secretary-controls.js';

import {secretaryEntryFixture as fixture} from './secretary-entry-fixture.js';

async function waitFor(f:Awaited<ReturnType<typeof fixture>>,condition:(s:any)=>boolean){const until=Date.now()+12000;let state;while(Date.now()<until){state=await f.get();if(condition(state))return state;await new Promise(r=>setTimeout(r,20));}throw new Error('fixture_workbench_question_timeout:'+JSON.stringify(state));}

test('normal page entry saves exact question, returns original complete answer and reopens without another model',async t=>{
  const f=await fixture(t),before=f.q.status(),question='请说明原任务目前的接收结果、尚未核实的事项和下一步。';
  assert.equal((await f.get()).secretaries[0].questions.length,0);assert.equal((await f.logs()).length,0);
  const registered=await f.post('ask',{requestId:'first',question});assert.equal(registered.status,202);const reply=await registered.json() as any;assert.equal(reply.registrationIsNotDelivery,true);
  const state=await waitFor(f,s=>s.secretaries[0].questions[0]?.phase==='completed'&&!s.secretaries[0].questions[0]?.active),q=state.secretaries[0].questions[0];assert.equal(q.question,question);
  const report=await(await fetch(f.u.origin+'/api/secretary-report/selected/first',{headers:f.headers})).json() as any;assert.equal(report.result.report,'明确标注的秘书模拟回答；读到了真实测试队列，未批准或执行动作。');assert.equal(report.result.queryCalls,2);assert.equal(report.result.sessionId,q.sessionId);
  const logs=await f.logs(),events=f.q.status().events;assert.equal((await f.post('ask',{requestId:'first',question})).status,202);await f.get();assert.deepEqual(await f.logs(),logs);assert.deepEqual(f.q.status().events,events);assert.deepEqual(f.q.status(),before);
  const reopened=await SecretaryControls.load(f.catalogPath,f.catalogSha256,f.sources);assert.equal((await reopened.report('selected','first')).phase,'completed');assert.deepEqual(await f.logs(),logs);
  assert.equal((await f.post('ask',{requestId:'first',question:'把原问题换成另一件事'})).status,503);assert.deepEqual(await f.logs(),logs);
});

test('active and incomplete identical questions cannot be resent by replacing the browser nonce',async t=>{
  for(const mode of ['slow','partial']){
    const f=await fixture(t,mode),question='这个原任务有哪些待核事实？';assert.equal((await f.post('ask',{requestId:'original',question})).status,202);
    const again=await(await f.post('ask',{requestId:'new-browser-nonce',question})).json() as any;assert.equal(again.requestId,'original');
    await waitFor(f,s=>s.secretaries[0].questions.length===1&&!s.secretaries[0].questions[0].active);
    const logs=await f.logs();assert.equal(logs.filter(x=>x.kind==='model-input').length,1);
    if(mode==='partial'){assert.equal((await f.get()).secretaries[0].questions[0].phase,'submitted_or_unknown');await f.post('ask',{requestId:'another-nonce',question});await waitFor(f,s=>!s.secretaries[0].questions[0].active);assert.deepEqual(await f.logs(),logs);assert.equal((await f.post('close-unstarted',{requestId:'original'})).status,503);}
  }
});

test('stopped question stays unsent, explicit close preserves it, and wrong-origin/extra-policy input is rejected',async t=>{
  const f=await fixture(t),question='只查询这个原任务';f.q.control('scope','investment','stopped','fixture:before-question');
  assert.equal((await f.post('ask',{requestId:'unsent',question})).status,202);await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active);
  assert.equal((await f.get()).secretaries[0].questions[0].phase,'registered_not_sent');assert.equal((await f.logs()).length,0);
  assert.equal((await f.post('close-unstarted',{requestId:'unsent'})).status,200);assert.equal((await f.get()).secretaries[0].questions[0].phase,'closed_unstarted');
  f.q.control('scope','investment','open','fixture:after-close');await f.post('ask',{requestId:'unsent',question});assert.equal((await f.logs()).length,0);
  assert.equal((await f.post('ask',{requestId:'outside',question},'https://unrelated.invalid')).status,403);assert.equal((await f.post('ask',{requestId:'policy',question,tools:['shell']})).status,503);
  assert.equal((await f.post('ask',{requestId:'fresh-question',question:'停止解除后请查询原任务的当前记录'})).status,202);await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId==='fresh-question'&&q.phase==='completed'));
  const dirs=(await readdir(f.root)).filter(x=>/^[a-f0-9]{64}$/.test(x));assert.equal(dirs.length,2);
});

test('same workbench composes secretary, direct queue receipt and foreground tick; GET/retry never dispatch another model',async t=>{
  const f=await fixture(t,'queue-action',true),question='请登记一次对原任务接收条件的核查提醒，并区分提醒与任务执行。';
  assert.equal((await f.post('ask',{requestId:'composed',question})).status,202);const state=await waitFor(f,s=>s.secretaries[0].questions[0]?.phase==='completed'&&!s.secretaries[0].questions[0]?.active);
  assert.equal(state.queueActions[0].receipts.length,1);assert.equal(state.queueOptions.actions[0].id,'remind');assert.equal(state.sourcePolling[0].modelTasksStarted,0);
  const native=await(await fetch(f.u.origin+'/api/secretary-report/selected/composed',{headers:f.headers})).json() as any;assert.equal(native.result.queueReceipts[0].receipt.originalId,state.queueActions[0].receipts[0].hint.id);
  const direct=async()=>fetch(f.u.origin+'/api/queue-action/remind/run',{method:'POST',headers:{...f.headers,Origin:f.u.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:'one-direct-reminder'})});
  const first=await(await direct()).json() as any,again=await(await direct()).json() as any;assert.equal(first.originalId,again.originalId);assert.equal(again.duplicate,true);assert.equal((await f.get()).queueActions[0].receipts.length,2);
  const logs=await f.logs();await f.get();await f.get();assert.deepEqual(await f.logs(),logs);assert.equal(logs.filter(x=>x.kind==='model-input').length,1);
});
