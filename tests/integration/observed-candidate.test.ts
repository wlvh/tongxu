import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {candidateFixture,raw} from './fixture.js';
import {hash} from '../../src/snapshot.js';
import {runObservedCandidate} from '../../src/observed-candidate.js';
import {observeRemoteCandidate} from '../../src/observed-candidate-source.js';
import {parseObservedCandidateRequest} from '../../src/observed-candidate-contract.js';
import {runReception} from '../../src/receiver.js';

async function fixture(t:test.TestContext){
  const f=await candidateFixture(t),remote=join(f.root,'observed-remote.json'),exe=join(f.root,'observed-gh.mjs'),c=f.candidate;
  const initial={repository:c.repository,repositoryId:71,pr:99,H:c.H,B:c.B,refB:c.B,target:c.target,mode:'normal',count:0,prCount:0};await writeFile(remote,raw(initial));
  await writeFile(exe,`#!${process.execPath}
import fs from 'node:fs';
const path=${JSON.stringify(remote)},args=process.argv.slice(2),method=args[args.indexOf('--method')+1],endpoint=args.at(-1),r=JSON.parse(fs.readFileSync(path,'utf8'));r.count++;const base='repos/'+r.repository,repo={id:r.repositoryId,full_name:r.repository};let status=200,value;
if(method!=='GET')throw new Error('fixture_mutation_forbidden');
if(endpoint===base)value=repo;
else if(endpoint===base+'/pulls/'+r.pr){r.prCount++;value={number:r.pr,state:r.mode==='closed'?'closed':'open',merged:false,html_url:'https://github.com/'+r.repository+'/pull/'+r.pr,head:{sha:r.mode==='changing'&&r.prCount%2===0?'a'.repeat(40):r.H,ref:'fixture-integration',repo},base:{sha:r.B,ref:r.target,repo}};}
else if(endpoint===base+'/git/ref/heads/'+encodeURIComponent(r.target))value={ref:'refs/heads/'+r.target,object:{type:'commit',sha:r.refB??r.B}};
else{status=404;value={message:'fixed fixture missing'};}
fs.writeFileSync(path,JSON.stringify(r));if(r.mode==='lost')process.exit(1);if(r.mode==='limited')status=429;process.stdout.write('HTTP/2.0 '+status+' Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(value));process.exitCode=status===200?0:1;
`,{mode:0o700});
  const p={...f.link,schemaVersion:1 as const,kind:'tongxu-observed-integration-candidate' as const,repositoryId:71,ghExecutable:exe,ghSha256:hash(await readFile(exe))},path=join(f.root,'observe-candidate.json');await writeFile(path,raw(p));
  const state=async()=>JSON.parse(await readFile(remote,'utf8')),change=async(v:Record<string,unknown>)=>writeFile(remote,raw({...await state(),...v}));return {...f,p,path,remote,exe,state,change,initial};
}

