import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonical} from '../../src/comparison.js';
import {runTaskContactChoice,observeTaskContactChoice,parseTaskContactChoice,runTaskContactChoiceFile} from '../../src/task-contact-choice.js';
import {taskChoiceFixture} from './task-contact-choice-fixture.js';
import {hash} from '../../src/snapshot.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';
const raw=(x:unknown)=>Buffer.from(canonical(x));

test('original role selects fixed B, complete B reply returns to A, and replay sends nothing',async t=>{
  const f=await taskChoiceFixture(t),done=await runTaskContactChoice(f.store,f.raw);assert.equal(done.completed,true);assert.equal(done.selectedContact,'contract');assert.equal(done.newModelRequests,3);
  const [a,b,last]=done.steps,second=f.q.messages().submitted(b!.run,'owner-b')[0]!,returned=f.q.messages().submitted(last!.run,'owner-a')[0]!;
  assert.equal(JSON.parse(second.material[0].text).sender.run,a!.run);assert.equal(JSON.parse(returned.material[0].text).sender.run,b!.run);assert.equal(JSON.parse(returned.material[0].text).previousExecutions[0].run,a!.run);
  const before=await readFile(f.trace),events=f.q.status().events,view=await observeTaskContactChoice(f.store,f.raw,true);assert.equal(view.complete,true);assert.equal(view.steps.length,3);assert.ok(view.steps.every(s=>s.report.completeCapture&&s.report.consumptionConfirmed));assert.deepEqual(f.q.status().events,events);assert.deepEqual(await readFile(f.trace),before);
  const again=await runTaskContactChoiceFile(f.store,f.path);assert.equal(again.completed,true);assert.equal(again.newModelRequests,0);assert.deepEqual(await readFile(f.trace),before);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,3);
});

test('no contact request completes original A without starting B or inventing a followup',async t=>{
  const f=await taskChoiceFixture(t,'none'),done=await runTaskContactChoice(f.store,f.raw);assert.equal(done.completed,true);assert.equal(done.selectedContact,null);assert.equal(done.steps.length,1);assert.equal(done.newModelRequests,1);assert.equal(f.q.taskInbox().status(f.b.item).length,0);assert.equal((await observeTaskContactChoice(f.store,f.raw)).complete,true);
});

test('unlisted contact or wrong plan in an otherwise final report cannot start another role',async t=>{
  for(const mode of ['bad-option','wrong-plan']){const f=await taskChoiceFixture(t,mode),done=await runTaskContactChoice(f.store,f.raw);assert.equal(done.completed,false);assert.match(done.waiting!,/option_not_allowed|request_invalid/);assert.equal(done.newModelRequests,1);assert.equal(f.q.taskInbox().status(f.b.item).length,0);const read=await observeTaskContactChoice(f.store,f.raw,true);assert.equal(read.complete,false);assert.equal(read.steps.length,1);assert.ok(read.steps[0].report.report);}
});

test('wrong role, changed trusted plan and candidate change are denied without new downstream input',async t=>{
  const f=await taskChoiceFixture(t);assert.throws(()=>parseTaskContactChoice(raw({...f.plan,initial:{...f.plan.initial,participant:{...f.plan.initial.participant,role:'reviewer'}}})),/task_request_invalid/);
  await assert.rejects(runTaskContactChoiceFile(f.store,f.path,'0'.repeat(64)),/selected_plan_changed/);assert.equal((await f.calls()).length,0);
  let step=0;const done=await runTaskContactChoice(f.store,f.raw,undefined,{beforeStep:()=>{if(++step===4)writeFileSync(join(f.definition.workspace,'sample.js'),'export const changed=99;\n');}});assert.equal(done.completed,false);assert.equal(done.newModelRequests,1);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);
  const changed={...f.plan,contacts:f.plan.contacts.map(c=>({...c,title:'changed after original choice'}))};const denied=await runTaskContactChoice(f.store,raw(changed));assert.equal(denied.completed,false);assert.equal(denied.newModelRequests,0);assert.match(denied.waiting!,/request_id_is_fixed/);
});

