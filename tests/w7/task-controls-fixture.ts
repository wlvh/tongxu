import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {taskMain} from '../../src/task-cli.js';
import {parseDevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import type {TaskOwnerRequest} from '../../src/task-inbox.js';
import {TaskControls} from '../../src/task-controls.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

export async function controlFixture(t:test.TestContext,mode='complete'){
  const f=await messageFixture(t,mode);await taskMain(['enable','--store',f.store]);const original=f.q.status().items.find((i:any)=>i.id===f.item),definition=parseDevelopmentTask(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-development-task',id:'controlled-task',repository:'fixture/reception',title:'直接联系夹具',goal:'核查 sample.js 的固定契约',acceptance:['保留实际完整结果'],source:'explicit task-control fixture',issue:null,context:original.context,workspace:join(f.root,'objects'),base:original.candidate.B,target:original.candidate.targetRef,paths:['sample.js']}))),observed=f.q.tasks().observe(definition,await observeTaskWorkspace(definition)),task=observed.item,current=f.q.tasks().current(task);
  const request:TaskOwnerRequest={schemaVersion:1,kind:'tongxu-task-owner-request',id:'configured-contact',task,source:'explicit fixture operator prepared contact',question:'核对固定代码，说明证据与仍然存在的缺口。',from:null,participant:{...f.plan.participants[0]!,id:'original-owner',item:task,role:'issue_owner',parent:null},executionKind:'fixture',authorityIntent:null,billing:f.plan.billing,timeoutMs:500},requestPath=join(f.root,'contact-request.json');
  await writeFile(requestPath,canonical(request));const sources=[{id:'task',title:'直接联系夹具',store:f.store,item:task}],catalog={schemaVersion:1 as const,kind:'tongxu-task-controls' as const,contacts:[{id:'contact',title:'核对实际代码',source:'task',packet:current.packet,sourceSha256:current.fingerprint,request:{path:requestPath,sha256:hash(await readFile(requestPath))}}]},catalogPath=join(f.root,'task-controls.json');
  const load=async()=>{await writeFile(catalogPath,canonical(catalog));return TaskControls.load(catalogPath,hash(await readFile(catalogPath)),sources);};const controls=await load();t.after(()=>controls.drain());
  const plan={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'可执行工作台夹具',goal:'实际派发与回读；模型为明确夹具。',sources,controls:{path:catalogPath,sha256:hash(await readFile(catalogPath))}},planPath=join(f.root,'controlled-workbench.json');await writeFile(planPath,canonical(plan));
  return {...f,definition,task,request,requestPath,sources,catalog,catalogPath,controls,load,plan,planPath};
}
