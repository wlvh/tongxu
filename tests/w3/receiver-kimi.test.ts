import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup} from './receiver-fixture.js';
import {ready} from './receiver-authority-fixture.js';
import {additionalFixture,additionalKimiHome} from '../w7/additional-cli-fixture.js';
import {normal} from '../events/normal-entry-fixture.js';
import {runReception,reconcileReception,correctReception,parseReceiverPlan} from '../../src/receiver.js';
import {readFormalKimiImpact} from '../../src/formal-kimi.js';
import {probeAdditionalProgram,ExtraCliSession} from '../../src/additional-cli.js';
import {QueueStore} from '../../src/queue-store.js';
import {LiveProcess} from '../../src/live-process.js';
import {startWorkbench} from '../../src/workbench.js';
import {hash} from '../../src/snapshot.js';
import type {AIPreferenceSnapshot} from '../../src/ai-settings.js';
import type {AIProvider,inspectAIProvider} from '../../src/ai-catalog.js';

const scope={account:{id:7},repository:{id:1,nodeId:'R_1',fullName:'fixture/reception'}};
function preferences(executable:string):AIPreferenceSnapshot{return {revision:1,scope,roles:{receiver:{tool:'kimi',executable,model:'fixture/model-next',effort:'future-depth',resolvedModel:null,settingsRevision:1,role:'receiver',project:{account:7,repository:1,nodeId:'R_1'},catalogObservedAt:new Date().toISOString()}}};}
async function selected(t:test.TestContext,mode='complete',governed=false){
 const f=governed?await ready(t,true):await setup(t),k=await additionalFixture(t,'kimi',mode,'receiver');
 f.plan.ai=preferences(k.binary);f.plan.billing.providers=['claude','kimi'];f.plan.timeoutMs=1000;
 await writeFile(f.plan.billing.evidence,'Explicit Claude/Kimi protocol fixture billing proof; no actual model/account/credit.');f.plan.billing.evidenceSha256=hash(await readFile(f.plan.billing.evidence));await writeFile(f.path,JSON.stringify(f.plan));return {f,k};
}
test('Kimi receiver consumes its own exact original, exposes real provider metadata and cold reads without a second input',async t=>{
 const {f,k}=await selected(t),r=await runReception(f.path);assert.equal(r.receiver.phase,'returned',JSON.stringify(r));assert.match(r.receiver.judgment.report,/完整Kimi协议样例/);assert.equal(await f.count(),0);assert.equal((await k.calls()).length,1);
 const saved=f.q.receiverState(r.operation),completed=JSON.parse(await readFile(join(r.receiver.directory,'kimi/completed.json'),'utf8'));assert.equal(completed.kind,'tongxu-kimi-receiver-result');assert.equal(completed.inputSha256,saved.receiver.inputSha256);assert.equal(JSON.parse(completed.finalText).bindingHash,saved.receiver.bindingHash);
 const metadata=f.q.status([f.item]).operations.find((o:any)=>o.id===r.operation).nativeExecution;assert.equal(metadata.tool,'Kimi CLI');assert.equal(metadata.state,'recorded');assert.equal(metadata.model,'fixture/model-next');
 f.q.enableSupplements();f.q.reviewRecords().enable();const record=f.q.reviewRecords().registerJudgment(r.operation,{taskClass:'fixture',riskClass:'bounded',coverageWindow:'fixed original',source:'explicit protocol test'});assert.equal(record.tool,'kimi');assert.equal(record.model,metadata.model);assert.equal(record.session,metadata.session);
 const before=await readFile(k.trace),again=await runReception(f.path),cold=await reconcileReception(f.store,r.operation);assert.equal(again.operation,r.operation);assert.equal(cold.receiver.judgment.report,r.receiver.judgment.report);assert.deepEqual(await readFile(k.trace),before);
 const stage=join(r.receiver.directory,'kimi');await assert.rejects(readFormalKimiImpact({directory:stage,executable:k.binary,aiModel:{model:'fixture/model-next',effort:'future-depth'},system:saved.system.toString(),input:saved.input.toString(),timeoutMs:500,executionKind:'fixture'}));
 await writeFile(join(stage,'receiver-request.json'),JSON.stringify({role:'verifier_impact'}));await assert.rejects(reconcileReception(f.store,r.operation),/receiver_original_impact_input_changed/);assert.deepEqual(await readFile(k.trace),before);
});
test('a completed invalid Kimi judgment preserves full final text and uses the existing bounded correction consumer',async t=>{
 const {f,k}=await selected(t,'invalid-judgment'),first=await runReception(f.path);assert.equal(first.status,'receiver_invalid_result');assert.equal(first.receiver.invalidResult.executionCompleted,true);
 const full=JSON.parse(await readFile(join(first.receiver.directory,'kimi/completed.json'),'utf8')).finalText,material=join(f.root,'correction.txt');await writeFile(material,'Explicit evidence for one bounded response correction; no permission change.');
 const path=join(f.root,'correction.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-ended-result-correction',store:f.store,operation:first.operation,bindingHash:first.receiver.bindingHash,receiverPlan:f.path,source:'fixture:bounded-correction',reason:'Preserve actual complete contradictory output and request one consistent judgment',material:[{name:'fixed-facts',path:material,sha256:hash(await readFile(material))}]}));
 const second=await correctReception(path);assert.equal(second.receiver.phase,'returned',JSON.stringify(second));assert.notEqual(second.operation,first.operation);assert.equal(JSON.parse(f.q.receiverState(second.operation).input.toString()).data.evidence.correction.originalFinalText,full);assert.equal((await k.calls()).length,2);await correctReception(path);assert.equal((await k.calls()).length,2);
});
for(const mode of ['wrong-session','wrong-model','tool','partial','cancelled','duplicate-response'])test('Kimi receiver '+mode+' retains the original without Claude fallback or retry',async t=>{
 const {f,k}=await selected(t,mode),r=await runReception(f.path);assert.equal(r.status,'receiver_unknown',JSON.stringify(r));assert.equal(await f.count(),0);const before=await readFile(k.trace);await runReception(f.path);assert.deepEqual(await readFile(k.trace),before);assert.equal(f.q.status().operations.filter((o:any)=>o.result?.receiver).length,1);if(mode==='wrong-model'){assert.equal((await k.calls()).length,0);assert.equal(r.newTaskSent,false);}
});
test('Kimi needs explicit applicable billing and project binding before any user prompt',async t=>{
 const {f,k}=await selected(t);delete f.plan.billing.providers;await writeFile(f.path,JSON.stringify(f.plan));await assert.rejects(runReception(f.path),/billing_provider_not_authorized/);assert.equal((await k.calls()).length,0);
 for(const providers of [[],['kimi','kimi'],['other']])assert.throws(()=>parseReceiverPlan(Buffer.from(JSON.stringify({...f.plan,billing:{...f.plan.billing,providers}}))),/billing_providers_invalid/);
 f.plan.billing.providers=['kimi'];f.plan.ai!.scope={...scope,repository:{...scope.repository,fullName:'fixture/other'}};await writeFile(f.path,JSON.stringify(f.plan));await assert.rejects(runReception(f.path),/outside_project/);assert.equal((await k.calls()).length,0);assert.equal(await f.count(),0);
});
for(const change of ['stop','revoke','source','resource','profile','billing'] as const)test('Kimi last asynchronous '+change+' change reaches the original admission and sends zero prompts',async t=>{
 const {f,k}=await selected(t,'complete',true),g=f as Awaited<ReturnType<typeof ready>>,prompt=ExtraCliSession.prototype.prompt;let injected=false;
 ExtraCliSession.prototype.prompt=async function(input,timeout,before,refresh,gate){return prompt.call(this,input,timeout,before,async()=>{
  if(this.directory.startsWith(f.store)){injected=true;
   if(change==='stop')f.q.control('scope','investment','stopped','Explicit last-boundary stop');
   else if(change==='revoke')await g.adopt({kind:'revoke',decision:g.confirmation.sha});
   else if(change==='source')await f.packet({H:await f.newHead()});
   else if(change==='resource'){const db=new DatabaseSync(join(g.ledger!.root,'original-fixture.sqlite'));try{db.prepare('UPDATE requests SET result=?').run(JSON.stringify({state:'absent',reason:null,claim:null}));}finally{db.close();}}
  }await refresh?.();
  if(this.directory.startsWith(f.store)){if(change==='profile')await writeFile(join(this.directory,'workspace/.kimi-code/agents/agent.md'),'Changed profile');if(change==='billing')await writeFile(f.plan.billing.evidence,'Changed fee evidence');}
 },gate);};t.after(()=>{ExtraCliSession.prototype.prompt=prompt;});
 const r=await runReception(f.path);assert.equal(injected,true);assert.equal(r.status,'receiver_unknown',JSON.stringify(r));assert.equal(r.newTaskSent,false);assert.equal((await k.calls()).length,0);assert.equal(await f.count(),0);assert.equal(g.ledger!.state().settlements.length,0);assert.equal(f.q.receiverState(r.operation).receiver.phase,'reserved');
});
test('Kimi holds the original queue transaction through the actual ACP user-input write',async t=>{
 const {f,k}=await selected(t,'complete',true),other=new DatabaseSync(join(f.store,'queue.sqlite')),send=LiveProcess.prototype.send;other.exec('PRAGMA busy_timeout=0');let observed=false;
 LiveProcess.prototype.send=function(message:any){if(message.method==='session/prompt'&&this.directory.startsWith(f.store)){assert.throws(()=>other.exec('BEGIN IMMEDIATE'),/locked|busy/);observed=true;}return send.call(this,message);};t.after(()=>{LiveProcess.prototype.send=send;other.close();});
 const r=await runReception(f.path);assert.equal(r.receiver.phase,'returned',JSON.stringify(r));assert.equal(observed,true);assert.equal((await k.calls()).length,1);assert.equal((f as Awaited<ReturnType<typeof ready>>).ledger!.state().settlements.length,1);other.exec('BEGIN IMMEDIATE;ROLLBACK');
});
test('a rolled-back Kimi dispatch retains its actual input and original held claim when explicitly closing the ended execution',async t=>{
 const {f,k}=await selected(t,'complete',true),effect=QueueStore.prototype.receiverEffect;
 QueueStore.prototype.receiverEffect=function(id,binding,observations,send){return (effect as any).call(this,id,binding,observations,()=>{send();throw Error('explicit_fixture_after_kimi_input_before_commit');});};
 let r;try{r=await runReception(f.path);}finally{QueueStore.prototype.receiverEffect=effect;}
 assert.equal(r.newTaskSent,true);assert.equal(f.q.receiverState(r.operation).receiver.phase,'reserved');assert.equal((await k.calls()).length,1);
 const closed=await reconcileReception(f.store,r.operation,'Explicit ended original after Kimi input and dispatch transaction rollback');assert.equal(closed.modelDispatchStatus,'submitted_or_unknown');assert.equal(closed.queueDispatchRegistered,false);assert.equal(closed.dispatchCapture.capturedInputPresent,true);const g=f as Awaited<ReturnType<typeof ready>>;assert.equal(f.q.resources().status(g.resourceRequests[0]!).state,'held');assert.equal(g.ledger!.state().settlements.length,0);await runReception(f.path);assert.equal((await k.calls()).length,1);
});

