import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {candidateFixture,raw} from './fixture.js';
import {runReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';

test('new exact candidate uses its own W2 run and independent receiver consumes preserved minimum-integration evidence',async t=>{
  const f=await candidateFixture(t),original=await readFile(join(f.verification,'verification.json')),linked=f.q.attachIntegrationCandidate(raw(f.link));assert.equal(linked.duplicate,false);assert.notEqual(linked.packet,f.link.packet);assert.equal(f.q.attachIntegrationCandidate(raw(f.link)).duplicate,true);
  const r=await runReception(f.receiverPath);assert.equal(r.receiver.phase,'returned');assert.equal(r.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(r.receiver.integrationSha256,linked.integrationSha256);assert.equal(r.receiver.judgment.consumedIntegration,linked.integrationSha256);assert.equal(r.receiver.currentMaterialMatches,true);assert.equal(await f.count(),1);
  const input=JSON.parse(f.q.receiverState(r.operation).input.toString()),m=input.data.evidence.integration;assert.equal(input.binding.candidate.pr,99);assert.equal(input.binding.candidate.H,f.candidate.H);assert.equal(input.data.evidence.report.inputs.length,1);assert.equal(input.data.evidence.report.observedSampleFailures,0);assert.equal(m.source.report.stages[1].tools[0].sampleSet.samples[0].status,'fail');assert.equal(m.source.report.stages[2].tools[0].sampleSet.samples[0].status,'ok');assert.equal(m.sourceAcceptanceTransferred,false);assert.equal(m.permissionGranted,false);assert.equal(hash(m.diff.text),m.diff.sha256);assert.ok(m.originals.every((x:any)=>hash(Buffer.from(x.text,x.encoding==='utf8'?'utf8':'base64'))===x.sha256));assert.ok((await readFile(join(f.verification,'verification.json'))).equals(original));
  assert.equal((await runReception(f.receiverPath)).duplicate,true);assert.equal(await f.count(),1);assert.equal(f.q.integrations().state(f.request.id).targetUpdated,false);
  await f.addPacket({pr:10,H:f.A3,sourceAt:new Date(Date.now()+60000).toISOString()});const old=f.q.receiverState(r.operation);assert.equal(old.result.receiver.currentMaterialMatches,false);assert.equal(old.receiver.judgment.report,r.receiver.judgment.report);assert.equal((await runReception(f.receiverPath)).duplicate,true);assert.equal(await f.count(),1);
});
test('missing link cannot dispatch; exact attachment gives a new packet without rewriting the old attempted operation',async t=>{
  const f=await candidateFixture(t);await assert.rejects(runReception(f.receiverPath),/integration_candidate_link_required/);assert.equal(await f.count(),0);const before=f.q.status().operations.find((o:any)=>o.item===f.candidateItem);assert.ok(before);const linked=f.q.attachIntegrationCandidate(raw(f.link));assert.notEqual(linked.packet,before.packet);assert.throws(()=>f.q.attachIntegrationCandidate(raw({...f.link,source:'altered request'})),/request_changed/);
  const r=await runReception(f.receiverPath);assert.equal(r.receiver.currentMaterialMatches,true);assert.notEqual(r.operation,before.id);assert.equal(await f.count(),1);assert.equal(f.q.status().operations.find((o:any)=>o.id===before.id).packet,before.packet);
});
test('wrong integration acknowledgment is retained as an invalid ended output, never a consumed PASS',async t=>{
  const f=await candidateFixture(t);f.q.attachIntegrationCandidate(raw(f.link));const executable=f.plan.claudeExecutable;await writeFile(executable,(await readFile(executable,'utf8')).replace('consumedIntegration:x.binding.integrationSha256',"consumedIntegration:'0'.repeat(64)"));const r=await runReception(f.receiverPath);assert.equal(r.status,'receiver_invalid_result');assert.equal(r.receiver.invalidResult.reason,'receiver_integration_not_consumed');assert.equal(r.receiver.judgment,null);assert.equal(f.q.status().claims.length,0);assert.equal((await runReception(f.receiverPath)).status,'receiver_invalid_result');assert.equal(await f.count(),1);
});
test('previous consumers cannot drop the integration lineage or dispatch using an unvalidated claim',async t=>{
  const f=await candidateFixture(t),linked=f.q.attachIntegrationCandidate(raw(f.link)),begun=f.q.begin(f.candidateItem,'old-consumer-fixture');f.q.evaluate(begun.operation);const db=new DatabaseSync(join(f.store,'queue.sqlite'));
  try{assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,18);const packet=db.prepare('SELECT * FROM packets WHERE id=?').get(linked.packet) as any,summary=JSON.parse(packet.summary);delete summary.integration;assert.throws(()=>db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(packet.item,'f'.repeat(64),packet.manifest_hash,packet.report_hash,packet.context_hash,JSON.stringify(summary),new Date().toISOString()),/integration_candidate_lineage_required/);
    const prior=JSON.parse((db.prepare('SELECT result FROM operations WHERE id=?').get(begun.operation) as any).result),receiver={contractVersion:6,packetFingerprint:linked.fingerprint,integrationSha256:linked.integrationSha256,phase:'reserved'};assert.throws(()=>db.prepare("UPDATE operations SET status='receiving',result=? WHERE id=?").run(JSON.stringify({...prior,receiver}),begun.operation),/integration_current_consumer_check_required/);
  }finally{db.close();}assert.equal(await f.count(),0);
});
