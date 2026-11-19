import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,realpath,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replacementText,implementationEditProfile} from '../../src/repair-edits.js';
import {verifyImplementationModel} from '../../src/implementation-ai.js';
import {verifyImplementationEdits,replayImplementationWrite,retainedProjectAdditions} from '../../src/implementation-edits.js';
import {canonical} from '../../src/comparison.js';
import {RepairTools,acquireWorkspace,releaseWorkspace,tree,treeHash,git,projectRepairToolSpecs,projectRepairToolsFor,projectFileMovesVersion} from '../../src/repair-workspace.js';
import {fixture} from './repair-fixture.js';
import {hash} from '../../src/snapshot.js';
const profile='literal-edits-v1',args=(edits:unknown)=>({path:'source.txt',expectedSha256:'a'.repeat(64),edits});
test('both implementation readers enforce the original project-file tool version and exact declarations',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tongxu-project-tool-profile-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const prompt={system:'Fixed project owner prompt'},request={workspaceRequest:{projectFiles:true,protectedPaths:[]},editProfile:profile,workflowPrompt:prompt};
 const state={plan:{request,operationRoot:root},result:{}},plan={editProfile:profile};
 const legacy=projectRepairToolsFor(profile,true),current=projectRepairToolsFor(profile,true,projectFileMovesVersion);
 // Canonical digest of the entire declaration at 3614c373, including schemas and descriptions.
 assert.equal(hash(canonical(legacy)),'30d2e7a5e87a305d3ba3d464d97b193af6ae093e2db70b0c004f370146f85e3f');
 await writeFile(join(root,'initial-tree.json'),'{}');
 await writeFile(join(root,'reconciled-tools.json'),'[]');
 await writeFile(join(root,'stdout.ndjson'),JSON.stringify({id:1,result:{}})+'\n');
 for(const {version,tools,valid} of [
  {version:undefined,tools:legacy,valid:true},
  {version:projectFileMovesVersion,tools:current,valid:true},
  {version:undefined,tools:current,valid:false},
  {version:projectFileMovesVersion,tools:legacy,valid:false},
  {version:projectFileMovesVersion,tools:current.slice(0,-1),valid:false},
  {version:projectFileMovesVersion,tools:current.map(tool=>({...tool,description:'Changed description'})),valid:false},
  {version:'unknown',tools:current,valid:false}
 ]){
  const manifest={prompt,editProfile:profile,...(version?{projectFileToolsVersion:version}:{})};
  const wire=JSON.stringify({id:1,method:'thread/start',params:{baseInstructions:prompt.system,dynamicTools:tools}})+'\n';
  await writeFile(join(root,'stdin.ndjson'),wire);
  if(valid){
   await verifyImplementationModel(request,plan,manifest,root);
   await verifyImplementationEdits(state,plan,manifest,root);
  }else{
   await assert.rejects(verifyImplementationModel(request,plan,manifest,root),/implementation_edit_profile_changed/);
   await assert.rejects(verifyImplementationEdits(state,plan,manifest,root),/implementation_(project_file_capture|edit_profile)_changed/);
  }
  assert.equal(await readFile(join(root,'stdin.ndjson'),'utf8'),wire);
 }
});

