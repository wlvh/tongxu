import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {runClaude,readClaudeExecution} from '../../src/live-claude.js';
import {recoverStage} from '../../src/relay.js';
import {hash} from '../../src/snapshot.js';
import {messageFixture} from '../w6/message-fixture.js';

const input=JSON.stringify({messageId:'single-review',replyReferences:['fixed-source'],evidence:'Quoted @/private/example is data, not an attachment.\n第二行原文'});
test('304 single execution preserves logical and wire input separately and recovers without another input',async t=>{
  const f=await messageFixture(t,'304'),directory=join(f.root,'single');
  const result=await runClaude({executable:f.claude,directory,system:'Explicit fixture independent reviewer',input,timeoutMs:1000});
  assert.equal(result.protocol,'claude-stream-json/2.1.304');assert.equal(result.inputSha256,hash(input));
  const wire=await readFile(join(directory,'stdin.ndjson'));assert.equal(result.wireInputSha256,hash(wire));assert.notEqual(result.inputSha256,result.wireInputSha256);
  const sent=JSON.parse(wire.toString());assert.equal(sent.client_composed,true);assert.equal(sent.message.content,input);assert.equal(sent.uuid,result.inputUuid);
  const trace=await readFile(f.trace,'utf8'),recovered=await recoverStage(directory,'claude');
  assert.equal(recovered.finalText,result.finalText);assert.equal(recovered.inputSha256,result.inputSha256);assert.equal(recovered.inputUuid,result.inputUuid);
  await rm(join(directory,'completed.json'));assert.equal((await recoverStage(directory,'claude')).finalText,result.finalText);assert.equal(await readFile(f.trace,'utf8'),trace);
});
test('304 governed dispatch submits the exact first user message before releasing its synchronous effect gate',async t=>{
  const f=await messageFixture(t,'304'),directory=join(f.root,'gated'),seen:unknown[]=[];
  const result=await runClaude({executable:f.claude,directory,system:'Explicit gated fixture',input,timeoutMs:1000,dispatchGate:effect=>{const value=effect(),wire=JSON.parse(readFileSync(join(directory,'stdin.ndjson'),'utf8'));assert.equal(wire.type,'user');assert.equal(wire.message.content,input);assert.equal(wire.client_composed,true);seen.push(wire.uuid);return value;}});
  assert.deepEqual(seen,[result.inputUuid]);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,1);
});

test('304 single execution rejects an incomplete command, child execution, a wrong input and terminal tail',async t=>{
  for(const mode of ['304-no-completed','304-child','304-refused-child','304-wrong-input','304-after-completed']){
    const f=await messageFixture(t,mode),directory=join(f.root,'single');
    await assert.rejects(runClaude({executable:f.claude,directory,system:'Explicit fixture',input,timeoutMs:100}),/executor_wait_timeout|message_claude_304_command_not_complete/);
    const trace=await readFile(f.trace,'utf8');await assert.rejects(recoverStage(directory,'claude'),/message_claude_304_command_not_complete/);assert.equal(await readFile(f.trace,'utf8'),trace);
  }
});

test('304 recovery verifies original composed input, exact launch and protocol even with self-consistent file digests',async t=>{
  const f=await messageFixture(t,'304'),directory=join(f.root,'single');
  await runClaude({executable:f.claude,directory,system:'Explicit fixture',input,timeoutMs:1000});
  for(const mode of ['wire','launch','protocol']){
    const copy=join(f.root,mode);await cp(directory,copy,{recursive:true});
    if(mode==='wire'){
      const wire=JSON.parse(await readFile(join(copy,'stdin.ndjson'),'utf8'));delete wire.client_composed;const bytes=JSON.stringify(wire)+'\n';await writeFile(join(copy,'stdin.ndjson'),bytes);
      const capture=JSON.parse(await readFile(join(copy,'capture-status.json'),'utf8'));capture.files['stdin.ndjson']=hash(bytes);await writeFile(join(copy,'capture-status.json'),JSON.stringify(capture));
      await assert.rejects(readClaudeExecution(copy),/claude_original_stream_input_changed/);
    }else if(mode==='launch'){
      const launch=JSON.parse(await readFile(join(copy,'launch.json'),'utf8'));launch.args.push('--continue');await writeFile(join(copy,'launch.json'),JSON.stringify(launch));
      await assert.rejects(readClaudeExecution(copy),/claude_original_stream_launch_changed/);
    }else{
      const receipt=JSON.parse(await readFile(join(copy,'completed.json'),'utf8'));receipt.protocol='claude-text/2.1.233';await writeFile(join(copy,'completed.json'),JSON.stringify(receipt));
      await assert.rejects(recoverStage(copy,'claude'),/stage_input_integrity_failed/);
    }
  }
});
