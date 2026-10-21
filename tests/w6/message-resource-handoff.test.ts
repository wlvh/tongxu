import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from './message-fixture.js';
import {messageAuthority} from './message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {MessageRecords} from '../../src/message-store.js';
import {runMessages} from '../../src/messages.js';
import {continueMessage} from '../../src/message-continuation.js';
import {hash} from '../../src/snapshot.js';
import {readOwnerSource} from '../../src/authority-source.js';
import {QueueStore} from '../../src/queue-store.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

async function fixture(t:test.TestContext,mode='normal'){
  const f=await messageFixture(t),ledger=await ledgerFixture(t,mode==='lost-next-claim'?'normal':mode),spec=ledger.profile.resources[0]!;
  if(mode==='lost-next-claim'){let script=await readFile(ledger.profile.executable,'utf8');script=script.replace("if(mode==='lost-after-claim'&&c.command==='claim'", "if(c.command==='claim'&&c.request.authorityIntent==='resumed-coordination'||mode==='lost-after-claim'&&c.command==='claim'");await writeFile(ledger.profile.executable,script);ledger.profile.executableSha256=hash(script);}
  const db=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));db.prepare('UPDATE capacity SET n=2').run();db.close();
  f.plan.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];const authority=await messageAuthority(f);f.q.resources().configure(Buffer.from(JSON.stringify(ledger.profile)));await f.write();
  const record=MessageRecords.prototype.record;MessageRecords.prototype.record=function(run,participant,p){const result=record.call(this,run,participant,p);if(p.kind==='reply'&&p.messageId==='fact')f.q.control('scope','investment','stopped','fixture: stop only the final unsent message');return result;};let first:any;
  try{first=await runMessages(f.store,f.path);}finally{MessageRecords.prototype.record=record;}
  assert.equal(first.newModelRequests,3);assert.equal(first.completed,false);assert.equal(first.messages.at(-1).sent,null);f.q.control('scope','investment','open','fixture: original owner allows bounded continuation');
  const request={schemaVersion:1,kind:'tongxu-complete-unsent-message',source:'Explicit fixture: settle captured prefix before exact final message continuation',allowNewContext:true,authorityIntent:'resumed-coordination',billing:f.plan.billing,replaceKnownUnstarted:false},requestPath=join(f.root,'continue-resources.json');await writeFile(requestPath,JSON.stringify(request));
  const prepared=await continueMessage(f.store,f.path,requestPath,true),action={...authority.request,payloadSha256:prepared.nextRun},grant=await authority.adopt({kind:'confirm_action',adoption:authority.scope.sha,performerRole:'coordinator',request:action,expiresAt:new Date(Date.now()+3600000).toISOString()}),fresh=[];
  for(const [i,source] of authority.a.sourceRequests(grant.sha).entries())fresh.push(await readOwnerSource(authority.a.configuration().profile,source.proposalSha256,source.commentId,join(f.root,'continuation-authority-'+i)));
  authority.a.reserveAction(request.authorityIntent,action,'coordinator',grant.sha,fresh);
  return {...f,ledger,authority,first,request,requestPath,prepared,grant,originalResource:f.q.messageResources().state(first.run).resourceRequests[0]!};
}
test('governed continuation accounts for the complete prefix, sends only the unsent final and retains original reports',async t=>{
  const f=await fixture(t),old=f.q.messages().status(f.first.run);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,0);const result:any=await continueMessage(f.store,f.path,f.requestPath);
  assert.equal(result.completed,true,JSON.stringify(result));assert.equal(result.newModelRequests,1);assert.equal(result.originalRunCompleted,false);assert.equal(result.nativeSessionResumed,false);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);assert.equal(f.q.resources().status(f.originalResource).outcome.outcome.state,'failed');assert.equal(f.q.resources().settledOutcome(f.originalResource),true);assert.equal(f.q.messageResources().state(f.first.run).phase,'partial_returned');assert.deepEqual(f.q.messages().status(f.first.run).messages,old.messages);assert.deepEqual(f.q.messages().status(f.first.run).runtimes,old.runtimes);
  const projection=(await QueueStore.observe(f.store,[],[],[f.item])).collaboration[f.item],original=projection.messages.find((r:any)=>r.run===f.first.run);assert.equal(original.resourcesSettled,true);assert.equal(original.messages.at(-1).state,'Held');assert.equal(original.messages.at(-1).sendRegistered,false);assert.equal(original.messages.at(-1).continuedIn,result.nextRun);
  const trace=await readFile(f.trace),again:any=await continueMessage(f.store,f.path,f.requestPath);assert.equal(again.completed,true);assert.equal(again.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);
});
test('lost prefix and final settlements are recovered from original requests without repeated inputs or writes',async t=>{
  const f=await fixture(t,'lost-after-result'),trace=await readFile(f.trace);await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath));assert.equal(f.ledger.state().settlements.length,1);assert.deepEqual(await readFile(f.trace),trace);
  const pending=f.q.status(),provider=f.ledger.state();await runMessages(f.store,f.path,true);assert.deepEqual(f.q.status(),pending);assert.deepEqual(f.ledger.state(),provider);
  const second:any=await continueMessage(f.store,f.path,f.requestPath);assert.equal(second.newModelRequests,1);assert.equal(second.result.completed,true);assert.equal(second.completed,false);assert.equal(second.result.resourcesSettled,false);assert.equal(f.ledger.state().settlements.length,2);
  const sent=await readFile(f.trace),third:any=await continueMessage(f.store,f.path,f.requestPath);assert.equal(third.completed,true);assert.equal(third.newModelRequests,0);assert.deepEqual(await readFile(f.trace),sent);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);
});
test('an unknown continuation claim retains its fixed selection and resumes with an appended billing observation',async t=>{
  const f=await fixture(t,'lost-next-claim'),first:any=await continueMessage(f.store,f.path,f.requestPath);assert.equal(first.completed,false);assert.equal(first.newModelRequests,0);const plan=await readFile(first.planPath),requestBytes=await readFile(join(first.directory,'request.json'));assert.equal(f.ledger.state().claims.length,2);
  f.request.billing={...f.request.billing,observedAt:new Date().toISOString()};f.request.replaceKnownUnstarted=true;await writeFile(f.requestPath,JSON.stringify({...f.request,authorityIntent:'replacement-must-not-hide-unknown'}));await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath),/invested_request_is_fixed/);assert.equal(f.ledger.state().claims.length,2);
  await writeFile(f.requestPath,JSON.stringify(f.request));const next:any=await continueMessage(f.store,f.path,f.requestPath);assert.equal(next.completed,true,JSON.stringify(next));assert.equal(next.nextRun,first.nextRun);assert.equal(next.attempt,first.attempt);assert.equal(next.newModelRequests,1);assert.deepEqual(await readFile(next.planPath),plan);assert.deepEqual(await readFile(join(next.directory,'request.json')),requestBytes);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);
});
test('revocation blocks new continuation work while the original completed prefix can still be accounted',async t=>{
  const f=await fixture(t),trace=await readFile(f.trace);await f.authority.adopt({kind:'revoke',decision:f.grant.sha});const result:any=await continueMessage(f.store,f.path,f.requestPath);assert.equal(result.completed,false);assert.equal(result.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.q.resources().settledOutcome(f.originalResource),true);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
  const outcome=JSON.stringify(f.q.resources().status(f.originalResource).outcome);f.request.authorityIntent='new-exact-authorized-continuation';f.request.replaceKnownUnstarted=true;await writeFile(f.requestPath,JSON.stringify(f.request));const prepared=await continueMessage(f.store,f.path,f.requestPath,true);assert.notEqual(prepared.nextRun,result.nextRun);const action={...f.authority.request,payloadSha256:prepared.nextRun},grant=await f.authority.adopt({kind:'confirm_action',adoption:f.authority.scope.sha,performerRole:'coordinator',request:action,expiresAt:new Date(Date.now()+3600000).toISOString()}),fresh=[];for(const [i,source] of f.authority.a.sourceRequests(grant.sha).entries())fresh.push(await readOwnerSource(f.authority.a.configuration().profile,source.proposalSha256,source.commentId,join(f.root,'renewed-authority-'+i)));f.authority.a.reserveAction(f.request.authorityIntent,action,'coordinator',grant.sha,fresh);
  const resumed:any=await continueMessage(f.store,f.path,f.requestPath);assert.equal(resumed.completed,true,JSON.stringify(resumed));assert.equal(resumed.newModelRequests,1);assert.equal(JSON.stringify(f.q.resources().status(f.originalResource).outcome),outcome);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);
});
test('two governed continuation controllers keep one original accounting and one final dispatch',async t=>{
  const f=await fixture(t),cli=fileURLToPath(new URL('../../src/message-continuation-cli.js',import.meta.url)),run=()=>new Promise<{code:number|null;out:string;error:string}>(resolve=>{const child=spawn(process.execPath,[cli,'run','--store',f.store,'--plan',f.path,'--request',f.requestPath]);let out='',error='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);child.on('close',code=>resolve({code,out,error}));});
  const all=await Promise.all([run(),run()]);assert.ok(all.some(r=>r.code===0&&JSON.parse(r.out).completed));for(const r of all)if(r.code!==0)assert.match(r.error,/controller_active/);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,4);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);
});
test('changed candidates and unconfirmed original claims cannot start another resource consumer',async t=>{
  for(const mode of ['candidate','unknown','released']){const f=await fixture(t),trace=await readFile(f.trace);if(mode==='candidate')await f.packet({H:await f.newHead()});else{const db=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite')),row=db.prepare('SELECT result FROM requests WHERE id=?').get(f.originalResource) as any,v=JSON.parse(row.result);v.claim.state=mode;db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(v),f.originalResource);db.close();}
    await assert.rejects(()=>continueMessage(f.store,f.path,f.requestPath),mode==='candidate'?/candidate_or_material_changed/:/partial_resource_state_unresolved/);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,0);
  }
});
