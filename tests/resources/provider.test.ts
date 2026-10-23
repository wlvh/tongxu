import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash } from '../../src/snapshot.js';
import { canonical } from '../../src/comparison.js';
import { parseLedgerProfile,resourceRequestHash,type LedgerProfile,type ResourceRequest,type LedgerCommand } from '../../src/resource-contract.js';
import { callResourceProvider,requireLedgerObservation } from '../../src/resource-provider.js';

// This is the external fixture's original ledger, not a tongxu product balance.
// Actual SQLite transactions and child transports run; all identities/resources
// are explicit test data and no supplier or production ledger is contacted.
import {fixture} from './provider-fixture.js';

test('two actual child calls compete in the original fixture ledger; fixed replay never creates a second claim',async t=>{
  const f=await fixture(t),c1=f.cmd('claim'),c2=f.cmd('claim',{...f.request,operation:'00000000-0000-4000-8000-000000000002',authorityIntent:'another-fixture-action'});
  const results=await Promise.all([f.call(c1,()=>{}),f.call(c2,()=>{})]);assert.deepEqual(results.map(x=>x.reply.result.state).sort(),['present','refused']);assert.equal(f.state().remaining,0);assert.equal(f.state().claims.length,1);
  const winner=results.find(x=>x.reply.result.state==='present')!,command=winner.reply.requestId===c1.requestId?c1:c2,again=await f.call(command,()=>{});assert.equal(again.reply.result.claim.id,winner.reply.result.claim.id);assert.equal(f.state().claims.length,1);requireLedgerObservation(again,f.profile,command);
  assert.throws(()=>requireLedgerObservation({...again},f.profile,command),/actual_resource_provider/);again.raw.fill(32);assert.throws(()=>requireLedgerObservation(again,f.profile,command));
});
test('lost claim response leaves a real original claim; lookup recovers the exact id without another claim send',async t=>{
  const f=await fixture(t,'lost-after-claim');await assert.rejects(f.call(f.cmd('claim'),()=>{}),/execution_incomplete/);assert.equal(f.state().claims.length,1);
  const lookup=await f.call(f.cmd('lookup'));assert.equal(lookup.reply.result.state,'present');assert.equal(lookup.reply.result.claim.requestSha256,resourceRequestHash(f.request));assert.equal(f.state().claims.length,1);assert.equal(f.state().remaining,0);
  const oldExit=JSON.parse(await readFile(join(f.root,'call-1/exit.json'),'utf8'));assert.equal(oldExit.code,7);
});
test('result receipt and replay retain original claim and one settlement; no local refund is inferred',async t=>{
  const f=await fixture(t),claimed=await f.call(f.cmd('claim'),()=>{}),outcome={claimId:claimed.reply.result.claim.id,state:'failed' as const,evidenceSha256:hash('explicit known fixture execution failed')},c=f.cmd('record_result',f.request,outcome);
  const returned=await f.call(c,()=>{});assert.equal(returned.reply.result.claim.state,'consumed');await f.call(c,()=>{});assert.equal(f.state().settlements.length,1);assert.equal(f.state().remaining,0);
  await assert.rejects(f.call(f.cmd('record_result',f.request,{...outcome,evidenceSha256:hash('changed')}),()=>{}),/execution_incomplete/);assert.equal(f.state().settlements.length,1);
});
test('unknown protocol, mismatched recipient, multiple/partial replies and missing intent cannot be treated as valid resource evidence',async t=>{
  for(const mode of ['wrong-id','wrong-version','partial','two-replies']){const f=await fixture(t,mode);await assert.rejects(f.call(f.cmd('capabilities')));assert.equal(f.state().claims.length,0);}
  const f=await fixture(t);await assert.rejects(f.call(f.cmd('claim')),/persisted_intent_gate_required/);assert.equal(f.state().claims.length,0);
  const missing=await fixture(t,'credentials-missing'),cap=await missing.call(missing.cmd('capabilities'));assert.equal(cap.reply.result.credentialState,'unavailable');assert.equal(missing.state().claims.length,0);
  assert.throws(()=>parseLedgerProfile(Buffer.from(JSON.stringify({...f.profile,balance:10}))),/profile_invalid/);
});
