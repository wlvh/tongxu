import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {integrationFixture,raw} from './fixture.js';
import {IntegrationRecords} from '../../src/integration-store.js';
import {runIntegration} from '../../src/integration.js';
import {QueueStore} from '../../src/queue-store.js';
import {git} from '../../src/repair-workspace.js';
import {hash} from '../../src/snapshot.js';

test('actual Git builds only the selected combined candidate; failed prefix and author extra/staged work stay original',async t=>{
  const f=await integrationFixture(t),before=await f.authorState(),originalReport=await readFile(join(f.verification,'verification.json')),result=await runIntegration(f.store,f.path);assert.equal(result.phase,'produced');assert.ok('result' in result);assert.equal(result.newGitProcesses,result.result!.steps);assert.equal(result.newModelInputs,0);const artifact=result.result!,candidate=artifact.candidate,repo=join(result.directory,'candidate.git');
  assert.equal(candidate.B,f.B);assert.equal(candidate.T,f.packet.summary.tree);assert.equal(await git(repo,['show',candidate.H+':scale.json']),'1000');assert.equal(await git(repo,['show',candidate.H+':consumer.json']),'1000');await assert.rejects(git(repo,['show',candidate.H+':unselected-extra.txt']));await assert.rejects(git(repo,['show',candidate.H+':author-staged.txt']));assert.equal(await git(repo,['rev-list','--parents','-n','1',candidate.H]),candidate.H+' '+f.B);assert.deepEqual(await f.authorState(),before);assert.ok((await readFile(join(f.verification,'verification.json'))).equals(originalReport));assert.equal(artifact.requiresOwnValidation,true);assert.equal(artifact.requiresOwnReception,true);assert.equal(result.technicalAcceptanceGranted,false);assert.equal(result.targetUpdated,false);
  const saved=f.q.integrations().artifacts(f.request.id);assert.equal(hash(saved.bundle),artifact.bundleSha256);assert.equal(hash(saved.diff),artifact.diffSha256);assert.match(saved.diff.toString(),/scale.json/);assert.doesNotMatch(saved.diff.toString(),/unselected-extra|author-staged/);
  const queue=f.q.status(),again=await runIntegration(f.store,f.path);assert.equal(again.newGitProcesses,0);assert.equal(again.newModelInputs,0);assert.deepEqual(f.q.status(),queue);assert.equal((await QueueStore.observeIntegration(f.store,f.request.id)).result!.candidate.H,candidate.H);assert.equal((await f.count()),0);
});
test('a definitive Git failure ends with original captures; a corrected explicit request does not erase it',async t=>{
  const f=await integrationFixture(t),empty=join(f.root,'empty-object-source');await mkdir(empty,{mode:0o700});await git(empty,['init','--bare','--template=']);const bad={...f.request,id:'missing-objects',objects:empty},path=join(f.root,'bad-source.json');await writeFile(path,raw(bad));const failed=await runIntegration(f.store,path);assert.equal(failed.phase,'failed_ended');assert.ok('result' in failed);assert.equal(failed.result!.success,false);assert.equal(failed.result!.reason,'integration_git_step_failed');assert.equal(failed.newModelInputs,0);
  const queue=f.q.status();assert.equal((await runIntegration(f.store,path)).newGitProcesses,0);assert.deepEqual(f.q.status(),queue);const good=await runIntegration(f.store,f.path);assert.equal(good.phase,'produced');assert.equal(f.q.integrations().state(bad.id).phase,'failed_ended');assert.equal((await f.count()),0);
  assert.throws(()=>f.q.integrations().prepare(raw({...f.request,id:'manufacture-another-candidate'}),[]),/source_already_has_candidate/);
});
test('a stop arriving at the actual Git boundary produces a known refusal without starting that command',async t=>{
  const f=await integrationFixture(t),effect=IntegrationRecords.prototype.effect;let stopped=false;IntegrationRecords.prototype.effect=function(id,observations,call){if(!stopped){stopped=true;f.q.control(f.context.scope.id,'investment','stopped','explicit late-stop fixture');}return (effect as any).call(this,id,observations,call);};t.after(()=>{IntegrationRecords.prototype.effect=effect;});const result=await runIntegration(f.store,f.path);assert.equal(result.phase,'failed_ended');assert.ok('result' in result);assert.equal(result.result!.reason,'integration_effect_refused');assert.equal(result.newGitProcesses,0);assert.equal(result.targetUpdated,false);assert.equal((await f.count()),0);
});
test('completed Git captures survive consumer interruption and recover without reading the source checkout or running another command',async t=>{
  const f=await integrationFixture(t),complete=IntegrationRecords.prototype.complete;IntegrationRecords.prototype.complete=function(){throw new Error('explicit_consumer_interruption');};t.after(()=>{IntegrationRecords.prototype.complete=complete;});await assert.rejects(runIntegration(f.store,f.path),/explicit_consumer_interruption/);IntegrationRecords.prototype.complete=complete;assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');await rename(f.objects,join(f.root,'author-source-retained'));const restored=await runIntegration(f.store,f.path,'reconcile');assert.equal(restored.phase,'produced');assert.equal(restored.newGitProcesses,0);assert.equal(restored.newModelInputs,0);
});
test('an original start lacking execution captures stays unknown; new ids and close cannot make it unsent',async t=>{
  const f=await integrationFixture(t);f.q.integrations().prepare(raw(f.request),[]);f.q.integrations().start(f.request.id,[]);assert.throws(()=>f.q.integrations().prepare(raw({...f.request,id:'bypass-unknown'}),[]),/original_unresolved/);await assert.rejects(runIntegration(f.store,f.path,'reconcile'));await assert.rejects(runIntegration(f.store,f.path,'close-unstarted'),/original_started_or_closed/);assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');assert.equal((await f.count()),0);
});
test('source Git configuration is never loaded while packing fixed objects',async t=>{
  const f=await integrationFixture(t),config=join(f.objects,'.git/config'),original=await readFile(config),before=await f.authorState();
  // Deliberately invalid config belongs only to this isolated fixture. Any
  // Git command opening that Git directory would fail before doing its work.
  const invalid=Buffer.from('[invalid source configuration\n');await writeFile(config,invalid);
  const result=await runIntegration(f.store,f.path);assert.equal(result.phase,'produced');assert.ok((await readFile(config)).equals(invalid));
  await writeFile(config,original);assert.deepEqual(await f.authorState(),before);assert.equal((await f.count()),0);
});
test('a missing promised object fails locally without fetching or repairing the source repository',async t=>{
  const f=await integrationFixture(t),mirror=join(f.root,'local-promisor.git');await git(f.root,['clone','--bare','--no-hardlinks',f.objects,mirror]);
  await git(f.objects,['config','extensions.partialClone','fixture-promisor']);await git(f.objects,['config','remote.fixture-promisor.url',mirror]);await git(f.objects,['config','remote.fixture-promisor.promisor','true']);
  const missing=await git(f.objects,['rev-parse',f.A+':scale.json']),path=join(f.objects,'.git/objects',missing.slice(0,2),missing.slice(2));await access(path);await rm(path);
  const originalConfig=await readFile(join(f.objects,'.git/config')),before=await f.authorState(),result=await runIntegration(f.store,f.path);assert.equal(result.phase,'failed_ended');assert.ok('result' in result);assert.equal(result.result!.reason,'integration_git_step_failed');await assert.rejects(access(path));assert.ok((await readFile(join(f.objects,'.git/config'))).equals(originalConfig));assert.deepEqual(await f.authorState(),before);assert.equal((await f.count()),0);
});
