import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from './message-fixture.js';
import {runMessages} from '../../src/messages.js';
import {messageClaudeVersion,messageClaudeInput,checkMessageClaudeInit,messageClaudeFinal} from '../../src/message-claude.js';

test('exact supported Claude profiles keep legacy input and require 304 composed input',()=>{
  assert.equal(messageClaudeVersion('2.1.233 (Claude Code)'),'2.1.233');
  assert.equal(messageClaudeVersion('2.1.304 (Claude Code)'),'2.1.304');
  for(const version of ['2.1.299 (Claude Code)','2.1.305 (Claude Code)','2.1.304'])assert.throws(()=>messageClaudeVersion(version),/unsupported/);
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
  for(const mode of ['304-wrong-input','304-no-completed','304-child']){
    const f=await messageFixture(t,mode),r=await runMessages(f.store,f.path);assert.equal(r.completed,false,mode);assert.equal(r.newModelRequests,2,mode);assert.equal(r.messages[1]!.reply,null);assert.equal(r.messages[2]!.state,'Held');const before=await readFile(f.trace);assert.equal((await runMessages(f.store,f.path,true)).completed,false);assert.deepEqual(await readFile(f.trace),before);
  }
});
test('304 lifecycle has one matching terminal command and no concealed tool, error or other session',()=>{
  const result={type:'result',session_id:'s',subtype:'success',is_error:false,terminal_reason:'completed',stop_reason:'end_turn',result:'fixture',user_message_uuid:'u',user_message_uuids:['u'],queued_turn_count:0,result_index:0,permission_denials:[],safety_stops:0,subagent_stats:{spawned:0,spawned_by_subagents:0,started_in_background:0,completed:0,failed:0,max_depth:0,requested:{background:0,foreground:0,unset:0}}};
  const lifecycle=(state:string)=>({type:'command_lifecycle',state,command_uuid:'u',session_id:'s'}),base=[lifecycle('queued'),lifecycle('started'),result,lifecycle('completed')];assert.equal(messageClaudeFinal(base,'s','2.1.304','u'),'fixture');
  const variants=[base.slice(0,-1),[...base,lifecycle('completed')],[...base,{type:'control_request',session_id:'s'}],base.map(x=>({...x,session_id:'other'})),[base[0]!,base[1]!,{...result,terminal_reason:'aborted_streaming'},base[3]!],[base[0]!,base[1]!,{...result,is_error:true},base[3]!],[base[0]!,base[1]!,{...result,api_error_status:429},base[3]!],[base[0]!,base[1]!,{...result,permission_denials:[{tool:'Read'}]},base[3]!],[base[0]!,base[1]!,{type:'assistant',session_id:'s',message:{content:[{type:'tool_use'}]}},result,base[3]!]];
  for(const events of variants)assert.throws(()=>messageClaudeFinal(events,'s','2.1.304','u'),/not_complete/);
});
