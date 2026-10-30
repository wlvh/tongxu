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
