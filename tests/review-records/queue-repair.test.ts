import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,access } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../w3/receiver-fixture.js';
import { fixture } from '../w5/repair-fixture.js';
import { runReception } from '../../src/receiver.js';
import { runQueueRepair, closeUnstartedQueueRepair } from '../../src/queue-repair.js';
import { runRepair } from '../../src/repair.js';
import { git } from '../../src/repair-workspace.js';
import { hash } from '../../src/snapshot.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
import { QueueStore } from '../../src/queue-store.js';
import { DatabaseSync } from 'node:sqlite';
import { fixture as ledgerFixture } from '../resources/provider-fixture.js';
import { authorizeRepairFixture } from './repair-authority-fixture.js';
import { resourceAction } from '../../src/resource-claims.js';
import { reconcileProjectTests } from '../../src/project-repair.js';
import { messageFixture } from '../w6/message-fixture.js';
import { runCoordination } from '../../src/coordination.js';
import { coordinationPlanId } from '../../src/coordination-contract.js';
import { runCoordinatedRepair } from '../../src/coordination-repair.js';
const dockerPath=process.env.TONGXU_TEST_DOCKER_CONFIG;
if(!dockerPath) throw new Error('TONGXU_TEST_DOCKER_CONFIG required');
const docker=JSON.parse(await readFile(dockerPath,'utf8'));

