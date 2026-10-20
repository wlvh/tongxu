import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { messageFixture } from './message-fixture.js';
import { runMessages } from '../../src/messages.js';
import { MessageRecords } from '../../src/message-store.js';
import { continueMessage,parseContinuationRequest } from '../../src/message-continuation.js';
import { messagePlanId } from '../../src/message-contract.js';
import { hash } from '../../src/snapshot.js';

async function prefix(t:test.TestContext,mode='complete'){
  const f=await messageFixture(t,mode),original=MessageRecords.prototype.record;
  MessageRecords.prototype.record=function(run,participant,p){const result=original.call(this,run,participant,p);if(p.kind==='reply'&&p.messageId==='fact')f.q.control('scope','investment','stopped','fixture:stop-before-unsent-synthesis');return result;};
  let first:Awaited<ReturnType<typeof runMessages>>;try{first=await runMessages(f.store,f.path);}finally{MessageRecords.prototype.record=original;}
  assert.equal(first!.newModelRequests,3);assert.equal(first!.messages.at(-1)!.sent,null);assert.equal(first!.messages.slice(0,3).every(m=>m.state==='Reply'),true);
  f.q.control('scope','investment','open','fixture:explicit-new-context-continuation');
  const request={schemaVersion:1,kind:'tongxu-complete-unsent-message',source:'explicit fixture continuation of the one never-sent final',allowNewContext:true,authorityIntent:null,billing:f.plan.billing,replaceKnownUnstarted:false},requestPath=join(f.root,'continuation-request.json');await writeFile(requestPath,JSON.stringify(request));
  return {...f,first:first!,request,requestPath};
}
test('one explicit continuation preserves the three completed tasks, supplies complete original context, and sends only the unsent final',async t=>{
  const f=await prefix(t),old=f.q.messages().status(f.first.run),prepared=await continueMessage(f.store,f.path,f.requestPath,true);assert.equal(prepared.newModelRequests,0);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,3);
  const context=JSON.parse(await readFile(join(prepared.directory,'context.json'),'utf8'));assert.equal(context.nativeSessionResumed,false);assert.equal(context.reports.length,3);assert.deepEqual(context.reports.map((r:any)=>r.receipt),old.messages.slice(0,3).map(m=>m.reply));assert.equal(context.originalRoleInputs.length,1);assert.equal(context.originalRoleInputs[0].sha256,old.messages[0]!.sent.inputSha256);assert.equal(context.material[0].text,'Explicit fixture source: export const value = 2;\n');
  const result=await continueMessage(f.store,f.path,f.requestPath);assert.equal('completed' in result&&result.completed,true,JSON.stringify(result));assert.equal(result.newModelRequests,1);assert.equal(result.nativeSessionResumed,false);assert.equal('originalRunCompleted' in result&&result.originalRunCompleted,false);
  const fresh=f.q.messages().status(result.nextRun);assert.notEqual(fresh.messages[0]!.reply.sessionId,old.messages[0]!.reply.sessionId);assert.equal(fresh.messages[0]!.reply.reportedConsumption,true);const input=f.q.messages().submitted(result.nextRun,'reviewer')[0];assert.deepEqual(input.replyReferences,[hash(await readFile(join(result.directory,'context.json')))]);assert.match(input.body,/NEW native context/);
  assert.deepEqual(f.q.messages().status(f.first.run).messages,old.messages);assert.deepEqual(f.q.messages().status(f.first.run).runtimes,old.runtimes);const trace=await readFile(f.trace);const repeat=await continueMessage(f.store,f.path,f.requestPath);assert.equal('completed' in repeat&&repeat.completed,true);assert.equal(repeat.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);
});
test('two public continuation controllers cannot launch competing final tasks; a new request never replaces a sent continuation',async t=>{
  const f=await prefix(t,'delay'),cli=fileURLToPath(new URL('../../src/message-continuation-cli.js',import.meta.url));
  const run=()=>new Promise<any>(resolve=>{const p=spawn(process.execPath,[cli,'run','--store',f.store,'--plan',f.path,'--request',f.requestPath]);let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('close',code=>resolve({code,out,err}));});const results=await Promise.all([run(),run()]);assert.ok(results.some(r=>r.code===0&&JSON.parse(r.out).completed));for(const r of results)if(r.code)assert.match(r.err,/controller_active/);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,4);
  f.request.source+=' changed';f.request.replaceKnownUnstarted=true;await writeFile(f.requestPath,JSON.stringify(f.request));const before=await readFile(f.trace);await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath),/unknown_or_sent_never_replace/);assert.deepEqual(await readFile(f.trace),before);
});
test('active original controller, damaged captures, and a changed candidate prevent both continuation entry and direct generated-plan execution',async t=>{
  const f=await prefix(t),prepared=await continueMessage(f.store,f.path,f.requestPath,true),lock=new DatabaseSync(join(f.store,'messages-'+f.first.run,'controller.sqlite'));lock.exec('BEGIN IMMEDIATE');try{await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath),/message_controller_active/);await assert.rejects(()=>runMessages(f.store,prepared.planPath),/original_controller_active/);}finally{lock.exec('ROLLBACK');lock.close();}
  const path=join(f.first.runtimes[0]!.started.directory,'stdout.ndjson'),bytes=await readFile(path);await writeFile(path,bytes.subarray(0,bytes.length-1));await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath),/capture_unresolved/);const blocked=await runMessages(f.store,prepared.planPath);assert.equal(blocked.newModelRequests,0);assert.match(JSON.stringify(blocked.problems),/capture_unresolved/);await writeFile(path,bytes);
  await f.packet({H:await f.newHead()});await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath),/candidate_or_material_changed/);const changed=await runMessages(f.store,prepared.planPath);assert.equal(changed.newModelRequests,0);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,3);
});
test('only a never-started preparation can be replaced, in the same slot, at most three times',async t=>{
  const f=await prefix(t);let current=await continueMessage(f.store,f.path,f.requestPath,true);const originalPlan=await readFile(current.planPath);f.request.source+=' revision';await writeFile(f.requestPath,JSON.stringify(f.request));await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath,true),/selection_is_fixed/);f.request.replaceKnownUnstarted=true;
  const oldPath=current.planPath;for(let i=2;i<=3;i++){f.request.source+=' '+i;await writeFile(f.requestPath,JSON.stringify(f.request));current=await continueMessage(f.store,f.path,f.requestPath,true);assert.equal(current.attempt,i);}assert.deepEqual(await readFile(oldPath),originalPlan);await assert.rejects(()=>runMessages(f.store,oldPath),/selection_superseded/);
  f.request.source+=' fourth';await writeFile(f.requestPath,JSON.stringify(f.request));await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath,true),/attempt_limit/);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,3);
});
test('refused, incomplete, or still unknown original work is not a continuation source and requests cannot introduce new permissions',async t=>{
  for(const mode of ['refused','partial-answer']){const f=await messageFixture(t,mode);await runMessages(f.store,f.path);assert.throws(()=>f.q.messages().continuationSource(messagePlanId(f.plan)),/completed_prefix/);}
  const f=await prefix(t);for(const extra of [{allowNewContext:false},{shell:'echo bypass'},{billing:{...f.request.billing,usageCreditsEnabled:true}}])assert.throws(()=>parseContinuationRequest(Buffer.from(JSON.stringify({...f.request,...extra}))),/request_invalid|billing_boundary/);
});
