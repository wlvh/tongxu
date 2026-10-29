import {BoundedCodexSession} from '../../src/repair-native.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,unlink,mkdir,symlink,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secretaryFixture} from '../w4/secretary-fixture.js';
import {hash} from '../../src/snapshot.js';
import {startWorkbench} from '../../src/workbench.js';
import {SecretaryControls} from '../../src/secretary-controls.js';
import {closeUnstartedSecretary,selectSecretaryRuntime} from '../../src/secretary.js';
import {canonical} from '../../src/comparison.js';
import {save} from '../../src/live-process.js';

import {secretaryEntryFixture as fixture} from './secretary-entry-fixture.js';

async function waitFor(f:Awaited<ReturnType<typeof fixture>>,condition:(s:any)=>boolean){const until=Date.now()+12000;let state;while(Date.now()<until){state=await f.get();if(condition(state))return state;await new Promise(r=>setTimeout(r,20));}throw new Error('fixture_workbench_question_timeout:'+JSON.stringify(state));}

async function stableEntry(f:Awaited<ReturnType<typeof secretaryFixture>>){const entry=join(f.root,'current-codex');await symlink(f.p.codexExecutable,entry);f.p.codexExecutable=entry;await writeFile(f.secretaryPlan,JSON.stringify(f.p));}

test('interrupted web registration then CLI upgrade preserves the selected request, permits explicit closure and a new request',async t=>{
  const f=await fixture(t),requestId='interrupted-registration',question='原组合任务做成了什么，现在还需要处理什么？',directory=join(f.root,hash(requestId));
  const template=await readFile(f.secretaryPlan),plan=Buffer.from(canonical(await selectSecretaryRuntime({...f.p,question})));
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'template.json'),template);await writeFile(join(directory,'input-plan.json'),plan);
  const code=await readFile(f.p.codexExecutable,'utf8');await writeFile(f.p.codexExecutable,code.replaceAll('0.163.0-alpha.10.2','99.8.0'));
  assert.equal((await f.post('ask',{requestId,question})).status,202);
  let state=await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active),old=state.secretaries[0].questions[0];
  assert.equal(old.requestId,requestId);assert.equal(old.phase,'registered_not_sent');assert.equal(old.reason,'secretary_runtime_or_billing_changed');
  assert.ok(old.registrationRecoveredAt);
  assert.deepEqual(await readFile(join(directory,'input-plan.json')),plan);assert.deepEqual(await readFile(join(directory,'template.json')),template);assert.equal((await f.logs()).length,0);
  assert.equal((await f.post('ask',{requestId,question:'不能替换原问题'})).status,503);
  assert.equal((await f.post('close-unstarted',{requestId})).status,200);
  assert.equal((await f.post('ask',{requestId,question})).status,202);assert.equal((await f.logs()).length,0);
  assert.equal((await f.post('ask',{requestId:'new-after-explicit-close',question})).status,202);
  state=await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId==='new-after-explicit-close'&&q.phase==='completed'));
  assert.equal(state.secretaries[0].questions.find((q:any)=>q.requestId===requestId).phase,'closed_unstarted');assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,1);
  assert.deepEqual(await readFile(join(directory,'input-plan.json')),plan);assert.deepEqual(await readFile(join(directory,'template.json')),template);
});

