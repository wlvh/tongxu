import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ReturnControls} from '../../src/return-controls.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {readRepairReports} from '../../src/repair.js';
import {returnWorkFixture as page,waitForReturnWork as wait,type Basic} from './return-work-fixture.js';

const opts={timeout:120000};

test('page starts original repair once, captures actual tests and independent new-candidate review, and reopens the same result',opts,async t=>{
  const f=await page(t),original=f.q.receiverState((f as Basic).operation).receiver.judgment,trace=await readFile(f.model.trace),initial=(await f.get()).returnWork[0];assert.equal(initial.repair.phase,'not_started');assert.equal(initial.repair.sourceJudgmentId,original.judgmentId);
  assert.equal((await f.post('start',{executionRoot:'/unregistered'})).status,503);assert.deepEqual(await readFile(f.model.trace),trace);
  assert.equal((await f.post('start')).status,202);assert.equal((await f.post('start')).status,202);
  const done=await wait(f,r=>r.available&&!r.active&&r.repair.phase==='returned');assert.equal(done.repair.result.status,'completed');assert.equal(done.repair.result.actualRepairPerformed,true);assert.equal(done.repair.result.testsPassed,true);assert.equal(done.repair.result.reviewCandidateH,done.repair.result.afterH);assert.notEqual(done.repair.result.beforeH,done.repair.result.afterH);
  const full=await(await fetch(f.u.origin+'/api/return-report/original-return',{headers:f.headers})).json() as any;assert.equal(full.repair.originalReturn.report,original.report);assert.equal(full.repair.originalResult.data.review.verdict,'PASS');assert.equal(f.q.status().claims.length,0);
  assert.equal(full.originalReports.available,true);assert.equal(full.originalReports.reports.length,5);
  const operation=join(f.request.executionRoot,'operation'),fact=JSON.parse(await readFile(join(operation,'attempt-1/fact-and-repair/completed.json'),'utf8')),impact=JSON.parse(await readFile(join(operation,'attempt-1/impact-1/completed.json'),'utf8'));
  assert.deepEqual(full.originalReports.reports.filter((r:any)=>r.role==='verifier_fact').map((r:any)=>r.finalText),fact.finalAnswers.map((r:any)=>r.text));assert.equal(full.originalReports.reports.find((r:any)=>r.role==='verifier_impact').finalText,impact.finalText);
  const after=await readFile(f.model.trace);assert.notDeepEqual(after,trace);assert.equal((await f.post('reconcile')).status,202);await wait(f,r=>!r.active);assert.deepEqual(await readFile(f.model.trace),after);
  const controls=await ReturnControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),f.sources),old=f.q.status().events,report=await controls.report('original-return');assert.equal(report.available,true);assert.deepEqual(f.q.status().events,old);assert.deepEqual(await readFile(f.model.trace),after);
  const result=full.repair.originalResult,requestHash=full.repair.originalRequestSha256,terminalHash=full.repair.originalEvidence.terminalRecordSha256;
  await assert.rejects(readRepairReports(f.request.executionRoot,'0'.repeat(64),result,terminalHash),/request_changed/);
  await assert.rejects(readRepairReports(f.request.executionRoot,requestHash,result,'0'.repeat(64)),/terminal_changed/);
  await assert.rejects(readRepairReports(f.request.executionRoot,requestHash,{...result,after:{...result.after,H:'0'.repeat(40)}},terminalHash),/result_mismatch/);
  const rawPath=join(operation,'attempt-1/fact-and-repair/stdout.ndjson'),raw=await readFile(rawPath);await writeFile(join(f.root,'report-before-tamper.ndjson'),raw);
  try{await writeFile(rawPath,Buffer.concat([raw,Buffer.from('\n')]));const held=await controls.report('original-return');assert.ok('originalReports' in held);assert.equal(held.originalReports?.available,false);assert.equal(held.repair.originalResult.data.review.verdict,'PASS');}finally{await writeFile(rawPath,raw);}
  // Reading a historical completed report neither resumes nor requires today's
  // worktree to equal the old candidate; its sealed original capture is enough.
  const sourcePath=join(f.request.executionRoot,'workspace/src/normalize.mjs'),source=await readFile(sourcePath);
  try{await writeFile(sourcePath,Buffer.concat([source,Buffer.from('\n// Later uncommitted work, outside this saved result.\n')]));const historical=await controls.report('original-return');assert.ok('originalReports' in historical);assert.equal(historical.originalReports?.available,true);}finally{await writeFile(sourcePath,source);}
  assert.deepEqual(f.q.status().events,old);assert.deepEqual(await readFile(f.model.trace),after);assert.deepEqual(await readFile(rawPath),raw);
});

