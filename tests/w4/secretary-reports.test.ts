import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {secretaryFixture} from './secretary-fixture.js';
import {sourceFixture} from '../events/source-fixture.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {QueueStore} from '../../src/queue-store.js';
import {SecretaryTools} from '../../src/secretary-tools.js';
import {runSecretary} from '../../src/secretary.js';
import {startWorkbench} from '../../src/workbench.js';
import {readSecretarySources} from '../../src/secretary-sources.js';

test('secretary and page read identical full reception evidence; selected source closure and related merge are observations, not fixed conclusions',async t=>{
  const f=await secretaryFixture(t,'reception-full'),s=await sourceFixture(t,'fixture/reception'),repo='fixture/reception';
  const related={number:7,html_url:'https://github.com/fixture/reception/pull/7',title:'fixture integrated candidate',body:'Explicit test merge record',state:'closed',merged:true,merged_at:'2026-10-23T12:00:00Z',merge_commit_sha:'d'.repeat(40),head:{sha:'c'.repeat(40)},base:{ref:'main',sha:'b'.repeat(40),repo:{id:12,full_name:repo}}};
  await s.change({H:f.p.candidate.H,B:f.p.candidate.B,target:f.p.candidate.target,prState:'closed',comments:[{id:77,user:{id:88},body:'Explicit fixture: original closed after inclusion through related PR7',html_url:'https://github.com/fixture/reception/pull/1#issuecomment-77'}],related:{'repos/fixture/reception/pulls/7':related}});
  f.q.events().configure(Buffer.from(canonical(s.profile)));f.p.receptionReports=true;f.p.taskSources={profileSha256:hash(canonical(s.profile)),relatedPulls:[7]};await writeFile(f.secretaryPlan,JSON.stringify(f.p));
  const before=f.q.status(),result=await runSecretary(f.secretaryPlan,f.output),rows=(await f.logs()).filter(x=>x.kind==='observation'),report=rows.find(x=>x.value.data.report)?.value.data,sources=rows.find(x=>x.value.data.documents)?.value.data;
  const original=await QueueStore.observeReceptionReport(f.store,f.item,f.received.operation);assert.deepEqual(report,original);assert.equal(report.reportSha256,hash(report.report));assert.deepEqual(report.findings,original.findings);assert.equal(report.originalCandidate.H,f.p.candidate.H);
  assert.equal(sources.currentCandidate.state,'closed');assert.equal(sources.related[0].pr,7);assert.equal(sources.related[0].record.merged,true);assert.ok(sources.documents.some((d:any)=>d.kind==='comments'&&d.value[0].body.includes('related PR7')));assert.equal(result.localLedgerOnly,false);assert.equal(result.newModelTasks,1);assert.deepEqual(f.q.status(),before);
  const path=join(f.root,'page.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-local-workbench',title:'fixture report',goal:'readonly',sources:[{id:'selected',title:'selected',store:f.store,item:f.item}]}));const app=await startWorkbench(path);t.after(()=>app.close());const url=new URL(app.url);const page=await(await fetch(url.origin+'/api/report/selected/'+f.received.operation,{headers:{Authorization:'Bearer '+url.hash.slice(1)}})).json() as any;const {source,...same}=page;assert.equal(source,'selected');assert.deepEqual(same,original);
  const trace=await readFile(f.trace),reads=(await s.get()).requests.length;assert.equal((await runSecretary(f.secretaryPlan,f.output)).newModelTasks,0);assert.deepEqual(await readFile(f.trace),trace);assert.equal((await s.get()).requests.length,reads);
  // A different observed source must yield a different answerable fact set.
  await s.change({prState:'open',related:{'repos/fixture/reception/pulls/7':{...related,state:'open',merged:false,merged_at:null,merge_commit_sha:null}}});const later=await readSecretarySources(f.store,f.item,f.p.candidate,f.p.taskSources,'fixture',join(f.root,'later-source'));
  assert.equal(later.currentCandidate?.state,'open');assert.equal(later.related[0]!.record.merged,false);
});

