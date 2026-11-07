import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {messageFixture} from '../w6/message-fixture.js';
import {runReception} from '../../src/receiver.js';
import {runMessages} from '../../src/messages.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import type {CoordinationPlan,CoordinationStage} from '../../src/coordination-contract.js';
import {coordinationTaskBody,coordinationMessageId,coordinationMessageAuthority,type CoordinationMessagePurpose,type CoordinationExecution} from '../../src/coordination-execution-contract.js';

async function fixture(t:test.TestContext,recursive=false,refreshUnsent=false){
  const f=await messageFixture(t),receiverTemplate=JSON.parse(await readFile(join(f.root,'plan.json'),'utf8'));
  const parent=await f.packet({pr:3}),H=f.q.status().items.find((i:any)=>i.id===parent.item)!.candidate.H;
  const producer=await f.packet({pr:4,requires:[{item:parent.item,type:'development',version:H,blocks:'shadow_review',source:'Explicit current upstream evidence fixture',canContinue:'Independent reading'}]}),consumer=await f.packet({pr:5}),independent=await f.packet({pr:6});
  const receiverPath=join(f.root,'producer-receiver.json');await writeFile(receiverPath,canonical({...receiverTemplate,item:producer.item}));
  const accepted=await runReception(receiverPath);assert.equal(accepted.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');
  const task=(id:string,item:string):CoordinationPlan['tasks'][number]=>({id,item,actor:id,originActor:id,dispatch:'owner_backlog',stages:['investigate','implement'],independentPaths:[],workspace:null,publishBranch:null,outputs:[]});
  const plan:CoordinationPlan={schemaVersion:1,kind:'tongxu-task-coordination',name:'receiver-current-source-consumption',revision:'r1',previous:null,source:'Explicit protocol fixtures with actual Git, queue, CLI and message consumers',authorityIntent:null,mode:'stage_serial',actors:[{id:'A',tool:'codex'},{id:'B',tool:'codex'},{id:'A3',tool:'codex'}],tasks:[{...task('A',producer.item),stages:['investigate','implement','receive'],outputs:[{id:'accepted',stage:'receive',kind:'receiver_judgment'}]},task('B',consumer.item),task('A3',independent.item)],shared:[],dependencies:[{task:'B',stage:recursive?'investigate':'implement',producer:'A',capability:'accepted'}]};
  if(recursive){const c=await f.packet({pr:7});plan.actors.push({id:'C',tool:'codex'});plan.tasks.push(task('C',c.item));plan.tasks[1]!.outputs=[{id:'report',stage:'investigate',kind:'message_report'}];plan.dependencies.push({task:'C',stage:'implement',producer:'B',capability:'report'});}
  const enabled=join(f.root,'hold-input'),sent=join(f.root,'input-sent'),release=join(f.root,'release-input');
  let script=await readFile(f.codex,'utf8');
  const report="report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId";
  assert.ok(script.includes(report));
  script=script.replace(report,"report:JSON.stringify((()=>{const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),task=x.body.split('\\n')[0].slice(18);return {kind:'tongxu-coordination-feedback',task,revision:c.revision,parts:[],report:'Explicit fixture read the supplied exact original and applicability labels.'};})())");
  const finish="if(mode==='delay')setTimeout(finish,300);else finish();return;}";assert.ok(script.includes(finish));
  script=script.replace(finish,`if(fs.existsSync(${JSON.stringify(enabled)})){fs.writeFileSync(${JSON.stringify(sent)},x.messageId);const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(wait);finish();}},10);}else finish();return;}`);
  await writeFile(f.codex,script);
  const {item:_item,role:_role,parent:_parent,...profile}=f.plan.participants[0]!;
  const execution:CoordinationExecution={schemaVersion:1,kind:'tongxu-coordination-readonly-execution',source:'Explicit fixed role capabilities',executionKind:'fixture',actors:plan.actors.map(a=>({...profile,id:a.id,executableSha256:hash(script)})),taskBodies:Object.fromEntries(plan.tasks.map(t=>[t.id,'Read the declared original sources and their current applicability'])),authorityIntents:Object.fromEntries(plan.tasks.map(t=>[t.id,null])),billing:f.plan.billing,timeoutMs:5000,refreshUnsent};
  const planPath=join(f.root,'coordination.json'),executionPath=join(f.root,'execution.json'),testPath=join(f.root,'unused-test.json');
  await writeFile(planPath,canonical(plan));await writeFile(executionPath,canonical(execution));await writeFile(testPath,canonical({schemaVersion:1,tools:[{id:'unused',argv:['/fixture/not-run'],timeoutMs:1000}]}));
  const ref=async(path:string)=>({path,sha256:hash(await readFile(path))});
  const entry={schemaVersion:1,kind:'tongxu-conditional-delivery-entry',id:'receiver-currentness',title:'Original receiver applicability',store:f.store,repository:'fixture/reception',target:'fixture',coordination:{plan:await ref(planPath),execution:await ref(executionPath)},integration:{item:producer.item,members:['A','B'],gateStage:'implement',objects:receiverTemplate.objects,selectionReason:'This component only checks precise receipt and message consumption',authorization:null,testPlan:await ref(testPath),receiverTemplate:await ref(receiverPath),receiverAuthorization:null,sourceReader:{repositoryId:1,ghExecutable:receiverTemplate.claudeExecutable,ghSha256:hash(await readFile(receiverTemplate.claudeExecutable)),issues:[],executionKind:'fixture'}}};
  const entryPath=join(f.root,'entry.json');await writeFile(entryPath,canonical(entry));const execute=promisify(execFile),cli=new URL('../../src/conditional-entry-cli.js',import.meta.url).pathname;
  const run=async(action:string,...args:string[])=>{const result=await execute(process.execPath,[cli,action,'--entry',entryPath,...args],{cwd:f.root,timeout:30000,maxBuffer:16*1024*1024});return JSON.parse(result.stdout);};
  const id=(await run('prepare')).preparedCoordination as string,records=f.q.coordination();
  const prepareMessage=async(taskId:string,purpose:CoordinationMessagePurpose,stage:CoordinationStage,legacy=false)=>{
    const assigned=plan.tasks.find(t=>t.id===taskId)!,actor=execution.actors.find(a=>a.id===assigned.actor)!,request=records.execution(id,Buffer.from(canonical(execution)));
    let context=records.context(id,[taskId],stage);
    // Old contexts have no sourceCurrent fields. They retain the original
    // identity and must still pass live source checks before a first send.
    if(legacy){
      const value=structuredClone(context.value);
      for(const output of value.outputs){delete output.sourceCurrent;delete output.sourceProblem;}
      const bytes=Buffer.from(canonical(value)),sha256=hash(bytes),event=Buffer.from(canonical({sha256})),eventHash=hash(event);
      const db=new DatabaseSync(join(f.store,'queue.sqlite'));
      try{
        db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256,bytes);
        db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(eventHash,event);
        db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('coordination_context_prepared','coordination:'+id,JSON.stringify({value:{sha256},sha256:eventHash}),new Date().toISOString());
      }finally{db.close();}
      context={value,bytes,sha256};
    }
    const directory=join(f.store,'coordination-'+id,'dispatch-'+hash(canonical([taskId,purpose])),'attempt-1');await mkdir(directory,{recursive:true,mode:0o700});
    const message={schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:execution.executionKind,source:execution.source+'; coordination '+id+' task '+taskId+' '+purpose,...coordinationMessageAuthority(execution,id,taskId,purpose,1),participants:[{...actor,item:assigned.item,role:'issue_owner',parent:null}],messages:[{id:coordinationMessageId(taskId,purpose),from:null,to:actor.id,body:coordinationTaskBody(execution,taskId,purpose),replies:[]}],material:[{name:'coordination-context.json',path:join(directory,'context.json'),sha256:context.sha256}],consumeMaterial:['coordination-context.json'],billing:execution.billing,timeoutMs:execution.timeoutMs};
    records.selectDispatch(id,taskId,purpose,request.requestSha256,Buffer.from(canonical(message)),context.sha256);const selected=records.dispatchSelection(id,taskId,purpose)!;
    records.bindMessages(id,selected.plan,selected.contextSha256,[{task:taskId,messageId:message.messages[0]!.id}]);await writeFile(join(directory,'context.json'),selected.context);await writeFile(join(directory,'plan.json'),selected.plan);
    return {...selected,messageId:message.messages[0]!.id,planPath:join(directory,'plan.json')};
  };
  return {...f,run,id,plan,records,accepted,prepareMessage,enabled,sent,release,producer,
    invalidate:()=>f.packet({pr:3,incomplete:true}),restore:()=>f.packet({pr:3}),
    inputs:async()=>(await f.calls()).filter(c=>c.kind==='input').length,
    ready:(task='B')=>records.stage(id,task,'implement'),
    reuse:()=>run('reuse','--task','A')};
}

