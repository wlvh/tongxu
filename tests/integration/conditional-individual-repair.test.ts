import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {coordinatedRepair} from '../review-records/queue-repair-fixture.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {runReception} from '../../src/receiver.js';
import {git} from '../../src/repair-workspace.js';
import {DatabaseSync} from 'node:sqlite';
import type {ConditionalEntryPlan} from '../../src/conditional-entry-contract.js';

async function ordinaryEntry(t:test.TestContext){
 const f=await coordinatedRepair(t,false,'complete',false,'project-rounds'),plan={...f.coordPlan,revision:'normal-entry',previous:f.coordId,tasks:f.coordPlan.tasks.map(t=>t.id==='B'?{...t,stages:['investigate','implement'] as typeof t.stages}:t)};
 // Original prepare-only requests are kept; no actor was sent or taken over.
 const planPath=join(f.root,'normal-individual-coordination.json');await writeFile(planPath,canonical(plan));f.q.coordination().register(Buffer.from(canonical(plan)));
 const ref=async(path:string)=>({path,sha256:hash(await readFile(path))}),p=f.request,profilePath=join(f.root,'normal-individual-repair-capability.json');await writeFile(profilePath,canonical({schemaVersion:1,kind:'tongxu-conditional-repair-capability',objects:p.objects,allowedPaths:p.allowedPaths,materialPaths:p.materialPaths,protectedPaths:p.protectedPaths,contract:p.contract,testPlan:{path:p.testPlan,sha256:p.testPlanSha256},config:await ref(f.model.configPath),authorization:p.authorization,demonstrationFixture:true,generatedDirectories:[]}));
 const entry:ConditionalEntryPlan={schemaVersion:1,kind:'tongxu-conditional-delivery-entry',id:'normal-individual-return',title:'Original individual repair with exact downstream consumption',store:f.store,repository:'fixture/reception',target:'fixture',coordination:{plan:await ref(planPath),execution:await ref(f.coordConfigPath)},repairs:[{task:'A',profile:await ref(profilePath),authorization:null}],integration:{item:f.plan.item,members:['A','B'],gateStage:'implement',objects:f.request.objects,selectionReason:'No current combination exists in this fixture; it must not block the independent original repair.',authorization:null,testPlan:await ref(f.request.testPlan),receiverTemplate:await ref(f.path),receiverAuthorization:null,sourceReader:{repositoryId:1,ghExecutable:f.plan.claudeExecutable,ghSha256:hash(await readFile(f.plan.claudeExecutable)),issues:[],executionKind:'fixture'}}};
 const path=join(f.root,'normal-individual-entry.json');await writeFile(path,canonical(entry));const execute=promisify(execFile),cli=fileURLToPath(new URL('../../src/conditional-entry-cli.js',import.meta.url)),run=async(action:string,...args:string[])=>JSON.parse((await execute(process.execPath,[cli,action,'--entry',path,...args],{cwd:f.root,timeout:60000,maxBuffer:16*1024*1024})).stdout);
 return {f,run,profilePath};
}

test('the same normal entry derives an ordinary original RETURN repair while an exact downstream task waits for its actual candidate',async t=>{
 const {f,run}=await ordinaryEntry(t);
 await run('prepare');const before=await run('investigate');assert.equal(before.results['A:investigate'].completed,true);assert.equal(before.prepared['B:investigate'],undefined);
 const result=await run('repair','--task','A');assert.equal(result.operation,f.operation);assert.equal(result.result.repairStatus,'completed');assert.equal(result.result.counters.actualFileWrites,1);assert.notEqual(result.result.after.H,f.H);assert.equal(f.q.reviewRecords().state(result.operation).repair.memberReturn,undefined);
 const trace=await readFile(f.model.trace);assert.equal((await run('repair','--task','A')).result.duplicate,true);assert.deepEqual(await readFile(f.model.trace),trace);
 const consumed=await run('investigate');assert.equal(consumed.results['B:investigate'].completed,true);assert.ok((await run('report')).reports.some((r:any)=>r.kind==='repair'&&r.complete&&r.result.originalResult.after.H===result.result.after.H));await assert.rejects(()=>run('integrate'),/conditional_entry_integration_source_changed/);assert.deepEqual(await readFile(f.model.trace),trace);
});

