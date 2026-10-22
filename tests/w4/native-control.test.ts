import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {BoundedCodexSession,readOwnedCodexSession,findingSchema,type NativeOptions} from '../../src/repair-native.js';
import {disabledFeatures} from '../../src/live-codex.js';
import type {NativeControlRequest,NativeControlPolicy} from '../../src/native-control-contract.js';
import {parseCodexResult} from '../../src/codex-results.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

async function setup(t:test.TestContext,policy?:NativeControlPolicy,persistent=false){
  const root=await mkdtemp('/private/tmp/tongxu-owned-control-');t.after(async()=>{if(process.env.TONGXU_NATIVE_CONTROL_TEST_EVIDENCE){await mkdir(process.env.TONGXU_NATIVE_CONTROL_TEST_EVIDENCE,{recursive:true});await cp(root,join(process.env.TONGXU_NATIVE_CONTROL_TEST_EVIDENCE,basename(root)),{recursive:true});}await rm(root,{recursive:true,force:true});});const executable=join(root,'codex-fixture.mjs'),operation=join(root,'operation');await mkdir(operation);
  const script=`#!${process.execPath}
import readline from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');let thread=null,turn=null,n=0,history=[];
const persist=()=>{if(thread&&!thread.ephemeral)writeFileSync(${JSON.stringify(join(root,'fixture-native-history.json'))},JSON.stringify({thread,history,n}));};
const replyThread=()=>({thread,cwd:thread.cwd,approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},modelProvider:'openai',instructionSources:[]});
if(process.argv.includes('--version')){console.log('codex-cli 0.163.0-alpha.10.2');process.exit(0)}
const finish=()=>{const item={id:'answer-'+n,type:'agentMessage',text:JSON.stringify({candidateH:turn.H,decision:'confirmed',report:turn.steering}),phase:'final_answer'};emit({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,completedAtMs:100,item}});const ended={id:turn.id,status:'completed',items:[item],error:null};emit({method:'turn/completed',params:{threadId:thread.id,turn:ended}});history.push(ended);turn=null;persist();};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),ok=result=>emit({id:m.id,result});
if(m.method==='initialize')ok({userAgent:'explicit-control-fixture'});
else if(m.method==='account/read')ok({account:{type:'chatgpt'}});
else if(m.method==='config/read')ok({config:{web_search:'disabled',model_provider:'openai',service_tier:'default',features:Object.fromEntries(${JSON.stringify(disabledFeatures)}.map(x=>[x,false])),mcp_servers:{}}});
else if(m.method==='account/rateLimits/read')ok({ordinaryUsageAllowed:true});
else if(m.method==='thread/start'){thread={id:'fixture-thread',sessionId:'fixture-thread',cwd:m.params.cwd,cliVersion:'0.163.0-alpha.10.2',source:'vscode',ephemeral:m.params.ephemeral,parentThreadId:null,forkedFromId:null};ok(replyThread());emit({method:'thread/started',params:{thread}});persist();}
else if(m.method==='thread/resume'){const saved=JSON.parse(readFileSync(${JSON.stringify(join(root,'fixture-native-history.json'))},'utf8'));thread=saved.thread;history=saved.history;n=saved.n;ok(replyThread());}
else if(m.method==='thread/read')ok({thread:{...thread,status:{type:'idle'},turns:history}});
else if(m.method==='turn/start'){turn={id:'fixture-turn-'+(++n),H:JSON.parse(m.params.input[0].text).candidateH,steering:'No steering yet'};ok({turn:{id:turn.id}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id:turn.id,status:'inProgress',items:[],rootTurnId:turn.id}}});}
else if(m.method==='turn/steer'){if(!turn||m.params.expectedTurnId!==turn.id){emit({id:m.id,error:{code:-32600,message:'wrong turn'}});return;}turn.steering=m.params.input[0].text;ok({turnId:turn.id});setTimeout(finish,20);}
else if(m.method==='turn/interrupt'){ok({});setTimeout(()=>{const ended={id:turn.id,status:'interrupted',items:[],error:null};emit({method:'turn/completed',params:{threadId:thread.id,turn:ended}});history.push(ended);turn=null;persist();},20);}
});
`;
  await writeFile(executable,script,{mode:0o700});const candidate={kind:'local-git' as const,repository:'local/control-fixture',pr:null,H:'a'.repeat(40),B:'a'.repeat(40),target:'fixture'},options:NativeOptions={executable,directory:join(operation,'capture'),operation,candidate,role:'verifier_fact',system:'Explicit synthetic controller protocol fixture; no official model invoked.',inputManifestSha256:'b'.repeat(64),scopeSource:'fixture:owned-control',disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:2000,executionKind:'fixture',persistent,...(policy?{control:policy}:{})};
  const session=await BoundedCodexSession.start(options);t.after(()=>session.close());const active=async()=>{const until=Date.now()+2000;while(Date.now()<until){const s=session.controlState();if(s.currentTurnActive)return s;await new Promise(r=>setTimeout(r,5));}throw new Error('fixture_no_active_turn');};
  const request=(s:ReturnType<typeof session.controlState>,id:string,action:'steer'|'interrupt'):NativeControlRequest=>({id,action,threadId:s.threadId!,sessionId:s.sessionId!,turnId:s.turnId!,input:action==='steer'?'Check the explicit counterexample and keep the exact candidate.':null});
  const frames=async()=>JSON.parse('['+(await readFile(join(options.directory,'stdin.ndjson'),'utf8')).trim().split('\n').join(',')+']');return {root,session,options,candidate,active,request,frames};
}

