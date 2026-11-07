import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {memberInputFixture} from '../integration-member/repair-fixture.js';
import {messageFixture} from '../w6/message-fixture.js';
import {readPacket} from '../../src/queue-evidence.js';
import {canonical} from '../../src/comparison.js';
import {hash,Snapshot} from '../../src/snapshot.js';
import {collectConditionalCandidate,type ConditionalCollection} from '../../src/conditional-entry-source.js';
import {verify} from '../../src/verification.js';
import {runObservedCandidate} from '../../src/observed-candidate.js';
import {runReception} from '../../src/receiver.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';
import type {ConditionalEntryPlan} from '../../src/conditional-entry-contract.js';
import {parseConditionalRepairProfile} from '../../src/conditional-entry-repair.js';
import {memberSourceFixture} from './conditional-member-source-fixture.js';
import {memberAuthorityFixture} from './conditional-member-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {DatabaseSync} from 'node:sqlite';
import {readOwnerSource} from '../../src/authority-source.js';
import {parseActionRequest} from '../../src/authority-contract.js';
import {randomUUID} from 'node:crypto';
import {setup as receiverFixture} from '../w3/receiver-fixture.js';
import {git} from '../../src/repair-workspace.js';

const noInput=(r:any)=>r.messages.every((m:any)=>!m.sent&&!m.delivery&&!m.reply)&&r.runtimes.every((r:any)=>!r.started||r.ended?.proof.knownUnstarted===true&&r.captureVerification?.proof.knownUnstarted===true);

