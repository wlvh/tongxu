import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secretaryFixture} from '../w4/secretary-fixture.js';
import {sourceFixture} from './source-fixture.js';
import {QueueEventControls} from '../../src/queue-event-controls.js';
import {runSecretary} from '../../src/secretary.js';
import {SecretaryTools} from '../../src/secretary-tools.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {sourceTick} from '../../src/event-tick.js';
import {ownerDecisionText,scopeBodyHash,type AuthorityProfile,type ActionRequest} from '../../src/authority-contract.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';

async function fixture(t:test.TestContext){
  const f=await secretaryFixture(t,'queue-action'),source=await sourceFixture(t,'fixture/reception');f.q.enableSupplements();
  await source.change({H:f.p.candidate.H,B:f.p.candidate.B,target:f.p.candidate.target});f.q.events().configure(Buffer.from(canonical(source.profile)));
  const actions=[{id:'remind',title:'核查原任务的接收条件',source:'selected',profileSha256:hash(canonical(source.profile)),kind:'hint',hintKind:'consumer_feedback'}],catalog={schemaVersion:1,kind:'tongxu-queue-event-controls',actions},path=join(f.root,'queue-options.json');await writeFile(path,JSON.stringify(catalog));
  f.p.kind='tongxu-task-secretary';f.p.queueActions={path,sha256:hash(await readFile(path)),source:'selected'};f.p.question='请登记一次对原任务接收条件的核查提醒，并明确说明是否已执行任务。';await writeFile(f.secretaryPlan,JSON.stringify(f.p));
  const controls=await QueueEventControls.load(path,f.p.queueActions.sha256,[{id:'selected',store:f.store,item:f.item}]);return {...f,source,controls,catalog,catalogPath:path};
}

async function preferenceFixture(t:test.TestContext,oneShot=false){
  const f=await fixture(t);await sourceTick(f.store);f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();
  const a=f.q.authority(),records:Record<string,any>={},path=join(f.root,'owner-originals.json'),exe=join(f.root,'owner-source.mjs'),raw=(x:unknown)=>Buffer.from(JSON.stringify(x));
  const code=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),r=JSON.parse(fs.readFileSync(${JSON.stringify(path)},'utf8'));if(args.includes('graphql')){const id=args.find(x=>x.startsWith('id=')).slice(3);console.log(JSON.stringify(Object.values(r).find(x=>x.comment.node_id===id).graph));}else console.log(JSON.stringify(r[args.at(-1).split('/').at(-1)].comment));`;
  await writeFile(exe,code,{mode:0o700});
  const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:9,ownerId:101,executorId:202,ghExecutable:exe,ghSha256:hash(code),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000};a.configure(raw(profile));let serial=8600000000;
  const adopt=async(value:any)=>{const p=a.prepare('queue-control-'+(++serial),raw(value)),sha=p.proposalSha256,id=serial,at=new Date().toISOString(),body=ownerDecisionText(sha),node='IC_queue_'+id,url=`https://github.com/fixture/reception/issues/9#issuecomment-${id}`,comment={id,node_id:node,body,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/9',html_url:url},graph={data:{viewer:{databaseId:202},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),body,createdAt:at,updatedAt:at,lastEditedAt:null,url,author:{__typename:'User',databaseId:101},editor:null,issue:{number:9,repository:{nameWithOwner:'fixture/reception'}}}}};records[id]={comment,graph};await writeFile(path,raw(records));a.apply(sha,fixtureOwnerObservation(profile,sha,id,raw(graph),raw(comment),at));return sha;};
  const item=f.q.status().items.find((i:any)=>i.id===f.item),body={goals:['Explicit queue preference fixture'],nonGoals:['No production acceptance'],preserve:['Original results'],acceptance:['Exact authorized effect'],constraints:['No model execution by queue action']},adoption=await adopt({kind:'adopt_scope',scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,body,previousAdoption:null});
  const preference={schemaVersion:1,kind:'queue_preference',item:f.item,priority:2,mainIncident:false,reason:'Explicit fixture bounded priority'},request:ActionRequest={schemaVersion:1,scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,scopeBodySha256:scopeBodyHash(body),repository:'fixture/reception',target:item.candidate.targetRef,action:'coordinate',item:f.item,candidate:{H:item.candidate.H,B:item.candidate.B,subjectSha256:null},paths:[],resourceRefs:[],payloadSha256:hash(canonical(preference))};
  const authorization=await adopt(oneShot?{kind:'confirm_action',adoption,performerRole:'secretary',request,expiresAt:new Date(Date.now()+3600000).toISOString()}:{kind:'delegate',adoption,roles:['secretary'],targets:[item.candidate.targetRef],actions:['coordinate'],paths:[],resourceRefs:[],expiresAt:new Date(Date.now()+3600000).toISOString()});
  const entry={id:'priority',title:'提高已选任务的队列优先级',source:'selected',profileSha256:hash(canonical(f.source.profile)),kind:'preference',preference,request,authorization};
  await writeFile(f.catalogPath,JSON.stringify({...f.catalog,actions:[entry,...f.catalog.actions]}));f.p.queueActions!.sha256=hash(await readFile(f.catalogPath));f.p.question='请按已给的有限授权提高当前任务优先级，说明实际生效范围。';await writeFile(f.secretaryPlan,JSON.stringify(f.p));
  const controls=await QueueEventControls.load(f.catalogPath,f.p.queueActions!.sha256,[{id:'selected',store:f.store,item:f.item}]);return {...f,controls,a,adopt,authorization,entry};
}