test('full report/source tools reject unselected operations, extra arguments, forged profile and fixture sources for a native caller',async t=>{
  const f=await secretaryFixture(t),s=await sourceFixture(t,'fixture/reception');await s.change({H:f.p.candidate.H,B:f.p.candidate.B,target:f.p.candidate.target});f.q.events().configure(Buffer.from(canonical(s.profile)));
  const dir=join(f.root,'queries');await mkdir(dir);const selection={profileSha256:hash(canonical(s.profile)),relatedPulls:[]};
  const gate=new SecretaryTools(f.store,f.item,f.p.candidate,dir,undefined,false,false,undefined,false,undefined,true,selection,'fixture'),legacy=new SecretaryTools(f.store,f.item,f.p.candidate,dir);
  await assert.rejects(legacy.call({tool:'tongxu_reception_report',arguments:{operation:f.received.operation},callId:'disabled'}),/query_not_allowed/);
  await assert.rejects(gate.call({tool:'tongxu_reception_report',arguments:{operation:'another-task-operation'},callId:'outside'}),/report_not_found/);
  await assert.rejects(gate.call({tool:'tongxu_task_sources',arguments:{url:'https://unrelated.invalid'},callId:'url'}),/query_not_allowed/);
  const otherItem='a'.repeat(64);await assert.rejects(QueueStore.observeReceptionReport(f.store,otherItem,f.received.operation),/report_not_found/);
  await assert.rejects(readSecretarySources(f.store,f.item,f.p.candidate,{...selection,profileSha256:'0'.repeat(64)},'fixture',join(f.root,'wrong-profile')),/selection_changed/);
  await assert.rejects(readSecretarySources(f.store,f.item,f.p.candidate,selection,'native_capture',join(f.root,'wrong-kind')),/selection_changed/);
  assert.equal((await s.get()).requests.length,0);
  await s.change({reportedRepo:'other/repository'});const foreign=await readSecretarySources(f.store,f.item,f.p.candidate,selection,'fixture',join(f.root,'foreign-original'));assert.equal(foreign.originalIdentityVerified,false);assert.equal(foreign.currentCandidate,null);assert.ok(foreign.documents.every((d:any)=>d.kind==='comments'&&d.value.length===0));
});

test('missing related source retains original closeout and a large source observation remains replayable with explicit omissions',async t=>{
  const f=await secretaryFixture(t),s=await sourceFixture(t,'fixture/reception');
  await s.change({H:f.p.candidate.H,B:f.p.candidate.B,target:f.p.candidate.target,prState:'closed',comments:Array.from({length:40},(_,i)=>({id:100+i,user:{id:1},body:'明确测试正文"\\'.repeat(2400),html_url:'https://github.com/fixture/reception/pull/1#issuecomment-'+(100+i)}))});f.q.events().configure(Buffer.from(canonical(s.profile)));
  const dir=join(f.root,'bounded-source-query');await mkdir(dir);const selection={profileSha256:hash(canonical(s.profile)),relatedPulls:[77]},gate=new SecretaryTools(f.store,f.item,f.p.candidate,dir,undefined,false,false,undefined,false,undefined,true,selection,'fixture');
  const request={tool:'tongxu_task_sources',arguments:{},callId:'source-with-gap'},reply=await gate.call(request),data=JSON.parse(reply.contentItems[0].text).data;
  assert.equal(data.currentCandidate.state,'closed');assert.equal(data.observedCandidateMatchesTask,true);assert.equal(data.related[0].available,false);assert.equal(data.related[0].status,404);assert.ok(data.gaps.includes('related_77_source_http_404'));assert.equal(data.sourceReadComplete,false);assert.equal(data.originalSourceReadComplete,true);assert.equal(data.relatedSourcesComplete,false);assert.equal(data.projectionComplete,false);
  assert.ok(data.omissions.length>0);assert.equal(data.documents.find((d:any)=>d.kind==='comments').omittedCount,8);assert.ok(Buffer.byteLength(JSON.stringify(data))<128*1024);
  const file=await readFile(join(dir,'queries/source-with-gap.json'));assert.ok(file.length<1024*1024);assert.equal((await gate.observations()).length,1);const reads=(await s.get()).requests.length;
  assert.deepEqual(await gate.call(request),reply);assert.equal((await s.get()).requests.length,reads);assert.deepEqual(await readFile(join(dir,'queries/source-with-gap.json')),file);
  await s.change({comments:[],related:{'repos/fixture/reception/pulls/77':{number:77,base:{repo:{id:999,full_name:'wrong/repo'}}}}});
  await assert.rejects(readSecretarySources(f.store,f.item,f.p.candidate,selection,'fixture',join(f.root,'wrong-related-identity')),/related_source_identity_unknown/);
});
