import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ready } from './fixture.js';
import { managedMergeAction,prepareManagedMerge,validateManagedMerge } from '../../src/managed-merge.js';
import { inspectMergePreflight } from '../../src/merge-preflight.js';
import { callMergeProvider,mergeCommand,mergeHttpRequest,requireMergeObservation } from '../../src/merge-provider.js';
import { QueueStore } from '../../src/queue-store.js';
import { resourceAction } from '../../src/resource-claims.js';
import { inspectMergeController } from '../../src/merge-recovery.js';
import { cp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { readPacket } from '../../src/queue-evidence.js';
import { hash } from '../../src/snapshot.js';
import { runReception } from '../../src/receiver.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from '../../src/comparison.js';

test('one original queue operation owns target before resources, sends one exact HTTP merge and verifies actual result',async t=>{
  const f=await ready(t),s=f.q.merges().status(f.operation);assert.equal(s.merge.phase,'resources_pending');assert.equal(f.q.status().claims[0].operation,f.operation);assert.equal(f.ledger.state().claims.length,0);
  const done=await managedMergeAction(f.store,f.operation,'run');assert.equal(done.merge.phase,'exact_merge_result_verified');assert.equal(done.status,'complete');assert.equal(done.newMergeCall,true);
  assert.equal(f.q.status().operations.length,1);assert.equal(f.q.status().claims.length,0);assert.equal(f.publisher.state().merges,1);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
  const puts=f.publisher.requests.filter(r=>r.method==='PUT');assert.equal(puts.length,1);assert.equal(JSON.parse(puts[0]!.body).sha,f.binding.H);assert.equal(puts[0]!.path,`/repos/fixture/reception/pulls/1/merge`);
  assert.ok(!(await f.publisher.env()).some((k:string)=>/TOKEN|API_KEY|SSH|HOME|GH_CONFIG/i.test(k)));assert.ok(f.publisher.requests.every(r=>!r.headers.authorization));
  writeFileSync(f.sourcePath,'{}');const n=f.publisher.requests.length;
  assert.equal((await managedMergeAction(f.store,f.operation,'run')).newMergeCall,false);assert.equal((await prepareManagedMerge(f.store,f.plan)).duplicate,true);assert.equal(f.publisher.requests.length,n);
});
test('lost HTTP reply after an actual fixture merge stays unknown; readback recovers the same request without another PUT',async t=>{
  const f=await ready(t,'lost-after-merge');await assert.rejects(managedMergeAction(f.store,f.operation,'run'),/execution_incomplete/);assert.equal(f.publisher.state().merges,1);assert.equal(f.q.merges().status(f.operation).merge.phase,'sent_unknown');
  assert.equal((await managedMergeAction(f.store,f.operation,'run')).newMergeCall,false);
  f.adopt({kind:'revoke',decision:f.confirmation.sha});writeFileSync(f.sourcePath,'{}');
  const done=await managedMergeAction(f.store,f.operation,'reconcile');assert.equal(done.merge.phase,'exact_merge_result_verified');assert.equal(done.newMergeCall,false);assert.equal(f.publisher.state().merges,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('changed actual base/tree keeps target occupied for actual-version verification; wrong target is never repaired by a PASS',async t=>{
  for(const mode of ['base-race','tree-race','wrong-target']){
    const f=await ready(t,mode),done=await managedMergeAction(f.store,f.operation,'run');
    assert.equal(done.merge.phase,mode==='wrong-target'?'merged_wrong_target':'merged_pending_verification');assert.equal(done.merge.readback.result.productionActionAllowed,false);
    if(mode==='wrong-target'){assert.throws(()=>f.q.merges().validationInput(f.operation),/not_applicable/);assert.equal(f.q.status().claims.length,0);}
    else{assert.equal(f.q.status().claims.length,1);const input=JSON.parse(f.q.merges().validationInput(f.operation).toString());assert.equal(input.actual.mergeCommit,f.publisher.state().M);assert.equal(input.actual.reason,'actual_version_requires_own_validation');assert.throws(()=>f.q.merges().completeValidation(f.operation,{referenceSha256:'0'.repeat(64),executionKind:'fixture',proof:Buffer.from('{}'),proofSha256:hash('{}'),observedAt:new Date().toISOString()}),/actual_independent/);}
    assert.equal((await managedMergeAction(f.store,f.operation,'run')).newMergeCall,false);assert.equal(f.publisher.state().merges,1);
  }
});
test('unknown rules, missing check pages, Draft and missing credential block real fixture PUT while retaining original facts',async t=>{
  for(const mode of ['unknown-rule','missing-check-page','draft','credential-missing','head-changed']){
    const f=await ready(t,mode),done=await managedMergeAction(f.store,f.operation,'run');assert.equal(done.newMergeCall,false);assert.ok('preflight' in done);assert.equal(done.preflight.ready,false);assert.ok(done.preflight.gaps.length);assert.equal(f.publisher.requests.filter(r=>r.method==='PUT').length,0);assert.equal(f.q.status().claims.length,1);
  }
});
test('Owner merge stop and another target owner cannot be bypassed by the old shadow evaluator or a copied request',async t=>{
  const f=await ready(t);f.adopt({kind:'control',adoption:f.scope.sha,control:'merge',state:'stopped'});
  await assert.rejects(managedMergeAction(f.store,f.operation,'run'),/owner_action_stopped/);assert.equal(f.ledger.state().claims.length,0);assert.equal(f.publisher.state().merges,0);
  assert.throws(()=>f.q.evaluate(f.operation),/original_managed_merge_pending/);const other=await f.packet({pr:2});assert.ok(f.q.begin(other.item,'competing').blocked.includes('target_occupied_or_unknown'));
  const legacy=new DatabaseSync(join(f.store,'queue.sqlite'));try{assert.throws(()=>legacy.prepare("UPDATE operations SET status='complete',result='{}' WHERE id=?").run(f.operation),/managed_merge_original_unresolved/);assert.throws(()=>legacy.prepare('DELETE FROM claims WHERE operation=?').run(f.operation),/managed_merge_original_unresolved/);}finally{legacy.close();}
  assert.equal(f.q.status().claims.length,1);
});
test('a pre-launch interruption is recoverable only after the exact owner ended; active/started attempts never become unsent',async t=>{
  const f=await ready(t);await resourceAction(f.store,f.binding.resourceRequests[0]!,'claim','background');
  const preflight=await inspectMergePreflight(f.publisher.profile,f.binding,join(f.root,'preflight')),m=f.q.merges(),fresh=await f.fresh();let capture='';
  await assert.rejects(callMergeProvider(f.publisher.profile,mergeCommand(f.binding,'merge'),join(f.root,'prelaunch'),dir=>{capture=dir;m.dispatch(f.operation,preflight,fresh,dir);throw new Error('explicit_fixture_before_spawn');}),/before_spawn/);
  await assert.rejects(inspectMergeController(m.originalDispatch(f.operation)),/controller_active/);
  m.controllerReturned(f.operation,capture);const recovered=await managedMergeAction(f.store,f.operation,'recover-controller');assert.equal(recovered.merge.phase,'resources_pending');assert.equal(f.publisher.state().merges,0);
  const done=await managedMergeAction(f.store,f.operation,'run');assert.equal(done.merge.phase,'exact_merge_result_verified');assert.equal(done.merge.attempts.length,2);assert.equal(f.publisher.state().merges,1);
  const proof=await inspectMergeController(m.originalDispatch(f.operation));assert.equal(proof.unstarted,false);
});
test('only an explicit definitive refusal may retry and it keeps the original resource, candidate and bound request',async t=>{
  const f=await ready(t,'refused');const refused=await managedMergeAction(f.store,f.operation,'run');assert.equal(refused.merge.phase,'refused');assert.equal(f.publisher.state().merges,0);
  assert.equal(f.ledger.state().settlements.length,0);assert.equal((await managedMergeAction(f.store,f.operation,'run')).newMergeCall,false);
  f.publisher.setMode('normal');const retry=await managedMergeAction(f.store,f.operation,'retry-refused');assert.equal(retry.newMergeCall,true);assert.equal(retry.merge.phase,'exact_merge_result_verified');assert.equal(f.publisher.requests.filter(r=>r.method==='PUT').length,2);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('serialized provider receipts and request path/payload overrides cannot create a send authority',async t=>{
  const f=await ready(t),command=mergeCommand(f.binding,'read',{kind:'pr'});
  const reply=await callMergeProvider(f.publisher.profile,command,join(f.root,'read-original'));
  assert.throws(()=>requireMergeObservation(JSON.parse(JSON.stringify(reply)),f.publisher.profile,command),/actual_managed_publisher/);
  assert.throws(()=>mergeHttpRequest({...command,read:{kind:'commit',page:1,commit:'../../admin',tip:null}}),/actual_merge_commit_required/);
  await assert.rejects(callMergeProvider(f.publisher.profile,mergeCommand(f.binding,'merge'),join(f.root,'ungated')),/persisted_managed_merge_gate/);
  const q=await QueueStore.open(f.store);try{assert.equal(q.merges().status(f.operation).operation,f.operation);}finally{q.close();}
});
test('actual-version validation consumes a new explicit fixture W2 packet and a separately executed fixture receiver, never an old PASS',async t=>{
  const f=await ready(t,'base-race');await managedMergeAction(f.store,f.operation,'run');const reference=f.q.merges().validationInput(f.operation),actual=JSON.parse(reference.toString()).actual;
  await assert.rejects(validateManagedMerge(f.store,f.operation,f.store,f.operation),/separate_actual_version/);
  // Only copies of explicitly synthetic test inputs are edited. This fixture
  // exercises binding/consumption, not real GitHub, W2 or model acceptance.
  const root=join(f.root,'actual-version-fixture');await mkdir(root,{mode:0o700});
  const snapshot=join(root,'snapshot'),verification=join(root,'verification');await cp(join(f.root,'snapshot-1'),snapshot,{recursive:true});await cp(join(f.root,'verification-1'),verification,{recursive:true});
  const manifest=JSON.parse((await readFile(join(snapshot,'manifest.json'))).toString()),at=new Date().toISOString();manifest.candidate.B=actual.actualBase;manifest.candidate.observedAt=at;manifest.rounds.forEach((r:any)=>{r.startedAt=at;r.finishedAt=at;});
  const manifestBytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(snapshot,'manifest.json'),manifestBytes);
  const report=JSON.parse((await readFile(join(verification,'verification.json'))).toString());report.id='explicit-actual-version-fixture';report.startedAt=at;report.finishedAt=at;report.inputs[0].candidate=manifest.candidate;report.inputs[0].manifestHash=hash(manifestBytes);report.inputs[0].manifest={sha256:hash(manifestBytes),path:`raw/${hash(manifestBytes)}.bin`,bytes:manifestBytes.length};await writeFile(join(verification,report.inputs[0].manifest.path),manifestBytes,{mode:0o600});
  report.stages[0].inputHead=actual.actualBase;report.stages[0].parent=actual.actualBase;report.stages[0].head=actual.actualBase;report.stages[1].parent=actual.actualBase;await writeFile(join(verification,'verification.json'),JSON.stringify(report));
  const store=join(root,'queue'),q=await QueueStore.create(store,'fixture/reception');t.after(()=>q.close());q.enableReceiver();const item=q.import(await readPacket(snapshot,verification,join(f.root,'context-1.json')));
  const material=join(root,'actual-merge-readback.json');await writeFile(material,reference,{mode:0o600});const plan=join(root,'receiver.json');await writeFile(plan,JSON.stringify({...f.receiverPlan,store,item:item.item,material:[{path:material,sha256:hash(reference)}]}),{mode:0o600});
  const received=await runReception(plan);assert.equal(received.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');
  const done=await validateManagedMerge(f.store,f.operation,store,received.operation);assert.equal(done.merge.phase,'actual_merge_result_verified');assert.equal(f.q.status().claims.length,0);assert.equal(f.publisher.state().merges,1);assert.equal(done.productionActionAllowed,false);
  const settled=await resourceAction(f.store,f.binding.resourceRequests[0]!,'record-result','background');assert.equal(settled.state,'consumed');
});
test('confirmed unsent cancellation releases the queue target and reports original resource facts without assuming a refund',async t=>{
  const f=await ready(t,'draft');await managedMergeAction(f.store,f.operation,'run');assert.equal(f.ledger.state().claims.length,1);
  f.adopt({kind:'revoke',decision:f.confirmation.sha});const cancelled=await managedMergeAction(f.store,f.operation,'cancel-unstarted');assert.equal(cancelled.merge.phase,'cancelled_before_send');assert.equal(f.q.status().claims.length,0);assert.equal(f.publisher.requests.filter(r=>r.method==='PUT').length,0);assert.equal(f.ledger.state().settlements.length,1);assert.equal(f.ledger.state().remaining,0);
  assert.equal((await managedMergeAction(f.store,f.operation,'cancel-unstarted')).duplicate,true);
});
test('two real CLI controllers cannot send competing merges for one queue operation',async t=>{
  const f=await ready(t),cli=fileURLToPath(new URL('../../src/merge-cli.js',import.meta.url));
  const child=()=>new Promise<{code:number|null;stdout:string;stderr:string}>(resolve=>{const p=spawn(process.execPath,[cli,'run','--store',f.store,'--operation',f.operation],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('close',code=>resolve({code,stdout,stderr}));});
  const r=await Promise.all([child(),child()]);assert.deepEqual(r.map(x=>x.code).sort(),[0,1]);assert.match(r.find(x=>x.code===1)!.stderr,/controller_active/);assert.equal(f.publisher.state().merges,1);assert.equal(f.ledger.state().claims.length,1);
});
test('actual controller death before provider launch preserves the original request and permits one evidenced continuation',async t=>{
  const f=await ready(t);await resourceAction(f.store,f.binding.resourceRequests[0]!,'claim','background');const script=join(f.root,'kill-before-launch.mjs');
  const moduleURL=(name:string)=>new URL('../../src/'+name+'.js',import.meta.url).href;
  await writeFile(script,`import {QueueStore} from ${JSON.stringify(moduleURL('queue-store'))};import {readOwnerSource} from ${JSON.stringify(moduleURL('authority-source'))};import {inspectMergePreflight} from ${JSON.stringify(moduleURL('merge-preflight'))};import {callMergeProvider,mergeCommand} from ${JSON.stringify(moduleURL('merge-provider'))};import {join} from 'node:path';
const q=await QueueStore.open(${JSON.stringify(f.store)}),m=q.merges(),s=m.status(${JSON.stringify(f.operation)}),p=m.configuration(),dir=${JSON.stringify(f.root)},a=q.authority();const preflight=await inspectMergePreflight(p,s.binding,join(dir,'killed-preflight'));const observations=[];for(const ref of a.sourceRequests(a.reservedAction(s.binding.authorityIntent).authorization))observations.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(dir,'killed-source-'+ref.commentId)));await callMergeProvider(p,mergeCommand(s.binding,'merge'),join(dir,'killed-original-send'),d=>{m.dispatch(s.operation,preflight,observations,d);process.kill(process.pid,'SIGKILL');});`,{mode:0o600});
  const result=await new Promise<{code:number|null;signal:string|null;error:string}>(resolve=>{const p=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe']});let error='';p.stderr.on('data',b=>error+=b);p.once('close',(code,signal)=>resolve({code,signal,error}));});
  assert.equal(result.signal,'SIGKILL',result.error);assert.equal(f.q.merges().status(f.operation).merge.phase,'sent_unknown');assert.equal(f.publisher.state().merges,0);
  assert.equal((await managedMergeAction(f.store,f.operation,'recover-controller')).merge.phase,'resources_pending');
  assert.equal((await managedMergeAction(f.store,f.operation,'run')).merge.phase,'exact_merge_result_verified');assert.equal(f.publisher.requests.filter(r=>r.method==='PUT').length,1);assert.equal(f.ledger.state().claims.length,1);
});
test('large legal review pages retain exact original blobs while the saved preflight stays a bounded reference index',async t=>{
  const f=await ready(t),p=f.publisher,root='/repos/'+f.binding.repository,body='x'.repeat(9000),at=new Date().toISOString();
  for(let page=1;page<=5;page++)p.setReply(`${root}/pulls/${f.binding.pr}/reviews?per_page=100&page=${page}`,Array.from({length:100},(_,i)=>({id:(page-1)*100+i+1,user:{id:70,login:'fixture-commenter'},state:'COMMENTED',commit_id:f.binding.H,submitted_at:at,body})),200,page<5);
  const done=await managedMergeAction(f.store,f.operation,'run');assert.equal(done.merge.phase,'exact_merge_result_verified');assert.equal(p.state().merges,1);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'),{readOnly:true});try{
    const get=(sha:string)=>Buffer.from((db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as any).bytes);
    const raw=get(done.merge.attempts[0].preflightSha256),saved=JSON.parse(raw.toString());assert.ok(raw.length<64*1024,`metadata index unexpectedly ${raw.length} bytes`);
    const pages=saved.records.filter((r:any)=>r.command.read?.kind==='reviews');assert.equal(pages.length,5);let bytes=0;
    for(const page of pages){assert.equal(page.observation.raw,undefined);assert.equal(page.observation.reply,undefined);const original=get(page.observation.rawSha256);assert.equal(hash(original),page.observation.rawSha256);assert.equal(original.length,page.observation.rawBytes);bytes+=original.length;const parsed=JSON.parse(JSON.parse(original.toString()).result.body);assert.equal(parsed.length,100);assert.equal(parsed[99].body,body);}
    assert.ok(bytes>4*1024*1024);
  }finally{db.close();}
});
test('historical expanded readback indexes stay readable without overwriting the original or repeating a merge',async t=>{
  const f=await ready(t,'base-race');await managedMergeAction(f.store,f.operation,'run');
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));let legacySha='';
  try{
    const get=(sha:string)=>Buffer.from((db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as any).bytes),op=db.prepare('SELECT result FROM operations WHERE id=?').get(f.operation) as any,result=JSON.parse(op.result),oldSha=result.merge.readback.sha256,index=JSON.parse(get(oldSha).toString());
    // Explicit fixture for the previously shipped 073fae0 storage format.
    for(const r of index.records){const raw=get(r.observation.rawSha256);delete r.observation.rawSha256;delete r.observation.rawBytes;r.observation.raw=raw;r.observation.reply=JSON.parse(raw.toString());}
    const legacy=Buffer.from(canonical(index));legacySha=hash(legacy);db.prepare('INSERT INTO blobs VALUES(?,?)').run(legacySha,legacy);result.merge.readback.sha256=legacySha;
    db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result),f.operation);
    const row=db.prepare("SELECT id,data FROM events WHERE object=? AND kind='managed_merge_readback'").get('merge:'+f.operation) as any,data=JSON.parse(row.data);data.blobs=data.blobs.map((s:string)=>s===oldSha?legacySha:s);db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
    const material=JSON.parse(f.q.merges().validationInput(f.operation).toString());assert.equal(material.readback.originalIndexSha256,legacySha);assert.equal(material.readback.records[0].observation.raw,undefined);assert.ok(material.originals.every((r:any)=>hash(r.rawText)===r.rawSha256));assert.equal(hash(get(legacySha)),legacySha);assert.equal(f.publisher.state().merges,1);
    const ref=material.originals[0].rawSha256,original=get(ref);db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('changed'),ref);assert.throws(()=>f.q.merges().validationInput(f.operation),/original_missing_or_changed/);db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(original,ref);
  }finally{db.close();}
});
