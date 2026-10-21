import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePublicationPlan,publicationAuthorityPayloadSha,type PublicationPlan} from '../../src/publication-contract.js';

const plan:PublicationPlan={schemaVersion:1,kind:'tongxu-reception-publication',store:'/private/tmp/publication-fixture',operation:'00000000-0000-4000-8000-000000000001',channel:'commit-status',ghExecutable:'/private/tmp/fixed-gh',ghSha256:'a'.repeat(64),repositoryId:71,actor:{id:72,login:'fixture'},source:'Explicit local fixture; no publication permission'};
const parse=(p:unknown)=>parsePublicationPlan(Buffer.from(JSON.stringify(p)));
test('publication permission fixes public material, executable, actor and original operation without circular reservation IDs',()=>{
  const fixed=publicationAuthorityPayloadSha(plan,'b'.repeat(64));
  for(const changed of [{...plan,operation:'00000000-0000-4000-8000-000000000002'},{...plan,actor:{id:73,login:'other'}},{...plan,repositoryId:72},{...plan,ghExecutable:'/private/tmp/other-gh'},{...plan,ghSha256:'c'.repeat(64)},{...plan,source:'another source'}])assert.notEqual(publicationAuthorityPayloadSha(changed,'b'.repeat(64)),fixed);
  assert.notEqual(publicationAuthorityPayloadSha(plan,'c'.repeat(64)),fixed);
  assert.equal(publicationAuthorityPayloadSha({...plan,governance:{authorityIntent:'fixed-intent',resourceRequests:['d'.repeat(64)]}},'b'.repeat(64)),fixed);
  assert.deepEqual(parse(plan),plan);assert.deepEqual(parse({...plan,governance:{authorityIntent:'fixed-intent',resourceRequests:[]}}).governance?.resourceRequests,[]);
});
test('publication plan rejects invented channels, executable paths and ambiguous authority/resource bindings',()=>{
  for(const changed of [{...plan,channel:'check-run'},{...plan,ghExecutable:'gh'},{...plan,store:'/private/tmp/../other'},{...plan,actor:{...plan.actor,approval:true}},{...plan,governance:null},{...plan,governance:{authorityIntent:'bad intent',resourceRequests:[]}},{...plan,governance:{authorityIntent:'fixed',resourceRequests:['a'.repeat(64),'a'.repeat(64)]}},{...plan,governance:{authorityIntent:'fixed',resourceRequests:[],allowAll:true}}])assert.throws(()=>parse(changed),/invalid_publication/);
});
