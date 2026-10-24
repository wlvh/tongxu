import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,link,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from './message-fixture.js';
import {runMessages} from '../../src/messages.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {messageClaudeVersion,messageClaudeInput,checkMessageClaudeInit,messageClaudeFinal} from '../../src/message-claude.js';

test('Claude release labels are not an allowlist; archived wire profiles and actual init identity remain distinct',()=>{
  assert.equal(messageClaudeVersion('2.1.233 (Claude Code)'),'2.1.233');
  assert.equal(messageClaudeVersion('2.1.304 (Claude Code)'),'2.1.304');
  for(const version of ['2.1.299','2.1.305','99.7.0'])assert.equal(messageClaudeVersion(version+' (Claude Code)'),version);assert.throws(()=>messageClaudeVersion('2.1.304'),/identity_not_observed/);
  assert.equal('client_composed' in messageClaudeInput('2.1.233','s','u','@literal'),false);
  assert.equal(messageClaudeInput('2.1.304','s','u','@literal').client_composed,true);
  const init={type:'system',subtype:'init',session_id:'s',claude_code_version:'2.1.304',permissionMode:'dontAsk',apiKeySource:'none',tools:[],mcp_servers:[]};
  checkMessageClaudeInit(init,'s','2.1.304');assert.throws(()=>checkMessageClaudeInit(init,'s','2.1.233'),/boundary/);
  assert.throws(()=>checkMessageClaudeInit({...init,tools:['Read']},'s','2.1.304'),/boundary/);
});
test('304 fixture performs two messages in one original Claude session, returning exact input receipts and replaying without execution',async t=>{
  const f=await messageFixture(t,'304');f.plan.participants=f.plan.participants.slice(0,2);f.plan.messages=[f.plan.messages[0]!,f.plan.messages[1]!,{id:'impact-followup',from:'reviewer',to:'impact',body:'检查前一轮结论的反例。',replies:['check','impact']},{id:'synthesis',from:'impact',to:'reviewer',body:'综合原完整回复。',replies:['check','impact','impact-followup']}];await f.write();
  const r=await runMessages(f.store,f.path);assert.equal(r.completed,true,JSON.stringify(r.problems));assert.equal(r.newModelRequests,4);
  assert.equal(r.messages[1]!.delivery.sessionId,r.messages[2]!.delivery.sessionId);assert.notEqual(r.messages[1]!.delivery.turnId,r.messages[2]!.delivery.turnId);
  const runtime=r.runtimes.find(x=>x.participant==='impact')!,inputs=(await readFile(join(runtime.started.directory,'stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.equal(inputs.length,2);assert.ok(inputs.every(x=>x.client_composed===true));
  const before=await readFile(f.trace),again=await runMessages(f.store,f.path,true);assert.equal(again.completed,true);assert.deepEqual(await readFile(f.trace),before);
});
test('304 mismatched consumed UUID, unfinished command and child execution cannot release a report downstream',async t=>{
  for(const mode of ['304-wrong-input','304-no-completed','304-child','304-after-completed','304-refused-child','304-duplicate-init']){
    const f=await messageFixture(t,mode),r=await runMessages(f.store,f.path);assert.equal(r.completed,false,mode);assert.equal(r.newModelRequests,2,mode);assert.equal(r.messages[1]!.reply,null);assert.equal(r.messages[2]!.state,'Held');const before=await readFile(f.trace);assert.equal((await runMessages(f.store,f.path,true)).completed,false);assert.deepEqual(await readFile(f.trace),before);
  }
});
test('304 lifecycle has one matching terminal command and no concealed tool, error or other session',()=>{
  const result={type:'result',session_id:'s',subtype:'success',is_error:false,terminal_reason:'completed',stop_reason:'end_turn',result:'fixture',user_message_uuid:'u',user_message_uuids:['u'],queued_turn_count:0,result_index:0,permission_denials:[],safety_stops:0,subagent_stats:{spawned:0,spawned_by_subagents:0,started_in_background:0,completed:0,failed:0,max_depth:0,requested:{background:0,foreground:0,unset:0},killed:{parent:0,user:0,system:0},refused:{depth_limit:0,concurrency_limit:0,budget:0},by_type:{}}};
  const lifecycle=(state:string)=>({type:'command_lifecycle',state,command_uuid:'u',session_id:'s'}),init={type:'system',subtype:'init',session_id:'s',claude_code_version:'2.1.304',permissionMode:'dontAsk',apiKeySource:'none',tools:[],mcp_servers:[]};
  const make=(override:Record<string,unknown>={})=>[lifecycle('queued'),lifecycle('started'),init,{...result,...override},lifecycle('completed')],base=make();assert.equal(messageClaudeFinal(base,'s','2.1.304','u'),'fixture');
  const variants:any[][]=[[...base,{type:'assistant',session_id:'s',message:{content:[{type:'text',text:'late text'}]}}],base.slice(0,-1),[...base,lifecycle('completed')],[...base,{type:'control_request',session_id:'s'}],base.map(x=>({...x,session_id:'other'})),make({terminal_reason:'aborted_streaming'}),make({is_error:true}),make({api_error_status:429}),make({permission_denials:[{tool:'Read'}]}),[...base.slice(0,-1),{type:'assistant',session_id:'s',message:{content:[{type:'tool_use'}]}},base.at(-1)!],[...base.slice(0,-1),init,base.at(-1)!]];
  for(const key of ['killed','refused'] as const){const e=structuredClone(base),r=e.find(x=>x.type==='result') as any;r.subagent_stats[key][key==='killed'?'user':'budget']=1;variants.push(e);}for(const events of variants)assert.throws(()=>messageClaudeFinal(events,'s','2.1.304','u'),/not_complete|boundary|initialization_ambiguous/);
});
test('readonly vendor executables may have hard links; configured paths remain exact while historical fingerprints do not pin new runs',async t=>{
  const f=await messageFixture(t,'304');await link(f.claude,join(f.root,'vendor-hardlink'));await link(f.codex,join(f.root,'codex-hardlink'));const r=await runMessages(f.store,f.path);assert.equal(r.completed,true,JSON.stringify(r.problems));assert.equal(r.newModelRequests,4);const trace=await readFile(f.trace);assert.equal((await runMessages(f.store,f.path,true)).completed,true);assert.deepEqual(await readFile(f.trace),trace);
  const linked=await messageFixture(t,'304'),alias=join(linked.root,'symlink-codex');await symlink(linked.codex,alias);linked.plan.participants[0]!.executable=alias;await linked.write();const refused=await runMessages(linked.store,linked.path);assert.equal(refused.newModelRequests,0);assert.match(JSON.stringify(refused.problems),/executor_file_invalid/);assert.equal((await linked.calls()).length,0);
  const parent=await messageFixture(t,'304'),directoryAlias=join(parent.root,'install-alias');await symlink(parent.root,directoryAlias);parent.plan.participants[0]!.executable=join(directoryAlias,'codex-messages.mjs');await parent.write();const parentRefusal=await runMessages(parent.store,parent.path);assert.equal(parentRefusal.newModelRequests,0);assert.match(JSON.stringify(parentRefusal.problems),/executor_file_invalid/);assert.equal((await parent.calls()).length,0);
  const changed=await messageFixture(t,'304');changed.plan.participants[0]!.executableSha256='a'.repeat(64);await changed.write();const selected=await runMessages(changed.store,changed.path);assert.equal(selected.completed,true,JSON.stringify(selected.problems));assert.equal(selected.newModelRequests,4);const prior=await readFile(changed.trace);assert.equal((await runMessages(changed.store,changed.path,true)).completed,true);assert.deepEqual(await readFile(changed.trace),prior);
});

test('304 rechecks the actual init of each input before accepting a second-round reply',async t=>{
  const f=await messageFixture(t,'304-second-init-tool');f.plan.participants=f.plan.participants.slice(0,2);f.plan.messages=[f.plan.messages[0]!,f.plan.messages[1]!,{id:'impact-followup',from:'reviewer',to:'impact',body:'继续原会话补查。',replies:['check','impact']},{id:'synthesis',from:'impact',to:'reviewer',body:'只消费已核的回复。',replies:['check','impact','impact-followup']}];await f.write();
  const r=await runMessages(f.store,f.path);assert.equal(r.completed,false);assert.equal(r.newModelRequests,3);assert.equal(r.messages[2]!.reply,null);assert.equal(r.messages[3]!.state,'Held');assert.match(JSON.stringify(r.problems),/boundary/);const trace=await readFile(f.trace);await runMessages(f.store,f.path,true);assert.deepEqual(await readFile(f.trace),trace);
});
test('complete per-input 304 originals correct an old failed classification by append only, without resending either input',async t=>{
  const f=await messageFixture(t,'304');f.plan.participants=f.plan.participants.slice(0,2);f.plan.messages=[f.plan.messages[0]!,f.plan.messages[1]!,{id:'impact-followup',from:'reviewer',to:'impact',body:'第二轮原输入。',replies:['check','impact']}];await f.write();const first=await runMessages(f.store,f.path);assert.equal(first.completed,true);
  // Explicit old-reader classification fixture. Actual 092 native originals
  // are preserved and checked separately; this test makes no provider claim.
  const db=new DatabaseSync(join(f.store,'queue.sqlite')),row=db.prepare("SELECT id,data FROM events WHERE kind='message_runtime_ended' AND json_extract(data,'$.value.participant')='impact'").get() as any,record=JSON.parse(row.data);record.value.proof.successfulCapture=false;const bytes=Buffer.from(canonical(record.value));record.sha256=hash(bytes);db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(record.sha256,bytes);const old=JSON.stringify(record);db.prepare('UPDATE events SET data=? WHERE id=?').run(old,row.id);db.prepare("DELETE FROM events WHERE kind='message_reply' AND json_extract(data,'$.value.id')='impact-followup'").run();db.close();
  const trace=await readFile(f.trace),replayed=await runMessages(f.store,f.path,true);assert.equal(replayed.completed,true,JSON.stringify(replayed.problems));const runtime=replayed.runtimes.find(x=>x.participant==='impact')!;assert.equal(runtime.ended.proof.successfulCapture,false);assert.equal(runtime.captureVerification!.source,'strict_original_claude_input_recheck');assert.equal(runtime.captureVerification!.proof.successfulCapture,true);assert.equal(replayed.messages[2]!.reply.reportedConsumption,true);assert.deepEqual(await readFile(f.trace),trace);
  const again=await runMessages(f.store,f.path,true);assert.equal(again.completed,true);const check=new DatabaseSync(join(f.store,'queue.sqlite'));try{assert.equal((check.prepare('SELECT data FROM events WHERE id=?').get(row.id) as any).data,old);assert.equal((check.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='message_runtime_revalidated'").get() as any).n,1);}finally{check.close();}assert.deepEqual(await readFile(f.trace),trace);
});

test('an unfamiliar Claude release with the same stream contract works after its installed bytes change, and re-entry does not resend',async t=>{
  const f=await messageFixture(t,'304');const script=await readFile(f.claude,'utf8');await writeFile(f.claude,script.replaceAll('2.1.304','99.7.0'));
  const r=await runMessages(f.store,f.path);assert.equal(r.completed,true,JSON.stringify(r.problems));assert.equal(r.newModelRequests,4);
  const runtime=r.runtimes.find(x=>x.participant==='impact')!,identity=JSON.parse(await readFile(join(runtime.started.directory,'executable.json'),'utf8'));assert.equal(identity.version,'99.7.0 (Claude Code)');
  const trace=await readFile(f.trace);assert.equal((await runMessages(f.store,f.path,true)).completed,true);assert.deepEqual(await readFile(f.trace),trace);
});
