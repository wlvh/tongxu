import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {coordinatedRepair} from '../review-records/queue-repair-fixture.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import type {ConditionalEntryPlan} from '../../src/conditional-entry-contract.js';

test('the same normal entry derives an ordinary original RETURN repair while an exact downstream task waits for its actual candidate',async t=>{
 const f=await coordinatedRepair(t,false),plan={...f.coordPlan,revision:'normal-entry',previous:f.coordId,tasks:f.coordPlan.tasks.map(t=>t.id==='B'?{...t,stages:['investigate','implement'] as typeof t.stages}:t)};
 // Original prepare-only requests are kept; no actor was sent or taken over.
 const planPath=join(f.root,'normal-individual-coordination.json');await writeFile(planPath,canonical(plan));f.q.coordination().register(Buffer.from(canonical(plan)));
 const ref=async(path:string)=>({path,sha256:hash(await readFile(path))}),p=f.request,profilePath=join(f.root,'normal-individual-repair-capability.json');await writeFile(profilePath,canonical({schemaVersion:1,kind:'tongxu-conditional-repair-capability',objects:p.objects,allowedPaths:p.allowedPaths,materialPaths:p.materialPaths,protectedPaths:p.protectedPaths,contract:p.contract,testPlan:{path:p.testPlan,sha256:p.testPlanSha256},config:await ref(f.model.configPath),authorization:p.authorization,demonstrationFixture:true,generatedDirectories:[]}));
 const entry:ConditionalEntryPlan={schemaVersion:1,kind:'tongxu-conditional-delivery-entry',id:'normal-individual-return',title:'Original individual repair with exact downstream consumption',store:f.store,repository:'fixture/reception',target:'fixture',coordination:{plan:await ref(planPath),execution:await ref(f.coordConfigPath)},repairs:[{task:'A',profile:await ref(profilePath),authorization:null}],integration:{item:f.plan.item,members:['A','B'],gateStage:'implement',objects:f.request.objects,selectionReason:'No current combination exists in this fixture; it must not block the independent original repair.',authorization:null,testPlan:await ref(f.request.testPlan),receiverTemplate:await ref(f.path),receiverAuthorization:null,sourceReader:{repositoryId:1,ghExecutable:f.plan.claudeExecutable,ghSha256:hash(await readFile(f.plan.claudeExecutable)),issues:[],executionKind:'fixture'}}};
 const path=join(f.root,'normal-individual-entry.json');await writeFile(path,canonical(entry));const execute=promisify(execFile),cli=fileURLToPath(new URL('../../src/conditional-entry-cli.js',import.meta.url)),run=async(action:string,...args:string[])=>JSON.parse((await execute(process.execPath,[cli,action,'--entry',path,...args],{cwd:f.root,timeout:60000,maxBuffer:16*1024*1024})).stdout);
 await run('prepare');const before=await run('investigate');assert.equal(before.results['A:investigate'].completed,true);assert.equal(before.prepared['B:investigate'],undefined);
 const result=await run('repair','--task','A');assert.equal(result.operation,f.operation);assert.equal(result.result.repairStatus,'completed');assert.equal(result.result.counters.actualFileWrites,1);assert.notEqual(result.result.after.H,f.H);assert.equal(f.q.reviewRecords().state(result.operation).repair.memberReturn,undefined);
 const trace=await readFile(f.model.trace);assert.equal((await run('repair','--task','A')).result.duplicate,true);assert.deepEqual(await readFile(f.model.trace),trace);
 const consumed=await run('investigate');assert.equal(consumed.results['B:investigate'].completed,true);assert.ok((await run('report')).reports.some((r:any)=>r.kind==='repair'&&r.complete&&r.result.originalResult.after.H===result.result.after.H));await assert.rejects(()=>run('integrate'),/conditional_entry_integration_source_changed/);assert.deepEqual(await readFile(f.model.trace),trace);
});
