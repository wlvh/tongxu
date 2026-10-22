import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm,cp,access,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareWorkbenchRuntime,inspectWorkbenchRuntime,launchWorkbench} from '../../src/workbench-launch.js';
import {hash} from '../../src/snapshot.js';
test('one fixed runtime detects stale source, build, configuration and file additions before importing any selected program',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-launch-manifest-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'composition');await mkdir(source);for(const d of ['dist/src','src','web/workbench'])await mkdir(join(source,d),{recursive:true});
 await writeFile(join(source,'src/selected.ts'),'// explicit fixture source\n');await writeFile(join(source,'dist/src/workbench.js'),'throw new Error("must_never_import_other_composition");\n');await writeFile(join(source,'package.json'),'{"type":"module"}\n');for(const name of ['index.html','app.js','app.css','favicon.svg'])await writeFile(join(source,'web/workbench',name),'explicit fixture '+name+'\n');
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',source,...args],{encoding:'utf8'}).trim();git('init','--initial-branch=fixture');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','bounded launcher fixture');
 const plan=join(root,'plan.json');await writeFile(plan,'{"kind":"explicit fixture, never launched"}\n');const manifest=await prepareWorkbenchRuntime(source,plan),raw=Buffer.from(JSON.stringify(manifest)),runtimePath=join(root,'runtime.json');await writeFile(runtimePath,raw);
 assert.equal((await inspectWorkbenchRuntime(raw)).identity.sourceHead,git('rev-parse','HEAD'));await assert.rejects(launchWorkbench(runtimePath),/wrong_launcher/);
 await writeFile(plan,'changed plan');await assert.rejects(inspectWorkbenchRuntime(raw),/plan_changed/);await writeFile(plan,'{"kind":"explicit fixture, never launched"}\n');
 const modulePath=join(source,'dist/src/workbench.js'),module=await readFile(modulePath);await writeFile(modulePath,'changed build');await assert.rejects(inspectWorkbenchRuntime(raw),/build_changed/);await writeFile(modulePath,module);
 const extra=join(source,'dist/src/extra.js');await writeFile(extra,'additional module');await assert.rejects(inspectWorkbenchRuntime(raw),/file_set_changed/);await rm(extra);
 await writeFile(join(source,'src/selected.ts'),'modified source');await assert.rejects(inspectWorkbenchRuntime(raw),/source_changed/);await writeFile(join(source,'src/selected.ts'),'// explicit fixture source\n');
 await assert.rejects(inspectWorkbenchRuntime(Buffer.from(JSON.stringify({...manifest,files:[...manifest.files,{path:'../outside',sha256:hash('x')}]}))),/manifest_invalid/);
 assert.equal((await inspectWorkbenchRuntime(raw)).identity.planSha256,manifest.plan.sha256);
});

test('cold launcher checks a modified application helper before its module body can execute',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-launch-before-import-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'composition');await mkdir(join(source,'dist'),{recursive:true});await mkdir(join(source,'src'));await mkdir(join(source,'web'));
 await cp(fileURLToPath(new URL('../../src/',import.meta.url)),join(source,'dist/src'),{recursive:true});await cp(fileURLToPath(new URL('../../../web/workbench/',import.meta.url)),join(source,'web/workbench'),{recursive:true});await writeFile(join(source,'package.json'),'{"type":"module"}\n');await writeFile(join(source,'src/selected.ts'),'// Explicit launch-boundary fixture; no real model or application request.\n');
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',source,...args],{encoding:'utf8'});git('init','--initial-branch=fixture');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','explicit launch boundary');const plan=join(root,'plan.json');await writeFile(plan,'{}');const manifest=await prepareWorkbenchRuntime(source,plan),path=join(root,'runtime.json');await writeFile(path,JSON.stringify(manifest));
 const helper=join(source,'dist/src/snapshot.js'),marker=join(root,'unexpected-module-body');await writeFile(helper,(await readFile(helper,'utf8'))+'\n(await import("node:fs")).writeFileSync('+JSON.stringify(marker)+',"executed");\n');
 const result=spawnSync(process.execPath,[join(source,'dist/src/workbench-launch.js'),'--runtime',path],{encoding:'utf8',timeout:10000});assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/workbench_runtime_build_changed/);await assert.rejects(access(marker),{code:'ENOENT'});
});
