import test from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {git,exists,checkRepairIndex,tree} from '../../src/repair-workspace.js';
import {QueueStore} from '../../src/queue-store.js';
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

for(const point of ['init','fetch','checkout','checkout-applied'])test('same receipt resumes only its ended empty result checkout: '+point,async t=>{
  const f=await repository(t),execution=join(f.root,'execution');await mkdir(execution);await git(execution,['init']);await git(execution,['fetch',f.source,f.H]);await git(execution,['checkout','--detach','FETCH_HEAD']);
  await writeFile(join(execution,'code.mjs'),'export const value=2;\n');await git(execution,['add','.']);await git(execution,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','H1']);const H=await git(execution,['rev-parse','HEAD']);
  await writeFile(join(f.source,'code.mjs'),'original dirty checkout');const index=await readFile(join(f.source,'.git','index'));
  const options={repositoryPath:f.source,executionWorkspace:execution,H,previous:null,branch:'tongxu/result',workspace:join(f.root,'result'),evidence:join(f.root,'receipt')};
  const spawn=childProcess.spawn;let injected=false;
  childProcess.spawn=((command:any,args:any,opts:any)=>{
    if(command==='/usr/bin/git'&&args.includes(options.workspace)&&args.includes(point==='checkout-applied'?'checkout':point)&&!injected){
      injected=true;if(point!=='checkout-applied')throw Error('injected_result_interruption');
      const child=spawn(command,args,opts),once=child.once.bind(child);child.once=((event:any,listener:any)=>event==='close'?once(event,()=>listener(71,null)):once(event,listener)) as any;return child;
    }
    return spawn(command,args,opts);
  }) as typeof spawn;syncBuiltinESMExports();
  try{await assert.rejects(receiveWorkResult(options),/injected_result_interruption|git_mutation_incomplete/);}finally{childProcess.spawn=spawn;syncBuiltinESMExports();}
  assert.equal(injected,true);assert.equal(await git(f.source,['rev-parse',options.branch]),H);
  assert.equal((await receiveWorkResult(options)).H,H);assert.equal((await receiveWorkResult(options)).alreadyReceived,true);
  assert.equal(await git(options.workspace,['rev-parse','HEAD^{tree}']),await git(execution,['rev-parse',H+'^{tree}']));assert.equal(await git(f.source,['rev-parse','HEAD']),f.H);assert.deepEqual(await readFile(join(f.source,'.git','index')),index);assert.equal(await readFile(join(f.source,'code.mjs'),'utf8'),'original dirty checkout');
});

for(const external of ['file','index','ref','unknown-process','wrong-intent','foreign-directory','config'])test('incomplete result receipt preserves external or unknown state: '+external,async t=>{
  const f=await repository(t),options={repositoryPath:f.source,executionWorkspace:f.source,H:f.H,previous:null,branch:'tongxu/result',workspace:join(f.root,'result'),evidence:join(f.root,'receipt')};
  const spawn=childProcess.spawn;childProcess.spawn=((command:any,args:any,opts:any)=>{if(command==='/usr/bin/git'&&args.includes(options.workspace)&&args.includes('checkout'))throw Error('injected_checkout_interruption');return spawn(command,args,opts);}) as typeof spawn;syncBuiltinESMExports();
  try{await assert.rejects(receiveWorkResult(options),/injected_checkout_interruption/);}finally{childProcess.spawn=spawn;syncBuiltinESMExports();}
  if(external==='file')await writeFile(join(options.workspace,'external.txt'),'keep me');
  if(external==='config')await git(options.workspace,['config','core.worktree',f.source]);
  if(external==='index')await git(options.workspace,['read-tree',f.H]);
  if(external==='ref')await git(options.workspace,['update-ref','refs/heads/external',f.H]);
  if(external==='unknown-process')for(const name of await readdir(options.evidence))if(name.startsWith('git-')){const blocked=join(options.evidence,name,'blocked-before-spawn.json');await rm(blocked,{force:true});}
  if(external==='wrong-intent')await writeFile(join(options.evidence,'receipt-'+f.H+'.json'),'{}');
  if(external==='foreign-directory')await writeFile(join(options.evidence,'workspace-created.json'),canonical({workspace:options.workspace,dev:-1,ino:-1}));
  await assert.rejects(receiveWorkResult(options),/workspace_changed|git_unknown|fixed_input_changed/);
  if(external==='file')assert.equal(await readFile(join(options.workspace,'external.txt'),'utf8'),'keep me');
  assert.equal(await git(f.source,['rev-parse','HEAD']),f.H);
});

test('missing preparation conditions preserve new initial words without rewriting any fixed or unknown version',async t=>{
  const f=await repository(t),root=join(f.root,'works'),store=await ProjectWorkStore.open(root),at=new Date().toISOString();
  const config={root,executor:{path:join(f.root,'unused.json'),sha256:'a'.repeat(64)},verification:{kind:'docker',client:'/usr/bin/unused-docker',endpoint:'unix:///unused.sock',image:'sha256:'+'a'.repeat(64),node:'/usr/bin/node'},owner:{ownerId:1,executorId:1,ghExecutable:'/usr/bin/unused-gh',ghSha256:'a'.repeat(64),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000,sharedAccountApproval:{decisionReference:{kind:'recorded_user_decision',sha256:'a'.repeat(64)}}}};
  let ready=false,fixedId='';const path=join(f.root,'work.json');await writeFile(path,canonical(config));const work=await ProjectWork.open({path,sha256:hash(canonical(config))},async(_scope,number)=>{if(!ready)throw Error('must_not_read_issue');return {number,title:'exact issue',body:'fixed',url:'https://github.com/fixture/project/issues/'+number,defaultHead:f.H};},async()=>{},async()=>{throw Error('must_not_start_controls');});
  t.after(()=>work.drain());
  for(const version of [0,1]){
    const id=randomUUID(),draft={id,conversationId:randomUUID(),issue:{number:version+1,title:'exact issue',body:'fixed',url:'https://github.com/fixture/project/issues/'+(version+1),bodySha256:hash('fixed')},goal:version?'frozen approved goal':'',createdAt:at,updatedAt:at,revision:0,version,requestId:randomUUID(),stage:version?'authorizing':'draft',problem:null,stopRequested:version?true:undefined,preparation:version?{directory:join(root,'fixed'),H:f.H,repositoryPath:f.source,inputSha256:'b'.repeat(64)}:undefined,events:[]};
    store.create(scope,draft);if(version)fixedId=id;await work.prepare(scope,id,{goal:'new words before missing location'});
    let result:any;for(let i=0;i<100;i++){result=(await work.detail(scope,id)).draft;if(result.problem==='project_work_repository_location_required')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(result.problem,'project_work_repository_location_required');assert.equal(result.goal,version?'frozen approved goal':'new words before missing location');assert.equal(result.draftGoal??undefined,version?'new words before missing location':undefined);assert.equal(result.version,version);assert.equal(result.stopRequested??undefined,draft.stopRequested);assert.deepEqual(result.preparation??undefined,draft.preparation);
  }
  ready=true;store.setSettings(scope,{repositoryPath:f.source,verified:true});await work.prepare(scope,fixedId,{goal:'new words before missing location'});
  let next:any;for(let i=0;i<100;i++){const state=await work.state(scope);if(!state.works.find(w=>w.id===fixedId)?.active){next=(await work.detail(scope,fixedId)).draft;break;}await new Promise(r=>setTimeout(r,5));}
  assert.equal(next.version,2);assert.equal(next.goal,'new words before missing location');assert.equal(next.draftGoal==null,true);assert.equal(next.prior[0].version,1);
  store.close();
});

// Explicit queue/report boundary samples below exercise selection and real Git
// receipt recovery; they do not claim these rows came from a model execution.
async function pendingWork(t:any,latestKind:string){
  const f=await repository(t),execution=join(f.root,'execution');await mkdir(execution);await git(execution,['init']);await git(execution,['fetch',f.source,f.H]);await git(execution,['checkout','--detach','FETCH_HEAD']);
  const commit=async(value:number)=>{await writeFile(join(execution,'code.mjs'),`export const value=${value};\n`);await git(execution,['add','.']);await git(execution,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','explicit result sample '+value]);return git(execution,['rev-parse','HEAD']);};
  const H1=await commit(2),H2=await commit(3),root=join(f.root,'work'),id=randomUUID(),directory=join(root,'works',id,'version-1'),workspace=join(directory,'result'),branch='tongxu/result',evidence=join(directory,'receipt-'+H1);
  const options={repositoryPath:f.source,executionWorkspace:execution,H:H1,previous:null,branch,workspace,evidence},spawn=childProcess.spawn;
  childProcess.spawn=((command:any,args:any,opts:any)=>{if(command==='/usr/bin/git'&&args.includes(workspace)&&args.includes('checkout'))throw Error('fixture_original_receipt_interruption');return spawn(command,args,opts);}) as typeof spawn;syncBuiltinESMExports();
  try{await assert.rejects(receiveWorkResult(options),/fixture_original_receipt_interruption/);}finally{childProcess.spawn=spawn;syncBuiltinESMExports();}
  const original={id:'original',plan:{workspace:execution,resourceRequests:['resource-original']},result:{status:'completed',completeCapture:true,H1}},latest={id:'latest',plan:{workspace:execution,resourceRequests:['resource-latest']},...(latestKind==='incomplete'?{}:{result:latestKind==='completed'?{status:'completed',completeCapture:true,H1:H2}:latestKind==='no_change'?{status:'no_change',completeCapture:true,H1:null}:{status:'active_or_unknown',completeCapture:false,H1:null}})};
  let rows:any[]=[original,latest],unsettled='',badReport='';const reports:string[]=[],resources:string[]=[];
  t.mock.method(QueueStore,'open',async()=>({issueImplementations:()=>({requests:()=>rows}),resources:()=>({settledOutcome:(id:string)=>{resources.push(id);return id!==unsettled;}}),close:()=>{}}));
  const controls={report:async(_source:string,id:string)=>{reports.push(id);if(id===badReport)throw Error('fixture_original_report_changed');return {};}};
  const catalog={entries:[{store:join(f.root,'explicit-queue-sample'),objects:f.source,target:branch}]},catalogPath=join(f.root,'catalog.json');await writeFile(catalogPath,canonical(catalog));
  const store=await ProjectWorkStore.open(root),at=new Date().toISOString();t.after(()=>store.close());store.create(scope,{id,conversationId:randomUUID(),issue:{number:1,title:'explicit receipt sample',body:'fixed',url:'https://github.com/fixture/project/issues/1',bodySha256:hash('fixed')},goal:'fixed',createdAt:at,updatedAt:at,revision:0,version:1,requestId:'original',stage:'waiting_return',problem:'fixture_original_receipt_interruption',source:'work',catalog:{path:catalogPath,sha256:hash(canonical(catalog))},delivery:{H:H1,previous:null,branch,workspace,status:'pending',problem:'fixture_original_receipt_interruption'},events:[]});
  const config={root,executor:{path:join(f.root,'unused.json'),sha256:'a'.repeat(64)},verification:{kind:'docker',client:'/usr/bin/unused-docker',endpoint:'unix:///unused.sock',image:'sha256:'+'a'.repeat(64),node:'/usr/bin/node'},owner:{ownerId:1,executorId:1,ghExecutable:'/usr/bin/unused-gh',ghSha256:'a'.repeat(64),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000,sharedAccountApproval:{decisionReference:{kind:'recorded_user_decision',sha256:'a'.repeat(64)}}}},path=join(f.root,'config.json');await writeFile(path,canonical(config));
  const work=await ProjectWork.open({path,sha256:hash(canonical(config))},async()=>{throw Error('must_not_read_issue');},async()=>{},async()=>controls as any);t.after(()=>work.drain());
  return {...f,work,id,H1,H2,workspace,branch,directory,evidence,reports,resources,state:()=>store.get(scope,id),setRows:(value:any[])=>{rows=value;},original,latest,setUnsettled:(value:string)=>{unsettled=value;},setBadReport:(value:string)=>{badReport=value;}};
}
for(const latest of ['no_change','incomplete','unknown'])for(const blocked of [false,true])test('pending receipt precedes explicit '+latest+' latest sample, original blocked='+blocked,async t=>{
  const f=await pendingWork(t,latest),intent=await readFile(join(f.evidence,'receipt-'+f.H1+'.json'));
  if(blocked)await writeFile(join(f.workspace,'external.txt'),'retain external work');
  if(blocked)await assert.rejects(f.work.receive(scope,f.id),/workspace_changed/);else if(latest==='no_change')assert.deepEqual(await f.work.receive(scope,f.id),{status:'no_change',newCommit:false});else await assert.rejects(f.work.receive(scope,f.id),/result_not_complete/);
  const d=f.state();assert.equal(d.delivery!.H,f.H1);assert.equal(d.delivery!.status,blocked?'pending':'received');assert.equal(d.stage,blocked||latest!=='no_change'?'waiting_return':'delivered');assert.equal(await git(f.source,['rev-parse',f.branch]),f.H1);if(!blocked)assert.equal(await git(f.workspace,['rev-parse','HEAD']),f.H1);
  assert.deepEqual(f.reports,['original']);assert.deepEqual(f.resources,['resource-original']);assert.deepEqual(await readFile(join(f.evidence,'receipt-'+f.H1+'.json')),intent);assert.equal(await exists(join(f.directory,'receipt-'+f.H2)),false);
});
for(const match of ['missing','ambiguous'])test('pending receipt refuses '+match+' original result sample',async t=>{
  const f=await pendingWork(t,'completed');f.setRows(match==='missing'?[f.latest]:[f.original,{...f.original,id:'other'},f.latest]);await assert.rejects(f.work.receive(scope,f.id),/pending_result_not_unique/);assert.equal(f.state().delivery!.H,f.H1);assert.equal(f.state().delivery!.status,'pending');assert.deepEqual(f.reports,[]);assert.equal(await exists(join(f.directory,'receipt-'+f.H2)),false);
});
for(const target of ['original','latest'])for(const gate of ['report','resources'])test('pending receipt retains exact result at explicit '+target+' '+gate+' refusal',async t=>{
  const f=await pendingWork(t,'completed');if(gate==='report')f.setBadReport(target);else f.setUnsettled('resource-'+target);
  await assert.rejects(f.work.receive(scope,f.id),gate==='report'?/report_changed/:/resources_unresolved/);assert.equal(f.state().delivery!.H,f.H1);assert.equal(f.state().delivery!.status,target==='original'?'pending':'received');assert.equal(await exists(join(f.directory,'receipt-'+f.H2)),false);assert.equal(await git(f.source,['rev-parse',f.branch]),f.H1);
});
test('a failed latest receipt retains H2 pending with the truly received H1 predecessor',async t=>{
  const f=await pendingWork(t,'completed'),spawn=childProcess.spawn;
  childProcess.spawn=((command:any,args:any,opts:any)=>{if(command==='/usr/bin/git'&&args.includes(f.workspace)&&args.includes('merge'))throw Error('fixture_latest_receipt_interruption');return spawn(command,args,opts);}) as typeof spawn;syncBuiltinESMExports();
  try{await assert.rejects(f.work.receive(scope,f.id),/fixture_latest_receipt_interruption/);}finally{childProcess.spawn=spawn;syncBuiltinESMExports();}
  const d=f.state();assert.equal(d.delivery!.H,f.H2);assert.equal(d.delivery!.previous,f.H1);assert.equal(d.delivery!.status,'pending');assert.equal(d.stage,'waiting_return');assert.equal(d.events.filter(e=>e.kind==='result_received').length,1);assert.equal(await git(f.workspace,['rev-parse','HEAD']),f.H1);
  assert.equal((await f.work.receive(scope,f.id) as any).H,f.H2);assert.equal(f.state().delivery!.status,'received');assert.equal(await git(f.workspace,['rev-parse','HEAD']),f.H2);
});

// Synthetic preparation captures; no private project source or real model.
async function preparationCapture(t:any,kind:'complete'|'questions'|'unknown'|'version-mismatch'='complete'){
  const f=await repository(t),{fixture}=await import('../w5/repair-fixture.js'),native=await fixture(t),{BoundedCodexSession,findingSchema}=await import('../../src/repair-native.js'),{workPreparationInstructionsV1,preparationToolSpecs}=await import('../../src/project-work-contract.js');
  const directory=join(f.root,'preparation');await mkdir(directory);
  const proposal={goal:'Set the selected value',acceptance:['value equals2'],allowedPaths:['code.mjs'],materialPaths:['code.mjs'],protectedPaths:[],validation:{description:'Independent fixed assertion',script:"import assert from 'node:assert/strict';import{value}from './code.mjs';assert.equal(value,2);"},questions:kind==='questions'?['Synthetic old premise conflicts with the adopted result.']:[],report:'Explicit protocol fixture, not a real project result.'};
  const source={path:f.source,H:f.H,repository:'fixture/project'},input={kind:'project_work_engineering_preparation',source,issue:{number:1},userGoal:'exact',files:[],...(kind==='version-mismatch'?{preparationVersion:2}:{})},bytes=canonical(input);await writeFile(join(directory,'input.json'),bytes);
  let code=await readFile(native.config.codexExecutable,'utf8');code=code.replace("if(stage==='tongxu_read_file'){",`if(stage==='tongxu_repository_file'){${kind==='questions'?`emit({method:'item/completed',params:{threadId:thread.id,turnId:current,completedAtMs:99,item:{id:current+'-question',type:'agentMessage',phase:'final_answer',delivery:'async',questions:[{title:'Synthetic old premise conflicts with the adopted result.',options:null}],text:'This is a synthetic question, not a final result.'}}});`:''}finish({candidateH:context.source.H,decision:'${kind==='questions'?'needs_owner':'confirmed'}',report:JSON.stringify(${JSON.stringify(proposal)})});return;}if(stage==='tongxu_read_file'){`);
  code=code.replace("if(mode==='host-unavailable'&&turn===1)","if(context.kind==='project_work_engineering_preparation'){tool('tongxu_repository_file',{path:'code.mjs'});return;}if(mode==='host-unavailable'&&turn===1)");await writeFile(native.config.codexExecutable,code);
  const system=kind==='unknown'?workPreparationInstructionsV1+' unknown-version':workPreparationInstructionsV1,candidate={kind:'local-git' as const,repository:'local/project-work-preparation',pr:null,H:f.H,B:f.H,target:'preparation'};
  const session=await BoundedCodexSession.start({executable:native.config.codexExecutable,directory:join(directory,'native'),operation:directory,candidate,role:'verifier_fact',projectPreparation:true,system,inputManifestSha256:hash(bytes),scopeSource:'Synthetic preparation fixture',arrangementSource:'Read-only fixture; no permission',disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:3000,executionKind:'fixture',beforeTurn:async()=>{},gate:{check:async()=>{},call:async()=>({success:true,contentItems:[{type:'inputText',text:'{}'}]})}});
  try{if(kind==='questions')await assert.rejects(session.turn(bytes,candidate,findingSchema),/non_terminal_agent_message/);else await session.turn(bytes,candidate,findingSchema);}finally{await session.close();}
  const start=(await readFile(join(directory,'native','stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x)).find(x=>x.method==='thread/start');assert.deepEqual(start.params.dynamicTools,preparationToolSpecs);
  return {...f,directory,source,proposal,trace:native.trace};
}
test('known V1 full capture retains detail, confirmation and start preflight after V2 prompt introduction',async t=>{
  const f=await preparationCapture(t),{readWorkProposal}=await import('../../src/project-work-preparation.js'),read=await readWorkProposal(f.directory,f.source),at=new Date().toISOString(),trace=await readFile(f.trace);
  assert.equal(read.ready,true);const id=randomUUID(),draft={id,issue:{number:1,title:'Synthetic V1',body:'fixed',bodySha256:hash('fixed')},version:1,stage:'prepared',goal:'exact',revision:0,events:[],preparation:{directory:f.directory,H:f.H,repositoryPath:f.source.path,...read,observedAt:at}};
  const owner={ownerId:1,executorId:1,ghExecutable:'/usr/bin/unused-gh',ghSha256:'a'.repeat(64),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000,sharedAccountApproval:{decisionReference:{kind:'recorded_user_decision',sha256:'a'.repeat(64)}}};
  const work=Object.assign(Object.create(ProjectWork.prototype),{store:{get:()=>structuredClone(draft)},active:new Map(),config:{owner},verify:async()=>{},readIssue:async()=>({...draft.issue,defaultHead:f.H}),save:(_scope:any,d:any)=>d,initializeQueue:async()=>{throw Error('synthetic_start_preflight_passed');},job:(_scope:any,_id:any,fn:any)=>fn({stop:false})});
  const detail=await work.detail(scope,id);assert.equal(detail.draft.preparation.proposalDigest,read.proposalDigest);
  const payload={version:1,proposalSha256:read.proposalDigest};assert.deepEqual((await work.confirmation(scope,id,payload)).allowedPaths,['code.mjs']);
  await assert.rejects(work.start(scope,id,payload),/synthetic_start_preflight_passed/);assert.deepEqual(await readFile(f.trace),trace);assert.equal(await exists(join(f.directory,'environment')),false);
});
for(const kind of ['unknown','version-mismatch'] as const)test('unknown or mismatched preparation instructions never adopt a plan: '+kind,async t=>{
  const f=await preparationCapture(t,kind),{readWorkProposal}=await import('../../src/project-work-preparation.js');await assert.rejects(readWorkProposal(f.directory,f.source),/preparation_version/);
});
test('ended rejected V1 questions are cold readable as unaccepted diagnostics with zero mutations or inputs',async t=>{
  const f=await preparationCapture(t,'questions'),{readWorkPreparationDiagnostic,readWorkProposal}=await import('../../src/project-work-preparation.js'),before=await readFile(join(f.directory,'native','stdout.ndjson')),trace=await readFile(f.trace);
  await assert.rejects(readWorkProposal(f.directory,f.source),/ENOENT|controlled/);
  const diagnostic=await readWorkPreparationDiagnostic(f.directory,f.source);assert.equal(diagnostic?.accepted,false);assert.deepEqual(diagnostic?.questions,f.proposal.questions);assert.equal((diagnostic as any).proposal,undefined);assert.equal((diagnostic as any).ready,undefined);assert.equal(await exists(join(f.directory,'native','completed.json')),false);
  const draft={id:'fixture',stage:'needs_input',version:1,problem:'controlled_result_not_final:non_terminal_agent_message',preparation:{directory:f.directory,repositoryPath:f.source.path,H:f.H}};
  const work=Object.assign(Object.create(ProjectWork.prototype),{store:{get:()=>structuredClone(draft)}});
  assert.deepEqual((await work.detail(scope,'fixture')).preparationDiagnostic,diagnostic);assert.deepEqual((await work.detail(scope,'fixture')).preparationDiagnostic,diagnostic);assert.deepEqual(await readFile(f.trace),trace);assert.deepEqual(await readFile(join(f.directory,'native','stdout.ndjson')),before);
  const bindingPath=join(f.directory,'native','binding.json'),original=await readFile(bindingPath),binding=JSON.parse(original.toString());await writeFile(bindingPath,canonical({...binding,role:'reviewer'}));assert.equal(await readWorkPreparationDiagnostic(f.directory,f.source),null);await writeFile(bindingPath,original);
  assert.equal(await readWorkPreparationDiagnostic(f.directory,{...f.source,H:'f'.repeat(40)}),null);await writeFile(bindingPath,canonical({...binding,turnIds:['wrong-original-turn']}));assert.equal(await readWorkPreparationDiagnostic(f.directory,f.source),null);await writeFile(bindingPath,original);
  await writeFile(join(f.directory,'native','stdout.ndjson'),Buffer.concat([before,Buffer.from('bad\n')]));assert.equal(await readWorkPreparationDiagnostic(f.directory,f.source),null);await writeFile(join(f.directory,'native','stdout.ndjson'),before);
  await rm(join(f.directory,'native','exit.json'));assert.equal(await readWorkPreparationDiagnostic(f.directory,f.source),null);
});
test('a changed project test can be proposed, while protected paths and the frozen verifier remain distinct',()=>{
  const base={goal:'Synchronize an adopted premise',acceptance:['new behavior'],allowedPaths:['code.mjs','test/existing.test.mjs'],materialPaths:['code.mjs','test/existing.test.mjs','AGENTS.md'],protectedPaths:['AGENTS.md'],validation:{description:'Independent frozen verification',script:'import assert from "node:assert/strict";assert.ok(true);'},questions:[],report:'Path control fixture only; it does not prove the test semantics.'};
  assert.deepEqual(parseWorkProposal(base).allowedPaths,base.allowedPaths);assert.throws(()=>parseWorkProposal({...base,protectedPaths:['AGENTS.md','test/existing.test.mjs']}),/proposal_invalid/);
});

test('selected Git view preserves only unchanged omitted links; all link changes and gitlinks are refused',async t=>{
 const f=await repository(t);await symlink('synthetic-never-read-target',join(f.source,'omitted-link'));await git(f.source,['add','omitted-link']);await git(f.source,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','synthetic link']);const H=await git(f.source,['rev-parse','HEAD']),workspace=join(f.root,'sparse'),operation=join(f.root,'index-operation');await mkdir(workspace);await mkdir(operation);await git(workspace,['init','--template=']);await git(workspace,['config','core.sparseCheckout','true']);await git(workspace,['config','core.sparseCheckoutCone','false']);await git(workspace,['config','index.sparse','false']);await mkdir(join(workspace,'.git/info'),{recursive:true});await writeFile(join(workspace,'.git/info/sparse-checkout'),'/code.mjs\n');await git(workspace,['fetch',f.source,H]);await git(workspace,['checkout','--detach','FETCH_HEAD']);
 const current=await tree(workspace,true),view={materialView:'selected_files' as const,materialPaths:['code.mjs']},index=await readFile(join(workspace,'.git/index')),object=await git(workspace,['rev-parse','HEAD:omitted-link']);assert.equal(await exists(join(workspace,'omitted-link')),false);
 await checkRepairIndex(workspace,operation,['code.mjs'],current,view);await assert.rejects(checkRepairIndex(workspace,operation,['code.mjs'],current),/unsupported/);await assert.rejects(checkRepairIndex(workspace,operation,['code.mjs'],current,{...view,materialPaths:['code.mjs','omitted-link']}),/unsupported/);
 for(const change of ['delete','object','mode','new','stage','gitlink'] as const){
  if(change==='delete')await git(workspace,['update-index','--force-remove','omitted-link']);
  if(change==='object'){await writeFile(join(f.root,'new-link-target'),'changed');const oid=await git(workspace,['hash-object','-w',join(f.root,'new-link-target')]);await git(workspace,['update-index','--cacheinfo','120000,'+oid+',omitted-link']);}
  if(change==='mode')await git(workspace,['update-index','--cacheinfo','100644,'+object+',omitted-link']);
  if(change==='new')await git(workspace,['update-index','--add','--cacheinfo','120000,'+object+',added-link']);
  if(change==='gitlink')await git(workspace,['update-index','--add','--cacheinfo','160000,'+H+',module']);
  if(change==='stage'){await git(workspace,['update-index','--force-remove','omitted-link']);childProcess.execFileSync('/usr/bin/git',['-C',workspace,'update-index','--index-info'],{input:'120000 '+object+' 1\tomitted-link\n'});}
  await assert.rejects(checkRepairIndex(workspace,operation,['code.mjs'],current,view),/unsupported|reconciliation/);await writeFile(join(workspace,'.git/index'),index);
 }
 await symlink('synthetic-never-read-target',join(workspace,'omitted-link'));await assert.rejects(tree(workspace,true),/unsafe_workspace_entry/);await assert.rejects(checkRepairIndex(workspace,operation,['code.mjs'],current,view),/unsupported/);await rm(join(workspace,'omitted-link'));assert.deepEqual(await readFile(join(workspace,'.git/index')),index);
});