for(const mode of ['local','owner-missing','governed','monitored','governed-monitored','second-round','current-parent'])test('normal entry derives a real member RETURN through original gates: '+mode,async t=>{
 const ownerMissing=mode==='owner-missing';
 const f=await memberInputFixture(t,mode==='second-round'?'project-rounds':'project',true,mode.includes('monitored')),roles=await messageFixture(t),memberB=f.q.import(await readPacket(f.snapshots[1]!,join(f.root,'member-b-verification'),join(f.root,'integration-context.json')));
 const authorBefore=await f.authorState(),remote=f.originalSource??await memberSourceFixture(f.root,f.A,f.B,f.objects);
 const plan:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'normal-member-repair',revision:'r1',previous:null,source:'Actual Git/Docker, scripted native CLI roles and source; not a production model or remote acceptance',authorityIntent:null,mode:'parallel',actors:[{id:'a',tool:'codex'},{id:'b',tool:'codex'}],tasks:[{id:'A',item:f.member.item,actor:'a',originActor:'a',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:['src/normalize.mjs'],workspace:join(f.request.executionRoot,'workspace'),publishBranch:'repair-member-a',outputs:[{id:'fixed-member',stage:'implement',kind:'repair_candidate'}]},{id:'B',item:memberB.item,actor:'b',originActor:'b',dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:[],workspace:null,publishBranch:null,outputs:[]}],shared:[],dependencies:[]};
 let script=await readFile(roles.codex,'utf8');const marker="report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId";assert.ok(script.includes(marker));script=script.replace(marker,"report:JSON.stringify((()=>{const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),task=x.body.split('\\n')[0].slice(18);return {kind:'tongxu-coordination-feedback',task,revision:c.revision,parts:[],report:'Explicit readonly task fixture. A controlled new managed writer still requires an actual RETURN and original gates.'};})())");await writeFile(roles.codex,script);
 const {item:_item,role:_role,parent:_parent,...actor}=roles.plan.participants[0]!,execution={schemaVersion:1,kind:'tongxu-coordination-readonly-execution',source:'Explicit original responsibility fixture',executionKind:'fixture',actors:plan.actors.map(a=>({...actor,id:a.id,executableSha256:hash(script)})),taskBodies:{A:'Investigate original member label defect',B:'Investigate separate member units'},authorityIntents:{A:null,B:null},billing:roles.plan.billing,timeoutMs:3000,refreshUnsent:false};
 let governed:Awaited<ReturnType<typeof memberAuthorityFixture>>|undefined,ledger:Awaited<ReturnType<typeof ledgerFixture>>|undefined,implementAuthorization:any=null,validationAuthorization:any=null,integrationAuthorization:any=null,candidateAuthorization:any=null,receiverAuthorization:any=null;
 if(mode.startsWith('governed')){
  ledger=await ledgerFixture(t);const db=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));db.prepare('UPDATE capacity SET n=8').run();db.close();governed=await memberAuthorityFixture(f,ledger.profile);
  const base={kind:'delegate',adoption:governed.scope.sha,targets:['fixture'],expiresAt:new Date(Date.now()+3600000).toISOString()},budget={ledgerId:ledger.profile.ledgerId,resourceRef:ledger.profile.resources[0]!.ref,unit:ledger.profile.resources[0]!.unit,quantity:1};
  const grant=async(roles:string[],actions:string[],paths:string[],resourceRefs:string[])=>{const d=await governed!.adopt({...base,roles,actions,paths,resourceRefs});return {adoption:governed!.scope.sha,authorization:d.sha,budgets:resourceRefs.length?[budget]:[]};};
  implementAuthorization=await grant(['implementer'],['implement'],f.request.allowedPaths,[budget.resourceRef]);validationAuthorization=await grant(['background'],['test'],[],[budget.resourceRef]);integrationAuthorization=await grant(['background'],['test'],[],[]);candidateAuthorization=await grant(['background'],['test'],[],[budget.resourceRef]);receiverAuthorization=await grant(['receiver'],['receive'],[],[budget.resourceRef]);const coordinate=await grant(['coordinator'],['coordinate'],[],[budget.resourceRef]);Object.assign(execution,{delegatedCoordination:{adoption:coordinate.adoption,authorization:coordinate.authorization,resources:[budget]}});
 }
 const planPath=join(f.root,'normal-repair-coordination.json'),executionPath=join(f.root,'normal-repair-execution.json');await writeFile(planPath,canonical(plan));await writeFile(executionPath,canonical(execution));const ref=async(path:string)=>({path,sha256:hash(await readFile(path))});
 const p=f.request,profile={schemaVersion:1,kind:'tongxu-conditional-repair-capability',objects:p.objects,allowedPaths:p.allowedPaths,materialPaths:p.materialPaths,protectedPaths:p.protectedPaths,contract:p.contract,testPlan:{path:p.testPlan,sha256:p.testPlanSha256},config:await ref(f.model.configPath),authorization:p.authorization,demonstrationFixture:true,generatedDirectories:p.generatedDirectories},profilePath=join(f.root,'installed-member-repair-capability.json');await writeFile(profilePath,canonical(profile));
 assert.throws(()=>parseConditionalRepairProfile(Buffer.from(canonical({...profile,candidate:{H:f.A}}))),/profile_invalid/);assert.throws(()=>parseConditionalRepairProfile(Buffer.from(canonical({...profile,allowedPaths:['test/normalize.test.mjs']}))),/profile_invalid/);
 const entry:ConditionalEntryPlan={schemaVersion:1,kind:'tongxu-conditional-delivery-entry',id:'normal-repair-entry',title:'Original member repair through the fixed entry',store:f.store,repository:'fixture/reception',target:'fixture',coordination:{plan:await ref(planPath),execution:await ref(executionPath)},repairs:[{task:'A',profile:await ref(profilePath),authorization:implementAuthorization,postRepair:{testPlan:await ref(mode==='second-round'?join(f.root,'units-test.json'):p.testPlan),validationAuthorization,recompositionAuthorization:validationAuthorization}}],integration:{item:f.imported.item,members:['A','B'],gateStage:'implement',objects:f.objects,selectionReason:'Only the selected member can be repaired; combination must be independently revalidated',authorization:integrationAuthorization?{adoption:integrationAuthorization.adoption,authorization:integrationAuthorization.authorization}:null,testPlan:await ref(join(f.root,'units-test.json')),receiverTemplate:await ref(f.receiverPath),validationAuthorization:candidateAuthorization,receiverAuthorization,sourceReader:{repositoryId:1,ghExecutable:remote.executable,ghSha256:remote.sha256,issues:[],executionKind:'fixture'}}};
 const path=join(f.root,'normal-member-entry.json');await writeFile(path,canonical(entry));const execute=promisify(execFile),cli=fileURLToPath(new URL('../../src/conditional-entry-cli.js',import.meta.url)),run=async(action:string,...args:string[])=>JSON.parse((await execute(process.execPath,[cli,action,'--entry',path,...args],{cwd:f.root,timeout:60000,maxBuffer:16*1024*1024})).stdout);
 await run('prepare');await assert.rejects(()=>run('repair-member','--task','A','--finding','0'),/coordination_repair_original_task_reply_required/);let investigated=await run('investigate');if(!investigated.readonlyTasksCompleted){const pending=Object.values(investigated.results).filter((r:any)=>!r.completed) as any[];const errors=Object.entries(investigated.errors);assert.ok(pending.length||errors.length,JSON.stringify(investigated));assert.ok(pending.every(r=>r.messages.every((m:any)=>m.state==='Held')&&noInput(r)&&r.problems.some((p:any)=>p.reason==='owner_source_order_conflict')),JSON.stringify(investigated));for(const [key,reason] of errors){assert.equal(reason,'owner_source_order_conflict');const task=key.split(':')[0]!,selected=f.q.coordination().dispatchSelection(investigated.coordination,task,'investigate');if(selected){try{const original=f.q.messages().status(selected.run);assert.ok(noInput(original));}catch(e){if(!(e instanceof Error)||e.message!=='original_message_run_required')throw e;}}}const original=Object.fromEntries(Object.entries(investigated.prepared).map(([k,p]:[string,any])=>[k,p.run]));investigated=await run('investigate');for(const [key,run] of Object.entries(original))assert.equal(investigated.prepared[key].run,run);}assert.equal(investigated.readonlyTasksCompleted,true,JSON.stringify(investigated));
 await assert.rejects(()=>run('repair-member','--task','B','--finding','0'),/repair_not_configured/);await assert.rejects(()=>run('repair','--task','A'),/conditional_entry_real_return_required/);await assert.rejects(()=>run('repair-member','--task','A','--finding','1'),/integration_member_finding_not_in_original/);
 if(ownerMissing){
  f.q.enableReceiverCorrections();f.q.authority().configure(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:8,ownerId:101,executorId:202,ghExecutable:f.plan.claudeExecutable,ghSha256:hash(await readFile(f.plan.claudeExecutable)),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000})));
  const before=await readFile(f.model.trace).catch(()=>Buffer.alloc(0));await assert.rejects(()=>run('repair-member','--task','A','--finding','0'),/conditional_entry_repair_authority_required/);await assert.rejects(()=>run('repair-member','--task','A','--finding','0'),/conditional_entry_repair_authority_required/);assert.deepEqual(await readFile(f.model.trace).catch(()=>Buffer.alloc(0)),before);assert.deepEqual(await f.authorState(),authorBefore);assert.ok(!f.q.status().events.some((e:any)=>e.kind==='coordination_normal_entry_step'&&JSON.parse(e.data).value.reference.kind==='repair'));return;
 }
 let selectedParent=f.parent;
 let historicalParentOriginal:string|undefined;
 if(mode==='current-parent'){
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));
  historicalParentOriginal=(db.prepare('SELECT result FROM operations WHERE id=?').get(f.parent.operation) as any).result;
  const traceBefore=await readFile(f.model.trace).catch(()=>Buffer.alloc(0));
  const resourcesBefore=f.q.status().events.filter((e:any)=>e.kind.startsWith('resource_'));
  await remote.publishIntegration(f.candidate.H,join(f.produced.directory,'candidate.git'));
  const remoteState=JSON.parse(await readFile(remote.state,'utf8'));
  remoteState.integration.body='Updated parent explanation, with the same member H and manifest.';
  await writeFile(remote.state,canonical(remoteState));
  const collection:ConditionalCollection={schemaVersion:1,kind:'tongxu-conditional-candidate-collection',integration:f.association.integration,integrationRequestSha256:f.produced.requestSha256,snapshot:join(f.root,'current-parent-w1'),objects:join(f.produced.directory,'candidate.git'),candidate:{repository:'fixture/reception',pr:99,H:f.candidate.H,B:f.B,T:f.candidate.T,targetRef:'fixture'},context:f.context as ConditionalCollection['context']};
  assert.equal((await collectConditionalCandidate(entry,collection,f.root,async()=>{},async()=>{})).collectionComplete,true);
  const verification=join(f.root,'current-parent-w2');
  await verify({snapshots:[collection.snapshot],objects:collection.objects,plan:join(f.root,'units-test.json'),output:verification});
  assert.equal(f.q.import(await readPacket(collection.snapshot,verification,join(f.root,'integration-context.json'))).item,f.candidateItem);
  const currentPacket=db.prepare('SELECT packets.* FROM items JOIN packets ON packets.id=items.current_packet WHERE items.id=?').get(f.candidateItem) as any;
  const observation=join(f.root,'current-parent-observation.json');
  await writeFile(observation,canonical({schemaVersion:1,kind:'tongxu-observed-integration-candidate',integration:f.association.integration,item:f.candidateItem,packet:currentPacket.id,fingerprint:currentPacket.fingerprint,source:'Actual new parent collection and own Docker W2 on unchanged integration code',repositoryId:1,ghExecutable:remote.executable,ghSha256:remote.sha256,executionKind:'fixture'}));
  await runObservedCandidate(f.store,observation);
  assert.equal(f.q.receiverState(f.parent.operation).result.receiver.currentMaterialMatches,false);
  // A complete historical parent alone cannot authorize a current repair.
  await assert.rejects(()=>run('repair-member','--task','A','--finding','0'),/conditional_entry_real_return_required/);
  selectedParent=await runReception(f.receiverPath);
  assert.notEqual(selectedParent.operation,f.parent.operation);
  assert.equal(selectedParent.receiver.judgment.verdict,'RETURN_FOR_WORK');
  assert.equal(f.q.receiverState(selectedParent.operation).result.receiver.currentMaterialMatches,true);

  // Controlled corruption of this private fixture checks refusal boundaries.
  // Every changed row/blob is restored before the actual normal repair.
  const rejectOperation=async(operation:string,status:string,change:(result:any)=>void,reason:RegExp)=>{
   const row=db.prepare('SELECT status,result FROM operations WHERE id=?').get(operation) as any;
   const altered=JSON.parse(row.result);change(altered);
   db.prepare('UPDATE operations SET status=?,result=? WHERE id=?').run(status,canonical(altered),operation);
   try{await assert.rejects(()=>run('repair-member','--task','A','--finding','0'),reason);}
   finally{db.prepare('UPDATE operations SET status=?,result=? WHERE id=?').run(row.status,row.result,operation);}
  };
  assert.throws(()=>db.prepare("UPDATE operations SET status='repairing' WHERE id=?").run(f.parent.operation),/integration_requires_member_scoped_repair/);
  await rejectOperation(f.parent.operation,'complete',r=>{r.receiver.controllerReturned=false;},/conditional_entry_complete_return_required/);
  await rejectOperation(selectedParent.operation,'complete',r=>{r.receiver.controllerReturned=false;},/conditional_entry_complete_return_required/);
  await rejectOperation(selectedParent.operation,'complete',r=>{r.receiver.phase='unknown';},/original_receiver_judgment_unavailable/);
  for(const operation of [f.parent.operation,selectedParent.operation]){
   const receiver=JSON.parse((db.prepare('SELECT result FROM operations WHERE id=?').get(operation) as any).result).receiver;
   const sha=receiver.blobs['completed.json'].sha256;
   const original=(db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as any).bytes;
   db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('damaged private fixture capture'),sha);
   try{await assert.rejects(()=>run('repair-member','--task','A','--finding','0'),/stored_evidence_hash_mismatch/);}
   finally{db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(original,sha);}
  }

  // A different PR identity for the same private integration has its own real
  // W2 and complete reception. Both parent RETURNs are current and ambiguous.
  const snapshot=join(f.root,'other-current-parent-w1'),other=await Snapshot.create(snapshot,'fixture/reception',100,[],[]),at=new Date().toISOString();
  other.manifest.candidate={repository:'fixture/reception',pr:100,H:f.candidate.H,B:f.B,mergeBase:f.B,targetRef:'fixture',observedAt:at};
  await other.artifact(canonical({explicitFixture:true,H:f.candidate.H,pr:100}),{kind:'pr',round:1,retrievedAt:at,provenance:'explicit-local-fixture',status:200});
  other.manifest.rounds.push({number:1,startedAt:at,finishedAt:at,coverage:{},sources:[],notes:[],gaps:[],limitations:['explicit_PR_identity_fixture'],current:true});await other.save();await other.close();
  const otherVerification=join(f.root,'other-current-parent-w2');
  await verify({snapshots:[snapshot],objects:collection.objects,plan:join(f.root,'units-test.json'),output:otherVerification});
  const otherPacket=await readPacket(snapshot,otherVerification,join(f.root,'integration-context.json')),otherItem=f.q.import(otherPacket);
  f.q.attachIntegrationCandidate(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-integration-candidate',integration:f.association.integration,item:otherItem.item,packet:otherItem.packet,fingerprint:otherPacket.fingerprint,source:'Explicit alternate PR identity with its own real W2'})));
  const otherReceiverPath=join(f.root,'other-current-parent-receiver.json');
  await writeFile(otherReceiverPath,canonical({...f.receiverPlan,item:otherItem.item}));
  const otherReturn=await runReception(otherReceiverPath);
  assert.equal(f.q.receiverState(otherReturn.operation).result.receiver.currentMaterialMatches,true);
  assert.equal(f.q.receiverState(selectedParent.operation).result.receiver.currentMaterialMatches,true);
  await assert.rejects(()=>run('repair-member','--task','A','--finding','0'),/conditional_entry_return_ambiguous/);
  // Supersede only the alternate parent's materials without a new RETURN.
  const laterSnapshot=join(f.root,'other-parent-later-w1');
  const later=await Snapshot.create(laterSnapshot,'fixture/reception',100,[],[]),laterAt=new Date().toISOString();
  later.manifest.candidate={...other.manifest.candidate,observedAt:laterAt};
  await later.artifact(canonical({explicitFixture:true,H:f.candidate.H,pr:100,body:'New alternate parent material, no current RETURN'}),{kind:'pr',round:1,retrievedAt:laterAt,provenance:'explicit-local-fixture',status:200});
  later.manifest.rounds.push({number:1,startedAt:laterAt,finishedAt:laterAt,coverage:{},sources:[],notes:[],gaps:[],limitations:['explicit_PR_identity_fixture'],current:true});await later.save();await later.close();
  const laterVerification=join(f.root,'other-parent-later-w2');
  await verify({snapshots:[laterSnapshot],objects:collection.objects,plan:join(f.root,'units-test.json'),output:laterVerification});
  const laterPacket=await readPacket(laterSnapshot,laterVerification,join(f.root,'integration-context.json'));
  assert.equal(f.q.import(laterPacket).item,otherItem.item);
  assert.equal(f.q.receiverState(otherReturn.operation).result.receiver.currentMaterialMatches,false);
  assert.equal(f.q.conditionalRepairSource(f.member.item,0).operation,selectedParent.operation);
  assert.deepEqual(await readFile(f.model.trace).catch(()=>Buffer.alloc(0)),traceBefore);
  assert.deepEqual(f.q.status().events.filter((e:any)=>e.kind.startsWith('resource_')),resourcesBefore);
  assert.equal((db.prepare('SELECT result FROM operations WHERE id=?').get(f.parent.operation) as any).result,historicalParentOriginal);
  db.close();
 }
 const result=await run('repair-member','--task','A','--finding','0');assert.equal(result.result.repairStatus,'completed');assert.notEqual(result.result.after.H,f.A);assert.equal(result.result.counters.actualFileWrites,1);assert.equal(result.manualReportCopyRequired,false);
 const state=f.q.reviewRecords().state(result.operation).repair;assert.equal(state.result.actualRepairPerformed,true);assert.ok(state.memberReturn);const source=f.q.integrationMemberReturns().material(state.memberReturn.id);assert.equal(source.request.reception.operation,selectedParent.operation);assert.deepEqual(source.request.findingIndexes,[0]);assert.equal(source.proof.parent.judgment.verdict,'RETURN_FOR_WORK');assert.equal(source.proof.individualReceptionInferred,false);assert.equal(f.q.receiverState(f.parent.operation).receiver.judgment.verdict,'RETURN_FOR_WORK');assert.equal(f.q.status().operations.find((o:any)=>o.id===result.operation).result.receiver,undefined);
 if(mode==='current-parent'){
  const parent=f.q.receiverState(selectedParent.operation).receiver;
  const receipt=JSON.parse(await readFile(join(parent.directory,'claude/completed.json'),'utf8'));
  assert.equal(source.request.reception.judgmentId,parent.judgmentId);
  assert.equal(source.request.reception.bindingHash,parent.bindingHash);
  assert.equal(source.request.reception.inputSha256,parent.inputSha256);
  assert.equal(source.request.reception.finalSha256,hash(receipt.finalText));
  assert.equal(source.request.member.H,f.association.member.H);
  assert.equal(source.request.member.manifestSha256,f.association.member.manifestSha256);
  const request=JSON.parse(await readFile(join(f.request.executionRoot,'request.json'),'utf8'));
  const original=f.q.reviewRecords().state(result.operation).repair;
  assert.equal(original.phase,'returned');assert.equal(original.controllerReturned,true);
  assert.equal(original.result.data.tests.passed,true);
  assert.equal(request.priorReview.operation,selectedParent.operation);
  assert.equal(request.priorReview.integrationMember.parentFinal,receipt.finalText);
  const stableTrace=await readFile(f.model.trace),stableResources=f.q.status().events.filter((e:any)=>e.kind.startsWith('resource_')),stableAuthor=await f.authorState();
  const duplicate=await run('repair-member','--task','A','--finding','0');
  assert.equal(duplicate.operation,result.operation);assert.equal(duplicate.result.duplicate,true);
  assert.deepEqual(duplicate.result.counters,result.result.counters);
  assert.deepEqual(await readFile(f.model.trace),stableTrace);
  assert.deepEqual(f.q.status().events.filter((e:any)=>e.kind.startsWith('resource_')),stableResources);
  assert.deepEqual(await f.authorState(),stableAuthor);
 }

 await assert.rejects(()=>run('collect-member','--task','A'),/conditional_entry_published_candidate_mismatch/);assert.ok(!f.q.status().events.some((e:any)=>e.kind==='coordination_normal_entry_step'&&JSON.parse(e.data).value.reference.kind==='member-snapshot'));
 await remote.publish(result.result.after.H,join(f.request.executionRoot,'workspace'));if(f.observeOriginalSource)await f.observeOriginalSource();const observed=await run('collect-member','--task','A');assert.equal(observed.collectionComplete,true);assert.equal(observed.candidate.H,result.result.after.H);assert.equal(observed.remoteWritePerformed,false);const firstGets=(await remote.reads()).length,frozenMember=await readFile(join(observed.snapshot,'manifest.json'));assert.equal((await run('collect-member','--task','A')).collectionComplete,true);assert.ok((await remote.reads()).length>firstGets);assert.deepEqual(await readFile(join(observed.snapshot,'manifest.json')),frozenMember);const gets=(await remote.reads()).length;
 const own=await run('validate-member','--task','A');assert.equal(own.state.phase,'recorded');assert.equal(own.newVerificationRuns,1);assert.equal(own.state.source.kind,'member-repair');assert.equal(own.state.integration,undefined);assert.equal((await run('validate-member','--task','A')).newVerificationRuns,0);
 if(governed&&ledger){const input=f.q.candidateValidations().originals(own.state.id).plan;assert.equal(input.kind,'tongxu-member-candidate-validation');const action=f.q.authority().reservedAction(input.governance!.authorityIntent).request;assert.equal(action.candidate.H,result.result.after.H);assert.equal(action.candidateSource.kind,'controlled-member-observation');assert.notEqual(action.item,f.member.item);assert.equal(f.q.memberCandidateSource(action.candidateSource).packet,null);assert.equal(f.q.memberCandidateSource(action.candidateSource).evidenceComplete,false);const wrongAction={...action,action:'receive'};delete wrongAction.payloadSha256;assert.throws(()=>parseActionRequest(wrongAction),/authority_candidate_source_invalid/);const fresh:Awaited<ReturnType<typeof readOwnerSource>>[]=[];for(const r of f.q.authority().sourceRequests(validationAuthorization.authorization))fresh.push(await readOwnerSource(governed.profile,r.proposalSha256,r.commentId,join(f.root,'negative-source-'+randomUUID())));const before=ledger.state(),originalRequest=f.q.resources().status(input.governance!.resourceRequests[0]!).request;assert.throws(()=>f.q.resources().prepare({...originalRequest,operation:f.parent.operation},fresh,'background'),/resource_original_action_or_operation_mismatch/);assert.throws(()=>f.q.authority().checkAction({...action,candidate:{...action.candidate,H:f.A}},'background',validationAuthorization.authorization,fresh),/authority_current_candidate_or_scope_mismatch/);const wrong=action.candidateSource.sha256.slice(0,-1)+(action.candidateSource.sha256.endsWith('0')?'1':'0');assert.throws(()=>f.q.authority().checkAction({...action,item:wrong,candidateSource:{...action.candidateSource,sha256:wrong}},'background',validationAuthorization.authorization,fresh),/member_source_not_recorded/);assert.deepEqual(ledger.state(),before);}
 const rebuilt=await run('recompose-member','--task','A');assert.equal(rebuilt.phase,'new_integration_candidate_requires_own_reception');assert.equal(rebuilt.memberHead,result.result.after.H);assert.equal(rebuilt.priorAcceptanceTransferred,false);assert.equal(rebuilt.memberImport.individualReceptionInferred,false);assert.equal(rebuilt.composition?true:false,true);assert.equal(rebuilt.remotePublicationInferred,false);assert.notEqual(rebuilt.candidate.H,result.result.after.H);const again=await run('recompose-member','--task','A');assert.equal(again.duplicate,true);assert.equal(again.memberImport.duplicate,true);assert.equal(again.newGitProcesses,0);assert.equal((await remote.reads()).length,gets);

 if(mode==='second-round'){
  const firstPlan=await readFile(result.repairPlan),firstMember=await readFile(join(observed.snapshot,'manifest.json')),firstValidation=own.state.id,firstRecomposition=rebuilt.integration.id;
  await run('refresh');const initialCombination=await run('integrate');assert.equal(initialCombination.result.candidate.H,rebuilt.candidate.H);await run('investigate');
  await remote.publishIntegration(rebuilt.candidate.H,join(initialCombination.directory,'candidate.git'));
  await run('collect','--pr','99');await run('validate');await run('attach');const secondReturn=await run('receive');assert.equal(secondReturn.receiver.judgment.verdict,'RETURN_FOR_WORK');assert.notEqual(secondReturn.operation,f.parent.operation);
  // Until the current member RETURN is repaired, old H1/W2/recomposition
  // cannot stand in as the current pipeline's result.
  await assert.rejects(()=>run('validate-member','--task','A'),/conditional_entry_current_member_repair_required/);
  const second=await run('repair-member','--task','A','--finding','0');assert.equal(second.result.repairStatus,'completed');assert.notEqual(second.operation,result.operation);assert.notEqual(second.result.after.H,result.result.after.H);
  const secondPlan=JSON.parse(await readFile(second.repairPlan,'utf8')),secondRequest=JSON.parse(await readFile(secondPlan.request,'utf8'));assert.equal(secondPlan.continuation.operation,result.operation);assert.equal(secondRequest.candidate.H,result.result.after.H);assert.equal(f.q.integrationMemberReturns().material(secondPlan.memberReturn.id).request.reception.operation,secondReturn.operation);
  await remote.publish(second.result.after.H,join(secondRequest.executionRoot,'workspace'));const collected2=await run('collect-member','--task','A');assert.equal(collected2.candidate.H,second.result.after.H);assert.notEqual(collected2.snapshot,observed.snapshot);
  const verified2=await run('validate-member','--task','A');assert.equal(verified2.newVerificationRuns,1);assert.notEqual(verified2.state.id,firstValidation);const validationPlan=f.q.candidateValidations().originals(verified2.state.id).plan;assert.equal(validationPlan.kind,'tongxu-member-candidate-validation');if(validationPlan.kind!=='tongxu-member-candidate-validation')throw new Error('member_validation_expected');assert.equal(validationPlan.collection.repair.operation,second.operation);assert.equal(validationPlan.collection.candidate.H,second.result.after.H);
  const recomposed2=await run('recompose-member','--task','A');assert.equal(recomposed2.phase,'new_integration_candidate_requires_own_reception');assert.equal(recomposed2.memberHead,second.result.after.H);assert.notEqual(recomposed2.integration.id,firstRecomposition);assert.notEqual(recomposed2.memberImport.item,rebuilt.memberImport.item);
  const stableTrace=await readFile(f.model.trace);assert.equal((await run('repair-member','--task','A','--finding','0')).result.duplicate,true);assert.equal((await run('validate-member','--task','A')).newVerificationRuns,0);const again2=await run('recompose-member','--task','A');assert.equal(again2.newGitProcesses,0);assert.equal(again2.memberImport.duplicate,true);assert.deepEqual(await readFile(f.model.trace),stableTrace);
  await run('refresh');const finalCombination=await run('integrate');assert.equal(finalCombination.result.candidate.H,recomposed2.candidate.H);assert.equal(finalCombination.newGitProcesses,0);await remote.publishIntegration(recomposed2.candidate.H,join(finalCombination.directory,'candidate.git'));
  await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="complete"'));await run('collect','--pr','99');const own2=await run('validate');assert.equal(own2.newVerificationRuns,1);await run('attach');const accepted=await run('receive');assert.equal(accepted.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.notEqual(accepted.operation,secondReturn.operation);
  const all=(await run('report')).reports;assert.ok(all.some((r:any)=>r.kind==='repair'&&r.complete&&r.result.operation===result.operation));assert.ok(all.some((r:any)=>r.kind==='repair'&&r.complete&&r.result.operation===second.operation));assert.deepEqual(await readFile(result.repairPlan),firstPlan);assert.deepEqual(await readFile(join(observed.snapshot,'manifest.json')),firstMember);
  if(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE)await cp(f.root,join(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE,'member-second-round'),{recursive:true});return;
 }
 if(governed&&ledger){assert.equal(ledger.state().claims.length,5);assert.equal(ledger.state().settlements.length,5);await governed.adopt({kind:'revoke',decision:implementAuthorization.authorization});await governed.adopt({kind:'revoke',decision:validationAuthorization.authorization});const old=ledger.state();assert.equal((await run('recompose-member','--task','A')).duplicate,true);assert.deepEqual(ledger.state(),old);}
 const original=await readFile(result.repairPlan),trace=await readFile(f.model.trace),readonlyTrace=await readFile(roles.trace);await rm(profilePath);await rm(f.model.configPath);
 const duplicate=await run('repair-member','--task','A','--finding','0');assert.equal(duplicate.operation,result.operation);assert.equal(duplicate.result.duplicate,true);assert.deepEqual(await readFile(result.repairPlan),original);assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(await readFile(roles.trace),readonlyTrace);await assert.rejects(()=>run('repair-member','--task','A','--finding','1'),/original_repair_selection_required/);
 const report=await run('report'),repair=report.reports.find((r:any)=>r.kind==='repair');assert.equal(repair.available,true);assert.equal(repair.complete,true);assert.ok(report.reports.some((r:any)=>r.kind==='member-recomposition'&&r.complete&&r.result.link.repair.resultSha256===state.resultSha256&&r.result.originals.length>0));assert.equal(repair.result.originalVerdict,'RETURN_FOR_WORK');assert.equal(repair.result.originalResult.after.H,result.result.after.H);assert.deepEqual(await readFile(f.model.trace),trace);assert.deepEqual(await f.authorState(),authorBefore);
 await run('refresh');const rejoined=await run('integrate');assert.equal(rejoined.phase,'produced');assert.equal(rejoined.result.candidate.H,rebuilt.candidate.H);assert.equal(rejoined.newGitProcesses,0);await assert.rejects(()=>run('collect','--pr','99'),/conditional_entry_published_candidate_unavailable/);assert.equal((await remote.reads()).some((r:any)=>r.method!=='GET'),false);assert.deepEqual(await f.authorState(),authorBefore);
 const pSource=f.q.candidateValidations().originals(own.state.id).plan;assert.equal(pSource.kind,'tongxu-member-candidate-validation');if(pSource.kind!=='tongxu-member-candidate-validation'||!pSource.candidateSource)throw new Error('source_reference_missing');const refSource=pSource.candidateSource,clock=Date.now;try{const now=Date.now();Date.now=()=>now+120000;assert.throws(()=>f.q.memberCandidateSource(refSource),/member_source_current_observation_required/);}finally{Date.now=clock;}
 if(mode==='current-parent'){
  const db=new DatabaseSync(join(f.store,'queue.sqlite'),{readOnly:true});
  assert.equal((db.prepare('SELECT result FROM operations WHERE id=?').get(f.parent.operation) as any).result,historicalParentOriginal);db.close();
  const reports=(await run('report')).reports;
  assert.ok(reports.some((r:any)=>r.kind==='repair'&&r.complete&&r.result.operation===result.operation));
  assert.deepEqual(await readFile(f.model.trace),trace);
  assert.deepEqual(await f.authorState(),authorBefore);
  if(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE)await cp(f.root,join(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE,'member-current-parent'),{recursive:true});
  return;
 }
 const remoteOriginal=await readFile(remote.state),allModels=await readFile(f.model.trace),allReadonly=await readFile(roles.trace),resourceState=ledger?.state();for(const problem of [{closed:true},{fork:true},{exitCode:3}]){await writeFile(remote.state,canonical({...JSON.parse(remoteOriginal.toString()),...problem}));await assert.rejects(()=>run('collect-member','--task','A'),/conditional_entry_(source_read_incomplete|published_repository_changed|published_candidate_mismatch)/);const old=await run('validate-member','--task','A');assert.equal(old.newVerificationRuns,0);assert.equal(old.sourceCurrent,false);assert.equal(old.historicalResultOnly,true);assert.equal((await run('recompose-member','--task','A')).phase,'waiting_for_current_member_source');await writeFile(remote.state,remoteOriginal);await run('collect-member','--task','A');assert.equal((await run('validate-member','--task','A')).sourceCurrent,true);}
 await remote.publish(f.A3,f.objects);await assert.rejects(()=>run('collect-member','--task','A'),/conditional_entry_published_candidate_mismatch/);assert.equal((await run('state')).collectionSources.find((s:any)=>s.kind==='member-source').sourceCurrent,false);assert.throws(()=>f.q.memberCandidateSource(refSource),/member_source_current_observation_required/);await writeFile(remote.state,remoteOriginal);await run('collect-member','--task','A');
 const body='Actual newly observed member material for the same fixed H1';await writeFile(remote.state,canonical({...JSON.parse(remoteOriginal.toString()),body}));const changed=await run('collect-member','--task','A');assert.ok(changed.sourceObservation.materialReconciliation.items.some((i:any)=>i.changed));assert.deepEqual(await readFile(join(observed.snapshot,'manifest.json')),frozenMember);const originals=await run('report'),memberOriginal=originals.reports.find((r:any)=>r.kind==='member-collection');assert.equal(memberOriginal.result.latestSource.sourceCurrent,true);assert.ok(memberOriginal.result.latestSource.originals.some((r:any)=>Buffer.from(r.text,r.encoding).toString().includes(body)));const oldValidation=await run('validate-member','--task','A');assert.equal(oldValidation.newVerificationRuns,0);assert.equal((await run('recompose-member','--task','A')).phase,'waiting_for_current_combination_material');assert.deepEqual(await readFile(f.model.trace),allModels);assert.deepEqual(await readFile(roles.trace),allReadonly);if(ledger)assert.deepEqual(ledger.state(),resourceState);
 await run('refresh');const currentAgain=await run('integrate');assert.equal(currentAgain.phase,'produced');assert.equal(currentAgain.currentSource,true);assert.equal(currentAgain.result.candidate.H,rebuilt.candidate.H);assert.equal(currentAgain.newGitProcesses,0);assert.deepEqual(await readFile(f.model.trace),allModels);if(ledger)assert.deepEqual(ledger.state(),resourceState);
 if(mode==='monitored'||mode==='governed-monitored'){
  await remote.publishIntegration(rebuilt.candidate.H,join(currentAgain.directory,'candidate.git'));
  const receiverProgram=await readFile(f.plan.claudeExecutable,'utf8');
  await writeFile(f.plan.claudeExecutable,receiverProgram.replace('mode="return"','mode="complete"'));
  const collected=await run('collect','--pr','99');
  assert.equal(collected.collectionComplete,true);
  const verified=await run('validate');
  assert.equal(verified.newVerificationRuns,1);
  assert.equal(verified.state.result.evidenceComplete,true);
  const verification=join(verified.state.directory,'verification','verification.json');
  const frozenVerification=await readFile(verification);
  await run('attach');
  const received=await run('receive');
  assert.equal(received.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');
  const first=f.q.receiverState(received.operation).input;
  assert.ok(first.toString().includes(body));
  const input=JSON.parse(first.toString());
  assert.ok(input.data.evidence.integration.currentMaterial.sha256);
  const nativeCount=await f.count();
  const nextBody='Second full upstream member explanation for the same tested H1';
  const published=JSON.parse(await readFile(remote.state,'utf8'));
  await writeFile(remote.state,canonical({...published,body:nextBody}));
  await run('collect-member','--task','A');
  await run('refresh');
  assert.equal((await run('integrate')).newGitProcesses,0);
  await assert.rejects(()=>run('receive'),/conditional_entry_observed_own_candidate_required/);
  await run('collect','--pr','99');
  assert.equal((await run('validate')).newVerificationRuns,0);
  await run('attach');
  const second=await run('receive');
  assert.notEqual(second.operation,received.operation);
  assert.equal(second.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');
  assert.ok(f.q.receiverState(second.operation).input.toString().includes(nextBody));
  assert.equal(await f.count(),nativeCount+1);
  assert.deepEqual(f.q.receiverState(received.operation).input,first);
  assert.deepEqual(await readFile(verification),frozenVerification);
  await run('receive');
  assert.equal(await f.count(),nativeCount+1);
  assert.deepEqual(await readFile(f.model.trace),allModels);
  if(ledger){assert.equal(ledger.state().claims.length,8);assert.equal(ledger.state().settlements.length,8);}
 }
});


