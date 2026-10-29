import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../w3/receiver-fixture.js';
import { QueueStore } from '../../src/queue-store.js';
import { canonical } from '../../src/comparison.js';
import { hash } from '../../src/snapshot.js';
import { ownerDecisionText,scopeBodyHash,parseActionRequest,parseOwnerProposal,parseAuthorityProfile,type AuthorityProfile,type ActionRequest } from '../../src/authority-contract.js';
import { fixtureOwnerObservation,readOwnerSource,type OwnerObservation } from '../../src/authority-source.js';
import { authorityMain } from '../../src/authority-cli.js';
import { runReception } from '../../src/receiver.js';
import { fixture as modelFixture } from '../w5/repair-fixture.js';
import { overallReview } from '../../src/overall-review.js';

const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));
const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:7,ownerId:101,executorId:202,ghExecutable:'/fixture/gh',ghSha256:'a'.repeat(64),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000};
const body={goals:['Bounded fixture behavior'],nonGoals:['No production acceptance'],preserve:['Keep originals'],acceptance:['Inspect exact evidence'],constraints:['No hidden side effects']};
let serial=6200000000;
function originals(sha:string,id=++serial,p=profile){const at=new Date().toISOString(),url=`https://github.com/${p.repository}/issues/${p.issue}#issuecomment-${id}`,text=ownerDecisionText(sha),nodeId='IC_fixture_'+id;
  return {id,readAt:at,comment:{id,node_id:nodeId,body:text,user:{id:p.ownerId,type:'User'},created_at:at,updated_at:at,issue_url:`https://api.github.com/repos/${p.repository}/issues/${p.issue}`,html_url:url},graph:{data:{viewer:{id:'U_fixture',databaseId:p.executorId,login:'executor-fixture'},node:{__typename:'IssueComment',id:nodeId,fullDatabaseId:String(id),body:text,createdAt:at,updatedAt:at,lastEditedAt:null as string|null,url,author:{__typename:'User',databaseId:p.ownerId},editor:null as any,issue:{number:p.issue,repository:{nameWithOwner:p.repository}}}}}};
}
function observation(raw:ReturnType<typeof originals>,sha:string,p=profile){return fixtureOwnerObservation(p,sha,raw.id,bytes(raw.graph),bytes(raw.comment),raw.readAt);}
async function fixture(t:test.TestContext){
  const f=await setup(t);f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();
  const r=f.q.authority();r.configure(bytes(profile));let index=0;
  function prepare(p:any,id='proposal-'+(++index)){return r.prepare(id,bytes(p));}
  function adopt(p:any){const proposal=prepare(p),raw=originals(proposal.proposalSha256),obs=observation(raw,proposal.proposalSha256);r.apply(proposal.proposalSha256,obs);return {sha:proposal.proposalSha256,raw,obs,proposal};}
  const c=f.q.status().items[0].context;
  const scope=adopt({kind:'adopt_scope',scopeId:c.scope.id,scopeVersion:c.scope.version,body,previousAdoption:null});
  const item=f.q.status().items[0],request:ActionRequest={schemaVersion:1,scopeId:c.scope.id,scopeVersion:c.scope.version,scopeBodySha256:scopeBodyHash(body),repository:profile.repository,target:'fixture',action:'receive',item:f.item,candidate:{H:item.candidate.H,B:item.candidate.B,subjectSha256:null},paths:['sample.js'],resourceRefs:[]};
  const confirm=(req=request)=>adopt({kind:'confirm_action',adoption:scope.sha,performerRole:'receiver',request:req,expiresAt:new Date(Date.now()+3600000).toISOString()});
  return {...f,r,prepare,adopt,scope,request,confirm};
}
test('source proof requires two coherent originals, distinct identities and owner last editor',()=>{
  const sha='b'.repeat(64),source=originals(sha);assert.equal(observation(source,sha).authorId,101);
  const changed=(f:(r:ReturnType<typeof originals>)=>void,pattern:RegExp)=>{const r=structuredClone(source);f(r);assert.throws(()=>observation(r,sha),pattern);};
  changed(r=>{r.graph.data.viewer.databaseId=101;},/execution_identity/);
  assert.throws(()=>observation(originals(sha,++serial,{...profile,executorId:101}),sha,{...profile,executorId:101}),/shared_account/);
  changed(r=>{r.graph.data.node.editor={__typename:'User',databaseId:202};r.graph.data.node.lastEditedAt=r.readAt;},/edited_by_another/);
  changed(r=>{r.graph.data.node.lastEditedAt=r.readAt;},/editor_attribution/);
  changed(r=>{r.comment.body='Please approve '+r.comment.body;},/source_mismatch/);
  changed(r=>{r.graph.data.node.fullDatabaseId='12';},/source_mismatch/);
  changed(r=>{r.graph.data.node.issue.number=8;},/source_mismatch/);
  changed(r=>{r.graph.data.node.body=r.comment.body='PASS';},/not_an_exact/);
  changed(r=>{r.graph.data.node.body=r.comment.body=JSON.stringify({...JSON.parse(r.comment.body),role:'owner'});},/not_an_exact/);
  const edited=structuredClone(source);edited.graph.data.node.editor={__typename:'User',databaseId:101};edited.graph.data.node.lastEditedAt=edited.readAt;assert.equal(observation(edited,sha).editorId,101);
  assert.throws(()=>fixtureOwnerObservation({...profile,executionKind:'github'},sha,source.id,bytes(source.graph),bytes(source.comment),source.readAt),/fixture_owner_source_only/);
});
test('configuration is not adoption; fixed proposals keep original encoding and idempotent scope application',async t=>{
  const f=await fixture(t),s=f.r.status();assert.equal(s.executionKind,'fixture');assert.equal(s.scopes.length,1);assert.equal(s.externalActionSent,false);
  assert.equal(f.r.configure(Buffer.from(canonical(profile))).duplicate,true);
  assert.throws(()=>f.r.configure(bytes({...profile,ownerId:303})),/profile_is_fixed/);
  const before=f.q.status().events.length;assert.equal(f.r.apply(f.scope.sha,f.scope.obs).duplicate,true);assert.equal(f.q.status().events.length,before);
  assert.equal(f.r.prepare(f.scope.proposal.requestId,Buffer.from(canonical(f.scope.proposal.prepared.proposal))).duplicate,true);
  assert.throws(()=>f.r.prepare(f.scope.proposal.requestId,bytes({...f.scope.proposal.prepared.proposal,body:{...body,goals:['changed']}})),/request_id_changed/);
  assert.throws(()=>f.r.apply(f.scope.sha,{...f.scope.obs} as OwnerObservation),/fresh_provider/);
  const fresh=observation(f.scope.raw,f.scope.sha);fresh.graphRaw.fill(32);assert.throws(()=>f.r.apply(f.scope.sha,fresh));
});
test('one-shot exact action survives restart without a second reservation or automatic resend',async t=>{
  const f=await fixture(t),c=f.confirm(),obs=[c.obs,f.scope.obs];
  assert.throws(()=>f.r.checkAction(f.request,'background',c.sha,obs),/exact_action_mismatch/);
  const x=f.r.reserveAction('receive-one',f.request,'receiver',c.sha,obs);assert.equal(x.state,'reserved_execution_unproven');assert.equal(x.consumerActionAvailable,false);
  assert.throws(()=>f.r.checkAction(f.request,'receiver',c.sha,obs),/already_reserved/);
  assert.throws(()=>f.r.reserveAction('another-id',f.request,'receiver',c.sha,obs),/already_reserved/);
  const q=await QueueStore.open(f.store);try{const repeated=q.authority().reserveAction('receive-one',f.request,'receiver',c.sha,[]);assert.equal(repeated.duplicate,true);assert.equal(repeated.next,'read_original_execution_before_any_dispatch');}finally{q.close();}
  const revocation=f.adopt({kind:'revoke',decision:c.sha});assert.ok(revocation.sha);
  assert.throws(()=>f.r.checkAction(f.request,'receiver',c.sha,obs),/decision_revoked/);
  assert.equal(f.r.reserveAction('receive-one',f.request,'receiver',c.sha,[]).state,'reserved_execution_unproven');assert.equal(f.r.status().intents.length,1);assert.equal(await f.count(),0);
});
test('delegation matches trusted role, action, exact paths, resources, target and current S',async t=>{
  const f=await fixture(t),d=f.adopt({kind:'delegate',adoption:f.scope.sha,roles:['receiver','background'],targets:['fixture'],actions:['receive','test'],paths:['sample.js'],resourceRefs:['existing-seat'],expiresAt:new Date(Date.now()+3600000).toISOString()}),obs=[d.obs,f.scope.obs];
  assert.equal(f.r.checkAction(f.request,'receiver',d.sha,obs).authorityCheck,'passed');
  const reject=(request:any,role:any,pattern:RegExp)=>assert.throws(()=>f.r.checkAction(request,role,d.sha,obs),pattern);
  reject(f.request,'secretary',/trusted_role/);reject(f.request,'coordinator',/trusted_role/);
  reject({...f.request,target:'main'},'receiver',/boundary_mismatch/);
  reject({...f.request,paths:['sample.js','secrets.txt']},'receiver',/boundary_mismatch/);
  reject({...f.request,resourceRefs:['new-paid-route']},'receiver',/boundary_mismatch/);
  reject({...f.request,action:'merge'},'background',/boundary_mismatch/);
  reject({...f.request,scopeVersion:'S9'},'receiver',/scope_mismatch/);
  reject({...f.request,repository:'another/repo'},'receiver',/repository_mismatch/);
  reject({...f.request,candidate:{...f.request.candidate,H:'a'.repeat(40)}},'receiver',/current_candidate/);
  assert.throws(()=>parseActionRequest({...f.request,role:'background'}),/request_invalid/);
  assert.throws(()=>parseActionRequest({...f.request,paths:['../elsewhere']}),/request_invalid/);
  assert.throws(()=>parseOwnerProposal({kind:'delegate',adoption:f.scope.sha,roles:['owner'],targets:['fixture'],actions:['merge'],paths:[],resourceRefs:[],expiresAt:new Date(Date.now()+10000).toISOString()},profile,Date.now()),/delegation_invalid/);
});
test('source edits, expired observations, deleted/unavailable sources do not reuse cached approval',async t=>{
  const f=await fixture(t),c=f.confirm();assert.throws(()=>f.r.checkAction(f.request,'receiver',c.sha,[f.scope.obs]),/fresh_exact_owner/);
  const old=structuredClone(c.raw);old.readAt=new Date(Date.now()-600000).toISOString();old.graph.data.node.createdAt=old.graph.data.node.updatedAt=old.comment.created_at=old.comment.updated_at=old.readAt;assert.throws(()=>f.r.checkAction(f.request,'receiver',c.sha,[observation(old,c.sha),f.scope.obs]),/fresh_provider/);
  const edited=structuredClone(c.raw);edited.graph.data.node.body=edited.comment.body=ownerDecisionText('c'.repeat(64));assert.throws(()=>observation(edited,c.sha),/not_an_exact/);
  const withProse=structuredClone(c.raw);withProse.graph.data.node.body=withProse.comment.body='This is only a proposal.\n'+withProse.comment.body;assert.throws(()=>observation(withProse,c.sha),/not_an_exact/);
  const expiring=f.adopt({kind:'confirm_action',adoption:f.scope.sha,performerRole:'receiver',request:f.request,expiresAt:new Date(Date.now()+200).toISOString()});await new Promise(r=>setTimeout(r,230));assert.throws(()=>f.r.checkAction(f.request,'receiver',expiring.sha,[expiring.obs,f.scope.obs]),/expired/);
  assert.equal(f.r.status().intents.length,0);
});
test('scope adoption uses previous identity CAS; r update reuses S but S update invalidates old delegation',async t=>{
  const f=await fixture(t),d=f.adopt({kind:'delegate',adoption:f.scope.sha,roles:['receiver'],targets:['fixture'],actions:['receive'],paths:['sample.js'],resourceRefs:[],expiresAt:new Date(Date.now()+3600000).toISOString()}),obs=[d.obs,f.scope.obs];
  const changed=await f.packet({arrangementVersion:'r2'});const req={...f.request,item:changed.item};assert.equal(f.r.checkAction(req,'receiver',d.sha,obs).authorityCheck,'passed');
  const v2={kind:'adopt_scope',scopeId:f.request.scopeId,scopeVersion:'S2',body:{...body,goals:['new exact scope']},previousAdoption:f.scope.sha};
  const a=f.prepare(v2),b=f.prepare({...v2,scopeVersion:'S3'});f.r.apply(a.proposalSha256,observation(originals(a.proposalSha256),a.proposalSha256));
  assert.throws(()=>f.r.apply(b.proposalSha256,observation(originals(b.proposalSha256),b.proposalSha256)),/previous_version_changed/);
  assert.throws(()=>f.r.checkAction(req,'receiver',d.sha,obs),/current_adopted_scope/);
  assert.throws(()=>f.prepare({...v2,scopeVersion:f.request.scopeVersion,previousAdoption:a.proposalSha256}),/new_version_required/);
});
test('Owner stop uses original controls; legacy API and pre-opened SQL cannot reopen or delete it',async t=>{
  const f=await fixture(t),legacy=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>legacy.close());const c=f.confirm(),obs=[c.obs,f.scope.obs];
  const stop=f.adopt({kind:'control',adoption:f.scope.sha,control:'investment',state:'stopped'});
  assert.equal(f.q.status().controls[0].stopped,1);assert.throws(()=>f.r.checkAction(f.request,'receiver',c.sha,obs),/action_stopped/);
  assert.throws(()=>f.q.control(f.request.scopeId,'investment','open','agent text'),/verified_owner_stop/);
  assert.throws(()=>legacy.prepare("UPDATE controls SET stopped=0 WHERE scope=?").run(f.request.scopeId),/verified_owner_stop/);
  assert.throws(()=>legacy.prepare('DELETE FROM controls').run(),/must_be_preserved/);
  assert.equal(f.r.apply(stop.sha,stop.obs).duplicate,true);
  const resume=f.adopt({kind:'control',adoption:f.scope.sha,control:'investment',state:'open'});assert.ok(resume.sha);assert.equal(f.q.status().controls[0].stopped,0);assert.equal(f.r.checkAction(f.request,'receiver',c.sha,obs).authorityCheck,'passed');
  f.adopt({kind:'control',adoption:f.scope.sha,control:'merge',state:'stopped'});assert.equal(f.r.checkAction(f.request,'receiver',c.sha,obs).authorityCheck,'passed');
});
test('old current candidate and contradictory observations block authorization without releasing old evidence',async t=>{
  const f=await fixture(t),c=f.confirm();const before=f.q.status().events.length;
  await f.packet({H:await f.newHead()});assert.throws(()=>f.r.checkAction(f.request,'receiver',c.sha,[c.obs,f.scope.obs]),/current_candidate/);assert.ok(f.q.status().events.length>before);assert.equal(f.q.status().items.length,2);
});
test('profile opt-in does not start native consumers and pending claims prevent upgrade',async t=>{
  const f=await fixture(t);await assert.rejects(runReception(f.path),/authority_consumer_binding_required/);assert.equal(await f.count(),0);
  const sql=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>sql.close());
  for(const kind of ['publication_intent','publication_started','overall_review_dispatched'])assert.throws(()=>sql.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run(kind,'fixture','{}',new Date().toISOString()),/authority_consumer_binding_required/);
  const g=await setup(t);g.q.enableSupplements();g.q.reviewRecords().enable();g.q.enableCompositions();g.q.enableReceiverCorrections();g.q.begin(g.item,'fixture-pending');assert.throws(()=>g.q.authority().configure(bytes(profile)),/active_or_unknown/);
});
test('operator CLI has no role override or fixture-to-production importer; status survives reopen',async t=>{
  const f=await fixture(t),p=join(f.root,'profile.json');await writeFile(p,bytes(profile));
  assert.equal((await authorityMain(['configure','--store',f.store,'--profile',p])).duplicate,true);
  await assert.rejects(authorityMain(['status','--store',f.store,'--role','owner']),/invalid_authority_command/);
  await assert.rejects(readOwnerSource(profile,'not-a-digest',f.scope.raw.id,join(f.root,'source')),/github_owner_read_identity_invalid/);
  const state=await authorityMain(['status','--store',f.store]);assert.equal(state.expectedOwnerId,101);assert.equal(state.consumerActionAvailable,false);
  assert.throws(()=>parseAuthorityProfile(bytes({...profile,ghExecutable:'gh'})),/absolute/);
  const baseline=f.r.adoptionBaseline(f.scope.sha,[f.scope.obs]);assert.equal(baseline.verifiedSource,true);assert.equal(baseline.productAcceptance,false);assert.equal(baseline.executionKind,'fixture');
});
test('accepted baseline needs a separate exact snapshot decision; adopting S alone cannot imply it',async t=>{
  const f=await fixture(t),material={goals:{name:'goals.txt',sha256:hash('goals')},rules:{name:'rules.txt',sha256:hash('rules')},capabilities:{name:'capabilities.txt',sha256:hash('capabilities')}};
  assert.throws(()=>f.r.acceptedBaseline(f.scope.sha,Object.values(material),[f.scope.obs]),/explicit_baseline/);
  const b=f.adopt({kind:'accept_baseline',adoption:f.scope.sha,material}),obs=[b.obs,f.scope.obs];
  const accepted=f.r.acceptedBaseline(b.sha,Object.values(material),obs);assert.equal(accepted.technicalPass,false);assert.equal(accepted.mergeApproved,false);
  assert.throws(()=>f.r.acceptedBaseline(b.sha,[{...material.goals,sha256:hash('changed')},material.rules,material.capabilities],obs),/material_mismatch/);
  f.adopt({kind:'adopt_scope',scopeId:f.request.scopeId,scopeVersion:'S2',body,previousAdoption:f.scope.sha});
  assert.equal(f.r.acceptedBaseline(b.sha,Object.values(material),obs).scopeVersion,f.request.scopeVersion);
  f.adopt({kind:'revoke',decision:b.sha});assert.throws(()=>f.r.acceptedBaseline(b.sha,Object.values(material),obs),/decision_revoked/);
});
test('bounded provider reader captures exact commands; failed, partial, changed CLI and coherent fixture sources stay distinct',async t=>{
  const f=await fixture(t),sha=f.scope.sha,raw=f.scope.raw,script=join(f.root,'gh-source-fixture.mjs');
  const content=`#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]!=='api'||args[1]!=='--hostname'||args[2]!=='github.com')process.exit(9);if(args.includes('graphql')){if(!args.some(a=>a.startsWith('query=query('))||args.some(a=>a.includes('mutation')))process.exit(10);process.stdout.write(${JSON.stringify(JSON.stringify(raw.graph))});}else{if(!args.includes('--method')||!args.includes('GET')||args.at(-1)!==${JSON.stringify(`repos/${profile.repository}/issues/comments/${raw.id}`)})process.exit(11);process.stdout.write(${JSON.stringify(JSON.stringify(raw.comment))});}`;
  await writeFile(script,content,{mode:0o700});const p={...profile,ghExecutable:script,ghSha256:hash(content)};
  const good=await readOwnerSource(p,sha,raw.id,join(f.root,'bounded-good'));assert.equal(good.executionKind,'fixture');assert.equal(good.commentId,raw.id);
  const command=JSON.parse(await readFile(join(f.root,'bounded-good/comment-editor-request.json'),'utf8'));assert.ok(command.args.every((a:string)=>!a.includes('mutation')));assert.equal(command.readOnly,true);
  await writeFile(script,content+'\n// changed');await assert.rejects(readOwnerSource(p,sha,raw.id,join(f.root,'bounded-changed')),/gh_current_capabilities_unavailable/);
  const metadata="if(process.argv.includes('--version')){console.log('gh version 99.0.0 (explicit fixture)');process.exit(0)}if(process.argv.includes('--help')){console.log('--hostname --method --include --input --header --raw-field');process.exit(0)};";
  await writeFile(script,content.replace('const args=',metadata+'const args='));const upgraded=await readOwnerSource(p,sha,raw.id,join(f.root,'bounded-upgraded'));assert.equal(upgraded.authorId,101);assert.equal(upgraded.executorId,202);assert.equal(upgraded.executionKind,'fixture');
  const selected=JSON.parse(await readFile(join(f.root,'bounded-upgraded/executable.json'),'utf8'));assert.equal(selected.configuredSha256,p.ghSha256);assert.notEqual(selected.sha256,p.ghSha256);
  const changedDuring=content+"\nif(process.argv.includes('graphql'))(await import('node:fs')).appendFileSync(process.argv[1],'\\n// changed during last owner read\\n');";await writeFile(script,changedDuring);
  await assert.rejects(readOwnerSource({...p,ghSha256:hash(changedDuring)},sha,raw.id,join(f.root,'bounded-last-read-changed')),/changed_during_operation/);
  assert.equal(JSON.parse(await readFile(join(f.root,'bounded-last-read-changed/comment-editor-executable-changed.json'),'utf8')).observationIssued,false);
  await assert.rejects(readFile(join(f.root,'bounded-last-read-changed/observation.json')),{code:'ENOENT'});
  const failing=`#!${process.execPath}\nprocess.stdout.write('{}');process.exit(3);`;await writeFile(script,failing);await assert.rejects(readOwnerSource({...p,ghSha256:hash(failing)},sha,raw.id,join(f.root,'bounded-failure')),/source_unavailable/);
  const exit=JSON.parse(await readFile(join(f.root,'bounded-failure/comment-exit.json'),'utf8'));assert.equal(exit.exit,3);
  const partial=`#!${process.execPath}\nprocess.stdout.write('{"data":');`;await writeFile(script,partial);await assert.rejects(readOwnerSource({...p,ghSha256:hash(partial)},sha,raw.id,join(f.root,'bounded-partial')),SyntaxError);
  assert.equal(JSON.parse(await readFile(join(f.root,'bounded-partial/comment-exit.json'),'utf8')).exit,0);
});
test('overall preparation consumes exact baseline source and bytes; cannot turn this foundation into an unbound model dispatch',async t=>{
  const f=await setup(t),m=await modelFixture(t),received=await runReception(f.path),original=f.q.receiverState(received.operation),context=f.q.receiverEvidence(received.operation).context;
  f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();
  const sourceFile=join(f.root,'provider-fixture.json'),script=join(f.root,'provider-fixture.mjs');
  const code=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),data=JSON.parse(fs.readFileSync(${JSON.stringify(sourceFile)},'utf8'));if(args.includes('graphql')){const id=args.find(a=>a.startsWith('id=')).slice(3);const x=Object.values(data).find(x=>x.comment.node_id===id);process.stdout.write(JSON.stringify(x.graph));}else{const id=args.at(-1).split('/').at(-1);process.stdout.write(JSON.stringify(data[id].comment));}`;
  await writeFile(script,code,{mode:0o700});const p={...profile,ghExecutable:script,ghSha256:hash(code)},r=f.q.authority();r.configure(bytes(p));
  const a=r.prepare('adopt',bytes({kind:'adopt_scope',scopeId:context.scope.id,scopeVersion:context.scope.version,body,previousAdoption:null})),aRaw=originals(a.proposalSha256);r.apply(a.proposalSha256,observation(aRaw,a.proposalSha256,p));
  const material:any={},refs:any[]=[];
  for(const name of ['goals','rules','capabilities']){const path=join(f.root,name+'.txt'),text='Explicit fixture '+name;await writeFile(path,text);const ref={name,sha256:hash(text)};material[name]=ref;refs.push({...ref,path});}
  const b=r.prepare('baseline',bytes({kind:'accept_baseline',adoption:a.proposalSha256,material})),bRaw=originals(b.proposalSha256);r.apply(b.proposalSha256,observation(bRaw,b.proposalSha256,p));await writeFile(sourceFile,bytes({[aRaw.id]:aRaw,[bRaw.id]:bRaw}));
  const plan={schemaVersion:1,kind:'tongxu-overall-review',store:f.store,operation:received.operation,judgmentId:original.receiver.judgmentId,bindingHash:original.receiver.bindingHash,context,config:m.configPath,configSha256:hash(await readFile(m.configPath)),trigger:{kind:'owner_request',source:'fixture:request',reason:'exact accepted baseline fixture'},material:{acceptedBaseline:refs,cumulativeChanges:[refs[0]],currentBehavior:[refs[1]],currentDocuments:[refs[2]]},baselineAcceptance:{kind:'verified_owner_source',decision:b.proposalSha256}};
  const path=join(f.root,'overall-plan.json');await writeFile(path,bytes(plan));const before=await readFile(m.trace),preview=await overallReview(path);assert.equal(preview.status,'prepared_not_sent');assert.deepEqual(preview.gaps,[]);assert.equal((preview as any).baselineSource.executionKind,'fixture');assert.equal(preview.noOverallDriftEstablished,false);
  assert.equal((await overallReview(path)).status,'prepared_not_sent');await assert.rejects(overallReview(path,'run'),/authority_consumer_binding_required/);assert.deepEqual(await readFile(m.trace),before);
  await writeFile(refs[0].path,'replaced content');await assert.rejects(overallReview(path),/overall_material_changed/);
});
