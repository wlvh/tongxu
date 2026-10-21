import type test from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setup } from '../w3/receiver-fixture.js';
import { runReception } from '../../src/receiver.js';
import { fixture as ledgerFixture } from '../resources/provider-fixture.js';
import { publisherFixture } from './provider-fixture.js';
import { hash } from '../../src/snapshot.js';
import { ownerDecisionText,scopeBodyHash,actionHash,type AuthorityProfile,type ActionRequest } from '../../src/authority-contract.js';
import { fixtureOwnerObservation } from '../../src/authority-source.js';
import { readOwnerSource } from '../../src/authority-source.js';
import { randomUUID } from 'node:crypto';
import { resourceRequestHash,type ResourceRequest } from '../../src/resource-contract.js';
import type { ManagedMergeBinding } from '../../src/merge-contract.js';
import { prepareManagedMerge } from '../../src/managed-merge.js';

const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));let commentId=7200000000;
export async function ready(t:test.TestContext,mode='normal'){
  const f=await setup(t);const received=await runReception(f.path);return readyFromReception(t,f,received,mode);
}
export async function readyFromReception(t:test.TestContext,f:Awaited<ReturnType<typeof setup>>,received:any,mode='normal',actualFixtureMerge?:()=>Promise<string>){
  const operation=received.operation;
  f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();
  const sources:Record<string,any>={},sourcePath=join(f.root,'owner-provider-data.json'),exe=join(f.root,'owner-provider.mjs');
  const code=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),data=JSON.parse(fs.readFileSync(${JSON.stringify(sourcePath)},'utf8'));if(args.includes('graphql')){const node=args.find(x=>x.startsWith('id=')).slice(3);console.log(JSON.stringify(Object.values(data).find(x=>x.comment.node_id===node).graph));}else console.log(JSON.stringify(data[args.at(-1).split('/').at(-1)].comment));`;
  writeFileSync(exe,code,{mode:0o700});
  const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:7,ownerId:11,executorId:22,ghExecutable:exe,ghSha256:hash(code),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000};
  const a=f.q.authority();a.configure(bytes(profile));
  function adopt(p:any){const prepared=a.prepare('merge-proposal-'+(++commentId),bytes(p)),sha=prepared.proposalSha256,id=commentId,body=ownerDecisionText(sha),at=new Date().toISOString(),url=`https://github.com/fixture/reception/issues/7#issuecomment-${id}`,nodeId='IC_fixture_'+id;
    const comment={id,node_id:nodeId,user:{id:11,type:'User'},body,created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/7',html_url:url};
    const graph={data:{viewer:{databaseId:22},node:{__typename:'IssueComment',id:nodeId,fullDatabaseId:String(id),author:{__typename:'User',databaseId:11},editor:null,lastEditedAt:null,body,createdAt:at,updatedAt:at,url,issue:{number:7,repository:{nameWithOwner:'fixture/reception'}}}}};
    sources[id]={graph,comment};writeFileSync(sourcePath,bytes(sources));const observation=fixtureOwnerObservation(profile,sha,id,bytes(graph),bytes(comment),at);a.apply(sha,observation);return {sha,observation};
  }
  const ledger=await ledgerFixture(t),r=f.q.receiverState(operation),e=f.q.receiverEvidence(operation),body={goals:['Exercise explicit fixture managed merge'],nonGoals:['No real GitHub update'],preserve:[],acceptance:['Exact original request and actual tree'],constraints:['No personal credential fallback']};
  f.q.resources().configure(bytes(ledger.profile));
  const scope=adopt({kind:'adopt_scope',scopeId:e.context.scope.id,scopeVersion:e.context.scope.version,body,previousAdoption:null});
  const c=e.manifest.candidate,action:ActionRequest={schemaVersion:1,scopeId:e.context.scope.id,scopeVersion:e.context.scope.version,scopeBodySha256:scopeBodyHash(body),repository:c.repository,target:c.targetRef,action:'merge',item:f.item,candidate:{H:c.H,B:c.B,subjectSha256:null},paths:[],resourceRefs:['existing-fixture-slot']};
  const confirmation=adopt({kind:'confirm_action',adoption:scope.sha,performerRole:'background',request:action,expiresAt:new Date(Date.now()+3600000).toISOString()}),observations=[scope.observation,confirmation.observation],intent='fixture-managed-merge';a.reserveAction(intent,action,'background',confirmation.sha,observations);
  const request:ResourceRequest={schemaVersion:1,ledgerId:ledger.profile.ledgerId,repository:c.repository,operation,authorityIntent:intent,resourceRef:'existing-fixture-slot',unit:'fixture-task',quantity:1,role:'background',actionSha256:actionHash(action)};
  const binding:ManagedMergeBinding={schemaVersion:1,operation,item:f.item,packet:r.result.packet,repository:c.repository,repositoryId:99,pr:c.pr,H:c.H,B:c.B,targetRef:c.targetRef,T:r.result.tree,receptionOperation:operation,judgmentId:r.receiver.judgmentId,receptionBindingHash:r.receiver.bindingHash,authorityIntent:intent,resourceRequests:[resourceRequestHash(request)],scope:{id:action.scopeId,version:action.scopeVersion,bodySha256:action.scopeBodySha256},arrangement:{id:e.context.arrangement.id,version:e.context.arrangement.version},subjectSha256:null,integrationReference:r.receiver.integrationSha256??null,method:'merge'};
  const publisher=await publisherFixture(t,binding,mode,actualFixtureMerge);f.q.merges().configure(bytes(publisher.profile));
  const plan=bytes({binding,resources:[request]});await prepareManagedMerge(f.store,plan);
  const fresh=async()=>{const values=[];for(const ref of a.sourceRequests(confirmation.sha))values.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(f.root,'fresh-owner-'+randomUUID())));return values;};
  return {...f,receiverPlan:f.plan,operation,binding,request,publisher,ledger,a,scope,confirmation,adopt,observations,sourcePath,plan,fresh};
}
