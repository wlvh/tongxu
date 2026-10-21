import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,mkdir,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {memberInputFixture} from './repair-fixture.js';
import {authorizeRepairFixture} from '../review-records/repair-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {freshOwner} from './governed-recomposition-fixture.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {runMemberRefutation} from '../../src/member-refutation.js';
import {hash} from '../../src/snapshot.js';
import {raw} from '../integration/fixture.js';
import type {MemberRefutationPlan} from '../../src/member-refutation-contract.js';
import {QueueStore} from '../../src/queue-store.js';

async function fixture(t:test.TestContext,delegated=true,mode='normal'){
  const hooks:Array<()=>unknown>=[],owned={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext,f=await (await memberInputFixture(owned,'project-refuted',false)).prepareRepair(),ledger=await ledgerFixture(owned,mode);
  t.after(async()=>{f.q.close();if(process.env.TONGXU_REFUTATION_AUTHORITY_EVIDENCE){const root=process.env.TONGXU_REFUTATION_AUTHORITY_EVIDENCE;await mkdir(root,{recursive:true});for(const source of [f.root,ledger.root])await cp(source,join(root,basename(source)),{recursive:true});}for(const fn of hooks.reverse())try{await fn();}catch{}});
  const db=new DatabaseSync(join(ledger.root,'original-fixture.sqlite'));db.prepare('UPDATE capacity SET n=2').run();db.close();const owner=await authorizeRepairFixture({...f,operation:f.memberOperation,plan:{...f.plan,item:f.member.item},H:f.A},ledger.profile);
  await writeFile(f.planPath,raw({...f.p,governance:{authorityIntent:owner.intent,resourceRequests:[owner.resourceId]}}));let repair:any;try{repair=await runQueueRepair(f.planPath);}catch(e){if(mode!=='lost-after-claim')throw e;repair=await runQueueRepair(f.planPath);}if(mode==='lost-after-result')await runQueueRepair(f.planPath);assert.equal(repair.repairStatus,'skipped_refuted');
  const budget={ledgerId:ledger.profile.ledgerId,resourceRef:ledger.profile.resources[0]!.ref,unit:ledger.profile.resources[0]!.unit,quantity:1},g={authorityIntent:'refutation-new-receive',adoption:owner.scope.sha,resourceBudget:[budget]} as NonNullable<MemberRefutationPlan['governance']>;
  if(delegated){const decision=await owner.adopt({kind:'delegate',adoption:owner.scope.sha,roles:['receiver'],targets:['fixture'],actions:['receive'],paths:[],resourceRefs:[budget.resourceRef],expiresAt:new Date(Date.now()+3600000).toISOString()});g.delegation=decision.sha;}
  const p:MemberRefutationPlan={schemaVersion:1,kind:'tongxu-member-refutation-reception',id:'governed-unchanged-refutation',store:f.store,memberReturn:f.memberReturn,repairPlan:{path:f.planPath,sha256:hash(await readFile(f.planPath))},receiverPlan:{path:f.receiverPath,sha256:hash(await readFile(f.receiverPath))},source:'Explicit local Owner/provider/role fixtures, actual isolated Git/Docker refutation; no remote publication',governance:g},path=join(f.root,'governed-refutation.json');await writeFile(path,raw(p));await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="complete"'));return {...f,owner,ledger,repair,refutationPlan:p,refutationPath:path};
}

test('governed refutation prepares a separate exact receive action, original resources and new reception once',async t=>{
  const f=await fixture(t),count=await f.count(),trace=await readFile(f.model.trace),parent=f.q.receiverState(f.parent.operation).receiver.judgment,template=await readFile(f.receiverPath),prepared=await runMemberRefutation(f.refutationPath,'prepare');assert.equal('phase' in prepared&&prepared.phase,'prepared_not_sent');assert.equal(await f.count(),count);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.ledger.state().settlements.length,1);assert.ok((await readFile(f.receiverPath)).equals(template));
  const record=JSON.parse(await readFile(join(prepared.directory,'receiver-preparation.json'),'utf8'));assert.notEqual(record.packet,f.original.result.packet);assert.notEqual(record.operation,f.parent.operation);const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(result.reception.receiver.memberRefutationSha256,result.proofSha256);assert.equal(result.reception.receiver.authorityIntent,f.refutationPlan.governance!.authorityIntent);assert.equal(await f.count(),count+1);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);assert.deepEqual(f.q.receiverState(f.parent.operation).receiver.judgment,parent);assert.ok((await readFile(f.model.trace)).equals(trace));assert.equal(result.memberUnchanged,true);
  await f.owner.adopt({kind:'revoke',decision:f.refutationPlan.governance!.delegation});await rm(f.planPath);await rm(f.receiverPath);const again=await runMemberRefutation(f.refutationPath);assert.ok('reception' in again);assert.equal(again.reception.operation,result.reception.operation);assert.equal(await f.count(),count+1);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);
});

