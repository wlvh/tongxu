import type test from 'node:test';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {memberRepairFixture} from './repair-fixture.js';
import {authorizeRepairFixture} from '../review-records/repair-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {raw} from '../integration/fixture.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {Snapshot,hash} from '../../src/snapshot.js';
import {recompositionTestPayloadSha} from '../../src/recomposition-test-contract.js';
import {prepareResourceRequest} from '../../src/resource-claims.js';
import type {MemberRecompositionPlan} from '../../src/member-recomposition-contract.js';
import {readOwnerSource} from '../../src/authority-source.js';
import {randomUUID} from 'node:crypto';

export async function freshOwner(owner:Awaited<ReturnType<typeof authorizeRepairFixture>>,authorization:string,root:string){const observations=[];for(const ref of owner.a.sourceRequests(authorization))observations.push(await readOwnerSource(owner.profile,ref.proposalSha256,ref.commentId,join(root,'fresh-owner-'+randomUUID())));return observations;}

export async function observedSnapshot(path:string,c:any){const at=new Date().toISOString(),s=await Snapshot.create(path,c.repository,c.pr,[],[]);s.manifest.candidate={...c,mergeBase:c.B,observedAt:at};await s.artifact(raw({explicitFixture:true,candidate:c,actualGitHubPublication:false}),{kind:'pr',round:1,retrievedAt:at,provenance:'explicit-local-fixture',status:200});s.manifest.rounds.push({number:1,startedAt:at,finishedAt:at,coverage:{},sources:[],notes:[],gaps:[],limitations:['explicit_fixture_not_a_real_PR_observation'],current:true});await s.save();await s.close();return {path,sha256:hash(await readFile(join(path,'manifest.json')))};}

export async function governedRecompositionFixture(t:test.TestContext,options:{delegated?:boolean;providerMode?:string}={}){
  const hooks:Array<()=>unknown>=[],owned={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext,f=await memberRepairFixture(owned),ledger=await ledgerFixture(owned,options.providerMode);
  t.after(async()=>{f.q.close();if(process.env.TONGXU_RECOMPOSITION_TEST_EVIDENCE){const root=process.env.TONGXU_RECOMPOSITION_TEST_EVIDENCE;await mkdir(root,{recursive:true});for(const source of [f.root,ledger.root])await cp(source,join(root,basename(source)),{recursive:true});}for(const fn of hooks.reverse())try{await fn();}catch{}});
  const db=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));db.prepare('UPDATE capacity SET n=3').run();db.close();
  const owner=await authorizeRepairFixture({...f,operation:f.memberOperation,plan:{...f.plan,item:f.member.item},H:f.A},ledger.profile);
  await writeFile(f.planPath,raw({...f.p,governance:{authorityIntent:owner.intent,resourceRequests:[owner.resourceId]}}));let repair:any;
  try{repair=await runQueueRepair(f.planPath);}catch(e){if(options.providerMode!=='lost-after-claim')throw e;repair=await runQueueRepair(f.planPath);}
  if(options.providerMode==='lost-after-result')await runQueueRepair(f.planPath);
  const newMember=await observedSnapshot(join(f.root,'repaired-member-observation'),{repository:'fixture/reception',pr:10,H:repair.after.H,B:f.B,targetRef:'fixture'}),plan:MemberRecompositionPlan={schemaVersion:1,kind:'tongxu-member-recomposition',id:'governed-repaired-units',store:f.store,memberReturn:f.memberReturn,repairPlan:{path:f.planPath,sha256:hash(await readFile(f.planPath))},newMember,testPlan:{path:join(f.root,'units-test.json'),sha256:hash(await readFile(join(f.root,'units-test.json')))},source:'Explicit local Owner and ledger fixtures; actual isolated Git/Docker, scripted role processes; no real remote publication',governance:{testAuthorityIntent:'exact-recomposition-test',testResourceRequests:[],integrationAuthorityIntent:'new-composition-integration'}};
  const request={...owner.request,action:'test' as const,paths:[],payloadSha256:recompositionTestPayloadSha(plan)},confirmation=await owner.adopt({kind:'confirm_action',adoption:owner.scope.sha,performerRole:'background',request,expiresAt:new Date(Date.now()+3600000).toISOString()}),observations=await freshOwner(owner,confirmation.sha,f.root),action=owner.a.reserveAction(plan.governance!.testAuthorityIntent,request,'background',confirmation.sha,observations),resource={...owner.resource,authorityIntent:plan.governance!.testAuthorityIntent,role:'background' as const,actionSha256:action.requestSha256},prepared=await prepareResourceRequest(f.store,raw(resource),'background');plan.governance!.testResourceRequests=[prepared.id];
  if(options.delegated!==false){const delegation=await owner.adopt({kind:'delegate',adoption:owner.scope.sha,roles:['background'],targets:['fixture'],actions:['test'],paths:[],resourceRefs:[],expiresAt:new Date(Date.now()+3600000).toISOString()});plan.governance!.integrationDelegation={authorization:delegation.sha,adoption:owner.scope.sha};}
  const path=join(f.root,'governed-recomposition.json');await writeFile(path,raw(plan));return {...f,ledger,owner,repair,newMember,recompositionPlan:plan,recompositionPath:path,testRequest:request,testConfirmation:confirmation,testResource:prepared.id,testObservations:observations};
}
