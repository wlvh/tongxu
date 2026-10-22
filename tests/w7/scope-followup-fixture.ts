import type test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {controlFixture} from './task-controls-fixture.js';
import {nativeControlFixture,until} from './native-control-fixture.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {prepareTaskOwner} from '../../src/tasks.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {ownerDecisionText} from '../../src/authority-contract.js';

export async function scopeFollowupFixture(t:test.TestContext,dirty=false,native=false,originalUnsent=false){
 const f=native?await nativeControlFixture(t):await controlFixture(t);let controls=f.controls;
 if(dirty){const path=join(f.definition.workspace,'sample.js');await writeFile(path,'export const value = 3;\n');execFileSync('/usr/bin/git',['-C',f.definition.workspace,'add','sample.js']);await writeFile(path,'export const value = 4;\n');f.q.tasks().observe(f.definition,await observeTaskWorkspace(f.definition));const c=f.q.tasks().current(f.task);f.catalog.contacts[0]!.packet=c.packet;f.catalog.contacts[0]!.sourceSha256=c.fingerprint;controls=await f.load();t.after(()=>controls.drain());}
 if(originalUnsent){f.q.taskInbox().enqueue(Buffer.from(canonical(f.request)));await prepareTaskOwner(f.store,f.task,f.request.id);f.q.taskInbox().cancelUnsent(f.task,f.request.id,'explicit original zero-input fixture');}else{const running=controls.execute('contact');if(native){const live=await until(()=>controls.state(),rows=>Boolean((rows[0] as any).nativeControl?.currentTurnActive)),n=(live[0] as any).nativeControl;await controls.controlNative('contact',{option:'check-counterexample',threadId:n.threadId,sessionId:n.sessionId,turnId:n.turnId});}const original=await running;assert.equal((original.execution as any).completed,true);}
 const selected=await prepareTaskOwner(f.store,f.task,f.request.id),plan=JSON.parse(await readFile(selected.plan,'utf8')),authorityPath=join(f.root,'unused-authority-template.json');
 const a=await messageAuthority({...f,item:f.task,plan,path:authorityPath,write:async()=>writeFile(authorityPath,canonical(plan))} as any),oldScope=a.a.proposal(a.scope.sha).proposal as any,nextScope=await a.adopt({...oldScope,scopeVersion:'S2',previousAdoption:a.scope.sha,body:{...oldScope.body,goals:['按新目标重新核对固定模块契约'],constraints:['已有订阅；没有业务写入或合入']}}),current=f.q.tasks().current(f.task);
 const request={schemaVersion:1,kind:'tongxu-task-scope-followup',task:f.task,adoption:nextScope.sha,expectedPacket:current.packet,expectedSourceSha256:current.fingerprint,goal:'按已采用的新目标，核对原模块与完整先前报告，说明可以继续什么。',acceptance:['说明固定代码与原报告的具体依据；不把读取当写入或验收。']};
 async function originalDecision(sha:string){const id=7700000000+Object.keys(a.records).length,at=new Date().toISOString(),node='IC_scope_fixture_'+id,url='https://github.com/fixture/reception/issues/8#issuecomment-'+id,text=ownerDecisionText(sha),comment={id,node_id:node,body:text,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/8',html_url:url},graph={data:{viewer:{databaseId:202},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body:text,createdAt:at,updatedAt:at,url,issue:{number:8,repository:{nameWithOwner:'fixture/reception'}}}}};a.records[id]={comment,graph};await writeFile(a.sourcePath,canonical(a.records));return url;}
 return {...f,a,nextScope,request,previousRequest:f.request,originalDecision,originalControls:controls};
}
