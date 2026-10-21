import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {memberRepairFixture} from './repair-fixture.js';
import {raw} from '../integration/fixture.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {runMemberRecomposition} from '../../src/member-recomposition.js';
import {Snapshot,hash} from '../../src/snapshot.js';
import {DockerRuntime} from '../../src/docker-sandbox.js';

function stop(f:Awaited<ReturnType<typeof memberRepairFixture>>){return spawnSync(process.execPath,[new URL('../../src/cli.js',import.meta.url).pathname,'queue','control','--store',f.store,'--scope',f.context.scope.id,'--kind','investment','--state','stopped','--source','Explicit independent local CLI before recomposition effect'],{encoding:'utf8',timeout:5000});}
test('IMR-F04: the queue keeps its write transaction through the actual effect callback',async t=>{
  const f=await memberRepairFixture(t);let called=false;f.q.memberRecompositionEffect(f.memberReturn,()=>{called=true;const competing=stop(f);assert.notEqual(competing.status,0);});assert.equal(called,true);assert.equal(f.q.status().controls.some((c:any)=>c.scope===f.context.scope.id&&c.kind==='investment'&&c.stopped===1),false);const committed=stop(f);assert.equal(committed.status,0,committed.stderr);called=false;assert.throws(()=>f.q.memberRecompositionEffect(f.memberReturn,()=>{called=true;}),/member_recomposition_stopped/);assert.equal(called,false);
});
test('IMR-F04: a second CLI stop before a non-probe Docker start prevents the actual container process',async t=>{
  const f=await memberRepairFixture(t),repair=await runQueueRepair(f.planPath),path=join(f.root,'new-member'),at=new Date().toISOString(),s=await Snapshot.create(path,'fixture/reception',10,[],[]);s.manifest.candidate={repository:'fixture/reception',pr:10,H:repair.after.H,B:f.B,targetRef:'fixture',mergeBase:f.B,observedAt:at};await s.artifact(raw({explicitFixture:true,H:repair.after.H,B:f.B,actualGitHubPublication:false}),{kind:'pr',round:1,retrievedAt:at,provenance:'explicit-local-fixture',status:200});s.manifest.rounds.push({number:1,startedAt:at,finishedAt:at,coverage:{},sources:[],notes:[],gaps:[],limitations:['explicit_fixture'],current:true});await s.save();await s.close();
  const plan={schemaVersion:1,kind:'tongxu-member-recomposition',id:'stop-recomposition',store:f.store,memberReturn:f.memberReturn,repairPlan:{path:f.planPath,sha256:hash(await readFile(f.planPath))},newMember:{path,sha256:hash(await readFile(join(path,'manifest.json')))},testPlan:{path:join(f.root,'units-test.json'),sha256:hash(await readFile(join(f.root,'units-test.json')))},source:'Explicit final-effect stop fixture; no real model or remote resource'},entry=join(f.root,'stop-recomposition.json');await writeFile(entry,raw(plan));
  const original=DockerRuntime.prototype.run;let injected=false,record='';DockerRuntime.prototype.run=function(o){const gate=o.startGate;if(gate?.start&&!o.directory.endsWith('/probe')){const start=gate.start;o={...o,startGate:{...gate,start:effect=>{if(!injected){injected=true;record=join(o.directory,'execution.json');const stopped=stop(f);assert.equal(stopped.status,0,stopped.stderr);}return start(effect);}}};}return original.call(this,o);};t.after(()=>{DockerRuntime.prototype.run=original;});const trace=await readFile(f.model.trace);await assert.rejects(runMemberRecomposition(entry),/member_recomposition_original_verification_incomplete|member_recomposition_stopped/);assert.equal(injected,true);const execution=JSON.parse(await readFile(record,'utf8'));assert.equal(execution.phase,'not_started');assert.equal(execution.startGateRejected,true);assert.equal(execution.reason,'member_recomposition_stopped');assert.equal(Object.hasOwn(execution,'clientPid'),false);assert.ok((await readFile(f.model.trace)).equals(trace));
});
