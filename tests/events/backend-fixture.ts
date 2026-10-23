import type test from 'node:test';
import { setup } from '../w3/receiver-fixture.js';
import { sourceFixture } from './source-fixture.js';
export async function monitored(t:test.TestContext,mode='complete'){
  const f=await setup(t,mode),source=await sourceFixture(t,'fixture/reception');f.q.enableSupplements();
  const candidate=f.q.status().items[0].candidate;await source.change({H:candidate.H,B:candidate.B,target:candidate.targetRef});
  f.q.events().configure(Buffer.from(JSON.stringify(source.profile)));return {...f,source};
}
