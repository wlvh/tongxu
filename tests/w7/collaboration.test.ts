import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from '../w6/message-fixture.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {runMessages} from '../../src/messages.js';
import {startWorkbench} from '../../src/workbench.js';
import {observeTask} from '../../src/secretary-tools.js';
import {QueueStore} from '../../src/queue-store.js';
import {coordinationPlanId} from '../../src/coordination-contract.js';
import {hash} from '../../src/snapshot.js';

async function app(t:test.TestContext,f:Awaited<ReturnType<typeof messageFixture>>){
  const path=join(f.root,'workbench.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-local-workbench',title:'实际进程测试场景',goal:'明确夹具验证，不代表真实模型',sources:[{id:'selected',title:'所选任务',store:f.store,item:f.item}]}));
  const server=await startWorkbench(path);t.after(()=>server.close());const u=new URL(server.url),headers={Authorization:'Bearer '+u.hash.slice(1)};
  const get=(path:string)=>fetch(u.origin+path,{headers});return {get,state:async()=>((await (await get('/api/state')).json()) as any).tasks[0],url:server.url};
}
test('workbench and secretary share exact selected message facts; full reports are separate and refresh starts nothing',async t=>{
  const f=await messageFixture(t),result=await runMessages(f.store,f.path);assert.equal(result.completed,true);const a=await app(t,f),before=f.q.status(),trace=await readFile(f.trace),state=await a.state(),collab=state.collaboration;
  assert.equal(collab.messages.length,1);const m=collab.messages[0];assert.equal(m.current,true);assert.equal(m.messages.length,4);assert.equal(m.messages.every((x:any)=>x.state==='Reply'&&x.consumptionConfirmed),true);assert.equal(m.participants.every((x:any)=>x.completeCapture),true);
  const item=before.items.find((i:any)=>i.id===f.item),c=item.candidate,secretary=await observeTask(f.store,f.item,{repository:c.repository,pr:c.pr,H:c.H,B:c.B,target:c.targetRef});assert.deepEqual(secretary.collaboration,collab);
  const body=JSON.stringify(state);assert.ok(!body.includes(f.root));assert.ok(!body.includes(result.messages[0]!.reply.report));assert.ok(!body.includes(f.plan.messages[0]!.body));
  const report=await (await a.get('/api/message-report/selected/'+result.run+'/check')).json() as any;assert.equal(report.report,result.messages[0]!.reply.finalText);assert.equal(report.reportSha256,hash(report.report));assert.equal(report.reportText,result.messages[0]!.reply.report);assert.equal(report.reportTextSha256,hash(report.reportText));assert.equal(report.completeCapture,true);assert.equal(report.formalJudgmentGranted,false);
  await a.state();await a.get('/api/message-report/selected/'+result.run+'/synthesis');assert.deepEqual(f.q.status(),before);assert.deepEqual(await readFile(f.trace),trace);
});
test('messages addressed only to another selected-out item cannot be retrieved through a guessed run and message id',async t=>{
  const f=await messageFixture(t),other=await f.packet({pr:2});f.plan.participants.find(p=>p.id==='impact')!.item=other.item;await f.write();const result=await runMessages(f.store,f.path);assert.equal(result.completed,true);const a=await app(t,f),state=await a.state(),m=state.collaboration.messages[0];
  assert.deepEqual(m.messages.map((x:any)=>x.id),['check','fact','synthesis']);assert.ok(!JSON.stringify(state).includes(other.item));assert.equal((await a.get('/api/message-report/selected/'+result.run+'/impact')).status,404);assert.equal((await a.get('/api/message-report/unknown/'+result.run+'/check')).status,404);
});
test('historical candidate and arrangement remain explicit while unknown original captures never appear complete',async t=>{
  const f=await messageFixture(t,'partial-answer'),result=await runMessages(f.store,f.path);assert.equal(result.completed,false);const other=await f.packet({pr:2}),task=(id:string,item:string)=>({id,item,actor:id,originActor:id,dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:[],workspace:null,publishBranch:null,outputs:[]});
  const plan={schemaVersion:1,kind:'tongxu-task-coordination',name:'view-coordination',revision:'r1',previous:null,source:'Explicit view test; no contact with external actors',authorityIntent:null,mode:'parallel',actors:[{id:'A',tool:'codex'},{id:'B',tool:'codex'}],tasks:[task('A',f.item),task('B',other.item)],shared:[{id:'shared',tasks:['A','B'],paths:['src/a.ts'],contract:'Private shared source text must not leak into ordinary status',feedbackFrom:['A','B'],blockedStages:['implement']}],dependencies:[]};
  const r1=f.q.coordination().register(Buffer.from(JSON.stringify(plan)));f.q.coordination().register(Buffer.from(JSON.stringify({...plan,revision:'r2',previous:r1.id})));await f.packet({H:await f.newHead()});const a=await app(t,f),state=await a.state(),c=state.collaboration;
  assert.equal(c.messages[0].current,false);assert.equal(c.messages[0].messages[0].state,'Unknown');assert.equal(c.coordination[0].current,false);assert.equal(c.coordination[1].current,true);assert.equal(c.coordination[1].tasks[0].stages.every((s:any)=>!s.phasePrerequisitesMet),true);assert.equal(c.coordination[1].tasks[0].originActorContactVerified,false);assert.ok(!JSON.stringify(state).includes(plan.shared[0]!.contract));assert.ok(!JSON.stringify(state).includes(other.item));
});
test('lost resource settlement is visible beside a complete report without provider calls or factual cleanup from refresh',async t=>{
  const f=await messageFixture(t),ledger=await ledgerFixture(t,'lost-after-result'),spec=ledger.profile.resources[0]!;f.plan.resourceBudget=[{ledgerId:ledger.profile.ledgerId,resourceRef:spec.ref,unit:spec.unit,quantity:1}];await messageAuthority(f);f.q.resources().configure(Buffer.from(JSON.stringify(ledger.profile)));await f.write();const result=await runMessages(f.store,f.path);assert.equal(result.completed,true);assert.equal(result.resourcesSettled,false);
  const a=await app(t,f),before=f.q.status(),provider=ledger.state(),trace=await readFile(f.trace);const state=await a.state(),run=state.collaboration.messages[0];assert.equal(run.resourcesSettled,false);assert.equal(run.resources[0].settled,false);assert.equal(run.messages.every((m:any)=>m.state==='Reply'),true);await a.state();assert.deepEqual(f.q.status(),before);assert.deepEqual(ledger.state(),provider);assert.deepEqual(await readFile(f.trace),trace);
});
test('changed message evidence is unavailable rather than rendered as a cached success',async t=>{
  const f=await messageFixture(t),result=await runMessages(f.store,f.path),a=await app(t,f),db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());
  const row=db.prepare("SELECT data FROM events WHERE kind='message_reply' AND object=? ORDER BY id LIMIT 1").get('messages:'+result.run) as any,sha=JSON.parse(row.data).sha256;db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('changed evidence'),sha);
  const state=await a.state();assert.equal(state.collaboration.messages[0].available,false);assert.match(state.collaboration.messages[0].error,/original_missing_or_changed/);assert.notEqual((await a.get('/api/message-report/selected/'+result.run+'/check')).status,200);
});
