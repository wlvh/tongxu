import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,access,cp } from 'node:fs/promises';
import { join,basename } from 'node:path';
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

export async function setupRepair(t: test.TestContext, mode='return', modelMode='project') {
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
export async function coordinatedRepair(t:test.TestContext,start=true,messageMode='complete',reverseOwners=false){
  const f=await setupRepair(t),messages=await messageFixture(t,messageMode),other=await f.packet({pr:2,H:f.H});
  let script=await readFile(messages.codex,'utf8');script=script.replace("report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId","report:JSON.stringify((()=>{const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),task=x.body.split('\\n')[0].slice(18);return {kind:'tongxu-coordination-feedback',task,revision:c.revision,parts:[],report:'Explicit fixture consumed '+c.outputs.map(o=>o.sha256).join(',')};})())");await writeFile(messages.codex,script);
  const plan={schemaVersion:1,kind:'tongxu-task-coordination',name:'coordinated-repair-fixture',revision:'r1',previous:null,source:'Explicit test: new managed workspace after original readonly task, no external writer takeover',authorityIntent:null,mode:'stage_serial',actors:[{id:'A',tool:'codex'},{id:'B',tool:'codex'}],tasks:[{id:'A',item:f.plan.item,actor:'A',originActor:'A',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:f.request.allowedPaths,workspace:join(f.request.executionRoot,'workspace'),publishBranch:'fixture-repair-A',outputs:[{id:'fixed-label',stage:'implement',kind:'repair_candidate'}]},{id:'B',item:other.item,actor:'B',originActor:'B',dispatch:'owner_backlog',stages:['investigate'],independentPaths:[],workspace:null,publishBranch:null,outputs:[]}],shared:[],dependencies:[{task:'B',stage:'investigate',producer:'A',capability:'fixed-label'}]};
  if(reverseOwners)for(const task of plan.tasks){task.actor=task.originActor=task.id==='A'?'B':'A';}
  const config={schemaVersion:1,kind:'tongxu-coordination-readonly-execution',source:'Explicit fixture processes; no real models',executionKind:'fixture',actors:['A','B'].map(id=>({id,tool:'codex',executable:messages.codex,executableSha256:hash(script),disabledMcpServers:[],allowedInstructionSources:[]})),taskBodies:{A:'Review the scoped label contract before a new managed repair workspace is prepared.',B:'Read the actual repaired candidate, code diff, tests and independent report from A.'},authorityIntents:{A:null,B:null},billing:messages.plan.billing,timeoutMs:1000,refreshUnsent:false};
  const planPath=join(f.root,'coordination.json'),configPath=join(f.root,'coordination-execution.json');await writeFile(planPath,JSON.stringify(plan));await writeFile(configPath,JSON.stringify(config));
  const first=await runCoordination(f.store,planPath,configPath,!start);assert.equal(first.newModelRequests,start?1:0);if(start)assert.equal(first.results['A:investigate'].completed,true,JSON.stringify(first.errors));assert.equal(first.prepared['B:investigate'],undefined);
  const from=first.prepared['A:investigate'],p={...f.p,coordination:{planId:first.coordination,task:'A',capability:'fixed-label',fromRun:from.run,fromMessage:from.messageId}};await writeFile(f.planPath,JSON.stringify(p));
  return {...f,messages,coordPlan:plan,coordPlanPath:planPath,coordConfigPath:configPath,coordId:first.coordination,coordinatedPlan:p};
}