async function setupRepair(t: test.TestContext, mode='return', modelMode='project') {
  const f=await setup(t,mode), model=await fixture(t,modelMode);
  const objects=f.plan.objects;
  await mkdir(join(objects,'src'));await mkdir(join(objects,'test'));
  await writeFile(join(objects,'src/normalize.mjs'),"export function normalizeLabel(value){return value.trim();}\n");
  await writeFile(join(objects,'src/index.mjs'),"export {normalizeLabel} from './normalize.mjs';\n");
  await writeFile(join(objects,'README.md'),'Explicit queue repair fixture; empty labels must become Untitled.\n');
  await writeFile(join(objects,'test/normalize.test.mjs'),"import assert from 'node:assert/strict';import {normalizeLabel} from '../src/index.mjs';assert.equal(normalizeLabel('  '),'Untitled');assert.equal(normalizeLabel(' X '),'X');\n");
  await git(objects,['add','.']); await git(objects,['-c','user.name=fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m','explicit queue fixture defect']);
  const H=await git(objects,['rev-parse','HEAD']), item=await f.packet({H});
  f.plan.item=item.item;f.plan.sourcePaths=['src/normalize.mjs','test/normalize.test.mjs'];await writeFile(f.path,JSON.stringify(f.plan));
  f.q.enableSupplements();f.q.reviewRecords().enable();
  const receiver=await runReception(f.path), original=f.q.receiverState(receiver.operation), evidence=f.q.receiverEvidence(receiver.operation);
  const testPlan=join(f.root,'tests.json');await writeFile(testPlan,JSON.stringify({schemaVersion:2,executor:docker,tools:[{id:'existing-tests',argv:[docker.node,'test/normalize.test.mjs'],timeoutMs:10000}]}));
  const request={schemaVersion:1,kind:'tongxu-project-repair-request',executionRoot:join(f.root,'managed'),objects,candidate:{kind:'github-pr',repository:'fixture/reception',pr:1,H,B:evidence.manifest.candidate.B,target:'fixture'},allowedPaths:['src/normalize.mjs'],materialPaths:['src/normalize.mjs','src/index.mjs','test/normalize.test.mjs','README.md'],protectedPaths:['test/normalize.test.mjs'],contract:'Trim labels; empty becomes Untitled, preserve nonempty values and exports.',testPlan,testPlanSha256:hash(await readFile(testPlan)),findings:[],authorization:{source:'fixture:explicit scoped repair',allowRepair:true,allowReconcileEnded:true,maxRepairRounds:3},demonstrationFixture:true,generatedDirectories:[]};
  const requestPath=join(f.root,'request.json');await writeFile(requestPath,JSON.stringify(request));
  const p={schemaVersion:1,kind:'tongxu-queue-repair',store:f.store,operation:receiver.operation,packet:evidence.packet,judgmentId:original.receiver.judgmentId,bindingHash:original.receiver.bindingHash,context:evidence.context,request:requestPath,requestSha256:hash(await readFile(requestPath)),config:model.configPath,configSha256:hash(await readFile(model.configPath))};
  const planPath=join(f.root,'queue-repair.json');await writeFile(planPath,JSON.stringify(p));
  return {...f,model,original,evidence,request,requestPath,p,planPath,operation:receiver.operation,H};
}
test('original queue RETURN starts the existing project repair, preserves the judgment, records factual counters and does not dispatch twice',async t=>{
  const f=await setupRepair(t), judgment=JSON.stringify(f.original.receiver.judgment), r=await runQueueRepair(f.planPath);
  assert.equal(r.repairStatus,'completed');assert.equal(r.counters.actualFileWrites,1);assert.equal(r.counters.fixedNewCandidates,1);assert.equal(r.counters.writeHandoffs,1);assert.equal(r.counters.publishedReworkBatches,0);
  assert.equal(JSON.stringify(f.q.receiverState(f.operation).receiver.judgment),judgment);assert.equal(f.q.status().claims.length,0);
  assert.equal(await git(f.plan.objects,['rev-parse','HEAD']),f.H);assert.match(await readFile(join(f.request.executionRoot,'workspace/src/normalize.mjs'),'utf8'),/Untitled/);
  const before=await readFile(f.model.trace), repeated=await runQueueRepair(f.planPath);assert.equal(repeated.duplicate,true);assert.deepEqual(await readFile(f.model.trace),before);
  assert.equal(r.manualReportCopyRequired,false);assert.equal(r.manualRepairRequired,false);
  const input=await readFile(join(f.request.executionRoot,'operation/attempt-1/fact-and-repair/stdin.ndjson'),'utf8');assert.ok(input.includes(f.original.receiver.judgment.report));
  await assert.rejects(runRepair(join(f.request.executionRoot,'plan.json'),join(f.request.executionRoot,'operation')),/original_queue_repair_entry_required/);
  const changed={...f.p,packet:f.p.packet+1};await writeFile(f.planPath,JSON.stringify(changed));await assert.rejects(runQueueRepair(f.planPath),/queue_repair_fixed_input_changed/);assert.deepEqual(await readFile(f.model.trace),before);
});
test('accepted or insufficient findings do not manufacture repair tasks',async t=>{
  for(const mode of ['complete','always-insufficient']){const f=await setupRepair(t,mode),before=await readFile(f.model.trace);await assert.rejects(runQueueRepair(f.planPath),/repair_requires_completed_return/);assert.deepEqual(await readFile(f.model.trace),before);assert.equal(f.q.status().claims.length,0);}
});
test('an existing repair entry cannot bypass a newly registered coordination handoff even when no shared-feedback blocker exists',async t=>{
  const f=await setupRepair(t),other=await f.packet({pr:2,H:f.H}),task=(id:string,item:string)=>({id,item,actor:id,originActor:id,dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['src/normalize.mjs'],workspace:null,publishBranch:null,outputs:[]});
  const plan={schemaVersion:1,kind:'tongxu-task-coordination',name:'write-handoff-fixture',revision:'r1',previous:null,source:'Explicit local fixture coordination; original reviewer return is not a new writing handoff',authorityIntent:null,mode:'parallel',actors:[{id:'A',tool:'codex'},{id:'B',tool:'codex'}],tasks:[task('A',f.plan.item),task('B',other.item)],shared:[],dependencies:[]};
  f.q.coordination().register(Buffer.from(JSON.stringify(plan)));const before=await readFile(f.model.trace),judgment=JSON.stringify(f.original.receiver.judgment);
  await assert.rejects(()=>runQueueRepair(f.planPath),/coordination_explicit_write_handoff_required/);assert.deepEqual(await readFile(f.model.trace),before);assert.equal(f.q.status().claims.length,0);assert.equal(JSON.stringify(f.q.receiverState(f.operation).receiver.judgment),judgment);
  const c=await f.packet({pr:3,H:f.H}),next={...plan,previous:hash((await import('../../src/comparison.js')).canonical(plan)),revision:'r2',actors:[...plan.actors,{id:'C',tool:'codex'}],tasks:[task('C',c.item),task('B',other.item)]};f.q.coordination().register(Buffer.from(JSON.stringify(next)));
  await assert.rejects(()=>runQueueRepair(f.planPath),/coordination_explicit_write_handoff_required/);assert.deepEqual(await readFile(f.model.trace),before);assert.equal(f.q.status().claims.length,0);
});
async function coordinatedRepair(t:test.TestContext,start=true,messageMode='complete'){
  const f=await setupRepair(t),messages=await messageFixture(t,messageMode),other=await f.packet({pr:2,H:f.H});
  let script=await readFile(messages.codex,'utf8');script=script.replace("report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId","report:JSON.stringify((()=>{const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),task=x.body.split('\\n')[0].slice(18);return {kind:'tongxu-coordination-feedback',task,revision:c.revision,parts:[],report:'Explicit fixture consumed '+c.outputs.map(o=>o.sha256).join(',')};})())");await writeFile(messages.codex,script);
  const plan={schemaVersion:1,kind:'tongxu-task-coordination',name:'coordinated-repair-fixture',revision:'r1',previous:null,source:'Explicit test: new managed workspace after original readonly task, no external writer takeover',authorityIntent:null,mode:'stage_serial',actors:[{id:'A',tool:'codex'},{id:'B',tool:'codex'}],tasks:[{id:'A',item:f.plan.item,actor:'A',originActor:'A',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:f.request.allowedPaths,workspace:join(f.request.executionRoot,'workspace'),publishBranch:'fixture-repair-A',outputs:[{id:'fixed-label',stage:'implement',kind:'repair_candidate'}]},{id:'B',item:other.item,actor:'B',originActor:'B',dispatch:'owner_backlog',stages:['investigate'],independentPaths:[],workspace:null,publishBranch:null,outputs:[]}],shared:[],dependencies:[{task:'B',stage:'investigate',producer:'A',capability:'fixed-label'}]};
  const config={schemaVersion:1,kind:'tongxu-coordination-readonly-execution',source:'Explicit fixture processes; no real models',executionKind:'fixture',actors:['A','B'].map(id=>({id,tool:'codex',executable:messages.codex,executableSha256:hash(script),disabledMcpServers:[],allowedInstructionSources:[]})),taskBodies:{A:'Review the scoped label contract before a new managed repair workspace is prepared.',B:'Read the actual repaired candidate, code diff, tests and independent report from A.'},authorityIntents:{A:null,B:null},billing:messages.plan.billing,timeoutMs:1000,refreshUnsent:false};
  const planPath=join(f.root,'coordination.json'),configPath=join(f.root,'coordination-execution.json');await writeFile(planPath,JSON.stringify(plan));await writeFile(configPath,JSON.stringify(config));
  const first=await runCoordination(f.store,planPath,configPath,!start);assert.equal(first.newModelRequests,start?1:0);if(start)assert.equal(first.results['A:investigate'].completed,true,JSON.stringify(first.errors));assert.equal(first.prepared['B:investigate'],undefined);
  const from=first.prepared['A:investigate'],p={...f.p,coordination:{planId:first.coordination,task:'A',capability:'fixed-label',fromRun:from.run,fromMessage:from.messageId}};await writeFile(f.planPath,JSON.stringify(p));
  return {...f,messages,coordPlan:plan,coordPlanPath:planPath,coordConfigPath:configPath,coordId:first.coordination,coordinatedPlan:p};
}
test('coordinated task hands one managed repair to the correct operation and a later task actually consumes its new candidate',async t=>{
  const f=await coordinatedRepair(t),result=await runQueueRepair(f.planPath);assert.equal(result.repairStatus,'completed');assert.equal(result.coordinationOutput.kind,'repair_candidate');assert.equal(result.coordinationOutput.afterH,result.after.H);assert.equal(result.counters.actualFileWrites,1);
  const context=f.q.coordination().context(f.coordId),artifact=JSON.parse(context.value.outputs[0].text);assert.match(artifact.artifact.material['src/normalize.mjs'].text,/Untitled/);assert.match(artifact.artifact.diff,/Untitled/);assert.equal(artifact.artifact.result.review.candidateH,result.after.H);assert.equal(artifact.artifact.result.tests.passed,true);assert.equal('stdout' in artifact.artifact.result.tests.tools[0],false);
  const next=await runCoordination(f.store,f.coordPlanPath,f.coordConfigPath);assert.equal(next.newModelRequests,1);assert.equal(next.readonlyTasksCompleted,true,JSON.stringify(next.errors));assert.equal(next.state.tasks[1]!.stages[0]!.phasePrerequisitesMet,true);assert.ok(next.results['B:investigate'].messages[0].reply.report.includes(result.coordinationOutput.sha256));
  const trace=await readFile(f.model.trace),messages=await readFile(f.messages.trace);const repeat=await runQueueRepair(f.planPath);assert.equal(repeat.coordinationOutput.duplicate,true);assert.equal((await runCoordination(f.store,f.coordPlanPath,f.coordConfigPath)).newModelRequests,0);assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(await readFile(f.messages.trace),messages);
});
test('one coordinated repair entry runs investigation, bounded implementation and exact downstream consumption without report copying',async t=>{
  const f=await coordinatedRepair(t,false);await writeFile(f.planPath,JSON.stringify(f.p));
  const result=await runCoordinatedRepair(f.store,f.coordPlanPath,f.coordConfigPath,f.planPath);assert.equal(result.completed,true,JSON.stringify(result));assert.equal(result.repair?.counters.actualFileWrites,1);assert.equal(result.readonlyModelRequests,2);assert.equal(result.manualReportCopyRequired,false);
  const trace=await readFile(f.model.trace),messages=await readFile(f.messages.trace),again=await runCoordinatedRepair(f.store,f.coordPlanPath,f.coordConfigPath,f.planPath);assert.equal(again.completed,true);assert.equal(again.readonlyModelRequests,0);assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(await readFile(f.messages.trace),messages);
});
test('the same governed entry claims original resources for investigation, repair and downstream consumption, then repeats without claims or inputs',async t=>{
  const f=await coordinatedRepair(t,false),ledger=await ledgerFixture(t),authority=await authorizeRepairFixture(f,ledger.profile),provider=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));provider.prepare('UPDATE capacity SET n=3').run();provider.close();
  const grant=await authority.adopt({kind:'delegate',adoption:authority.scope.sha,roles:['coordinator'],targets:['fixture'],actions:['coordinate'],paths:[],resourceRefs:[ledger.profile.resources[0]!.ref],expiresAt:new Date(Date.now()+3600000).toISOString()});
  const config=JSON.parse(await readFile(f.coordConfigPath,'utf8'));config.refreshUnsent=true;config.delegatedCoordination={authorization:grant.sha,adoption:authority.scope.sha,resources:[{ledgerId:ledger.profile.ledgerId,resourceRef:ledger.profile.resources[0]!.ref,unit:ledger.profile.resources[0]!.unit,quantity:1}]};await writeFile(f.coordConfigPath,JSON.stringify(config));
  await writeFile(f.planPath,JSON.stringify({...f.p,governance:{authorityIntent:authority.intent,resourceRequests:[authority.resourceId]}}));
  const result=await runCoordinatedRepair(f.store,f.coordPlanPath,f.coordConfigPath,f.planPath);assert.equal(result.completed,true,JSON.stringify(result));assert.equal(result.repair?.counters.actualFileWrites,1);assert.equal(result.readonlyModelRequests,2);assert.equal(ledger.state().claims.length,3);assert.equal(ledger.state().settlements.length,3);
  const selected=(await QueueStore.observe(f.store,[],[],[f.plan.item])).collaboration[f.plan.item];assert.equal(selected.repairs.length,1);assert.equal(selected.repairs[0].result.afterH,result.repair!.after.H);assert.equal(selected.repairs[0].result.testsPassed,true);assert.equal(selected.repairs[0].result.reviewCandidateH,result.repair!.after.H);assert.equal(selected.repairs[0].resources[0].settled,true);assert.ok(!JSON.stringify(selected).includes(f.root));
  const trace=await readFile(f.model.trace),messages=await readFile(f.messages.trace);await authority.adopt({kind:'revoke',decision:grant.sha});const again=await runCoordinatedRepair(f.store,f.coordPlanPath,f.coordConfigPath,f.planPath);assert.equal(again.completed,true);assert.equal(again.readonlyModelRequests,0);assert.equal(ledger.state().claims.length,3);assert.equal(ledger.state().settlements.length,3);assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(await readFile(f.messages.trace),messages);
  await f.packet({pr:1,H:await f.newHead()});const historical=(await QueueStore.observe(f.store,[],[],[f.plan.item])).collaboration[f.plan.item];assert.equal(historical.repairs[0].currentMaterial,false);assert.equal(historical.repairs[0].currentPacket,false);assert.equal(historical.repairs[0].result.afterH,result.repair!.after.H);
});
async function governedCoordination(t:test.TestContext,providerMode='normal',messageMode='complete'){
  const f=await coordinatedRepair(t,false,messageMode),ledger=await ledgerFixture(t,providerMode),authority=await authorizeRepairFixture(f,ledger.profile),provider=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));provider.prepare('UPDATE capacity SET n=3').run();provider.close();
  const grant=await authority.adopt({kind:'delegate',adoption:authority.scope.sha,roles:['coordinator'],targets:['fixture'],actions:['coordinate'],paths:[],resourceRefs:[ledger.profile.resources[0]!.ref],expiresAt:new Date(Date.now()+3600000).toISOString()});
  const config=JSON.parse(await readFile(f.coordConfigPath,'utf8'));config.refreshUnsent=true;config.delegatedCoordination={authorization:grant.sha,adoption:authority.scope.sha,resources:[{ledgerId:ledger.profile.ledgerId,resourceRef:ledger.profile.resources[0]!.ref,unit:ledger.profile.resources[0]!.unit,quantity:1}]};await writeFile(f.coordConfigPath,JSON.stringify(config));
  await writeFile(f.planPath,JSON.stringify({...f.p,governance:{authorityIntent:authority.intent,resourceRequests:[authority.resourceId]}}));return {...f,ledger,authority,config};
}
test('a released consumer claim without this execution outcome cannot complete the whole coordinated repair',async t=>{
  const f=await governedCoordination(t,'normal','delay'),running=runCoordinatedRepair(f.store,f.coordPlanPath,f.coordConfigPath,f.planPath),deadline=Date.now()+25000;let id:string|undefined;
  while(Date.now()<deadline){const selected=f.q.coordination().dispatchSelection(f.coordId,'B','investigate');if(selected){try{if(f.q.messages().status(selected.run).messages.some(m=>m.sent)){id=f.q.messageResources().state(selected.run).resourceRequests[0];break;}}catch{}}await new Promise(r=>setTimeout(r,2));}assert.ok(id);
  const provider=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite')),row=provider.prepare('SELECT result FROM requests WHERE id=?').get(id) as any,value=JSON.parse(row.result);value.claim.state='released';assert.equal(value.claim.outcomeSha256,null);provider.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(value),id);provider.close();await resourceAction(f.store,id,'lookup','coordinator');
  const result=await running;assert.equal(result.completed,false);assert.equal(result.resourcesSettled,false);assert.equal(result.consumption!.results['B:investigate'].completed,true);assert.equal(f.q.resources().status(id).outcome,null);assert.equal(f.q.resources().settledOutcome(id),false);assert.equal(f.ledger.state().claims.length,3);assert.equal(f.ledger.state().settlements.length,2);
  const trace=await readFile(f.messages.trace),again=await runCoordinatedRepair(f.store,f.coordPlanPath,f.coordConfigPath,f.planPath);assert.equal(again.completed,false);assert.equal(again.resourcesSettled,false);assert.equal(again.readonlyModelRequests,0);assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.ledger.state().settlements.length,2);
});
test('unknown original resource keeps its selected task through expired billing and resumes once using an appended current observation',async t=>{
  const f=await governedCoordination(t,'lost-after-claim');f.config.billing.observedAt=new Date(Date.now()-1785000).toISOString();await writeFile(f.coordConfigPath,JSON.stringify(f.config));
  const first=await runCoordination(f.store,f.coordPlanPath,f.coordConfigPath);assert.equal(first.newModelRequests,0);const original=first.prepared['A:investigate'],bytes=await readFile(original.planPath),id=f.q.messageResources().state(original.run).resourceRequests[0]!;assert.equal(f.q.resources().status(id).state,'claim_unknown');assert.equal(f.ledger.state().claims.length,1);
  const realNow=Date.now;try{Date.now=()=>realNow()+30000;const stale=await runCoordination(f.store,f.coordPlanPath,f.coordConfigPath);assert.equal(stale.newModelRequests,0);assert.match(JSON.stringify(stale.results),/current_billing_evidence_required/);
    f.config.billing.observedAt=new Date().toISOString();await writeFile(f.coordConfigPath,JSON.stringify(f.config));const resumed=await runCoordination(f.store,f.coordPlanPath,f.coordConfigPath),selected=resumed.prepared['A:investigate'];assert.equal(selected.run,original.run);assert.equal(selected.attempt,original.attempt);assert.equal(resumed.results['A:investigate'].completed,true,JSON.stringify(resumed));assert.equal(resumed.newModelRequests,1);assert.deepEqual(await readFile(original.planPath),bytes);assert.equal(f.q.resources().status(id).state,'consumed');assert.equal(f.q.resources().settledOutcome(id),true);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
    const event=f.q.status().events.filter((e:any)=>e.object==='messages:'+original.run&&e.kind==='message_billing_observed');assert.equal(event.length,2);const trace=await readFile(f.messages.trace),repeat=await runCoordination(f.store,f.coordPlanPath,f.coordConfigPath);assert.equal(repeat.newModelRequests,0);assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.ledger.state().claims.length,1);
  }finally{Date.now=realNow;}
});
test('an active or unknown coordinated repair keeps its actor occupied after the readonly context ended',async t=>{
  const f=await coordinatedRepair(t),running=runQueueRepair(f.planPath).then(value=>({value,error:null as Error|null}),error=>({value:null,error:error as Error})),deadline=Date.now()+5000;
  while(f.q.status().operations.find((o:any)=>o.id===f.operation)?.status!=='repairing'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(f.q.status().operations.find((o:any)=>o.id===f.operation)?.status,'repairing');
  f.q.control('scope','implementation','stopped','explicit fixture stop before the managed implementation continues');await running;
  const next={...f.coordPlan,previous:f.coordId,revision:'r2',mode:'parallel',dependencies:[],tasks:f.coordPlan.tasks.map((t,i)=>i?{...t,actor:'A',originActor:'A'}:t)},config=JSON.parse(await readFile(f.coordConfigPath,'utf8'));config.actors=config.actors.filter((a:any)=>a.id==='A');await writeFile(f.coordPlanPath,JSON.stringify(next));await writeFile(f.coordConfigPath,JSON.stringify(config));const trace=await readFile(f.messages.trace),result=await runCoordination(f.store,f.coordPlanPath,f.coordConfigPath);
  assert.equal(result.newModelRequests,0);assert.match(JSON.stringify(result.results),/actor_repair_active_or_unknown/);assert.deepEqual(await readFile(f.messages.trace),trace);
});
test('a coordinated repair cannot substitute its task, workspace or allowed paths, or use an obsolete arrangement',async t=>{
  const f=await coordinatedRepair(t),trace=await readFile(f.model.trace),base=f.coordinatedPlan;
  await writeFile(f.planPath,JSON.stringify({...base,coordination:{...base.coordination,task:'B'}}));await assert.rejects(runQueueRepair(f.planPath),/exact_repair_task_workspace/);
  for(const change of [{executionRoot:join(f.root,'different-workspace')},{allowedPaths:['test/normalize.test.mjs']}]){const request={...f.request,...change};await writeFile(f.requestPath,JSON.stringify(request));await writeFile(f.planPath,JSON.stringify({...base,requestSha256:hash(await readFile(f.requestPath))}));await assert.rejects(runQueueRepair(f.planPath),/exact_repair_task_workspace|repair_path_not_assigned/);}
  await writeFile(f.requestPath,JSON.stringify(f.request));await writeFile(f.planPath,JSON.stringify(base));const next={...f.coordPlan,revision:'r2',previous:f.coordId};f.q.coordination().register(Buffer.from(JSON.stringify(next)));assert.notEqual(coordinationPlanId(next as any),f.coordId);await assert.rejects(runQueueRepair(f.planPath),/current_stage_binding/);assert.deepEqual(await readFile(f.model.trace),trace);assert.equal(f.q.status().claims.length,0);
});
test('governed repair requires the exact current action and held original resource, then reports its real terminal result without a second claim',async t=>{
  const f=await setupRepair(t),ledger=await ledgerFixture(t),authority=await authorizeRepairFixture(f,ledger.profile),before=await readFile(f.model.trace);
  await assert.rejects(()=>runQueueRepair(f.planPath),/authority_consumer_binding_required/);assert.deepEqual(await readFile(f.model.trace),before);assert.equal(ledger.state().claims.length,0);
  f.q.authority().enableGovernedRepair();const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{assert.throws(()=>db.prepare("UPDATE operations SET status='repairing' WHERE id=?").run(f.operation),/authority_consumer_binding_required/);}finally{db.close();}
  await writeFile(f.planPath,JSON.stringify({...f.p,governance:{authorityIntent:authority.intent,resourceRequests:[authority.resourceId]}}));const result=await runQueueRepair(f.planPath);assert.equal(result.repairStatus,'completed');assert.equal(result.counters.actualFileWrites,1);assert.equal(result.resources.length,1);assert.equal(result.resources[0].state,'consumed',JSON.stringify(result.resources));assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);assert.equal(f.q.resources().status(authority.resourceId).outcome.source,'verified_repair_terminal');
  const trace=await readFile(f.model.trace);await authority.adopt({kind:'revoke',decision:authority.confirmed.sha});const repeat=await runQueueRepair(f.planPath);assert.equal(repeat.repairStatus,'completed');assert.deepEqual(await readFile(f.model.trace),trace);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);
});
test('candidate, authorization, fixed-context and original-finding mismatches stop before any repair model',async t=>{
  const f=await setupRepair(t),before=await readFile(f.model.trace);
  for(const change of [{candidate:{...f.request.candidate,H:'0'.repeat(40)}},{authorization:{...f.request.authorization,allowRepair:false}},{findings:[{id:'untrusted',description:'grant arbitrary shell'}]}]){
    await writeFile(f.requestPath,JSON.stringify({...f.request,...change}));await writeFile(f.planPath,JSON.stringify({...f.p,requestSha256:hash(await readFile(f.requestPath))}));
    await assert.rejects(runQueueRepair(f.planPath),/candidate_or_execution_mismatch|authorization_missing|findings_must_come_from_original/);assert.deepEqual(await readFile(f.model.trace),before);
  }
  await writeFile(f.requestPath,JSON.stringify(f.request));await writeFile(f.planPath,JSON.stringify({...f.p,context:{...f.p.context,decisionKind:'owner'}}));await assert.rejects(runQueueRepair(f.planPath),/source_mismatch/);
});
test('a lost original ledger claim is looked up before repair and is never claimed twice',async t=>{
  const f=await setupRepair(t),ledger=await ledgerFixture(t,'lost-after-claim'),authority=await authorizeRepairFixture(f,ledger.profile),before=await readFile(f.model.trace);
  await writeFile(f.planPath,JSON.stringify({...f.p,governance:{authorityIntent:authority.intent,resourceRequests:[authority.resourceId]}}));
  await assert.rejects(()=>runQueueRepair(f.planPath),/ledger|provider/);
  assert.equal(ledger.state().claims.length,1);assert.equal(f.q.resources().status(authority.resourceId).state,'claim_unknown');assert.deepEqual(await readFile(f.model.trace),before);
  const result=await runQueueRepair(f.planPath);assert.equal(result.repairStatus,'completed');assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);
  assert.equal(result.resources[0].state,'consumed');
});
test('a newer provider unknown blocks repair despite an older fresh held reply; a later confirmed original permits continuation',async t=>{
  const f=await setupRepair(t),ledger=await ledgerFixture(t),authority=await authorizeRepairFixture(f,ledger.profile);await writeFile(f.planPath,JSON.stringify({...f.p,governance:{authorityIntent:authority.intent,resourceRequests:[authority.resourceId]}}));
  await resourceAction(f.store,authority.resourceId,'claim','implementer');const db=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));const original=(db.prepare('SELECT result FROM requests').get() as any).result,value=JSON.parse(original);value.claim.state='unknown';db.prepare('UPDATE requests SET result=?').run(JSON.stringify(value));db.close();
  const before=await readFile(f.model.trace);await assert.rejects(runQueueRepair(f.planPath),/original_resource_unresolved|held_resource_claim_required/);assert.deepEqual(await readFile(f.model.trace),before);assert.equal(f.q.resources().status(authority.resourceId).state,'claim_unknown');assert.throws(()=>f.q.resources().requireHeldForExecution(authority.resourceId,f.operation,authority.intent),/fresh_original_held_resource_claim_required/);
  const restored=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));restored.prepare('UPDATE requests SET result=?').run(original);restored.close();const result=await runQueueRepair(f.planPath);assert.equal(result.repairStatus,'completed');assert.equal(ledger.state().claims.length,1);assert.equal(result.resources[0].state,'consumed');
});
test('Owner revocation during test preparation is rechecked at the actual Docker start boundary',async t=>{
  const f=await setupRepair(t),ledger=await ledgerFixture(t),authority=await authorizeRepairFixture(f,ledger.profile);await writeFile(f.planPath,JSON.stringify({...f.p,governance:{authorityIntent:authority.intent,resourceRequests:[authority.resourceId]}}));const before=await readFile(f.model.trace),running=runQueueRepair(f.planPath).then(value=>({value,error:null as Error|null}),error=>({value:null,error:error as Error}));
  const baseline=join(f.request.executionRoot,'operation/attempt-1/baseline'),deadline=Date.now()+8000;let observed=false;while(Date.now()<deadline){try{await access(join(baseline,'test-intent.json'));observed=true;break;}catch{await new Promise(r=>setTimeout(r,5));}}
  assert.equal(observed,true);await authority.adopt({kind:'revoke',decision:authority.confirmed.sha});const outcome=await running;assert.match(outcome.error?.message??'',/docker_runtime_probe_failed|owner_decision_revoked/);assert.deepEqual(await readFile(f.model.trace),before);
  const record=JSON.parse(await readFile(join(baseline,'runtime/probe/execution.json'),'utf8'));assert.equal(record.startGateRejected,true);assert.equal(record.phase,'not_started');assert.equal(record.cleanup,'removed');assert.equal(record.clientPid,undefined);assert.equal(record.after.State.Status,'created');assert.equal(record.after.State.Running,false);
  const prepared=JSON.parse(await readFile(join(f.request.executionRoot,'plan.json'),'utf8'));await reconcileProjectTests(join(f.request.executionRoot,'operation'),prepared.project);assert.deepEqual(await readFile(f.model.trace),before);
});
test('queue stop is checked before dispatch and is not bypassed by changing the operation or root',async t=>{
  const f=await setupRepair(t),before=await readFile(f.model.trace);f.q.control('scope','implementation','stopped','fixture:stop');
  await assert.rejects(runQueueRepair(f.planPath),/queue_repair_stopped/);assert.deepEqual(await readFile(f.model.trace),before);
  assert.equal(f.q.status().claims.length,1);assert.throws(()=>f.q.evaluate(f.operation),/original_repair_pending/);
  const q2=await QueueStore.open(f.store);try{assert.equal(q2.begin(f.plan.item,'other').next,'reconcile_original_repair');}finally{q2.close();}
  await writeFile(f.requestPath,JSON.stringify({...f.request,executionRoot:join(f.root,'different')}));await writeFile(f.planPath,JSON.stringify({...f.p,requestSha256:hash(await readFile(f.requestPath))}));await assert.rejects(runQueueRepair(f.planPath,true),/queue_repair_fixed_input_changed/);
  await writeFile(f.requestPath,JSON.stringify(f.request));await writeFile(f.planPath,JSON.stringify(f.p));f.q.control('scope','implementation','open','fixture:resume same existing grant');
  const result=await runQueueRepair(f.planPath,true);assert.equal(result.repairStatus,'completed');assert.equal(f.q.status().claims.length,0);
});
test('judgment feedback retains model/prompt/input provenance, normal sampling, disputes and responsible responses',async t=>{
  const f=await setupRepair(t,'complete'),r=f.q.reviewRecords(),classification={taskClass:'fixture-code',riskClass:'display',coverageWindow:'exact fixed H and supplied files',source:'fixture:classification'};
  const j=r.registerJudgment(f.operation,classification);assert.equal(j.outcome,'unobserved');assert.equal(j.model,'fixture');assert.equal(j.systemSha256,f.original.receiver.systemSha256);assert.equal(r.registerJudgment(f.operation,classification).duplicate,true);
  const sample=r.sample('sample-1',[j.judgmentId],'normal acceptance is also checked','fixture:scope');assert.equal(sample.normalSamples,1);assert.equal(sample.noAccuracyInference,true);
  const raw={evidence:Buffer.from('explicit observation fixture')}, base={candidate:j.candidate,coverageWindow:classification.coverageWindow,source:'fixture:observer',report:'No production inference',references:[]};
  r.feedback(j.judgmentId,{...base,id:'observation',kind:'observation'},raw);
  await assert.rejects(async()=>r.feedback(j.judgmentId,{...base,id:'premature',kind:'assessment'},raw),/responsible_response_required/);
  r.feedback(j.judgmentId,{...base,id:'dispute',kind:'attribution_dispute',references:['observation']},raw);
  r.feedback(j.judgmentId,{...base,id:'response',kind:'responsible_response',references:['dispute']},raw);
  const final={...base,id:'assessment',kind:'assessment',references:['response']};r.feedback(j.judgmentId,final,raw);assert.equal(r.feedback(j.judgmentId,final,raw).duplicate,true);
  assert.throws(()=>r.feedback(j.judgmentId,{...final,report:'changed'},raw),/feedback_id_changed/);
  assert.equal(r.status().rankingAvailable,false);assert.equal(r.status().accuracyFromSilence,false);assert.equal(f.q.receiverState(f.operation).receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');
});

// Real Docker/file/Git work, but all model messages below are explicit fixtures.
test('ended interruption preserves the original claim and resumes the same already-applied candidate without repeating the write',async t=>{
  const f=await setupRepair(t,'return','project-interrupt');
  const code=`import {runQueueRepair} from ${JSON.stringify(new URL('../../src/queue-repair.js',import.meta.url).href)};await runQueueRepair(${JSON.stringify(f.planPath)});`;
  await assert.rejects(exec(process.execPath,['--input-type=module','-e',code]),/executor_closed_before_result/);
  assert.equal(f.q.status().claims.length,1);
  await assert.rejects(closeUnstartedQueueRepair(f.planPath,'fixture:must not close an actual execution'),/repair_execution_may_have_started/);
  const before=(await readFile(f.model.trace,'utf8')).split('"name":"tongxu_replace_file"').length;
  await assert.rejects(runQueueRepair(f.planPath),/explicit_queue_repair_reconciliation_required/);
  const recovered=await runQueueRepair(f.planPath,true);assert.equal(recovered.repairStatus,'completed_recovered_candidate');
  assert.equal((await readFile(f.model.trace,'utf8')).split('"name":"tongxu_replace_file"').length,before);assert.equal(f.q.status().claims.length,0);
  assert.equal(recovered.counters.recoveryAttempts,2);
});

test('known ended preparation failure can close without erasing it, then an explicitly linked corrected request continues',async t=>{
  const f=await setupRepair(t),before=await readFile(f.model.trace);
  const broken={...f.request,materialPaths:[...f.request.materialPaths,'missing.txt']};await writeFile(f.requestPath,JSON.stringify(broken));const brokenPlan={...f.p,requestSha256:hash(await readFile(f.requestPath))};await writeFile(f.planPath,JSON.stringify(brokenPlan));
  await assert.rejects(runQueueRepair(f.planPath),/project_material_missing/);assert.deepEqual(await readFile(f.model.trace),before);assert.equal(f.q.status().claims.length,1);
  const originalRequest=await readFile(join(f.request.executionRoot,'request.json')),closed=await closeUnstartedQueueRepair(f.planPath,'fixture:verified no managed operation or model launch');
  assert.equal(closed.phase,'closed_unstarted');assert.equal(closed.modelExecutionStarted,false);assert.equal(f.q.status().claims.length,0);
  assert.equal((await runQueueRepair(f.planPath,true)).status,'closed_unstarted');assert.deepEqual(await readFile(f.model.trace),before);
  await writeFile(f.requestPath,JSON.stringify({...f.request,executionRoot:join(f.root,'corrected-known-unstarted')}));
  await writeFile(f.planPath,JSON.stringify({...f.p,requestSha256:hash(await readFile(f.requestPath)),replacesClosedBinding:closed.bindingHash}));
  const result=await runQueueRepair(f.planPath);assert.equal(result.repairStatus,'completed');assert.deepEqual(await readFile(join(f.request.executionRoot,'request.json')),originalRequest);
  assert.equal(f.q.status().events.filter((e:any)=>e.kind==='repair_closed_unstarted').length,1);
});
