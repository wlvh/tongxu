import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,symlink,readdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicationHttp} from '../../src/publication-http.js';
import {capturedGhExecutableMatches,selectGhExecutable} from '../../src/gh-executable.js';
import {readPublicationDispatchCapture} from '../../src/publication-dispatch-capture.js';
import type {PublicationPlan} from '../../src/publication-contract.js';
import {observeRemoteCandidate,type ObservedCandidateBinding} from '../../src/observed-candidate-source.js';
import type {ObservedCandidateRequest} from '../../src/observed-candidate-contract.js';
import {hash} from '../../src/snapshot.js';

const endpoint='repos/fixture/upgrade/issues/1/comments';
const readEndpoint=endpoint+'?per_page=100&page=1';
async function fixture(t:test.TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-gh-upgrade-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const executable=join(root,'gh'),target=join(root,'gh-current.mjs'),trace=join(root,'api-calls');
 const code=(version:string,help=true)=>`#!${process.execPath}
import fs from 'node:fs';const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('gh version ${version} (explicit fixture)');process.exit(0);}
if(args[0]==='api'&&args[1]==='--help'){console.log(${JSON.stringify(help?'--hostname --method --include --input --header --raw-field':'--method')});process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,input})+'\\n');const endpoint=args.at(-1),repo={id:17,full_name:'fixture/upgrade'},value=endpoint==='repos/fixture/upgrade'?repo:endpoint==='repos/fixture/upgrade/git/ref/heads/main'?{ref:'refs/heads/main',object:{type:'commit',sha:'b'.repeat(40)}}:endpoint==='repos/fixture/upgrade/pulls/1'?{number:1,state:'open',merged:false,html_url:'https://github.com/fixture/upgrade/pull/1',head:{sha:'a'.repeat(40),ref:'feature',repo},base:{sha:'b'.repeat(40),ref:'main',repo}}:{id:123,fixtureOnly:true};process.stdout.write('HTTP/2.0 '+(args.includes('POST')?'201':'200')+' Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(value));
`;
 await writeFile(target,code('2.0.0'),{mode:0o700});await symlink(target,executable);const configured=hash(await readFile(target));await writeFile(target,code('99.0.0'),{mode:0o700});
 const http=()=>new PublicationHttp(root,executable,configured,'fixture/upgrade',1,'a'.repeat(40),'main');
 return {root,executable,target,trace,configured,code,http};
}
test('new gh captures accept an upgraded configured entry, preserve setup identity and replay without installed old gh',async t=>{
 const f=await fixture(t),http=f.http();const reply=await http.request('GET',readEndpoint);assert.equal(reply.status,200);
 const request=JSON.parse(await readFile(join(reply.directory,'request.json'),'utf8'));assert.notEqual(request.executableHash,f.configured);assert.equal(request.executableSelection.configuredSha256,f.configured);assert.match(request.executableSelection.version,/99\.0\.0/);assert.equal(capturedGhExecutableMatches(request,f.executable,f.configured),true);
 assert.equal(capturedGhExecutableMatches({...request,executableSelection:{...request.executableSelection,configuredSha256:'0'.repeat(64)}},f.executable,f.configured),false);
 assert.equal(capturedGhExecutableMatches({command:f.executable,executableHash:f.configured},f.executable,f.configured),true);
 const first=await readFile(f.trace);await writeFile(f.target,f.code('100.0.0'),{mode:0o700});await assert.rejects(http.request('GET',readEndpoint),/changed_during_operation/);assert.deepEqual(await readFile(f.trace),first);
 const updated=await f.http().request('GET',readEndpoint);assert.equal(updated.status,200);assert.equal(capturedGhExecutableMatches(request,f.executable,f.configured),true);
 await writeFile(f.target,f.code('101.0.0',false),{mode:0o700});await assert.rejects(selectGhExecutable(f.executable,f.configured),/gh_capability_missing/);
});
test('candidate observation reports the gh actually used, not the obsolete setup fingerprint',async t=>{
 const f=await fixture(t),p={ghExecutable:f.executable,ghSha256:f.configured,repositoryId:17} as ObservedCandidateRequest;
 const b={repository:'fixture/upgrade',pr:1,H:'a'.repeat(40),B:'b'.repeat(40),T:'c'.repeat(40),targetRef:'main'} as ObservedCandidateBinding;
 const observed=await observeRemoteCandidate(p,b,f.root);assert.equal(observed.observations.length,5);assert.equal(observed.executable.sha256,hash(await readFile(f.target)));assert.equal(observed.executable.configuredSha256,f.configured);assert.notEqual(observed.executable.sha256,f.configured);assert.equal(observed.remoteWritePerformed,false);
});
test('publication keeps exact POST input and no-resend capture across a gh upgrade; changing it at dispatch starts nothing',async t=>{
 const f=await fixture(t),payload={body:'Explicit local fixture, no remote publication'},input=Buffer.from(JSON.stringify(payload));
 const reply=await f.http().request('POST',endpoint,payload,{intent(){},started(){}});
 const p={ghExecutable:f.executable,ghSha256:f.configured} as PublicationPlan;
 const prepared={directory:reply.directory,endpoint};const captured=await readPublicationDispatchCapture(p,prepared,input);assert.equal(captured.phase,'ended_possible');
 await writeFile(f.target,f.code('102.0.0'),{mode:0o700});const before=await readFile(f.trace);await readPublicationDispatchCapture(p,prepared,input);assert.deepEqual(await readFile(f.trace),before);
 let intent=false,pending='';await assert.rejects(f.http().request('POST',endpoint,payload,{intent(){intent=true;},started(){},dispatch(dir,effect){pending=dir;writeFileSync(f.target,f.code('103.0.0'));effect();}}),/changed_during_operation/);
 assert.equal(intent,false);assert.deepEqual(await readFile(f.trace),before);assert.ok(!(await readdir(pending)).includes('process.json'));
 await assert.rejects(f.http().request('POST','repos/fixture/upgrade/pulls/1/merge',payload,{intent(){},started(){}}),/endpoint_denied/);
});
test('a gh replacement during the last GET or POST keeps raw evidence and cannot verify or resend the result',async t=>{
 for(const method of ['GET','POST'] as const){
  const f=await fixture(t),code=f.code('99.0.0')+'\nfs.appendFileSync(process.argv[1],"\\n// changed during API call\\n");\n';await writeFile(f.target,code,{mode:0o700});
  const payload={body:'explicit uncertain fixture'},input=Buffer.from(JSON.stringify(payload));await assert.rejects(f.http().request(method,method==='GET'?readEndpoint:endpoint,method==='POST'?payload:undefined,method==='POST'?{intent(){},started(){}}:undefined),/changed_during_operation/);
  const directories=(await readdir(f.root)).filter(n=>n.startsWith('http-'));assert.equal(directories.length,1);const directory=join(f.root,directories[0]!);
  assert.equal(JSON.parse(await readFile(join(directory,'exit.json'),'utf8')).code,0);assert.equal(JSON.parse(await readFile(join(directory,'executable-changed.json'),'utf8')).remoteAcceptanceVerified,false);assert.ok((await readFile(join(directory,'stdout.http'))).length>0);
  const before=await readFile(f.trace);assert.equal(before.toString().trim().split('\n').length,1);
  if(method==='POST'){const captured=await readPublicationDispatchCapture({ghExecutable:f.executable,ghSha256:f.configured} as PublicationPlan,{directory,endpoint},input);assert.equal(captured.phase,'ended_possible');assert.ok(captured.originals.has('executable-changed.json'));}
  assert.deepEqual(await readFile(f.trace),before);
 }
 const f=await fixture(t);await writeFile(f.target,f.code('99.0.0')+`\nif(fs.readFileSync(${JSON.stringify(f.trace)},'utf8').trim().split('\\n').length===5)fs.appendFileSync(process.argv[1],'\\n// changed on last source read\\n');\n`,{mode:0o700});
 await assert.rejects(observeRemoteCandidate({ghExecutable:f.executable,ghSha256:f.configured,repositoryId:17} as ObservedCandidateRequest,{repository:'fixture/upgrade',pr:1,H:'a'.repeat(40),B:'b'.repeat(40),T:'c'.repeat(40),targetRef:'main'} as ObservedCandidateBinding,f.root),/changed_during_operation/);assert.equal((await readFile(f.trace,'utf8')).trim().split('\n').length,5);
});
