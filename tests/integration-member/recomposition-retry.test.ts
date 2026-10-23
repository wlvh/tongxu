import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {governedRecompositionFixture,freshOwner} from './governed-recomposition-fixture.js';
import {runMemberRecomposition} from '../../src/member-recomposition.js';
import {recompositionTestPayloadSha} from '../../src/recomposition-test-contract.js';
import {memberRecompositionDirectory,type MemberRecompositionPlan} from '../../src/member-recomposition-contract.js';
import {prepareResourceRequest} from '../../src/resource-claims.js';
import {DockerRuntime} from '../../src/docker-sandbox.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {raw} from '../integration/fixture.js';
type Fixture=Awaited<ReturnType<typeof governedRecompositionFixture>>;

async function failKnown(f:Fixture,path:string,plan:MemberRecompositionPlan){
  const original=DockerRuntime.prototype.run;let stopped=false,executionPath='';
  DockerRuntime.prototype.run=function(o){const gate=o.startGate;if(gate?.start&&!o.directory.endsWith('/probe')){const start=gate.start;o={...o,startGate:{...gate,start:effect=>{if(!stopped){stopped=true;executionPath=join(o.directory,'execution.json');f.q.control(f.context.scope.id,'investment','stopped','Explicit fixture: stop before the first test tool');}return start(effect);}}};}return original.call(this,o);};
  try{await assert.rejects(runMemberRecomposition(path),/member_recomposition_original_verification_incomplete|member_recomposition_stopped|owner_action_stopped/);}finally{DockerRuntime.prototype.run=original;}
  assert.equal(stopped,true);const state=f.q.recompositionTests().state(plan.id);assert.equal(state.phase,'recorded');assert.equal(state.result.usableForTransfer,false);assert.equal(state.result.terminalExecutionProven,true);assert.ok(state.resultSha256);assert.equal(f.q.resources().settledOutcome(plan.governance!.testResourceRequests[0]!),true);f.q.control(f.context.scope.id,'investment','open','Explicit fixture: resume new investment after the known ended test');return {state,executionPath};
}
async function authorizeRetry(f:Fixture,previous:MemberRecompositionPlan,id:string,change?:(p:MemberRecompositionPlan)=>void){
  const old=f.q.recompositionTests().state(previous.id),plan:MemberRecompositionPlan={...previous,id,retry:{previous:previous.id,resultSha256:old.resultSha256!,source:'Explicit fixture: known failed original checked; a separate bounded retry is authorized'},governance:{...previous.governance!,testAuthorityIntent:id+'-test',testResourceRequests:[],integrationAuthorityIntent:id+'-integration'}};change?.(plan);
  const request={...f.testRequest,payloadSha256:recompositionTestPayloadSha(plan)},confirmation=await f.owner.adopt({kind:'confirm_action',adoption:f.owner.scope.sha,performerRole:'background',request,expiresAt:new Date(Date.now()+3600000).toISOString()}),action=f.owner.a.reserveAction(plan.governance!.testAuthorityIntent,request,'background',confirmation.sha,await freshOwner(f.owner,confirmation.sha,f.root)),resource={...f.owner.resource,authorityIntent:plan.governance!.testAuthorityIntent,role:'background' as const,actionSha256:action.requestSha256},prepared=await prepareResourceRequest(f.store,raw(resource),'background');plan.governance!.testResourceRequests=[prepared.id];const path=join(f.root,id+'.json');await writeFile(path,raw(plan));return {plan,path,resourceId:prepared.id};
}

