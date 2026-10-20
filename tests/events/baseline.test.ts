import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { monitored } from './backend-fixture.js';
import { sourceTick } from '../../src/event-tick.js';
import { packetSourceMaterial } from '../../src/event-gates.js';
import { eventMaterialHash,materialProjection } from '../../src/event-source.js';
import { hash } from '../../src/snapshot.js';

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
