import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm,cp,access,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareWorkbenchRuntime,inspectWorkbenchRuntime,launchWorkbench,minimumNodeVersion,supportedNodeVersion,requireNodeRuntime,renderWorkbenchLauncher} from '../../src/workbench-launch.js';
import {hash} from '../../src/snapshot.js';
test('one fixed runtime detects stale source, build, configuration and file additions before importing any selected program',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-launch-manifest-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'composition');await mkdir(source);for(const d of ['dist/src','src','web/workbench'])await mkdir(join(source,d),{recursive:true});
 await writeFile(join(source,'src/selected.ts'),'// explicit fixture source\n');await writeFile(join(source,'dist/src/workbench.js'),'throw new Error("must_never_import_other_composition");\n');await writeFile(join(source,'package.json'),'{"type":"module"}\n');for(const name of ['index.html','app.js','app.css','favicon.svg'])await writeFile(join(source,'web/workbench',name),'explicit fixture '+name+'\n');
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',source,...args],{encoding:'utf8'}).trim();git('init','--initial-branch=fixture');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','bounded launcher fixture');
 const plan=join(root,'plan.json');await writeFile(plan,'{"kind":"explicit fixture, never launched"}\n');const manifest=await prepareWorkbenchRuntime(source,plan),raw=Buffer.from(JSON.stringify(manifest)),runtimePath=join(root,'runtime.json');await writeFile(runtimePath,raw);
 assert.equal((await inspectWorkbenchRuntime(raw)).identity.sourceHead,git('rev-parse','HEAD'));await assert.rejects(launchWorkbench(runtimePath),/wrong_launcher/);
 const oldBuild={...manifest,nodeVersion:'v24.0.0'},identity=(await inspectWorkbenchRuntime(Buffer.from(JSON.stringify(oldBuild)))).identity;
 assert.equal(identity.nodeVersion,process.version);assert.equal(identity.buildNodeVersion,'v24.0.0');assert.equal(identity.minimumNodeVersion,'24.0.0');assert.equal(identity.nodeExecutable,process.execPath);assert.equal(oldBuild.nodeVersion,'v24.0.0');
 await writeFile(plan,'changed plan');await assert.rejects(inspectWorkbenchRuntime(raw),/plan_changed/);await writeFile(plan,'{"kind":"explicit fixture, never launched"}\n');
 const modulePath=join(source,'dist/src/workbench.js'),module=await readFile(modulePath);await writeFile(modulePath,'changed build');await assert.rejects(inspectWorkbenchRuntime(raw),/build_changed/);await writeFile(modulePath,module);
 const extra=join(source,'dist/src/extra.js');await writeFile(extra,'additional module');await assert.rejects(inspectWorkbenchRuntime(raw),/file_set_changed/);await rm(extra);
 await writeFile(join(source,'src/selected.ts'),'modified source');await assert.rejects(inspectWorkbenchRuntime(raw),/source_changed/);await writeFile(join(source,'src/selected.ts'),'// explicit fixture source\n');
 await assert.rejects(inspectWorkbenchRuntime(Buffer.from(JSON.stringify({...manifest,files:[...manifest.files,{path:'../outside',sha256:hash('x')}]}))),/manifest_invalid/);
 assert.equal((await inspectWorkbenchRuntime(raw)).identity.planSha256,manifest.plan.sha256);
});