test('known failed original yields one newly authorized retry; active original controller is respected and old evidence remains',async t=>{
  const f=await governedRecompositionFixture(t),trace=await readFile(f.model.trace),author=await f.authorState(),failed=await failKnown(f,f.recompositionPath,f.recompositionPlan),oldRequest=await readFile(join(failed.state.directory,'request.json')),oldReport=await readFile(join(failed.state.directory,'verification/verification.json')),retry=await authorizeRetry(f,f.recompositionPlan,'retry-after-known-stop');
  const controller=new DatabaseSync(join(failed.state.directory,'controller.sqlite'));controller.exec('BEGIN IMMEDIATE');try{await assert.rejects(runMemberRecomposition(retry.path),/retry_original_controller_active/);assert.equal(f.ledger.state().claims.length,2);}finally{controller.exec('ROLLBACK');controller.close();}
  const invoke=async()=>{const child=spawn(process.execPath,[new URL('../../src/integration-member-cli.js',import.meta.url).pathname,'recompose','--plan',retry.path],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const [code,signal]=await once(child,'close');return {code,signal,stdout,stderr};},calls=await Promise.all([invoke(),invoke()]);await writeFile(join(f.root,'concurrent-retry-cli.json'),raw(calls));const successful=calls.filter(c=>c.code===0);assert.ok(successful.length>=1,JSON.stringify(calls));const result=JSON.parse(successful[0]!.stdout);assert.equal(result.phase,'new_integration_candidate_requires_own_reception');assert.notEqual(result.directory,failed.state.directory);assert.equal(result.directory,memberRecompositionDirectory(retry.plan));const next=f.q.recompositionTests().state(retry.plan.id);assert.equal(next.attempt,2);assert.equal(next.retry?.previous,f.recompositionPlan.id);assert.equal(next.result.usableForTransfer,true);assert.equal(f.ledger.state().claims.length,3);assert.equal(f.ledger.state().settlements.length,3);assert.ok((await readFile(join(failed.state.directory,'request.json'))).equals(oldRequest));assert.ok((await readFile(join(failed.state.directory,'verification/verification.json'))).equals(oldReport));assert.equal(f.q.recompositionTests().state(f.recompositionPlan.id).resultSha256,failed.state.resultSha256);assert.ok((await readFile(f.model.trace)).equals(trace));assert.deepEqual(await f.authorState(),author);
  const again=await runMemberRecomposition(retry.path);assert.ok('newGitProcesses'in again);assert.equal(again.newGitProcesses,0);assert.equal(again.newModelInputs,0);assert.equal(f.ledger.state().claims.length,3);assert.equal(f.ledger.state().settlements.length,3);await writeFile(join(f.root,'retry-verification.json'),raw({failed:failed.state,retry:next,result,again,oldRequestSha256:hash(oldRequest),oldReportSha256:hash(oldReport),originalModelTraceUnchanged:true,realModelInputs:0}));
});

test('incorrect result, old authority and unresolved original capture do not start a replacement attempt',async t=>{
  const f=await governedRecompositionFixture(t),failed=await failKnown(f,f.recompositionPath,f.recompositionPlan),bad=await authorizeRetry(f,f.recompositionPlan,'wrong-result',p=>{p.retry!.resultSha256='0'.repeat(64);});await assert.rejects(runMemberRecomposition(bad.path),/retry_known_failed_original_required/);assert.equal(f.ledger.state().claims.length,2);
  const borrowed={...bad.plan,id:'borrowed-test',retry:{...bad.plan.retry!,resultSha256:failed.state.resultSha256!},governance:f.recompositionPlan.governance};const path=join(f.root,'borrowed.json');await writeFile(path,raw(borrowed));await assert.rejects(runMemberRecomposition(path),/exact_authority_mismatch/);assert.equal(f.ledger.state().claims.length,2);
  const wrongResource=await authorizeRetry(f,f.recompositionPlan,'borrowed-resource');wrongResource.plan.governance!.testResourceRequests=[f.testResource];await writeFile(wrongResource.path,raw(wrongResource.plan));await assert.rejects(runMemberRecomposition(wrongResource.path),/original_resource_mismatch/);assert.equal(f.ledger.state().claims.length,2);
  const valid=await authorizeRetry(f,f.recompositionPlan,'restored-original'),original=await readFile(failed.executionPath);await writeFile(failed.executionPath,raw({...JSON.parse(original.toString()),phase:'running',cleanup:'unknown',clientPid:process.pid}));try{await assert.rejects(runMemberRecomposition(valid.path),/w2_|recomposition_.*capture/);assert.equal(f.ledger.state().claims.length,2);assert.throws(()=>f.q.recompositionTests().state(valid.plan.id),/not_prepared/);}finally{await writeFile(failed.executionPath,original);}
  const done=await runMemberRecomposition(valid.path);assert.equal(done.phase,'new_integration_candidate_requires_own_reception');assert.equal(f.ledger.state().claims.length,3);assert.equal(f.ledger.state().settlements.length,3);
});

test('retry investment stop and revoked new authority leave original resources intact; a new exact permission may proceed',async t=>{
  const f=await governedRecompositionFixture(t);await failKnown(f,f.recompositionPath,f.recompositionPlan);const stopped=await authorizeRetry(f,f.recompositionPlan,'stopped-retry');f.q.control(f.context.scope.id,'investment','stopped','Explicit fixture stops new retry investment');await assert.rejects(runMemberRecomposition(stopped.path),/stopped/);assert.equal(f.ledger.state().claims.length,2);f.q.control(f.context.scope.id,'investment','open','Explicit fixture resumes new investment only');
  const action=f.owner.a.reservedAction(stopped.plan.governance!.testAuthorityIntent);await f.owner.adopt({kind:'revoke',decision:action.authorization});await assert.rejects(runMemberRecomposition(stopped.path),/revoked|authorization|decision|grant/);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);
  const fresh=await authorizeRetry(f,f.recompositionPlan,'new-permitted-retry');assert.equal((await runMemberRecomposition(fresh.path)).phase,'new_integration_candidate_requires_own_reception');assert.equal(f.ledger.state().claims.length,3);assert.equal(f.ledger.state().settlements.length,3);
});

test('the original retry chain permits at most three attempts and never forks an earlier failure',async t=>{
  const f=await governedRecompositionFixture(t),ledger=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite'));ledger.prepare('UPDATE capacity SET n=10').run();ledger.close();let plan=f.recompositionPlan,path=f.recompositionPath;
  await failKnown(f,path,plan);const second=await authorizeRetry(f,plan,'attempt-two');await failKnown(f,second.path,second.plan);
  const fork=await authorizeRetry(f,plan,'fork-original');await assert.rejects(runMemberRecomposition(fork.path),/retry_latest_original_required/);assert.equal(f.ledger.state().claims.length,3);
  const third=await authorizeRetry(f,second.plan,'attempt-three');await failKnown(f,third.path,third.plan);assert.equal(f.q.recompositionTests().state(third.plan.id).attempt,3);const fourth=await authorizeRetry(f,third.plan,'attempt-four');await assert.rejects(runMemberRecomposition(fourth.path),/retry_attempt_limit/);assert.equal(f.ledger.state().claims.length,4);assert.equal(f.ledger.state().settlements.length,4);assert.equal(f.q.recompositionTests().state(plan.id).attempt,1);
});
