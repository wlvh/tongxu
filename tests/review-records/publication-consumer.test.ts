import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {publicationFixture} from '../w3/publication-fixture.js';
import {runReception} from '../../src/receiver.js';
import {publication} from '../../src/publisher.js';
import {QueueStore} from '../../src/queue-store.js';
import {hash} from '../../src/snapshot.js';

async function fixture(t:test.TestContext,mode='normal') {
  const f=await publicationFixture(t,mode,'return');f.q.enableSupplements();f.q.reviewRecords().enable();
  const H=await f.newHead(),next=await f.packet({H});
  await writeFile(f.path,JSON.stringify({...f.plan,item:next.item,executionKind:'native_capture'}));
  const received=await runReception(f.path);await f.change({H});
  await writeFile(f.pubPath,JSON.stringify({...f.p,operation:received.operation}));
  // Deliberately synthetic historical repair record, paired with actual local
  // Git/queue/fake-gh executions. No real supplier or external publication.
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));
  try {
    const blob=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)),sha=hash(bytes);db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,bytes);return sha;};
    const row=db.prepare('SELECT result FROM operations WHERE id=?').get(f.result.operation)!,result=JSON.parse(row.result as string),sha=blob({});
    const repairResult={actualRepairPerformed:true,status:'completed',executionKind:'native_capture',before:{H:f.result.candidate.H},after:{H},sourceCandidate:f.result.candidate};
    result.repair={phase:'returned',bindingHash:sha,planSha256:sha,requestSha256:sha,configSha256:sha,resultSha256:blob(repairResult),evidenceSha256:blob({fixture:true}),counters:{actualFileWrites:1},result:repairResult};
    db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result),f.result.operation);
  } finally {db.close();}
  return {...f,newH:H,publicationOperation:received.operation};
}

test('normal publisher consumes exact repair and remote receipts; reopen/republish sends no new POST or model input',async t=>{
  const f=await fixture(t),trace=await readFile(f.trace);
  const result=await publication(f.pubPath,'publish');assert.equal(result.status,'published_verified');assert.equal(result.repairBatches!.recorded,1);
  assert.equal(result.repairBatches!.batches[0]!.operation,f.result.operation);assert.equal(result.repairBatches!.batches[0]!.publicationOperation,f.publicationOperation);
  const saved=f.q.reviewRecords().status().events,again=await publication(f.pubPath,'reconcile');assert.equal(again.repairBatches!.recorded,0);
  assert.deepEqual(f.q.reviewRecords().status().events,saved);assert.equal((await f.remote()).posts.length,2);assert.deepEqual(await readFile(f.trace),trace);
});

test('failure after both verified receipts leaves original publication recoverable without a second paid task or POST',async t=>{
  const f=await fixture(t),original=QueueStore.prototype.reconcilePublishedRepairBatches,trace=await readFile(f.trace);
  try {
    QueueStore.prototype.reconcilePublishedRepairBatches=function(){throw new Error('fixture:interrupt-before-local-counter');};
    await assert.rejects(publication(f.pubPath,'publish'),/fixture:interrupt-before-local-counter/);
  } finally {QueueStore.prototype.reconcilePublishedRepairBatches=original;}
  assert.equal(f.q.publicationState(f.publicationOperation).stages.status.lastState,'verified');assert.equal(f.q.reviewRecords().status().events.length,0);
  const recovered=await publication(f.pubPath,'reconcile');assert.equal(recovered.repairBatches!.recorded,1);assert.equal((await f.remote()).posts.length,2);assert.deepEqual(await readFile(f.trace),trace);
});

test('a comment alone does not count; original explicit rejected retry completes the same batch',async t=>{
  const f=await fixture(t,'reject-status'),trace=await readFile(f.trace),partial=await publication(f.pubPath,'publish');
  assert.equal(partial.status,'publication_pending_or_unknown');assert.equal(partial.repairBatches,null);
  assert.equal(f.q.reconcilePublishedRepairBatches().recorded,0);
  const completed=await publication(f.pubPath,'retry-rejected','fixture:known rejected status continuation');assert.equal(completed.repairBatches!.recorded,1);
  assert.equal((await f.remote()).comments.length,1);assert.equal((await f.remote()).posts.length,3);assert.deepEqual(await readFile(f.trace),trace);
});
