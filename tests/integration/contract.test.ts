import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIntegrationRequest,integrationRequestSha256} from '../../src/integration-contract.js';

const request={schemaVersion:1,kind:'tongxu-minimal-integration',id:'selected-two-members',operation:'12345678-1234-1234-1234-123456789abc',subjectSha256:'a'.repeat(64),scopeSha256:'b'.repeat(64),arrangementSha256:'c'.repeat(64),objects:'/private/tmp/explicit-local-source',selectionReason:'The two fixed members must be validated as one candidate; earlier failures remain original evidence.',source:'explicit trusted fixture selection, not a model instruction',authorityIntent:null};
const raw=(p:unknown)=>Buffer.from(JSON.stringify(p));
test('the fixed selection binds original operation, subject, scope and arrangement without gaining execution permissions',()=>{
  const p=parseIntegrationRequest(raw(request)),sha=integrationRequestSha256(p);assert.equal(sha,integrationRequestSha256(parseIntegrationRequest(Buffer.from(JSON.stringify(request,null,2)))));
  for(const [key,value] of Object.entries({operation:'12345678-1234-1234-1234-123456789abd',subjectSha256:'d'.repeat(64),scopeSha256:'e'.repeat(64),arrangementSha256:'f'.repeat(64)}))assert.notEqual(integrationRequestSha256(parseIntegrationRequest(raw({...request,[key]:value}))),sha);
  assert.equal(p.authorityIntent,null);
});
test('report-supplied commands, output locations, permissions and ambiguous source paths are refused',()=>{
  for(const extra of [{argv:['git','push']},{outputDirectory:'/private/tmp/replace-something'},{mergeApproved:true},{newRole:'administrator'}])assert.throws(()=>parseIntegrationRequest(raw({...request,...extra})),/integration_request_invalid/);
  for(const objects of ['relative','/private/tmp/../source','/private/tmp/source/'])assert.throws(()=>parseIntegrationRequest(raw({...request,objects})),/integration_request_invalid/);
  assert.throws(()=>parseIntegrationRequest(Buffer.from([0xff])),/integration_request_invalid/);assert.throws(()=>parseIntegrationRequest(raw({...request,selectionReason:'x'.repeat(8193)})),/integration_request_invalid/);
});
