import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {freshReturnFixture as page,waitIncoming as wait} from './return-preparation-fixture.js';
import {hash} from '../../src/snapshot.js';
import {exists,git} from '../../src/repair-workspace.js';
import {ReturnControls} from '../../src/return-controls.js';
import {withQueueRepairLock} from '../../src/queue-repair.js';
const opts={timeout:120000};

test('a RETURN arriving after startup is prepared by the page consumer, executed once and read completely after reopening without manual plan files',opts,async t=>{
  const f=await page(t),scopeFiles=[f.profilePath,f.catalogPath,f.path],before=await Promise.all(scopeFiles.map(p=>readFile(p))),initial=await f.get(),arrived=await f.arrive(),id='incoming:'+arrived.operation;
  assert.ok(!initial.returnWork.some((x:any)=>x.id===id));assert.notEqual(arrived.operation,f.operation);assert.equal(arrived.H,f.H);assert.ok(arrived.packet>f.evidence.packet);
  const inputDirectory=join(f.store,'return-input-'+arrived.operation);assert.equal(await exists(inputDirectory),false);
  const current=(await f.get()).returnWork.find((x:any)=>x.id===id);assert.equal(current.available,true);assert.equal(current.preparation.prepared,false);assert.equal(current.repair.candidate.H,arrived.H);
  const concurrent=await Promise.all([f.post(current,'start'),f.post(current,'start')]);assert.ok(concurrent.some(r=>r.status===202));for(const response of concurrent)if(response.status!==202){assert.equal(response.status,503);assert.match((await response.json() as any).error,/queue_repair_controller_active/);}
  const done=await wait(f,id,r=>!r.active&&r.repair?.phase==='returned'),full=await f.report(id);assert.equal(done.repair.result.status,'completed');assert.equal(done.repair.result.testsPassed,true);assert.equal(done.repair.result.reviewCandidateH,done.repair.result.afterH);assert.notEqual(done.repair.result.afterH,arrived.H);assert.equal(full.originalReports.available,true);assert.equal(full.originalReports.reports.length,5);
  const prepared=JSON.parse(await readFile(join(inputDirectory,'plan.json'),'utf8')),request=JSON.parse(await readFile(join(inputDirectory,'request.json'),'utf8'));assert.equal(prepared.operation,arrived.operation);assert.equal(request.candidate.H,arrived.H);assert.deepEqual(request.findings,[]);assert.equal(request.priorReview,undefined);assert.equal(request.executionRoot,join(f.executionParent,'return-'+arrived.operation));assert.equal(prepared.requestSha256,hash(await readFile(join(inputDirectory,'request.json'))));
  const trace=await readFile(f.model.trace),files=await Promise.all(['binding.json','request.json','config.json','plan.json'].map(async n=>{const p=join(inputDirectory,n);return {n,bytes:await readFile(p),mtime:(await stat(p)).mtimeMs};}));
  await f.reopen();const reopened=(await f.get()).returnWork.find((x:any)=>x.id===id);assert.equal(reopened.preparation.prepared,true);assert.deepEqual(await f.report(id),full);assert.equal((await f.post(reopened,'reconcile')).status,202);await wait(f,id,r=>!r.active);assert.deepEqual(await readFile(f.model.trace),trace);
  for(const file of files){assert.deepEqual(await readFile(join(inputDirectory,file.n)),file.bytes);assert.equal((await stat(join(inputDirectory,file.n))).mtimeMs,file.mtime);}assert.deepEqual(await Promise.all(scopeFiles.map(p=>readFile(p))),before);
  await writeFile(join(f.root,'new-return-flow-verification.json'),JSON.stringify({arrival:arrived,originalReturn:f.q.receiverState(arrived.operation).receiver.judgment,done,full,scopeFilesUnchanged:true,perReturnPlanWrittenByProgram:true,reopenAndRepeatNewModelInputs:0,fixtureModelsOnly:true},null,2)+'\n');
});

test('wrong original selection, extra paths, changed support scope and stale candidate do not become a new repair',opts,async t=>{
  const f=await page(t),arrived=await f.arrive(),id='incoming:'+arrived.operation,entry=(await f.get()).returnWork.find((x:any)=>x.id===id),trace=await readFile(f.model.trace),directory=join(f.store,'return-input-'+arrived.operation);
  for(const body of [{selectionSha256:'0'.repeat(64)},{selectionSha256:entry.preparation.selectionSha256,executionRoot:'/unregistered'}])assert.equal((await f.post(entry,'start',body)).status,503);
  await withQueueRepairLock(f.store,arrived.operation,async()=>{const busy=await f.post(entry,'start');assert.equal(busy.status,503);assert.match((await busy.json() as any).error,/queue_repair_controller_active/);});assert.equal(await exists(directory),false);
  const raw=await readFile(f.profilePath);try{await writeFile(f.profilePath,JSON.stringify({...f.profile,allowedPaths:['README.md']}));assert.equal((await f.post(entry,'start')).status,503);}finally{await writeFile(f.profilePath,raw);}
  await writeFile(join(f.request.objects,'sample.js'),'export const value=4; // explicit later fixture candidate\n');await git(f.request.objects,['add','sample.js']);await git(f.request.objects,['-c','user.name=fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m','later explicit fixture candidate']);await f.packet({H:await git(f.request.objects,['rev-parse','HEAD'])});assert.equal((await f.post(entry,'start')).status,503);assert.equal(await exists(directory),false);assert.deepEqual(await readFile(f.model.trace),trace);
  const changed={...f.profile,scope:{...f.profile.scope,version:'unadopted-S2'}},profilePath=join(f.root,'changed-scope.json');await writeFile(profilePath,JSON.stringify(changed));const catalog={...f.catalog,entries:[{...f.catalog.entries[0]!,prepare:{path:profilePath,sha256:hash(await readFile(profilePath))}}]},catalogPath=join(f.root,'changed-controls.json');await writeFile(catalogPath,JSON.stringify(catalog));const controls=await ReturnControls.load(catalogPath,hash(await readFile(catalogPath)),f.sources);assert.ok((await controls.state()).every((x:any)=>!x.available));await assert.rejects(controls.begin(id,'start',{selectionSha256:entry.preparation.selectionSha256}),/outside_fixed_scope/);await controls.drain();assert.deepEqual(await readFile(f.model.trace),trace);
});

