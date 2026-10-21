import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {memberRepairFixture,brokenLabel} from './repair-fixture.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {raw} from '../integration/fixture.js';
import {hash} from '../../src/snapshot.js';
import {git} from '../../src/repair-workspace.js';
import {authorizeRepairFixture} from '../review-records/repair-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {ReviewRecords} from '../../src/review-record-store.js';

test('one member repair uses the original parent report, changes only its managed source and repeats without new model inputs',async t=>{
  const f=await memberRepairFixture(t),author=await f.authorState(),parent=JSON.stringify(f.q.receiverState(f.parent.operation).receiver.judgment),result=await runQueueRepair(f.planPath);assert.equal(result.repairStatus,'completed');assert.equal(result.counters.actualFileWrites,1);assert.equal(result.manualReportCopyRequired,false);assert.equal(result.manualRepairRequired,false);assert.equal(f.q.status().claims.length,0);
  assert.equal(JSON.stringify(f.q.receiverState(f.parent.operation).receiver.judgment),parent);const member=f.q.status().operations.find((o:any)=>o.id===f.memberOperation);assert.equal(member.result.receiver,undefined);assert.equal(member.result.repair.sourceReceptionOperation,f.parent.operation);assert.equal(member.result.repair.memberReturnSha256,f.memberReturn.sourceSha256);assert.equal(member.result.repair.result.sourceCandidate.H,f.A);assert.deepEqual(await f.authorState(),author);assert.equal(await git(f.objects,['show',f.A+':src/normalize.mjs']),brokenLabel.trim());assert.match(await readFile(join(f.request.executionRoot,'workspace/src/normalize.mjs'),'utf8'),/Untitled/);
  const input=await readFile(join(f.request.executionRoot,'operation/attempt-1/fact-and-repair/stdin.ndjson'),'utf8');assert.ok(input.includes(f.original.receiver.judgment.report));assert.ok(input.includes(f.memberReturn.sourceSha256));assert.ok(input.includes(f.C));
  const trace=await readFile(f.model.trace),again=await runQueueRepair(f.planPath);assert.equal(again.duplicate,true);assert.ok((await readFile(f.model.trace)).equals(trace));const db=new DatabaseSync(join(f.store,'queue.sqlite'),{readOnly:true});try{assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,19);}finally{db.close();}
});
test('member assignment and implementation authorization mismatches fail before any repair execution',async t=>{
  const f=await memberRepairFixture(t),trace=await readFile(f.model.trace);
  await writeFile(f.planPath,raw({...f.p,operation:f.parent.operation}));await assert.rejects(runQueueRepair(f.planPath),/member_repair_original_operation_mismatch/);
  await writeFile(f.planPath,raw({...f.p,memberReturn:{...f.memberReturn,sourceSha256:'0'.repeat(64)}}));await assert.rejects(runQueueRepair(f.planPath),/member_repair_original_operation_mismatch/);
  const noWrite={...f.request,authorization:{...f.request.authorization,allowRepair:false}};await writeFile(f.requestPath,raw(noWrite));await writeFile(f.planPath,raw({...f.p,requestSha256:hash(raw(noWrite))}));await assert.rejects(runQueueRepair(f.planPath),/queue_repair_authorization_missing/);assert.ok((await readFile(f.model.trace)).equals(trace));assert.equal(f.q.status().claims.length,0);
});
test('member repair consumes its own exact grant and original resource, then retains its outcome through revocation',async t=>{
  const f=await memberRepairFixture(t),ledger=await ledgerFixture(t),a=await authorizeRepairFixture({...f,operation:f.memberOperation,plan:{...f.plan,item:f.member.item},H:f.A},ledger.profile),before=await readFile(f.model.trace);
  await assert.rejects(runQueueRepair(f.planPath),/authority_consumer_binding_required/);assert.ok((await readFile(f.model.trace)).equals(before));assert.equal(ledger.state().claims.length,0);
  const p={...f.p,governance:{authorityIntent:a.intent,resourceRequests:[a.resourceId]}};await writeFile(f.planPath,raw(p));const result=await runQueueRepair(f.planPath);assert.equal(result.repairStatus,'completed');assert.equal(result.counters.actualFileWrites,1);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);assert.equal(f.q.resources().status(a.resourceId).request.operation,f.memberOperation);
  const trace=await readFile(f.model.trace);await a.adopt({kind:'revoke',decision:a.confirmed.sha});assert.equal((await runQueueRepair(f.planPath)).duplicate,true);assert.ok((await readFile(f.model.trace)).equals(trace));assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);
});
test('an implementation stop at the actual repair effect stops execution while preserving the member operation',async t=>{
  const f=await memberRepairFixture(t),check=ReviewRecords.prototype.check,trace=await readFile(f.model.trace);let changed=false;
  ReviewRecords.prototype.check=function(id,binding,effect,observations){if(effect&&!changed){changed=true;f.q.control(f.context.scope.id,'implementation','stopped','explicit stop immediately before actual effect');}return check.call(this,id,binding,effect,observations);};t.after(()=>{ReviewRecords.prototype.check=check;});
  await assert.rejects(runQueueRepair(f.planPath),/docker_runtime_probe_failed/);const probe=JSON.parse(await readFile(join(f.request.executionRoot,'operation/attempt-1/baseline/runtime/probe/execution.json'),'utf8'));assert.equal(probe.reason,'queue_repair_stopped');assert.equal(probe.startGateRejected,true);assert.equal(Object.hasOwn(probe,'clientPid'),false);assert.equal(probe.phase,'not_started');assert.equal(probe.cleanup,'removed');assert.equal(changed,true);assert.ok((await readFile(f.model.trace)).equals(trace));assert.equal(f.q.status().operations.find((o:any)=>o.id===f.memberOperation).status,'repairing');assert.equal(f.q.status().operations.find((o:any)=>o.id===f.memberOperation).result.receiver,undefined);
});