test('same-H upstream evidence invalidates registered and already consumed receiver outputs, with exact historical recovery and no duplicate input',async t=>{
  const f=await fixture(t);await f.run('investigate');const receipt=await f.reuse(),before=await f.inputs();
  await f.invalidate();await assert.rejects(f.reuse,/queue_repair_source_no_longer_current/);
  assert.match(f.ready().blockers.join(),/capability_producer_changed:A:accepted/);
  assert.equal((await f.run('investigate')).newModelRequests,0);assert.equal(await f.inputs(),before);
  assert.equal(f.records.outputOriginal(f.id,receipt.sha256).historicalObservationOnly,true);
  await f.restore();assert.equal((await f.reuse()).duplicate,true);assert.equal((await f.run('investigate')).newModelRequests,1);assert.equal(f.ready().phasePrerequisitesMet,true);
  const consumed=await f.inputs();await f.invalidate();assert.equal(f.ready().phasePrerequisitesMet,false);assert.equal((await f.run('report')).newModelInputs,0);assert.equal((await f.run('investigate')).newModelRequests,0);
  await f.restore();assert.equal(f.ready().phasePrerequisitesMet,true);assert.equal((await f.run('investigate')).newModelRequests,0);assert.equal(await f.inputs(),consumed);
});

for(const purpose of ['consume','consume_implement','investigate'] as const)test('a prepared '+purpose+' rejects a stale receipt at first send, retains its original run and recovers',async t=>{
  const f=await fixture(t);if(purpose!=='investigate')await f.run('investigate');await f.reuse();
  const selected=await f.prepareMessage('B',purpose,purpose==='investigate'?'investigate':'implement',purpose==='consume');
  const before=await f.inputs();await f.invalidate();const blocked=await runMessages(f.store,selected.planPath,false,selected.run);
  assert.equal(blocked.newModelRequests,0);assert.equal(blocked.completed,false);assert.equal(await f.inputs(),before);assert.equal(f.ready().phasePrerequisitesMet,false);
  // A3 has no declared dependency on this receiver, even though the complete
  // context also carries the unrelated historical output.
  const independent=await f.run('investigate');assert.equal(independent.results['A3:investigate'].completed,true);assert.equal(f.records.dispatchSelection(f.id,'B',purpose)!.run,selected.run);
  await f.restore();const recovered=await runMessages(f.store,selected.planPath,false,selected.run);assert.equal(recovered.completed,true);assert.equal(recovered.newModelRequests,1);f.records.consumeMessageInputs(f.id,'B','implement',selected.run,selected.messageId);assert.equal(f.ready().phasePrerequisitesMet,true);
  assert.equal((await runMessages(f.store,selected.planPath,true,selected.run)).newModelRequests,0);
});

