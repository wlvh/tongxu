import test from 'node:test';
import assert from 'node:assert/strict';
import {messageFixture} from '../w6/message-fixture.js';
import {runMessages} from '../../src/messages.js';
import {parseMessagePlan} from '../../src/message-contract.js';
import {parseEarlyReceiverAdvice,earlyReceiverAdviceInstructions} from '../../src/early-receiver-contract.js';
import {canonical} from '../../src/comparison.js';
import {inspectRolePrompt} from '../../src/role-prompts.js';

test('early Codex transport uses the actual receiver assembly without writing a technical judgment; old plans stay byte-identical',async t=>{
 const f=await messageFixture(t),old=Buffer.from(canonical(f.plan));assert.equal(canonical(parseMessagePlan(old)),old.toString());
 f.plan.participants=[{...f.plan.participants[0]!,role:'receiver',parent:null}];f.plan.messages=[f.plan.messages[0]!];await f.write();
 const before=f.q.status().operations.map((o:any)=>o.result?.receiver?.judgment??null),result=await runMessages(f.store,f.path);
 assert.equal(result.completed,true,JSON.stringify(result.problems));assert.equal(result.newModelRequests,1);
 const assembly=JSON.parse(f.q.messages().frozen(result.run).assemblies[f.plan.participants[0]!.id]!.toString());
 assert.equal(inspectRolePrompt(assembly,'receiver').role,'receiver');assert.ok(assembly.parts.some((p:any)=>p.source==='tongxu:prompts/receiver.md'));
 assert.deepEqual(f.q.status().operations.map((o:any)=>o.result?.receiver?.judgment??null),before);
 const calls=await f.calls();assert.equal((await runMessages(f.store,f.path,true)).newModelRequests,0);assert.deepEqual(await f.calls(),calls);
 const wrong=structuredClone(f.plan);wrong.participants[0]!.tool='claude';wrong.participants[0]!.allowedInstructionSources=[];
 assert.throws(()=>parseMessagePlan(Buffer.from(canonical(wrong))),/early_receiver_codex_transport_required/);
});

test('early advice binds exact shared material and preserves conflict or unknown without accepting PASS or another part',()=>{
 const binding={relationSha256:'a'.repeat(64),materialSha256:'b'.repeat(64),parts:[{id:'api',hash:'c'.repeat(64)},{id:'storage',hash:'d'.repeat(64)}]},value={schemaVersion:1,kind:'tongxu-early-receiver-advice',relationSha256:binding.relationSha256,materialSha256:binding.materialSha256,parts:[{id:'storage',hash:'d'.repeat(64),position:'unknown',report:'Current writer end state remains unknown.'},{id:'api',hash:'c'.repeat(64),position:'conflict',report:'The intermediate consumer still expects the old field.'}],report:'Early advice on the exact supplied material; no final technical acceptance.'};
 const parsed=parseEarlyReceiverAdvice(Buffer.from(canonical(value)),binding);assert.deepEqual(parsed.parts.map(p=>[p.id,p.position]),[['api','conflict'],['storage','unknown']]);
 for(const changed of [{...value,materialSha256:'e'.repeat(64)},{...value,verdict:'ACCEPT_WITHIN_SCOPE'},{...value,parts:[{...value.parts[0],position:'PASS'},value.parts[1]]},{...value,parts:[value.parts[0],value.parts[0]]},{...value,parts:[value.parts[0],{...value.parts[1],hash:'e'.repeat(64)}]}])assert.throws(()=>parseEarlyReceiverAdvice(Buffer.from(canonical(changed)),binding),/early_receiver_.*binding_invalid/);
 assert.match(earlyReceiverAdviceInstructions(binding),/early advice only/);
});
