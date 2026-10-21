import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from './message-fixture.js';
import {messageAuthority} from './message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {runMessages} from '../../src/messages.js';

async function setup(t:test.TestContext,providerMode='normal',messageMode='complete'){
  const f=await messageFixture(t,messageMode),ledger=await ledgerFixture(t,providerMode),spec=ledger.profile.resources[0]!;
  f.plan.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];
  const authority=await messageAuthority(f);f.q.resources().configure(Buffer.from(JSON.stringify(ledger.profile)));await f.write();return {...f,ledger,authority};
}
test('a lost claim reply keeps the exact governed message unsent; original lookup completes it once',async t=>{
  const f=await setup(t,'lost-after-claim'),first=await runMessages(f.store,f.path);assert.equal(first.completed,false);assert.equal(first.newModelRequests,0);assert.equal((await f.calls()).length,0);assert.equal(f.ledger.state().claims.length,1);
  const binding=f.q.messageResources().state(first.run);assert.equal(f.q.resources().status(binding.resourceRequests[0]).state,'claim_unknown');
  const trace=await readFile(f.trace),readOnly=await runMessages(f.store,f.path,true);assert.equal(readOnly.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
  const next=await runMessages(f.store,f.path);assert.equal(next.completed,true,JSON.stringify(next.problems));assert.equal(next.newModelRequests,4);assert.equal(next.resources[0]!.state,'consumed');assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('lost settlement is reconciled from the original provider after revocation without another input or result write',async t=>{
  const f=await setup(t,'lost-after-result'),first=await runMessages(f.store,f.path);assert.equal(first.completed,true);assert.equal(first.resourcesSettled,false);assert.equal(first.resources[0]!.state,'result_pending_or_unknown');assert.equal(f.ledger.state().settlements.length,1);
  const trace=await readFile(f.trace);await f.authority.adopt({kind:'revoke',decision:f.authority.confirmed.sha});const again=await runMessages(f.store,f.path);assert.equal(again.completed,true);assert.equal(again.resourcesSettled,true);assert.equal(again.newModelRequests,0);assert.equal(again.resources[0]!.state,'consumed');assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('a newer provider unknown after the first reply stops later messages and repeated entry never resends the original',async t=>{
  const f=await setup(t,'normal','delay'),running=runMessages(f.store,f.path),deadline=Date.now()+6000;while(!(await f.calls()).some(c=>c.kind==='input')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.ok((await f.calls()).some(c=>c.kind==='input'));
  const db=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite')),row=db.prepare('SELECT result FROM requests').get() as any,value=JSON.parse(row.result);value.claim.state='unknown';db.prepare('UPDATE requests SET result=?').run(JSON.stringify(value));db.close();
  const result=await running;assert.equal(result.completed,false);assert.equal(result.newModelRequests,1);assert.match(JSON.stringify(result.problems),/fresh_original_held_resource_claim_required/);const binding=f.q.messageResources().state(result.run);assert.equal(f.q.resources().status(binding.resourceRequests[0]).state,'claim_unknown');
  const trace=await readFile(f.trace),again=await runMessages(f.store,f.path);assert.equal(again.completed,false);assert.equal(again.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,0);
});
