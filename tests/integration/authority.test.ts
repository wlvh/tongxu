import test from 'node:test';
import assert from 'node:assert/strict';
import {access,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {integrationFixture,raw} from './fixture.js';
import {integrationAuthority,otherValidation} from './authority-fixture.js';
import {IntegrationRecords} from '../../src/integration-store.js';
import {runIntegration} from '../../src/integration.js';
import {runDeliveryValidation} from '../../src/delivery-validation.js';
import {deliveryValidationSha} from '../../src/delivery-validation-contract.js';

test('MI-F01: unresolved integration retains its one-shot test authority across the other actual validation entry',async t=>{
  const f=await integrationFixture(t),a=await integrationAuthority(f),complete=IntegrationRecords.prototype.complete;IntegrationRecords.prototype.complete=function(){throw new Error('explicit_result_consumer_interruption');};t.after(()=>{IntegrationRecords.prototype.complete=complete;});await assert.rejects(runIntegration(f.store,f.path),/explicit_result_consumer_interruption/);IntegrationRecords.prototype.complete=complete;assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');
  const second=await otherValidation(f,a);await assert.rejects(runDeliveryValidation(f.store,second.path),/test_authority_intent_already_bound/);await assert.rejects(access(join(f.store,'delivery-validation-'+deliveryValidationSha(second.plan as any),'verification')));assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{const bindings=db.prepare("SELECT kind,object FROM events WHERE kind IN ('integration_authority_bound','delivery_validation_authority_bound')").all();assert.equal(bindings.length,1);assert.throws(()=>db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('delivery_validation_authority_bound','delivery-validation:legacy-consumer',JSON.stringify({value:{authorityIntent:a.intent}}),new Date().toISOString()),/UNIQUE constraint failed/);}finally{db.close();}
  assert.equal((await runIntegration(f.store,f.path,'reconcile')).newGitProcesses,0);assert.equal(await f.count(),0);
});
test('MI-F01 reverse: a completed W2 test cannot lend its consumed reservation to a new integration run',async t=>{
  const f=await integrationFixture(t),a=await integrationAuthority(f),second=await otherValidation(f,a),result=await runDeliveryValidation(f.store,second.path);assert.equal(result.phase,'recorded');assert.equal(result.newVerificationRuns,1);await assert.rejects(runIntegration(f.store,f.path),/test_authority_intent_already_bound/);assert.throws(()=>f.q.integrations().state(f.request.id),/not_prepared/);assert.equal((await runDeliveryValidation(f.store,second.path)).newVerificationRuns,0);assert.equal(await f.count(),0);
});
test('a revoked exact grant or missing grant cannot start integration; restoring no grant is not a bypass',async t=>{
  const f=await integrationFixture(t),a=await integrationAuthority(f);await writeFile(f.path,raw({...f.request,authorityIntent:null}));await assert.rejects(runIntegration(f.store,f.path),/integration_authority_required/);await writeFile(f.path,raw(f.request));await a.adopt({kind:'revoke',decision:a.confirmation.sha});await assert.rejects(runIntegration(f.store,f.path),/revoked/);assert.throws(()=>f.q.integrations().state(f.request.id),/not_prepared/);assert.equal(await f.count(),0);
});
