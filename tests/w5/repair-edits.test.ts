import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {replacementText,implementationEditProfile} from '../../src/repair-edits.js';
import {RepairTools,acquireWorkspace,releaseWorkspace,tree,treeHash,projectRepairToolSpecs,projectRepairToolsFor} from '../../src/repair-workspace.js';
import {fixture} from './repair-fixture.js';
import {hash} from '../../src/snapshot.js';
const profile='literal-edits-v1',args=(edits:unknown)=>({path:'source.txt',expectedSha256:'a'.repeat(64),edits});
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
