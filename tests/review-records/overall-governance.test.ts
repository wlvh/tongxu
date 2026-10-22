import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {overallFixture} from './overall-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {overallReview} from '../../src/overall-review.js';
import {overallAuthorityPayloadSha} from '../../src/overall-authority.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';
import {ownerDecisionText,scopeBodyHash,actionHash,type AuthorityProfile,type ActionRequest} from '../../src/authority-contract.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import type {ResourceRequest} from '../../src/resource-contract.js';

async function governed(t:test.TestContext,mode='normal'){
  const f=await overallFixture(t),ledger=await ledgerFixture(t,mode);f.q.enableCompositions();f.q.enableReceiverCorrections();
  const records:Record<string,any>={},source=join(f.root,'owner-source.json'),exe=join(f.root,'owner-source.mjs'),code=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),data=JSON.parse(fs.readFileSync(${JSON.stringify(source)},'utf8'));if(args.includes('graphql'))console.log(JSON.stringify(Object.values(data).find(x=>x.comment.node_id===args.find(a=>a.startsWith('id=')).slice(3)).graph));else console.log(JSON.stringify(data[args.at(-1).split('/').at(-1)].comment));`;
  await writeFile(exe,code,{mode:0o700});const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:9,ownerId:101,executorId:202,ghExecutable:exe,ghSha256:hash(code),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000},a=f.q.authority();a.configure(Buffer.from(canonical(profile)));f.q.resources().configure(Buffer.from(canonical(ledger.profile)));let serial=7400000000;
  async function adopt(p:any){const id=++serial,sha=a.prepare('overall-'+id,Buffer.from(canonical(p))).proposalSha256,body=ownerDecisionText(sha),at=new Date().toISOString(),node='IC_overall_'+id,url=`https://github.com/fixture/reception/issues/9#issuecomment-${id}`,comment={id,node_id:node,body,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/9',html_url:url},graph={data:{viewer:{databaseId:202},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body,createdAt:at,updatedAt:at,url,issue:{number:9,repository:{nameWithOwner:'fixture/reception'}}}}};records[id]={comment,graph};await writeFile(source,canonical(records));const observation=fixtureOwnerObservation(profile,sha,id,Buffer.from(canonical(graph)),Buffer.from(canonical(comment)),at);a.apply(sha,observation);return {sha,observation};}
  const item=f.q.status().items.find((i:any)=>i.id===f.item),body={goals:['Explicit overall-review test'],nonGoals:['No supplier calls'],preserve:['Original operation'],acceptance:['Four categories and exact authority'],constraints:['Existing resource fixture only']},scope=await adopt({kind:'adopt_scope',scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,body,previousAdoption:null});
  const request:ActionRequest={schemaVersion:1,scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,scopeBodySha256:scopeBodyHash(body),repository:'fixture/reception',target:item.candidate.targetRef,action:'coordinate',item:f.item,candidate:{H:item.candidate.H,B:item.candidate.B,subjectSha256:null},paths:[],resourceRefs:['existing-fixture-slot'],payloadSha256:overallAuthorityPayloadSha(f.plan)};
  const confirmation=await adopt({kind:'confirm_action',adoption:scope.sha,performerRole:'coordinator',request,expiresAt:new Date(Date.now()+3600000).toISOString()}),observations=[scope.observation,confirmation.observation],intent='overall-fixed-action';a.reserveAction(intent,request,'coordinator',confirmation.sha,observations);
  const resource:ResourceRequest={schemaVersion:1,ledgerId:ledger.profile.ledgerId,repository:request.repository,operation:f.plan.operation,authorityIntent:intent,resourceRef:'existing-fixture-slot',unit:'fixture-task',quantity:1,role:'coordinator',actionSha256:actionHash(request)},id=f.q.resources().prepare(resource,observations,'coordinator').id;
  f.plan.governance={authorityIntent:intent,resourceRequests:[id]};const write=()=>writeFile(f.planPath,canonical(f.plan));await write();return {...f,a,ledger,adopt,confirmation,scope,request,id,source,write};
}
test('governed overall review consumes original authority and one existing claim; repeat recovers after revocation without another input',async t=>{
  const f=await governed(t);assert.equal((await overallReview(f.planPath,'prepare')).status,'prepared_not_sent');assert.equal(f.ledger.state().claims.length,0);
  const result=await overallReview(f.planPath,'run') as any;assert.equal(result.status,'review_recorded');assert.equal(result.resources[0].settled,true);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.equal(result.noOverallDriftEstablished,false);
  const before=await readFile(f.m.trace);await f.adopt({kind:'revoke',decision:f.confirmation.sha});await writeFile(f.source,'{}');const repeated=await overallReview(f.planPath,'reconcile') as any;assert.equal(repeated.duplicate,true);assert.equal(repeated.resources[0].settled,true);assert.deepEqual(await readFile(f.m.trace),before);
  const original=f.q.reviewRecords().overallOriginal(Buffer.from(canonical(f.plan)))!;assert.equal(original.events.filter((e:any)=>e.kind==='overall_review_dispatched').length,1);
});
test('revoked, changed and resource-unavailable proposals never start a new overall model turn',async t=>{
  const revoked=await governed(t),before=await readFile(revoked.m.trace);await revoked.adopt({kind:'revoke',decision:revoked.confirmation.sha});await assert.rejects(overallReview(revoked.planPath,'run'),/revoked/);assert.deepEqual(await readFile(revoked.m.trace),before);assert.equal(revoked.ledger.state().claims.length,0);
  const changed=await governed(t);changed.plan.trigger.reason='A changed task is not the authorized plan';await changed.write();await assert.rejects(overallReview(changed.planPath,'run'),/exact_authority_mismatch/);assert.equal(changed.ledger.state().claims.length,0);
  const absent=await governed(t,'credentials-missing'),old=await readFile(absent.m.trace);await assert.rejects(overallReview(absent.planPath,'run'),/credentials_unavailable/);assert.deepEqual(await readFile(absent.m.trace),old);assert.equal(absent.ledger.state().claims.length,0);
});
test('lost resource settlement reuses the complete original capture and provider lookup, never replays the model',async t=>{
  const f=await governed(t,'lost-after-result'),result=await overallReview(f.planPath,'run') as any;assert.equal(result.status,'review_recorded');assert.equal(result.resources[0].settled,false);const before=await readFile(f.m.trace);assert.equal(f.ledger.state().settlements.length,1);
  const recovered=await overallReview(f.planPath,'reconcile') as any;assert.equal(recovered.resources[0].settled,true);assert.deepEqual(await readFile(f.m.trace),before);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);
});
test('new overall dispatch keeps the persistent old-consumer denial and composes with publication protections',async t=>{
  const f=await governed(t),db=new DatabaseSync(join(f.store,'queue.sqlite'));t.after(()=>db.close());f.a.enableGovernedOverall();f.a.enableGovernedPublication();f.a.configuration();
  const old=await overallReview(f.planPath,'prepare') as any,raw={operation:f.plan.operation,id:old.id,inputSha256:'a'.repeat(64),blobs:{},attempt:1};
  assert.throws(()=>db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('overall_review_dispatched','overall:'+old.id,canonical(raw),new Date().toISOString()),/authority_consumer_binding_required/);
  assert.equal((await overallReview(f.planPath,'run')).status,'review_recorded');
  const g=await governed(t);g.a.enableGovernedPublication();g.a.enableGovernedOverall();g.a.configuration();assert.equal((await overallReview(g.planPath,'run')).status,'review_recorded');
});
