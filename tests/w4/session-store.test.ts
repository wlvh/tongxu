import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile,readFile,mkdir,rm } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setup } from '../w3/receiver-fixture.js';
import { fixture } from './session-source-fixture.js';
import { sessionMain } from '../../src/session-cli.js';
import { readExactCodexSession } from '../../src/session-source.js';
import { hash } from '../../src/snapshot.js';
const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));
async function prepared(t:test.TestContext){const q=await setup(t),source=await fixture(t),plan={schemaVersion:1,kind:'tongxu-session-association',item:q.item,role:'reviewer',source:source.spec},input=join(q.root,'association.json');await writeFile(input,bytes(plan));return {...q,source,plan,input};}
test('one entry records an exact readonly association; role/candidate behavior and writer ownership remain unproven',async t=>{
  const f=await prepared(t),result=await sessionMain(['associate','--store',f.store,'--request','original','--input',f.input]);assert.equal(result.status,'metadata_observed');assert.equal(result.bindingCurrent,true);assert.equal(result.controlPermissionGranted,false);assert.equal(result.actualRoleBehaviorVerified,false);assert.equal(result.executionCandidateVerified,false);assert.equal(result.writerOwnershipVerified,false);
  const original=await readFile(join(result.directory,'stdout.ndjson')),n=f.q.status().events.length;
  const repeated=await sessionMain(['associate','--store',f.store,'--request','original','--input',f.input]);assert.equal(repeated.observation.metadata.threadId,result.observation.metadata.threadId);assert.equal(f.q.status().events.length,n);assert.deepEqual(await readFile(join(result.directory,'stdout.ndjson')),original);assert.equal(await f.count(),0);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{const row=db.prepare("SELECT id,data FROM events WHERE kind='session_read_observed'").get() as any,data=JSON.parse(row.data);data.metadata.sessionId='wrong-after-storage';db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),row.id);assert.throws(()=>f.q.sessions().status('original'),/observation_index_changed/);db.prepare('UPDATE events SET data=? WHERE id=?').run(row.data,row.id);}finally{db.close();}
  await f.packet({H:await f.newHead()});assert.equal(f.q.sessions().status('original').bindingCurrent,false);assert.equal(f.q.sessions().status('original').observation.metadata.threadId,'fixture-thread');
  await writeFile(f.input,bytes({...f.plan,role:'implementer'}));await assert.rejects(sessionMain(['associate','--store',f.store,'--request','original','--input',f.input]),/request_changed/);
});
test('capture completed before recorder interruption can be reconciled after executable removal without another reader',async t=>{
  const f=await prepared(t),r=f.q.sessions(),p=r.prepare('interrupted',bytes(f.plan));await mkdir(dirname(p.directory),{mode:0o700});r.started('interrupted');await readExactCodexSession(p.spec,p.directory);
  const raw=await readFile(join(p.directory,'stdout.ndjson'));await rm(f.source.spec.executable);
  const unresolved=await sessionMain(['associate','--store',f.store,'--request','interrupted','--input',f.input]);assert.equal(unresolved.status,'read_started_or_unknown');assert.equal(unresolved.newReaderStarted,false);
  const result=await sessionMain(['reconcile','--store',f.store,'--request','interrupted']);assert.equal(result.status,'metadata_observed');assert.equal(result.observation.recoveredFromOriginalCapture,true);assert.equal(result.newReaderStarted,false);assert.equal(hash(await readFile(join(p.directory,'stdout.ndjson'))),hash(raw));assert.equal(await f.count(),0);
  assert.equal((await sessionMain(['reconcile','--store',f.store,'--request','interrupted'])).observation.metadata.threadId,'fixture-thread');
});
test('missing or corrupted original capture stays unknown and keeps its exact request instead of starting a replacement',async t=>{
  const f=await prepared(t),r=f.q.sessions(),p=r.prepare('unknown',bytes(f.plan));await mkdir(dirname(p.directory),{mode:0o700});r.started('unknown');
  await assert.rejects(sessionMain(['reconcile','--store',f.store,'--request','unknown']));assert.equal(r.status('unknown').status,'read_started_or_unknown');
  const o=await readExactCodexSession(p.spec,p.directory),raw=await readFile(join(p.directory,'stdout.ndjson'));await writeFile(join(p.directory,'stdout.ndjson'),'damaged\n');await assert.rejects(sessionMain(['reconcile','--store',f.store,'--request','unknown']),/integrity_failed/);assert.equal(r.status('unknown').status,'read_started_or_unknown');
  await writeFile(join(p.directory,'stdout.ndjson'),raw);assert.equal((await sessionMain(['reconcile','--store',f.store,'--request','unknown'])).status,'metadata_observed');assert.equal(o.modelRequestsSent,0);assert.equal(await f.count(),0);
});
test('two real CLI processes bind the same request once; no role override or model dispatch exists',async t=>{
  const f=await prepared(t),cli=fileURLToPath(new URL('../../src/session-cli.js',import.meta.url));const run=()=>new Promise<{code:number|null;out:string;err:string}>(resolve=>{const p=spawn(process.execPath,[cli,'associate','--store',f.store,'--request','concurrent','--input',f.input],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('close',code=>resolve({code,out,err}));});const results=await Promise.all([run(),run()]);assert.ok(results.some(r=>r.code===0));for(const r of results)if(r.code!==0)assert.match(r.err,/controller_active/);
  assert.equal(f.q.status().events.filter((e:any)=>e.kind==='session_read_started').length,1);assert.equal(f.q.sessions().status('concurrent').status,'metadata_observed');assert.equal(await f.count(),0);await assert.rejects(sessionMain(['status','--store',f.store,'--request','concurrent','--role','owner']),/command_invalid/);
});