test('the last input gate rechecks a prepared receiver after runtime startup',async t=>{
  const f=await fixture(t);await f.run('investigate');await f.reuse();const selected=await f.prepareMessage('B','consume','implement'),before=await f.inputs();let changed=false;
  const blocked=await runMessages(f.store,selected.planPath,false,selected.run,undefined,undefined,async()=>{if(!changed&&f.q.messages().status(selected.run).runtimes.some(r=>r.started)){await f.invalidate();changed=true;}});
  assert.equal(changed,true);assert.equal(blocked.newModelRequests,0);assert.equal(await f.inputs(),before);
  await f.restore();const recovered=await runMessages(f.store,selected.planPath,false,selected.run);assert.equal(recovered.newModelRequests,1);assert.equal(recovered.completed,true);
});

test('new independent investigation labels a stale future receipt as history and cannot register it as effective consumption',async t=>{
  const f=await fixture(t);const receipt=await f.reuse();await f.invalidate();const result=await f.run('investigate');assert.equal(result.readonlyTasksCompleted,true,JSON.stringify(result.errors));assert.equal(result.newModelRequests,3);
  const selected=f.records.dispatchSelection(f.id,'B','investigate')!,context=JSON.parse(selected.context.toString()),output=context.outputs.find((o:any)=>o.sha256===receipt.sha256);
  assert.equal(output.sourceCurrent,false);assert.match(output.sourceProblem,/queue_repair_source_no_longer_current/);assert.equal(f.ready().phasePrerequisitesMet,false);
  assert.throws(()=>f.records.consumeMessageInputs(f.id,'B','implement',selected.run,coordinationMessageId('B','investigate')),/coordination_exact_producer_output_not_consumed/);
  await f.restore();assert.equal((await f.run('investigate')).newModelRequests,1);assert.equal(f.ready().phasePrerequisitesMet,true);
});

test('refreshUnsent preserves an independent prepared run when only unrelated source applicability changes',async t=>{
  const f=await fixture(t,false,true);await f.reuse();
  const selected=await f.prepareMessage('A3','investigate','investigate');
  await f.invalidate();
  const result=await f.run('investigate');
  assert.equal(result.results['A3:investigate'].completed,true);
  assert.equal(f.records.dispatchSelection(f.id,'A3','investigate')!.run,selected.run);
  assert.equal(f.q.messages().submitted(selected.run,'A3').length,1);
  assert.equal((await f.run('investigate')).newModelRequests,0);
});

