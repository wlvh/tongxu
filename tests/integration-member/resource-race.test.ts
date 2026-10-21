import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {memberRepairFixture} from './repair-fixture.js';
import {authorizeRepairFixture} from '../review-records/repair-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {runMemberRepairEntry} from '../../src/integration-member-entry.js';
import {ResourceRecords} from '../../src/resource-store.js';
import {hash} from '../../src/snapshot.js';
import {raw} from '../integration/fixture.js';

test('IMR-F01: parent source changed at the actual resource boundary cannot acquire a claim or start a model',async t=>{
  const f=await memberRepairFixture(t),ledger=await ledgerFixture(t),a=await authorizeRepairFixture({...f,operation:f.memberOperation,plan:{...f.plan,item:f.member.item},H:f.A},ledger.profile),ref=async(path:string)=>({path,sha256:hash(await readFile(path))}),p={schemaVersion:1,kind:'tongxu-integration-member-repair',id:'parent-source-resource-race',store:f.store,selection:await ref(join(f.root,'member-return-request.json')),project:await ref(f.requestPath),config:await ref(f.model.configPath),authorityIntent:a.intent,resources:[{ledgerId:a.resource.ledgerId,resourceRef:a.resource.resourceRef,unit:a.resource.unit,quantity:a.resource.quantity}],coordination:null,replacesClosedBinding:null,source:'Original independently found race, using public packet import and actual fixture provider boundary'},path=join(f.root,'resource-race.json');await writeFile(path,raw(p));
  let newer:Parameters<typeof f.q.import>[0]|undefined;const importer=f.q.import;f.q.import=packet=>{newer=packet;return {item:'deferred-fixture-import',packet:0} as ReturnType<typeof importer>;};try{await f.addPacket({pr:99,H:f.A3,sourceAt:new Date(Date.now()+60000).toISOString()});}finally{f.q.import=importer;}assert.ok(newer);
  const before=ledger.state(),trace=await readFile(f.model.trace),dispatch=ResourceRecords.prototype.dispatchClaim;let injected=false;ResourceRecords.prototype.dispatchClaim=function(...args){if(!injected){injected=true;f.q.import(newer!);assert.throws(()=>f.q.memberRepairInput(f.memberOperation,f.memberReturn,true),/source_no_longer_current/);}return dispatch.apply(this,args);};t.after(()=>{ResourceRecords.prototype.dispatchClaim=dispatch;});
  await assert.rejects(runMemberRepairEntry(path),/member_repair_source_no_longer_current/);assert.equal(injected,true);assert.equal(before.claims.length,0);assert.equal(ledger.state().claims.length,0);assert.equal(f.q.resources().status(a.resourceId).state,'prepared_not_sent');assert.ok((await readFile(f.model.trace)).equals(trace));
});
