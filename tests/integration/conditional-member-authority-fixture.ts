import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from '../../src/snapshot.js';
import {ownerDecisionText,type AuthorityProfile} from '../../src/authority-contract.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';
import type {QueueStore} from '../../src/queue-store.js';
import type {LedgerProfile} from '../../src/resource-contract.js';
const bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));

/** Original local Owner source only. It deliberately reserves no action or
 * resource in advance; the actual normal entry must derive each one. */
export async function memberAuthorityFixture(f:{root:string;q:QueueStore;context:any},ledger:LedgerProfile){
 f.q.enableReceiverCorrections();const records:Record<string,any>={},sourcePath=join(f.root,'member-owner-source.json'),exe=join(f.root,'member-owner-source-fixture.mjs');
 const code=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),r=JSON.parse(fs.readFileSync(${JSON.stringify(sourcePath)},'utf8'));if(args.includes('graphql')){const id=args.find(v=>v.startsWith('id=')).slice(3);console.log(JSON.stringify(Object.values(r).find(x=>x.comment.node_id===id).graph));}else console.log(JSON.stringify(r[args.at(-1).split('/').at(-1)].comment));`;
 await writeFile(exe,code,{mode:0o700});const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:8,ownerId:101,executorId:202,ghExecutable:exe,ghSha256:hash(code),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000},a=f.q.authority();a.configure(bytes(profile));f.q.resources().configure(bytes(ledger));let next=7400000000;
 async function adopt(value:any){const p=a.prepare('normal-member-proposal-'+(++next),bytes(value)),id=next,sha=p.proposalSha256,text=ownerDecisionText(sha),at=new Date().toISOString(),node='IC_member_'+id,url=`https://github.com/fixture/reception/issues/8#issuecomment-${id}`;
  const comment={id,node_id:node,body:text,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/8',html_url:url},graph={data:{viewer:{databaseId:202},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body:text,createdAt:at,updatedAt:at,url,issue:{number:8,repository:{nameWithOwner:'fixture/reception'}}}}};records[id]={comment,graph};await writeFile(sourcePath,bytes(records));const observation=fixtureOwnerObservation(profile,sha,id,bytes(graph),bytes(comment),at);a.apply(sha,observation);return {sha,observation,id};
 }
 const scope=await adopt({kind:'adopt_scope',scopeId:f.context.scope.id,scopeVersion:f.context.scope.version,body:{goals:['Repair the actual selected local member and verify its new candidate and combination'],nonGoals:['No production or real remote writes'],preserve:['Original return, captures and author work'],acceptance:['Actual controlled repair, own registered verification and exact recomposition'],constraints:['Configured paths only, original resources and distinct purpose-bound actions']},previousAdoption:null});return {profile,a,scope,adopt};
}
