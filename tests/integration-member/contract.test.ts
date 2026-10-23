import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIntegrationMemberReturn,integrationMemberReturnSha256} from '../../src/integration-member-contract.js';
const original={schemaVersion:1,kind:'tongxu-integration-member-return',id:'specific-member-return',integration:'fixed-units-integration',reception:{operation:'00000000-0000-4000-8000-000000000001',packet:4,bindingHash:'a'.repeat(64),judgmentId:'00000000-0000-4000-8000-000000000002',inputSha256:'b'.repeat(64),finalSha256:'c'.repeat(64)},member:{index:0,H:'a'.repeat(40),B:'b'.repeat(40),manifestSha256:'d'.repeat(64),item:'e'.repeat(64),packet:2,fingerprint:'f'.repeat(64)},scopeSha256:'1'.repeat(64),arrangementSha256:'2'.repeat(64),findingIndexes:[0,2],source:'explicit bounded selection from the original integration return'};
const raw=(x:unknown)=>Buffer.from(JSON.stringify(x));
test('member return binds the exact parent final, selected member and findings, without implying acceptance or permission',()=>{
  const p=parseIntegrationMemberReturn(raw(original)),sha=integrationMemberReturnSha256(p);assert.deepEqual(p,original);
  for(const x of [{...original,reception:{...original.reception,finalSha256:'9'.repeat(64)}},{...original,member:{...original.member,H:'c'.repeat(40)}},{...original,member:{...original.member,index:1}},{...original,findingIndexes:[1]},{...original,scopeSha256:'3'.repeat(64)}])assert.notEqual(integrationMemberReturnSha256(parseIntegrationMemberReturn(raw(x))),sha);
});
test('a report cannot smuggle execution or select ambiguous original findings',()=>{
  for(const x of [{...original,allowedPaths:['anywhere']},{...original,command:['/bin/sh']},{...original,authorityIntent:'invented'},{...original,member:{...original.member,accepted:true}},{...original,reception:{...original.reception,verdict:'PASS'}},{...original,member:{...original.member,index:8}},{...original,findingIndexes:[]},{...original,findingIndexes:[0,0]},{...original,findingIndexes:[2,0]},{...original,findingIndexes:[30]}])assert.throws(()=>parseIntegrationMemberReturn(raw(x)));
});