test('page cannot retarget a repair to another task or changed plan, and stopped execution does not launch model work',opts,async t=>{
  const f=await page(t),trace=await readFile(f.model.trace),foreign=await ReturnControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),[{...f.sources[0]!,item:'0'.repeat(64)}]);
  const missing=(await foreign.state())[0]!;assert.equal(missing.available,false);await assert.rejects(foreign.begin('original-return','start',{}),/task_mismatch/);assert.deepEqual(await readFile(f.model.trace),trace);
  await assert.rejects(runQueueRepair(f.planPath,false,'0'.repeat(64)),/selected_plan_changed/);assert.deepEqual(await readFile(f.model.trace),trace);
  f.q.control('scope','investment','stopped','explicit fixture stop before page action');await f.post('start');const held=await wait(f,r=>!r.active&&!!r.currentControllerProblem);assert.match(held.currentControllerProblem,/stopped/);assert.deepEqual(await readFile(f.model.trace),trace);
  const raw=await readFile(f.planPath);await writeFile(f.planPath,JSON.stringify({...f.p,bindingHash:'0'.repeat(64)}));assert.equal((await f.post('reconcile')).status,503);await writeFile(f.planPath,raw);assert.deepEqual(await readFile(f.model.trace),trace);
});

test('page closes only proven unstarted preparation, retains original request and accepts an explicitly linked corrected plan',opts,async t=>{
  const f=await page(t,'broken'),trace=await readFile(f.model.trace);await f.post('start');await wait(f,r=>!r.active&&r.currentControllerProblem==='project_material_missing');
  const original=await readFile(join(f.request.executionRoot,'request.json'));await f.post('close-unstarted');const closed=await wait(f,r=>!r.active&&r.repair.phase==='closed_unstarted');assert.equal(closed.repair.phase,'closed_unstarted');assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(await readFile(join(f.request.executionRoot,'request.json')),original);
  const old=f.q.reviewRecords().state((f as Basic).operation).repair,request={...f.request,executionRoot:join(f.root,'explicit-corrected-request')};await writeFile(f.requestPath,JSON.stringify(request));await writeFile(f.planPath,JSON.stringify({...f.p,requestSha256:hash(await readFile(f.requestPath)),replacesClosedBinding:old.bindingHash}));const sha=hash(await readFile(f.planPath)),catalog={...f.catalog,entries:f.catalog.entries.map(e=>({...e,repair:{path:f.planPath,sha256:sha}}))};await writeFile(f.catalogPath,JSON.stringify(catalog));
  const corrected=await ReturnControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),f.sources),ready=(await corrected.state())[0]!;assert.ok('repair' in ready);assert.equal(ready.repair.phase,'not_started');await corrected.begin('original-return','start',{});await wait({...f,get:async()=>({returnWork:await corrected.state()})},r=>!r.active&&r.repair.phase==='returned');await corrected.drain();const done=(await corrected.state())[0]!;assert.ok('repair' in done);assert.equal(done.repair.result!.status,'completed');assert.deepEqual(await readFile(join(f.request.executionRoot,'request.json')),original);
});

test('page keeps partial actual writes unknown, rejects unsent closure and reconciles the original candidate without writing twice',opts,async t=>{
  const f=await page(t,'partial');await f.post('start');await wait(f,r=>!r.active&&r.repair.phase==='unknown');const trace=await readFile(f.model.trace,'utf8'),writes=trace.split('"name":"tongxu_replace_file"').length;
  await f.post('close-unstarted');const held=await wait(f,r=>!r.active&&r.currentControllerProblem==='repair_execution_may_have_started');assert.equal(held.repair.phase,'unknown');
  await f.post('reconcile');const done=await wait(f,r=>!r.active&&r.repair.phase==='returned');assert.equal(done.repair.result.status,'completed_recovered_candidate');assert.equal((await readFile(f.model.trace,'utf8')).split('"name":"tongxu_replace_file"').length,writes);
});

test('one page entry consumes a verified member refutation and obtains a new independent reception, keeping original return unchanged',opts,async t=>{
  const f=await page(t,'refute'),member=f.member!,before=canonical(f.q.receiverState(member.parent.operation).receiver.judgment),author=await member.authorState(),count=await member.count();
  await f.post('start');const done=await wait(f,r=>!r.active&&r.refutation?.phase==='returned');assert.equal(done.repair.result.status,'skipped_refuted');assert.equal(done.repair.result.actualRepairPerformed,false);assert.equal(done.refutation.verdict,'ACCEPT_WITHIN_SCOPE');assert.notEqual(done.refutation.reception.operation,member.parent.operation);assert.equal(done.refutedNeedsNewReception,false);
  const full=await(await fetch(f.u.origin+'/api/return-report/original-return',{headers:f.headers})).json() as any;assert.equal(full.refutation.report.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(full.repair.originalResult.data.factReport.decision,'refuted');assert.equal(canonical(f.q.receiverState(member.parent.operation).receiver.judgment),before);assert.deepEqual(await member.authorState(),author);assert.equal(await member.count(),count+1);
  const trace=await readFile(f.model.trace);await f.post('reconcile');await wait(f,r=>!r.active);assert.deepEqual(await readFile(f.model.trace),trace);assert.equal(await member.count(),count+1);
});

test('closing the entry while a request is being checked does not launch a new controller or model',opts,async t=>{
  const f=await page(t),controls=await ReturnControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),f.sources),trace=await readFile(f.model.trace),before=f.q.status().events;
  const request=controls.begin('original-return','start',{}),closing=controls.drain();await assert.rejects(request,/return_control_closing/);await closing;
  assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(f.q.status().events,before);await assert.rejects(controls.begin('original-return','start',{}),/return_control_closing/);
});
