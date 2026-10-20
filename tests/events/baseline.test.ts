import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { monitored } from './backend-fixture.js';
import { sourceTick } from '../../src/event-tick.js';
import { packetSourceMaterial } from '../../src/event-gates.js';
import { eventMaterialHash,materialProjection } from '../../src/event-source.js';
import { hash } from '../../src/snapshot.js';
import { legacyEventGuards,eventGuards } from '../../src/event-gates.js';
import { randomUUID } from 'node:crypto';

test('intact complete W1 originals provide a material baseline; a missing page or changed blob cannot be reused',async t=>{
  const f=await monitored(t),db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());
  const rows=[['pr',{body:'original requirement'}],['pr_comments',[{id:3,user:{id:5},body:'counterexample'}]],['review_comments',[]],['reviews',[]]] as const;
  const artifacts=rows.map(([kind,value])=>{const bytes=Buffer.from(JSON.stringify(value)),sha256=hash(bytes);db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256,bytes);return {round:1,kind,sha256,status:200,page:1};});
  const manifest={rounds:[{number:1,current:true,gaps:[],coverage:Object.fromEntries(rows.map(([kind,value])=>[kind,{state:'complete',pages:1,records:Array.isArray(value)?value.length:1}]))}],artifacts};
  const expected=eventMaterialHash(materialProjection(rows[0][1],[...rows[1][1]],[],[],[]));assert.equal(packetSourceMaterial(db,manifest,[]),expected);
  const partial=structuredClone(manifest);partial.rounds[0]!.coverage.reviews!.state='partial';assert.equal(packetSourceMaterial(db,partial,[]),null);
  assert.equal(packetSourceMaterial(db,{...manifest,artifacts:artifacts.slice(0,-1)},[]),null);
  db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('damaged'),artifacts[0]!.sha256);assert.equal(packetSourceMaterial(db,manifest,[]),null);
});
test('a new complete W1 observation cannot bind an older source projection just because H and B match',async t=>{
  const f=await monitored(t);await sourceTick(f.store);const future=new Date(Date.now()+60000).toISOString();await f.packet({sourceAt:future,executionAt:future});
  const result=f.q.events().reconcilePackets();assert.ok(result.items[0]!.waiting.some((x:string)=>x.includes('source_candidate_changed_or_expired')));assert.ok(f.q.begin(f.item,'new-w1-old-source').blocked);assert.equal(await f.count(),0);
});
test('duplicate content advances the effective source watermark and both API and old SQL wait for a new source read',async t=>{
  const f=await monitored(t);await sourceTick(f.store);const before=f.q.status().items[0],source=f.q.events().status().subjects[0]!,at=new Date().toISOString();assert.ok(at>source.lastGoodAt);
  const imported=await f.packet({artifactIndex:1,sourceAt:at,executionAt:at});assert.equal(imported.duplicate,true);assert.equal(imported.currentPacket,before.currentPacket);
  assert.ok(f.q.events().reconcilePackets().items[0]!.waiting.length);assert.ok(f.q.begin(f.item,'duplicate-old-source').blocked);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{assert.throws(()=>db.prepare("INSERT INTO operations(id,item,packet,target,generation,run_ref,status,started_at) VALUES(?,?,?,?,1,'old-client','running',?)").run(randomUUID(),f.item,before.currentPacket,'fixture',at),/current_event_source_and_material_required/);}finally{db.close();}
  const refreshed=await sourceTick(f.store);assert.equal(refreshed.materials.items[0]!.changed,false);assert.equal(refreshed.materials.items[0]!.packet,before.currentPacket);assert.ok(f.q.begin(f.item,'after-refreshed-source').operation);assert.equal(await f.count(),0);
});
test('exact legacy source guards upgrade only while idle, clear old material bindings and retain all original observations',async t=>{
  const f=await monitored(t);await sourceTick(f.store);const db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());
  // These hashes came from the exact archived 629cd5b module, not the new generator.
  assert.deepEqual(legacyEventGuards.map(g=>hash(g.sql)),['8fe6195113d96b9060bed3ed8705239e66969605d29051928dc06006b39cad8a','1e48392b87eb807b60e10e8f5d9839d28ed97888004a464086c703e81c3fe43b','1ab316effdd6b477c126422386633ef4599d6dd6f5eb6eab62a40e1d1334f1e6','d1b9dd21b977ff01e5965f08fd3b3c6903501bd20fb666102116c89afbd841a2']);
  const installLegacy=()=>{for(const g of legacyEventGuards)db.exec('DROP TRIGGER '+g.name+';'+g.sql);};installLegacy();
  const original=f.q.events().status().subjects[0]!.originals,profile=Buffer.from(JSON.stringify(f.source.profile));
  assert.equal(f.q.events().configure(profile).upgraded,true);assert.deepEqual(f.q.events().status().subjects[0]!.originals,original);assert.ok(f.q.begin(f.item,'before-rebind').blocked);assert.equal(f.q.events().reconcilePackets().items[0]!.changed,false);
  const operation=f.q.begin(f.item,'original-active').operation;installLegacy();assert.throws(()=>f.q.events().configure(profile),/upgrade_requires_idle/);assert.equal(f.q.status().claims[0].operation,operation);
  f.q.evaluate(operation);assert.equal(f.q.events().configure(profile).upgraded,true);assert.equal(f.q.events().configure(profile).duplicate,true);
  db.exec('DROP TRIGGER '+eventGuards[0]!.name);assert.throws(()=>f.q.events().configure(profile),/guards_missing_or_unknown/);assert.equal(await f.count(),0);
});