test('atomic web registration is visible before projections and same request restores them without selecting a new CLI',async t=>{
  const f=await fixture(t),requestId='atomic-before-projections',question='原问题保持不变',directory=join(f.root,hash(requestId));
  const template=await readFile(f.secretaryPlan),plan=Buffer.from(canonical(await selectSecretaryRuntime({...f.p,question}))),encode=(bytes:Buffer)=>({base64:bytes.toString('base64'),sha256:hash(bytes)});
  await mkdir(directory,{recursive:true,mode:0o700});
  save(join(directory,'registration.json'),{schemaVersion:1,kind:'tongxu-web-secretary-registration',request:{schemaVersion:1,kind:'tongxu-workbench-question',source:'selected',item:f.item,store:f.store,requestId,question,templateSha256:hash(template),planSha256:hash(plan),createdAt:new Date().toISOString()},template:encode(template),plan:encode(plan)});
  const master=await readFile(join(directory,'registration.json'));
  await writeFile(join(directory,'question.json.interrupted.tmp'),'partial projection bytes');
  assert.equal((await f.get()).secretaries[0].questions[0].requestId,requestId);assert.equal((await f.logs()).length,0);
  assert.equal((await f.post('ask',{requestId,question})).status,202);await waitFor(f,s=>s.secretaries[0].questions[0]?.phase==='completed');
  const trace=await readFile(f.trace);assert.deepEqual(await readFile(join(directory,'input-plan.json')),plan);assert.deepEqual(await readFile(join(directory,'registration.json')),master);
  assert.equal((await f.post('ask',{requestId,question})).status,202);assert.deepEqual(await readFile(f.trace),trace);
  await writeFile(join(directory,'input-plan.json'),Buffer.from('conflicting projection'));
  assert.equal((await f.post('ask',{requestId,question})).status,503);assert.deepEqual(await readFile(f.trace),trace);assert.deepEqual(await readFile(join(directory,'registration.json')),master);
});

test('legacy recovery cannot start a second identical unresolved question and template-only preparation is recoverable',async t=>{
  const f=await fixture(t,'partial'),question='不要重复原来未完成的问题',requestId='legacy-before-browser-retry',directory=join(f.root,hash(requestId)),template=await readFile(f.secretaryPlan),plan=Buffer.from(canonical(await selectSecretaryRuntime({...f.p,question})));
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'template.json'),template);await writeFile(join(directory,'input-plan.json'),plan);
  await f.post('ask',{requestId:'already-unresolved',question});await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId==='already-unresolved'&&!q.active));
  const trace=await readFile(f.trace),again=await(await f.post('ask',{requestId,question})).json() as any;
  assert.equal(again.requestId,'already-unresolved');assert.deepEqual(await readFile(f.trace),trace);assert.deepEqual(await readFile(join(directory,'input-plan.json')),plan);
  const fresh=await fixture(t),id='template-only',dir=join(fresh.root,hash(id));await mkdir(dir,{recursive:true,mode:0o700});await writeFile(join(dir,'template.json'),await readFile(fresh.secretaryPlan));
  assert.equal((await fresh.post('ask',{requestId:id,question:'尚未选定CLI的旧登记'})).status,202);await waitFor(fresh,s=>s.secretaries[0].questions[0]?.phase==='completed');assert.equal((await fresh.logs()).filter(x=>x.kind==='model-input').length,1);
});

test('a CLI update after installation uses the same normal entry without editing its template; old answers survive another update',async t=>{
  const f=await fixture(t,'normal',false,stableEntry),requestId='same-entry-after-cli-update',question='核对原任务并保留完整结果。';
  const templateBefore=await readFile(f.secretaryPlan),catalogBefore=await readFile(f.catalogPath);
  const code=await readFile(f.p.codexExecutable,'utf8');await writeFile(f.p.codexExecutable,code.replaceAll('0.163.0-alpha.10.2','99.7.0'));
  assert.notEqual(hash(await readFile(f.p.codexExecutable)),f.p.codexSha256);
  assert.equal((await f.post('ask',{requestId,question})).status,202);
  await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId===requestId&&q.phase==='completed'));
  const directory=join(f.root,hash(requestId)),selected=JSON.parse(await readFile(join(directory,'input-plan.json'),'utf8'));
  assert.equal(selected.runtimeSelection.configuredSha256,f.p.codexSha256);assert.equal(selected.runtimeSelection.observedVersion,'codex-cli 99.7.0');
  assert.equal(selected.codexSha256,hash(await readFile(f.p.codexExecutable)));
  const resultBefore=await readFile(join(directory,'execution/result.json')),traceBefore=await readFile(f.trace);
  await writeFile(f.p.codexExecutable,code.replaceAll('0.163.0-alpha.10.2','100.0.0'));
  assert.equal((await f.post('ask',{requestId,question})).status,202);
  const again=await f.get();assert.equal(again.secretaries[0].questions[0].phase,'completed');
  const full=await(await fetch(f.u.origin+'/api/secretary-report/selected/'+requestId,{headers:f.headers})).json() as any;assert.equal(full.phase,'completed');assert.equal(full.result.report,JSON.parse(resultBefore.toString()).report);
  assert.deepEqual(await readFile(f.trace),traceBefore);assert.deepEqual(await readFile(join(directory,'execution/result.json')),resultBefore);
  assert.deepEqual(await readFile(f.secretaryPlan),templateBefore);assert.deepEqual(await readFile(f.catalogPath),catalogBefore);
});

