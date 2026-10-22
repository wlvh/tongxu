import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {overallFixture} from './overall-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {overallAuthorityPayloadSha} from '../../src/overall-authority.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';
import {ownerDecisionText,scopeBodyHash,actionHash,type AuthorityProfile,type ActionRequest} from '../../src/authority-contract.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import type {ResourceRequest} from '../../src/resource-contract.js';

export async function governed(t:test.TestContext,mode='normal'){
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
