import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup } from '../w3/receiver-fixture.js';
import { fixture } from '../w5/repair-fixture.js';
import { runReception } from '../../src/receiver.js';
import { runRepair } from '../../src/repair.js';
import { readArchivedSession,requireArchivedSession } from '../../src/session-capture.js';
import { sessionMain } from '../../src/session-cli.js';
import { inspectRolePrompt } from '../../src/role-prompts.js';

test('complete receiver archive links exact native final and complete prompt manifest without implying a live session',async t=>{
  const f=await setup(t),r=await runReception(f.path),directory=join(r.receiver.directory,'claude'),source=await readArchivedSession('claude-readonly',directory);
  const original=f.q.receiverState(r.operation),assembly=JSON.parse(original.promptAssembly.toString());inspectRolePrompt(assembly,'receiver');assert.equal(assembly.system,original.system.toString());assert.ok(assembly.parts.some((p:any)=>p.kind==='upstream'));assert.equal(JSON.parse(original.input.toString()).binding.promptAssemblySha256,r.receiver.promptAssemblySha256);
  assert.equal(source.recordedRole,'receiver');assert.equal(source.finals[0]!.text,JSON.stringify(r.receiver.judgment));assert.equal(source.controlPermissionGranted,false);
  const plan=join(f.root,'link.json');await writeFile(plan,JSON.stringify({directory,format:'claude-readonly',item:f.item,role:'receiver'}));const linked=await sessionMain(['link','--store',f.store,'--request','archive','--input',plan]);assert.equal(linked.status,'archived_result_linked');assert.equal(linked.capturedCandidateMatches,true);assert.equal(linked.currentNativeStatus,'not_observed');assert.equal(linked.source.executionProvenanceVerified,false);assert.equal((await sessionMain(['link','--store',f.store,'--request','archive','--input',plan])).duplicate,true);assert.equal(await f.count(),1);
  assert.throws(()=>f.q.sessions().linkCapture('wrong-role',f.item,'implementer',source),/role_mismatch/);assert.throws(()=>requireArchivedSession({...source}),/original_archived_session_read_required/);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{const row=db.prepare("SELECT id,data FROM events WHERE kind='session_capture_linked'").get() as any,data=JSON.parse(row.data);data.source.finals[0].text='changed after original capture';db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),row.id);assert.throws(()=>f.q.sessions().status('archive'),/index_changed/);db.prepare('UPDATE events SET data=? WHERE id=?').run(row.data,row.id);}finally{db.close();}
  assert.equal(f.q.sessions().status('archive').source.finals[0].text,source.finals[0]!.text);
});
test('controlled Codex archive keeps multiple exact turns and role; fixture provenance cannot become ownership or current candidate proof',async t=>{
  const f=await fixture(t),result=await runRepair(f.plan,f.operation);assert.equal(result.status,'completed');const directory=join(f.operation,'attempt-1','fact-and-repair'),source=await readArchivedSession('codex-controlled',directory);
  assert.equal(source.recordedRole,'verifier_fact');assert.equal(source.executionKindAsRecorded,'fixture');assert.ok(source.turnIds.length>=3);assert.equal(source.finals.length,source.turnIds.length);assert.equal(source.currentNativeStatus,'not_observed');
  await assert.rejects(readArchivedSession('codex-readonly',directory));
  const q=await setup(t),linked=q.q.sessions().linkCapture('fact-archive',q.item,'verifier_fact',source);assert.equal(linked.capturedCandidateMatches,false);assert.equal(linked.controlPermissionGranted,false);assert.equal(linked.writerOwnershipVerified,false);
  const before=await readFile(join(directory,'stdout.ndjson'));await writeFile(join(directory,'stdout.ndjson'),'partial\n');await assert.rejects(readArchivedSession('codex-controlled',directory));await writeFile(join(directory,'stdout.ndjson'),before);assert.equal((await readArchivedSession('codex-controlled',directory)).sessionId,source.sessionId);
});