test('normal page entry saves exact question, returns original complete answer and reopens without another model',async t=>{
  const f=await fixture(t),before=f.q.status(),question='请说明原任务目前的接收结果、尚未核实的事项和下一步。';
  assert.equal((await f.get()).secretaries[0].questions.length,0);assert.equal((await f.logs()).length,0);
  const registered=await f.post('ask',{requestId:'first',question});assert.equal(registered.status,202);const reply=await registered.json() as any;assert.equal(reply.registrationIsNotDelivery,true);
  const state=await waitFor(f,s=>s.secretaries[0].questions[0]?.phase==='completed'&&!s.secretaries[0].questions[0]?.active),q=state.secretaries[0].questions[0];assert.equal(q.question,question);
  const report=await(await fetch(f.u.origin+'/api/secretary-report/selected/first',{headers:f.headers})).json() as any;assert.equal(report.result.report,'明确标注的秘书模拟回答；读到了真实测试队列，未批准或执行动作。');assert.equal(report.result.queryCalls,2);assert.equal(report.result.sessionId,q.sessionId);
  const logs=await f.logs(),events=f.q.status().events;assert.equal((await f.post('ask',{requestId:'first',question})).status,202);await f.get();assert.deepEqual(await f.logs(),logs);assert.deepEqual(f.q.status().events,events);assert.deepEqual(f.q.status(),before);
  const reopened=await SecretaryControls.load(f.catalogPath,f.catalogSha256,f.sources);assert.equal((await reopened.report('selected','first')).phase,'completed');assert.deepEqual(await f.logs(),logs);
  assert.equal((await f.post('ask',{requestId:'first',question:'把原问题换成另一件事'})).status,503);assert.deepEqual(await f.logs(),logs);
});

test('active and incomplete identical questions cannot be resent by replacing the browser nonce',async t=>{
  for(const mode of ['slow','partial']){
    const f=await fixture(t,mode),question='这个原任务有哪些待核事实？';assert.equal((await f.post('ask',{requestId:'original',question})).status,202);
    const again=await(await f.post('ask',{requestId:'new-browser-nonce',question})).json() as any;assert.equal(again.requestId,'original');
    await waitFor(f,s=>s.secretaries[0].questions.length===1&&!s.secretaries[0].questions[0].active);
    const logs=await f.logs();assert.equal(logs.filter(x=>x.kind==='model-input').length,1);
    if(mode==='partial'){assert.equal((await f.get()).secretaries[0].questions[0].phase,'submitted_or_unknown');await f.post('ask',{requestId:'another-nonce',question});await waitFor(f,s=>!s.secretaries[0].questions[0].active);assert.deepEqual(await f.logs(),logs);assert.equal((await f.post('close-unstarted',{requestId:'original'})).status,503);}
  }
});