test('new RETURN keeps partial writes in the original operation and recovers after its worker exits, not after the page process exits',opts,async t=>{
  const f=await page(t,'project-interrupt'),arrived=await f.arrive(),id='incoming:'+arrived.operation,entry=(await f.get()).returnWork.find((x:any)=>x.id===id),started=await f.post(entry,'start');assert.equal(started.status,202,await started.text());const unknown=await wait(f,id,r=>!r.active&&r.repair.phase==='unknown');assert.equal(unknown.repair.originalControllerState,'ended');
  const root=join(f.executionParent,'return-'+arrived.operation),capture=join(root,'operation/attempt-1/fact-and-repair/stdout.ndjson'),original=await readFile(capture),trace=await readFile(f.model.trace,'utf8'),writes=trace.split('"name":"tongxu_replace_file"').length;assert.match(await readFile(join(root,'workspace/src/normalize.mjs'),'utf8'),/Untitled/);
  await f.reopen();const same=(await f.get()).returnWork.find((x:any)=>x.id===id);assert.equal(same.repair.phase,'unknown');await f.post(same,'close-unstarted');const held=await wait(f,id,r=>!r.active&&r.currentControllerProblem==='repair_execution_may_have_started');assert.equal(held.repair.phase,'unknown');
  await f.post(same,'reconcile');const done=await wait(f,id,r=>!r.active&&r.repair.phase==='returned');assert.equal(done.repair.result.status,'completed_recovered_candidate');assert.deepEqual(await readFile(capture),original);assert.equal((await readFile(f.model.trace,'utf8')).split('"name":"tongxu_replace_file"').length,writes);assert.equal(done.repair.operation,arrived.operation);
  const finalTrace=await readFile(f.model.trace);await f.post(same,'reconcile');await wait(f,id,r=>!r.active);assert.deepEqual(await readFile(f.model.trace),finalTrace);const full=await f.report(id);assert.equal(full.originalReports.available,true);await writeFile(join(f.root,'partial-original-recovery.json'),JSON.stringify({originalOperation:arrived.operation,unknown,done,full,originalCaptureUnchanged:true,originalWriterResent:false,pageProcessStillAlive:process.pid},null,2)+'\n');
});

test('closing during new RETURN preparation prevents worker launch and leaves the original queue unchanged',opts,async t=>{
  const f=await page(t),arrived=await f.arrive(),id='incoming:'+arrived.operation,controls=await ReturnControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),f.sources),entry=(await controls.state()).find((x:any)=>x.id===id) as any,trace=await readFile(f.model.trace),events=f.q.status().events;
  const pending=controls.begin(id,'start',{selectionSha256:entry.preparation.selectionSha256}),closing=controls.drain();await assert.rejects(pending,/return_control_closing/);await closing;assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(f.q.status().events,events);assert.equal(await exists(join(f.store,'return-input-'+arrived.operation,'plan.json')),false);
});

test('unpublished partial preparation bytes survive a later explicit start and do not become a replacement model task',opts,async t=>{
  const f=await page(t),arrived=await f.arrive(),id='incoming:'+arrived.operation,directory=join(f.store,'return-input-'+arrived.operation);await mkdir(directory,{mode:0o700});
  const partial=join(directory,'.pending-request.json-explicit-interruption-fixture'),bytes=Buffer.from('{"schemaVersion":');await writeFile(partial,bytes,{mode:0o600});
  const entry=(await f.get()).returnWork.find((x:any)=>x.id===id);assert.equal(entry.preparation.prepared,false);const started=await f.post(entry,'start');assert.equal(started.status,202,await started.text());const done=await wait(f,id,r=>!r.active&&r.repair.phase==='returned');assert.equal(done.repair.result.status,'completed');assert.deepEqual(await readFile(partial),bytes);
  const trace=await readFile(f.model.trace);await f.reopen();const old=(await f.get()).returnWork.find((x:any)=>x.id===id);await f.post(old,'reconcile');await wait(f,id,r=>!r.active);assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(await readFile(partial),bytes);
});