test('unknown sent B is retained on reentry and cannot become a different contact',async t=>{
  const f=await taskChoiceFixture(t,'unknown-b'),first=await runTaskContactChoice(f.store,f.raw);assert.equal(first.completed,false);assert.equal(first.newModelRequests,2);const trace=await readFile(f.trace);
  const second=await runTaskContactChoice(f.store,f.raw);assert.equal(second.completed,false);assert.equal(second.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);assert.equal((await observeTaskContactChoice(f.store,f.raw)).complete,false);
  const changed={...f.plan,contacts:f.plan.contacts.map(c=>({...c,request:{...c.request,id:'replacement-recipient'}}))};const held=await runTaskContactChoice(f.store,raw(changed));assert.equal(held.newModelRequests,0);assert.deepEqual(await readFile(f.trace),trace);assert.equal(f.q.taskInbox().status(f.a.item).length,1);
});

test('closing after A returns prevents B launch; explicit reentry consumes the original A without resending it',async t=>{
  const f=await taskChoiceFixture(t);let n=0;const first=await runTaskContactChoice(f.store,f.raw,undefined,{beforeStep:()=>{if(++n===4)throw new Error('task_choice_closing');}});assert.equal(first.completed,false);assert.equal(first.waiting,'task_choice_closing');assert.equal(first.newModelRequests,1);assert.equal(f.q.taskInbox().status(f.b.item).length,0);
  const done=await runTaskContactChoice(f.store,f.raw);assert.equal(done.completed,true);assert.equal(done.newModelRequests,2);assert.equal((await f.calls()).filter(c=>c.kind==='input'&&c.messageId==='choose').length,1);
});

test('competing callers use the same original controller and do not dispatch duplicate role inputs',async t=>{
  const f=await taskChoiceFixture(t);await Promise.all([runTaskContactChoice(f.store,f.raw),runTaskContactChoice(f.store,f.raw)]);const done=await runTaskContactChoice(f.store,f.raw);assert.equal(done.completed,true);assert.equal((await f.calls()).filter(c=>c.kind==='input').length,3);
});

test('contact selection is not coordination approval; final original A feedback still uses the original consumer',async t=>{
  for(const mode of ['contact','none']){
    const f=await taskChoiceFixture(t,mode),p=structuredClone(f.plan);
    for(const exe of [f.codex,f.claude]){let script=await readFile(exe,'utf8');const original="'明确进程夹具完整回复 '+x.messageId+'；消费了原材料与全部前序报告。'",replacement="JSON.stringify((()=>{const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),own=JSON.parse(x.material.find(m=>m.name==='task-owner-context.json').text),task=c.tasks.find(t=>t.item===own.task.item);return {kind:'tongxu-coordination-feedback',task:task.id,revision:c.revision,parts:c.shared.filter(p=>p.feedbackFrom.includes(task.id)).map(p=>({id:p.id,hash:p.hash,position:'agreed',report:'Explicit fixture feedback only.'})),report:'Complete fixture investigation; no writing authority.'};})())";assert.ok(script.includes(original));script=script.replace(original,replacement);await writeFile(exe,script);for(const r of [p.initial,...p.contacts.flatMap(c=>[c.request,c.followup])])if(r.participant.executable===exe)r.participant.executableSha256=hash(script);}
    const plan:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'choice-shared-scope',revision:'r1',previous:null,source:'explicit contact choice coordination fixture',authorityIntent:null,mode:'parallel',actors:[{id:'owner-a',tool:'codex'},{id:'owner-b',tool:'claude'}],tasks:[{id:'A',item:f.a.item,actor:'owner-a',originActor:'owner-a',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['a.js'],workspace:null,publishBranch:null,outputs:[]},{id:'B',item:f.b.item,actor:'owner-b',originActor:'owner-b',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['b.js'],workspace:null,publishBranch:null,outputs:[]}],shared:[{id:'shared',tasks:['A','B'],paths:['sample.js'],contract:'Preserve selected fixed exported value.',feedbackFrom:['A','B'],blockedStages:['implement']}],dependencies:[]};
    const registered=f.q.coordination().register(raw(plan)),done=await runTaskContactChoice(f.store,raw(p));assert.equal(done.completed,true,done.waiting??'');assert.equal(done.newModelRequests,mode==='contact'?3:1);assert.equal((done.steps.at(-1)!.coordination as any).recorded,true);
    const events=f.q.status().events.filter((e:any)=>e.object==='coordination:'+registered.id&&e.kind==='coordination_feedback');if(mode==='contact')assert.ok(events.every((e:any)=>JSON.parse(e.data).value.messageId!=='choose'));assert.equal(f.q.coordination().stage(registered.id,'A','implement').executionAuthorized,false);
  }
});
