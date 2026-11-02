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

const scope=(id=1)=>({account:{id:7},repository:{id,nodeId:'R_'+id,fullName:'fixture/project-'+id}});
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
