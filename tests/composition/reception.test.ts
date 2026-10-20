import nodeTest,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,rm,mkdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {setup} from '../w3/receiver-fixture.js';
import {Snapshot,hash} from '../../src/snapshot.js';
import {git} from '../../src/repair-workspace.js';
import {verify} from '../../src/verification.js';
import {readPacket} from '../../src/queue-evidence.js';
import {runReception} from '../../src/receiver.js';
import {workbenchState,parseWorkbenchPlan} from '../../src/workbench.js';
import {DatabaseSync} from 'node:sqlite';
import {SecretaryTools,observeTask} from '../../src/secretary-tools.js';
const dockerPath=process.env.TONGXU_TEST_DOCKER_CONFIG;
if(!dockerPath)throw new Error('TONGXU_TEST_DOCKER_CONFIG required');
const docker=JSON.parse(await readFile(dockerPath,'utf8')),roots=new WeakMap<TestContext,string[]>();
function test(name:string,body:(t:TestContext)=>Promise<void>){return nodeTest(name,async t=>{let passed=false;roots.set(t,[]);t.after(async()=>{for(const root of roots.get(t)!){if(passed)await rm(root,{recursive:true,force:true});else{const retained=resolve(process.env.TONGXU_TEST_FAILURE_DIRECTORY??'.test-failures',basename(root));await mkdir(resolve(retained,'..'),{recursive:true});await cp(root,retained,{recursive:true,errorOnExist:true,force:false});t.diagnostic('Failure kept at original '+root+' and '+retained);}}});await body(t);passed=true;});}