test('stopped question stays unsent, explicit close preserves it, and wrong-origin/extra-policy input is rejected',async t=>{
  const f=await fixture(t),question='只查询这个原任务';f.q.control('scope','investment','stopped','fixture:before-question');
  assert.equal((await f.post('ask',{requestId:'unsent',question})).status,202);await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active);
  assert.equal((await f.get()).secretaries[0].questions[0].phase,'registered_not_sent');assert.equal((await f.logs()).length,0);
  assert.equal((await f.post('close-unstarted',{requestId:'unsent'})).status,200);assert.equal((await f.get()).secretaries[0].questions[0].phase,'closed_unstarted');
  f.q.control('scope','investment','open','fixture:after-close');await f.post('ask',{requestId:'unsent',question});assert.equal((await f.logs()).length,0);
  assert.equal((await f.post('ask',{requestId:'outside',question},'https://unrelated.invalid')).status,403);assert.equal((await f.post('ask',{requestId:'policy',question,tools:['shell']})).status,503);
  assert.equal((await f.post('ask',{requestId:'fresh-question',question:'停止解除后请查询原任务的当前记录'})).status,202);await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId==='fresh-question'&&q.phase==='completed'));
  const dirs=(await readdir(f.root)).filter(x=>/^[a-f0-9]{64}$/.test(x));assert.equal(dirs.length,2);
});

test('same workbench composes secretary, direct queue receipt and foreground tick; GET/retry never dispatch another model',async t=>{
  const f=await fixture(t,'queue-action',true),question='请登记一次对原任务接收条件的核查提醒，并区分提醒与任务执行。';
  assert.equal((await f.post('ask',{requestId:'composed',question})).status,202);const state=await waitFor(f,s=>s.secretaries[0].questions[0]?.phase==='completed'&&!s.secretaries[0].questions[0]?.active);
  assert.equal(state.queueActions[0].receipts.length,1);assert.equal(state.queueOptions.actions[0].id,'remind');assert.equal(state.sourcePolling[0].modelTasksStarted,0);
  const native=await(await fetch(f.u.origin+'/api/secretary-report/selected/composed',{headers:f.headers})).json() as any;assert.equal(native.result.queueReceipts[0].receipt.originalId,state.queueActions[0].receipts[0].hint.id);
  const direct=async()=>fetch(f.u.origin+'/api/queue-action/remind/run',{method:'POST',headers:{...f.headers,Origin:f.u.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:'one-direct-reminder'})});
  const first=await(await direct()).json() as any,again=await(await direct()).json() as any;assert.equal(first.originalId,again.originalId);assert.equal(again.duplicate,true);assert.equal((await f.get()).queueActions[0].receipts.length,2);
  const logs=await f.logs();await f.get();await f.get();assert.deepEqual(await f.logs(),logs);assert.equal(logs.filter(x=>x.kind==='model-input').length,1);
});

test('ended metadata-only stop closes explicitly, preserves every original and allows a new question attempt',async t=>{
  const f=await fixture(t,'late-stop-once',false,stableEntry),requestId='zero-input',question='核对这个原任务的当前记录';
  const installed=await readFile(f.p.codexExecutable,'utf8');await writeFile(f.p.codexExecutable,installed.replaceAll('0.163.0-alpha.10.2','99.8.0'));
  await f.post('ask',{requestId,question});await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active);
  const output=join(f.root,hash(requestId),'execution'),native=join(output,'codex-secretary'),names=(await readdir(native,{withFileTypes:true})).filter(n=>n.isFile()).map(n=>n.name),originals=await Promise.all(names.map(n=>readFile(join(native,n))));
  assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
  await writeFile(f.p.codexExecutable,installed.replaceAll('0.163.0-alpha.10.2','100.0.0'));
  assert.equal((await f.post('close-unstarted',{requestId})).status,200);assert.equal((await f.post('close-unstarted',{requestId})).status,200);
  assert.equal((await f.get()).secretaries[0].questions[0].phase,'closed_unstarted');
  const receipt=JSON.parse((await readFile(join(output,'closed-unstarted.json'))).toString());assert.equal(receipt.proof.metadataOnly,true);assert.equal(receipt.proof.modelInputs,0);
  assert.deepEqual(await Promise.all(names.map(n=>readFile(join(native,n)))),originals);
  f.q.control('scope','investment','open','fixture:resume-after-proven-zero-input');
  await f.post('ask',{requestId,question});assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
  const retry=await(await f.post('ask',{requestId:'explicit-new-attempt',question})).json() as any;assert.equal(retry.requestId,'explicit-new-attempt');
  await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId==='explicit-new-attempt'&&q.phase==='completed'));
  assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,1);assert.deepEqual(await Promise.all(names.map(n=>readFile(join(native,n)))),originals);
});

