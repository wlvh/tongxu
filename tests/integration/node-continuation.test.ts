import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {inspectObjectSource} from '../../src/integration-objects.js';
import {integrationRecipe,readIntegrationCapture,type IntegrationMaterial} from '../../src/integration-producer.js';
import {captureIntegrationGit,readIntegrationGit} from '../../src/integration-git.js';
import {inspectIntegrationContinuation,recordIntegrationContinuation,recordIntegrationBoundary,checkIntegrationContinuationBoundary,integrationControllerReturned} from '../../src/integration-continuation.js';

// Actual local Git commands and raw captures. The declared composition is a
// test scenario, not a Docker test result, model execution or user acceptance.
test('an ended Git producer can continue on current Node without matching its original executable or release',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-node-continuation-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const objects=join(root,'objects'),directory=join(root,'operation');await mkdir(objects);await mkdir(directory,{mode:0o700});await mkdir(join(directory,'candidate.git'),{mode:0o700});await mkdir(join(directory,'steps'),{mode:0o700});
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',objects,...args],{encoding:'utf8'}).trim();git('init','--initial-branch=fixture');
 const commit=(message:string)=>{git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m',message);return git('rev-parse','HEAD');};
 await writeFile(join(objects,'value.txt'),'before\n');const B=commit('explicit fixture base');await writeFile(join(objects,'value.txt'),'after\n');const H=commit('explicit fixture member'),T=git('rev-parse','HEAD^{tree}');
 const subject={repository:'fixture/runtime',B,targetRef:'fixture',testedTree:T,members:[{candidate:{B,H}}]},source={composition:{subject},report:{stages:[{head:B},{head:H,tree:T}]}},request={objects,operation:randomUUID(),subjectSha256:hash(canonical(subject))};
 const m:IntegrationMaterial={request,source,directory,requestSha256:hash(canonical(request)),objectSource:await inspectObjectSource(objects)},material=join(root,'material.json');await writeFile(material,canonical(m));
 const modules=new URL('../../src/',import.meta.url).href;
 const producerScript=`import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {canonical} from ${JSON.stringify(modules+'comparison.js')};import {hash} from ${JSON.stringify(modules+'snapshot.js')};
import {integrationRuntimeHashes,recordIntegrationBoundary,integrationControllerReturned} from ${JSON.stringify(modules+'integration-continuation.js')};
import {integrationRecipe} from ${JSON.stringify(modules+'integration-producer.js')};import {captureIntegrationGit} from ${JSON.stringify(modules+'integration-git.js')};
const m=JSON.parse(await readFile(process.argv[1],'utf8')),layout=Buffer.from(canonical(m.objectSource)),id=randomUUID();await writeFile(join(m.directory,'object-source.json'),layout);
const producer=Buffer.from(canonical({kind:'tongxu-fixed-git-integration',requestSha256:m.requestSha256,sourceSha256:hash(canonical(m.source)),directory:m.directory,objectSourceSha256:hash(layout),controllerId:id,controllerPid:process.pid,continuationProtocol:'ended-fixed-prefix-v1',runtimeModules:await integrationRuntimeHashes(),node:{version:process.version,executable:process.execPath}}));await writeFile(join(m.directory,'producer.json'),producer);
const initial=await recordIntegrationBoundary(m,'initial',null,null),refs=[{name:'initial',sha256:initial.sha256}];let last=initial.sha256;const stop=Error('explicit_fixture_pause');
try{await integrationRecipe(m,async(name,step)=>{if(name==='002-source-pack')throw stop;const r=await captureIntegrationGit(join(m.directory,'steps',name),step,f=>f());if(!r.successful)throw Error('fixture_git_failed');const b=await recordIntegrationBoundary(m,name,r,last);refs.push({name,sha256:b.sha256});last=b.sha256;return r;});}catch(e){if(e!==stop)throw e;}
await integrationControllerReturned(m.directory,id,hash(producer));await writeFile(join(m.directory,'fixture-boundaries.json'),canonical(refs));console.log(JSON.stringify({id,node:process.version,executable:process.execPath}));`;
 const previousNode=process.env.TONGXU_TEST_PRIOR_NODE??process.execPath;
 const previous=JSON.parse(execFileSync(previousNode,['--input-type=module','-e',producerScript,material],{encoding:'utf8',timeout:30000}));
 const producer=await readFile(join(directory,'producer.json')),originalSteps=new Map<string,Buffer>();for(const name of await readdir(join(directory,'steps')))for(const file of await readdir(join(directory,'steps',name)))originalSteps.set(join(directory,'steps',name,file),await readFile(join(directory,'steps',name,file)));
 const proof=await inspectIntegrationContinuation(m);assert.equal(proof.nextStep,'002-source-pack');assert.deepEqual(proof.completedSteps,['000-git-version','001-init']);assert.equal(JSON.parse(producer.toString()).node.executable,previous.executable);
 const boundaryPath=join(directory,'candidate.git/unexplained');await writeFile(boundaryPath,'explicit unknown change');await assert.rejects(inspectIntegrationContinuation(m),/private_state_changed/);await rm(boundaryPath);
 const returned=join(directory,'controller-returns',previous.id+'.json'),saved=await readFile(returned),p=JSON.parse(producer.toString());
 // A live/unknown original controller still refuses even with a compatible Node.
 await rename(returned,returned+'.held');await writeFile(join(directory,'producer.json'),canonical({...p,controllerPid:process.pid}));await assert.rejects(inspectIntegrationContinuation(m),/controller_active_or_unknown/);await writeFile(join(directory,'producer.json'),producer);await rename(returned+'.held',returned);assert.deepEqual(await readFile(returned),saved);
 const currentProof=await inspectIntegrationContinuation(m),id=randomUUID(),continuation=JSON.parse((await recordIntegrationContinuation(directory,id,currentProof)).toString());assert.equal(continuation.node.nodeVersion,process.version);assert.equal(continuation.node.nodeExecutable,process.execPath);
 const boundaries=JSON.parse(await readFile(join(directory,'fixture-boundaries.json'),'utf8'));let last=currentProof.lastBoundarySha256,newSteps=0;
 const result=await integrationRecipe(currentProof.material,async(name,step)=>{
  if(currentProof.completedSteps.includes(name))return readIntegrationGit(join(directory,'steps',name),step);
  if(newSteps===0)checkIntegrationContinuationBoundary(currentProof);const r=await captureIntegrationGit(join(directory,'steps',name),step,f=>f());newSteps++;assert.equal(r.successful,true);
  const b=await recordIntegrationBoundary(m,name,r,last);boundaries.push({name,sha256:b.sha256});last=b.sha256;return r;
 });
 assert.equal(result.candidate.T,T);assert.equal(newSteps,result.steps-2);assert.deepEqual(await readFile(join(directory,'producer.json')),producer);for(const [path,bytes] of originalSteps)assert.deepEqual(await readFile(path),bytes);
 const replay=await readIntegrationCapture({...m,boundaryRecords:boundaries});assert.equal(replay.success,true);await integrationControllerReturned(directory,id,hash(producer));await assert.rejects(inspectIntegrationContinuation(m),/complete_capture_use_reconcile/);
});