// The W2 execution, Git composition and SQLite are real. Every model response
// is an explicitly generated fixture; no supplier request is made here.
async function composition(t:TestContext){
  const f=await setup(t,'complete',2,false);roots.get(t)!.push(f.root);const objects=f.plan.objects,B=await git(objects,['rev-parse',f.H+'^']);
  const member=async(name:string,file:string,value:string)=>{await git(objects,['switch','-c',name,B]);await writeFile(join(objects,file),value);await git(objects,['add','.']);await git(objects,['-c','user.name=fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m',name]);return git(objects,['rev-parse','HEAD']);};
  const H1=await member('component-a','a.txt','A\n'),H2=await member('component-b','b.txt','B\n'),snapshots:string[]=[],at=new Date().toISOString();
  for(const [i,H] of [H1,H2].entries()){
    const path=join(f.root,'member-'+i),s=await Snapshot.create(path,'fixture/reception',i+1,[],[]);
    s.manifest.candidate={repository:'fixture/reception',pr:i+1,H,B,mergeBase:B,targetRef:'fixture',observedAt:at};
    await s.artifact(JSON.stringify({fixture:true,pr:i+1,H}),{kind:'pr',round:1,retrievedAt:at,provenance:'explicit-local-fixture',status:200});
    s.manifest.rounds.push({number:1,startedAt:at,finishedAt:at,coverage:{},sources:[],notes:[],gaps:[],limitations:['explicit_fixture'],current:true});await s.save();await s.close();snapshots.push(path);
  }
  const planPath=join(f.root,'composition-tests.json'),script="const fs=require('node:fs'),assert=require('node:assert/strict');const files=['a.txt','b.txt'].filter(f=>fs.existsSync(f));for(const f of files)assert.equal(fs.readFileSync(f,'utf8'),f==='a.txt'?'A\\n':'B\\n');fs.writeFileSync(process.env.TONGXU_RESULT_FILE,JSON.stringify({samples:[{id:'surface',status:'ok',content:files,identity:'explicit-composition-fixture',source:'fixed-member-files',sideEffects:[]}]}));";
  await writeFile(planPath,JSON.stringify({schemaVersion:2,executor:docker,tools:[{id:'existing-surface-check',argv:[docker.node,'-e',script],timeoutMs:10000,expectedSampleIds:['surface']}]}));
  const verification=join(f.root,'combined-test'),result=await verify({snapshots,objects,plan:planPath,output:verification});assert.equal(result.exit,0,JSON.stringify(result.report.gaps));assert.equal(result.report.stages.length,3);
  const context=join(f.root,'context.json');await writeFile(context,JSON.stringify({schemaVersion:1,scope:{id:'scope',version:'S1',source:'fixture:scope'},arrangement:{id:'team',version:'r1',source:'fixture:arrangement'},decisionKind:'fact',requires:[]}));
  f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();
  const packet=await readPacket(snapshots[1]!,verification,context,snapshots);assert.equal(packet.summary.evidenceComplete,true,JSON.stringify(packet.summary.gaps));const imported=f.q.import(packet);
  const receiverPlan={...f.plan,schemaVersion:2,sourcePaths:[],item:imported.item,memberSources:[{index:0,manifestHash:packet.summary.composition!.subject.members[0]!.manifestHash,sourcePaths:['a.txt','sample.js']},{index:1,manifestHash:packet.summary.composition!.subject.members[1]!.manifestHash,sourcePaths:['b.txt','sample.js']}]};
  const receiverPath=join(f.root,'receiver-v2.json');await writeFile(receiverPath,JSON.stringify(receiverPlan));
  return {...f,addPacket:f.packet,snapshots,verification,context,packet,imported,receiverPlan,receiverPath,H1,H2,B,objects,at};
}
test('complete ordered W2 originals are delivered with all exact member sources and echoed subject; duplicates do not dispatch',async t=>{
  const f=await composition(t),r=await runReception(f.receiverPath);assert.equal(r.receiver.phase,'returned');assert.equal(r.receiver.judgment.schemaVersion,2);assert.equal(r.receiver.judgment.reviewedSubjectSha256,f.packet.summary.composition!.sha256);assert.equal(r.receiver.currentMaterialMatches,true);assert.equal(r.receiver.subject.individualAcceptanceInferred,false);
  const input=JSON.parse(f.q.receiverState(r.operation).input.toString());assert.equal(input.data.sources.length,4);assert.deepEqual(input.data.sources.map((x:any)=>x.H),[f.H1,f.H1,f.H2,f.H2]);assert.equal(input.data.evidence.report.stages.length,3);
  const before=await f.count();assert.equal(f.q.import(await readPacket(f.snapshots[1]!,f.verification,f.context,f.snapshots)).duplicate,true);assert.equal((await runReception(f.receiverPath)).duplicate,true);assert.equal(await f.count(),before);
  const single=await readPacket(f.snapshots[1]!,f.verification,f.context);assert.equal(single.summary.evidenceComplete,false);assert.ok(single.summary.gaps.includes('additional_members_require_independent_reception'));
  const plan=parseWorkbenchPlan(Buffer.from(JSON.stringify({schemaVersion:1,kind:'tongxu-local-workbench',title:'组合夹具',goal:'不是真实模型',sources:[{id:'composition',title:'两个成员',store:f.store,item:f.imported.item}]}))),view=await workbenchState(plan);
  assert.equal(view.tasks[0]!.composition.sha256,r.receiver.subjectSha256);assert.equal(view.tasks[0]!.operations[0]!.subject.members.length,2);assert.equal(view.tasks[0]!.operations[0]!.subject.testedTree,f.packet.summary.tree);
  const candidate={repository:r.candidate.repository,pr:r.candidate.pr,H:r.candidate.H,B:r.candidate.B,target:r.candidate.targetRef},state=await observeTask(f.store,f.imported.item,candidate);
  assert.equal(state.candidateRole,'routing_anchor');assert.equal(state.originalSubjectSha256,r.receiver.subjectSha256);assert.equal(state.subject!.testedTree,f.packet.summary.tree);assert.equal(state.subject!.individualAcceptanceInferred,false);assert.equal(state.subject!.members.length,2);assert.equal(state.compositionCurrent,true);
  const tools=new SecretaryTools(f.store,f.imported.item,candidate,join(f.root,'secretary-queries'));
  for(const [tool,args] of [['tongxu_task_status',{}],['tongxu_operation_status',{operation:r.operation}]] as const){const response=await tools.call({tool,arguments:args,callId:tool}),data=JSON.parse(response.contentItems[0]!.text).data;assert.equal(data.originalSubjectSha256,r.receiver.subjectSha256);assert.equal(data.subject.testedTree,f.packet.summary.tree);assert.deepEqual(data.subject.members.map((m:any)=>m.candidate.H),[f.H1,f.H2]);assert.equal(data.subject.individualAcceptanceInferred,false);assert.ok(!JSON.stringify(data).includes(r.receiver.judgment.report));assert.ok(!JSON.stringify(data).includes(f.root));assert.ok(!('sourceGaps'in data.subject.members[0]));}
});
test('non-anchor conflicts wait without a claim; both later observations allow recovery and later conflicts withdraw the old judgment',async t=>{
  const f=await composition(t),time=Date.now()+60000,at=(offset:number)=>new Date(time+offset).toISOString();
  const conflict=async(offset:number)=>{const options={pr:1,H:f.H1,sourceAt:at(offset),executionAt:at(offset)};await f.addPacket({...options,artifactIndex:81});const result=await f.addPacket({...options,artifactIndex:82});assert.equal(result.observationConflict,true);return result;};
  await conflict(0);
  const blocked=await runReception(f.receiverPath);assert.deepEqual(blocked.blocked,['composition_member_currentness_unverified']);assert.equal(await f.count(),0);assert.equal(f.q.status().claims.length,0);assert.equal(f.q.status().operations.length,0);assert.equal(f.q.status().items.find((i:any)=>i.id===f.imported.item).compositionCurrent,false);
  // These are explicitly synthetic observation times. Existing real Docker
  // outputs stay unchanged; this tests ordering, not a fresh execution claim.
  const refresh=async(label:string,sourceAt:string,executionAt:string)=>{
    const paths=[join(f.root,label+'-a'),join(f.root,label+'-b')],verification=join(f.root,label+'-verification');await cp(f.verification,verification,{recursive:true});const report=JSON.parse(await readFile(join(verification,'verification.json'),'utf8'));
    for(const [i,path] of paths.entries()){await cp(f.snapshots[i]!,path,{recursive:true});const m=JSON.parse(await readFile(join(path,'manifest.json'),'utf8'));m.candidate.observedAt=sourceAt;const ref=m.artifacts[0],raw=Buffer.from(JSON.stringify({fixture:true,observationTag:label,member:i}));await writeFile(join(path,ref.path),raw);ref.sha256=hash(raw);ref.bytes=raw.length;const bytes=Buffer.from(JSON.stringify(m)),sha256=hash(bytes);await writeFile(join(path,'manifest.json'),bytes);await writeFile(join(verification,'raw',sha256+'.bin'),bytes);report.inputs[i]={...report.inputs[i],candidate:m.candidate,manifestHash:sha256,manifest:{path:'raw/'+sha256+'.bin',sha256,bytes:bytes.length}};}
    report.startedAt=executionAt;report.finishedAt=executionAt;await writeFile(join(verification,'verification.json'),JSON.stringify(report));const packet=await readPacket(paths[1]!,verification,f.context,paths);assert.equal(packet.summary.evidenceComplete,true);f.q.import(packet);return packet;
  };
  await refresh('source-only',at(1000),at(0));assert.equal(f.q.status().items.find((i:any)=>i.id===f.imported.item).compositionCurrent,false);assert.deepEqual((await runReception(f.receiverPath)).blocked,['composition_member_currentness_unverified']);
  const packet=await refresh('jointly-later',at(2000),at(2000));assert.equal(f.q.status().items.find((i:any)=>i.id===f.imported.item).compositionCurrent,true);
  await writeFile(f.receiverPath,JSON.stringify({...f.receiverPlan,memberSources:f.receiverPlan.memberSources.map((m:any,i:number)=>({...m,manifestHash:packet.summary.composition!.subject.members[i]!.manifestHash}))}));
  const returned=await runReception(f.receiverPath);assert.equal(returned.receiver.currentMaterialMatches,true);assert.equal(await f.count(),1);
  await conflict(3000);assert.equal(f.q.receiverState(returned.operation).result.receiver.currentMaterialMatches,false);const old=await runReception(f.receiverPath);assert.equal(old.duplicate,true);assert.equal(old.receiver.currentMaterialMatches,false);assert.equal(await f.count(),1);
  const candidate={repository:returned.candidate.repository,pr:returned.candidate.pr,H:returned.candidate.H,B:returned.candidate.B,target:returned.candidate.targetRef},before=await observeTask(f.store,f.imported.item,candidate);
  await refresh('new-current-material',at(4000),at(4000));const after=await observeTask(f.store,f.imported.item,candidate);assert.notEqual(after.originalSubjectSha256,before.originalSubjectSha256);assert.equal(after.operations[0]!.originalSubjectSha256,returned.receiver.subjectSha256);assert.equal(after.operations[0]!.subject!.testedTree,returned.receiver.subject.testedTree);
});
test('missing or reordered member snapshots and tampered prefix identities never become complete evidence',async t=>{
  const f=await composition(t);
  await assert.rejects(readPacket(f.snapshots[1]!,f.verification,f.context,[f.snapshots[1]!]),/all_ordered_composition_snapshots_required/);
  await assert.rejects(readPacket(f.snapshots[0]!,f.verification,f.context,[f.snapshots[1]!,f.snapshots[0]!]),/composition_manifest_order_mismatch/);
  const changed=join(f.root,'changed-prefix');await cp(f.verification,changed,{recursive:true});const report=JSON.parse(await readFile(join(changed,'verification.json'),'utf8'));report.stages[1].inputHead=f.H2;await writeFile(join(changed,'verification.json'),JSON.stringify(report));
  const packet=await readPacket(f.snapshots[1]!,changed,f.context,f.snapshots);assert.equal(packet.summary.evidenceComplete,false);assert.ok(packet.summary.gaps.includes('stage_identity_chain_mismatch'));
  const corrupt=join(f.root,'corrupt-first');await cp(f.snapshots[0]!,corrupt,{recursive:true});const manifest=JSON.parse(await readFile(join(corrupt,'manifest.json'),'utf8'));await writeFile(join(corrupt,manifest.artifacts[0].path),'changed');await assert.rejects(readPacket(f.snapshots[1]!,f.verification,f.context,[corrupt,f.snapshots[1]!]),/source_integrity_failed/);
});
test('single-member plans cannot start a composition and incomplete member source selections are refused before any model',async t=>{
  const f=await composition(t),bad=join(f.root,'bad-plan.json');
  await writeFile(bad,JSON.stringify({...f.plan,item:f.imported.item,sourcePaths:['b.txt']}));await assert.rejects(runReception(bad),/receiver_subject_plan_mismatch/);assert.equal(await f.count(),0);
  await writeFile(bad,JSON.stringify({...f.receiverPlan,memberSources:[f.receiverPlan.memberSources[0]]}));await assert.rejects(runReception(bad),/invalid_receiver_plan/);assert.equal(await f.count(),0);
  const result=await runReception(f.receiverPath);assert.equal(result.receiver.phase,'returned');assert.equal(await f.count(),1);
});
test('updating any earlier member invalidates only the related composite judgment, not an unrelated task',async t=>{
  const f=await composition(t),r=await runReception(f.receiverPath);
  await git(f.objects,['switch','component-a']);await writeFile(join(f.objects,'a.txt'),'A2\n');await git(f.objects,['add','.']);await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m','new exact member']);const newer=await git(f.objects,['rev-parse','HEAD']);
  await f.addPacket({pr:1,H:newer,sourceAt:new Date(Date.now()+30000).toISOString()});assert.equal(f.q.receiverState(r.operation).result.receiver.currentMaterialMatches,false);
  const other=await f.addPacket({pr:3,H:f.H2,sourceAt:new Date(Date.now()+31000).toISOString(),target:'unrelated'}),path=join(f.root,'unrelated.json');await writeFile(path,JSON.stringify({...f.plan,item:other.item,sourcePaths:['b.txt']}));const result=await runReception(path);assert.equal(result.receiver.phase,'returned');assert.equal(result.receiver.currentMaterialMatches,true);
});
test('wrong returned subject remains unresolved and an old sender cannot reserve without the subject binding',async t=>{
  const f=await composition(t);await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('reviewedSubjectSha256:x.binding.subjectSha256',"reviewedSubjectSha256:'0'.repeat(64)"));
  const r=await runReception(f.receiverPath);assert.equal(r.status,'receiver_unknown');assert.equal(f.q.status().claims.length,1);const before=await f.count();assert.equal((await runReception(f.receiverPath)).status,'receiver_unknown');assert.equal(await f.count(),before);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{const row=db.prepare('SELECT result FROM operations WHERE id=?').get(r.operation) as any,old=JSON.parse(row.result);delete old.receiver.subjectSha256;delete old.receiver.subject;assert.throws(()=>db.prepare("UPDATE operations SET status='receiving',result=? WHERE id=?").run(JSON.stringify(old),r.operation),/composition_receiver_subject_required/);}finally{db.close();}
  assert.equal(f.q.receiverState(r.operation).receiver.subjectSha256,f.packet.summary.composition!.sha256);
});
test('moving identical raw artifacts between members changes semantic identity; a missing member observation is not a fresh joint observation',async t=>{
  const f=await composition(t),paths=[join(f.root,'rebound-a'),join(f.root,'rebound-b')],verification=join(f.root,'rebound-verification');
  for(const [i,path] of paths.entries())await cp(f.snapshots[i]!,path,{recursive:true});await cp(f.verification,verification,{recursive:true});
  const manifests=await Promise.all(paths.map(async path=>JSON.parse(await readFile(join(path,'manifest.json'),'utf8'))));
  for(const [i,m] of manifests.entries())for(const ref of m.artifacts)await cp(join(f.snapshots[i]!,ref.path),join(paths[1-i]!,ref.path));
  [manifests[0].artifacts,manifests[1].artifacts]=[manifests[1].artifacts,manifests[0].artifacts];
  const report=JSON.parse(await readFile(join(verification,'verification.json'),'utf8'));
  const rebind=async()=>{for(const [i,m] of manifests.entries()){const b=Buffer.from(JSON.stringify(m)),sha256=hash(b);await writeFile(join(paths[i]!,'manifest.json'),b);await writeFile(join(verification,'raw',sha256+'.bin'),b);report.inputs[i]={...report.inputs[i],candidate:m.candidate,manifestHash:sha256,manifest:{path:'raw/'+sha256+'.bin',sha256,bytes:b.length}};}await writeFile(join(verification,'verification.json'),JSON.stringify(report));};
  await rebind();const moved=await readPacket(paths[1]!,verification,f.context,paths);assert.equal(moved.summary.evidenceComplete,true);assert.notEqual(moved.fingerprint,f.packet.fingerprint);
  manifests[0].candidate.observedAt='unknown';await rebind();const missing=await readPacket(paths[1]!,verification,f.context,paths);assert.equal(missing.summary.evidenceComplete,false);assert.equal(missing.summary.sourceObservation,null);assert.ok(missing.summary.gaps.includes('member:0:observation_time_unavailable'));
});
