import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {overallFixture} from '../review-records/overall-fixture.js';
import {startWorkbench,parseWorkbenchPlan} from '../../src/workbench.js';
import {OverallControls} from '../../src/overall-controls.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';

async function ready(t:test.TestContext){
  const f=await overallFixture(t),sources=[{id:'original',title:'明确复盘测试任务',store:f.store,item:f.item}],selection={id:'review',title:'明确测试复盘；没有供应商调用',source:'original',plan:{path:f.planPath,sha256:hash(await readFile(f.planPath))}},plan={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'复盘测试',goal:'Explicit isolated fixture; not product acceptance',sources,overallReviews:[selection]},path=join(f.root,'workbench.json');await writeFile(path,canonical(plan));
  return {...f,sources,selection,workbenchPlan:plan,workbenchPath:path};
}
function client(url:string){const u=new URL(url),headers={Authorization:'Bearer '+u.hash.slice(1),'Content-Type':'application/json',Origin:u.origin};
  const get=async(path='/api/state')=>{const r=await fetch(u.origin+path,{headers});return {status:r.status,body:await r.json() as any};},post=async(action:string,body:any={},h=headers)=>{const r=await fetch(u.origin+'/api/overall-review/review/'+action,{method:'POST',headers:h,body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
  async function settled(){for(let i=0;i<200;i++){const r=(await get()).body.overallReviews[0];if(!r.active)return r;await new Promise(r=>setTimeout(r,25));}throw new Error('fixture_overall_wait_timeout');}return {get,post,settled,headers};
}
test('fixed UI prepares, executes and reads the full original report; reload and repeat cause no model replay',async t=>{
  const f=await ready(t),app=await startWorkbench(f.workbenchPath);t.after(()=>app.close());const c=client(app.url),before=await readFile(f.m.trace),saved=f.q.status();
  const state=(await c.get()).body.overallReviews[0];assert.equal(state.phase,'not_prepared');assert.equal(state.material.acceptedBaseline.length,0);assert.ok(!JSON.stringify(state).includes(f.root));assert.deepEqual(f.q.status(),saved);assert.deepEqual(await readFile(f.m.trace),before);
  assert.equal((await c.post('run',{}, {...c.headers,Origin:'https://elsewhere.example'})).status,403);assert.equal((await c.post('run',{plan:'/arbitrary'})).status,503);assert.equal((await c.get('/api/overall-report/not-selected')).status,503);
  assert.equal((await c.post('prepare')).status,202);assert.equal((await c.settled()).phase,'prepared_not_sent');assert.deepEqual(await readFile(f.m.trace),before);
  const requests=await Promise.all([c.post('run'),c.post('run')]);assert.ok(requests.every(x=>x.status===202));assert.equal((await c.settled()).phase,'review_recorded');
  const r=await c.get('/api/overall-report/review');assert.equal(r.status,200);assert.equal(r.body.report,'Independent synthetic review of current candidate.');assert.equal(r.body.reportSha256,hash(r.body.report));assert.equal(r.body.noOverallDriftEstablished,false);assert.equal(r.body.executionKind,'fixture');
  const trace=await readFile(f.m.trace),recorded=f.q.status();await c.get();await c.get('/api/overall-report/review');assert.deepEqual(f.q.status(),recorded);await c.post('run');await c.settled();assert.deepEqual(await readFile(f.m.trace),trace);
  const another=await startWorkbench(f.workbenchPath);t.after(()=>another.close());const d=client(another.url);assert.equal((await d.get()).body.overallReviews[0].phase,'review_recorded');await d.post('reconcile');await d.settled();assert.deepEqual(await readFile(f.m.trace),trace);
  assert.throws(()=>parseWorkbenchPlan(Buffer.from(canonical({...f.workbenchPlan,kind:'tongxu-local-workbench'}))),/invalid_workbench_controls/);
});
test('selected hash and original task identity cannot be swapped at runtime, while saved reports remain readable',async t=>{
  const f=await ready(t);await assert.rejects(OverallControls.load([f.selection],[{...f.sources[0]!,item:'f'.repeat(64)}]),/task_not_selected/);await assert.rejects(OverallControls.load([f.selection,{...f.selection,id:'second'}],f.sources),/duplicate_selection/);
  const app=await startWorkbench(f.workbenchPath);t.after(()=>app.close());const c=client(app.url),before=await readFile(f.m.trace);await writeFile(f.planPath,canonical({...f.plan,trigger:{...f.plan.trigger,reason:'runtime changed plan'}}));await c.post('run');const state=await c.settled();assert.equal(state.phase,'not_prepared');assert.equal(state.currentControllerProblem,'overall_selected_plan_changed');assert.deepEqual(await readFile(f.m.trace),before);
});
test('an unknown final stays unknown on reopen; original lookup and unstarted closure cannot turn it into a second task',async t=>{
  const f=await ready(t);await writeFile(f.m.config.codexExecutable,(await readFile(f.m.config.codexExecutable,'utf8')).replace("report:'Independent synthetic review of current candidate.'","candidateH:'0'.repeat(40),report:'Explicit invalid candidate fixture.'"));
  const app=await startWorkbench(f.workbenchPath);t.after(()=>app.close());const c=client(app.url);await c.post('run');assert.equal((await c.settled()).phase,'submitted_or_unknown');const before=await readFile(f.m.trace);
  await c.post('reconcile');assert.equal((await c.settled()).phase,'submitted_or_unknown');await c.post('close-unstarted');const s=await c.settled();assert.equal(s.phase,'submitted_or_unknown');assert.equal(s.lastProblem,'overall_native_execution_started_or_unknown');assert.deepEqual(await readFile(f.m.trace),before);
  assert.equal((await c.get('/api/overall-report/review')).status,404);
});
