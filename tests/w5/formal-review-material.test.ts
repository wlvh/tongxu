import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {formalReviewMaterial,readFormalSource,type FormalMaterialRequest} from '../../src/formal-review-material.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

async function fixture(t:test.TestContext){
 const objects=await realpath(await mkdtemp(join(tmpdir(),'tongxu-formal-material-')));t.after(()=>rm(objects,{recursive:true,force:true}));
 const git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],{cwd:objects,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','--template=','--initial-branch=main']);await mkdir(join(objects,'src'));await mkdir(join(objects,'outside'));
 for(const [path,text] of [['AGENTS.md','Required project rules\n'],['SOP.md','Required workflow\n'],['src/allowed.mjs','export const value=1;\n'],['outside/caller.mjs','export const caller=1;\n'],['outside/AGENTS.md','Required nested caller rules\n']])await writeFile(join(objects,path!),text!);
 git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','formal base']);const B=git(['rev-parse','HEAD']);
 await writeFile(join(objects,'src/allowed.mjs'),'export const value=2;\n');await writeFile(join(objects,'outside/caller.mjs'),'export const caller=2; // review this despite a narrower repair grant\n');git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','formal candidate']);const H=git(['rev-parse','HEAD']);
 const issue={number:8,body:'Review the complete PR, including its real caller.',url:'https://github.com/fixture/review/issues/8'},adoptedScope={goals:['Complete review'],preserve:['Original results'],acceptance:['Read the caller']};
 const request:FormalMaterialRequest={objects,candidate:{repository:'fixture/review',pr:7,H,B,target:'main',requirementsSha256:hash(canonical({issue,adoptedScope}))},issue,adoptedScope,requiredPaths:[],contextPaths:[]};return {objects,git,request};
}
test('formal review material contains the full PR and nested rules beyond any eventual writable subset',async t=>{
 const f=await fixture(t),material=await formalReviewMaterial(f.request);assert.deepEqual(material.changedPaths,['outside/caller.mjs','src/allowed.mjs']);assert.match(material.diff,/narrower repair grant/);assert.ok(material.files.some(f=>f.path==='outside/AGENTS.md'&&f.text==='Required nested caller rules\n'));assert.ok(material.files.some(f=>f.path==='SOP.md'));assert.ok(material.files.some(f=>f.path==='outside/caller.mjs'&&f.revision==='base'&&f.text==='export const caller=1;\n'));
 await writeFile(join(f.objects,'outside/caller.mjs'),'uncommitted bytes cannot enter this original\n');const again=await formalReviewMaterial(f.request);assert.equal(again.sha256,material.sha256);assert.ok(!canonical(again).includes('uncommitted bytes'));assert.equal(f.git(['rev-parse','HEAD']),f.request.candidate.H);
});
test('formal material refuses changed adopted requirements or missing mandatory context before any model',async t=>{
 const f=await fixture(t);await assert.rejects(formalReviewMaterial({...f.request,issue:{...f.request.issue,body:'Changed after adoption'}}),/requirements_or_source_binding/);await assert.rejects(formalReviewMaterial({...f.request,contextPaths:['missing-caller.mjs']}),/required_context_missing/);await assert.rejects(formalReviewMaterial({...f.request,requiredPaths:['../outside-project']}),/context_paths_invalid/);
});

test('additional formal caller reads use immutable original objects and refuse paths outside the selected repository',async t=>{const f=await fixture(t),original=await readFormalSource(f.objects,f.request.candidate.H,'outside/caller.mjs');await writeFile(join(f.objects,'outside/caller.mjs'),'uncommitted replacement');assert.deepEqual(await readFormalSource(f.objects,f.request.candidate.H,'outside/caller.mjs'),original);assert.match(original.text,/narrower repair grant/);await assert.rejects(readFormalSource(f.objects,f.request.candidate.H,'../outside'),/source_read_invalid/);await assert.rejects(readFormalSource(f.objects,f.request.candidate.H,'.git/config'),/source_read_invalid/);await assert.rejects(readFormalSource(f.objects,f.request.candidate.H,'missing-caller'),/path_not_regular/);});
