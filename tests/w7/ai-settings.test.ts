import test from 'node:test';
import type {AIProgram} from '../../src/ai-programs.js';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../../src/snapshot.js';
import {parseAIModels,requireModelChoice,codexModelList,type AIProvider} from '../../src/ai-catalog.js';
import {AISettings,withAIPreferences,currentAIChoice,participantWithAI} from '../../src/ai-settings.js';
import {capturedCodexModels,checkCodexSelected,codexTurnChoice,codexThreadChoice,recordedCodexTurnChoice,claudeChoiceArgs} from '../../src/ai-execution.js';
import {captureImplementationAI,parseImplementationAI,implementationChoice} from '../../src/implementation-ai.js';
import {startWorkbench} from '../../src/workbench.js';
import {firstCodingWorkflowRevision} from '../../src/coding-workflow-source.js';
import {randomUUID} from 'node:crypto';

const scope=(id=1)=>({account:{id:7},repository:{id,nodeId:'R_'+id,fullName:'fixture/project-'+id}});
test('overlapping workflow checks and cold retries keep the first observed main',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-workflow-race-')));
  const config={root,configured:[],disabledMcpServers:[]};
  const initial=await AISettings.open(config);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const body={requestId:randomUUID(),mode:'upstream-main'};
  let enter!:()=>void,release!:()=>void,observations=0;
  const verifying=new Promise<void>(done=>{enter=done;}),finish=new Promise<void>(done=>{release=done;});
  const first=initial.checkWorkflow(scope(),body,async()=>{enter();await finish;throw new Error('fixture_source_unavailable');},async()=>{
    observations++;return {main:'a'.repeat(40),firstMerged:true};
  });
  await verifying;
  const retry=initial.checkWorkflow(scope(),body,async()=>{},async()=>{observations++;return {main:'b'.repeat(40),firstMerged:true};});
  release();
  for(const result of await Promise.allSettled([first,retry])){
    assert.equal(result.status,'rejected');
    if(result.status==='rejected')assert.match(result.reason.message,/fixture_source_unavailable/);
  }
  assert.equal(observations,1);
  await initial.close();
  const reopened=await AISettings.open(config);
  try{
    const result=await reopened.checkWorkflow(scope(),body,async()=>{},async()=>{observations++;return {main:'c'.repeat(40),firstMerged:true};}) as {selectedRevision:string};
    assert.equal(result.selectedRevision,'a'.repeat(40));
    assert.equal(observations,1);
  }finally{await reopened.close();}
});

test('a verified workflow adoption sets the scoped default atomically and survives reopening',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-workflow-adoption-'))),config={root,configured:[],disabledMcpServers:[]};
  t.after(()=>rm(root,{recursive:true,force:true}));
  const settings=await AISettings.open(config),requestId=randomUUID(),selected=scope();
  const before=settings.workflowRevision(selected),input={checkRequestId:requestId,revision:firstCodingWorkflowRevision};
  const current=async()=>{},missing=async()=>null;
  try{
    await assert.rejects(settings.activateWorkflow(selected,input,current,missing),/checked_candidate_required/);
    await settings.checkWorkflow(selected,{requestId,mode:'first-adoption'},current,async()=>({main:'1234'.repeat(10),firstMerged:true}));
    await assert.rejects(settings.activateWorkflow(selected,input,current,missing),/activation_evidence_required/);
    assert.equal(settings.workflowRevision(selected),before);
    const evidence={runtimeHead:'b'.repeat(40),runtimeFilesSha256:'c'.repeat(64),operation:randomUUID(),materialSha256:'a'.repeat(64),testReport:'fixture accepted report reference'};
    const adopted=await settings.activateWorkflow(selected,input,current,async revision=>{assert.equal(revision,input.revision);return evidence;});
    assert.deepEqual(adopted.evidence,evidence);
    assert.equal(settings.workflowRevision(selected),firstCodingWorkflowRevision);
    assert.equal(settings.workflowRevision(scope(2)),before);
  }finally{await settings.close();}
  const cold=await AISettings.open(config);
  try{
    const repeated=await cold.activateWorkflow(selected,input,current,async()=>{throw new Error('duplicate observed new proof');});
    assert.equal(repeated.revision,firstCodingWorkflowRevision);
    assert.equal((await cold.workflow(undefined,selected)).status,'active');
    assert.equal((await cold.workflow(undefined,scope(2))).status,'controls_pending');
  }finally{await cold.close();}
});

