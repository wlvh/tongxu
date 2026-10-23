import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {overallFixture} from './overall-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {overallReview} from '../../src/overall-review.js';
import {RepairSession} from '../../src/repair-native.js';
import {overallAuthorityPayloadSha} from '../../src/overall-authority.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';
import {ownerDecisionText,scopeBodyHash,actionHash,type AuthorityProfile,type ActionRequest} from '../../src/authority-contract.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import type {ResourceRequest} from '../../src/resource-contract.js';

import {governed} from './overall-governance-fixture.js';

test('governed overall review consumes original authority and one existing claim; repeat recovers after revocation without another input',async t=>{
  const f=await governed(t);assert.equal((await overallReview(f.planPath,'prepare')).status,'prepared_not_sent');assert.equal(f.ledger.state().claims.length,0);
  const result=await overallReview(f.planPath,'run') as any;assert.equal(result.status,'review_recorded');assert.equal(result.resources[0].settled,true);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.equal(result.noOverallDriftEstablished,false);
  const before=await readFile(f.m.trace);await f.adopt({kind:'revoke',decision:f.confirmation.sha});await writeFile(f.source,'{}');const repeated=await overallReview(f.planPath,'reconcile') as any;assert.equal(repeated.duplicate,true);assert.equal(repeated.resources[0].settled,true);assert.deepEqual(await readFile(f.m.trace),before);
  const original=f.q.reviewRecords().overallOriginal(Buffer.from(canonical(f.plan)))!;assert.equal(original.events.filter((e:any)=>e.kind==='overall_review_dispatched').length,1);
});
test('revoked, changed and resource-unavailable proposals never start a new overall model turn',async t=>{
  const revoked=await governed(t),before=await readFile(revoked.m.trace);await revoked.adopt({kind:'revoke',decision:revoked.confirmation.sha});await assert.rejects(overallReview(revoked.planPath,'run'),/revoked/);assert.deepEqual(await readFile(revoked.m.trace),before);assert.equal(revoked.ledger.state().claims.length,0);
  const changed=await governed(t);changed.plan.trigger.reason='A changed task is not the authorized plan';await changed.write();await assert.rejects(overallReview(changed.planPath,'run'),/exact_authority_mismatch/);assert.equal(changed.ledger.state().claims.length,0);
  const absent=await governed(t,'credentials-missing'),old=await readFile(absent.m.trace);await assert.rejects(overallReview(absent.planPath,'run'),/credentials_unavailable/);assert.deepEqual(await readFile(absent.m.trace),old);assert.equal(absent.ledger.state().claims.length,0);
});
test('lost resource settlement reuses the complete original capture and provider lookup, never replays the model',async t=>{
  const f=await governed(t,'lost-after-result'),result=await overallReview(f.planPath,'run') as any;assert.equal(result.status,'review_recorded');assert.equal(result.resources[0].settled,false);const before=await readFile(f.m.trace);assert.equal(f.ledger.state().settlements.length,1);
  const recovered=await overallReview(f.planPath,'reconcile') as any;assert.equal(recovered.resources[0].settled,true);assert.deepEqual(await readFile(f.m.trace),before);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('an invalid prepared resource set does not poison the corrected original authorization or claim',async t=>{
  const f=await governed(t),governance=structuredClone(f.plan.governance!),before=await readFile(f.m.trace);f.plan.governance={...governance,resourceRequests:[]};await f.write();await assert.rejects(overallReview(f.planPath,'run'),/overall_exact_resource_set_required/);assert.deepEqual(await readFile(f.m.trace),before);assert.equal(f.ledger.state().claims.length,0);
  f.plan.governance=governance;await f.write();const result=await overallReview(f.planPath,'run') as any;assert.equal(result.status,'review_recorded');assert.equal(result.resources[0].settled,true);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
  const events=f.q.status().events;assert.equal(events.filter((e:any)=>e.kind==='overall_review_reserved').length,2);assert.equal(events.filter((e:any)=>e.kind==='overall_review_action_bound').length,1);assert.equal(events.filter((e:any)=>e.kind==='overall_review_dispatched').length,1);
});
test('confirmed ended metadata-only bootstrap can close while stopped and reuse its original held claim after resume',async t=>{
  const f=await governed(t),start=RepairSession.start;
  RepairSession.start=async options=>{const session=await start.call(RepairSession,options);if(options.executable===f.m.config.codexExecutable)f.q.control('scope','investment','stopped','Explicit stop after metadata, before any model input');return session;};
  try{await assert.rejects(overallReview(f.planPath,'run'),/new_investment_stopped/);}finally{RepairSession.start=start;}
  const original=f.q.reviewRecords().overallOriginal(Buffer.from(canonical(f.plan)))!,stage=join(f.store,'overall-'+original.id,'reviewer'),sent=(await readFile(join(stage,'stdin.ndjson'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.equal(sent.filter(m=>m.method==='turn/start').length,0);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,0);
  const closed=await overallReview(f.planPath,'close-unstarted','Explicit metadata-only recovery');assert.equal(closed.modelDispatched,false);assert.equal(f.ledger.state().settlements.length,0);
  f.q.control('scope','investment','open','Resume this exact original request');const result=await overallReview(f.planPath,'run') as any;assert.equal(result.status,'review_recorded');assert.equal(result.id,original.id);assert.equal(result.resources[0].id,f.id);assert.equal(result.resources[0].settled,true);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('new overall dispatch keeps the persistent old-consumer denial and composes with publication protections',async t=>{
  const f=await governed(t),db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());f.a.enableGovernedOverall();f.a.enableGovernedPublication();f.a.configuration();
  const old=await overallReview(f.planPath,'prepare') as any,raw={operation:f.plan.operation,id:old.id,inputSha256:'a'.repeat(64),blobs:{},attempt:1};
  assert.throws(()=>db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('overall_review_dispatched','overall:'+old.id,canonical(raw),new Date().toISOString()),/authority_consumer_binding_required/);
  assert.equal((await overallReview(f.planPath,'run')).status,'review_recorded');
  const outcome=f.q.resources().status(f.id).outcome!;
  assert.throws(()=>db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('resource_result_dispatched','resource:'+f.id,canonical({outcomeSha256:outcome.outcomeSha256,originalOperation:f.plan.operation,directory:'/explicit-old-consumer-statement'}),new Date().toISOString()),/overall_original_terminal_check_required/);
  const g=await governed(t);g.a.enableGovernedPublication();g.a.enableGovernedOverall();g.a.configuration();assert.equal((await overallReview(g.planPath,'run')).status,'review_recorded');
});
