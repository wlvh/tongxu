import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {messageFixture} from '../w6/message-fixture.js';
import {runMessages} from '../../src/messages.js';
import {parseMessagePlan} from '../../src/message-contract.js';
import {inspectRolePrompt} from '../../src/role-prompts.js';

test('the explicit acceptance role uses its complete readonly prompt and original Codex or Claude capture, never an Owner outcome',async t=>{
  for(const tool of ['codex','claude'] as const){const f=await messageFixture(t,'304'),participant=f.plan.participants.find(p=>p.tool===tool)!;f.plan.participants=[{...participant,id:'acceptance',role:'acceptance',parent:null}];f.plan.messages=[{id:'assess',from:null,to:'acceptance',body:'核对固定sample.js材料能证明什么、不能证明什么。保留缺口；不要把报告当作实际运行或本人接受。',replies:[]}];f.plan.consumeMaterial=['sample.js'];await f.write();const result=await runMessages(f.store,f.path),state=f.q.messages().status(result.run);assert.equal(result.completed,true);assert.equal(result.newModelRequests,1);assert.equal(state.runtimes[0]!.route.role,'acceptance');assert.equal(state.runtimes[0]!.route.writePermission,false);assert.equal(state.messages[0]!.reply.reportedConsumption,true);assert.equal(state.runtimes[0]!.captureVerification?.proof.successfulCapture,true);
    const frozen=f.q.messages().frozen(result.run),assembly=JSON.parse(frozen.assemblies.acceptance!.toString());assert.equal(inspectRolePrompt(assembly,'acceptance').role,'acceptance');assert.equal(assembly.parts.find((p:any)=>p.kind==='role').text,await readFile(new URL('../../../prompts/acceptance.md',import.meta.url),'utf8'));assert.equal(assembly.permissionGranted,false);assert.equal(f.q.status().events.filter((e:any)=>e.kind==='delivery_outcome_recorded'||e.kind==='authority_decision_applied').length,0);
    const before=await f.calls(),again=await runMessages(f.store,f.path);assert.equal(again.newModelRequests,0);assert.deepEqual(await f.calls(),before);assert.equal(parseMessagePlan(await readFile(f.path)).participants[0]!.role,'acceptance');
  }
});
test('an acceptance partial answer stays unresolved and the same request never resends',async t=>{
  const f=await messageFixture(t,'partial-answer');f.plan.participants=[{...f.plan.participants[0]!,id:'acceptance',role:'acceptance',parent:null}];f.plan.messages=[{id:'assess',from:null,to:'acceptance',body:'检查准确材料并完整报告覆盖与缺口；明确模拟终态故障。',replies:[]}];await f.write();const result=await runMessages(f.store,f.path);assert.equal(result.completed,false);const before=await f.calls(),again=await runMessages(f.store,f.path);assert.equal(again.newModelRequests,0);assert.equal(again.completed,false);assert.deepEqual(await f.calls(),before);assert.equal(f.q.status().events.filter((e:any)=>e.kind==='delivery_outcome_recorded').length,0);
});
