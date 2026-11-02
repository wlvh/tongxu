import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat,rename,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {integrationFixture,raw} from './fixture.js';
import {integrationAuthority} from './authority-fixture.js';
import {IntegrationRecords} from '../../src/integration-store.js';
import {runIntegration} from '../../src/integration.js';
import {integrationMain} from '../../src/integration-cli.js';
import {integrationPrivateState} from '../../src/integration-continuation.js';
import {hash} from '../../src/snapshot.js';

const options={skip:!process.env.TONGXU_TEST_DOCKER_CONFIG,timeout:120000};
async function paused(t:test.TestContext,governed=false,priorRuntime?:{version:string;execPath:string}){
  const f=await integrationFixture(t),owner=governed?await integrationAuthority(f):null,boundary=IntegrationRecords.prototype.boundary;let ended=false;
  IntegrationRecords.prototype.boundary=function(...args){const value=boundary.apply(this,args);if(!ended&&value.name==='006-merge-0'){ended=true;throw new Error('fixture_controller_returned_after_successful_boundary');}return value;};
  const oldVersion=Object.getOwnPropertyDescriptor(process,'version')!,oldPath=Object.getOwnPropertyDescriptor(process,'execPath')!;
  if(priorRuntime){Object.defineProperty(process,'version',{...oldVersion,value:priorRuntime.version});Object.defineProperty(process,'execPath',{...oldPath,value:priorRuntime.execPath});}
  try{await assert.rejects(runIntegration(f.store,f.path));}finally{IntegrationRecords.prototype.boundary=boundary;Object.defineProperty(process,'version',oldVersion);Object.defineProperty(process,'execPath',oldPath);}
  assert.equal(ended,true);const state=f.q.integrations().state(f.request.id);assert.equal(state.phase,'started_or_unknown');return {...f,owner,state,directory:state.directory};
}
async function captures(directory:string){const files:Record<string,unknown>={};const walk=async(path:string,relative='')=>{for(const name of (await readdir(path)).sort()){const full=join(path,name),key=relative+name,s=await stat(full);if(s.isDirectory())await walk(full,key+'/');else files[key]={sha256:hash(await readFile(full)),mtimeMs:s.mtimeMs};}};await walk(join(directory,'steps'));return files;}
function alteredPrefix(directory:string){const step=join(directory,'steps/000-git-version'),stdout=readFileSync(join(step,'stdout.bin')),exit=readFileSync(join(step,'exit.json')),changed=Buffer.concat([stdout,Buffer.from('explicit changed old capture\n')]);writeFileSync(join(step,'stdout.bin'),changed);writeFileSync(join(step,'exit.json'),raw({...JSON.parse(exit.toString()),stdoutSha256:hash(changed)}));return ()=>{writeFileSync(join(step,'stdout.bin'),stdout);writeFileSync(join(step,'exit.json'),exit);};}

