import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {hash} from '../../src/snapshot.js';
import {selectExternalExecutable,assertExternalExecutable} from '../../src/external-executable.js';
import {selectGhExecutable,assertGhExecutableUnchanged} from '../../src/gh-executable.js';
import {executable,LiveProcess,checkCapture} from '../../src/live-process.js';
import {validateClampExpression} from '../../src/repair-workspace.js';
import {fixture} from '../resources/provider-fixture.js';
import {callResourceProvider} from '../../src/resource-provider.js';
import {publisherFixture} from '../merge/provider-fixture.js';
import {callMergeProvider,mergeCommand,readMergeProviderCapture} from '../../src/merge-provider.js';
import type {ManagedMergeBinding} from '../../src/merge-contract.js';

async function root(t:test.TestContext){const p=await realpath(await mkdtemp(join(tmpdir(),'tongxu-dependency-fixture-')));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('stable package entry follows an upgrade even after the old version directory is removed; an in-flight selection cannot change',async t=>{
  const p=await root(t),old=join(p,'Cellar/gh/1.0/bin/gh'),next=join(p,'Cellar/gh/999.0/bin/gh'),alias=join(p,'opt/gh');
  await mkdir(join(p,'opt'));await mkdir(join(p,'Cellar/gh/1.0/bin'),{recursive:true});await mkdir(join(p,'Cellar/gh/999.0/bin'),{recursive:true});
  const script=(version:string)=>`#!${process.execPath}\nif(process.argv.includes('--version'))console.log('gh version ${version}');else console.log('--hostname --method --include --input --header --raw-field');\n`;
  await writeFile(old,script('1.0'),{mode:0o700});await writeFile(next,script('999.0'),{mode:0o700});await symlink(join(p,'Cellar/gh/1.0'),alias);
  const initial=selectExternalExecutable(old),priorHash=initial.sha256;await rm(alias);await symlink(join(p,'Cellar/gh/999.0'),alias);await rm(join(p,'Cellar/gh/1.0'),{recursive:true});
  const current=await selectGhExecutable(old,priorHash);assert.equal(current.realpath,next);assert.match(current.version!,/999/);assertGhExecutableUnchanged(current);assert.throws(()=>assertExternalExecutable(initial),/changed_during_operation/);
  await appendFile(next,'// changed within the invocation\n');assert.throws(()=>assertGhExecutableUnchanged(current),/changed_during_operation/);
});
test('vendor stable symlink runs the currently probed program; completed capture needs no installed original binary',async t=>{
  const p=await root(t),binary=join(p,'codex-current'),entry=join(p,'codex'),dir=join(p,'capture');
  await writeFile(binary,`#!${process.execPath}\nif(process.argv.includes('--version'))console.log('codex-cli 999.0.0');else console.log(JSON.stringify({fixture:true}));\n`,{mode:0o700});await symlink(binary,entry);
  const identity=await executable(entry,{tool:'codex'},'fixture');assert.equal(identity.path,entry);assert.equal(identity.realpath,binary);
  await mkdir(dir);const child=new LiveProcess(dir,entry,[],p,{},undefined,identity.externalSelection);await child.closed;await child.close();await checkCapture(dir);await rm(binary);await checkCapture(dir);
  const launch=JSON.parse(await readFile(join(dir,'launch.json'),'utf8'));assert.equal(launch.command,entry);assert.equal(launch.executableSelection.realpath,binary);
});
test('resource helper upgrade preserves capabilities and lookup; replacing it after capabilities cannot dispatch a claim',async t=>{
  const f=await fixture(t),old=f.profile.executableSha256;await appendFile(f.profile.executable,'\n// compatible installed update\n');const cap=await f.call(f.cmd('capabilities'));assert.notEqual(cap.executableSelection!.sha256,old);
  assert.equal((await f.call(f.cmd('lookup'))).reply.result.state,'absent');await appendFile(f.profile.executable,'\n// changed after capability observation\n');let intents=0;
  await assert.rejects(callResourceProvider(f.profile,f.cmd('claim'),join(f.root,'changed-before-write'),()=>{intents++;},cap.executableSelection),/changed_during_operation/);assert.equal(intents,0);assert.equal(f.state().claims.length,0);
  const fresh=await f.call(f.cmd('capabilities'));const claimed=await callResourceProvider(f.profile,f.cmd('claim'),join(f.root,'fresh-write'),()=>{intents++;},fresh.executableSelection);assert.equal(claimed.reply.result.state,'present');assert.equal(f.state().claims.length,1);
});
const b:ManagedMergeBinding={schemaVersion:1,operation:'00000000-0000-4000-8000-000000000001',item:'a'.repeat(64),packet:1,repository:'fixture/reception',repositoryId:99,pr:1,H:'a'.repeat(40),B:'b'.repeat(40),targetRef:'main',T:'c'.repeat(40),receptionOperation:'00000000-0000-4000-8000-000000000001',judgmentId:'fixture',receptionBindingHash:'b'.repeat(64),authorityIntent:'explicit-test-only',resourceRequests:['c'.repeat(64)],scope:{id:'fixture',version:'1',bodySha256:'d'.repeat(64)},arrangement:{id:'fixture',version:'1'},subjectSha256:null,integrationReference:null,method:'merge'};
test('publisher upgrade accepts a stable entry; a changed provider cannot reuse old capability evidence, and historical result remains readable',async t=>{
  const f=await publisherFixture(t,b),original=f.profile.executable,entry=join(f.root,'publisher');await symlink(original,entry);f.profile.executable=entry;await appendFile(original,'\n// compatible provider update\n');
  const c=mergeCommand(b,'capabilities'),dir=join(f.root,'cap'),cap=await callMergeProvider(f.profile,c,dir);assert.notEqual(cap.executableSelection!.sha256,f.profile.executableSha256);
  await appendFile(original,'\n// replaced between preflight and send\n');let intents=0;await assert.rejects(callMergeProvider(f.profile,mergeCommand(b,'merge'),join(f.root,'write'),()=>{intents++;},cap.executableSelection),/changed_during_operation/);assert.equal(intents,0);assert.equal(f.state().merges,0);
  const before=hash(await readFile(join(dir,'stdout.ndjson')));await rm(original);const recovered=await readMergeProviderCapture(f.profile,c,dir);assert.deepEqual(recovered.reply,cap.reply);assert.equal(hash(await readFile(join(dir,'stdout.ndjson'))),before);assert.equal(f.state().merges,0);
});
test('runtime parser enforces the original pure expression boundary independently of the installed TypeScript compiler',()=>{
  const module=(expression:string)=>`export function clamp(value,low,high){return ${expression};}`;
  for(const expression of ['Math.min(high,Math.max(low,value))','value<low?low:value>high?high:value','(value + low) ** 2 / high','value && low || high','!value ? -low : +high'])assert.equal(validateClampExpression(module(expression)).accepted,true);
  for(const expression of ['process.exit()','Math["min"](low,value)','Math.min?.(low,value)','Math.min(...value)','value.constructor','value=high','value++','(()=>value)()','import("fs")','new Function("return 1")()','value,high','1n','/x/','"text"','Infinity','Math.random()','Math.min()'])assert.throws(()=>validateClampExpression(module(expression)),Error,expression);
  for(const source of ['export async function clamp(v,l,h){return v;}','export function* clamp(v,l,h){return v;}','export function clamp(v,l,h=1){return v;}','export function clamp(v,...l){return v;}','export function clamp(Math,l,h){return Math.min(l,h);}',module('value')+'\nprocess.exit();',module('value')+'\nexport const x=1;','export function clamp(v,l,h){let x=v;return x;}'])assert.throws(()=>validateClampExpression(source));
});


test('Claude desktop updates resolve the current installed entry without pinning an old version directory',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-claude-desktop-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const old=join(root,'Claude/claude-code/1.0.0/old/claude.app/Contents/MacOS/claude'),current=join(root,'Claude/claude-code/99.7.0/new/claude.app/Contents/MacOS/claude');await mkdir(dirname(old),{recursive:true});await writeFile(old,'#!/bin/sh\nexit 0\n',{mode:0o700});const before=selectExternalExecutable(old);await mkdir(dirname(current),{recursive:true});await writeFile(current,'#!/bin/sh\n# new installed version\nexit 0\n',{mode:0o700});await rm(join(root,'Claude/claude-code/1.0.0'),{recursive:true});const after=selectExternalExecutable(old);assert.equal(after.realpath,current);assert.notEqual(after.sha256,before.sha256);assert.throws(()=>assertExternalExecutable(before),/changed_during_operation/);
});