test('metadata closure rejects live, partial, incomplete, model-intent and tool evidence even without a final answer',async t=>{
  const f=await fixture(t,'late-stop'),requestId='metadata-negative';await f.post('ask',{requestId,question:'explicit zero-input negative fixture'});await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active);
  const output=join(f.root,hash(requestId),'execution'),native=join(output,'codex-secretary'),read=(n:string)=>readFile(join(native,n)),status=await read('capture-status.json');
  const altered=async(name:string,bytes:Buffer|undefined,pattern:RegExp)=>{const old=await read(name);try{if(bytes)await writeFile(join(native,name),bytes);else await unlink(join(native,name));await assert.rejects(closeUnstartedSecretary(output),pattern);}finally{await writeFile(join(native,name),old);}};
  await altered('process.json',Buffer.from(JSON.stringify({pid:process.pid})),/active_or_unknown/);
  await altered('exit.json',undefined,/ENOENT/);await altered('capture-status.json',undefined,/ENOENT/);
  const input=await read('stdin.ndjson'),partial=input.subarray(0,input.length-1),capture=JSON.parse(status.toString());capture.files['stdin.ndjson']=hash(partial);await writeFile(join(native,'capture-status.json'),JSON.stringify(capture));
  try{await altered('stdin.ndjson',partial,/partial_frame/);}finally{await writeFile(join(native,'capture-status.json'),status);}
  await writeFile(join(native,'turn-1-intent.json'),'{}');try{await assert.rejects(closeUnstartedSecretary(output),/model_input_registered/);}finally{await unlink(join(native,'turn-1-intent.json'));}
  const raw=await read('stdout.ndjson'),tool=Buffer.concat([raw,Buffer.from(JSON.stringify({id:'unexpected',method:'item/tool/call',params:{}})+'\n')]),updated=JSON.parse(status.toString());updated.files['stdout.ndjson']=hash(tool);await writeFile(join(native,'capture-status.json'),JSON.stringify(updated));
  try{await altered('stdout.ndjson',tool,/protocol_unknown/);}finally{await writeFile(join(native,'capture-status.json'),status);}
  assert.equal((await closeUnstartedSecretary(output)).closed,true);assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
});


test('retargeting the stable entry after input checks cannot rebind a registered question or send its model input',async t=>{
  const f=await fixture(t,'normal',false,stableEntry),start=BoundedCodexSession.start,question='核对入口升级时的原问题。',requestId='upgrade-at-native-start';let replaced=false;
  BoundedCodexSession.start=async options=>{
    if(options.role==='secretary'&&!replaced){replaced=true;const next=join(f.fixtureRoot,'codex-new-install');await writeFile(next,(await readFile(f.p.codexExecutable,'utf8')).replaceAll('0.163.0-alpha.10.2','99.9.1'),{mode:0o700});await unlink(f.p.codexExecutable);await symlink(next,f.p.codexExecutable);}
    return start(options);
  };t.after(()=>{BoundedCodexSession.start=start;});
  await f.post('ask',{requestId,question});await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active);
  assert.equal(replaced,true);assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
  const path=join(f.root,hash(requestId),'input-plan.json'),original=await readFile(path),outcome=JSON.parse(await readFile(join(f.root,hash(requestId),'execution/outcome.json'),'utf8'));assert.equal(outcome.reason,'native_registered_executable_changed');
  await f.post('ask',{requestId,question});await waitFor(f,s=>!s.secretaries[0].questions[0].active);assert.deepEqual(await readFile(path),original);assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
  assert.equal((await f.post('close-unstarted',{requestId})).status,200);await f.post('ask',{requestId:'explicit-after-upgrade',question});await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId==='explicit-after-upgrade'&&q.phase==='completed'));
  const reply=await(await fetch(f.u.origin+'/api/secretary-report/selected/explicit-after-upgrade',{headers:f.headers})).json() as any;assert.equal(reply.phase,'completed');assert.ok(reply.result.report.length);assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,1);assert.deepEqual(await readFile(path),original);
});