test('MI05: same ended prefix continues only missing Git steps, preserving captures and the author checkout',options,async t=>{
  const f=await paused(t),before=await captures(f.directory),author=await f.authorState(),steps=await readdir(join(f.directory,'steps'));
  assert.equal(steps.length,7);await assert.rejects(runIntegration(f.store,f.path,'reconcile'));assert.deepEqual(await captures(f.directory),before);
  const retained=join(f.root,'retained-author-source');await rename(f.objects,retained);
  const result=await integrationMain(['continue-ended','--store',f.store,'--request',f.path]);await rename(retained,f.objects);
  assert.ok('recovery' in result&&'result' in result&&'reusedGitSteps' in result&&'newGitProcesses' in result&&'newModelInputs' in result);assert.equal(result.phase,'produced');assert.equal(result.recovery,'continued_verified_ended_prefix');assert.equal(result.reusedGitSteps,7);assert.equal(result.newGitProcesses,result.result!.steps-7);assert.equal(result.newModelInputs,0);assert.equal(result.result!.candidate.T,f.packet.summary.tree);assert.equal(result.directory,f.directory);
  const after=await captures(f.directory);for(const [name,value] of Object.entries(before))assert.deepEqual(after[name],value);assert.deepEqual(await f.authorState(),author);assert.equal(await f.count(),0);
  const queue=f.q.status(),again=await runIntegration(f.store,f.path,'continue-ended');assert.equal(again.newGitProcesses,0);assert.deepEqual(f.q.status(),queue);assert.deepEqual(await captures(f.directory),after);
});
test('Node upgrade and relocation preserve an ended integration prefix and record the actual new runtime',options,async t=>{
 const f=await paused(t,false,{version:'v24.0.0',execPath:'/explicit-fixture/previous-node'}),before=await captures(f.directory),producer=await readFile(join(f.directory,'producer.json'));
 assert.equal(JSON.parse(producer.toString()).node.version,'v24.0.0');
 const result=await runIntegration(f.store,f.path,'continue-ended');assert.equal(result.phase,'produced');assert.ok('reusedGitSteps' in result);assert.equal(result.reusedGitSteps,7);
 const attempts=await readdir(join(f.directory,'continuations'));assert.equal(attempts.length,1);const continued=JSON.parse(await readFile(join(f.directory,'continuations',attempts[0]!),'utf8'));
 assert.equal(continued.node.nodeVersion,process.version);assert.equal(continued.node.nodeExecutable,process.execPath);assert.equal(continued.node.minimumNodeVersion,'24.0.0');assert.deepEqual(await readFile(join(f.directory,'producer.json')),producer);
 const after=await captures(f.directory);for(const [name,value] of Object.entries(before))assert.deepEqual(after[name],value);
 const again=await runIntegration(f.store,f.path,'continue-ended');assert.equal(again.newGitProcesses,0);assert.equal(await f.count(),0);
});
test('MI05: active controller, changed private state, altered boundary, unknown child and partial capture refuse all new commands',options,async t=>{
  const f=await paused(t),steps=await readdir(join(f.directory,'steps')),producer=JSON.parse(await readFile(join(f.directory,'producer.json'),'utf8')),returned=join(f.directory,'controller-returns',producer.controllerId+'.json'),held=join(f.root,'held-controller-return.json');
  const refused=async(pattern:RegExp)=>{await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),pattern);assert.deepEqual(await readdir(join(f.directory,'steps')),steps);assert.equal(await f.count(),0);};
  await rename(returned,held);await refused(/controller_active_or_unknown/);await rename(held,returned);
  const extra=join(f.directory,'candidate.git/unaccounted.txt');await writeFile(extra,'explicit unaccounted fixture state\n');await refused(/private_state_changed/);
  const boundaryPath=join(f.directory,'boundaries/006-merge-0.json'),boundary=await readFile(boundaryPath),changed={...JSON.parse(boundary.toString()),state:await integrationPrivateState(f.directory)};await writeFile(boundaryPath,raw(changed));await refused(/original_boundary_changed/);await writeFile(boundaryPath,boundary);await rm(extra);
  const step=join(f.directory,'steps/006-merge-0'),processPath=join(step,'process.json'),exitPath=join(step,'exit.json'),processBytes=await readFile(processPath),exitBytes=await readFile(exitPath),alive=raw({...JSON.parse(processBytes.toString()),pid:process.pid,processGroup:process.pid});await writeFile(processPath,alive);await writeFile(exitPath,raw({...JSON.parse(exitBytes.toString()),processSha256:hash(alive)}));await refused(/child_active_or_unknown/);await writeFile(processPath,processBytes);await writeFile(exitPath,exitBytes);
  const heldExit=join(f.root,'held-exit.json');await rename(exitPath,heldExit);await refused(/ENOENT/);await rename(heldExit,exitPath);
  const future=join(f.directory,'steps/999-unregistered');await mkdir(future);await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/unexplained_step/);await rm(future,{recursive:true});
  const result=await runIntegration(f.store,f.path,'continue-ended');assert.ok('result' in result);assert.equal(result.phase,'produced');assert.equal(result.newGitProcesses,result.result!.steps-7);
});
test('MI05: a stop preserves the original partial candidate and reopening allows that same ended request to continue',options,async t=>{
  const f=await paused(t),before=await captures(f.directory);f.q.control(f.context.scope.id,'investment','stopped','explicit stop before continuation');await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/new_investment_stopped/);assert.deepEqual(await captures(f.directory),before);assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');
  f.q.control(f.context.scope.id,'investment','open','explicit same-request resume');const result=await runIntegration(f.store,f.path,'continue-ended');assert.ok('reusedGitSteps' in result&&'result' in result);assert.equal(result.phase,'produced');assert.equal(result.reusedGitSteps,7);assert.equal(result.newGitProcesses,result.result!.steps-7);assert.equal(await f.count(),0);
});
test('MI05: a newly observed member version prevents continuing the obsolete integration request',options,async t=>{
  const f=await paused(t),before=await captures(f.directory);await f.addPacket({pr:10,H:f.A3,sourceAt:new Date(Date.now()+60000).toISOString()});await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/source_not_current|source_packet_changed/);assert.deepEqual(await captures(f.directory),before);assert.equal(await f.count(),0);
});
test('MI05: private state changed after the continuation probe is rejected at the first actual spawn',options,async t=>{
  const f=await paused(t),effect=IntegrationRecords.prototype.effect;let injected=false;const fs=await import('node:fs');
  IntegrationRecords.prototype.effect=function(id,observations,call){if(!injected){injected=true;fs.writeFileSync(join(f.directory,'candidate.git/unaccounted-after-probe'),'explicit late fixture change\n');}return (effect as any).call(this,id,observations,call);};t.after(()=>{IntegrationRecords.prototype.effect=effect;});
  const result=await runIntegration(f.store,f.path,'continue-ended');assert.equal(injected,true);assert.equal(result.phase,'failed_ended');assert.equal(result.newGitProcesses,0);assert.ok('result' in result);assert.equal(result.result!.reason,'integration_effect_refused');const pending=join(f.directory,'steps/007-prefix-0');await assert.rejects(readFile(join(pending,'process.json')));const refusal=JSON.parse(await readFile(join(pending,'not-started.json'),'utf8'));assert.equal(refusal.spawnInvoked,false);assert.equal(refusal.reason,'integration_continuation_private_state_changed');assert.equal(await f.count(),0);
});
test('MI05: an exact existing grant continues the original consumer without another authority reservation',options,async t=>{
  const f=await paused(t,true),bindings=f.q.status().events.filter((e:any)=>e.kind==='integration_authority_bound');assert.equal(bindings.length,1);
  const result=await runIntegration(f.store,f.path,'continue-ended');assert.equal(result.phase,'produced');assert.ok('reusedGitSteps' in result);assert.equal(result.reusedGitSteps,7);assert.deepEqual(f.q.status().events.filter((e:any)=>e.kind==='integration_authority_bound'),bindings);assert.equal(await f.count(),0);
});
test('MI05: revocation of the original exact grant blocks the pending tail without rewriting the preserved prefix',options,async t=>{
  const f=await paused(t,true),before=await captures(f.directory);await f.owner!.adopt({kind:'revoke',decision:f.owner!.confirmation.sha});await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/revoked/);assert.deepEqual(await captures(f.directory),before);assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');assert.equal(await f.count(),0);
});
test('MIC-F01: changed prefix capture after admission cannot replace the issued proof; restoring originals continues the same request',options,async t=>{
  const f=await paused(t),admit=IntegrationRecords.prototype.continueEnded,steps=await readdir(join(f.directory,'steps'));let restore:(()=>void)|undefined;
  IntegrationRecords.prototype.continueEnded=function(...args){const value=admit.apply(this,args);if(!restore)restore=alteredPrefix(f.directory);return value;};t.after(()=>{IntegrationRecords.prototype.continueEnded=admit;});
  await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/boundary_capture_changed/);assert.ok(restore);assert.deepEqual(await readdir(join(f.directory,'steps')),steps);assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');restore();IntegrationRecords.prototype.continueEnded=admit;
  const recovered=await runIntegration(f.store,f.path,'continue-ended');assert.equal(recovered.phase,'produced');assert.ok('reusedGitSteps' in recovered);assert.equal(recovered.reusedGitSteps,7);assert.equal(await f.count(),0);
});
test('MIC-F01: old capture changed at the first new spawn is refused even with a self-consistent changed exit',options,async t=>{
  const f=await paused(t),effect=IntegrationRecords.prototype.effect;let restore:(()=>void)|undefined;
  IntegrationRecords.prototype.effect=function(id,observations,call){if(!restore)restore=alteredPrefix(f.directory);return (effect as any).call(this,id,observations,call);};t.after(()=>{IntegrationRecords.prototype.effect=effect;});
  await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/boundary_capture_changed/);const step=join(f.directory,'steps/007-prefix-0');await assert.rejects(readFile(join(step,'process.json')));const refusal=JSON.parse(await readFile(join(step,'not-started.json'),'utf8'));assert.equal(refusal.spawnInvoked,false);assert.equal(refusal.reason,'integration_continuation_prefix_capture_changed');assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');restore!();assert.equal(await f.count(),0);
});
test('MIC-F01: final capture replay binds each original step to its recorded boundary before completing',options,async t=>{
  const f=await paused(t),boundary=IntegrationRecords.prototype.boundary;let restore:(()=>void)|undefined;
  IntegrationRecords.prototype.boundary=function(...args){const value=boundary.apply(this,args);if(value.name==='018-bundle-verify'&&!restore)restore=alteredPrefix(f.directory);return value;};t.after(()=>{IntegrationRecords.prototype.boundary=boundary;});
  await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/boundary_capture_changed/);assert.ok(restore);assert.equal((await readdir(join(f.directory,'steps'))).length,19);assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');restore();IntegrationRecords.prototype.boundary=boundary;
  const recovered=await runIntegration(f.store,f.path,'reconcile');assert.equal(recovered.phase,'produced');assert.equal(recovered.newGitProcesses,0);assert.equal(await f.count(),0);
});
test('MIC-F01: an anchored success cannot turn into failed or not-started; exact originals restore the same request',options,async t=>{
  const f=await paused(t),admit=IntegrationRecords.prototype.continueEnded,step=join(f.directory,'steps/000-git-version'),boundaryPath=join(f.directory,'boundaries/000-git-version.json');
  const exit=await readFile(join(step,'exit.json')),process=await readFile(join(step,'process.json')),boundary=await readFile(boundaryPath),before=await readdir(join(f.directory,'steps'));
  t.after(()=>{IntegrationRecords.prototype.continueEnded=admit;});
  for(const variant of ['changed-exit','false-not-started','moved-boundary']){
    let changed=false;
    IntegrationRecords.prototype.continueEnded=function(...args){const value=admit.apply(this,args);changed=true;
      if(variant==='false-not-started'){unlinkSync(join(step,'process.json'));unlinkSync(join(step,'exit.json'));writeFileSync(join(step,'not-started.json'),raw({spawnInvoked:false,reason:'explicit_disguised_old_success_fixture'}));}
      else {writeFileSync(join(step,'exit.json'),raw({...JSON.parse(exit.toString()),code:1}));
        if(variant==='moved-boundary'){writeFileSync(join(f.directory,'boundaries/retained-original.json'),boundary);writeFileSync(boundaryPath,raw({...JSON.parse(boundary.toString()),stepSha256:'0'.repeat(64)}));}
      }return value;
    };
    await assert.rejects(runIntegration(f.store,f.path,'continue-ended'),/integration_boundary_capture_changed/);assert.equal(changed,true);
    assert.equal(f.q.integrations().state(f.request.id).phase,'started_or_unknown');assert.deepEqual(await readdir(join(f.directory,'steps')),before);
    assert.throws(()=>f.q.integrations().prepare(raw({...f.request,id:'bypass-'+variant}),[]),/integration_original_unresolved/);
    await writeFile(join(f.root,'classification-'+variant+'.json'),raw({explicitFaultFixture:true,variant,phase:f.q.integrations().state(f.request.id).phase,newGitProcesses:0,newModelInputs:0,currentExit:variant==='false-not-started'?null:JSON.parse(await readFile(join(step,'exit.json'),'utf8')),boundarySha256:hash(await readFile(boundaryPath)),originalBoundarySha256:hash(boundary)}));
    await writeFile(join(step,'exit.json'),exit);await writeFile(join(step,'process.json'),process);await writeFile(boundaryPath,boundary);
    await rm(join(step,'not-started.json'),{force:true});await rm(join(f.directory,'boundaries/retained-original.json'),{force:true});IntegrationRecords.prototype.continueEnded=admit;
  }
  const restored=await runIntegration(f.store,f.path,'continue-ended');assert.equal(restored.phase,'produced');assert.equal(restored.newGitProcesses,12);assert.ok('reusedGitSteps' in restored);assert.equal(restored.reusedGitSteps,7);
  assert.equal((await runIntegration(f.store,f.path,'continue-ended')).newGitProcesses,0);assert.equal(await f.count(),0);
});
