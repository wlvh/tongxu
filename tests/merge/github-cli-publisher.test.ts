import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runGitHubCliCommand,githubCliProductionRequest,parseGitHubCliPublisherConfig} from '../../src/github-cli-publisher.js';
import {prepareGitHubCliPublisher} from '../../src/github-cli-publisher-install.js';
import {callMergeProvider,mergeCommand,readMergeProviderCapture} from '../../src/merge-provider.js';
import {managedMergeAction} from '../../src/managed-merge.js';
import {publisherFixture} from './provider-fixture.js';
import {cliPublisherFixture} from './github-cli-fixture.js';
import {ready,rulesetOnly} from './fixture.js';
import type {ManagedMergeBinding} from '../../src/merge-contract.js';

const binding:ManagedMergeBinding={schemaVersion:1,operation:'00000000-0000-4000-8000-000000000001',item:'a'.repeat(64),packet:1,repository:'fixture/reception',repositoryId:99,pr:1,H:'a'.repeat(40),B:'b'.repeat(40),targetRef:'main',T:'c'.repeat(40),receptionOperation:'00000000-0000-4000-8000-000000000001',judgmentId:'fixture',receptionBindingHash:'b'.repeat(64),authorityIntent:'fixture-permission',resourceRequests:['c'.repeat(64)],scope:{id:'fixture',version:'1',bodySha256:'d'.repeat(64)},arrangement:{id:'fixture',version:'1'},subjectSha256:null,integrationReference:null,method:'merge'};
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
async function scan(directory:string,secret:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    if(entry.isDirectory())await scan(path,secret);
    else if(entry.isFile())assert.ok(!(await readFile(path)).includes(Buffer.from(secret)),path);
  }
}
test('existing gh child supplies one command token and the bounded adapter reads GraphQL and sends one exact merge',async t=>{
  const business=await publisherFixture(t,binding),cli=await cliPublisherFixture(t,business,binding);
  const cap=await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'capabilities')),cli.runtime);
  assert.equal(cap.result.kind,'capabilities');if(cap.result.kind!=='capabilities')return;
  assert.equal(cap.result.actorId,33);assert.equal(cap.result.credentialState,'available');assert.equal(cap.result.identity,'fixture');assert.equal(cli.requests.length,2);
  assert.equal((await cli.calls()).length,1);
  const policy=await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'read',{kind:'review_policy'})),cli.runtime);assert.equal(policy.result.kind,'http');assert.ok(business.requests.some(r=>r.method==='POST'&&r.path==='/graphql'));
  await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'merge')),cli.runtime);
  assert.equal(business.state().merges,1);assert.equal(business.requests.filter(r=>r.method==='PUT').length,1);assert.ok(cli.requests.every(r=>r.tokenMatches));
  const paged=await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'read',{kind:'reviews'})),{...cli.runtime,request:async request=>{const response=await cli.runtime.request(request);if(request.path.includes('/reviews?'))response.headers.link='<https://api.github.com/repos/fixture/reception/pulls/1/reviews?per_page=100&page=2>; rel="next"';return response;}});
  if(paged.result.kind==='http')assert.equal(paged.result.nextPage,true);
  const calls=await cli.calls();assert.equal(calls.length,4);for(const call of calls){assert.deepEqual(call.args,['auth','token','--hostname','github.com']);assert.ok(call.environment.includes('GH_CONFIG_DIR'));assert.ok(!call.environment.some((name:string)=>/TOKEN|API_KEY|SSH|HOME|GH_DEBUG/.test(name)));}
  assert.ok(!JSON.stringify([cap,policy,cli.requests,business.requests]).includes(cli.token));await scan(business.root,cli.token);
});
test('token changes in the login source after authentication cannot change the token within the original command',async t=>{
  const business=await publisherFixture(t,binding),cli=await cliPublisherFixture(t,business,binding);cli.setMode('rotate-after-token');
  const result=await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'read',{kind:'pr'})),cli.runtime);assert.equal(result.result.kind,'http');assert.ok(cli.requests.every(r=>r.tokenMatches));assert.equal((await cli.calls()).length,1);
});
test('scope actor type repository and admin or push gaps cannot grant capability or reach a PUT',async t=>{
  const business=await publisherFixture(t,binding),cli=await cliPublisherFixture(t,business,binding);
  for(const mode of ['wrong-actor','wrong-type','missing-scope','public-scope','no-scope-header','wrong-repository','not-admin','not-push']){
    cli.setMode(mode);const cap=await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'capabilities')),cli.runtime);
    assert.equal(cap.result.kind,'capabilities');if(cap.result.kind==='capabilities')assert.equal(cap.result.credentialState,'unavailable',mode);
    await assert.rejects(runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'merge')),cli.runtime));
  }
  assert.equal(business.requests.filter(r=>r.method==='PUT').length,0);await scan(business.root,cli.token);
});
test('gh failure stderr token limits directory permissions and current program changes stay bounded and private',async t=>{
  const business=await publisherFixture(t,binding),cli=await cliPublisherFixture(t,business,binding),messages:string[]=[];
  const runtime={...cli.runtime,report:(code:string)=>messages.push(code)};
  for(const mode of ['token-error','token-spam','token-whitespace','token-timeout','program-change']){
    await cli.setGhMode(mode);const cap=await runGitHubCliCommand({...cli.config,timeoutMs:1000},bytes(mergeCommand(binding,'capabilities')),runtime);
    if(cap.result.kind==='capabilities')assert.equal(cap.result.credentialState,'unavailable',mode);
  }
  assert.equal(cli.requests.length,0);assert.ok(!messages.join().includes(cli.token));
  await cli.setGhMode('normal');await chmod(cli.config.ghConfigDir,0o777);
  const cap=await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'capabilities')),runtime);if(cap.result.kind==='capabilities')assert.equal(cap.result.credentialState,'unavailable');assert.equal(cli.requests.length,0);
  await scan(business.root,cli.token);
  await chmod(cli.config.ghConfigDir,0o751);
  const upgraded=await runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'capabilities')),runtime);
  if(upgraded.result.kind==='capabilities')assert.equal(upgraded.result.credentialState,'available');
});
test('fixed API transport refuses foreign origins redirects and streamed oversize bodies without following or retrying',async t=>{
  let mode='redirect',cancelled=false;
  const mocked=t.mock.method(globalThis,'fetch',async()=>mode==='redirect'?new Response('{}',{status:307,headers:{Location:'https://unrelated.invalid'}}):new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5*1024*1024));},cancel(){cancelled=true;}})));
  const request={method:'PUT' as const,path:'/repos/fixture/reception/pulls/1/merge',authorization:'explicit-unit-only',body:'{}',signal:AbortSignal.timeout(1000)};
  await assert.rejects(githubCliProductionRequest({...request,path:'//unrelated.invalid'}),/request_invalid/);assert.equal(mocked.mock.callCount(),0);
  await assert.rejects(githubCliProductionRequest(request),/redirect_refused/);assert.equal(mocked.mock.callCount(),1);
  mode='large';await assert.rejects(githubCliProductionRequest(request),/response_limit/);assert.equal(mocked.mock.callCount(),2);assert.equal(cancelled,true);
});
test('pre-PUT redirect timeout oversize and every final candidate binding change cause zero PUT',async t=>{
  const business=await publisherFixture(t,binding),cli=await cliPublisherFixture(t,business,binding);
  for(const mode of ['before-redirect','before-timeout','before-large']){
    cli.setMode(mode);await assert.rejects(runGitHubCliCommand({...cli.config,timeoutMs:1000},bytes(mergeCommand(binding,'merge')),cli.runtime));
  }
  cli.setMode('normal');const prPath=`/repos/${binding.repository}/pulls/${binding.pr}`;
  const pr={number:binding.pr,state:'open',draft:false,merged:false,head:{sha:binding.H,repo:{id:binding.repositoryId}},base:{ref:binding.targetRef,repo:{id:binding.repositoryId,full_name:binding.repository}}};
  for(const change of [{head:{...pr.head,sha:'e'.repeat(40)}},{head:{...pr.head,repo:{id:100}}},{base:{...pr.base,ref:'other'}},{base:{...pr.base,repo:{id:100}}},{draft:true},{merged:true},{state:'closed'}]){
    business.setReply(prPath,{...pr,...change});await assert.rejects(runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'merge')),cli.runtime),/merge_scope_changed/);
  }
  business.setReply(prPath,pr);business.setReply(`/repos/${binding.repository}/git/ref/heads/${binding.targetRef}`,{ref:'refs/heads/'+binding.targetRef,object:{type:'commit',sha:'e'.repeat(40)}});
  await assert.rejects(runGitHubCliCommand(cli.config,bytes(mergeCommand(binding,'merge')),cli.runtime),/merge_scope_changed/);
  await assert.rejects(runGitHubCliCommand({...cli.config,targets:['other']},bytes(mergeCommand(binding,'merge')),cli.runtime),/command_invalid/);
  assert.equal(business.requests.filter(r=>r.method==='PUT').length,0);
});
test('sealed public deployment and normal prepare CLI check the finite runtime before credentials can be read',async t=>{
  const business=await publisherFixture(t,binding),cli=await cliPublisherFixture(t,business,binding);await cli.setGhMode('token-error');
  const deployed=await prepareGitHubCliPublisher(cli.config,join(business.root,'deployment'));assert.equal(deployed.credentialsRead,false);assert.equal((await cli.calls()).length,0);assert.equal(deployed.profile.credentialKind,'oauth_repo_admin');
  const command=mergeCommand(binding,'capabilities'),capture=join(business.root,'unavailable-capture');
  const cap=await callMergeProvider(deployed.profile,command,capture);if(cap.reply.result.kind==='capabilities')assert.equal(cap.reply.result.credentialState,'unavailable');
  assert.equal((await cli.calls()).length,1);await scan(business.root,cli.token);
  const marker=join(business.root,'module-ran');await writeFile(join(business.root,'deployment','github-cli-publisher.js'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'unsafe');\n`);
  await assert.rejects(callMergeProvider(deployed.profile,command,join(business.root,'changed-module')),/execution_incomplete/);await assert.rejects(readFile(marker),/ENOENT/);assert.equal((await cli.calls()).length,1);
  const changed=await prepareGitHubCliPublisher(cli.config,join(business.root,'changed-config')),entry=changed.profile.executable,program=await readFile(entry,'utf8');
  await writeFile(entry,program.replace('"actorId":33','"actorId":34'),{mode:0o700});await assert.rejects(callMergeProvider(changed.profile,command,join(business.root,'changed-config-capture')),/execution_incomplete/);assert.equal((await cli.calls()).length,1);
  const config=join(business.root,'public-config.json');await writeFile(config,JSON.stringify(cli.config));const result=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../src/github-cli-publisher-cli.js',import.meta.url)),'prepare','--config',config,'--directory',join(business.root,'normal-cli')]);assert.equal(JSON.parse(result.stdout).credentialsRead,false);assert.equal((await cli.calls()).length,1);
  await unlink(deployed.profile.executable);assert.deepEqual((await readMergeProviderCapture(deployed.profile,command,capture)).reply,cap.reply);
  assert.throws(()=>parseGitHubCliPublisherConfig({...cli.config,origin:'http://127.0.0.1'}),/configuration_invalid/);
});
for(const mode of ['normal','refused','lost-after-merge','after-redirect','after-timeout','after-large','after-malformed'])test('original shared managed consumer uses the CLI adapter and preserves '+mode,async t=>{
  const f=await ready(t,mode==='lost-after-merge'?'lost-after-merge':mode==='refused'?'refused':'normal','oauth_repo_admin',true),cli=await cliPublisherFixture(t,f.publisher,f.binding);rulesetOnly(f);await cli.attach();
  if(mode.startsWith('after-'))cli.setMode(mode);
  if(mode==='refused'){
    assert.equal((await managedMergeAction(f.store,f.operation,'run')).merge.phase,'refused');f.publisher.setMode('normal');
    assert.equal((await managedMergeAction(f.store,f.operation,'retry-refused')).merge.phase,'exact_merge_result_verified');
    assert.equal(f.publisher.requests.filter(r=>r.method==='PUT').length,2);
  }else{
    if(mode==='normal')assert.equal((await managedMergeAction(f.store,f.operation,'run')).merge.phase,'exact_merge_result_verified');
    else{
      if(mode==='after-malformed')assert.equal((await managedMergeAction(f.store,f.operation,'run')).merge.phase,'exact_merge_result_verified');
      else {await assert.rejects(managedMergeAction(f.store,f.operation,'run'),/execution_incomplete/);assert.equal(f.q.merges().status(f.operation).merge.phase,'sent_unknown');}
      assert.equal((await managedMergeAction(f.store,f.operation,'run')).newMergeCall,false);cli.setMode('normal');
      assert.equal((await managedMergeAction(f.store,f.operation,'reconcile')).merge.phase,'exact_merge_result_verified');
    }
    assert.equal(f.publisher.requests.filter(r=>r.method==='PUT').length,1);
  }
  assert.equal(f.publisher.state().merges,1);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.ok(cli.requests.every(r=>r.tokenMatches));
  await scan(f.store,cli.token);await scan(f.publisher.root,cli.token);
});
