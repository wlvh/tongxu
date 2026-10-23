import test from 'node:test';
import assert from 'node:assert/strict';
import {monitored} from './backend-fixture.js';
import {SourceTickLoop} from '../../src/event-loop.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';

async function waitFor(check:()=>boolean){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error('fixture_tick_wait_expired');await new Promise(r=>setTimeout(r,10));}}
test('foreground caller discovers a change without a hint and stops without a new model or queue operation',async t=>{
  const f=await monitored(t),loop=await SourceTickLoop.load([{source:'selected',profileSha256:hash(canonical(f.source.profile)),maxTicks:4}],[{id:'selected',store:f.store,item:f.item}]);t.after(()=>loop.drain());
  const operations=f.q.status().operations;loop.start();await waitFor(()=>loop.state()[0]!.checksFinished>=1);
  const changed='f'.repeat(40);await f.source.change({H:changed});await waitFor(()=>f.q.events().status().subjects[0]!.currentResult?.candidate?.H===changed);
  await loop.drain();const stopped=await f.source.get(),state=loop.state()[0]!;assert.equal(state.active,false);assert.equal(state.accepting,false);assert.equal(state.nextCheckAt,null);assert.equal(state.modelTasksStarted,0);assert.equal(state.mergeRequestsSent,0);
  await new Promise(r=>setTimeout(r,60));assert.deepEqual(await f.source.get(),stopped);assert.deepEqual(f.q.status().operations,operations);assert.equal(await f.count(),0);
  assert.equal(f.q.status().events.filter((e:any)=>e.kind==='source_hint').length,0);
});
test('configured bound stops new ticks; reopening uses original source revisions without fabricating work',async t=>{
  const f=await monitored(t),selection=[{source:'selected',profileSha256:hash(canonical(f.source.profile)),maxTicks:1}],sources=[{id:'selected',store:f.store,item:f.item}],first=await SourceTickLoop.load(selection,sources);t.after(()=>first.drain());first.start();await waitFor(()=>first.state()[0]!.checksFinished===1);
  const original=f.q.events().status().subjects[0]!,operations=f.q.status().operations;assert.equal(first.state()[0]!.limitReached,true);assert.equal(first.state()[0]!.nextCheckAt,null);await first.drain();
  const next=await SourceTickLoop.load(selection,sources);t.after(()=>next.drain());next.start();await waitFor(()=>next.state()[0]!.checksFinished===1);await next.drain();
  assert.equal(f.q.events().status().subjects[0]!.revision,original.revision);assert.deepEqual(f.q.status().operations,operations);assert.equal(await f.count(),0);
  await assert.rejects(SourceTickLoop.load([{...selection[0]!,profileSha256:'a'.repeat(64)}],sources),/profile_changed/);await assert.rejects(SourceTickLoop.load([...selection,...selection],sources),/selection_invalid/);
});
