import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from './session-source-fixture.js';
import { readExactCodexSession,requireSessionObservation,replaySessionRead,parseSessionReadSpec } from '../../src/session-source.js';

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
test('first exact thread lookup discovers unknown session and workspace; known expectations still match strictly',async t=>{
  const f=await fixture(t);
  for(const [i,expected] of [{sessionId:null,workspace:null},{sessionId:f.spec.sessionId,workspace:null},{sessionId:null,workspace:f.spec.workspace}].entries()){
    const spec={...f.spec,...expected},directory=join(f.root,`discover-${i}`),o=await readExactCodexSession(spec,directory);
    assert.equal(o.metadata?.sessionId,f.spec.sessionId);assert.equal(o.metadata?.workspace,f.spec.workspace);assert.equal(o.controlPermissionGranted,false);assert.equal(o.modelRequestsSent,0);
    assert.deepEqual((await replaySessionRead(spec,directory)).metadata,o.metadata);assert.deepEqual(o.spec,spec);
  }
  for(const [i,expected] of [{sessionId:'wrong-known',workspace:null},{sessionId:null,workspace:'/different-known'}].entries()){
    const o=await readExactCodexSession({...f.spec,...expected},join(f.root,`mismatch-${i}`));assert.equal(o.metadata,null);assert.equal(o.gap,'native_session_metadata_identity_mismatch');
  }
  const {sessionId:_,...missing}=f.spec;assert.throws(()=>parseSessionReadSpec(Buffer.from(JSON.stringify(missing))),/spec_invalid/);
});
test('unknown expectations never permit wrong thread or malformed returned identity',async t=>{
  for(const mode of ['wrong-thread','invalid-session','relative-workspace']){
    const f=await fixture(t,mode),o=await readExactCodexSession({...f.spec,sessionId:null,workspace:null},join(f.root,'read'));
    assert.equal(o.metadata,null);assert.equal(o.gap,'native_session_metadata_identity_mismatch');assert.equal(o.controlPermissionGranted,false);
  }
});
