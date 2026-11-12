import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {git} from '../../src/repair-workspace.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {ProjectWorkStore} from '../../src/project-work-store.js';
import {ProjectWork} from '../../src/project-work.js';
import {ProjectWorkOwner} from '../../src/project-work-owner.js';
import {parseWorkProposal} from '../../src/project-work-contract.js';
import {verifyRepositoryPath,receiveWorkResult} from '../../src/project-work-runtime.js';
import {repositoryFiles,repositoryFile,checkWorkMaterial} from '../../src/project-work-preparation.js';
import type {ProjectChatScope} from '../../src/project-chat.js';
const scope={account:{id:1,login:'fixture'},repository:{id:2,nodeId:'REPO2',fullName:'fixture/project'}} as ProjectChatScope;
test('read-only requests never receive Owner secrets; exact local confirmation is single use and declined/expired windows cannot act',async()=>{
  const opened:string[]=[],owner=new ProjectWorkOwner(()=> '127.0.0.1:1',async url=>{opened.push(url);}),payload={version:1,proposalSha256:'a'.repeat(64)};
  const response=await owner.request(scope,'work',payload,{goal:'exact'}),token=opened[0]!.split('#')[1]!;
  assert.ok(!JSON.stringify(response).includes(token));assert.equal(owner.view(token).used,false);await owner.request(scope,'work',payload,{goal:'exact'});assert.equal(opened[1],opened[0]);
  let calls=0;const perform=async(s:ProjectChatScope,id:string,p:typeof payload)=>{calls++;assert.deepEqual(s,scope);assert.equal(id,'work');assert.deepEqual(p,payload);};
  await Promise.all([owner.approve(token,perform),owner.approve(token,perform)]);assert.equal(calls,1);assert.equal(owner.decline(token).declined,false);
  await owner.request(scope,'other',payload,{});const other=opened.at(-1)!.split('#')[1]!;owner.decline(other);await assert.rejects(owner.approve(other,perform),/declined/);assert.equal(calls,1);
  owner.close();assert.throws(()=>owner.view(token),/expired/);await assert.rejects(owner.approve(other,perform),/expired/);
});
async function repository(t:any){const root=await mkdtemp(join(tmpdir(),'tongxu-first-use-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source');await mkdir(source);await git(source,['init','--initial-branch=main']);await writeFile(join(source,'code.mjs'),'export const value=1;\n');await writeFile(join(source,'unrelated-large.txt'),'x'.repeat(300000));await writeFile(join(source,'unrelated.bin'),Buffer.from([0,255,254]));await git(source,['add','.']);await git(source,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','source']);await git(source,['remote','add','origin','https://github.com/fixture/project.git']);return {root,source,H:await git(source,['rev-parse','HEAD'])};}
test('work settings and original draft survive cold reopen with exact project and request identity',async t=>{
  const f=await repository(t),path=join(f.root,'settings');let store=await ProjectWorkStore.open(path);const id=randomUUID(),conversationId=randomUUID(),at=new Date().toISOString();
  store.setSettings(scope,{repositoryPath:f.source});const draft={id,conversationId,issue:{number:1,title:'actual issue',body:'body',url:'https://github.com/fixture/project/issues/1',bodySha256:hash('body')},goal:'keep this exact request',createdAt:at,updatedAt:at,revision:0,version:0,requestId:randomUUID(),stage:'needs_input',problem:'project_work_repository_location_required',events:[]};
  store.create(scope,draft);assert.deepEqual(store.create(scope,draft),draft);store.close();store=await ProjectWorkStore.open(path);
  assert.deepEqual(store.get(scope,id),draft);assert.equal(store.settings(scope)?.repositoryPath,f.source);
  const other={...scope,repository:{...scope.repository,id:3}};assert.throws(()=>store.get(other,id),/outside_project/);assert.throws(()=>store.create(scope,{...draft,issue:{...draft.issue,number:2}}),/id_is_fixed/);
  const saved=store.save(scope,{...draft,problem:null},0);assert.equal(saved.revision,1);assert.throws(()=>store.save(scope,draft,0),/revision_changed/);store.close();
});
test('fixed material reads preserve exact Git bytes and omit unrelated large/binary files',async t=>{
  const f=await repository(t),source={path:f.source,H:f.H,repository:'fixture/project'},files=await repositoryFiles(source);
  assert.equal(files.length,3);assert.equal((await repositoryFile(source,'code.mjs')).text,'export const value=1;\n');
  await assert.rejects(repositoryFile(source,'unrelated-large.txt'),/file_not_readable/);await assert.rejects(repositoryFile(source,'unrelated.bin'));
  await assert.rejects(repositoryFile(source,'../outside'),/file_not_readable/);
  const proposal=parseWorkProposal({goal:'value two',acceptance:['value equals2'],allowedPaths:['code.mjs'],materialPaths:['code.mjs'],protectedPaths:[],validation:{description:'actual value',script:"import assert from 'node:assert/strict';import{value}from './code.mjs';assert.equal(value,2);"},questions:[],report:'source observed'});
  assert.equal(await checkWorkMaterial(source,proposal),Buffer.byteLength('export const value=1;\n'));assert.throws(()=>parseWorkProposal({...proposal,allowedPaths:['outside.mjs']}),/proposal_invalid/);assert.throws(()=>parseWorkProposal({...proposal,protectedPaths:['code.mjs']}),/proposal_invalid/);
  await writeFile(join(f.source,'code.mjs'),'uncommitted user work');assert.equal((await repositoryFile(source,'code.mjs')).text,'export const value=1;\n');
});
test('project location verifies the selected repository without modifying a dirty user checkout',async t=>{
  const f=await repository(t);await writeFile(join(f.source,'code.mjs'),'user dirty');const index=await readFile(join(f.source,'.git','index'));
  assert.equal(await verifyRepositoryPath(scope,f.source),f.source);await assert.rejects(verifyRepositoryPath({...scope,repository:{...scope.repository,fullName:'fixture/other'}},f.source),/identity_mismatch/);
  assert.equal(await readFile(join(f.source,'code.mjs'),'utf8'),'user dirty');assert.deepEqual(await readFile(join(f.source,'.git','index')),index);
});
test('complete results return to a real project branch; receipt recovery never overwrites dirty source or external result changes',async t=>{
  const f=await repository(t),execution=join(f.root,'execution');await mkdir(execution);await git(execution,['init']);await git(execution,['fetch',f.source,f.H]);await git(execution,['checkout','--detach','FETCH_HEAD']);await writeFile(join(execution,'code.mjs'),'export const value=2;\n');await git(execution,['add','code.mjs']);await git(execution,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','real result']);const H1=await git(execution,['rev-parse','HEAD']);
  await writeFile(join(f.source,'code.mjs'),'user unpublished work');const index=await readFile(join(f.source,'.git','index'));
  const options={repositoryPath:f.source,executionWorkspace:execution,H:H1,previous:null,branch:'tongxu/work-fixture',workspace:join(f.root,'result'),evidence:join(f.root,'evidence')};
  const result=await receiveWorkResult(options);assert.equal(result.H,H1);assert.equal(await git(f.source,['rev-parse','HEAD']),f.H);assert.equal(await readFile(join(f.source,'code.mjs'),'utf8'),'user unpublished work');assert.deepEqual(await readFile(join(f.source,'.git','index')),index);
  assert.equal(await git(f.source,['rev-parse','tongxu/work-fixture']),H1);assert.equal(await git(options.workspace,['rev-parse','HEAD^{tree}']),await git(execution,['rev-parse','HEAD^{tree}']));
  assert.equal((await receiveWorkResult(options)).H,H1);
  await writeFile(join(execution,'code.mjs'),'export const value=3;\n');await git(execution,['add','code.mjs']);await git(execution,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','supplement']);const H2=await git(execution,['rev-parse','HEAD']);
  await writeFile(join(options.workspace,'code.mjs'),'external unpublished result edit');await assert.rejects(receiveWorkResult({...options,H:H2,previous:H1}),/workspace_changed/);assert.equal(await git(f.source,['rev-parse','tongxu/work-fixture']),H1);
  await writeFile(join(options.workspace,'code.mjs'),'export const value=2;\n');await receiveWorkResult({...options,H:H2,previous:H1});assert.equal(await git(f.source,['rev-parse','tongxu/work-fixture']),H2);
  await git(f.source,['update-ref','refs/heads/tongxu/work-fixture',f.H,H2]);await assert.rejects(receiveWorkResult({...options,H:H2,previous:H1}),/branch_changed/);assert.equal(await git(f.source,['rev-parse','tongxu/work-fixture']),f.H);
});