test('a CLI change after model input retains the original uncertain attempt and never resends it',async t=>{
  const f=await fixture(t,'normal',false,stableEntry),turn=BoundedCodexSession.prototype.turn,requestId='upgrade-after-input',question='保留已发出的原输入。';let replaced=false;
  BoundedCodexSession.prototype.turn=async function(...args){const result=await turn.apply(this,args);if(this.o.role==='secretary'&&!replaced){replaced=true;await appendFile(f.p.codexExecutable,'\n// compatible update after input was already sent\n');}return result;};t.after(()=>{BoundedCodexSession.prototype.turn=turn;});
  await f.post('ask',{requestId,question});await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active);assert.equal(replaced,true);assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,1);
  const before=await readFile(f.trace);await f.post('ask',{requestId,question});await waitFor(f,s=>!s.secretaries[0].questions[0].active);assert.deepEqual(await readFile(f.trace),before);assert.equal((await f.post('close-unstarted',{requestId})).status,503);
});


test('an upgrade after metadata but before model send can be explicitly closed only from complete zero-input originals',async t=>{
  const f=await fixture(t,'normal',false,stableEntry),start=BoundedCodexSession.start,requestId='upgrade-after-metadata',question='升级后保留原问题再明确重开。';let replaced=false;
  BoundedCodexSession.start=async options=>{const session=await start(options);if(options.role==='secretary'&&!replaced){replaced=true;const next=join(f.fixtureRoot,'codex-next-after-metadata');await writeFile(next,(await readFile(f.p.codexExecutable,'utf8')).replaceAll('0.163.0-alpha.10.2','99.9.2'),{mode:0o700});await unlink(f.p.codexExecutable);await symlink(next,f.p.codexExecutable);}return session;};t.after(()=>{BoundedCodexSession.start=start;});
  await f.post('ask',{requestId,question});await waitFor(f,s=>s.secretaries[0].questions[0]&&!s.secretaries[0].questions[0].active);assert.equal(replaced,true);assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
  const output=join(f.root,hash(requestId),'execution'),native=join(output,'codex-secretary'),names=await readdir(native),originals=await Promise.all(names.filter(n=>n.endsWith('.json')||n.endsWith('.ndjson')||n.endsWith('.txt')).map(async name=>({name,bytes:await readFile(join(native,name))})));
  assert.equal(names.some(n=>n==='inputs.json'||n.startsWith('turn-')),false);assert.equal(JSON.parse(await readFile(join(native,'capture-failure.json'),'utf8')).reason,'external_executable_changed_during_operation');assert.doesNotMatch(await readFile(join(native,'stdin.ndjson'),'utf8'),/turn\/start/);
  await f.post('ask',{requestId,question});await waitFor(f,s=>!s.secretaries[0].questions[0].active);assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,0);
  assert.equal((await f.post('close-unstarted',{requestId})).status,200);for(const original of originals)assert.deepEqual(await readFile(join(native,original.name)),original.bytes);
  await f.post('ask',{requestId:'explicit-next-after-metadata',question});await waitFor(f,s=>s.secretaries[0].questions.some((q:any)=>q.requestId==='explicit-next-after-metadata'&&q.phase==='completed'));assert.equal((await f.logs()).filter(x=>x.kind==='model-input').length,1);
});
