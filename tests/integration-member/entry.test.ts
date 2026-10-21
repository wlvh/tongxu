import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {memberInputFixture,memberRepairFixture} from './repair-fixture.js';
import {authorizeRepairFixture} from '../review-records/repair-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {raw} from '../integration/fixture.js';
import {hash} from '../../src/snapshot.js';
import {runMemberRepairEntry,parseMemberRepairEntry} from '../../src/integration-member-entry.js';
import {memberRepairMain} from '../../src/integration-member-cli.js';

test('one public entry records original member evidence, runs actual repair/tests/review and keeps frozen inputs for zero-input reentry',async t=>{
  const f=await memberInputFixture(t);assert.equal(f.q.status().operations.some((o:any)=>o.item===f.member.item),false);const ref=async(path:string)=>({path,sha256:hash(await readFile(path))}),p={schemaVersion:1,kind:'tongxu-integration-member-repair',id:'repair-original-member',store:f.store,selection:await ref(f.selectionPath),project:await ref(f.requestPath),config:await ref(f.model.configPath),authorityIntent:null,resources:[],coordination:null,replacesClosedBinding:null,source:'explicit isolated single-entry repair fixture'},path=join(f.root,'member-entry.json');await writeFile(path,raw(p));
  const result=await memberRepairMain(['run','--plan',path]);assert.ok('result' in result);assert.ok(result.result);assert.equal(result.result.repairStatus,'completed');assert.equal(result.result.counters.actualFileWrites,1);assert.equal(result.manualReportCopyRequired,false);assert.equal(result.manualRepairRequired,false);assert.equal(f.q.integrationMemberReturns().state(f.association.id).repairStartedByThisRecord,false);const op=f.q.status().operations.find((o:any)=>o.item===f.member.item);assert.equal(op.id,result.operation);assert.equal(op.result.receiver,undefined);assert.equal(op.result.repair.result.after.H,result.result.after.H);
  const trace=await readFile(f.model.trace);await rm(f.selectionPath);await rm(f.requestPath);const repeated=await runMemberRepairEntry(path);assert.ok('result' in repeated);assert.ok(repeated.result);assert.equal(repeated.operation,result.operation);assert.equal(repeated.result.duplicate,true);assert.ok((await readFile(f.model.trace)).equals(trace));
  assert.throws(()=>parseMemberRepairEntry(raw({...p,command:['/bin/sh']})),/entry_invalid/);await assert.rejects(memberRepairMain(['run','--plan',path,'--force']),/command_invalid/);
});

test('the single entry preserves a completed governed repair after revocation without another resource claim or model input',async t=>{
  const f=await memberRepairFixture(t),ledger=await ledgerFixture(t),a=await authorizeRepairFixture({...f,operation:f.memberOperation,plan:{...f.plan,item:f.member.item},H:f.A},ledger.profile),ref=async(path:string)=>({path,sha256:hash(await readFile(path))}),p={schemaVersion:1,kind:'tongxu-integration-member-repair',id:'governed-member-entry',store:f.store,selection:await ref(join(f.root,'member-return-request.json')),project:await ref(f.requestPath),config:await ref(f.model.configPath),authorityIntent:a.intent,resources:[{ledgerId:a.resource.ledgerId,resourceRef:a.resource.resourceRef,unit:a.resource.unit,quantity:a.resource.quantity}],coordination:null,replacesClosedBinding:null,source:'Explicit governed member entry; all provider identities and models are fixtures'},path=join(f.root,'governed-member-entry.json');await writeFile(path,raw(p));
  const first=await runMemberRepairEntry(path);assert.ok('result' in first);assert.equal(first.result?.repairStatus,'completed');assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);await a.adopt({kind:'revoke',decision:a.confirmed.sha});const trace=await readFile(f.model.trace),state=ledger.state(),again=await runMemberRepairEntry(path);assert.ok('result' in again);assert.equal(again.result?.duplicate,true);assert.ok((await readFile(f.model.trace)).equals(trace));assert.deepEqual(ledger.state(),state);
});
