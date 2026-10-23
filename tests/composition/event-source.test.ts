import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,rm,mkdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {setup} from '../w3/receiver-fixture.js';
import {Snapshot,hash} from '../../src/snapshot.js';
import {git} from '../../src/repair-workspace.js';
import {verify} from '../../src/verification.js';
import {readPacket} from '../../src/queue-evidence.js';
import {runReception} from '../../src/receiver.js';
import {sourceTick} from '../../src/event-tick.js';
const dockerPath=process.env.TONGXU_TEST_DOCKER_CONFIG;
if(!dockerPath)throw new Error('TONGXU_TEST_DOCKER_CONFIG required');
// Actual Git, Docker prefixes and readonly child; model messages are fixtures.
// Regression for independent EV-F1: A1 and A2 share a PR, but only A2 is current.
test('repeated PR in ordered composition compares the exact last member material, retains old report and delivers the new source',async t=>{
 const f=await setup(t,'complete',2,false),objects=f.plan.objects;let passed=false;
 t.after(async()=>{if(passed)await rm(f.root,{recursive:true,force:true});else{const retained=resolve(process.env.TONGXU_TEST_FAILURE_DIRECTORY??'.test-failures',basename(f.root));await mkdir(resolve(retained,'..'),{recursive:true});await cp(f.root,retained,{recursive:true,errorOnExist:true,force:false});t.diagnostic('Failure retained at '+f.root+' and '+retained);}});
const B=await git(objects,['rev-parse',f.H+'^']);
async function member(branch:string,base:string,file:string,text:string){await git(objects,['switch','-c',branch,base]);await writeFile(join(objects,file),text);await git(objects,['add','.']);await git(objects,['-c','user.name=independent-fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m',branch]);return git(objects,['rev-parse','HEAD']);}
const A1=await member('independent-a1',B,'a.txt','A1\n'),B1=await member('independent-b1',B,'b.txt','B\n'),A2=await member('independent-a2',A1,'a.txt','A2\n');
const descriptions=[{pr:1,H:A1,body:'Requirement before the final A2 stage.'},{pr:2,H:B1,body:'Independent B requirement.'},{pr:1,H:A2,body:'Updated requirement reviewed with the final A2 stage.'}],snapshots:string[]=[],at=new Date().toISOString();
for(const [i,d]of descriptions.entries()){
 const path=join(f.root,'ordered-member-'+i),s=await Snapshot.create(path,'fixture/reception',d.pr,[],[]);
 s.manifest.candidate={repository:'fixture/reception',pr:d.pr,H:d.H,B,mergeBase:B,targetRef:'fixture',observedAt:at};
 const material=[['pr',{number:d.pr,body:d.body,comments:0,review_comments:0}],['pr_comments',[]],['review_comments',[]],['reviews',[]]] as const;
 for(const [kind,value]of material)await s.artifact(JSON.stringify(value),{kind,round:1,page:1,retrievedAt:at,provenance:'explicit-independent-local-fixture',status:200});
 s.manifest.rounds.push({number:1,startedAt:at,finishedAt:at,coverage:Object.fromEntries(material.map(([kind,value])=>[kind,{state:'complete',pages:1,records:Array.isArray(value)?value.length:1,ids:Array.isArray(value)?[]:[String(d.pr)],nextPage:null,termination:'explicit_fixture_complete',errors:[]}])),sources:[],notes:[],gaps:[],limitations:['explicit_fixture'],current:true});await s.save();await s.close();snapshots.push(path);
}
const docker=JSON.parse(await readFile(dockerPath,'utf8')),plan=join(f.root,'prefix-checks.json');
const script="const fs=require('node:fs'),a=require('node:assert/strict');for(const f of ['a.txt','b.txt'])if(fs.existsSync(f))a.ok(['A1\\n','A2\\n','B\\n'].includes(fs.readFileSync(f,'utf8')));fs.writeFileSync(process.env.TONGXU_RESULT_FILE,JSON.stringify({samples:[{id:'ordered-prefix',status:'ok',content:['a.txt','b.txt'].filter(f=>fs.existsSync(f)).map(f=>[f,fs.readFileSync(f,'utf8')]),identity:'explicit-a1-b1-a2-fixture',source:'actual-fixed-Git-files',sideEffects:[]}]}));";
await writeFile(plan,JSON.stringify({schemaVersion:2,executor:docker,tools:[{id:'independent-prefix-check',argv:[docker.node,'-e',script],timeoutMs:10000,expectedSampleIds:['ordered-prefix']}]}));
const verification=join(f.root,'ordered-verification'),verified=await verify({snapshots,objects,plan,output:verification});assert.equal(verified.exit,0,JSON.stringify(verified.report.gaps));assert.equal(verified.report.stages.length,4);
const context=join(f.root,'ordered-context.json');await writeFile(context,JSON.stringify({schemaVersion:1,scope:{id:'scope',version:'S1',source:'explicit-fixture'},arrangement:{id:'team',version:'r1',source:'explicit-fixture'},decisionKind:'fact',requires:[]}));
f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();
const packet=await readPacket(snapshots[2]!,verification,context,snapshots),imported=f.q.import(packet);assert.equal(packet.summary.evidenceComplete,true,JSON.stringify(packet.summary.gaps));
const receiver=join(f.root,'ordered-receiver.json');await writeFile(receiver,JSON.stringify({...f.plan,schemaVersion:2,item:imported.item,sourcePaths:[],memberSources:packet.summary.composition!.subject.members.map((m,i)=>({index:i,manifestHash:m.manifestHash,sourcePaths:[i===1?'b.txt':'a.txt','sample.js']}))}));
const accepted=await runReception(receiver);assert.equal(accepted.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');const originalInput=await readFile(join(accepted.receiver.directory,'binding-input.json'));
const sourceFile=join(f.root,'independent-live-source.json'),sourceExe=join(f.root,'independent-source.mjs');
const state={subjects:{1:{H:A2,B,target:'fixture',body:descriptions[0]!.body,comments:[]},2:{H:B1,B,target:'fixture',body:descriptions[1]!.body,comments:[]}},requests:[]};await writeFile(sourceFile,JSON.stringify(state));
const source=`#!${process.execPath}\nimport fs from'node:fs';const f=${JSON.stringify(sourceFile)},s=JSON.parse(fs.readFileSync(f,'utf8')),a=process.argv.slice(2),path=a.at(-1),method=a[a.indexOf('--method')+1];if(method!=='GET')throw new Error('independent fixture GET only');s.requests.push({path,method});const root='repos/fixture/reception',m=path.match(/\\/(?:pulls|issues)\\/(\\d+)(?:[/?]|$)/),pr=m?Number(m[1]):null,c=pr?s.subjects[pr]:null;let value,status=200;if(c&&path===root+'/pulls/'+pr)value={number:pr,body:c.body,state:'open',draft:false,comments:c.comments.length,review_comments:0,head:{sha:c.H,repo:{id:12}},base:{sha:'0'.repeat(40),ref:c.target,repo:{id:12,full_name:'fixture/reception'}}};else if(path===root+'/git/ref/heads/fixture')value={ref:'refs/heads/fixture',object:{type:'commit',sha:s.subjects[1].B}};else if(path.includes('/check-runs?'))value={total_count:0,check_runs:[]};else if(path.includes('/statuses?')||path.includes('/reviews?')||path.includes('/pulls/')&&path.includes('/comments?'))value=[];else if(c&&path.includes('/issues/')&&path.includes('/comments?'))value=c.comments;else{status=404;value={message:'fixture exact endpoint missing'};}fs.writeFileSync(f,JSON.stringify(s));process.stdout.write('HTTP/2 '+status+' Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(value));process.exitCode=status===200?0:1;`;
await writeFile(sourceExe,source,{mode:0o700});
f.q.events().configure(Buffer.from(JSON.stringify({schemaVersion:1,kind:'tongxu-bounded-event-source',repository:'fixture/reception',repositoryId:12,ghExecutable:sourceExe,ghSha256:hash(source),executionKind:'fixture',prs:[1,2],pollIntervalMs:10,maxSubjectsPerTick:2})));
const first=await sourceTick(f.store),changed=first.materials.items.find(x=>x.item===imported.item)!;
assert.equal(first.state.subjects.find(x=>x.pr===1)!.complete,true);
assert.equal(changed.changed,true);assert.notEqual(changed.packet,accepted.packet);
assert.equal(f.q.receiverState(accepted.operation).result.receiver.currentMaterialMatches,false);
assert.deepEqual(await readFile(join(accepted.receiver.directory,'binding-input.json')),originalInput);assert.equal(await f.count(),1);
const next=await runReception(receiver);assert.notEqual(next.operation,accepted.operation);assert.equal(next.receiver.currentMaterialMatches,true);assert.equal(await f.count(),2);
const sent=JSON.parse(f.q.receiverState(next.operation).input.toString());const updated=sent.data.evidence.sourceEvents.find((x:any)=>x.pr===1);
assert.equal(updated.candidate.H,A2);assert.ok(updated.originals.some((x:any)=>x.kind==='pr'&&x.text.includes(descriptions[0]!.body)));
assert.equal((await sourceTick(f.store)).materials.items.find(x=>x.item===imported.item)!.changed,false);assert.equal((await runReception(receiver)).operation,next.operation);assert.equal(await f.count(),2);
const current=JSON.parse(await readFile(sourceFile,'utf8'));current.subjects[2].comments=[{id:991,user:{id:33},body:'New non-anchor requirement'}];await writeFile(sourceFile,JSON.stringify(current));
const nonAnchor=await sourceTick(f.store);assert.equal(nonAnchor.materials.items.find(x=>x.item===imported.item)!.changed,true);assert.equal(f.q.receiverState(next.operation).result.receiver.currentMaterialMatches,false);assert.equal(await f.count(),2);
passed=true;
});