async function normalKimi(t:test.TestContext,resources=false,baselineMode='complete'){
 const k=await additionalFixture(t,'kimi','complete','receiver-profile');await additionalKimiHome(t,k.root);let unavailable=false;
 const probe:typeof inspectAIProvider=async(tool,path,directory)=>path===k.binary&&!unavailable?probeAdditionalProgram(tool as 'kimi',path,directory):({id:hash(path),tool,path,version:null,available:false,reason:'explicit_fixture_unavailable',authentication:'unknown',models:[],observedAt:new Date().toISOString(),capabilities:{readonlyMessages:false,scopedTools:false,ownedControl:false},evidence:directory} as AIProvider);
 const f=await normal(t,resources,false,{config:{root:join(k.root,'settings'),configured:[{tool:'kimi',path:k.binary}],disabledMcpServers:[]},probe:probe!,billingProviders:['claude','kimi']},baselineMode);
 const post=async(path:string,body:unknown={})=>{const r=await fetch(f.url.origin+path,{method:'POST',headers:{...f.headers,Origin:f.url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json() as any;assert.equal(r.status,200,JSON.stringify(value));return value;};
 const scan=await post('/api/ai-settings/scan'),provider=scan.catalog.find((p:any)=>p.path===k.binary);assert.equal(provider.capabilities.receptionReports,true);assert.equal((await k.calls()).length,0);let revision=0;
 const choose=async(model:string|null)=>{const changed=await post('/api/ai-settings/role',{revision,role:'receiver',choice:model?{providerId:provider.id,model,effort:'future-depth'}:null});revision=changed.revision;};await choose('fixture/model-next');
 const changed=async(id:number)=>{await f.observed.source.change({comments:[{id,user:{id:15},body:'Explicit new reception material '+id}]});await f.post('check');return (await f.get()).tasks[0].currentPacket;};
 return {...f,k,postAI:post,choose,changed,probe:probe!,unavailable:()=>{unavailable=true;}};
}
test('normal project AI settings freeze Kimi per new packet, read full originals and retain old choices after model changes and cold reopen',async t=>{
 const f=await normalKimi(t),packet=await f.changed(91);await f.post('start',{expectedPacket:packet});const first=await f.settled();assert.equal(first.entry.phase,'returned',JSON.stringify(first.entry));assert.equal((await f.k.calls()).length,1);assert.equal(await f.count(),1);
 const frozen=f.q.receiverState(first.entry.operation);assert.equal(JSON.parse(frozen.plan.toString()).ai.roles.receiver.model,'fixture/model-next');const original=await readFile(join(frozen.receiver.directory,'kimi/stdout.ndjson'));
 await f.choose('fixture/model-a');await f.post('start',{expectedPacket:packet});assert.equal((await f.settled()).entry.operation,first.entry.operation);assert.equal((await f.k.calls()).length,1);assert.deepEqual(await readFile(join(frozen.receiver.directory,'kimi/stdout.ndjson')),original);
 const next=await f.changed(92);await f.post('start',{expectedPacket:next});const second=await f.settled();assert.equal(second.entry.phase,'returned');assert.equal((await f.k.calls()).length,2);assert.equal(JSON.parse(f.q.receiverState(second.entry.operation).plan.toString()).ai.roles.receiver.model,'fixture/model-a');
 const app=await startWorkbench(f.planPath,undefined,{githubReader:f.github,aiProbe:f.probe});t.after(()=>app.close());const url=new URL(app.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)};await fetch(url.origin+'/api/github/projects',{headers});const r=await fetch(url.origin+'/api/report/selected/'+first.entry.operation,{headers}),full=await r.json() as any;assert.equal(r.status,200);assert.equal(full.report,frozen.receiver.judgment.report);assert.equal((await f.k.calls()).length,2);
});
test('a prepared governed receiver plan survives unavailable new settings and uses its original Kimi choice and resource claim',async t=>{
 const f=await normalKimi(t,true),packet=await f.changed(93),reserve=QueueStore.prototype.reserveReceiver;let interrupted=false;
 QueueStore.prototype.reserveReceiver=function(...args){if(this.directory===f.store&&!interrupted){interrupted=true;throw Error('explicit_fixture_preparation_interrupted');}return reserve.apply(this,args);};
 try{await f.post('start',{expectedPacket:packet});assert.match((await f.settled()).entry.problem,/preparation_interrupted/);}finally{QueueStore.prototype.reserveReceiver=reserve;}
 assert.equal(interrupted,true);assert.equal((await f.k.calls()).length,0);const operation=f.q.status().operations.find((o:any)=>o.packet===packet).id,path=join(f.store,'normal-reception-'+operation+'.json'),before=await readFile(path);assert.equal(JSON.parse(before.toString()).ai.roles.receiver.tool,'kimi');
 const altered=JSON.parse(before.toString());altered.ai.roles.receiver.model='fixture/model-a';await writeFile(path,JSON.stringify(altered));await f.post('start',{expectedPacket:packet});assert.equal((await f.settled()).entry.problem,'reception_original_plan_changed');assert.equal((await f.k.calls()).length,0);
 await unlink(path);f.unavailable();await f.postAI('/api/ai-settings/scan');await f.post('start',{expectedPacket:packet});const recovered=await f.settled();assert.equal(recovered.entry.phase,'returned',JSON.stringify(recovered.entry));assert.equal(recovered.entry.operation,operation);assert.deepEqual(await readFile(path),before);assert.equal((await f.k.calls()).length,1);assert.equal(f.ledger!.state().claims.length,2);assert.equal(f.ledger!.state().settlements.length,2);
});
test('a plan file without the original queue binding cannot supply a replacement choice or trigger discovery',async t=>{
 const f=await normalKimi(t),packet=await f.changed(94),begun=f.q.begin(f.item,'explicit_unbound_plan_fixture');f.q.evaluate(begun.operation);await writeFile(join(f.store,'normal-reception-'+begun.operation+'.json'),'{}');f.unavailable();await f.postAI('/api/ai-settings/scan');await f.post('start',{expectedPacket:packet});const result=await f.settled();assert.equal(result.entry.problem,'reception_original_plan_binding_missing');assert.equal((await f.k.calls()).length,0);assert.equal(await f.count(),1);
});
test('normal lookup of a submitted Claude403 original ignores unavailable new Kimi settings and unavailable live source without resending',async t=>{
 const f=await normalKimi(t,false,'provider403'),before=await f.get(),operation=f.first.operation,original=f.q.receiverState(operation),raw=await readFile(join(original.receiver.directory,'claude/stdout.ndjson'));assert.equal(before.receptions[0].phase,'dispatch_registered');assert.equal(JSON.parse(original.plan.toString()).ai,undefined);assert.equal(await f.count(),1);assert.equal((await f.k.calls()).length,0);
 f.unavailable();await f.postAI('/api/ai-settings/scan');await f.observed.source.change({mode:'forbidden-comments'});await f.post('start',{expectedPacket:before.tasks[0].currentPacket});const kept=await f.settled();assert.equal(kept.entry.operation,operation);assert.equal(kept.entry.phase,'dispatch_registered');assert.equal(kept.entry.problem,null);assert.equal(await f.count(),1);assert.equal((await f.k.calls()).length,0);assert.deepEqual(await readFile(join(original.receiver.directory,'claude/stdout.ndjson')),raw);assert.deepEqual(f.q.receiverState(operation).plan,original.plan);
});
