import test from 'node:test';
import assert from 'node:assert/strict';
import {controlFixture} from './task-controls-fixture.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
const raw=(x:unknown)=>Buffer.from(canonical(x));
test('selected-scope stop blocks original contact and resume preserves its actual original execution path',async t=>{
  const f=await controlFixture(t),base={schemaVersion:1,kind:'tongxu-local-scope-control',item:f.task,scopeSha256:hash(canonical(f.definition.context.scope)),control:'investment',source:'explicit local operator fixture'};
  const stopped=f.q.scopeControls().apply(raw({...base,id:'stop',state:'stopped',expectedRevision:0}));assert.equal(stopped.receipt.revision,1);assert.equal(stopped.ownerApproval,false);await f.controls.execute('contact');assert.equal((await f.calls()).filter(x=>x.kind==='input').length,0);
  const opened=f.q.scopeControls().apply(raw({...base,id:'resume',state:'open',expectedRevision:1}));assert.equal(opened.receipt.revision,2);const result=await f.controls.execute('contact');assert.equal((result.execution as any).completed,true);assert.equal((await f.calls()).filter(x=>x.kind==='input').length,1);assert.equal(f.q.taskInbox().status(f.task).length,1);
});
test('duplicate old control returns its receipt without overwriting a newer state; stale revision and scope are refused',async t=>{
  const f=await controlFixture(t),base={schemaVersion:1,kind:'tongxu-local-scope-control',item:f.task,scopeSha256:hash(canonical(f.definition.context.scope)),control:'investment',source:'explicit local operator fixture'},stop={...base,id:'stop',state:'stopped',expectedRevision:0};f.q.scopeControls().apply(raw(stop));f.q.scopeControls().apply(raw({...base,id:'open',state:'open',expectedRevision:1}));const before=f.q.status(),again=f.q.scopeControls().apply(raw(stop));assert.equal(again.duplicate,true);assert.equal(again.receiptStillLatest,false);assert.equal(again.currentControl!.state,'open');assert.deepEqual(f.q.status(),before);
  assert.throws(()=>f.q.scopeControls().apply(raw({...stop,id:'stale'})),/revision_changed/);assert.throws(()=>f.q.scopeControls().apply(raw({...stop,id:'scope-mismatch',scopeSha256:'0'.repeat(64),expectedRevision:2})),/scope_changed/);assert.throws(()=>f.q.scopeControls().apply(raw({...stop,state:'open'})),/request_id_changed/);assert.deepEqual(f.q.status(),before);
});