test('actual secretary fixture selects a fixed hint; native capture, original receipt and repeat stay distinct from dispatch',async t=>{
  const f=await fixture(t),originalTrace=await readFile(join(f.root,'trace.txt')),before=f.q.status().operations;
  const result=await runSecretary(f.secretaryPlan,f.output);assert.equal(result.status,'completed');assert.equal(result.queueActionCalls,1);assert.equal(result.queryCalls,0);assert.equal(result.ownerApproval,false);
  const receipt=result.queueReceipts![0]!.receipt;assert.equal(receipt.taskExecutionStarted,false);assert.equal(receipt.modelTasksStarted,0);assert.equal(receipt.record.hint.kind,'consumer_feedback');
  const state=await f.controls.state();assert.equal(state[0]!.available,true);assert.equal(state[0]!.receipts!.length,1);assert.equal(state[0]!.receipts![0]!.hint.id,receipt.originalId);
  const logs=await f.logs();assert.deepEqual(logs.find(x=>x.kind==='tools').names,['tongxu_task_status','tongxu_operation_status','tongxu_queue_options','tongxu_queue_action']);
  assert.equal((await runSecretary(f.secretaryPlan,f.output)).newModelTasks,0);assert.deepEqual(await f.logs(),logs);assert.deepEqual(f.q.status().operations,before);assert.deepEqual(await readFile(join(f.root,'trace.txt')),originalTrace);
});

test('same request reuses its hint, later deliberate request gets a new receipt; source tick alone consumes it',async t=>{
  const f=await fixture(t),a=await f.controls.execute('remind','same-request'),events=f.q.status().events;
  assert.equal((await f.controls.execute('remind','same-request')).duplicate,true);assert.deepEqual(f.q.status().events,events);
  const b=await f.controls.execute('remind','new-explicit-request');assert.notEqual(a.originalId,b.originalId);assert.equal((await f.controls.state())[0]!.receipts!.length,2);
  assert.equal((await f.source.get()).requests.length,0);const tick=await sourceTick(f.store);assert.equal(tick.modelTasksStarted,0);assert.equal(tick.mergeRequestsSent,0);assert.ok(tick.checked.length);
  assert.deepEqual(f.q.status().operations.map((o:any)=>o.id),[f.received.operation]);
});

test('unselected actions, changed catalog and late revocation cannot write an event or add permission',async t=>{
  const f=await fixture(t),gate=new SecretaryTools(f.store,f.item,f.p.candidate,join(f.root,'old-tool-contract'));
  await assert.rejects(gate.call({tool:'tongxu_queue_action',arguments:{action:'remind'},callId:'forbidden'}),/query_not_allowed/);
  const events=f.q.status().events;
  await assert.rejects(f.controls.execute('other','one'),/not_selected/);
  await assert.rejects(f.controls.execute('remind','two',()=>{throw new Error('fixture-revoked-before-effect');}),/fixture-revoked/);
  assert.deepEqual(f.q.status().events,events);
  await writeFile(f.catalogPath,JSON.stringify({...f.catalog,actions:[{...f.catalog.actions[0],hintKind:'head_changed'}]}));await assert.rejects(f.controls.execute('remind','three'),/catalog_changed/);assert.deepEqual(f.q.status().events,events);
});

test('secretary preference consumes fresh original authority and returns the same actual queue receipt; revocation blocks later requests',async t=>{
  const f=await preferenceFixture(t),result=await runSecretary(f.secretaryPlan,f.output),receipt=result.queueReceipts![0]!.receipt;
  assert.equal(result.queueActionCalls,1);assert.equal(receipt.record.effect,'local_queue_preference_applied');assert.equal(receipt.record.executionPermissionGranted,false);assert.equal(receipt.record.technicalIncidentVerified,false);
  const events=f.q.status().events;assert.equal((await f.controls.execute('priority',receipt.requestId)).duplicate,true);assert.deepEqual(f.q.status().events,events);
  const next=await f.controls.execute('priority','later-explicit-request');assert.notEqual(next.originalId,receipt.originalId);assert.equal(f.a.status().intents.length,2);
  await f.adopt({kind:'revoke',decision:f.authorization});const stopped=f.q.status().events;await assert.rejects(f.controls.execute('priority','after-revocation'),/revoked/);assert.deepEqual(f.q.status().events,stopped);
  const logs=await f.logs();assert.equal((await runSecretary(f.secretaryPlan,f.output)).newModelTasks,0);assert.deepEqual(await f.logs(),logs);
});

test('one-shot preference cannot be consumed again under another request identity',async t=>{
  const f=await preferenceFixture(t,true),first=await f.controls.execute('priority','first');assert.equal(first.record.effect,'local_queue_preference_applied');
  assert.equal((await f.controls.execute('priority','first')).duplicate,true);await assert.rejects(f.controls.execute('priority','second'),/confirmation_already_reserved/);
  const gate=new SecretaryTools(f.store,f.item,f.p.candidate,join(f.root,'bounded-gate'),undefined,false,false,undefined,false,f.controls);
  await assert.rejects(gate.call({tool:'tongxu_queue_action',arguments:{action:'priority',priority:-2},callId:'extra-payload'}),/query_not_allowed/);
  assert.equal(f.a.status().intents.length,1);
});
