import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {candidateFixture} from './fixture.js';
import {integrationAuthority} from './authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {messageFixture} from '../w6/message-fixture.js';
import {readPacket} from '../../src/queue-evidence.js';
import {canonical} from '../../src/comparison.js';
import {hash,Snapshot} from '../../src/snapshot.js';
import {collect} from '../../src/collector.js';
import {readFixedObjects} from '../../src/git.js';
import {ConditionalDeliveryEntry} from '../../src/conditional-entry.js';
import type {ConditionalEntryPlan} from '../../src/conditional-entry-contract.js';
import type {ConditionalCollection} from '../../src/conditional-entry-source.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';

test('own candidate validation uses a fresh purpose-bound test action and the original ledger, recovers a lost claim and cannot reuse the permission in another consumer',async t=>{
 const f=await candidateFixture(t),roles=await messageFixture(t),ledger=await ledgerFixture(t,'lost-after-claim'),owner=await integrationAuthority(f);f.q.resources().configure(Buffer.from(canonical(ledger.profile)));
 const capacity=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));try{capacity.prepare('UPDATE capacity SET n=2').run();}finally{capacity.close();}
 const snapshot=await Snapshot.resume(f.candidateSnapshot),repository={id:1,full_name:'fixture/reception'},at=new Date().toISOString();
 try{assert.equal(await collect(snapshot,{get:async endpoint=>{
  let value:unknown;if(endpoint==='repos/fixture/reception/pulls/99')value={id:99,number:99,head:{sha:f.candidate.H,ref:'integration',repo:repository},base:{sha:f.B,ref:'fixture',repo:repository},body:'Explicit authority component source fixture',updated_at:at,comments:0,review_comments:0,commits:1,changed_files:2};
  else if(endpoint==='repos/fixture/reception/git/ref/heads/fixture')value={ref:'refs/heads/fixture',object:{type:'commit',sha:f.B}};
  else if(endpoint.includes('/commits?'))value=[{sha:f.candidate.H,commit:{message:'Explicit private integration'}}];else if(endpoint.includes('/files?'))value=[{filename:'consumer.json'},{filename:'scale.json'}];else value=[];
  return {status:200,body:canonical(value),headers:{},provenance:'explicit-fixture-no-http-process'};
 }},candidate=>readFixedObjects(candidate,join(f.produced.directory,'candidate.git'))),0);}finally{await snapshot.close();}
 const auth=await owner.adopt({kind:'delegate',adoption:owner.scope.sha,roles:['background'],targets:['fixture'],actions:['test'],paths:[],resourceRefs:[ledger.profile.resources[0]!.ref],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const receiverAuth=await owner.adopt({kind:'delegate',adoption:owner.scope.sha,roles:['receiver'],targets:['fixture'],actions:['receive'],paths:[],resourceRefs:[ledger.profile.resources[0]!.ref],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const members:string[]=[];
 for(const [pr,H] of [[10,f.A],[11,f.C]] as const){await f.addPacket({pr,H,B:f.B});let path:string|undefined;for(const name of await readdir(f.root))if(/^snapshot-\d+$/.test(name)){const m=JSON.parse(await readFile(join(f.root,name,'manifest.json'),'utf8'));if(m.candidate?.pr===pr)path=join(f.root,name);}assert.ok(path);const index=path.split('snapshot-').at(-1)!;members.push(f.q.import(await readPacket(path,join(f.root,'verification-'+index),join(f.root,'integration-context.json'))).item);}
 // This is the bounded authority/resource component: the existing private
 // producer and explicit published-identity fixture are prepared upstream.
 // The separate normal CLI journey tests collection, advice and real Git.
 const plan:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'own-candidate-test-authority',revision:'r1',previous:null,source:'Explicit fixed association fixture for authority/resource checks only',authorityIntent:null,mode:'parallel',actors:[{id:'A',tool:'codex'},{id:'B',tool:'codex'}],tasks:members.map((item,i)=>({id:i?'B':'A',item,actor:i?'B':'A',originActor:i?'B':'A',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:[],workspace:null,publishBranch:null,outputs:[]})),shared:[],dependencies:[]};
 const {item:_item,role:_role,parent:_parent,...profile}=roles.plan.participants[0]!,execution={schemaVersion:1,kind:'tongxu-coordination-readonly-execution',source:'Explicit unused role capabilities; no model dispatch in this component',executionKind:'fixture',actors:plan.actors.map(a=>({...profile,id:a.id})),taskBodies:{A:'No task model dispatch in this component',B:'No task model dispatch in this component'},authorityIntents:{A:null,B:null},billing:roles.plan.billing,timeoutMs:3000,refreshUnsent:false};
 const planPath=join(f.root,'authority-coordination.json'),executionPath=join(f.root,'authority-execution.json');await writeFile(planPath,canonical(plan));await writeFile(executionPath,canonical(execution));const ref=async(path:string)=>({path,sha256:hash(await readFile(path))});
 const sourceReader=join(f.root,'candidate-source-fixture.mjs'),sourceCode=`#!${process.execPath}
const a=process.argv.slice(2),p=a.at(-1),repo={id:1,full_name:'fixture/reception'};if(a[a.indexOf('--method')+1]!=='GET'||process.env.GH_TOKEN||process.env.GITHUB_TOKEN)process.exit(4);
const value=p==='repos/fixture/reception'?repo:p==='repos/fixture/reception/pulls/99'?{number:99,state:'open',merged:false,head:{sha:${JSON.stringify(f.candidate.H)},ref:'integration',repo},base:{sha:${JSON.stringify(f.B)},ref:'fixture',repo},html_url:'https://github.com/fixture/reception/pull/99'}:p==='repos/fixture/reception/git/ref/heads/fixture'?{ref:'refs/heads/fixture',object:{type:'commit',sha:${JSON.stringify(f.B)}}}:null;
if(!value)process.exit(5);process.stdout.write('HTTP/1.1 200 Fixture\\r\\n\\r\\n'+JSON.stringify(value));
`;await writeFile(sourceReader,sourceCode,{mode:0o700});const budget={ledgerId:ledger.profile.ledgerId,resourceRef:ledger.profile.resources[0]!.ref,unit:ledger.profile.resources[0]!.unit,quantity:1};
 const entry:ConditionalEntryPlan={schemaVersion:1,kind:'tongxu-conditional-delivery-entry',id:'candidate-validation-authority',title:'Explicit authority/resource component',store:f.store,repository:'fixture/reception',target:'fixture',coordination:{plan:await ref(planPath),execution:await ref(executionPath)},integration:{item:f.imported.item,members:['A','B'],gateStage:'implement',objects:f.objects,selectionReason:'Exact original pair; upstream producer is actual Git, source identity is an explicit fixture',authorization:null,testPlan:await ref(join(f.root,'units-test.json')),receiverTemplate:await ref(f.receiverPath),receiverAuthorization:{adoption:owner.scope.sha,authorization:receiverAuth.sha,budgets:[budget]},validationAuthorization:{adoption:owner.scope.sha,authorization:auth.sha,budgets:[budget]},sourceReader:{repositoryId:1,ghExecutable:sourceReader,ghSha256:hash(sourceCode),issues:[],executionKind:'fixture'}}};
 const path=join(f.root,'authority-entry.json');await writeFile(path,canonical(entry));const prepared=await (await ConditionalDeliveryEntry.load(path)).prepare(),id=prepared.preparedCoordination,c=f.candidate,original=f.q.integrations().sourceMaterial(f.request.id);
 f.q.coordination().normalEntryStep(id,entry.id,'integration',Buffer.from(canonical(original.request)),{kind:'integration',id:f.request.id,operation:f.operation});
 const collection:ConditionalCollection={schemaVersion:1,kind:'tongxu-conditional-candidate-collection',integration:f.request.id,integrationRequestSha256:original.requestSha256,snapshot:f.candidateSnapshot,objects:join(f.produced.directory,'candidate.git'),candidate:{repository:c.repository,pr:99,H:c.H,B:c.B,T:c.T,targetRef:c.target},context:f.candidatePacket.context};
 f.q.coordination().normalEntryStep(id,entry.id,'collection-'+hash(f.request.id).slice(0,48),Buffer.from(canonical(collection)),{kind:'snapshot',id:f.request.id,directory:f.candidateSnapshot,pr:99});
 const execute=promisify(execFile),cli=fileURLToPath(new URL('../../src/conditional-entry-cli.js',import.meta.url)),run=async(action='validate')=>{const r=await execute(process.execPath,[cli,action,'--entry',path],{cwd:f.root,timeout:60000,maxBuffer:16*1024*1024});return JSON.parse(r.stdout);};
 f.q.control(f.context.scope.id,'investment','stopped','Explicit authority test stop');await assert.rejects(()=>run(),/owner_action_stopped|new_investment_stopped/);assert.equal(ledger.state().claims.length,0);f.q.control(f.context.scope.id,'investment','open','Explicit authority test resume');
 await assert.rejects(()=>run(),/ledger_|resource_|provider_/);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,0);
 const result=await run();assert.equal(result.newVerificationRuns,1,JSON.stringify(result));assert.equal(result.state.phase,'recorded');assert.equal(result.state.result.evidenceComplete,true);assert.equal(result.resources.settled,true,JSON.stringify(result.resources));assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);assert.equal(await f.count(),0);
 const step=f.q.coordination().normalEntry(id,entry.id).steps.find((s:any)=>s.reference.kind==='validation'),request=JSON.parse(step.request.toString()),intent=request.governance.authorityIntent;assert.notEqual(intent,owner.intent);assert.notEqual(owner.a.reservedAction(intent).request.payloadSha256,undefined);
 const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{
  assert.throws(()=>db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('candidate_validation_result','candidate-validation:'+result.state.id,canonical({sha256:'a'.repeat(64),value:{reportSha256:'b'.repeat(64),executionRegistrySha256:'c'.repeat(64)}}),new Date().toISOString()),/candidate_validation_actual_capture_required/);
  assert.throws(()=>db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('integration_authority_bound','integration:wrong-consumer',canonical({sha256:'d'.repeat(64),value:{authorityIntent:intent}}),new Date().toISOString()),/test_authority_purpose_mismatch|UNIQUE/);
 }finally{db.close();}
 const reportPath=join(result.state.directory,'verification','verification.json'),bytes=await readFile(reportPath);await owner.adopt({kind:'revoke',decision:auth.sha});const repeated=await run();assert.equal(repeated.newVerificationRuns,0);assert.equal(repeated.state.binding.run,result.state.binding.run);assert.deepEqual(await readFile(reportPath),bytes);assert.equal(ledger.state().claims.length,1);assert.equal(ledger.state().settlements.length,1);
 const intents=owner.a.status().intents.length,unchanged=await run('refresh');assert.equal(unchanged.coordination,id);assert.equal(unchanged.newModelInputs,0);assert.equal(owner.a.status().intents.length,intents);
 const association=await run('attach');assert.equal(association.remoteWritePerformed,false);assert.equal(association.independentReceptionGranted,false);assert.equal(await f.count(),0);
 await assert.rejects(()=>run('receive'),/ledger_|resource_|provider_/);assert.equal(ledger.state().claims.length,2);assert.equal(await f.count(),0);
 const received=await run('receive');assert.equal(received.receiver.phase,'returned',JSON.stringify(received));assert.equal(received.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(await f.count(),1);assert.equal(ledger.state().claims.length,2);assert.equal(ledger.state().settlements.length,2);await run('receive');assert.equal(await f.count(),1);assert.equal(ledger.state().claims.length,2);assert.equal(ledger.state().settlements.length,2);
});
