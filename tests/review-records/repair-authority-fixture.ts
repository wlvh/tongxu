import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../src/snapshot.js';
import { ownerDecisionText,scopeBodyHash,type AuthorityProfile,type ActionRequest } from '../../src/authority-contract.js';
import { fixtureOwnerObservation } from '../../src/authority-source.js';
import { prepareResourceRequest } from '../../src/resource-claims.js';
import { resourceRequestHash,type LedgerProfile,type ResourceRequest } from '../../src/resource-contract.js';
const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));
/** Explicit local Owner/provider fixtures. No real identity or external grant. */
export async function authorizeRepairFixture(f:any,ledger:LedgerProfile){
  f.q.enableCompositions();f.q.enableReceiverCorrections();const records:Record<string,any>={},sourcePath=join(f.root,'repair-owner-originals.json'),exe=join(f.root,'repair-owner-fixture.mjs');
  const code=`#!${process.execPath}\nimport fs from'node:fs';const args=process.argv.slice(2),r=JSON.parse(fs.readFileSync(${JSON.stringify(sourcePath)},'utf8'));if(args.includes('graphql')){const id=args.find(v=>v.startsWith('id=')).slice(3);console.log(JSON.stringify(Object.values(r).find(x=>x.comment.node_id===id).graph));}else console.log(JSON.stringify(r[args.at(-1).split('/').at(-1)].comment));`;
  await writeFile(exe,code,{mode:0o700});const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:8,ownerId:101,executorId:202,ghExecutable:exe,ghSha256:hash(code),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000},a=f.q.authority();a.configure(bytes(profile));let index=7300000000;
  async function adopt(value:any){const p=a.prepare('repair-proposal-'+(++index),bytes(value)),id=index,sha=p.proposalSha256,text=ownerDecisionText(sha),at=new Date().toISOString(),node='IC_repair_'+id,url=`https://github.com/fixture/reception/issues/8#issuecomment-${id}`;
    const comment={id,node_id:node,body:text,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/8',html_url:url},graph={data:{viewer:{databaseId:202},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body:text,createdAt:at,updatedAt:at,url,issue:{number:8,repository:{nameWithOwner:'fixture/reception'}}}}};records[id]={comment,graph};await writeFile(sourcePath,bytes(records));const observation=fixtureOwnerObservation(profile,sha,id,bytes(graph),bytes(comment),at);a.apply(sha,observation);return {sha,observation,id};
  }
  const scopeContext=f.p.context.scope,body={goals:['Repair the explicitly defective local fixture'],nonGoals:['No production or external business changes'],preserve:['Original judgment and captures'],acceptance:['Restricted file change, actual registered tests, independent review'],constraints:['Only the supplied allowed fixture paths; original provider owns resource accounting']},scope=await adopt({kind:'adopt_scope',scopeId:scopeContext.id,scopeVersion:scopeContext.version,body,previousAdoption:null});
  const request:ActionRequest={schemaVersion:1,scopeId:scopeContext.id,scopeVersion:scopeContext.version,scopeBodySha256:scopeBodyHash(body),repository:'fixture/reception',target:'fixture',action:'implement',item:f.plan.item,candidate:{H:f.H,B:f.request.candidate.B,subjectSha256:null},paths:f.request.allowedPaths,resourceRefs:[ledger.resources[0]!.ref]},confirmed=await adopt({kind:'confirm_action',adoption:scope.sha,performerRole:'implementer',request,expiresAt:new Date(Date.now()+3600000).toISOString()}),intent='governed-fixture-repair';
  const action=a.reserveAction(intent,request,'implementer',confirmed.sha,[scope.observation,confirmed.observation]);f.q.resources().configure(bytes(ledger));
  const resource:ResourceRequest={schemaVersion:1,ledgerId:ledger.ledgerId,repository:ledger.repository,operation:f.operation,authorityIntent:intent,resourceRef:ledger.resources[0]!.ref,unit:ledger.resources[0]!.unit,quantity:1,role:'implementer',actionSha256:action.requestSha256};await prepareResourceRequest(f.store,bytes(resource),'implementer');
  return {profile,a,scope,confirmed,request,intent,resource,resourceId:resourceRequestHash(resource),adopt,records,sourcePath};
}