for(const refreshUnsent of [false,true])test('a source lost after actual input retains the complete reply and reconciles the same run with refreshUnsent='+refreshUnsent,async t=>{
  const f=await fixture(t,false,refreshUnsent);await f.run('investigate');const receipt=await f.reuse(),selected=await f.prepareMessage('B','consume','implement');await writeFile(f.enabled,'hold');
  const pending=runMessages(f.store,selected.planPath,false,selected.run);
  try{for(let attempt=0;;attempt++){try{await access(f.sent);break;}catch{if(attempt>=500)throw new Error('fixture_input_not_observed');await new Promise(resolve=>setTimeout(resolve,10));}}await f.invalidate();}finally{await writeFile(f.release,'release');}
  const result=await pending;assert.equal(result.completed,true);assert.equal(result.newModelRequests,1);assert.equal(f.ready().phasePrerequisitesMet,false);
  assert.throws(()=>f.records.consumeMessageInputs(f.id,'B','implement',selected.run,selected.messageId),/coordination_exact_producer_output_not_consumed/);
  assert.equal(f.records.outputOriginal(f.id,receipt.sha256).complete,true);const before=await f.inputs();assert.equal((await runMessages(f.store,selected.planPath,true,selected.run)).completed,true);
  await f.restore();assert.equal((await f.run('investigate')).newModelRequests,0);assert.equal(f.ready().phasePrerequisitesMet,true);assert.equal(await f.inputs(),before);assert.equal(f.records.dispatchSelection(f.id,'B','consume')!.run,selected.run);
});

test('unchanged downstream message-report SHA retains history while declared receiver ancestry blocks new consumption',async t=>{
  const f=await fixture(t,true);await f.run('investigate');const receipt=await f.reuse(),selected=await f.prepareMessage('B','investigate','investigate');const result=await runMessages(f.store,selected.planPath,false,selected.run);assert.equal(result.completed,true);
  f.records.feedback(f.id,selected.run,selected.messageId);f.records.consumeMessageInputs(f.id,'B','investigate',selected.run,selected.messageId);const report=f.records.recordMessageOutput(f.id,'B','report',selected.run,selected.messageId),before=await f.inputs();
  await f.invalidate();assert.equal(f.records.stage(f.id,'B','investigate').phasePrerequisitesMet,false);assert.match(f.ready('C').blockers.join(),/B:report/);assert.equal((await f.run('investigate')).newModelRequests,0);assert.equal(await f.inputs(),before);
  assert.equal(hash(canonical(f.records.outputOriginal(f.id,report.sha256).value)),report.sha256);assert.equal(f.records.outputOriginal(f.id,receipt.sha256).complete,true);
  await f.restore();assert.equal((await f.run('investigate')).newModelRequests,1);assert.equal(f.ready('C').phasePrerequisitesMet,true);assert.equal((await f.run('investigate')).newModelRequests,0);
});

test('a complete report from an input whose source was lost stays unpublished until the same original source recovers',async t=>{
  const f=await fixture(t,true,true);await f.run('investigate');await f.reuse();
  const selected=await f.prepareMessage('B','investigate','investigate');
  await writeFile(f.enabled,'hold');
  const pending=runMessages(f.store,selected.planPath,false,selected.run);
  try{
    for(let attempt=0;;attempt++){
      try{await access(f.sent);break;}
      catch{if(attempt>=500)throw new Error('fixture_input_not_observed');await new Promise(resolve=>setTimeout(resolve,10));}
    }
    await f.invalidate();
  }finally{await writeFile(f.release,'release');}
  const reply=await pending;
  assert.equal(reply.completed,true);
  assert.equal(reply.newModelRequests,1);
  const before=await f.inputs();
  assert.throws(()=>f.records.recordMessageOutput(f.id,'B','report',selected.run,selected.messageId),/queue_repair_source_no_longer_current/);
  assert.equal(f.records.context(f.id,['A3'],'investigate').value.outputs.some(o=>o.task==='B'),false);
  await f.restore();
  f.records.consumeMessageInputs(f.id,'B','investigate',selected.run,selected.messageId);
  const output=f.records.recordMessageOutput(f.id,'B','report',selected.run,selected.messageId);
  assert.equal(f.records.recordMessageOutput(f.id,'B','report',selected.run,selected.messageId).duplicate,true);
  assert.equal(await f.inputs(),before);
  assert.equal(f.records.context(f.id).value.outputs.find(o=>o.sha256===output.sha256).sourceCurrent,true);
  assert.equal((await f.run('investigate')).newModelRequests,1);
  assert.equal((await f.run('investigate')).newModelRequests,0);
});
