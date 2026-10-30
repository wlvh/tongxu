import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {withAIPreferences,currentAIPreferences,currentAIChoice,captureRoleAI,parseAIPreferences,type AIPreferenceSnapshot} from '../../src/ai-settings.js';
import {ReturnControls} from '../../src/return-controls.js';
import {returnWorkWorker} from '../../src/return-work-worker.js';
import {workbenchMessageReport} from '../../src/workbench.js';
import {messageFixture} from '../w6/message-fixture.js';
import {runMessages} from '../../src/messages.js';
import {assembleRolePrompt,inspectRolePrompt,type PromptRole} from '../../src/role-prompts.js';

const scope={account:{id:7},repository:{id:1,nodeId:'R_1',fullName:'fixture/reception'}};
const selection=(model='fixture-astra'):AIPreferenceSnapshot=>({revision:2,scope,roles:{verifier_fact:{tool:'codex',executable:process.execPath,model,effort:'max',resolvedModel:null,settingsRevision:2,role:'verifier_fact',project:{account:7,repository:1,nodeId:'R_1'},catalogObservedAt:new Date().toISOString()}},errors:{}});
test('all nine role prompts include the complete delivered policy and do not require a phantom runtime-contract file read',async()=>{
  for(const role of ['secretary','issue_owner','implementer','reviewer','verifier_fact','verifier_impact','receiver','external_report','acceptance'] as PromptRole[]){
    const prompt=await assembleRolePrompt(role,'Explicit scoped test: supplied material only, no tools.');inspectRolePrompt(prompt,role);
    assert.ok(prompt.system.includes('全文已由运行器放入系统提示'));
    assert.ok(!prompt.system.includes('先读runtime_contract.md')&&!prompt.system.includes('先加载runtime_contract.md'));
    assert.equal(prompt.parts.at(-1)!.kind,'task_policy');assert.equal(prompt.parts.filter(p=>p.kind==='role').length,1);
  }
});
test('the secretary and page share the full collaboration reader: exact original report, wrong task rejected, no new input',async t=>{
  const f=await messageFixture(t),result=await runMessages(f.store,f.path);assert.equal(result.completed,true);
  const plan:any={sources:[{id:'selected',store:f.store,item:f.item}]},trace=await readFile(f.trace),report=await workbenchMessageReport(plan,'selected',result.run,'synthesis');
  assert.equal(report.completeCapture,true);assert.equal(report.consumptionConfirmed,true);assert.ok(report.reportText.includes('明确标记的进程夹具'));
  await assert.rejects(workbenchMessageReport(plan,'foreign',result.run,'synthesis'),/report_not_found/);
  await assert.rejects(workbenchMessageReport({sources:[{id:'selected',store:f.store,item:'0'.repeat(64)}]} as any,'selected',result.run,'synthesis'));
  assert.deepEqual(await readFile(f.trace),trace);
});
test('RETURN owns a frozen preference snapshot across a real child process; caller edits cannot rebind it',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-return-ai-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const worker=fileURLToPath(new URL('../../src/return-work-worker.js',import.meta.url)),plan={path:join(root,'plan.json'),sha256:'a'.repeat(64)},invocation=join(root,'input.json'),snapshot=selection();
  await withAIPreferences(snapshot,()=>{const copy=currentAIPreferences()!;snapshot.roles.verifier_fact!.model='changed-after-capture';return writeFile(invocation,canonical({kind:'fixed-original-return-invocation',action:'start',plan,operation:'original-operation',item:'b'.repeat(64),workerSha256:'pending',originalQueueIsAuthoritative:true,aiPreferences:copy}));});
  // Wait for the explicit frozen test record; its worker bytes bind the actual imported worker.
  const input=JSON.parse(await readFile(invocation,'utf8'));input.workerSha256=hash(await readFile(worker));await writeFile(invocation,canonical(input));const invocationSha=hash(await readFile(invocation));
  const script=join(root,'child.mjs'),output=join(root,'observed.json');await writeFile(script,`import {returnWorkWorker} from ${JSON.stringify(new URL('../../src/return-work-worker.js',import.meta.url).href)};import {captureRoleAI} from ${JSON.stringify(new URL('../../src/ai-settings.js',import.meta.url).href)};import fs from 'node:fs/promises';await returnWorkWorker(${JSON.stringify(['start',plan.path,plan.sha256,invocation,invocationSha])},{repair:async()=>{await fs.writeFile(${JSON.stringify(output)},JSON.stringify(captureRoleAI(['verifier_fact'],'fixture/reception')));},refutation:async()=>{throw Error('unexpected')},close:async()=>{throw Error('unexpected')}});`);
  const child=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const exit=await new Promise<number|null>(resolve=>child.once('close',resolve));assert.equal(exit,0,stderr);assert.equal(JSON.parse(await readFile(output,'utf8')).verifier_fact.model,'fixture-astra');
  assert.equal(currentAIChoice('verifier_fact'),undefined);
  await writeFile(invocation,canonical({...input,aiPreferences:selection('tampered')}));let called=0;
  await assert.rejects(returnWorkWorker(['start',plan.path,plan.sha256,invocation,invocationSha],{repair:async()=>{called++;return {};},refutation:async()=>{throw Error('unexpected')},close:async()=>{throw Error('unexpected')}}),/preferences_changed/);assert.equal(called,0);
  const wrong=selection();wrong.roles.verifier_fact!.project.repository=2;assert.throws(()=>parseAIPreferences(wrong),/preferences_invalid/);
  withAIPreferences(selection(),()=>assert.throws(()=>captureRoleAI(['verifier_fact'],'fixture/foreign'),/outside_project/));
});
test('the actual RETURN launcher includes selected preferences in its captured invocation instead of losing them at spawn',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-return-launch-ai-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'invalid-plan.json');await writeFile(path,'{}');const controls=new (ReturnControls as any)([],[]);
  await assert.rejects(withAIPreferences(selection(),()=>controls.invoke({source:{store:root,item:'b'.repeat(64)},plan:{operation:'recorded-operation'}},'start',{path,sha256:hash(Buffer.from('{}'))})));
  const {readdir}=await import('node:fs/promises');const directory=join(root,(await readdir(root)).find(p=>p.startsWith('return-work-'))!);const input=JSON.parse(await readFile(join(directory,'input.json'),'utf8')),launch=JSON.parse(await readFile(join(directory,'launch.json'),'utf8'));
  assert.equal(input.aiPreferences.roles.verifier_fact.model,'fixture-astra');assert.ok(launch.args.includes(join(directory,'input.json')));assert.ok(launch.args.includes(hash(await readFile(join(directory,'input.json')))));
  // Deliberately invalid queue plan: original controller rejects it, no model executes.
  assert.equal(JSON.parse(await readFile(join(directory,'exit.json'),'utf8')).code,1);
});