test('actual configured GET capture reaches the receiver with full originals; repeated CLI entries preserve the association and never run tests or roles',async t=>{
  const f=await fixture(t),old=await readFile(join(f.candidateVerification,'verification.json'));
  const r=await runObservedCandidate(f.store,f.path);assert.equal(r.duplicate,false);assert.equal(r.testsStarted,0);assert.equal(r.remoteWritePerformed,false);assert.equal((await f.state()).count,5);assert.equal(await f.count(),0);
  const invoke=async()=>{const child=spawn(process.execPath,[new URL('../../src/integration-cli.js',import.meta.url).pathname,'observe-candidate','--store',f.store,'--request',f.path],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const [code]=await once(child,'close');return {code,stdout,stderr};};
  const calls=await Promise.all([invoke(),invoke()]);await writeFile(join(f.root,'observed-concurrent-cli.json'),raw(calls));assert.ok(calls.some(x=>x.code===0),JSON.stringify(calls));for(const x of calls.filter(x=>x.code===0)){const v=JSON.parse(x.stdout);assert.equal(v.duplicate,true);assert.equal(v.packet,r.packet);assert.equal(v.newModelInputs,0);assert.equal(v.testsStarted,0);}assert.equal(await f.count(),0);
  // Concurrent fixture reads can race on its request counter; a fresh exact
  // read resolves any conservative conflict before the independent receiver.
  await f.change({mode:'normal'});await runObservedCandidate(f.store,f.path);
  const reception=await runReception(f.receiverPath);assert.equal(reception.receiver.phase,'returned');assert.equal(reception.receiver.judgment.consumedIntegration,r.integrationSha256);assert.equal(await f.count(),1);
  const input=JSON.parse(f.q.receiverState(reception.operation).input.toString()),remote=input.data.evidence.integration.association.remoteObservation;assert.equal(remote.capture.observations.length,5);assert.equal(remote.capture.binding.H,f.candidate.H);assert.equal(remote.capture.remoteWritePerformed,false);
  for(const observation of remote.capture.observations)for(const o of observation.originals){const b=Buffer.from(o.text,'base64');assert.equal(hash(b),o.sha256);assert.equal(b.length,o.bytes);}assert.ok((await readFile(join(f.candidateVerification,'verification.json'))).equals(old));
});

test('remote differences, missing responses and wrong executable cannot associate; original capture is not executable authority and the same request recovers',async t=>{
  const f=await fixture(t),source=f.q.observedCandidateSource(raw(f.p));assert.throws(()=>f.q.attachObservedCandidate(raw(f.p),{observedAt:new Date().toISOString()} as any),/actual_current_candidate_observation_required/);
  for(const change of [{mode:'closed'},{H:'b'.repeat(40)},{refB:'c'.repeat(40)},{repositoryId:72},{mode:'changing'},{mode:'lost'},{mode:'limited'}]){await f.change({...f.initial,...change});await assert.rejects(runObservedCandidate(f.store,f.path),/observed_candidate_|publication_http_response_unknown/);assert.equal(f.q.status().items.find((i:any)=>i.id===f.candidateItem).currentPacket,f.link.packet);assert.equal(await f.count(),0);}
  await f.change(f.initial);const executable=await readFile(f.exe);await writeFile(f.exe,Buffer.concat([executable,Buffer.from('\n// changed\n')]));await assert.rejects(runObservedCandidate(f.store,f.path),/publication_gh_changed/);await writeFile(f.exe,executable);
  const captureDir=join(f.root,'read-proof');await mkdir(captureDir,{mode:0o700});const c=await observeRemoteCandidate(f.p,source,captureDir);assert.throws(()=>f.q.attachObservedCandidate(raw(f.p),JSON.parse(JSON.stringify(c))),/actual_current_candidate_observation_required/);
  f.q.observedCandidateProblem(raw(f.p),'explicit later fixture uncertainty');assert.throws(()=>f.q.attachObservedCandidate(raw(f.p),c),/newer_read_required/);
  const done=await runObservedCandidate(f.store,f.path);assert.equal(done.duplicate,false);assert.equal(await f.count(),0);assert.throws(()=>parseObservedCandidateRequest(raw({...f.p,command:'anything'})),/invalid/);
});

test('an old local association is preserved as a predecessor; occupied target and failed refresh stop new reception, then an exact reread recovers',async t=>{
  const f=await fixture(t),old=f.q.attachIntegrationCandidate(raw(f.link)),claim=f.q.begin(f.candidateItem,'explicit-owned-claim');assert.ok(claim.operation);await assert.rejects(runObservedCandidate(f.store,f.path),/occupied_or_unknown/);assert.equal(f.q.status().items.find((i:any)=>i.id===f.candidateItem).currentPacket,old.packet);f.q.evaluate(claim.operation);
  const r=await runObservedCandidate(f.store,f.path);assert.equal(r.duplicate,false);assert.notEqual(r.packet,old.packet);assert.equal(await f.count(),0);
  await f.change({H:'a'.repeat(40)});await assert.rejects(runObservedCandidate(f.store,f.path),/remote_changed/);await assert.rejects(runReception(f.receiverPath),/integration_remote_observation_unresolved/);assert.equal(await f.count(),0);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{const op=db.prepare('SELECT * FROM operations WHERE item=? ORDER BY rowid DESC LIMIT 1').get(f.candidateItem) as any;assert.throws(()=>db.prepare("UPDATE operations SET status='receiving' WHERE id=?").run(op.id),/integration_remote_observation_unresolved/);}finally{db.close();}
  await f.change(f.initial);const recovered=await runObservedCandidate(f.store,f.path);assert.equal(recovered.duplicate,true);assert.equal(recovered.packet,r.packet);const result=await runReception(f.receiverPath);assert.equal(result.receiver.phase,'returned');const m=JSON.parse(f.q.receiverState(result.operation).input.toString()).data.evidence.integration;assert.equal(m.association.previousAssociationSha256,old.integrationSha256);assert.equal(await f.count(),1);
});
