import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {coordinatedRepair} from '../review-records/queue-repair-fixture.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {runCoordination} from '../../src/coordination.js';
import {taskMain} from '../../src/task-cli.js';
import {workTaskOwner} from '../../src/tasks.js';
import type {TaskOwnerRequest} from '../../src/task-inbox.js';
import {parseDevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {git} from '../../src/repair-workspace.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';

// A real local child uses the existing managed repair tools. Only the model
// protocol is a fixture. Hold it after an acknowledged write so the new task
// observes an actually active writer, not a manufactured occupancy record.
test('new B investigates A actual uncommitted shared edit while original managed writer remains active; neither can continue shared implementation',async t=>{
  const hooks:Array<()=>unknown>=[],owned={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext;
  const f=await coordinatedRepair(owned),keep=process.env.TONGXU_ACTIVE_WRITER_EVIDENCE;
  t.after(async()=>{
    if(keep){await mkdir(keep,{recursive:true});await writeFile(join(keep,basename(f.root)+'.json'),JSON.stringify({root:f.root,store:f.store,modelRoot:f.model.root,messageRoot:f.messages.root,officialModels:0,originalsPreservedInPlace:true},null,2)+'\n');f.q.close();f.messages.q.close();}
    else for(const fn of hooks.reverse())await fn();
  });
  const marker=f.model.trace+'.write-held',release=f.model.trace+'.release';
  // Install the existing task schema before execution. Migrating a queue
  // with an active writer is intentionally forbidden by the product.
  await taskMain(['enable','--store',f.store]);
  const script=await readFile(f.model.config.codexExecutable,'utf8'),needle="else if(stage==='tongxu_replace_file'){";
  assert.ok(script.includes(needle));
  await writeFile(f.model.config.codexExecutable,script.replace(needle,needle+`fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,at:new Date().toISOString(),acknowledgedWrite:v}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);tool('tongxu_run_tests',{});}},20);return;`));
  const config={...f.model.config,timeoutMs:60000};await writeFile(f.model.configPath,JSON.stringify(config));
  await writeFile(f.planPath,JSON.stringify({...f.coordinatedPlan,configSha256:hash(await readFile(f.model.configPath))}));
  const running=runQueueRepair(f.planPath).then(value=>({value,error:null as string|null}),error=>({value:null,error:(error as Error).message}));
  let proof:any,ended:Awaited<typeof running>|undefined;
  try{
    const deadline=Date.now()+45000;let held:any;
    while(Date.now()<deadline){try{held=JSON.parse(await readFile(marker,'utf8'));break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,10));}
    assert.ok(held,'original managed writer did not reach its acknowledged file write');process.kill(held.pid,0);
    const workspace=join(f.request.executionRoot,'workspace'),path=join(workspace,'src/normalize.mjs'),dirty=await readFile(path),index=await readFile(join(workspace,'.git/index')),indexMtime=(await stat(join(workspace,'.git/index'))).mtimeMs;
    assert.match(dirty.toString(),/Untitled/);assert.equal(await git(workspace,['rev-parse','HEAD']),f.H);
    const active=f.q.status().operations.find((o:any)=>o.id===f.operation);assert.equal(active.status,'repairing');assert.ok(f.q.status().claims.some((c:any)=>c.operation===f.operation));
    const lease=await readFile(join(workspace,'.git/tongxu-writer.json'));
    const definition=parseDevelopmentTask(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-development-task',id:'new-b-during-a-write',repository:'fixture/reception',title:'Explicit fixture B investigates shared uncommitted label behavior',goal:'Inspect the existing dirty bytes; do not overwrite or take over A.',acceptance:['Return the actual observed bytes and retain unknown shared agreement'],source:'Explicit V01 local integration fixture',issue:null,context:f.evidence.context,workspace,base:f.request.candidate.B,target:f.request.candidate.target,paths:['src/normalize.mjs']})));
    const observation=await observeTaskWorkspace(definition),b=f.q.tasks().observe(definition,observation);
    assert.equal(observation.files[0]!.text,dirty.toString());assert.notEqual(observation.headFiles![0]!.sha256,observation.files[0]!.sha256);assert.equal(observation.indexObserved,false);
    const plan:CoordinationPlan={...f.coordPlan as CoordinationPlan,revision:'r2',previous:f.coordId,mode:'parallel',source:'Explicit fixture: new B arrives while A is still writing; shared work needs B feedback, A responsibility stays A.',tasks:[{...f.coordPlan.tasks[0] as CoordinationPlan['tasks'][number],independentPaths:[]},{id:'B',item:b.item,actor:'B',originActor:'B',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:[],workspace:null,publishBranch:null,outputs:[]}],shared:[{id:'label-contract',tasks:['A','B'],paths:['src/normalize.mjs'],contract:'A owns the in-flight edit; B may inspect it but shared implementation waits for agreement.',feedbackFrom:['B'],blockedStages:['implement']}],dependencies:[]};
    const nextPlan=join(f.root,'new-b-coordination.json'),nextConfig=join(f.root,'new-b-execution.json');await writeFile(nextPlan,canonical(plan));
    const messageScript=await readFile(f.messages.codex,'utf8'),changed=messageScript.replace("parts:[],report:'Explicit fixture consumed '","parts:c.shared.filter(p=>p.feedbackFrom.includes(task)).map(p=>({id:p.id,hash:p.hash,position:'unknown',report:'Explicit fixture: A remains active; this investigation does not grant shared writing.'})),report:'Explicit fixture consumed '").replace("task=x.body.split('\\n')[0].slice(18)","task=x.material.some(m=>m.name==='task-owner-context.json')?c.tasks.find(t=>t.item===JSON.parse(x.material.find(m=>m.name==='task-owner-context.json').text).task.item).id:x.body.split('\\n')[0].slice(18)");assert.notEqual(changed,messageScript);await writeFile(f.messages.codex,changed);
    const next={...JSON.parse(await readFile(f.coordConfigPath,'utf8')),actors:[{id:'A',tool:'codex',executable:f.messages.codex,executableSha256:hash(changed),disabledMcpServers:[],allowedInstructionSources:[]},{id:'B',tool:'codex',executable:f.messages.codex,executableSha256:hash(changed),disabledMcpServers:[],allowedInstructionSources:[]}],taskBodies:{A:'Keep original A responsibility; never start another writer.',B:'Inspect the supplied raw working bytes and committed bytes for normalizeLabel. Preserve the existing A writer and return unknown agreement.'},timeoutMs:3000};await writeFile(nextConfig,JSON.stringify(next));
    const refused=await runCoordination(f.store,nextPlan,nextConfig);await writeFile(join(f.root,'new-task-direct-route-refused.json'),JSON.stringify(refused,null,2)+'\n');
    assert.equal(refused.newModelRequests,0);assert.match(JSON.stringify(refused.results['A:investigate']),/coordination_actor_repair_active_or_unknown/);assert.match(JSON.stringify(refused.results['B:investigate']),/task_registered_owner_dispatch_required/);
    // Development tasks use their existing owner inbox. The generic PR
    // coordination entry must not bypass that original responsibility gate.
    const request:TaskOwnerRequest={schemaVersion:1,kind:'tongxu-task-owner-request',id:'inspect-dirty-original',task:b.item,source:'Explicit V01 task owner fixture',question:next.taskBodies.B,from:null,participant:{...next.actors[1]!,tool:'codex',item:b.item,role:'issue_owner',parent:null},executionKind:'fixture',authorityIntent:null,billing:next.billing,timeoutMs:3000};
    f.q.taskInbox().enqueue(Buffer.from(canonical(request)));const investigation=await workTaskOwner(f.store,b.item);
    await writeFile(join(f.root,'new-b-owner-investigation.json'),JSON.stringify(investigation,null,2)+'\n');assert.equal(investigation.newModelRequests,1);assert.equal(investigation.runs[0]?.completed,true,JSON.stringify(investigation));assert.equal(investigation.pending.length,0);
    const selected=investigation.runs[0]!,submitted=f.q.messages().submitted(selected.run,'B');assert.equal(submitted.length,1);assert.ok(JSON.stringify(submitted[0]).includes('Untitled'));
    const shared=f.q.coordination().stage(refused.coordination,'B','implement');assert.ok(shared.blockers.includes('shared_feedback:label-contract:B:unknown'));assert.equal(shared.executionAuthorized,false);
    process.kill(held.pid,0);assert.deepEqual(await readFile(path),dirty);assert.deepEqual(await readFile(join(workspace,'.git/index')),index);assert.equal((await stat(join(workspace,'.git/index'))).mtimeMs,indexMtime);assert.deepEqual(await readFile(join(workspace,'.git/tongxu-writer.json')),lease);
    await assert.rejects(runQueueRepair(f.planPath),/original_queue_repair_controller_active_or_unknown|repair_controller_active|new_arrangement_requires_current_stage_binding/);
    proof={schemaVersion:1,executionKind:'fixture',officialModels:0,originalOperation:f.operation,originalTask:f.plan.item,newTask:b.item,originalCoordination:f.coordId,newCoordination:refused.coordination,writer:held,originalHead:f.H,workingSha256:hash(dirty),indexSha256:hash(index),indexMtime,leaseSha256:hash(lease),observation,refused,investigation,sharedStage:shared,originalWriterWasLiveBeforeAndAfterB:true,originalDirtyBytesIndexAndLeasePreserved:true};
    await writeFile(join(f.root,'active-writer-new-task-before-release.json'),JSON.stringify(proof,null,2)+'\n');
  }finally{await writeFile(release,'Explicit fixture releases its own paused child after inspection.\n');ended=await running;}
  assert.match(ended.error??JSON.stringify(ended.value),/new_arrangement_requires_current_stage_binding/);
  assert.equal((await readFile(f.model.trace,'utf8')).split('\n').filter(x=>x.includes('"name":"tongxu_replace_file"')).length,1);
  assert.equal(hash(await readFile(join(f.request.executionRoot,'workspace/src/normalize.mjs'))),proof.workingSha256);
  const before=await readFile(f.messages.trace),repeat=await workTaskOwner(f.store,proof.newTask);assert.equal(repeat.newModelRequests,0);assert.deepEqual(await readFile(f.messages.trace),before);
  await writeFile(join(f.root,'active-writer-new-task-verification.json'),JSON.stringify({...proof,originalWriterEnded:ended,sharedContinuationRejectedByActualExecutor:true,repeatedInvestigationNewInputs:0,originalWrites:1,newWriterLaunched:false,manualReportCopyRequired:false},null,2)+'\n');
});
