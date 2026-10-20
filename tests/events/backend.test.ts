import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { waitPhase } from '../w3/receiver-fixture.js';
import { monitored } from './backend-fixture.js';
import { sourceTick } from '../../src/event-tick.js';
import { runReception } from '../../src/receiver.js';
import { eventStateKey } from '../../src/event-gates.js';

test('source opt-in stops stale starts; full source material reaches a new receiver packet exactly once',async t=>{
  const f=await monitored(t),original=f.q.status().items[0].currentPacket;
  assert.ok(f.q.begin(f.item,'before-source').blocked.includes('source_unavailable_or_not_observed'));
  const tick=await sourceTick(f.store),next=tick.materials.items[0]!;assert.equal(next.changed,true);assert.notEqual(next.packet,original);assert.equal(await f.count(),0);
  const done=await runReception(f.path);assert.equal(done.receiver.currentMaterialMatches,true);assert.equal(await f.count(),1);
  const sent=JSON.parse(await readFile(join(done.receiver.directory,'binding-input.json'),'utf8'));
  assert.equal(sent.data.evidence.sourceEvents.length,1);assert.ok(sent.data.evidence.sourceEvents[0].originals.some((r:any)=>r.kind==='comments'&&r.text==='[]'));
  const again=await sourceTick(f.store);assert.equal(again.materials.items[0]!.changed,false);assert.equal((await runReception(f.path)).operation,done.operation);assert.equal(await f.count(),1);
});
test('new comment invalidates the old judgment without copying it or dispatching another model',async t=>{
  const f=await monitored(t);await sourceTick(f.store);const before=await runReception(f.path),oldInput=await readFile(join(before.receiver.directory,'binding-input.json'));
  await f.source.change({comments:[{id:8,user:{id:15},body:'Counterexample: the empty input also matters.'}]});
  const updated=await sourceTick(f.store);assert.equal(updated.materials.items[0]!.changed,true);assert.equal(await f.count(),1);
  assert.equal(f.q.status().operations[0].result.receiver.currentMaterialMatches,false);
  assert.deepEqual(await readFile(join(before.receiver.directory,'binding-input.json')),oldInput);
  const after=await runReception(f.path);assert.notEqual(after.operation,before.operation);assert.equal(after.receiver.currentMaterialMatches,true);assert.equal(await f.count(),2);
  const sent=JSON.parse(await readFile(join(after.receiver.directory,'binding-input.json'),'utf8'));assert.ok(sent.data.evidence.sourceEvents[0].originals.some((r:any)=>r.text.includes('Counterexample')));
});
test('check-only changes retain packet and completed judgment; unavailable source blocks dispatch and recovery uses original material',async t=>{
  const f=await monitored(t);await sourceTick(f.store);const done=await runReception(f.path),packet=done.packet;
  await f.source.change({checks:[{id:1,name:'unit',app:{id:4},head_sha:f.H,status:'completed',conclusion:'failure'}]});
  const checks=await sourceTick(f.store);assert.ok(checks.state.subjects[0]!.changes.includes('conditions_changed'));assert.equal(checks.materials.items[0]!.packet,packet);assert.equal(checks.materials.items[0]!.changed,false);assert.equal(f.q.status().operations[0].result.receiver.currentMaterialMatches,true);
  await f.source.change({mode:'forbidden-comments'});await sourceTick(f.store);assert.equal(f.q.status().operations[0].result.receiver.currentMaterialMatches,false);
  await f.source.change({mode:'normal'});await sourceTick(f.store);assert.equal(f.q.status().operations[0].result.receiver.currentMaterialMatches,true);assert.equal((await runReception(f.path)).operation,done.operation);assert.equal(await f.count(),1);
});
test('ongoing shadow operation keeps its original input; a later tick applies the saved change after completion',async t=>{
  const f=await monitored(t);await sourceTick(f.store);const active=f.q.begin(f.item,'original'),packet=f.q.status().items[0].currentPacket;
  await f.source.change({body:'Updated requirement'});const waiting=await sourceTick(f.store);assert.deepEqual(waiting.materials.items[0]!.waiting,['original_execution_active_or_unknown']);assert.equal(f.q.status().items[0].currentPacket,packet);
  assert.equal(f.q.begin(f.item,'repeat').operation,active.operation);f.q.evaluate(active.operation);
  const resumed=await sourceTick(f.store);assert.equal(resumed.materials.items[0]!.changed,true);assert.notEqual(resumed.materials.items[0]!.packet,packet);assert.equal(await f.count(),0);
});
test('candidate changes during auth preflight stop actual dispatch without discarding the original claim',async t=>{
  const f=await monitored(t,'auth-delay');await sourceTick(f.store);const running=runReception(f.path);await waitPhase(f.q,'reserved');
  await f.source.change({H:'c'.repeat(40)});await sourceTick(f.store);const result=await running;
  assert.equal(result.status,'receiver_unknown');assert.equal(result.newTaskSent,false);assert.equal(await f.count(),0);assert.equal(f.q.status().claims.length,1);
});
test('SQL guards stop pre-opened old clients on unbound/expired source and preserve packet source lineage',async t=>{
  const f=await monitored(t),db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());const item=f.q.status().items[0];
  const insert=()=>db.prepare("INSERT INTO operations(id,item,packet,target,generation,run_ref,status,started_at) VALUES(?,?,?,?,1,'old-client','running',?)").run(randomUUID(),item.id,item.currentPacket,'fixture-target',new Date().toISOString());
  assert.throws(insert,/current_event_source_and_material_required/);await sourceTick(f.store);
  const p=db.prepare('SELECT * FROM packets WHERE id=(SELECT current_packet FROM items WHERE id=?)').get(item.id) as any,summary=JSON.parse(p.summary);delete summary.eventSources;
  assert.throws(()=>db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id,p.fingerprint,p.manifest_hash,p.report_hash,p.context_hash,JSON.stringify(summary),p.created_at),/event_material_lineage_required/);
  const key=eventStateKey('fixture/reception',1),state=JSON.parse((db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any).value);state.validUntilAt='2000-01-01T00:00:00Z';db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(state),key);
  assert.ok(f.q.begin(f.item,'expired').blocked.includes('source_candidate_changed_or_expired'));assert.equal(await f.count(),0);
});
