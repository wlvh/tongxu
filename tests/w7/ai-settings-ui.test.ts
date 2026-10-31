import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('two editors: refresh replaces untouched choices, while edited drafts retain their original revision until explicitly discarded',async()=>{
  const source=await readFile(new URL('../../../web/workbench/ai-settings.js',import.meta.url),'utf8'),context:any={};
  runInNewContext(source+'\nthis.sync=syncAISettings;this.reset=resetAIRoleDraft;',context);
  const page:any={drafts:new Map(),dirty:new Set(),draftRevisions:new Map()},choice=(model:string)=>({providerId:'provider',model,effort:'max'}),state=(revision:number,model:string)=>({revision,roles:[{id:'secretary'},{id:'issue_owner'}],choices:{secretary:choice(model)}});
  context.sync(page,state(1,'old'));context.sync(page,state(2,'changed-in-second-window'));assert.equal(page.drafts.get('secretary').model,'changed-in-second-window');assert.equal(page.draftRevisions.get('secretary'),2);
  page.dirty.add('secretary');page.drafts.set('secretary',choice('my-unsaved-edit'));context.sync(page,state(3,'another-editor-change'));
  assert.equal(page.value.revision,3);assert.equal(page.draftRevisions.get('secretary'),2);assert.equal(page.drafts.get('secretary').model,'my-unsaved-edit');assert.notEqual(page.draftRevisions.get('secretary'),page.value.revision);
  context.reset(page,'secretary');assert.equal(page.drafts.get('secretary').model,'another-editor-change');assert.equal(page.draftRevisions.get('secretary'),3);assert.equal(page.dirty.has('secretary'),false);
});

test('configuration preview separates observed program defaults, explicit role choices and unknown task plans',async()=>{
  const source=await readFile(new URL('../../../web/workbench/ai-settings.js',import.meta.url),'utf8'),context:any={date:(s:string)=>s};runInNewContext(source+'\nthis.summary=aiChoiceSummary;',context);
  const defaults={model:'configured-model',effort:'xhigh',source:'codex_config_read'},value={defaults:{secretary:{tool:'codex',path:'/current/codex',observed:defaults,observedAt:'2026-10-31T00:00:00Z'}},catalog:[{id:'c',tool:'codex',path:'/current/codex',defaults,models:[{id:'chosen-model',resolvedId:null}],observedAt:'2026-10-31T00:00:00Z'},{id:'a',tool:'claude',path:'/current/claude',models:[{id:'sonnet',resolvedId:'sonnet-current'}],observedAt:'2026-10-31T00:00:00Z'}]};
  let result=context.summary('secretary',null,value);assert.equal(result.model,'configured-model');assert.equal(result.effort,'xhigh');assert.match(result.source,/启动配置/);assert.match(result.source,/最近检测/);
  result=context.summary('issue_owner',null,value);assert.equal(result.program,'由具体任务决定');assert.equal(result.model,'由具体任务决定');assert.ok(!result.source.includes('configured-model'));
  result=context.summary('secretary',{providerId:'c',model:'chosen-model',effort:'max'},value);assert.equal(result.model,'chosen-model');assert.equal(result.effort,'max');
  result=context.summary('secretary',{providerId:'c',model:'chosen-model',effort:null},value);assert.equal(result.effort,'程序默认（最近检测：xhigh）');
  result=context.summary('issue_owner',{providerId:'a',model:'sonnet',effort:null},value);assert.match(result.model,/sonnet-current/);assert.match(result.effort,/未回报具体值/);assert.ok(!result.effort.includes('xhigh'));
  result=context.summary('secretary',null,{defaults:{secretary:{tool:'codex',path:'/current/codex',observed:null}}});assert.match(result.model,/未回报/);assert.match(result.source,/尚未检测/);
});
