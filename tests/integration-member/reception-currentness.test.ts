import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {memberInputFixture} from './repair-fixture.js';
import {raw} from '../integration/fixture.js';
import {verify} from '../../src/verification.js';
import {readPacket} from '../../src/queue-evidence.js';
import {runReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';
import {runMemberRepairEntry} from '../../src/integration-member-entry.js';

test('new integration return retires an old individual PASS and repairs under the parent return without rewriting either judgment',async t=>{
  const f=await memberInputFixture(t),docker=JSON.parse(await readFile(process.env.TONGXU_TEST_DOCKER_CONFIG!,'utf8')),plan=join(f.root,'individual-positive-test.json');
  // Explicit process fixture of a narrower earlier check: it passed, while
  // the later parent supplied the missing empty-label counterexample.
  await writeFile(plan,raw({schemaVersion:2,executor:docker,tools:[{id:'positive-unit',argv:[docker.node,'-e',"const fs=require('node:fs'),n=JSON.parse(fs.readFileSync('scale.json'));fs.writeFileSync(process.env.TONGXU_RESULT_FILE,JSON.stringify({samples:[{id:'positive',status:n>0?'ok':'fail',content:n,identity:'positive-unit',source:'actual scale.json',sideEffects:[]}]}));"],timeoutMs:10000,expectedSampleIds:['positive']}]}));
  const output=join(f.root,'individual-positive-verification');await verify({snapshots:[f.snapshots[0]!],objects:f.objects,plan,output});const packet=await readPacket(f.snapshots[0]!,output,join(f.root,'integration-context.json')),member=f.q.import(packet);assert.equal(packet.summary.evidenceComplete,true);
  await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="complete"'));const receiver=join(f.root,'earlier-member-receiver.json');await writeFile(receiver,raw({...f.plan,item:member.item,objects:f.objects,sourcePaths:['src/normalize.mjs','scale.json']}));const old=await runReception(receiver);assert.equal(old.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(old.receiver.currentMaterialMatches,true);const original=JSON.stringify(old.receiver.judgment);
  const association={...f.association,member:{...f.association.member,packet:member.packet,fingerprint:packet.fingerprint}};await writeFile(f.selectionPath,raw(association));f.q.integrationMemberReturns().record(raw(association));assert.equal(f.q.receiverState(old.operation).result.receiver.currentMaterialMatches,false);assert.equal(JSON.stringify(f.q.receiverState(old.operation).receiver.judgment),original);assert.equal(f.q.integrationMemberReturns().state(association.id).current,true);
  const ref=async(path:string)=>({path,sha256:hash(await readFile(path))}),entry={schemaVersion:1,kind:'tongxu-integration-member-repair',id:'repair-after-parent-counterexample',store:f.store,selection:await ref(f.selectionPath),project:await ref(f.requestPath),config:await ref(f.model.configPath),authorityIntent:null,resources:[],coordination:null,replacesClosedBinding:null,source:'explicit scoped repair uses actual parent return; old member PASS is retained as historical'},path=join(f.root,'counterexample-entry.json');await writeFile(path,raw(entry));const result=await runMemberRepairEntry(path);assert.ok('result' in result);assert.ok(result.result);assert.equal(result.operation,old.operation);assert.equal(result.result.repairStatus,'completed');assert.equal(result.result.counters.actualFileWrites,1);assert.equal(JSON.stringify(f.q.receiverState(old.operation).receiver.judgment),original);assert.equal(f.q.receiverState(old.operation).result.receiver.currentMaterialMatches,false);assert.equal(f.q.receiverState(f.parent.operation).receiver.judgment.verdict,'RETURN_FOR_WORK');
});