test('project-file replay preserves legal root keys and rejects invalid remove or move receipts',()=>{
 const file={sha256:hash('source'),bytes:6,text:'source',executable:0o111};
 const initial={source:file,occupied:file,protected:file},scope={protectedPaths:['protected']};
 const move={tool:'tongxu_rename_file',arguments:{path:'source',destination:'__proto__',expectedSha256:file.sha256}};
 const remove={tool:'tongxu_delete_file',arguments:{path:'source',expectedSha256:file.sha256}};
 const receipt={beforeFile:file,status:'applied'};
 const moved=replayImplementationWrite({...initial},move,receipt,[],profile,scope);
 assert.equal(Object.hasOwn(moved,'__proto__'),true);
 assert.equal(Object.hasOwn(moved,'source'),false);
 assert.deepEqual(moved['__proto__'],file);
 for(const [request,record] of [
  [remove,{...receipt,beforeFile:{...file,executable:0}}],
  [{...remove,arguments:{...remove.arguments,path:'protected'}},receipt],
  [{...move,arguments:{...move.arguments,path:'../source'}},receipt],
  ...['../outside','protected','occupied'].map(destination=>[{...move,arguments:{...move.arguments,destination}},receipt])
 ]){
  assert.throws(()=>replayImplementationWrite({...initial},request,record,[],profile,scope),/implementation_edit_receipt_changed/);
 }
});
test('retained project move reports its unstaged target only while the applied receipt matches',async t=>{
 const f=await fixture(t),index=join(f.workspace,'.git/index'),originalIndex=await readFile(index);
 const source='clamp.mjs',destination='__proto__',initial=await tree(f.workspace,true),file=initial[source]!;
 const calls=join(f.operation,'calls');
 await mkdir(calls,{recursive:true,mode:0o700});
 await writeFile(join(f.operation,'initial-tree.json'),JSON.stringify(initial));
 const request={tool:'tongxu_rename_file',callId:'fixture-move',arguments:{path:source,destination,expectedSha256:file.sha256}},receipt={request,status:'applied',beforeFile:file};
 const receiptPath=join(calls,request.callId+'.json'),original=JSON.stringify(receipt);
 await rename(join(f.workspace,source),join(f.workspace,destination));
 await writeFile(receiptPath,original);
 const H0=await git(f.workspace,['rev-parse','HEAD']);
 await writeFile(join(f.workspace,'.git','tongxu-managed.json'),JSON.stringify({kind:'owned-project-workspace',initialH:H0,initialTreeSha256:treeHash(initial)}));
 const read=()=>retainedProjectAdditions(f.workspace,f.operation,H0,{protectedPaths:[]});
 const retained=await read();
 assert.deepEqual(retained.additions,[destination]);
 assert.match(retained.diff,/\+\+\+ b\/__proto__/);
 assert.deepEqual(await readFile(index),originalIndex);
 assert.equal(await readFile(receiptPath,'utf8'),original);
 await writeFile(receiptPath,JSON.stringify({...receipt,beforeFile:{...file,sha256:'f'.repeat(64)}}));
 assert.deepEqual(await read(),{additions:[],diff:''});
});
test('literal edits address the same original text, preserve bytes and interpret dollar strings literally',()=>{
 const before='\uFEFFα\r\nA😀B\r\nend',p=args([{oldText:'A',newText:'$&$1$`'},{oldText:'B',newText:''},{oldText:'end',newText:'尾'}]);
 assert.equal(replacementText(p,Buffer.from(before),profile),'\uFEFFα\r\n$&$1$`😀\r\n尾');
 assert.equal(replacementText(args([{oldText:'ab',newText:'a'},{oldText:'cd',newText:'c'}]),Buffer.from('abcd'),profile),'ac');
 assert.equal(replacementText(args([{oldText:'b',newText:'b'}]),Buffer.from('abc'),profile),'abc');
 assert.equal(replacementText({path:'p',expectedSha256:'h',text:'old full text'},Buffer.from('old')),'old full text');
 assert.deepEqual(projectRepairToolsFor(),projectRepairToolSpecs);
 assert.throws(()=>implementationEditProfile({editProfile:profile},{editProfile:undefined}),/profile_changed/);
 assert.throws(()=>implementationEditProfile({editProfile:'unknown'},{editProfile:'unknown'}),/profile_invalid/);
});
test('literal edits refuse ambiguity, overlap, invalid encoding, mixed forms and bounded inputs before writing',()=>{
 const bad:Array<[unknown,Buffer]>=[
  [args([]),Buffer.from('abc')],[args([{oldText:'',newText:'x'}]),Buffer.from('abc')],
  [args([{oldText:'z',newText:'x'}]),Buffer.from('abc')],[args([{oldText:'aaa',newText:'x'}]),Buffer.from('aaaa')],
  [args([{oldText:'abc',newText:'x'},{oldText:'bc',newText:'x'}]),Buffer.from('abc')],
  [{...args([{oldText:'a',newText:'b'}]),text:'mixed'},Buffer.from('abc')],
  [args([{oldText:'a',newText:'\ud800'}]),Buffer.from('abc')],[args([{oldText:'a',newText:'\0'}]),Buffer.from('abc')],
  [args([{oldText:'a',newText:'x',extra:1}]),Buffer.from('abc')],
  [args([{oldText:'a',newText:'b'}]),Buffer.from([0xff])],
  [args([{oldText:'\uFEFF',newText:''}]),Buffer.from('\uFEFFabc')],
  [args([{oldText:'a',newText:'x'.repeat(16385)}]),Buffer.from('a')],
  [args([{oldText:'a',newText:'x'.repeat(16384)},{oldText:'b',newText:'x'.repeat(16384)}]),Buffer.from('ab')],
  [args(Array.from({length:17},()=>({oldText:'a',newText:'b'}))),Buffer.from('abc')],
  [args([{oldText:'last',newText:'moretext'}]),Buffer.from('x'.repeat(256*1024-4)+'last')],
  [{...args([{oldText:'a',newText:'b'}]),path:'x'.repeat(65536)},Buffer.from('a')]
 ];
 for(const [p,before] of bad)assert.throws(()=>replacementText(p,before,profile));
 assert.throws(()=>replacementText(args([{oldText:'a',newText:'b'}]),Buffer.from('a')),/outside_grant/);
 assert.throws(()=>replacementText({path:'p',expectedSha256:'h',text:'\uFEFFadded'},Buffer.from('old'),profile),/bom_changed/);
 const full='x'.repeat(200000);assert.equal(replacementText({path:'p',expectedSha256:'h',text:full},Buffer.from('old'),profile),full);assert.throws(()=>replacementText({path:'p',expectedSha256:'h',text:'x'.repeat(256*1024+1)},Buffer.from('old'),profile),/result_limit/);
 const limit='x'.repeat(16383);assert.equal(replacementText(args([{oldText:limit+'a',newText:'y'.repeat(16384)}]),Buffer.from(limit+'a'),profile).length,16384);
 assert.equal(Buffer.byteLength(replacementText(args([{oldText:'last',newText:'LAST'}]),Buffer.from('x'.repeat(256*1024-4)+'last'),profile)),256*1024);
});
test('new-profile host uses the original atomic writer, receipts, hash, handoff, duplicate and final fence',async t=>{
 const f=await fixture(t);await mkdir(f.operation,{mode:0o700});const grant=JSON.parse(await readFile(f.grantPath,'utf8')),current=await tree(f.workspace),lease=await acquireWorkspace(f.workspace,f.operation,false,grant);
 let denied=false;const gate=new RepairTools(f.workspace,f.operation,grant,lease,process.execPath,current,grant.H,undefined,effect=>{if(denied&&effect)throw Error('test_final_stop');effect?.();},undefined,undefined,profile),path=join(f.workspace,'clamp.mjs'),before=await readFile(path);
 const p={tool:'tongxu_replace_file',callId:'literal-once',arguments:{path:'clamp.mjs',expectedSha256:hash(before),edits:[{oldText:'return',newText:'return /* $& literal */'}]}};
 await assert.rejects(gate.call(p),/outside_grant/);await gate.handoff('fixture-context');const response=await gate.call(p);assert.deepEqual(await gate.call(p),response);
 const receipt=JSON.parse(await readFile(join(f.operation,'calls/literal-once.json'),'utf8'));assert.deepEqual(receipt.request,p);assert.equal(receipt.afterText,replacementText(p.arguments,before,profile));assert.equal(receipt.afterSha256,hash(await readFile(path)));assert.equal(receipt.afterTreeSha256,treeHash(await tree(f.workspace)));assert.equal(receipt.afterExecutable,receipt.beforeExecutable);
 await assert.rejects(gate.call({...p,callId:'stale'}),/stale_input/);assert.equal(await readFile(path,'utf8'),receipt.afterText);
 const second={...p,callId:'literal-stopped',arguments:{...p.arguments,expectedSha256:receipt.afterSha256}};denied=true;await assert.rejects(gate.call(second),/test_final_stop/);assert.equal(await readFile(path,'utf8'),receipt.afterText);assert.equal(JSON.parse(await readFile(join(f.operation,'calls/literal-stopped.json'),'utf8')).status,'write_registered');denied=false;await assert.rejects(gate.call(second),/duplicate_tool_call_not_reconciled/);assert.equal(await readFile(path,'utf8'),receipt.afterText);
});