test('Node admission has a minimum and actual transaction capability, without a release whitelist',async()=>{
 assert.equal(minimumNodeVersion,'24.0.0');
 for(const version of ['v24.0.0','v24.22.1','v25.0.0','v30.5.8'])assert.equal(supportedNodeVersion(version),true,version);
 for(const version of ['v23.10.0','v22.16.0','v24','unknown','v99999999999999999.0.0'])assert.equal(supportedNodeVersion(version),false,version);
 assert.equal((await requireNodeRuntime()).nodeVersion,process.version);
 const module= fileURLToPath(new URL('../../src/workbench-launch.js',import.meta.url));
 const result=spawnSync(process.execPath,['--no-experimental-sqlite','--input-type=module','-e',`const m=await import(${JSON.stringify(module)});await m.requireNodeRuntime();`],{encoding:'utf8',timeout:10000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/node_sqlite_capability_unavailable/);
 const metadata=JSON.parse(await readFile(fileURLToPath(new URL('../../../package.json',import.meta.url)),'utf8'));assert.equal(metadata.engines.node,'>='+minimumNodeVersion);
});

test('normal launcher discovers current Node; changed binary and path keep the same manifest, invalid explicit choice never falls back',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-current-node-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,"composition ' with spaces");await mkdir(join(source,'dist/src'),{recursive:true});await mkdir(join(source,'src'));await mkdir(join(source,'web/workbench'),{recursive:true});
 await cp(fileURLToPath(new URL('../../src/workbench-launch.js',import.meta.url)),join(source,'dist/src/workbench-launch.js'));
 await writeFile(join(source,'dist/src/workbench.js'),'export async function startWorkbench(){return {mode:"explicit_fixture",url:"http://127.0.0.1:0/#not-listening",close:async()=>{}}}\n');
 await writeFile(join(source,'src/selected.ts'),'// explicit no-model launcher fixture\n');await writeFile(join(source,'package.json'),'{"type":"module"}\n');for(const name of ['index.html','app.js','app.css','favicon.svg'])await writeFile(join(source,'web/workbench',name),'explicit fixture\n');
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',source,...args]);git('init','--initial-branch=fixture');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','explicit current Node fixture');
 const plan=join(root,'plan.json'),runtime=join(root,'runtime.json'),entry=join(root,'START.command');await writeFile(plan,'{}');const manifest=await prepareWorkbenchRuntime(source,plan);manifest.nodeVersion='v24.0.0';await writeFile(runtime,JSON.stringify(manifest));await writeFile(entry,await renderWorkbenchLauncher(runtime),{mode:0o700});
 const wrapper=join(root,'node'),other=join(root,'other-node'),quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'",script='#!/bin/sh\nexec '+quote(process.execPath)+' "$@"\n';await writeFile(wrapper,script,{mode:0o700});await writeFile(other,script+'# another current entry\n',{mode:0o700});
 const before=await readFile(runtime),launch=(selected:string|undefined)=>spawnSync('/bin/zsh',[entry,'--no-open'],{encoding:'utf8',timeout:15000,env:{...process.env,PATH:root+':/usr/bin:/bin',TONGXU_NODE:selected}});
 for(const selected of [undefined,wrapper,other]){const result=launch(selected);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).runtime.nodeVersion,process.version);assert.equal(JSON.parse(result.stdout).runtime.buildNodeVersion,'v24.0.0');}
 await writeFile(wrapper,script+'# ordinary update at the same path\n',{mode:0o700});assert.equal(launch(undefined).status,0);assert.deepEqual(await readFile(runtime),before);
 const bad=join(root,'unsupported-node');await writeFile(bad,'#!/bin/sh\nexit 78\n',{mode:0o700});const refused=launch(bad);assert.equal(refused.status,1);assert.match(refused.stderr,/24\.0\.0/);assert.equal(refused.stdout,'');
 const older=join(root,'older'),later=join(root,'later');await mkdir(older);await mkdir(later);await cp(bad,join(older,'node'));await cp(wrapper,join(later,'node'));
 const throughPath=spawnSync('/bin/zsh',[entry,'--no-open'],{encoding:'utf8',timeout:15000,env:{...process.env,PATH:older+':'+later+':/usr/bin:/bin',TONGXU_NODE:undefined}});assert.equal(throughPath.status,0,throughPath.stderr);assert.equal(JSON.parse(throughPath.stdout).runtime.nodeVersion,process.version);
 // Model a host without any global fallback installation, changing only the
 // test environment's fallback locations, not the selection/check algorithm.
 const isolated=join(root,'isolated-START.command'),generated=await readFile(entry,'utf8'),withoutFallbacks=generated.replace(/  tx_candidates\+=\(\/opt\/homebrew\/bin\/node[^\n]+\)/,'  tx_candidates+=()');assert.notEqual(withoutFallbacks,generated);await writeFile(isolated,withoutFallbacks,{mode:0o700});await cp(bad,join(later,'node'));
 const allOld=spawnSync('/bin/zsh',[isolated,'--no-open'],{encoding:'utf8',timeout:15000,env:{...process.env,PATH:older+':'+later+':/usr/bin:/bin',TONGXU_NODE:undefined}});assert.equal(allOld.status,1);assert.match(allOld.stderr,/24\.0\.0/);assert.equal(allOld.stdout,'');
 const replacing=join(root,'replacing-node'),marker=join(root,'unexpected-second-node-call');await writeFile(replacing,'#!/bin/sh\n{\n/bin/cat > "$0" <<\'NEXT\'\n#!/bin/sh\n/usr/bin/touch '+quote(marker)+'\nexit 99\nNEXT\nexec '+quote(process.execPath)+' "$@"\n}\n',{mode:0o700});
 const once=launch(replacing);assert.equal(once.status,0,once.stderr);assert.equal(JSON.parse(once.stdout).runtime.nodeVersion,process.version);await assert.rejects(access(marker),{code:'ENOENT'});
 assert.doesNotMatch(await readFile(entry,'utf8'),/runtime\/node\/|tx_check_file "\$tx_node"/);
});

test('cold launcher checks a modified application helper before its module body can execute',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-launch-before-import-')));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'composition');await mkdir(join(source,'dist'),{recursive:true});await mkdir(join(source,'src'));await mkdir(join(source,'web'));
 await cp(fileURLToPath(new URL('../../src/',import.meta.url)),join(source,'dist/src'),{recursive:true});await cp(fileURLToPath(new URL('../../../web/workbench/',import.meta.url)),join(source,'web/workbench'),{recursive:true});await writeFile(join(source,'package.json'),'{"type":"module"}\n');await writeFile(join(source,'src/selected.ts'),'// Explicit launch-boundary fixture; no real model or application request.\n');
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',source,...args],{encoding:'utf8'});git('init','--initial-branch=fixture');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@localhost','commit','-m','explicit launch boundary');const plan=join(root,'plan.json');await writeFile(plan,'{}');const manifest=await prepareWorkbenchRuntime(source,plan),path=join(root,'runtime.json');await writeFile(path,JSON.stringify(manifest));
 const helper=join(source,'dist/src/snapshot.js'),marker=join(root,'unexpected-module-body');await writeFile(helper,(await readFile(helper,'utf8'))+'\n(await import("node:fs")).writeFileSync('+JSON.stringify(marker)+',"executed");\n');
 const result=spawnSync(process.execPath,[join(source,'dist/src/workbench-launch.js'),'--runtime',path],{encoding:'utf8',timeout:10000});assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/workbench_runtime_build_changed/);await assert.rejects(access(marker),{code:'ENOENT'});
});