test('exact owned turn accepts steer once; wrong IDs and concurrent duplicate cannot send a replacement turn',async t=>{
  let release!:()=>void;const wait=new Promise<void>(r=>release=r),checks:string[]=[];
  const f=await setup(t,{beforeControl:async r=>{checks.push(r.id);await wait;},beforeControlSendSync:(r,send)=>{checks.push('send:'+r.id);send();}}),pending=f.session.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema),state=await f.active(),request=f.request(state,'steer-1','steer');
  await assert.rejects(f.session.control({...request,id:'wrong',turnId:'wrong-turn'}),/exact_active_turn/);await assert.rejects(f.session.turn('{}',f.candidate,findingSchema),/native_turn_already_active/);
  const first=f.session.control(request);await assert.rejects(f.session.control(request),/original_outcome_unknown/);release();const ack=await first,final=await pending;assert.equal(ack.acknowledged,true);assert.equal(ack.turnTerminationVerified,false);assert.equal(final.report,request.input);
  assert.deepEqual(await f.session.control(request),ack);const frames=await f.frames();assert.equal(frames.filter((m:any)=>m.method==='turn/start').length,1);assert.equal(frames.filter((m:any)=>m.method==='turn/steer').length,1);assert.deepEqual(checks,['steer-1','send:steer-1']);assert.equal(f.session.controlState().pauseSupported,false);
  await assert.rejects(f.session.control({...request,input:'different'}),/native_control_id_changed/);await f.session.close();const inputs=JSON.parse(await readFile(join(f.options.directory,'inputs.json'),'utf8'));assert.equal(inputs[0].steering[0].input,request.input);
});
test('known pre-send refusal can retry without erasing it; interrupt ack is distinct from terminal and a later turn is explicit',async t=>{
  let allowed=false;const f=await setup(t,{beforeControl:async()=>{if(!allowed)throw new Error('fixture_revoked_before_send');},beforeControlSendSync:(_r,send)=>{if(!allowed)throw new Error('fixture_revoked_before_wire');send();}}),pending=f.session.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema),ended=assert.rejects(pending,/native_turn_interrupted/),state=await f.active(),request=f.request(state,'stop-1','interrupt');
  await assert.rejects(f.session.control(request),/fixture_revoked_before_send/);assert.equal((await f.frames()).filter((m:any)=>m.method==='turn/interrupt').length,0);allowed=true;const ack=await f.session.control(request);assert.equal(ack.turnTerminationVerified,false);await ended;assert.equal(f.session.controlState().currentTurnActive,false);
  await readFile(join(f.options.directory,'control-stop-1-attempt-1-problem.json'));await readFile(join(f.options.directory,'control-stop-1-attempt-2-ack.json'));
  const next=f.session.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema),current=await f.active();assert.notEqual(current.turnId,state.turnId);await assert.rejects(f.session.control({...request,id:'old-stop'}),/exact_active_turn/);await f.session.control(f.request(current,'steer-2','steer'));await next;await f.session.close();
  await assert.rejects(readFile(join(f.options.directory,'completed.json')),{code:'ENOENT'});const capture=JSON.parse(await readFile(join(f.options.directory,'control-state.json'),'utf8'));assert.equal(capture.permissionGranted,false);assert.equal(capture.requests.length,2);
  const raw=await readFile(join(f.options.directory,'stdout.ndjson')),binding=JSON.parse(await readFile(join(f.options.directory,'binding.json'),'utf8'));assert.ok(parseCodexResult(raw,binding).gaps.includes('turn_order_mismatch'));const parsed=parseCodexResult(raw,binding,[],{allowInterruptedPredecessors:true});assert.deepEqual(parsed.gaps,[]);assert.equal(parsed.status,'interrupted');assert.equal(parsed.handoffReady,false);assert.equal(parsed.turns[0]!.final,null);assert.ok(parsed.turns[1]!.final);
});
test('existing runtimes do not gain control from metadata or an uninstalled owner gate',async t=>{
  const f=await setup(t),pending=f.session.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema);const rejection=assert.rejects(pending);const state=await f.active();await assert.rejects(f.session.control(f.request(state,'steer-denied','steer')),/owner_gate_required/);assert.equal((await f.frames()).filter((m:any)=>m.method==='turn/steer').length,0);await f.session.close();await rejection;
});

