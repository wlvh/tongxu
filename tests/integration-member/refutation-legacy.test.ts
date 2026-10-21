import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {runQueueRepair} from '../../src/queue-repair.js';
import {runMemberRefutation} from '../../src/member-refutation.js';
import {memberInputFixture} from './repair-fixture.js';
import {raw} from '../integration/fixture.js';
import {hash} from '../../src/snapshot.js';

test('an actual preopened format20 receiver cannot dispatch after refutation, and its missing input field is rejected by storage',{
  skip:!process.env.TONGXU_TEST_DOCKER_CONFIG||!process.env.TONGXU_TEST_LEGACY_MEMBER_SOURCE,timeout:120000
},async t=>{
  const f=await (await memberInputFixture(t,'project-refuted',false)).prepareRepair();await runQueueRepair(f.planPath);
  const root=process.env.TONGXU_TEST_LEGACY_MEMBER_SOURCE!,{QueueStore:Old}=await import(pathToFileURL(join(root,'dist/src/queue-store.js')).href),{runReception:oldReception}=await import(pathToFileURL(join(root,'dist/src/receiver.js')).href),old=await Old.open(f.store),open=Old.open,close=old.close.bind(old);
  Old.open=async()=>old;old.close=()=>{};t.after(()=>{Old.open=open;close();});
  const ref=async(path:string)=>({path,sha256:hash(await readFile(path))}),plan=join(f.root,'refutation.json');await writeFile(plan,raw({schemaVersion:1,kind:'tongxu-member-refutation-reception',id:'original-refutation',store:f.store,memberReturn:f.memberReturn,repairPlan:await ref(f.planPath),receiverPlan:await ref(f.receiverPath),source:'Explicit isolated old-consumer probe; no official CLI.'}));
  const prepared=await runMemberRefutation(plan,'prepare'),trace=await readFile(f.trace),model=await readFile(f.model.trace);
  await assert.rejects(oldReception(f.receiverPath),/member_recomposition_format_downgraded/);assert.ok((await readFile(f.trace)).equals(trace));assert.ok((await readFile(f.model.trace)).equals(model));
  const begun=f.q.begin(prepared.item,'fixture-old-binding');f.q.evaluate(begun.operation);const db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());const row=db.prepare('SELECT result FROM operations WHERE id=?').get(begun.operation)!,result=JSON.parse(String(row.result));
  result.receiver={contractVersion:6,packetFingerprint:f.q.receiverEvidence(begun.operation).fingerprint};
  assert.throws(()=>db.prepare("UPDATE operations SET status='receiving',result=? WHERE id=?").run(JSON.stringify(result),begun.operation),/member_refutation_complete_input_required/);
  assert.equal(f.q.receiverState(begun.operation).receiver,undefined);assert.ok((await readFile(f.trace)).equals(trace));
});
