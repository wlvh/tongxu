import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {formalFixture} from '../w5/formal-round-fixture.js';
import {startWorkbench} from '../../src/workbench.js';
import {hash} from '../../src/snapshot.js';
import type {AIProvider} from '../../src/ai-catalog.js';
import {canonical} from '../../src/comparison.js';
import {git} from '../../src/repair-workspace.js';
import {additionalFixture} from './additional-cli-fixture.js';
import {formalBatch,validateFormalReview,validateFormalVerification} from '../../src/formal-review-contract.js';
import {FormalReviewControls} from '../../src/formal-review-controls.js';
import {QueueFormalRoundHost} from '../../src/formal-review-host.js';
import type {AIPreferenceSnapshot} from '../../src/ai-settings.js';
async function page(t:test.TestContext){const f=await formalFixture(t),path=join(f.root,'formal-workbench.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Explicit formal review fixture',goal:'Protocol fixture; no real remote or model',sources:f.sources.map(s=>({...s,title:'Explicit PR #1'})),formalReview:{path:f.catalog,sha256:hash(await readFile(f.catalog))}}));const app=await startWorkbench(path,undefined,{formalSourceReader:async()=>f.live});let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};t.after(close);const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1)},get=(p:string)=>fetch(url.origin+p,{headers}),post=(p:string,body:unknown,origin=url.origin)=>fetch(url.origin+p,{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {...f,path,app,url,get,post,close};}
test('a project work candidate can open its exact registered PR review and refuses a different base or requirement',async t=>{
 const f=await page(t),{H}=f.live.candidate,route='/api/formal-review/'+f.entry.id+'/prepare';
 const review=await f.controls.forWork(f.entry.issue,H);
 assert.deepEqual(review,{entry:f.entry.id,source:f.entry.source,candidate:f.live.candidate});
 assert.equal(await f.controls.forWork({...f.entry.issue,bodySha256:'0'.repeat(64)},H),null);
 assert.equal(await f.controls.forWork(f.entry.issue,'0'.repeat(40)),null);
 const plan={requestId:'selected-work',expectedCandidate:review!.candidate};
 const stale=await f.post(route,{...plan,expectedCandidate:{...review!.candidate,B:'1'.repeat(40)}});
 assert.equal((await stale.json() as any).error,'formal_candidate_or_requirements_changed');
 assert.equal(f.q.formalReviews().forEntry(f.entry.id).length,0);
 assert.equal((await f.post(route,plan)).status,200);
 assert.equal((await f.post(route,{...plan,expectedCandidate:{...review!.candidate,B:'1'.repeat(40)}})).status,503);
 assert.equal((await f.calls()).length,0);
});
test('normal workbench freezes the complete formal input, executes one direct PASS, reads full originals and cold-reopens with zero extra inputs',async t=>{const f=await page(t),route='/api/formal-review/'+f.entry.id;const html=await(await fetch(f.url.origin+'/')).text();assert.match(html,/src="\/formal-review.js"/);assert.equal((await fetch(f.url.origin+'/formal-review.js')).status,200);assert.equal((await(await f.get('/api/state')).json() as any).mode,'bounded_formal_review');assert.equal((await f.calls()).length,0);assert.equal((await f.post(route+'/prepare',{requestId:'wrong-origin'},'http://other.invalid')).status,403);assert.equal((await f.post(route+'/prepare',{requestId:'bad-path',path:'/not-permitted'})).status,503);const p=await(await f.post(route+'/prepare',{requestId:'normal-page'})).json() as any;assert.ok(p.operation,JSON.stringify(p));assert.equal((await f.calls()).length,0);assert.equal((await f.post(route+'/start',{operation:p.operation})).status,202);
 let s:any;for(let i=0;i<300;i++){s=await(await f.get('/api/formal-review')).json();if(!s.entries[0].requests[0].controllerActive)break;await new Promise(r=>setTimeout(r,20));}assert.equal(s.entries[0].requests[0].phase,'pass',JSON.stringify(s));const r=await(await f.get('/api/formal-review-report/'+f.entry.id+'/'+p.operation)).json() as any;assert.equal(r.fullStages[0].result.verdict,'PASS');assert.equal((await(await f.get('/api/state')).json() as any).tasks[0].operations.length,0);assert.equal(r.material.localRepairScopeDoesNotLimitReview,true);assert.deepEqual(r.material.changedPaths.sort(),['AGENTS.md','SOP.md','sample.js','test.mjs']);assert.equal((await f.calls()).length,1);await f.close();const cold=await startWorkbench(f.path,undefined,{formalSourceReader:async()=>{throw new Error('read_must_not_query_live_source');}});t.after(()=>cold.close());const u=new URL(cold.url),before=await f.calls(),restored=await(await fetch(u.origin+'/api/formal-review-report/'+f.entry.id+'/'+p.operation,{headers:{Authorization:'Bearer '+u.hash.slice(1)}})).json() as any;assert.deepEqual(restored.fullStages,r.fullStages);assert.deepEqual(await f.calls(),before);
});

test('dual verification can answer every finding from two valid reports',()=>{
 const candidate={repository:'fixture/reception',pr:1,H:'a'.repeat(40),B:'b'.repeat(40),target:'main',requirementsSha256:'c'.repeat(64)};
 const inputSha256='d'.repeat(64);
 const report=(size:number)=>validateFormalReview({candidateH:candidate.H,reviewedInputSha256:inputSha256,verdict:'REWORK_REQUIRED',
  report:'Explicit protocol findings',findings:Array.from({length:size},(_,i)=>({id:String(i).padStart(128,'a'),priority:1,description:'Observed concern',evidence:['test.mjs']})),coverageGaps:[],ownerQuestions:[]},candidate.H,inputSha256);
 const a=report(11),b=report(10);
 const findings=[...a.findings.map(f=>({...f,id:'correctness:'+f.id})),...b.findings.map(f=>({...f,id:'impact:'+f.id}))];
 const batch=formalBatch(candidate,{...a,findings});
 const assessments=findings.map(f=>({id:f.id,decision:'confirmed',report:'Evidence checked',evidence:['test.mjs']}));
 const result={candidateH:candidate.H,batchSha256:batch.sha256,report:'Verified whole batch',assessments};
 assert.equal(validateFormalVerification(result,batch).assessments.length,21);
 assert.throws(()=>validateFormalVerification({...result,assessments:assessments.slice(0,20)},batch),/formal_complete_batch_verification_required/);
});

async function dualPrograms(t:test.TestContext,mode:string){
 const f=await formalFixture(t,mode==='fix'||mode==='replace-fix-wait'?'confirmed':'pass',mode==='replace-ended'),peer=await additionalFixture(t,'kimi',mode==='late-peer'?'after-terminal-text':'complete');
 const codex=await readFile(f.n.config.codexExecutable,'utf8');
 await writeFile(f.n.config.codexExecutable,codex.replace("context.candidate??=context.material.candidate;","context.candidate??=context.material.candidate;repairing||=context.stage==='authorized-repair';"));
 const peerCode=await readFile(peer.binary,'utf8');
 const source="if(responseKind==='message')output={messageId:envelope.messageId,consumed:envelope.replyReferences,report:'Explicit '+tool+' fixture complete material report '+turn};";
 const replacement="if(responseKind==='message')output=envelope.batch?{candidateH:envelope.material.candidate.H,batchSha256:envelope.batch.sha256,report:'Independent fixture impact verification',assessments:envelope.batch.findings.map(f=>({id:f.id,decision:'confirmed',report:'Fixture confirms the finding',evidence:['test.mjs']}))}:{candidateH:envelope.material.candidate.H,reviewedInputSha256:envelope.material.sha256,verdict:'PASS',report:'Independent fixture full review',findings:[],coverageGaps:[],ownerQuestions:[]};";
 assert.ok(peerCode.includes(source));await writeFile(peer.binary,peerCode.replace(source,replacement));
 const catalog=JSON.parse(await readFile(f.catalog,'utf8'));catalog.entries[0].workflowContract='coding-loop-v2';await writeFile(f.catalog,canonical(catalog));
 return {f,peer};
}

for(const mode of ['pass','missing-peer',...(process.env.TONGXU_TEST_DOCKER_CONFIG?['fix']:[])])test('normal dual formal review '+mode+' keeps the independent reports and original sessions',async t=>{
 const {f,peer}=await dualPrograms(t,mode);
 const path=join(f.root,'dual-review-workbench.json'),account={id:7,login:'fixture'},repo={
   id:1,nodeId:'R_1',full_name:'fixture/reception',description:'Dual review fixture',private:true,archived:false,
   defaultBranchRef:{name:'fixture',target:{oid:f.live.candidate.B}},updated_at:new Date().toISOString()
 };
 await writeFile(path,canonical({
   schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Dual-review protocol fixture',goal:'Verify independent sessions and complete exchange',githubProjects:true,
   sources:f.sources.map(s=>({...s,title:'Explicit fixture PR'})),formalReview:{path:f.catalog,sha256:hash(await readFile(f.catalog))},
   aiSettings:{root:join(f.root,'dual-settings'),configured:[{tool:'kimi',path:peer.binary}],disabledMcpServers:[]}
 }));
 const dependencies:NonNullable<Parameters<typeof startWorkbench>[2]>={
  formalSourceReader:async()=>f.live,
  githubReader:async()=>({query:async op=>({
   status:200,headers:{},provenance:'gh-http-body',
   body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repo],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository:repo}})
  })}),
  aiProbe:async(tool,path,directory)=>({
   id:hash(path),tool,path,version:'explicit protocol fixture',available:path===peer.binary,reason:null,authentication:'subscription',
   models:[{id:'fixture/model-next',name:'Explicit fixture',description:'ACP tested',resolvedId:null,efforts:['future-depth'],defaultEffort:'future-depth',isDefault:true}],
   observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:false,ownedControl:false,impactReports:tool==='kimi'},evidence:directory
  })
 };
 const app=await startWorkbench(path,undefined,dependencies);t.after(()=>app.close());
 const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'X-Tongxu-Account':'7','X-Tongxu-Project':'1'};
 const http=async(route:string,body?:object)=>{
   const r=await fetch(url.origin+route,{headers:{...headers,...(body?{Origin:url.origin,'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
   return {status:r.status,data:await r.json() as any};
 };
 await http('/api/github/projects');
 const route='/api/formal-review/'+f.entry.id;
 if(mode==='missing-peer'){
  const refused=await http(route+'/prepare',{requestId:'dual-review-test'});
  assert.equal(refused.status,503);
  assert.equal(refused.data.error,'formal_second_company_not_configured');
  assert.deepEqual((await http('/api/formal-review')).data.entries[0].requests,[]);
  assert.equal((await f.calls()).length,0);
 }
 assert.equal((await http('/api/ai-settings/scan',{})).status,200);
 const selection=await http('/api/ai-settings/role',{revision:0,role:'verifier_impact',choice:{providerId:hash(peer.binary),model:'fixture/model-next',effort:'future-depth'}});
 assert.equal(selection.status,200,JSON.stringify(selection.data));
 const prepared=await http(route+'/prepare',{requestId:'dual-review-test'});
 assert.equal(prepared.status,200,JSON.stringify(prepared.data));
 const operation=prepared.data.operation as string;
 assert.equal((await http(route+'/start',{operation})).status,202);
 const report=async()=>(await http('/api/formal-review-report/'+f.entry.id+'/'+operation)).data;
 await waitFor(async()=>!(await report()).controllerActive);
 const complete=await report();
 assert.equal(complete.phase,mode==='fix'?'awaiting_publication':'pass',JSON.stringify(complete.detail));
 const stages=complete.fullStages;
 const stage=(name:string)=>stages.find((s:any)=>s.key==='round-'+complete.executionRound+'/'+name);
 const first=stage('correctness-initial'),second=stage('impact-initial');
 assert.equal(first.proof.inputSha256,second.proof.inputSha256);
 assert.equal(first.proof.native.company,'OpenAI');assert.equal(second.proof.native.company,'Moonshot');
 assert.equal(first.proof.native.sessionId,stage('correctness-exchange').proof.native.sessionId);
 assert.equal(second.proof.native.sessionId,stage('impact-exchange').proof.native.sessionId);
 assert.notEqual(first.proof.native.sessionId,second.proof.native.sessionId);
 assert.equal(second.proof.native.promptBoundaryVerified,true);
 assert.ok(second.proof.originals['prompt-boundaries.ndjson']);
 if(mode==='fix'){
  assert.equal(stage('fix').proof.native.sessionId,first.proof.native.sessionId);
  assert.equal(stage('fact-1').proof.native.sessionId,first.proof.native.sessionId);
  assert.equal(stage('impact-1').proof.native.sessionId,second.proof.native.sessionId);
  assert.equal(complete.result.fix.tested.passed,true);
  assert.notEqual(complete.result.fix.H1,complete.candidate.H);
 }
 const calls=await f.calls(),peerCalls=await peer.calls();
 await report();
 assert.deepEqual(await f.calls(),calls);assert.deepEqual(await peer.calls(),peerCalls);
 if(mode==='fix'){
  const {sourceFixture}=await import('../events/source-fixture.js');
  const {readEventSource}=await import('../../src/event-source.js');
  const {sourceTick}=await import('../../src/event-tick.js');
  const remote=await sourceFixture(t,'fixture/reception'),fix=complete.result.fix;
  f.q.events().configure(Buffer.from(canonical(remote.profile)));
  await remote.change({H:fix.H1,B:complete.candidate.B,target:complete.candidate.target,body:fix.proposedPRBody});
  await git(f.entry.objects,['fetch','--no-tags',fix.workspace,fix.H1]);
  await f.packet({H:fix.H1,B:complete.candidate.B,sourceAt:new Date().toISOString(),executionAt:new Date().toISOString()});
  await sourceTick(f.store);f.live.candidate.H=fix.H1;
  f.live.observation=await readEventSource(remote.profile,1,join(remote.root,'dual-review-publication'));
  assert.equal((await http(route+'/check',{})).status,200);
  const successor=async()=>{
    const state=(await http('/api/formal-review')).data;
    return state.entries[0].requests.find((r:any)=>r.previousOperation===operation);
  };
  await waitFor(async()=>{const next=await successor();return next?.phase==='pass'&&!next.controllerActive;});
  const checked=await successor();
  const followup=(await http('/api/formal-review-report/'+f.entry.id+'/'+checked.operation)).data;
  assert.equal(followup.candidate.H,fix.H1);
  assert.equal(followup.result.review.verdict,'PASS');
  assert.equal(followup.result.peerReview.verdict,'PASS');
  for(const [name,old] of [['correctness-initial',first],['impact-initial',second]] as const){
    const fresh=followup.fullStages.find((s:any)=>s.key.endsWith('/'+name));
    assert.notEqual(fresh.proof.native.sessionId,old.proof.native.sessionId);
  }
  t.diagnostic(JSON.stringify({reviewedH:complete.candidate.H,fixedH:fix.H1,originalReview:operation,newReview:checked.operation,
    sameOpenAIFixSession:first.proof.native.sessionId,retainedOriginalKimiSession:second.proof.native.sessionId}));
 }
});
for(const mode of ['missing-peer','late-peer','resume-live','replace-ended','replace-fix-wait'])test('dual controller '+mode+' verifies original capture and admission',async t=>{
 const {f,peer}=await dualPrograms(t,mode);
 if(mode==='replace-fix-wait')t.mock.method(QueueFormalRoundHost.prototype,'fixAvailable',async()=>({available:false,reason:'explicit_fixture_waiting_for_fix_authority'}));
 let unavailable=mode==='resume-live'||mode==='replace-ended',operation:string|undefined;
 const snapshot:AIPreferenceSnapshot={revision:0,scope:{account:{id:7},repository:{id:1,nodeId:'R_1',fullName:'fixture/reception'}},roles:{}};
 const read=async()=>{
  if(unavailable&&operation&&f.q.formalReviews().state(operation).stages.some((stage:any)=>stage.stage.key==='round-1/impact-initial'&&stage.returned))
    throw new Error('explicit_fixture_source_unavailable');
  return f.live;
 };
 const catalogSha256=hash(await readFile(f.catalog));
 const open=()=>FormalReviewControls.load(f.catalog,catalogSha256,f.sources,undefined,read,async()=>{},undefined,()=>snapshot);
 let control=await open();t.after(()=>control.drain());
 const id=f.entry.id,requestId='dual-controller-fixture';
 if(mode==='missing-peer'){
  await assert.rejects(control.prepare(id,requestId),/formal_second_company_not_configured/);
  assert.deepEqual((await control.state())[0]!.requests,[]);
  assert.equal((await f.calls()).length,0);
 }
 snapshot.roles.verifier_impact={tool:'kimi',executable:peer.binary,model:'fixture/model-next',effort:'future-depth',
  resolvedModel:null,settingsRevision:0,role:'verifier_impact',project:{account:7,repository:1,nodeId:'R_1'},catalogObservedAt:new Date().toISOString()};
 const prepared=await control.prepare(id,requestId);
 const op=prepared.operation as string;operation=op;
 const report=()=>control.report(id,op);
 await control.begin(id,op);
 await waitFor(async()=>!(await report()).controllerActive);
 const original=await report();
 if(mode==='replace-fix-wait'){
  assert.equal(original.detail.reason,'explicit_fixture_waiting_for_fix_authority');
  assert.equal(original.ownsOriginalSessions,true);
  const sent=await f.calls(),peerSent=await peer.calls();
  assert.ok(sent.length>2&&peerSent.length>2);
  await control.drain();control=await open();
  await control.begin(id,op);await waitFor(async()=>!(await report()).controllerActive);
  assert.equal((await report()).detail.reason,'formal_original_reviewer_context_not_owned');
  assert.equal((await control.replaceEndedDual(id,op,1)).executionRound,2);
  assert.deepEqual((await report()).fullStages,original.fullStages);
  assert.deepEqual(await f.calls(),sent);assert.deepEqual(await peer.calls(),peerSent);return;
 }
 if(mode==='late-peer'){
  assert.equal(original.phase,'waiting');assert.equal(original.result,null);
  assert.equal(original.detail.reason,'external_cli_text_outside_prompt');
  assert.equal(original.fullStages.find((s:{key:string})=>s.key.endsWith('/impact-initial'))!.proof,null);
  await assert.rejects(control.replaceEndedDual(id,op,1),/formal_dual_replacement_not_verified/);
  await control.begin(id,op);await waitFor(async()=>!(await report()).controllerActive);
  assert.equal((await peer.calls()).length,1);return;
 }
 if(unavailable){
  assert.equal(original.detail.reason,'explicit_fixture_source_unavailable');assert.equal(original.ownsOriginalSessions,true);
  const priorCodex=await f.calls(),priorPeer=await peer.calls();
  assert.equal(priorCodex.length,1);assert.equal(priorPeer.length,1);
  await assert.rejects(control.replaceEndedDual(id,op,1),/formal_dual_replacement_not_verified/);
  unavailable=false;
  if(mode==='replace-ended'){
   await control.drain();control=await open();
   await control.begin(id,op);await waitFor(async()=>!(await report()).controllerActive);
   assert.equal((await report()).detail.reason,'formal_original_reviewer_context_not_owned');
   const replacement=await control.replaceEndedDual(id,op,1);assert.equal(replacement.executionRound,2);
   assert.equal(replacement.resourcesSettled,true);
   await assert.rejects(control.replaceEndedDual(id,op,1),/formal_dual_replacement_not_verified/);
   assert.deepEqual(await f.calls(),priorCodex);assert.deepEqual(await peer.calls(),priorPeer);
  }
  await control.begin(id,op);await waitFor(async()=>!(await report()).controllerActive);
 }
 const complete=await report();
 assert.equal(complete.phase,'pass',JSON.stringify(complete.detail));
 const current=complete.fullStages.filter((s:{key:string})=>s.key.startsWith('round-'+complete.executionRound+'/'));
 assert.equal(current.length,4);assert.equal(current[1]!.proof.native.promptBoundaryVerified,true);
 assert.equal(current[0]!.proof.native.sessionId,current[2]!.proof.native.sessionId);
 assert.equal(current[1]!.proof.native.sessionId,current[3]!.proof.native.sessionId);
 assert.equal((await f.calls()).length,mode==='replace-ended'?3:2);
 assert.equal((await peer.calls()).length,mode==='replace-ended'?3:2);
 if(mode==='replace-ended'){
  const before=original.fullStages.filter((s:{proof:unknown})=>s.proof);assert.deepEqual(complete.fullStages.slice(0,2),before);
  for(let i=0;i<2;i++)assert.notEqual(current[i]!.proof.native.sessionId,before[i]!.proof.native.sessionId);
 }else if(mode==='resume-live')assert.deepEqual(current.slice(0,2),original.fullStages.filter((s:{proof:unknown})=>s.proof));
});

test('formal browser request cannot choose an unregistered source, authority or operation',async t=>{const f=await page(t);assert.equal((await f.post('/api/formal-review/not-selected/prepare',{requestId:'forged'})).status,503);const p=await(await f.post('/api/formal-review/'+f.entry.id+'/prepare',{requestId:'owned-stop'})).json() as any;assert.equal((await f.post('/api/formal-review/'+f.entry.id+'/stop',{operation:p.operation,authorization:'fake'})).status,503);assert.equal((await f.post('/api/formal-review/'+f.entry.id+'/stop',{operation:p.operation})).status,200);assert.equal((await f.post('/api/formal-review/'+f.entry.id+'/start',{operation:p.operation})).status,202);assert.equal((await f.calls()).length,0);});
test('normal configured source reader fetches the registered adopted Issue and PR originals through actual scoped GET processes',async t=>{const f=await formalFixture(t),{sourceFixture}=await import('../events/source-fixture.js'),{sourceTick}=await import('../../src/event-tick.js'),{canonical}=await import('../../src/comparison.js'),remote=await sourceFixture(t,'fixture/reception');await remote.change({H:f.live.candidate.H,B:f.live.candidate.B,target:f.live.candidate.target,related:{'repos/fixture/reception/issues/72':{number:72,body:f.live.issue.body,html_url:f.live.issue.url}}});f.q.events().configure(Buffer.from(canonical(remote.profile)));await sourceTick(f.store);const path=join(f.root,'actual-source-page.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Actual GET protocol fixture',goal:'No official models or remote',sources:f.sources.map(s=>({...s,title:'Explicit PR'})),formalReview:{path:f.catalog,sha256:hash(await readFile(f.catalog))}}));const app=await startWorkbench(path);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1),Origin:u.origin,'Content-Type':'application/json'},response=await fetch(u.origin+'/api/formal-review/'+f.entry.id+'/prepare',{method:'POST',headers,body:JSON.stringify({requestId:'original-scoped-reader'})}),r=await response.json() as any;assert.equal(response.status,200,JSON.stringify(r));const saved=await(await fetch(u.origin+'/api/formal-review-report/'+f.entry.id+'/'+r.operation,{headers})).json() as any;assert.equal(saved.material.issue.body,f.live.issue.body);assert.equal(saved.material.sourceEvidence.source,'original_registered_source_get');assert.ok((await remote.get()).requests.some((r:any)=>r.path==='repos/fixture/reception/issues/72'));assert.equal((await f.calls()).length,0);});