test('without delegation a refutation waits for its exact new action, then uses the same preparation after confirmation',async t=>{
  const f=await fixture(t,false),count=await f.count(),pending=await runMemberRefutation(f.refutationPath);assert.equal('phase' in pending&&pending.phase,'refutation_receiver_authority_pending');assert.equal(await f.count(),count);assert.equal(f.ledger.state().claims.length,1);
  const value=JSON.parse(await readFile(join(pending.directory,'receiver-authorization-pending.json'),'utf8'));assert.notEqual(value.packet,f.original.result.packet);assert.equal(value.request.candidate.H,f.candidate.H);const decision=await f.owner.adopt({kind:'confirm_action',adoption:f.owner.scope.sha,performerRole:'receiver',request:value.request,expiresAt:new Date(Date.now()+3600000).toISOString()});f.owner.a.reserveAction(value.intent,value.request,'receiver',decision.sha,await freshOwner(f.owner,decision.sha,f.root));const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(await f.count(),count+1);assert.equal(f.ledger.state().claims.length,2);
});

for(const mode of ['lost-after-claim','lost-after-result'])test('governed refutation keeps original claim and reception through '+mode,async t=>{
  const f=await fixture(t,true,mode),count=await f.count();
  if(mode==='lost-after-claim'){await assert.rejects(runMemberRefutation(f.refutationPath));assert.equal(await f.count(),count);}
  else{const first=await runMemberRefutation(f.refutationPath);assert.ok('reception' in first);assert.equal(first.reception.receiver.phase,'returned');assert.equal(first.reception.resources[0].state,'result_pending_or_unknown');assert.equal(await f.count(),count+1);}
  const result=await runMemberRefutation(f.refutationPath);assert.ok('reception' in result);assert.equal(result.reception.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(result.reception.resources[0].state,'consumed');assert.equal(await f.count(),count+1);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);await runMemberRefutation(f.refutationPath);assert.equal(await f.count(),count+1);
});

test('revoked future receive grant and changed member cannot turn refutation into a new input',async t=>{
  const f=await fixture(t),count=await f.count();await runMemberRefutation(f.refutationPath,'prepare');await f.owner.adopt({kind:'revoke',decision:f.refutationPlan.governance!.delegation});await assert.rejects(runMemberRefutation(f.refutationPath),/owner_decision_revoked/);assert.equal(await f.count(),count);assert.equal(f.ledger.state().claims.length,1);
  await f.addPacket({pr:10,H:f.A3,sourceAt:new Date(Date.now()+60000).toISOString()});await assert.rejects(runMemberRefutation(f.refutationPath),/source_no_longer_current/);assert.equal(await f.count(),count);assert.equal(f.q.memberRefutation(f.refutationPlan.id).current,false);
});

test('same head and action do not let an old packet receive reservation authorize the new refutation packet',async t=>{
  const f=await fixture(t,false),count=await f.count(),request={...f.owner.request,action:'receive' as const,item:f.candidateItem,candidate:{H:f.candidate.H,B:f.B,subjectSha256:null},paths:[]},confirmation=await f.owner.adopt({kind:'confirm_action',adoption:f.owner.scope.sha,performerRole:'receiver',request,expiresAt:new Date(Date.now()+3600000).toISOString()});f.owner.a.reserveAction(f.refutationPlan.governance!.authorityIntent,request,'receiver',confirmation.sha,await freshOwner(f.owner,confirmation.sha,f.root));
  await assert.rejects(runMemberRefutation(f.refutationPath),/refutation_receiver_exact_authority_required/);assert.equal(await f.count(),count);assert.equal(f.ledger.state().claims.length,1);assert.equal(f.q.memberRefutation(f.refutationPlan.id).reception,null);
});

test('last-effect stop preserves the original unstarted receiver and never dispatches a replacement',async t=>{
  const f=await fixture(t),count=await f.count(),effect=QueueStore.prototype.receiverEffect;let stopped=false;QueueStore.prototype.receiverEffect=function(id,binding,observations,call){stopped=true;f.q.control(f.context.scope.id,'investment','stopped','Explicit stop at the actual refutation receiver effect');return (effect as any).call(this,id,binding,observations,call);};t.after(()=>{QueueStore.prototype.receiverEffect=effect;});
  const first=await runMemberRefutation(f.refutationPath);assert.ok('reception' in first);assert.equal(stopped,true);assert.equal(first.reception.status,'receiver_unknown');assert.equal(first.reception.newTaskSent,false);assert.equal(await f.count(),count);assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,1);const again=await runMemberRefutation(f.refutationPath);assert.ok('reception' in again);assert.equal(again.reception.operation,first.reception.operation);assert.equal(await f.count(),count);
});