for(const kind of ['external','committed'])test('normal entry distinguishes a second current RETURN and original responsibility: '+kind,async t=>{
 const {f,run,profilePath}=await ordinaryEntry(t);
 await run('prepare');await run('investigate');const first=await run('repair','--task','A');
 assert.equal(first.result.repairStatus,'completed');const originalPlan=await readFile(first.repairPlan),firstState=f.q.reviewRecords().state(first.operation).repair,firstTrace=await readFile(f.model.trace);
 const originalDb=new DatabaseSync(join(f.store,'queue.sqlite')),originalRaw=(originalDb.prepare('SELECT result FROM operations WHERE id=?').get(first.operation) as any).result,originalUnknown=JSON.parse(originalRaw);originalUnknown.repair.phase='unknown';originalUnknown.repair.controllerReturned=false;originalDb.prepare("UPDATE operations SET status='repairing',result=? WHERE id=?").run(JSON.stringify(originalUnknown),first.operation);await assert.rejects(()=>run('repair','--task','A'),/explicit_queue_repair_reconciliation_required|original_queue_repair_controller_active_or_unknown/);originalDb.prepare("UPDATE operations SET status='complete',result=? WHERE id=?").run(originalRaw,first.operation);originalDb.close();assert.deepEqual(await readFile(f.model.trace),firstTrace);
 // H alone cannot identify a RETURN: a new material packet on the same H
 // must wait on its own source rather than report the old completed repair.
 const material=await f.packet({H:f.H}),receiverPath=join(f.root,'followup-receiver.json');
 await writeFile(receiverPath,canonical({...f.plan,item:material.item}));const materialReturn=await runReception(receiverPath);assert.notEqual(materialReturn.operation,first.operation);
 await run('refresh');await run('investigate');const materialWait=await run('repair','--task','A');assert.equal(materialWait.phase,'waiting_for_current_repair');assert.equal(materialWait.current.operation,materialReturn.operation);assert.equal(materialWait.waiting,'conditional_entry_current_candidate_requires_original_handoff');assert.equal(materialWait.result,undefined);assert.deepEqual(await readFile(f.model.trace),firstTrace);
 const H=kind==='external'?await f.newHead():first.result.after.H;
 if(kind==='committed')await git(f.plan.objects,['fetch','--no-tags',join(f.request.executionRoot,'workspace'),H]);
 const next=await f.packet({H});await run('refresh');await assert.rejects(()=>run('repair','--task','A'),/conditional_entry_real_return_required/);
 await writeFile(receiverPath,canonical({...f.plan,item:next.item}));const current=await runReception(receiverPath);assert.equal(current.receiver.judgment.verdict,'RETURN_FOR_WORK');await run('investigate');
 if(kind==='external'){
  const waited=await run('repair','--task','A');assert.equal(waited.current.operation,current.operation);assert.equal(waited.current.candidate.H,H);assert.equal(waited.waiting,'conditional_entry_current_candidate_requires_original_handoff');assert.equal(waited.result,undefined);assert.deepEqual(await readFile(f.model.trace),firstTrace);
 }else{
  const db=new DatabaseSync(join(f.store,'queue.sqlite')),raw=(db.prepare('SELECT result FROM operations WHERE id=?').get(first.operation) as any).result;
  const unknown=JSON.parse(raw);unknown.repair.phase='unknown';unknown.repair.controllerReturned=false;db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(unknown),first.operation);
  assert.equal((await run('repair','--task','A')).waiting,'conditional_entry_original_repair_requires_reconciliation');db.prepare('UPDATE operations SET result=? WHERE id=?').run(raw,first.operation);
  const unsettled=JSON.parse(raw);unsettled.repair.resourceRequests=['0'.repeat(64)];db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(unsettled),first.operation);assert.equal((await run('repair','--task','A')).waiting,'continuation_original_resources_unsettled');db.prepare('UPDATE operations SET result=? WHERE id=?').run(raw,first.operation);db.close();
  const terminal=join(f.request.executionRoot,'operation/terminal-record.json'),saved=await readFile(terminal);await writeFile(terminal,'{}');assert.equal((await run('repair','--task','A')).waiting,'handoff_original_terminal_changed');await writeFile(terminal,saved);
  const lease=join(f.request.executionRoot,'workspace/.git/tongxu-writer.json');await writeFile(lease,'{}');assert.equal((await run('repair','--task','A')).waiting,'continuation_original_state_changed_or_occupied');await rm(lease);
  assert.deepEqual(await readFile(f.model.trace),firstTrace);
  const second=await run('repair','--task','A');assert.equal(second.operation,current.operation);assert.equal(second.result.repairStatus,'completed');assert.notEqual(second.result.after.H,H);assert.equal(second.result.counters.actualFileWrites,1);
  const plan=JSON.parse(await readFile(second.repairPlan,'utf8')),request=JSON.parse(await readFile(plan.request,'utf8'));assert.equal(plan.continuation.operation,first.operation);assert.equal(request.objects,join(f.request.executionRoot,'workspace'));assert.notEqual(request.executionRoot,f.request.executionRoot);assert.equal(f.q.coordination().continuation(second.operation)?.adoptedH,H);const frozenConfig=await readFile(plan.config);assert.throws(()=>f.q.coordination().repairGate(second.operation,{plan:Buffer.from(canonical(plan)),request:Buffer.from(canonical({...request,executionRoot:join(f.root,'arbitrary-successor')})),config:frozenConfig}),/conditional_entry_exact_successor_workspace_required/);
  const relation=(await run('state')).coordination.id,step=f.q.coordination().normalEntryTaskStep(relation,'normal-individual-return','repair','A')!,{sourceSha256:_source,...legacyReference}=step.reference;
  f.q.coordination().normalEntryStep(relation,'normal-individual-return','repair-A',step.request,legacyReference);
  const secondTrace=await readFile(f.model.trace);assert.equal((await run('repair','--task','A')).operation,current.operation);assert.equal((await run('repair','--task','A')).result.duplicate,true);assert.deepEqual(await readFile(f.model.trace),secondTrace);
  await rm(profilePath);await rm(f.model.configPath);assert.equal((await run('repair','--task','A')).result.duplicate,true);assert.deepEqual(await readFile(f.model.trace),secondTrace);
  const reports=(await run('report')).reports.filter((r:any)=>r.kind==='repair'&&r.complete);assert.ok(reports.some((r:any)=>r.result.operation===first.operation));assert.ok(reports.some((r:any)=>r.result.operation===second.operation));
 }
 assert.deepEqual(await readFile(first.repairPlan),originalPlan);assert.equal(f.q.reviewRecords().state(first.operation).repair.resultSha256,firstState.resultSha256);
 if(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE)await cp(f.root,join(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE,'ordinary-'+kind),{recursive:true});
});