test('known failed release preserves a partial release intent and refuses corrupt history before touching the own lease',async t=>{
 const f=await fixture(t);await mkdir(f.operation,{mode:0o700});const grant=JSON.parse(await readFile(f.grantPath,'utf8')),lease=await acquireWorkspace(f.workspace,f.operation,false,grant),history=join(f.operation,'ownership-history');await mkdir(history,{mode:0o700});const path=join(history,lease.generation+'-released.json'),lock=join(f.workspace,'.git/tongxu-writer.json'),original=await readFile(lock),outcome='known_ended_readonly_failure_closed';
 await writeFile(path,JSON.stringify({lease:{...lease,generation:'foreign'},outcome,at:new Date().toISOString()}));const corrupt=await readFile(path);await assert.rejects(releaseWorkspace(f.workspace,lease,outcome,true),/history_changed/);assert.deepEqual(await readFile(path),corrupt);assert.deepEqual(await readFile(lock),original);
 const valid=JSON.stringify({lease,outcome,at:'2026-11-12T00:00:00.000Z'});await writeFile(path,valid);await releaseWorkspace(f.workspace,lease,outcome,true);assert.equal(await readFile(path,'utf8'),valid);assert.deepEqual(await readFile(join(history,lease.generation+'-lock.json')),original);await assert.rejects(readFile(lock),/ENOENT/);
});