test('member source fixture keeps 99-prefixed member commits separate from exact integration routes',async t=>{
 const f=await receiverFixture(t);
 const B=await git(f.plan.objects,['rev-parse','HEAD^']);
 const remote=await memberSourceFixture(f.root,f.H,B,f.plan.objects);
 const state=JSON.parse(await readFile(remote.state,'utf8'));
 // These artificial SHAs exercise only the local transport routing.
 state.H='99'+'f'.repeat(38);
 state.integration={H:'ab'+'e'.repeat(38),B,commits:[],files:[]};
 await writeFile(remote.state,canonical(state));
 const execute=promisify(execFile);
 const get=async(endpoint:string)=>{
  const response=await execute(process.execPath,[remote.executable,'api','--method','GET',endpoint]);
  assert.match(response.stdout,/^HTTP\/1\.1 200 Fixture/);
  return JSON.parse(response.stdout.split('\r\n\r\n')[1]!);
 };
 assert.equal((await get('repos/fixture/reception/pulls/10')).head.sha,state.H);
 assert.deepEqual(await get('repos/fixture/reception/commits/'+state.H+'/check-runs?filter=latest&per_page=100&page=1'),{total_count:0,check_runs:[]});
 assert.deepEqual(await get('repos/fixture/reception/commits/'+state.H+'/statuses?per_page=100&page=1'),[]);
 assert.equal((await get('repos/fixture/reception/pulls/99')).head.sha,state.integration.H);
 assert.deepEqual(await get('repos/fixture/reception/issues/99/comments?per_page=100&page=1'),[]);
 assert.deepEqual(await get('repos/fixture/reception/commits/'+state.integration.H+'/check-runs?filter=latest&per_page=100&page=1'),{total_count:0,check_runs:[]});
});