test('a retained send closure expires at the synchronous gate return, including a held refusal',async t=>{
  let later:(()=>void)|undefined;const f=await setup(t,{beforeControl:async()=>{},beforeControlSendSync:(_r,send)=>{later=send;}}),pending=f.session.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema),ended=assert.rejects(pending),state=await f.active();
  await assert.rejects(f.session.control(f.request(state,'held-closure','steer')),/send_not_authorized/);
  assert.ok(later);assert.throws(()=>later!(),/send_gate_expired/);assert.equal((await f.frames()).filter((m:any)=>m.method==='turn/steer').length,0);
  await f.session.close();await ended;
});
test('caller mutation during the asynchronous check cannot change the fixed request, wire or receipt digest',async t=>{
  let release!:()=>void;const wait=new Promise<void>(r=>release=r),f=await setup(t,{beforeControl:async()=>wait,beforeControlSendSync:(_r,send)=>send()}),pending=f.session.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema),state=await f.active(),request=f.request(state,'fixed-request','steer'),original=structuredClone(request);
  const control=f.session.control(request);request.input='A changed caller input that was not checked.';release();const receipt=await control,report=await pending;
  assert.deepEqual(receipt.request,original);assert.equal(receipt.requestSha256,hash(canonical(original)));assert.equal(report.report,original.input);assert.equal((await f.frames()).find((m:any)=>m.method==='turn/steer').params.input[0].text,original.input);
  await f.session.close();
});

test('persistent original resumes exact history; interruption survives restart and old-source replay is refused',async t=>{
  const policy:NativeControlPolicy={beforeControl:async()=>{},beforeControlSendSync:(_r,send)=>send()},f=await setup(t,policy,true);
  const first=f.session.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema);const state=await f.active();
  await assert.rejects(BoundedCodexSession.start({...f.options,directory:join(f.options.operation,'competitor')}),/owned_controller_active/);
  await f.session.control(f.request(state,'first-steer','steer'));await first;await f.session.close();
  const prior=await readOwnedCodexSession(f.options.directory);assert.equal(prior.parsed.status,'final_observed');
  await assert.rejects(BoundedCodexSession.start({...f.options,system:'changed',directory:join(f.options.operation,'wrong'),resumeFrom:f.options.directory}),/original_scope_changed/);
  const secondPath=join(f.options.operation,'resume'),second=await BoundedCodexSession.start({...f.options,directory:secondPath,resumeFrom:f.options.directory});t.after(()=>second.close());assert.equal(second.sessionId,prior.binding.sessionId);
  const secondTurn=second.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema),interrupted=assert.rejects(secondTurn,/native_turn_interrupted/);let s=second.controlState();while(!s.currentTurnActive){await new Promise(r=>setTimeout(r,5));s=second.controlState();}
  await second.control({...f.request(s,'interrupt-resumed','interrupt')});await interrupted;await second.close();
  const captured=await readOwnedCodexSession(secondPath);assert.equal(captured.depth,2);assert.equal(captured.parsed.status,'interrupted');assert.deepEqual(captured.parsed.turns.map(t=>t.terminal),['completed','interrupted']);
  const raw=await readFile(join(secondPath,'stdout.ndjson'),'utf8');assert.equal(raw.includes('thread/started'),false);assert.equal(captured.raw.subarray(0,prior.raw.length).equals(prior.raw),true);
  await assert.rejects(BoundedCodexSession.start({...f.options,directory:join(f.options.operation,'stale'),resumeFrom:f.options.directory}),/history_changed_or_active/);
  const thirdPath=join(f.options.operation,'resume-after-interrupt'),third=await BoundedCodexSession.start({...f.options,directory:thirdPath,resumeFrom:secondPath});t.after(()=>third.close());
  const thirdTurn=third.turn(JSON.stringify({candidateH:f.candidate.H}),f.candidate,findingSchema);s=third.controlState();while(!s.currentTurnActive){await new Promise(r=>setTimeout(r,5));s=third.controlState();}
  await third.control(f.request(s,'final-steer','steer'));await thirdTurn;await third.close();const final=await readOwnedCodexSession(thirdPath);assert.deepEqual(final.parsed.turns.map(t=>t.terminal),['completed','interrupted','completed']);assert.equal(final.parsed.handoffReady,false);
  assert.equal((await readFile(join(thirdPath,'stdin.ndjson'),'utf8')).includes('thread/start'),false);await assert.rejects(readFile(join(thirdPath,'completed.json')),{code:'ENOENT'});
});