test('normal workflow check pins the first adoption even after upstream main moves and keeps an explicit later check fixed',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-workflow-check-')));
  const path=join(root,'workbench.json'),repo={
    id:1,nodeId:'R_1',full_name:'fixture/project-1',description:'Workflow check fixture',private:false,archived:false,
    defaultBranchRef:{name:'main',target:{oid:'c'.repeat(40)}},updated_at:new Date().toISOString()
  };
  const account={id:7,login:'fixture'};
  let main='a'.repeat(40),firstMerged=true,observations=0;
  const dependencies:NonNullable<Parameters<typeof startWorkbench>[2]>={
    githubReader:async()=>({query:async op=>({
      status:200,headers:{},provenance:'gh-http-body',
      body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repo],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository:repo}})
    })}),
    workflowUpstream:async()=>{observations++;return {main,firstMerged};}
  };
  await writeFile(path,JSON.stringify({
    schemaVersion:1,kind:'tongxu-local-workbench',title:'Workflow check fixture',goal:'Pin the observed upstream version',sources:[],
    githubProjects:true,aiSettings:{root:join(root,'settings'),configured:[],disabledMcpServers:[]}
  }));
  let app=await startWorkbench(path,undefined,dependencies);
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const http=async(route:string,body?:object)=>{
    const url=new URL(app.url),response=await fetch(url.origin+route,{
      headers:{Authorization:'Bearer '+url.hash.slice(1),'X-Tongxu-Account':'7','X-Tongxu-Project':'1',
        ...(body?{Origin:url.origin,'Content-Type':'application/json'}:{})},
      ...(body?{method:'POST',body:JSON.stringify(body)}:{})
    });
    return {status:response.status,data:await response.json() as any};
  };
  await http('/api/github/projects');
  const route='/api/ai-settings/workflow/check',first={requestId:randomUUID(),mode:'first-adoption'};
  const chosen=await http(route,first);
  assert.equal(chosen.status,200);
  assert.deepEqual([chosen.data.selectedRevision,chosen.data.observedMain,chosen.data.activated,chosen.data.modelInputs],
    [firstCodingWorkflowRevision,main,false,0]);
  assert.equal(chosen.data.reason,'coding_workflow_controls_pending');
  const inactive=await http('/api/ai-settings/workflow/activate',{checkRequestId:first.requestId,revision:firstCodingWorkflowRevision});
  assert.equal(inactive.status,503);
  assert.equal(inactive.data.error,'coding_workflow_activation_evidence_required');
  main='b'.repeat(40);
  assert.deepEqual(await http(route,first),chosen);
  assert.equal(observations,1);
  assert.equal((await http(route,{...first,mode:'upstream-main'})).data.error,'coding_workflow_request_changed');
  await app.close();app=await startWorkbench(path,undefined,dependencies);await http('/api/github/projects');
  const reopened=await http('/api/ai-settings/workflow/engineering_owner');
  assert.deepEqual(reopened.data.check,chosen.data);
  assert.equal(reopened.data.activeRevision,chosen.data.activeRevision);
  assert.equal(observations,1);
  const followup={requestId:randomUUID(),mode:'upstream-main'},found=await http(route,followup);
  assert.equal(found.data.selectedRevision,main);
  assert.equal(found.data.reason,'coding_workflow_candidate_package_unavailable');
  assert.equal(found.data.activated,false);
  main='d'.repeat(40);firstMerged=false;
  assert.deepEqual(await http(route,followup),found);
  assert.equal((await http(route,{...first,requestId:randomUUID()})).data.reason,'coding_workflow_first_revision_not_merged');
  assert.equal(observations,3);
});
test('current tool catalogs determine model IDs and per-model efforts, without a release or model-name allowlist',async()=>{
  const codex=parseAIModels('codex',[{model:'future-model-z',displayName:'Future',supportedReasoningEfforts:[{reasoningEffort:'new-depth'}],defaultReasoningEffort:'new-depth'}]);
  requireModelChoice(codex,{model:'future-model-z',effort:'new-depth'});assert.throws(()=>requireModelChoice(codex,{model:'gpt-6-astra',effort:'max'}),/no_longer_available/);assert.throws(()=>requireModelChoice(codex,{model:'future-model-z',effort:'xhigh'}),/effort_not_supported/);
  const claude=parseAIModels('claude',[{value:'sonnet',resolvedModel:'claude-sonnet-next',supportedEffortLevels:['low','xhigh']}]);assert.equal(claude[0]!.resolvedId,'claude-sonnet-next');assert.deepEqual(claude[0]!.efforts,['low','xhigh']);assert.deepEqual(claudeChoiceArgs({model:'sonnet',effort:'xhigh'}),['--model','sonnet','--effort','xhigh']);
  assert.throws(()=>parseAIModels('codex',[{model:'x',supportedReasoningEfforts:[{reasoningEffort:'bad value'}]}]),/invalid/);
  const calls:any[]=[];const models=await codexModelList(async(m,p)=>{calls.push([m,p]);return p.cursor?{data:[{model:'b'}],nextCursor:null}:{data:[{model:'a'}],nextCursor:'next'};});assert.deepEqual(models.map(m=>m.id),['a','b']);assert.equal(calls.length,2);assert.ok(calls.every(c=>c[0]==='model/list'));
  await assert.rejects(()=>codexModelList(async()=>({data:[],nextCursor:'loop'})),/pagination_invalid/);
});
test('project settings are revision checked, preserved on reopen, and do not change captured operation choices',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-ai-settings-')));t.after(()=>rm(root,{recursive:true,force:true}));const codex=join(root,'codex'),claude=join(root,'claude');for(const p of [codex,claude])await writeFile(p,'#!/bin/sh\nexit 0\n',{mode:0o700});
  let fail=false;const config={root:join(root,'settings'),configured:[{tool:'codex' as const,path:codex},{tool:'claude' as const,path:claude}],disabledMcpServers:[]};
  const probe=async(tool:AIProgram,path:string,directory:string):Promise<AIProvider>=>({id:hash(JSON.stringify([tool,path])).slice(0,24),tool,path,version:'future version',available:!fail&&[codex,claude].includes(path),reason:fail?'ai_probe_unavailable':null,authentication:'subscription',models:[{id:tool==='codex'?'fixture-astra':'sonnet',resolvedId:tool==='claude'?'fixture-sonnet':null,name:'Explicit fixture',description:'No model call',efforts:['max','xhigh'],defaultEffort:null,isDefault:true}],observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:tool==='codex',ownedControl:tool==='codex'},evidence:directory});
  let settings=await AISettings.open(config,probe);await settings.scan(scope());const catalog=settings.state(scope()).catalog,c=catalog.find(p=>p.path===codex)!,a=catalog.find(p=>p.path===claude)!;
  await settings.change(scope(),{revision:0,role:'secretary',choice:{providerId:c.id,model:'fixture-astra',effort:'max'}});const original=settings.snapshot(scope());
  await assert.rejects(()=>settings.change(scope(),{revision:0,role:'secretary',choice:null}),/revision_changed/);
  await assert.rejects(()=>settings.change(scope(),{revision:1,role:'secretary',choice:{providerId:a.id,model:'sonnet',effort:'xhigh'}}),/tools_not_supported/);
  await settings.change(scope(),{revision:1,role:'issue_owner',choice:{providerId:a.id,model:'sonnet',effort:'xhigh'}});assert.equal(settings.state(scope(2)).revision,0);
  const selected=settings.snapshot(scope());withAIPreferences(selected,()=>{assert.equal(currentAIChoice('issue_owner')!.tool,'claude');const p=participantWithAI({id:'owner',item:'a'.repeat(64),role:'issue_owner',tool:'codex',parent:null,executable:codex,executableSha256:'0'.repeat(64),disabledMcpServers:['fixture'],allowedInstructionSources:[{path:'/original/instruction',sha256:'0'.repeat(64)}]},scope().repository.fullName);assert.equal(p.participant.tool,'claude');assert.deepEqual(p.participant.aiModel,{model:'sonnet',effort:'xhigh'});assert.deepEqual(p.participant.allowedInstructionSources,[]);assert.throws(()=>participantWithAI(p.participant,'fixture/other'),/outside_project/);});
  withAIPreferences(original,()=>assert.equal(currentAIChoice('issue_owner'),undefined));assert.equal(currentAIChoice('secretary'),undefined);
  await settings.close();settings=await AISettings.open(config,probe);assert.equal(settings.snapshot(scope()).roles.issue_owner!.model,'sonnet');fail=true;await settings.scan(scope());const failed=settings.snapshot(scope());withAIPreferences(failed,()=>{assert.throws(()=>currentAIChoice('issue_owner'),/unavailable/);assert.equal(currentAIChoice('acceptance'),undefined);});await settings.close();
});
test('captured model selection verifies returned availability and actual launch, rather than a settings label',()=>{
  const choice={model:'fixture-astra',effort:'max'},sent=[{id:1,method:'model/list',params:{limit:50,includeHidden:false}}],received=[{id:1,result:{data:[{model:'fixture-astra',supportedReasoningEfforts:[{reasoningEffort:'max'}]}],nextCursor:null}}];
  capturedCodexModels(sent,received,choice);assert.throws(()=>capturedCodexModels([],received,choice),/proof_missing/);assert.throws(()=>capturedCodexModels(sent,[...received,...received],choice),/proof_changed/);assert.throws(()=>checkCodexSelected({model:'fallback',reasoningEffort:'max'},choice),/not_applied/);assert.throws(()=>checkCodexSelected({model:'fixture-astra',reasoningEffort:'high'},choice),/not_applied/);assert.deepEqual(codexTurnChoice(choice),{model:'fixture-astra',effort:'max'});
});
test('new default requests leave model and effort to the program; resuming derives values from the original turn',()=>{
  assert.deepEqual(codexThreadChoice(),{});assert.deepEqual(codexTurnChoice(),{});
  assert.deepEqual(codexTurnChoice({model:'future-model',effort:null}),{model:'future-model'});
  const thread={model:'original-model',reasoningEffort:'xhigh'};
  assert.deepEqual(recordedCodexTurnChoice(thread,{effort:'high'}),{model:'original-model',effort:'high'});
  assert.deepEqual(recordedCodexTurnChoice(thread,{}),{model:'original-model',effort:'xhigh'});
  assert.deepEqual(codexTurnChoice(recordedCodexTurnChoice(thread,{effort:'high'})),{model:'original-model',effort:'high'});
});

