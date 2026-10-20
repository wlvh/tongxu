import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from './session-source-fixture.js';
import { readExactCodexSession,requireSessionObservation } from '../../src/session-source.js';

test('actual readonly child observes only the specified session; old creation version and idle status grant no control',async t=>{
  const f=await fixture(t),o=await readExactCodexSession(f.spec,join(f.root,'read'));
  assert.equal(requireSessionObservation(o,f.spec).metadata?.threadId,'fixture-thread');assert.equal(o.metadata?.createdWithVersion,'0.134.0');assert.equal(o.reader.version,'codex-cli 0.163.0-alpha.10.2');assert.equal(o.metadata?.capabilities.resume,'not_verified');assert.equal(o.controlPermissionGranted,false);assert.equal(o.modelRequestsSent,0);
  const sent=o.originals['stdin.ndjson']!.toString().trim().split('\n').map(s=>JSON.parse(s));assert.deepEqual(sent.map(s=>s.method),['initialize','initialized','thread/read']);assert.deepEqual(sent.at(-1).params,{threadId:'fixture-thread',includeTurns:false});
  assert.throws(()=>requireSessionObservation({...o},f.spec),/actual_current_session_read_required/);o.originals['stdout.ndjson']!.fill(32);assert.throws(()=>requireSessionObservation(o,f.spec),/actual_current_session_read_required/);
});
test('missing original or wrong session keeps full read failure and never starts a replacement',async t=>{
  for(const mode of ['missing','wrong-thread']){const f=await fixture(t,mode),o=await readExactCodexSession(f.spec,join(f.root,'read'));assert.equal(o.metadata,null);assert.ok(o.gap);assert.equal(o.modelRequestsSent,0);assert.ok(o.originals['stdout.ndjson']!.length);assert.ok(!o.originals['stdin.ndjson']!.toString().includes('thread/start'));assert.equal(requireSessionObservation(o,f.spec).gap,o.gap);}
});
test('changed executable or reused output fails before a new session read',async t=>{
  const f=await fixture(t);await assert.rejects(readExactCodexSession({...f.spec,executableSha256:'0'.repeat(64)},join(f.root,'wrong-executable')),/executable_changed/);
  await readExactCodexSession(f.spec,join(f.root,'original'));await assert.rejects(readExactCodexSession(f.spec,join(f.root,'original')));
});
