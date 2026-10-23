import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitored } from './backend-fixture.js';
import { sourceTick } from '../../src/event-tick.js';
import { QueueStore } from '../../src/queue-store.js';
import { canonical } from '../../src/comparison.js';
import { hash } from '../../src/snapshot.js';
import { fixtureOwnerObservation } from '../../src/authority-source.js';
import { ownerDecisionText,scopeBodyHash,parseActionRequest,type AuthorityProfile,type ActionRequest } from '../../src/authority-contract.js';
const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));

async function prepared(t:test.TestContext){const f=await monitored(t);await sourceTick(f.store);return f;}
async function preferences(t:test.TestContext){
  const f=await prepared(t);f.q.reviewRecords().enable();f.q.enableCompositions();f.q.enableReceiverCorrections();
  const profile:AuthorityProfile={schemaVersion:1,kind:'tongxu-owner-source-profile',repository:'fixture/reception',issue:7,ownerId:101,executorId:202,ghExecutable:'/fixture/gh',ghSha256:'a'.repeat(64),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000};
  const authority=f.q.authority();authority.configure(bytes(profile));let serial=1;
  const apply=(proposal:unknown)=>{
    const p=authority.prepare('fixture-proposal-'+serial,bytes(proposal)),id=6300000000+serial++,at=new Date().toISOString(),body=ownerDecisionText(p.proposalSha256),nodeId='IC_fixture_'+id,url=`https://github.com/fixture/reception/issues/7#issuecomment-${id}`;
    const comment={id,node_id:nodeId,body,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/7',html_url:url};
    const graph={data:{viewer:{id:'U_executor',databaseId:202},node:{__typename:'IssueComment',id:nodeId,fullDatabaseId:String(id),body,createdAt:at,updatedAt:at,lastEditedAt:null,url,author:{__typename:'User',databaseId:101},editor:null,issue:{number:7,repository:{nameWithOwner:'fixture/reception'}}}}};
    const obs=fixtureOwnerObservation(profile,p.proposalSha256,id,bytes(graph),bytes(comment),at);authority.apply(p.proposalSha256,obs);return {sha:p.proposalSha256,obs};
  };
  const body={goals:['Fixture scheduling'],nonGoals:['No model or production execution'],preserve:['Keep original queue'],acceptance:['Bound exact preference'],constraints:['No implicit permissions']};
  const scope=apply({kind:'adopt_scope',scopeId:'scope',scopeVersion:'S1',body,previousAdoption:null});
  const reserve=(item:string,priority=0,mainIncident=false)=>{
    const selected=f.q.status().items.find((i:any)=>i.id===item),preference={schemaVersion:1,kind:'queue_preference',item,priority,mainIncident,reason:'Explicit fixture Owner preference; not technical proof.'};
    const request:ActionRequest={schemaVersion:1,scopeId:'scope',scopeVersion:'S1',scopeBodySha256:scopeBodyHash(body),repository:'fixture/reception',target:selected.candidate.targetRef,action:'coordinate',item,candidate:{H:selected.candidate.H,B:selected.candidate.B,subjectSha256:null},paths:[],resourceRefs:[],payloadSha256:hash(canonical(preference))};
    const confirmation=apply({kind:'confirm_action',adoption:scope.sha,performerRole:'coordinator',request,expiresAt:new Date(Date.now()+3600000).toISOString()}),observations=[confirmation.obs,scope.obs],intent='fixture-preference-'+serial;
    authority.reserveAction(intent,request,'coordinator',confirmation.sha,observations);return {preference,observations,intent,request,confirmation};
  };
  const prefer=(item:string,priority=0,mainIncident=false)=>{const r=reserve(item,priority,mainIncident);f.q.events().applyPreference(r.intent,bytes(r.preference),r.observations);return r;};
  return {...f,reserve,prefer,apply,authority};
}
test('bounded tick evaluates once, then keeps an explicit receiver pending action without launching a role',async t=>{
  const f=await prepared(t),first=await sourceTick(f.store,true);assert.equal(first.localEvaluation!.result!.status,'evaluated');assert.equal(first.ranking.selected,null);assert.equal(first.ranking.items[0]!.stage,'receive');assert.ok(first.ranking.items[0]!.waiting.includes('bound_role_consumer_required:receive'));
  const events=f.q.status().events.length,operations=f.q.status().operations.length;assert.equal((await sourceTick(f.store,true)).localEvaluation!.selection.selected,null);assert.equal(f.q.status().operations.length,operations);assert.equal(await f.count(),0);assert.ok(f.q.status().events.length>=events);
});
test('two actual CLI selectors and restart refer to one original operation; reading rank never consumes a fairness turn',async t=>{
  const f=await prepared(t),cli=fileURLToPath(new URL('../../src/event-cli.js',import.meta.url));const child=()=>new Promise<any>((resolve,reject)=>{const p=spawn(process.execPath,[cli,'select','--store',f.store,'--run','same-entry'],{stdio:['ignore','pipe','pipe']});let out='',error='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>error+=b);p.once('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(error)));});
  const a=await Promise.all([child(),child()]);assert.equal(a[0].operation,a[1].operation);assert.equal(f.q.status().claims.length,1);assert.equal(f.q.status().operations.length,1);
  const count=()=>f.q.status().events.filter((e:any)=>e.kind==='queue_ranked_evaluation_started').length;const n=count();f.q.scheduling();f.q.scheduling();assert.equal(count(),n);
  const reopened=await QueueStore.open(f.store);try{assert.equal(reopened.selectEvaluation('same-entry').operation,a[0].operation);assert.equal(reopened.selectEvaluation('different-entry').operation,a[0].operation);reopened.evaluate(a[0].operation);assert.equal(reopened.selectEvaluation('same-entry').operation,a[0].operation);assert.equal(reopened.selectEvaluation('after-completion').selected,null);}finally{reopened.close();}
});
test('Owner preference requires the original exact payload and fresh source, then records only a local scheduling effect',async t=>{
  const f=await preferences(t),p=f.reserve(f.item,2,true);
  assert.throws(()=>f.q.events().applyPreference(p.intent,bytes({...p.preference,priority:-2}),p.observations),/exact_authority_binding/);
  assert.throws(()=>f.q.events().applyPreference(p.intent,bytes(p.preference),[]),/fresh_provider|reobservation|source/);
  const applied=f.q.events().applyPreference(p.intent,bytes(p.preference),p.observations);assert.equal(applied.effect,'local_queue_preference_applied');assert.equal(applied.executionPermissionGranted,false);assert.equal(applied.technicalIncidentVerified,false);
  const n=f.q.status().events.length;assert.equal(f.q.events().applyPreference(p.intent,bytes(p.preference),[]).duplicate,true);assert.equal(f.q.status().events.length,n);
  const selected=f.q.scheduling().selected!;assert.equal(selected.classification,'adopted_main_incident');assert.equal(selected.priority,2);assert.equal(await f.count(),0);
  assert.throws(()=>parseActionRequest({...p.request,action:'merge'}),/payload_invalid/);
});
test('pending prerequisite may receive coordination preference; actual selection promotes its exact upstream and never claims the blocked child',async t=>{
  const f=await preferences(t),upstream=f.item,child=await f.packet({pr:2,requires:[{item:upstream,type:'merge',version:f.H,blocks:'shadow_review',source:'fixture exact dependency',canContinue:'coordinate priority'}]});
  f.prefer(child.item,2,true);const rank=f.q.scheduling();assert.equal(rank.selected?.item,upstream);assert.ok(rank.selected?.reasons.some(x=>x.startsWith('necessary_upstream_for:')));assert.equal(rank.items.find(x=>x.item===child.item)?.selectable,false);
  const started=f.q.selectEvaluation('upstream-first');assert.equal(started.item,upstream);assert.equal(f.q.status().claims.length,1);f.q.evaluate(started.operation);
  assert.equal(f.q.selectEvaluation('child-still-needs-real-merge').selected,null);assert.equal(f.q.status().claims.length,0);assert.ok(f.q.scheduling().items.find(x=>x.item===child.item)!.waiting.some(x=>x.startsWith('external_dependency_unverified:')));assert.equal(await f.count(),0);
});
test('three actual urgent starts give the oldest ordinary item one turn, while Stop and active claims stay authoritative',async t=>{
  const f=await preferences(t),ids=[];for(let pr=2;pr<=5;pr++)ids.push((await f.packet({pr})).item);for(const id of ids)f.prefer(id,2,true);
  const db=new DatabaseSync(join(f.store,'queue.sqlite'));db.prepare('UPDATE items SET created_at=? WHERE id=?').run(new Date(Date.now()-3600000).toISOString(),f.item);db.close();
  for(let n=0;n<3;n++){const s=f.q.selectEvaluation('urgent-'+n);assert.ok(ids.includes(s.item));assert.equal(s.history.class,'urgent');assert.equal(f.q.selectEvaluation('same-active-'+n).operation,s.operation);f.q.evaluate(s.operation);}
  const turn=f.q.scheduling();assert.equal(turn.selected?.item,f.item);assert.equal(turn.selected?.fairnessTurn,true);
  f.q.control('scope','investment','stopped','fixture-local-stop');assert.equal(f.q.selectEvaluation('stopped').selected,null);f.q.control('scope','investment','open','fixture-local-resume');
  const selected=f.q.selectEvaluation('fairness-turn');assert.equal(selected.item,f.item);assert.equal(selected.history.class,'ordinary');assert.equal(await f.count(),0);
});