async function projectStopPage(t:test.TestContext){
 const f=await formalFixture(t,'refuted'),release=join(f.root,'release-review'),script=await readFile(f.n.config.codexExecutable,'utf8');
 await writeFile(f.n.config.codexExecutable,script.replace(/finishReview=r=>[^;]+;/,'finishReview=r=>{const wait=()=>{if(fs.existsSync('+JSON.stringify(release)+'))finish(r);else setTimeout(wait,10);};wait();};'));
 let offline=false,queries=0;const account={id:7,login:'fixture'},repository={id:1,nodeId:'R_1',full_name:'fixture/reception',description:'Explicit formal stop fixture',private:true,archived:false,defaultBranchRef:{name:'fixture',target:{oid:f.live.candidate.B}},updated_at:'2026-11-05T00:00:00Z'};
 const reader=async()=>({query:async(op:string)=>{queries++;if(offline)throw new Error('github_connection_unavailable');return {status:200,headers:{},provenance:'explicit local protocol fixture',body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repository],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository}})};}});
 const path=join(f.root,'project-stop-page.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Formal stop fixture',goal:'No external model or remote writes',githubProjects:true,sources:f.sources.map(s=>({...s,title:'Explicit PR'})),formalReview:{path:f.catalog,sha256:hash(await readFile(f.catalog))}}));
 const open=async()=>{const app=await startWorkbench(path,undefined,{githubReader:reader,formalSourceReader:async()=>f.live}),url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json','X-Tongxu-Account':'7','X-Tongxu-Project':'1'};let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};t.after(close);return {close,headers,get:(route:string)=>fetch(url.origin+route,{headers}),post:(action:string,body:unknown,overrides:Record<string,string>={},entry=f.entry.id)=>fetch(url.origin+'/api/formal-review/'+entry+'/'+action,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)})};};
 return {...f,open,release,setOffline:(v:boolean)=>{offline=v;},queries:()=>queries};
}
async function waitFor(check:()=>Promise<boolean>){for(let i=0;i<1000;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('formal_stop_fixture_timeout');}
for(const cold of [false,true])test('formal project stop is local, rejects wrong ownership and survives '+(cold?'cold offline reopen':'remote outage during reviewer'),async t=>{
 const f=await projectStopPage(t);let p=await f.open();assert.equal((await p.get('/api/github/projects')).status,200);const prepared=await(await p.post('prepare',{requestId:'offline-stop'})).json() as any;assert.ok(prepared.operation,JSON.stringify(prepared));const original=f.q.formalReviews().state(prepared.operation).request;
 if(cold){await p.close();p=await f.open();}else{assert.equal((await p.post('start',{operation:prepared.operation})).status,202);await waitFor(async()=>(await f.calls()).length===1);}
 f.setOffline(true);const before=f.queries(),body={operation:prepared.operation};
 for(const override of [{'X-Tongxu-Account':'8'},{'X-Tongxu-Project':'2'}] as Array<Record<string,string>>)assert.equal((await p.post('stop',body,override)).status,503);
 assert.equal((await p.post('stop',body,{},'not-selected')).status,503);assert.equal((await p.post('stop',{operation:'00000000-0000-4000-8000-000000000000'})).status,503);assert.equal((await p.post('stop',body,{Authorization:'Bearer invalid'})).status,401);assert.equal((await p.post('stop',body,{Origin:'http://wrong.invalid'})).status,403);assert.equal((await p.post('stop',{...body,source:'/not-permitted'})).status,503);assert.equal(f.q.formalReviews().state(prepared.operation).stopped,false);
 const stop=await p.post('stop',body);assert.equal(stop.status,200,JSON.stringify(await stop.json()));assert.equal(f.q.formalReviews().state(prepared.operation).stopped,true);assert.deepEqual(original.workbenchProject,{account:7,repository:1,fullName:'fixture/reception'});assert.equal((await p.post('stop',body)).status,200);assert.equal(f.queries(),before,'stop must not query GitHub or discover a project');assert.deepEqual(f.q.formalReviews().state(prepared.operation).request,original,'stop must not rewrite its frozen input');
 // Cleanup bypass is exclusive to stop; starting new work still queries source.
 assert.equal((await p.post('prepare',{requestId:'must-not-start-offline'})).status,503);assert.equal((await f.calls()).length,cold?0:1);if(!cold)assert.ok(f.queries()>before);
 f.setOffline(false);await writeFile(f.release,'return the held reviewer');if(cold){assert.equal((await p.get('/api/github/projects')).status,200);assert.equal((await p.post('start',body)).status,202);}
 await waitFor(async()=>{const state=await(await p.get('/api/formal-review')).json() as any;return !state.entries[0].requests[0].controllerActive;});assert.equal((await f.calls()).length,cold?0:1);const r=await(await p.get('/api/formal-review-report/'+f.entry.id+'/'+prepared.operation)).json() as any;assert.equal(r.stopped,true);assert.equal(r.result,null);assert.equal(r.fullStages.length,cold?0:1);await p.close();const restored=await f.open();await restored.get('/api/github/projects');assert.equal((await(await restored.get('/api/formal-review-report/'+f.entry.id+'/'+prepared.operation)).json() as any).stopped,true);assert.equal((await f.calls()).length,cold?0:1);
});
test('legacy formal request keeps its frozen input and needs an already discovered local project identity for offline stop',async t=>{
 const f=await projectStopPage(t),s=await f.controls.prepare(f.entry.id,'legacy-input'),original=f.q.formalReviews().state(s.operation).request;assert.equal(original.workbenchProject,undefined);let p=await f.open();f.setOffline(true);const before=f.queries(),body={operation:s.operation},rejected=await p.post('stop',body);assert.equal(rejected.status,503);assert.equal((await rejected.json() as any).error,'formal_stop_outside_project');assert.equal(f.queries(),before);assert.equal(f.q.formalReviews().state(s.operation).stopped,false);
 f.setOffline(false);assert.equal((await p.get('/api/github/projects')).status,200);f.setOffline(true);const known=f.queries();assert.equal((await p.post('stop',body,{'X-Tongxu-Project':'2'})).status,503);assert.equal((await p.post('stop',body)).status,200);assert.equal(f.queries(),known);assert.deepEqual(f.q.formalReviews().state(s.operation).request,original);assert.equal((await f.calls()).length,0);await p.close();p=await f.open();assert.equal((await p.post('stop',body)).status,503);assert.equal(f.q.formalReviews().state(s.operation).stopped,true);assert.equal((await f.calls()).length,0);
});

if(process.env.TONGXU_TEST_DOCKER_CONFIG)for(const mode of ['manual','timer','changed','default','unavailable'])test('formal project successor freezes current AI settings through the normal '+mode+' entry',async t=>{
 const f=await formalFixture(t,'confirmed'),account={id:7,login:'fixture'},repository={id:1,nodeId:'R_1',full_name:'fixture/reception',description:'Explicit AI setting fixture',private:true,archived:false,defaultBranchRef:{name:'fixture',target:{oid:f.live.candidate.B}},updated_at:'2026-11-05T00:00:00Z'},other={...repository,id:2,nodeId:'R_2',full_name:'fixture/other'};
 const reader=async()=>({query:async(op:string,variables:Record<string,unknown>)=>({status:200,headers:{},provenance:'explicit project protocol fixture',body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repository,other],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository:variables.id==='R_2'?other:repository}})})});
 let unavailable=false;
 const aiProbe=async(tool:any,path:string,directory:string):Promise<AIProvider>=>({id:hash(canonical([tool,path])).slice(0,24),tool,path,version:'explicit protocol fixture',available:!unavailable&&[f.n.config.codexExecutable,f.n.config.claudeExecutable].includes(path),reason:unavailable?'fixture_unavailable':null,authentication:'subscription',models:[{id:tool==='codex'?'fixture-astra':'fixture',resolvedId:null,name:'Explicit fixture model',description:'No official model',efforts:['max'],defaultEffort:null,isDefault:true}],observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:tool==='codex',ownedControl:tool==='codex',controlledReports:tool==='codex',impactReports:tool==='claude'},evidence:directory});
 const path=join(f.root,'project-ai-page.json');await writeFile(path,canonical({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Formal AI fixture',goal:'Protocol models and remote only',githubProjects:true,sources:f.sources.map(s=>({...s,title:'Explicit PR'})),formalReview:{path:f.catalog,sha256:hash(await readFile(f.catalog))},aiSettings:{root:join(f.root,'settings'),configured:[{tool:'codex',path:f.n.config.codexExecutable},{tool:'claude',path:f.n.config.claudeExecutable}],disabledMcpServers:[]}}));
 const app=await startWorkbench(path,undefined,{githubReader:reader,aiProbe,formalSourceReader:async()=>f.live});t.after(()=>app.close());const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),Origin:url.origin,'Content-Type':'application/json','X-Tongxu-Account':'7','X-Tongxu-Project':'1'},get=(p:string,project='1')=>fetch(url.origin+p,{headers:{...headers,'X-Tongxu-Project':project}}),post=async(p:string,body:unknown,project='1')=>{const r=await fetch(url.origin+p,{method:'POST',headers:{...headers,'X-Tongxu-Project':project},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};},route='/api/formal-review/'+f.entry.id;
 const until=async(check:()=>Promise<boolean>)=>{const end=Date.now()+60000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw new Error('formal_ai_fixture_timeout');};
 const state=async()=>{const r=await get('/api/formal-review');assert.equal(r.status,200);return (await r.json() as any).entries[0].requests;};
 assert.equal((await get('/api/github/projects')).status,200);
 // Start the actual foreground controller before saving choices, so a startup snapshot is insufficient.
 assert.equal((await get('/api/formal-review')).status,200);
 const scanned=await post('/api/ai-settings/scan',{});assert.equal(scanned.status,200);let revision=0;
 const change=async(role:string,effort:string|null,project='1')=>{const provider=scanned.body.catalog.find((p:any)=>p.path===(role==='verifier_impact'?f.n.config.claudeExecutable:f.n.config.codexExecutable)),result=await post('/api/ai-settings/role',{revision:project==='1'?revision:0,role,choice:{providerId:provider.id,model:role==='verifier_impact'?'fixture':'fixture-astra',effort}},project);assert.equal(result.status,200,JSON.stringify(result));if(project==='1')revision=result.body.revision;};
 if(mode!=='default')for(const role of ['reviewer','verifier_fact'])await change(role,mode==='changed'?null:'max');
 const prepared=await post(route+'/prepare',{requestId:'project-ai-'+mode});assert.equal(prepared.status,200);const operation=prepared.body.operation,original=structuredClone(f.q.formalReviews().state(operation).request);
 assert.equal((await post(route+'/start',{operation})).status,202);await until(async()=>!(await state())[0].controllerActive);const first=await(await get('/api/formal-review-report/'+f.entry.id+'/'+operation)).json() as any;assert.equal(first.phase,'awaiting_publication',JSON.stringify(first.detail));
 if(mode!=='default'){
  for(const stage of f.q.formalReviews().state(operation).stages.filter((s:any)=>s.stage.key.endsWith('/review')||s.stage.key.endsWith('/fact'))){const sent=(await readFile(join(stage.stage.directory,'stdin.ndjson'),'utf8')).trim().split('\n').map(s=>JSON.parse(s)),thread=sent.find(m=>m.method==='thread/start'),turn=sent.find(m=>m.method==='turn/start');assert.equal(thread.params.model,'fixture-astra');assert.equal(turn.params.model,'fixture-astra');assert.equal(turn.params.effort,mode==='changed'?undefined:'max');}
 }
 if(mode==='changed')for(const role of ['reviewer','verifier_fact'])await change(role,'max');
 // The legacy impact protocol fixture has no live model catalog. Freeze its choice for
 // the new round without claiming an actual selected-model Claude invocation.
 if(mode!=='default')await change('verifier_impact','max');
 // Another project's current page/settings cannot become this controller's source.
 await change('reviewer',null,'2');assert.equal((await(await get('/api/formal-review','2')).json() as any).available,false);assert.equal((await post(route+'/prepare',{requestId:'foreign'},'2')).status,503);
 if(mode==='unavailable'){unavailable=true;assert.equal((await post('/api/ai-settings/scan',{})).status,200);}
 const {sourceFixture}=await import('../events/source-fixture.js'),{readEventSource}=await import('../../src/event-source.js'),{sourceTick}=await import('../../src/event-tick.js'),remote=await sourceFixture(t,'fixture/reception'),fix=first.result.fix;
 f.q.events().configure(Buffer.from(canonical(remote.profile)));await remote.change({H:fix.H1,B:first.candidate.B,target:first.candidate.target,body:fix.proposedPRBody});await git(f.entry.objects,['fetch','--no-tags',fix.workspace,fix.H1]);await f.packet({H:fix.H1,B:first.candidate.B,sourceAt:new Date().toISOString(),executionAt:new Date().toISOString()});await sourceTick(f.store);f.live.candidate.H=fix.H1;f.live.observation=await readEventSource(remote.profile,1,join(remote.root,'project-ai-publication'));
 if(mode==='manual')assert.equal((await post(route+'/check',{})).status,200);
 if(mode==='unavailable'){
  await until(async()=>(await state())[0].detail?.reason==='ai_selected_provider_unavailable');assert.equal((await state()).length,1);assert.equal((await f.calls()).length,5);assert.deepEqual(f.q.formalReviews().state(operation).request,original);return;
 }
 await until(async()=>(await state()).some((s:any)=>s.round===2&&!s.controllerActive&&s.phase!=='prepared'));const child=(await state()).find((s:any)=>s.round===2),stored=f.q.formalReviews().state(child.operation),result=await(await get('/api/formal-review-report/'+f.entry.id+'/'+child.operation)).json() as any;assert.equal(result.phase,'pass',JSON.stringify(result.detail));
 const choices=stored.request.aiSelections;if(mode==='default')assert.deepEqual(choices,{});else for(const role of ['reviewer','verifier_fact','verifier_impact']){assert.ok(choices[role],JSON.stringify(choices));assert.equal(choices[role].model,role==='verifier_impact'?'fixture':'fixture-astra');assert.equal(choices[role].effort,'max');assert.equal(choices[role].settingsRevision,revision);assert.deepEqual(choices[role].project,{account:7,repository:1,nodeId:'R_1'});}
 const sent=(await readFile(join(stored.stages[0].stage.directory,'stdin.ndjson'),'utf8')).trim().split('\n').map(s=>JSON.parse(s)),thread=sent.find(m=>m.method==='thread/start'),turn=sent.find(m=>m.method==='turn/start');assert.equal(thread.params.model,mode==='default'?undefined:'fixture-astra');assert.equal(thread.params.config?.model_reasoning_effort,mode==='default'?undefined:'max');assert.equal(turn.params.model,mode==='default'?undefined:'fixture-astra');assert.equal(turn.params.effort,mode==='default'?undefined:'max');assert.deepEqual(f.q.formalReviews().state(operation).request,original);assert.equal((await f.calls()).length,6);await get('/api/formal-review-report/'+f.entry.id+'/'+child.operation);assert.equal((await f.calls()).length,6);
});
