import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCoordinationPlan,coordinationPartId,type CoordinationPlan} from '../../src/coordination-contract.js';
const plan=():CoordinationPlan=>({schemaVersion:1,kind:'tongxu-task-coordination',name:'explicit-fixture',revision:'r1',previous:null,source:'Explicit parser fixture only; no native task, authority or writing permission',authorityIntent:null,mode:'stage_serial',actors:[{id:'old-a',tool:'codex'},{id:'a-owner',tool:'codex'},{id:'old-b',tool:'codex'},{id:'b-owner',tool:'claude'}],tasks:[{id:'A',item:'a'.repeat(64),actor:'a-owner',originActor:'old-a',dispatch:'same_tool_new',stages:['investigate','implement','receive'],independentPaths:['src/a.ts'],workspace:null,publishBranch:null,outputs:[{id:'A1',stage:'implement',kind:'repair_candidate'}]},{id:'B',item:'b'.repeat(64),actor:'b-owner',originActor:'old-b',dispatch:'other_tool_new',stages:['investigate','implement','receive'],independentPaths:['src/b.ts'],workspace:null,publishBranch:null,outputs:[{id:'B1',stage:'receive',kind:'receiver_judgment'}]}],shared:[{id:'api',tasks:['A','B'],paths:['src/api.ts'],contract:'Fixed fixture interface; current counterpart feedback required before shared implementation.',feedbackFrom:['A','B'],blockedStages:['implement','receive']}],dependencies:[{task:'B',stage:'implement',producer:'A',capability:'A1'}]});
const parse=(p:CoordinationPlan)=>parseCoordinationPlan(Buffer.from(JSON.stringify(p)));
test('serial arrangement names a precise producer capability and leaves investigation outside shared feedback gates',()=>{
  const p=plan();assert.deepEqual(parse(p),p);assert.equal(p.dependencies[0]!.stage,'implement');assert.ok(!p.shared[0]!.blockedStages.includes('investigate'));
  p.dependencies=[];assert.throws(()=>parse(p),/precise_serial_dependency/);p.mode='parallel';assert.doesNotThrow(()=>parse(p));
});
test('a cycle through a later producer stage is rejected, including its implicit earlier-stage dependency',()=>{
  const p=plan();p.dependencies.push({task:'A',stage:'implement',producer:'B',capability:'B1'});assert.throws(()=>parse(p),/dependency_cycle/);
});
test('dispatch categories match actual assigned tools and a backlog keeps its original responsibility',()=>{
  const p=plan();p.tasks[1]!.dispatch='same_tool_new';assert.throws(()=>parse(p),/dispatch_does_not_match/);p.tasks[1]!.dispatch='owner_backlog';assert.throws(()=>parse(p),/dispatch_does_not_match/);p.tasks[1]!.actor='old-b';assert.doesNotThrow(()=>parse(p));
  p.mode='unified_owner';assert.throws(()=>parse(p),/unified_owner/);p.tasks[0]!.actor='old-b';assert.doesNotThrow(()=>parse(p));
});
test('only the changed shared contract or responsibility invalidates its identity, not unrelated notes or independent paths',()=>{
  const p=plan(),before=coordinationPartId(p,p.shared[0]!);p.revision='r2';p.source+=' new note';p.tasks[0]!.independentPaths.push('docs/unrelated.md');assert.equal(coordinationPartId(p,p.shared[0]!),before);p.shared[0]!.contract+=' changed response shape';assert.notEqual(coordinationPartId(p,p.shared[0]!),before);
  const other=plan();other.tasks[0]!.actor='old-b';assert.notEqual(coordinationPartId(other,other.shared[0]!),before);
});
test('a model report cannot be declared implementation evidence, and shared paths cannot be declared independent',()=>{
  const p=plan();p.tasks[0]!.outputs[0]!.kind='message_report';assert.throws(()=>parse(p),/output_invalid/);p.tasks[0]!.outputs[0]!.kind='repair_candidate';p.tasks[0]!.independentPaths.push('src/api.ts');assert.throws(()=>parse(p),/shared_part_invalid/);p.tasks[0]!.independentPaths.pop();p.shared[0]!.blockedStages=['receive'];assert.throws(()=>parse(p),/shared_part_invalid/);
});
