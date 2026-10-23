import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../../src/snapshot.js';
import {verifyObservedHelperTransports} from '../../src/workspace-handoff-originals.js';

function records(){
  const parent={pid:123,sha256:'a'.repeat(64),threadId:'fixture-thread',turnIds:['fixture-turn']},helper=456;
  const params={threadId:parent.threadId,turnId:parent.turnIds[0],callId:'fixture-call',tool:'tongxu_read_file',arguments:{path:'src/code.mjs'}},call={id:'fixture-rpc',method:'item/tool/call',params},start={method:'item/started',params:{threadId:params.threadId,turnId:params.turnId,item:{id:params.callId,type:'dynamicToolCall',status:'inProgress',namespace:null,tool:params.tool,arguments:params.arguments}}};
  const transport={requestSha256:hash(JSON.stringify(call)),startSha256:hash(JSON.stringify(start)),callId:params.callId,threadId:params.threadId,turnId:params.turnId,transport:'owned-app-server-dynamic-rpc',appServerPid:parent.pid,appServerExecutableSha256:parent.sha256,observedHelperPids:[helper],helperObservation:'observed_official_children'},pair={request:call,response:{id:call.id,result:{contentItems:[]}}};
  return {parent,helper,call,start,transport,pair};
}
test('identical cached request retransmissions retain one original observed-helper association',()=>{
  const f=records();verifyObservedHelperTransports([f.transport],[f.start,f.call,structuredClone(f.call)],[f.pair],f.parent,f.helper);
});
test('conflicting retransmission, missing response, wrong parent and missing helper remain refused',()=>{
  const f=records(),events=[f.start,f.call];
  assert.throws(()=>verifyObservedHelperTransports([f.transport],[...events,{...f.call,params:{...f.call.params,arguments:{path:'outside.mjs'}}}],[f.pair],f.parent,f.helper),/transport_changed/);
  assert.throws(()=>verifyObservedHelperTransports([f.transport],events,[],f.parent,f.helper),/transport_changed/);
  assert.throws(()=>verifyObservedHelperTransports([f.transport],events,[f.pair],{...f.parent,pid:999},f.helper),/transport_changed/);
  assert.throws(()=>verifyObservedHelperTransports([f.transport],events,[f.pair],f.parent,999),/transport_missing/);
});
