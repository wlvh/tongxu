import type test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {setup} from '../w3/receiver-fixture.js';
import {Snapshot,hash} from '../../src/snapshot.js';
import {git} from '../../src/repair-workspace.js';
import {verify} from '../../src/verification.js';
import {readPacket} from '../../src/queue-evidence.js';
import {canonical} from '../../src/comparison.js';
import {runIntegration} from '../../src/integration.js';
import type {IntegrationRequest} from '../../src/integration-contract.js';

export const raw=(x:unknown)=>Buffer.from(canonical(x));
export type MemberScenario={seed:(objects:string)=>Promise<void>;changeA:(objects:string)=>Promise<void>};
export async function integrationFixture(t:test.TestContext,scenario?:MemberScenario){
  const config=process.env.TONGXU_TEST_DOCKER_CONFIG;if(!config)throw new Error('TONGXU_TEST_DOCKER_CONFIG_required');const docker=JSON.parse(await readFile(config,'utf8')),hooks:Array<()=>unknown>=[],f=await setup({after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext);
  t.after(async()=>{if(process.env.TONGXU_INTEGRATION_TEST_EVIDENCE){const parent=process.env.TONGXU_INTEGRATION_TEST_EVIDENCE;await mkdir(parent,{recursive:true});await cp(f.root,join(parent,basename(f.root)),{recursive:true});}for(const fn of hooks.reverse())await fn();});
  const objects=f.plan.objects;
  const commit=async(message:string)=>{await git(objects,['add','.']);await git(objects,['-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-m',message]);return git(objects,['rev-parse','HEAD']);};
  await writeFile(join(objects,'scale.json'),'1\n');await writeFile(join(objects,'consumer.json'),'1\n');await scenario?.seed(objects);const B=await commit('base units contract');
  await git(objects,['switch','-c','member-a',B]);await writeFile(join(objects,'scale.json'),'1000\n');await scenario?.changeA(objects);const A=await commit('producer changes units');
  await git(objects,['switch','-c','member-b',B]);await writeFile(join(objects,'consumer.json'),'1000\n');const C=await commit('consumer changes units');
  const snapshots:string[]=[],at=new Date().toISOString();for(const [index,H] of [A,C].entries()){
    const path=join(f.root,'member-snapshot-'+index),s=await Snapshot.create(path,'fixture/reception',index+10,[],[]);s.manifest.candidate={repository:'fixture/reception',pr:index+10,H,B,mergeBase:B,targetRef:'fixture',observedAt:at};await s.artifact(JSON.stringify({explicitFixture:true,H,B}),{kind:'pr',round:1,retrievedAt:at,provenance:'explicit-local-fixture',status:200});s.manifest.rounds.push({number:1,startedAt:at,finishedAt:at,coverage:{},sources:[],notes:[],gaps:[],limitations:['explicit_fixture'],current:true});await s.save();await s.close();snapshots.push(path);
  }
  const script="const fs=require('node:fs'),producer=JSON.parse(fs.readFileSync('scale.json','utf8')),consumer=JSON.parse(fs.readFileSync('consumer.json','utf8'));fs.writeFileSync(process.env.TONGXU_RESULT_FILE,JSON.stringify({samples:[{id:'units-contract',status:producer===consumer?'ok':'fail',content:{producer,consumer},identity:'fixed-unit-contract',source:'actual isolated JSON files',sideEffects:[]}]}));",plan=join(f.root,'units-test.json');await writeFile(plan,raw({schemaVersion:2,executor:docker,tools:[{id:'units-check',argv:[docker.node,'-e',script],timeoutMs:10000,expectedSampleIds:['units-contract']}]}));
  const onlyB=await verify({snapshots:[snapshots[1]!],objects,plan,output:join(f.root,'member-b-verification')});assert.equal(onlyB.report.stages[1]!.tools[0]!.sampleSet!.samples[0]!.status,'fail');
  const verification=join(f.root,'composition-verification'),result=await verify({snapshots,objects,plan,output:verification});assert.equal(result.report.stages[1]!.tools[0]!.sampleSet!.samples[0]!.status,'fail');assert.equal(result.report.stages[2]!.tools[0]!.sampleSet!.samples[0]!.status,'ok');
  const context={schemaVersion:1,scope:{id:'minimum-units',version:'S1',source:'explicit isolated minimum composition fixture'},arrangement:{id:'two-members',version:'r1',source:'explicit bounded selection'},decisionKind:'fact',requires:[]},contextPath=join(f.root,'integration-context.json');await writeFile(contextPath,raw(context));f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();const packet=await readPacket(snapshots[1]!,verification,contextPath,snapshots),imported=f.q.import(packet);assert.equal(packet.summary.evidenceComplete,false);const begun=f.q.begin(imported.item,'explicit-minimum-integration');assert.ok(begun.operation);f.q.evaluate(begun.operation);
  await git(objects,['switch','member-a']);await writeFile(join(objects,'unselected-extra.txt'),'This unrelated A3 commit must not enter the candidate.\n');const A3=await commit('unselected author work');await writeFile(join(objects,'scale.json'),'2000\n');await writeFile(join(objects,'author-staged.txt'),'uncommitted staged owner file\n');await git(objects,['add','author-staged.txt']);
  const request:IntegrationRequest={schemaVersion:1,kind:'tongxu-minimal-integration',id:'units-selected-two',operation:begun.operation,subjectSha256:packet.summary.composition!.sha256,scopeSha256:hash(canonical(context.scope)),arrangementSha256:hash(canonical(context.arrangement)),objects,selectionReason:'Both fixed changes are necessary together; preserve the failed single-member prefix and validate the new candidate independently.',source:'explicit two-member Git/Docker fixture, not a real product defect',authorityIntent:null},path=join(f.root,'integration-request.json');await writeFile(path,raw(request));
  const authorState=async()=>({head:await git(objects,['rev-parse','HEAD']),refs:await git(objects,['show-ref']),status:await git(objects,['status','--porcelain=v1','-z']),index:hash(await readFile(join(objects,'.git/index'))),scale:await readFile(join(objects,'scale.json'),'utf8'),staged:await readFile(join(objects,'author-staged.txt'),'utf8')});
  return {...f,addPacket:f.packet,objects,B,A,C,A3,snapshots,verification,verificationResult:result,context,packet,imported,operation:begun.operation,request,path,authorState};
}
/** The new PR identity is explicitly a local fixture. Its tests are real W2
 * executions; no recorded member PASS or fabricated PR publication is reused. */
export async function candidateFixture(t:test.TestContext,scenario?:MemberScenario){
  const f=await integrationFixture(t,scenario),produced=await runIntegration(f.store,f.path);assert.equal(produced.phase,'produced');assert.ok('result' in produced);const c=produced.result!.candidate,objects=join(produced.directory,'candidate.git'),snapshot=join(f.root,'integration-pr-snapshot'),at=new Date().toISOString(),s=await Snapshot.create(snapshot,c.repository,99,[],[]);
  s.manifest.candidate={repository:c.repository,pr:99,H:c.H,B:c.B,targetRef:c.target,mergeBase:c.B,observedAt:at};await s.artifact(raw({explicitFixture:true,newPR:99,H:c.H,B:c.B,source:'local fixture of independently collected PR identity; no GitHub publication'}),{kind:'pr',round:1,retrievedAt:at,provenance:'explicit-local-fixture',status:200});s.manifest.rounds.push({number:1,startedAt:at,finishedAt:at,coverage:{},sources:[],notes:[],gaps:[],limitations:['explicit_PR_identity_fixture'],current:true});await s.save();await s.close();
  const verification=join(f.root,'integration-own-verification'),verified=await verify({snapshots:[snapshot],objects,plan:join(f.root,'units-test.json'),output:verification});assert.equal(verified.exit,0);assert.equal(verified.report.observedSampleFailures,0);const packet=await readPacket(snapshot,verification,join(f.root,'integration-context.json')),imported=f.q.import(packet);assert.equal(packet.summary.evidenceComplete,true);
  const link={schemaVersion:1,kind:'tongxu-integration-candidate',integration:f.request.id,item:imported.item,packet:imported.packet,fingerprint:packet.fingerprint,source:'explicit fixture new PR99, own actual W2 verification'},receiverPlan={...f.plan,item:imported.item,objects,sourcePaths:['scale.json','consumer.json']},receiverPath=join(f.root,'integration-receiver.json');await writeFile(receiverPath,raw(receiverPlan));
  return {...f,produced,candidate:c,candidateSnapshot:snapshot,candidateVerification:verification,candidatePacket:packet,candidateItem:imported.item,link,receiverPath,receiverPlan};
}
