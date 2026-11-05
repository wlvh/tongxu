import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {additionalFixture} from '../w7/additional-cli-fixture.js';
import {runFormalKimiImpact,readFormalKimiImpact,type FormalKimiRequest} from '../../src/formal-kimi.js';
import {probeAdditionalProgram} from '../../src/additional-cli.js';
import {AISettings,withAIPreferences} from '../../src/ai-settings.js';
import {formalFixture,ended} from './formal-round-fixture.js';
import {hash} from '../../src/snapshot.js';
import {ExtraCliSession} from '../../src/additional-cli.js';
import {FormalReviewControls} from '../../src/formal-review-controls.js';
import {DatabaseSync} from 'node:sqlite';

const material={candidate:{H:'a'.repeat(40)}},batch={sha256:'b'.repeat(64),findings:[{id:'F1'},{id:'F2'}]};
const input='Read this exact whole batch.\n'+JSON.stringify({material,batch});
async function fixture(t:test.TestContext,mode='complete',nativeProfile=false){
  const f=await additionalFixture(t,'kimi',mode,nativeProfile?'formal-profile':'formal'),o:FormalKimiRequest={directory:join(f.root,'formal-impact'),executable:f.binary,aiModel:{model:'fixture/model-next',effort:'future-depth'},system:'Explicit impact role fixture. No tools or permissions.',input,timeoutMs:1000,executionKind:nativeProfile?'native_capture':'fixture'};
  if(nativeProfile){
    const home=join(f.root,'kimi-home'),old=process.env.KIMI_CODE_HOME;await mkdir(home,{mode:0o700});await writeFile(join(home,'config.toml'),'default_model="fixture/model-a"\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\noauth={storage="file",key="oauth/kimi-code"}\n[models."fixture/model-a"]\nprovider="managed:kimi-code"\n[models."fixture/model-next"]\nprovider="managed:kimi-code"\n');process.env.KIMI_CODE_HOME=home;t.after(()=>{if(old===undefined)delete process.env.KIMI_CODE_HOME;else process.env.KIMI_CODE_HOME=old;});
  }
  return {...f,o};
}
test('formal Kimi closes and verifies one exact original input and complete report; cold capture reads spend nothing',async t=>{
  const f=await fixture(t);let refreshed=0,submitted=0;const result=await runFormalKimiImpact(f.o,async()=>{refreshed++;},()=>{submitted++;});assert.equal(refreshed,1);assert.equal(submitted,1);assert.equal(result.protocol,'kimi-acp/1');assert.equal(result.inputSha256,hash(input));assert.equal(result.systemPromptSha256,hash(f.o.system));assert.equal(JSON.parse(result.finalText).assessments.length,2);assert.match(JSON.parse(result.finalText).report,/retained full text/);assert.equal((await f.calls()).length,1);
  const before=await readFile(f.trace),cold=await readFormalKimiImpact(f.o);assert.equal(cold.finalText,result.finalText);assert.equal(cold.sessionId,result.sessionId);assert.deepEqual(await readFile(f.trace),before);assert.ok(cold.originals['prompt-boundaries.ndjson']);assert.ok(cold.originals['exit.json']);
  await writeFile(join(f.o.directory,'stdout.ndjson'),await readFile(join(f.o.directory,'stdout.ndjson'),'utf8')+'{}\n');await assert.rejects(readFormalKimiImpact(f.o),/capture_integrity_failed/);assert.deepEqual(await readFile(f.trace),before);
});
for(const reason of ['source_changed','config_changed','formal_stopped','resource_unknown','profile_changed'])test('formal Kimi last asynchronous '+reason+' blocks the actual input and dispatch',async t=>{
  const f=await fixture(t);let submitted=0;
  await assert.rejects(runFormalKimiImpact(f.o,async()=>{await Promise.resolve();if(reason==='profile_changed')await writeFile(join(f.o.directory,'workspace/.kimi-code/agents/agent.md'),'Changed readonly profile');else throw Error(reason);},()=>{submitted++;}),reason==='profile_changed'?/profile_changed/:new RegExp(reason));
  assert.equal(submitted,0);assert.equal((await f.calls()).length,0);const requests=(await readFile(join(f.o.directory,'stdin.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(requests.filter(r=>r.method==='session/prompt').length,0);
});
for(const mode of ['wrong-session','wrong-model','tool','partial','cancelled','duplicate-response'])test('formal Kimi '+mode+' never produces a verified capture or fallback',async t=>{
  const f=await fixture(t,mode);await assert.rejects(runFormalKimiImpact(f.o,async()=>{},()=>{}));await assert.rejects(readFormalKimiImpact(f.o));assert.ok((await f.calls()).length<=1);
});
for(const mode of ['profile-delay','profile-never','profile-tools'])test('formal Kimi real-profile fixture bootstrap: '+mode,async t=>{
  const f=await fixture(t,mode,true);
  if(mode==='profile-delay'){const result=await runFormalKimiImpact(f.o,async()=>{},()=>{});assert.equal(JSON.parse(result.finalText).assessments.length,2);assert.ok(result.originals['profile-observed.json']);assert.equal((await f.calls()).length,1);}
  else{await assert.rejects(runFormalKimiImpact(f.o,async()=>{},()=>{}),/readonly_profile_missing/);assert.equal((await f.calls()).length,0);}
});
async function configuredFormal(t:test.TestContext,mode='complete',withLedger=false){
  const f=await formalFixture(t,'refuted',withLedger),k=await fixture(t,mode,true),scope={account:{id:7},repository:{id:1,nodeId:'R_1',fullName:'fixture/reception'}},config={root:join(f.root,'ai-settings'),configured:[{tool:'kimi' as const,path:k.binary}],disabledMcpServers:[]};
  const probe:Parameters<typeof AISettings.open>[1]=async(tool,path,directory)=>path===k.binary?probeAdditionalProgram(tool as 'kimi',path,directory):{id:hash(path),tool,path,version:null,available:false,reason:'fixture_not_selected',authentication:'unknown',models:[],observedAt:new Date().toISOString(),capabilities:{readonlyMessages:false,scopedTools:false,ownedControl:false,impactReports:false},evidence:directory};
  const settings=await AISettings.open(config,probe);t.after(()=>settings.close());await settings.scan(scope);assert.equal((await k.calls()).length,0);const provider=settings.state(scope).catalog.find(p=>p.path===k.binary)!;assert.equal(provider.capabilities.impactReports,true);await settings.change(scope,{revision:0,role:'verifier_impact',choice:{providerId:provider.id,model:k.o.aiModel.model,effort:k.o.aiModel.effort}});const snapshot=settings.snapshot(scope);
  const prepared=await withAIPreferences(snapshot,()=>f.controls.prepare(f.entry.id,'selected-kimi'));await settings.change(scope,{revision:1,role:'verifier_impact',choice:null});return {f,k,prepared};
}
for(const withLedger of [false,true])test('normal AI selection freezes Kimi and returns its full report to the SAME fact context; original ledger='+withLedger,async t=>{
  const {f,k,prepared}=await configuredFormal(t,'complete',withLedger);await f.controls.begin(f.entry.id,prepared.operation);const report=await ended(f,prepared.operation);assert.equal(report.phase,'pass',JSON.stringify(report.detail));
  const impact=report.fullStages.find((s:any)=>s.role==='verifier_impact');assert.equal(impact.proof.native.protocol,'kimi-acp/1');assert.match(impact.result.finalText,/retained full text/);const fact=report.fullStages.filter((s:any)=>s.role==='verifier_fact');assert.equal(fact.length,2);assert.equal(fact[0].proof.native.sessionId,fact[1].proof.native.sessionId);assert.equal((await k.calls()).length,1);const actual=JSON.parse((await k.calls())[0]!.input.slice((await k.calls())[0]!.input.lastIndexOf('\n')+1));assert.equal(actual.batch.findings.length,2);assert.equal(actual.initialFact,undefined);
  const before=await readFile(k.trace);await f.controls.begin(f.entry.id,prepared.operation);await ended(f,prepared.operation);assert.deepEqual(await readFile(k.trace),before);assert.equal(f.q.formalReviews().state(prepared.operation).request.aiSelections.verifier_impact.tool,'kimi');
  if(f.ledger){assert.equal(report.resourcesSettled,true);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);}
});
for(const mode of ['missing-finding','partial'])test('formal Kimi '+mode+' waits without Claude fallback or cold resend',async t=>{
  const {f,k,prepared}=await configuredFormal(t,mode);await f.controls.begin(f.entry.id,prepared.operation);const report=await ended(f,prepared.operation);assert.equal(report.phase,'waiting',JSON.stringify(report.detail));assert.equal((await k.calls()).length,1);assert.equal((await f.calls()).filter(c=>c.role==='impact').length,0);assert.equal(report.fullStages.filter((s:any)=>s.role==='verifier_fact').length,1);
  await f.controls.drain();const cold=await FormalReviewControls.load(f.catalog,hash(await readFile(f.catalog)),f.sources,undefined,async()=>f.live);t.after(()=>cold.drain());const trace=await readFile(k.trace);await cold.begin(f.entry.id,prepared.operation);const deadline=Date.now()+5000;while((await cold.state())[0]!.requests[0]!.controllerActive&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));const retained=await cold.report(f.entry.id,prepared.operation);assert.equal(retained.phase,'waiting');assert.match(retained.detail.reason,/sent_or_unknown_no_resend/);assert.deepEqual(await readFile(k.trace),trace);
});
for(const change of ['source','config','stop','resource'] as const)test('original formal host rechecks late '+change+' after Kimi setup and before actual dispatch',async t=>{
  const {f,k,prepared}=await configuredFormal(t,'complete',change==='resource'),prompt=ExtraCliSession.prototype.prompt;let injected=false;
  // Inject a real original-state change at the final asynchronous boundary;
  // leave the product refresh and synchronous dispatch guard untouched.
  ExtraCliSession.prototype.prompt=async function(input,timeout,beforeSend,beforeDispatch){return prompt.call(this,input,timeout,beforeSend,async()=>{
    if(this.directory.startsWith(f.entry.root)){injected=true;
      if(change==='source')f.live.candidate.H='f'.repeat(40);
      else if(change==='config')await writeFile(f.entry.config.path,await readFile(f.entry.config.path,'utf8')+'\n');
      else if(change==='stop')await f.controls.stop(f.entry.id,prepared.operation);
      else{const db=new DatabaseSync(join(f.ledger!.root,'original-fixture.sqlite'));try{db.prepare('UPDATE requests SET result=?').run(JSON.stringify({state:'absent',reason:null,claim:null}));}finally{db.close();}}
    }await beforeDispatch?.();
  });};t.after(()=>{ExtraCliSession.prototype.prompt=prompt;});
  await f.controls.begin(f.entry.id,prepared.operation);const report=await ended(f,prepared.operation);assert.equal(injected,true);assert.notEqual(report.phase,'pass');assert.equal((await k.calls()).length,0);const impact=f.q.formalReviews().state(prepared.operation).stages.find((s:any)=>s.stage.role==='verifier_impact');assert.ok(impact);assert.equal(impact.dispatched,false);assert.equal(impact.returned,null);
  if(change==='stop')assert.equal(report.stopped,true);else assert.match(report.detail.reason,change==='source'?/candidate_or_requirements_changed/:change==='config'?/config_changed/:/resource|claim|ledger/);
});