test('implementer is a distinct Codex setting; frozen project selection does not impose an Owner Issue number',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-implementer-setting-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const codex=join(root,'codex'),claude=join(root,'claude');for(const file of [codex,claude])await writeFile(file,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const probe=async(tool:AIProgram,path:string,directory:string):Promise<AIProvider>=>({id:path===codex?'codex':path===claude?'claude':hash(path),tool,path,version:'fixture',available:[codex,claude].includes(path),reason:null,authentication:'subscription',models:['model-a','model-b'].map(id=>({id,resolvedId:null,name:id,description:'fixture',efforts:['max'],defaultEffort:'max',isDefault:false})),observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:true,ownedControl:true},evidence:directory});
 const settings=await AISettings.open({root:join(root,'settings'),configured:[{tool:'codex',path:codex},{tool:'claude',path:claude}],disabledMcpServers:[]},probe);t.after(()=>settings.close());await settings.scan(scope());
 await settings.change(scope(),{revision:0,role:'issue_owner',choice:{providerId:'codex',model:'model-b',effort:'max'}});withAIPreferences(settings.snapshot(scope()),()=>assert.equal(captureImplementationAI(scope().repository.fullName),undefined));
 await assert.rejects(settings.change(scope(),{revision:1,role:'implementer',choice:{providerId:'claude',model:'model-a',effort:'max'}}),/implementer_codex/);
 await settings.change(scope(),{revision:1,role:'implementer',choice:{providerId:'codex',model:'model-a',effort:'max'}});const frozen=withAIPreferences(settings.snapshot(scope()),()=>captureImplementationAI(scope().repository.fullName))!;
 await settings.change(scope(),{revision:2,role:'implementer',choice:{providerId:'codex',model:'model-b',effort:'max'}});
 const request={implementationAI:frozen,adoptedScope:{source:'https://github.com/fixture/project-1/issues/9#issuecomment-101'},issue:{number:74}},plan={implementationAI:frozen};withAIPreferences(settings.snapshot(scope()),()=>assert.equal(implementationChoice(request,plan,{implementationAI:frozen})!.model,'model-a'));
 withAIPreferences(settings.snapshot(scope()),()=>assert.throws(()=>captureImplementationAI('fixture/another-project'),/outside_project/));
 assert.throws(()=>parseImplementationAI({...frozen,roles:{implementer:{...frozen.roles.implementer!,tool:'claude'}}}),/implementer_codex/);
 assert.throws(()=>implementationChoice(request,{implementationAI:settings.snapshot(scope())}),/original_model_changed/);
 assert.equal(implementationChoice({},{}),undefined);
});
