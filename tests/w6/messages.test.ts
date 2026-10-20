import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { messageFixture } from './message-fixture.js';
import { runMessages } from '../../src/messages.js';
import { messagePlanId,parseMessagePlan } from '../../src/message-contract.js';
import { hash } from '../../src/snapshot.js';
import { MessageRecords } from '../../src/message-store.js';
import { messageAuthority } from './message-authority-fixture.js';
import { fixture as ledgerFixture } from '../resources/provider-fixture.js';

test('one entry routes same-tool siblings and cross-tool replies back to the exact original session; repeat uses original capture',async t=>{
  const f=await messageFixture(t),r=await runMessages(f.store,f.path);assert.equal(r.completed,true,JSON.stringify(r.problems));assert.equal(r.newModelRequests,4);assert.deepEqual(r.messages.map(m=>m.state),['Reply','Reply','Reply','Reply']);
  const first=r.messages[0]!,last=r.messages[3]!;assert.equal(first.delivery.sessionId,last.delivery.sessionId);assert.notEqual(first.delivery.turnId,last.delivery.turnId);assert.equal(r.runtimes.length,3);assert.equal(r.runtimes[2]!.route.parent,'reviewer');assert.equal(r.writingPermissionGranted,false);
  const trace=await readFile(f.trace);assert.equal((await f.calls()).filter(c=>c.kind==='runtime').length,3);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,4);
  const repeat=await runMessages(f.store,f.path);assert.equal(repeat.completed,true);assert.equal(repeat.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
  await rm(f.codex);await rm(f.claude);const recovery=await runMessages(f.store,f.path,true);assert.equal(recovery.completed,true);assert.deepEqual(recovery.messages.map(m=>m.reply),r.messages.map(m=>m.reply));
});
test('stop investment holds only new messages; implementation and merge stops do not block readonly discussion',async t=>{
  const f=await messageFixture(t);f.q.control('scope','investment','stopped','fixture:owner-stop');let r=await runMessages(f.store,f.path);assert.equal(r.completed,false);assert.equal(r.newModelRequests,0);assert.equal((await f.calls()).length,0);assert.equal(r.messages[0]!.state,'Held');
  f.q.control('scope','investment','open','fixture:owner-resume');f.q.control('scope','implementation','stopped','fixture:owner-stop-write');f.q.control('scope','merge','stopped','fixture:owner-stop-merge');r=await runMessages(f.store,f.path);assert.equal(r.completed,true);assert.equal(r.newModelRequests,4);
});
test('partial final, approval wait, wrong Claude session and missing consumption never finish the chain or resend',async t=>{
  for(const mode of ['partial-answer','waiting','wrong-session','aborted','missing-consumption']){const f=await messageFixture(t,mode),r=await runMessages(f.store,f.path);assert.equal(r.completed,false,mode);const before=await readFile(f.trace),count=(await f.calls()).filter(c=>c.kind==='input').length;assert.ok(count<4,mode);const again=await runMessages(f.store,f.path);assert.equal(again.completed,false,mode);assert.equal(again.newModelRequests,0);assert.deepEqual(await readFile(f.trace),before);}
});
test('two public controllers on one frozen plan send one chain; changing route to evade unknown is blocked',async t=>{
  const f=await messageFixture(t,'delay'),cli=fileURLToPath(new URL('../../src/message-cli.js',import.meta.url)),run=()=>new Promise<any>(resolve=>{const p=spawn(process.execPath,[cli,'run','--store',f.store,'--plan',f.path]);let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('close',code=>resolve({code,out,err}));});const result=await Promise.all([run(),run()]);assert.ok(result.some(x=>x.code===0&&JSON.parse(x.out).completed));for(const x of result)if(x.code)assert.match(x.err,/controller_active/);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,4);
  const unknown=await messageFixture(t,'hang');await runMessages(unknown.store,unknown.path);const before=await readFile(unknown.trace);unknown.plan.source+=' changed route plan';await unknown.write();const next=await runMessages(unknown.store,unknown.path);assert.equal(next.completed,false);assert.match(JSON.stringify(next.problems),/prior_role_runtime_active_or_unknown/);assert.deepEqual(await readFile(unknown.trace),before);
});
test('message source/dependency cycles and impersonated role inputs fail before any child; forged receipts cannot become delivery',async t=>{
  const f=await messageFixture(t),raw=()=>Buffer.from(JSON.stringify(f.plan));f.plan.participants[0]!.parent='impact';assert.throws(()=>parseMessagePlan(raw()),/parent_cycle/);f.plan.participants[0]!.parent=null;f.plan.messages[0]!.from='impact';assert.throws(()=>parseMessagePlan(raw()),/sender_needs/);f.plan.messages[0]!.from=null;
  const r=await runMessages(f.store,f.path);assert.throws(()=>f.q.messages().record(r.run,'reviewer',{kind:'reply',run:r.run,participant:'reviewer',directory:r.runtimes[0]!.started.directory,messageId:'check',data:r.messages[0]!.reply,originals:{}}),/actual_dialog_runtime_proof_required/);
});
test('damaged original capture or queue index remains visible and cannot be accepted by repeat',async t=>{
  const f=await messageFixture(t),r=await runMessages(f.store,f.path),rawPath=join(r.runtimes[0]!.started.directory,'stdout.ndjson'),original=await readFile(rawPath),trace=await readFile(f.trace);await writeFile(rawPath,original.subarray(0,original.length-1));const replay=await runMessages(f.store,f.path,true);assert.equal(replay.completed,false);assert.deepEqual(await readFile(f.trace),trace);await writeFile(rawPath,original);assert.equal((await runMessages(f.store,f.path,true)).completed,true);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{const row=db.prepare("SELECT id,data FROM events WHERE kind='message_reply' LIMIT 1").get() as any,x=JSON.parse(row.data);x.value.receipt.finalText='changed';db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(x),row.id);assert.throws(()=>f.q.messages().status(r.run),/index_changed/);db.prepare('UPDATE events SET data=? WHERE id=?').run(row.data,row.id);}finally{db.close();}
});
test('explicit RPC refusal is separate from unknown delivery and quota holding; neither starts downstream or retries',async t=>{
  for(const mode of ['refused','quota']){const f=await messageFixture(t,mode),r=await runMessages(f.store,f.path);assert.equal(r.completed,false);assert.equal(r.messages[0]!.state,mode==='refused'?'Refused':'Held');assert.equal(r.newModelRequests,mode==='refused'?1:0);const trace=await readFile(f.trace);await runMessages(f.store,f.path,true);assert.deepEqual(await readFile(f.trace),trace);}
});
test('after a real recorder exit 77, complete original native capture reconstructs receipts with no executable or new task',async t=>{
  const f=await messageFixture(t);f.plan.participants=f.plan.participants.slice(0,1);f.plan.messages=f.plan.messages.slice(0,1);await f.write();
  const entry=new URL('../../src/messages.js',import.meta.url).href,records=new URL('../../src/message-store.js',import.meta.url).href,script=join(f.root,'recording-crash.mjs');
  await writeFile(script,`import {runMessages} from ${JSON.stringify(entry)};import{MessageRecords}from ${JSON.stringify(records)};const original=MessageRecords.prototype.record;MessageRecords.prototype.record=function(run,participant,p){if(p.kind==='ended')process.exit(77);return original.call(this,run,participant,p)};await runMessages(${JSON.stringify(f.store)},${JSON.stringify(f.path)});`);
  const code=await new Promise(resolve=>{const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe']});child.stderr.resume();child.on('close',resolve);});assert.equal(code,77);const run=messagePlanId(f.plan);assert.equal(f.q.messages().status(run).runtimes[0]!.ended,null);const before=await readFile(f.trace);await rm(f.codex);
  const r=await runMessages(f.store,f.path,true);assert.equal(r.completed,true,JSON.stringify(r));assert.equal(r.newModelRequests,0);assert.deepEqual(await readFile(f.trace),before);
});
test('actual SIGKILL after dispatch preserves an unknown original recipient and zero replacement sends',async t=>{
  const f=await messageFixture(t,'hang');f.plan.participants=f.plan.participants.slice(0,1);f.plan.messages=f.plan.messages.slice(0,1);f.plan.timeoutMs=60000;await f.write();
  const cli=fileURLToPath(new URL('../../src/message-cli.js',import.meta.url)),child=spawn(process.execPath,[cli,'run','--store',f.store,'--plan',f.path],{stdio:['ignore','ignore','pipe']});child.stderr.resume();const closed=new Promise(resolve=>child.on('close',resolve));const end=Date.now()+5000;while(!(await f.calls()).some(c=>c.kind==='input')&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.ok((await f.calls()).some(c=>c.kind==='input'));child.kill('SIGKILL');await closed;
  const before=await readFile(f.trace),run=messagePlanId(f.plan),recipient=f.q.messages().status(run).messages[0]!.sent.recipient;const r=await runMessages(f.store,f.path,true);assert.equal(r.completed,false);assert.deepEqual(r.messages[0]!.sent.recipient,recipient);assert.equal(r.newModelRequests,0);assert.deepEqual(await readFile(f.trace),before);
});
test('an investment stop between messages holds only unsent work and preserves the original reply',async t=>{
  const f=await messageFixture(t),original=MessageRecords.prototype.record;let changed=false;MessageRecords.prototype.record=function(run,participant,p){const result=original.call(this,run,participant,p);if(p.kind==='reply'&&!changed){changed=true;f.q.control('scope','investment','stopped','fixture:stop-between-turns');}return result;};t.after(()=>{MessageRecords.prototype.record=original;});
  const r=await runMessages(f.store,f.path);assert.equal(r.completed,false);assert.equal(r.messages[0]!.state,'Reply');assert.equal(r.messages[1]!.state,'Held');assert.equal(r.newModelRequests,1);assert.match(JSON.stringify(r.problems),/new_investment_stopped/);
});
test('a newer candidate blocks the frozen unsent plan without taking an old reply as current',async t=>{
  const f=await messageFixture(t);f.q.control('scope','investment','stopped','fixture:prepare-only');const first=await runMessages(f.store,f.path);assert.equal(first.newModelRequests,0);f.q.control('scope','investment','open','fixture:continue');await f.packet({H:await f.newHead()});const result=await runMessages(f.store,f.path);assert.equal(result.newModelRequests,0);assert.match(JSON.stringify(result.problems),/candidate_or_material_changed/);assert.equal((await f.calls()).length,0);
});
test('profiled queues require fresh exact coordination authority; no arbitrary payload or configured resource bypass',async t=>{
  const f=await messageFixture(t),auth=await messageAuthority(f);const r=await runMessages(f.store,f.path);assert.equal(r.completed,true,JSON.stringify(r.problems));assert.equal(r.newModelRequests,4);
  f.plan.source+=' unauthorized change';await f.write();let refused=await runMessages(f.store,f.path);assert.equal(refused.newModelRequests,0);assert.match(JSON.stringify(refused.problems),/authority_mismatch/);
  const other=await messageFixture(t);const a=await messageAuthority(other);await a.adopt({kind:'revoke',decision:a.confirmed.sha});refused=await runMessages(other.store,other.path);assert.equal(refused.newModelRequests,0);assert.match(JSON.stringify(refused.problems),/revoked/);
  const quota=await messageFixture(t);await messageAuthority(quota);const ledger=await ledgerFixture(t);quota.q.resources().configure(Buffer.from(JSON.stringify(ledger.profile)));const held=await runMessages(quota.store,quota.path);assert.equal(held.newModelRequests,0);assert.match(JSON.stringify(held.problems),/resource_consumer_not_yet_bound/);assert.equal((await quota.calls()).length,0);
});
test('a verified ended bootstrap with zero submitted messages can continue the same plan after quota clears, retaining the first capture',async t=>{
  const f=await messageFixture(t,'quota-toggle');f.plan.participants[1]!.id='reviewer-attempt-2';for(const m of f.plan.messages){if(m.to==='impact')m.to='reviewer-attempt-2';if(m.from==='impact')m.from='reviewer-attempt-2';}await f.write();const first=await runMessages(f.store,f.path);assert.equal(first.newModelRequests,0);assert.equal(first.runtimes[0]!.attempt,1);assert.equal(first.runtimes[0]!.ended.proof.knownUnstarted,true);const oldPath=join(first.runtimes[0]!.started.directory,'stdin.ndjson'),old=await readFile(oldPath);assert.equal(old.includes('turn/start'),false);
  await rm(f.quotaFile);const second=await runMessages(f.store,f.path);assert.equal(second.run,first.run);assert.equal(second.completed,true,JSON.stringify(second.problems));assert.equal(second.runtimes[0]!.attempt,2);assert.equal(second.newModelRequests,4);assert.deepEqual(await readFile(oldPath),old);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,4);
});
test('known preflight failure cannot create an eternal unknown writer and bootstrap retries remain bounded',async t=>{
  const f=await messageFixture(t);f.plan.participants[0]!.executableSha256='f'.repeat(64);await f.write();let latest=await runMessages(f.store,f.path);assert.equal(latest.newModelRequests,0);assert.equal(latest.runtimes[0]!.ended.proof.knownUnstarted,true);for(let i=0;i<3;i++)latest=await runMessages(f.store,f.path);assert.equal(latest.runtimes[0]!.attempt,3);assert.match(JSON.stringify(latest.problems),/bootstrap_retry_limit/);assert.equal((await f.calls()).length,0);
  f.plan.participants[0]!.executableSha256=hash(await readFile(f.codex));await f.write();const valid=await runMessages(f.store,f.path);assert.equal(valid.completed,true,JSON.stringify(valid.problems));assert.equal(valid.newModelRequests,4);
});
