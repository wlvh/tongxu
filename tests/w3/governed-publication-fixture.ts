import type test from 'node:test';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {publicationFixture} from './publication-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {publicDocument} from '../../src/publisher.js';
import {publicationAuthorityPayloadSha,type PublicationPlan} from '../../src/publication-contract.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {ownerDecisionText,scopeBodyHash,type AuthorityProfile,type ActionRequest} from '../../src/authority-contract.js';
import {readOwnerSource} from '../../src/authority-source.js';
import {prepareResourceRequest} from '../../src/resource-claims.js';
import {resourceRequestHash,type ResourceRequest} from '../../src/resource-contract.js';
import {DatabaseSync} from 'node:sqlite';
import {enableMemberRefutationFormat} from '../../src/queue-format.js';
const raw=(v:unknown)=>Buffer.from(canonical(v));

/** All executable endpoints here are owned local scripts. github/external
 * protocol shapes exercise their production adapters without network access. */
export async function governedPublicationFixture(t:test.TestContext,remoteMode='normal',ledgerMode='normal',memberFormat=false){
  const hooks:Array<()=>unknown>=[],owned={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext,f=await publicationFixture(owned,remoteMode),ledger=await ledgerFixture(owned,ledgerMode);
  t.after(async()=>{f.q.close();const parent=process.env.TONGXU_PUBLICATION_TEST_EVIDENCE;if(parent){await mkdir(parent,{recursive:true});for(const p of [f.root,ledger.root])await cp(p,join(parent,basename(p)),{recursive:true});}for(const hook of hooks.reverse())try{await hook();}catch{}});
  const provider=(await readFile(ledger.profile.executable,'utf8')).replace("executionKind:'fixture'","executionKind:'external'");await writeFile(ledger.profile.executable,provider);const ledgerProfile={...ledger.profile,executionKind:'external' as const,executableSha256:hash(provider)};
  f.q.enableSupplements();f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();const records:Record<string,any>={},sourcePath=join(f.root,'explicit-local-owner-records.json'),exe=join(f.root,'explicit-local-owner.mjs');await writeFile(sourcePath,raw(records));
  if(memberFormat){const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{db.exec('BEGIN IMMEDIATE');enableMemberRefutationFormat(db);db.exec('COMMIT');}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}}
  const code=`#!${process.execPath}\nimport fs from'node:fs';const args=process.argv.slice(2),r=JSON.parse(fs.readFileSync(${JSON.stringify(sourcePath)},'utf8'));if(args.includes('graphql')){const id=args.find(v=>v.startsWith('id=')).slice(3);console.log(JSON.stringify(Object.values(r).find(x=>x.comment.node_id===id).graph));}else console.log(JSON.stringify(r[args.at(-1).split('/').at(-1)].comment));`;
  await writeFile(exe,code,{mode:0o700});const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:8,ownerId:101,executorId:72,ghExecutable:exe,ghSha256:hash(code),executionKind:'github',maxObservationAgeMs:300000,maxGrantDurationMs:86400000},a=f.q.authority();a.configure(raw(profile));a.enableGovernedPublication();f.q.resources().configure(raw(ledgerProfile));let index=7400000000;
  async function adopt(value:any){const p=a.prepare('local-publication-proposal-'+(++index),raw(value)),id=index,sha=p.proposalSha256,text=ownerDecisionText(sha),at=new Date().toISOString(),node='IC_publication_'+id,url=`https://github.com/fixture/reception/issues/8#issuecomment-${id}`;
    const comment={id,node_id:node,body:text,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/8',html_url:url},graph={data:{viewer:{databaseId:72},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body:text,createdAt:at,updatedAt:at,url,issue:{number:8,repository:{nameWithOwner:'fixture/reception'}}}}};records[id]={comment,graph};await writeFile(sourcePath,raw(records));const observation=await readOwnerSource(profile,sha,id,join(f.root,'owner-observation-'+id));a.apply(sha,observation);return {sha,observation,id};
  }
  const state=f.q.receiverState(f.result.operation),context=JSON.parse(state.input.toString()).binding.context,body={goals:['Publish a fixed local fixture result'],nonGoals:['No network, real identity, supplier or business writes'],preserve:['Original reports and uncertain requests'],acceptance:['Exact authority, original resource, one matching publication'],constraints:['All endpoints are explicitly local protocol-shaped fixtures']},scope=await adopt({kind:'adopt_scope',scopeId:context.scope.id,scopeVersion:context.scope.version,body,previousAdoption:null});
  const p:PublicationPlan={...f.p,schemaVersion:1,kind:'tongxu-reception-publication',channel:'commit-status',governance:{authorityIntent:'fixed-publication-intent',resourceRequests:[]}},doc=publicDocument(p,state),request:ActionRequest={schemaVersion:1,scopeId:context.scope.id,scopeVersion:context.scope.version,scopeBodySha256:scopeBodyHash(body),repository:'fixture/reception',target:'fixture',action:'publish',item:f.item,candidate:{H:f.result.candidate.H,B:f.result.candidate.B,subjectSha256:null},paths:[],resourceRefs:[ledgerProfile.resources[0]!.ref],payloadSha256:publicationAuthorityPayloadSha(p,hash(Buffer.from(JSON.stringify(doc))))},confirmed=await adopt({kind:'confirm_action',adoption:scope.sha,performerRole:'background',request,expiresAt:new Date(Date.now()+3600000).toISOString()});
  const action=a.reserveAction(p.governance!.authorityIntent,request,'background',confirmed.sha,[scope.observation,confirmed.observation]),resource:ResourceRequest={schemaVersion:1,ledgerId:ledgerProfile.ledgerId,repository:ledgerProfile.repository,operation:p.operation,authorityIntent:p.governance!.authorityIntent,resourceRef:ledgerProfile.resources[0]!.ref,unit:ledgerProfile.resources[0]!.unit,quantity:1,role:'background',actionSha256:action.requestSha256};await prepareResourceRequest(f.store,raw(resource),'background');p.governance!.resourceRequests=[resourceRequestHash(resource)];await writeFile(f.pubPath,raw(p));
  return {...f,p,owner:{a,profile,scope,confirmed,adopt,request},ledger,resource,resourceId:resourceRequestHash(resource)};
}
