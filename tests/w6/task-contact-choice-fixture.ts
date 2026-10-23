import type test from 'node:test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {messageFixture} from './message-fixture.js';
import {taskMain} from '../../src/task-cli.js';
import {parseDevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import type {TaskOwnerRequest} from '../../src/task-inbox.js';
import type {TaskContactChoice} from '../../src/task-contact-choice.js';

export async function taskChoiceFixture(t:test.TestContext,mode='contact'){
  const hooks:Array<()=>unknown>=[],f=await messageFixture({after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext);
  t.after(async()=>{if(process.env.TONGXU_CHOICE_EVIDENCE){const out=process.env.TONGXU_CHOICE_EVIDENCE;await mkdir(out,{recursive:true});await writeFile(join(out,basename(f.root)+'.json'),JSON.stringify({root:f.root,store:f.store,mode,officialModels:0,originalsPreservedInPlace:true},null,2)+'\n');f.q.close();}else for(const fn of hooks.reverse())await fn();});
  await taskMain(['enable','--store',f.store]);
  const original=f.q.status().items.find((i:any)=>i.id===f.item),definition=parseDevelopmentTask(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-development-task',id:'choice-a',repository:'fixture/reception',title:'原任务 A',goal:'调查选定材料，必要时请 B 核契约后综合',acceptance:['保留实际材料和完整独立意见'],source:'explicit local contact-choice fixture',issue:null,context:original.context,workspace:join(f.root,'objects'),base:original.candidate.B,target:original.candidate.targetRef,paths:['sample.js']})));
  const a=f.q.tasks().observe(definition,await observeTaskWorkspace(definition)),bd={...definition,id:'choice-b',title:'独立任务 B'},b=f.q.tasks().observe(bd,await observeTaskWorkspace(bd));
  const hashes:Record<string,string>={};
  for(const exe of [f.codex,f.claude]){let script=await readFile(exe,'utf8'),start=script.indexOf('const report=x=>'),end=script.indexOf('\n',start);
    const report=`const report=x=>JSON.stringify({messageId:x.messageId,consumed:x.replyReferences,report:x.messageId==='choose'&&${JSON.stringify(mode)}!=='none'?JSON.stringify({kind:'tongxu-task-contact-request',planSha256:${JSON.stringify(mode)}==='wrong-plan'?'0'.repeat(64):x.body.match(/"planSha256":"([a-f0-9]{64})"/)[1],contactId:${JSON.stringify(mode)}==='bad-option'?'unregistered':'contract',report:'明确夹具：实际任务需要独立契约意见，选择固定B，不授予新权限。'}):'明确进程夹具完整回复 '+x.messageId+'；消费了原材料与全部前序报告。'});`;
    script=script.slice(0,start)+report+script.slice(end);if(mode==='unknown-b'&&exe===f.claude)script=script.replace("if(mode==='partial')return;","if(true)return;");if(mode==='contact-delay'&&exe===f.codex)script=script.replace("if(mode==='delay')setTimeout(finish,300);else finish();","if(x.messageId==='choose')setTimeout(finish,300);else finish();");await writeFile(exe,script);hashes[exe]=hash(script);
  }
  const request=(id:string,task=a.item,tool:'codex'|'claude'='codex'):TaskOwnerRequest=>({schemaVersion:1,kind:'tongxu-task-owner-request',id,task,source:'explicit fixture fixed contact scope',question:'核对选定代码和实际前序报告，按范围判断，不授予写权。',from:null,participant:{...f.plan.participants[0]!,id:task===a.item?'owner-a':'owner-b',item:task,role:'issue_owner',parent:null,tool,executable:tool==='codex'?f.codex:f.claude,executableSha256:hashes[tool==='codex'?f.codex:f.claude]!},executionKind:'fixture',authorityIntent:null,billing:f.plan.billing,timeoutMs:700});
  const plan:TaskContactChoice={schemaVersion:1,kind:'tongxu-task-owner-choice',initial:request('choose'),contacts:[{id:'contract',title:'向原B核实契约',request:request('contract-check',b.item,'claude'),followup:request('synthesize')}]},path=join(f.root,'contact-choice.json');await writeFile(path,canonical(plan));
  return {...f,a,b,definition,plan,path,raw:Buffer.from(canonical(plan)),request};
}
