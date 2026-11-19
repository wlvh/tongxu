import {join} from 'node:path';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {selectedProviderOptions} from './ai-settings.js';
import {ExtraCliSession,checkAcpSessionEvents,extraProfileFiles,parseAcpPrompt} from './additional-cli.js';
import {BoundedCodexSession,findingSchema,readRepairSession} from './repair-native.js';
import {checkCapture} from './live-process.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exists,processState,regular} from './repair-workspace.js';
import type {CodingWorkflowPrompt} from './coding-workflow-source.js';
import type {OwnedFormalFact} from './formal-review.js';
import type {QueueFormalRoundHost} from './formal-review-host.js';
import type {ReadRepairInbox} from './formal-repair-inbox.js';
import type {FormalReviews} from './formal-review-store.js';
import {formalBatch,formalDisagreements,formalReviewSchema,formalVerificationSchema,validateFormalReview,validateFormalVerification,type FormalReview} from './formal-review-contract.js';

export type DualReviewPrompts={
  correctness:CodingWorkflowPrompt; impact:CodingWorkflowPrompt;
  fact:CodingWorkflowPrompt; verificationImpact:CodingWorkflowPrompt;
};
const jsonInput=(facts:unknown)=>canonical(facts);
const jsonReport=(raw:string)=>JSON.parse(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw)?.[1]??raw);
function frames(bytes:Buffer){
  const text=new TextDecoder('utf8',{fatal:true}).decode(bytes);
  if(text&&!text.endsWith('\n'))throw new Error('external_cli_incomplete_frame');
  return text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
function verifyImpactBoundary(originals:Record<string,Buffer>,input:string,sessionId:string,requestId:number,final:string){
  const stdin=originals['stdin.ndjson']!,stdout=originals['stdout.ndjson']!;
  const boundaries=frames(originals['prompt-boundaries.ndjson']!).filter(row=>row.requestId===requestId);
  const boundary=boundaries[0],sent=frames(stdin),received=frames(stdout);
  const requests=sent.filter(row=>row.id===requestId),replies=received.filter(row=>!row.method&&row.id===requestId);
  const request=requests[0],reply=replies[0],terminal=received.indexOf(reply);
  if(boundaries.length!==1||requests.length!==1||replies.length!==1||boundary.schemaVersion!==1||
     request.method!=='session/prompt'||canonical(request.params)!==canonical({sessionId,prompt:[{type:'text',text:input}]})||
     !Number.isSafeInteger(boundary.stdinBytes)||boundary.stdinBytes<0||boundary.stdinBytes>=stdin.length||
     !Number.isSafeInteger(boundary.stdoutBytes)||boundary.stdoutBytes<0||boundary.stdoutBytes>=stdout.length||
     !Number.isSafeInteger(boundary.stdoutEvents)||boundary.stdoutEvents>terminal||
     hash(stdin.subarray(0,boundary.stdinBytes))!==boundary.stdinSha256||
     hash(stdout.subarray(0,boundary.stdoutBytes))!==boundary.stdoutSha256||
     hash(JSON.stringify(request)+'\n')!==boundary.requestSha256||
     stdin.subarray(boundary.stdinBytes).toString().split('\n')[0]!==JSON.stringify(request)||
     frames(stdout.subarray(0,boundary.stdoutBytes)).length!==boundary.stdoutEvents||
     received.slice(terminal+1).some(row=>row.params?.update?.sessionUpdate==='agent_message_chunk')||
     parseAcpPrompt(received.slice(boundary.stdoutEvents,terminal+1),sessionId,reply.result)!==final)
    throw new Error('formal_original_impact_capture_unbound');
}

export async function runDualFormalReviewRound(host:QueueFormalRoundHost,prompts:DualReviewPrompts,readInbox?:ReadRepairInbox){
  const {material,config}=host,source=material.candidate;
  const candidate={kind:'github-pr' as const,repository:source.repository,pr:source.pr,H:source.H,B:source.B,target:source.target};
  const key=(name:string)=>'round-'+host.round+'/'+name,kind=config.executionKind??'native_capture';
  const selected=host.aiSelections?.verifier_impact;
  if(selected?.tool!=='kimi'){
    const reason='formal_second_company_not_configured';
    host.progress('waiting',{reason,waitingFor:'Moonshot'});
    return {status:'waiting',reason};
  }
  let {gpt,kimi}=host.dual,retain=false,closingPeerForFix=false;
  let peerFinal:{input:string;sessionId:string;requestId:number;final:string}|undefined;
  const stageProof=(role:string,inputSha256:string,systemSha256:string,native:unknown)=>({
    role,inputSha256,systemSha256,candidate:source,completeCapture:true,executionKind:kind,native
  });
  const capturePrompt=async(name:string,input:string,schema:unknown,fix?:OwnedFormalFact)=>{
    const system=prompts.correctness.system,old=await host.original(key(name),input,system);
    if(old)return {report:old.report,sessionId:old.sessionId as string};
    const initial=name==='correctness-initial';
    const stage=await host.prepare(key(name),fix?'fix':'reviewer',input,system,fix?'fix':'analysis');
    host.activate(stage);
    if(!gpt){
      if(!initial||await exists(stage.directory))throw new Error('formal_original_reviewer_context_not_owned');
      const readonly=await host.reviewGate();
      gpt=host.dual.gpt=await BoundedCodexSession.start({
        ...selectedProviderOptions(host.aiSelections?.reviewer,'codex',config.codexExecutable),
        directory:stage.directory,operation:host.directory,candidate,role:'reviewer',system,inputManifestSha256:material.sha256,
        scopeSource:config.scopeSource,arrangementSource:'Formal review with the original reviewer retained through verification and authorized repair',
        disabledMcpServers:config.disabledMcpServers,allowedInstructionSources:config.allowedInstructionSources,
        timeoutMs:config.timeoutMs,executionKind:kind,projectRepair:true,
        gate:{
          check:async()=>{await host.refresh(host.activeStage());},
          call:async(p,before)=>host.activeStage().role==='fix'?(await host.factGate()).call(p,before):readonly.call(p,before)
        },
        beforeTurn:()=>host.refresh(host.activeStage()),dispatchGate:effect=>host.submit(host.activeStage(),effect)
      });
    }
    const report=await gpt.turn(input,candidate,schema),capture=await gpt.snapshotCompletedTurn();
    if(capture.input.input!==input||capture.binding.role!=='reviewer'||capture.binding.inputManifestSha256!==material.sha256||
      canonical(capture.report)!==canonical(report))throw new Error('formal_original_native_input_or_result_changed');
    const native={company:'OpenAI',sessionId:capture.binding.sessionId,threadId:capture.binding.threadId,turnId:capture.turnId};
    host.record(stage,report,stageProof('reviewer',stage.inputSha256,stage.systemSha256,native),capture.originals);
    return {report,sessionId:native.sessionId};
  };
  const captureImpact=async(name:string,input:string,parse:(value:unknown)=>unknown)=>{
    const system=prompts.impact.system,old=await host.original(key(name),input,system);
    if(old){
      peerFinal={input,sessionId:old.sessionId,requestId:old.requestId,final:old.finalText};
      return {report:parse(jsonReport(old.finalText)),sessionId:old.sessionId as string};
    }
    const stage=await host.prepare(key(name),'verifier_impact',input,system,'analysis');host.activate(stage);
    if(!kimi){
      if(name!=='impact-initial'||await exists(stage.directory))throw new Error('formal_original_impact_context_not_owned');
      await host.refresh(stage);
      kimi=await ExtraCliSession.open('kimi',selected.executable,stage.directory,system,kind==='fixture');
      try{await kimi.select({model:selected.model,effort:selected.effort});}
      catch(error){await kimi.close();throw error;}
      host.dual.kimi=kimi;
    }
    const {final,requestId}=await kimi.prompt(input,config.timeoutMs,undefined,()=>host.refresh(stage),effect=>host.submit(stage,effect));
    const report=parse(jsonReport(final)),sessionId=kimi.session.sessionId,originals:Record<string,Buffer>={};
    const names=['stdin.ndjson','stdout.ndjson','prompt-boundaries.ndjson','profile.json','executable.json','launch.json','process.json','initialize.json','session.json','selection.json',
      ...Object.keys(extraProfileFiles('kimi',kimi.directory,system)),...(kind==='native_capture'?['profile-observed.json']:[])];
    let bytes=0;
    for(const file of names){
      const original=await regular(join(kimi.directory,file),16*1024*1024);
      if((bytes+=original.length)>24*1024*1024)throw new Error('native_original_turn_capture_limit');
      originals[file]=original;
    }
    kimi.assertCanForward();
    verifyImpactBoundary(originals,input,sessionId,requestId,final);
    const native={company:'Moonshot',sessionId,requestId,model:selected.model,promptBoundaryVerified:true};
    host.record(stage,{finalText:final,report},stageProof('verifier_impact',stage.inputSha256,stage.systemSha256,native),originals);
    peerFinal={input,sessionId,requestId,final};
    return {report,sessionId};
  };
  const parseReview=(value:unknown)=>validateFormalReview(value,candidate.H,material.sha256);
  const reviewFor=(phase:string,context:unknown)=>jsonInput({phase,material,context,responseShape:formalReviewSchema});
  const capture=async(directory:string,names:string[])=>Object.fromEntries(await Promise.all(names.map(async name=>[name,await regular(join(directory,name),16*1024*1024)] as const)));
  const captureFiles=['stdin.ndjson','stdout.ndjson','stderr.txt','exit.json','capture-status.json'];
  const laneDirectory=(lane:string)=>join(host.directory,key(lane+'-initial').replace('/','-'));
  const closedPeer=async()=>{
    if(!peerFinal)throw new Error('formal_dual_terminal_capture_missing');
    const directory=laneDirectory('impact');
    await checkCapture(directory);
    const parts=await capture(directory,[...captureFiles,'prompt-boundaries.ndjson','process.json']);
    const status=JSON.parse(parts['capture-status.json']!.toString()),process=JSON.parse(parts['process.json']!.toString());
    if(status.status!=='complete'||status.failure!==null||process.status!=='spawn_attempted'||processState(process.pid)!=='ended'||
       captureFiles.slice(0,3).some(name=>hash(parts[name]!)!==status.files?.[name]))
      throw new Error('formal_original_impact_capture_unbound');
    checkAcpSessionEvents(frames(parts['stdout.ndjson']!),peerFinal.sessionId);
    const stages=host.q.formalReviews().state(host.operation).stages as ReturnType<FormalReviews['stage']>[];
    for(const stage of stages.filter(s=>s.stage.key.startsWith(key('impact-'))&&s.returned)){
      for(const name of ['stdin.ndjson','stdout.ndjson','prompt-boundaries.ndjson']){
        const saved=stage.returned!.proof.originals[name],bytes=parts[name]!;
        if(!saved||saved.bytes>bytes.length||hash(bytes.subarray(0,saved.bytes))!==saved.sha256)
          throw new Error('formal_original_impact_capture_unbound');
      }
    }
    verifyImpactBoundary(parts,peerFinal.input,peerFinal.sessionId,peerFinal.requestId,peerFinal.final);
    return {directory,parts};
  };
  const closedLanes=async(extra:Record<string,unknown>)=>{
    if(!peerFinal)throw new Error('formal_dual_terminal_capture_missing');
    await host.closeDual();
    const openai=laneDirectory('correctness');
    const completed=await readRepairSession(openai),conclusion=completed.turns.at(-1)?.final;
    if(!conclusion||canonical(parseReview(JSON.parse(conclusion.text)))!==canonical(extra.review))throw new Error('formal_dual_terminal_capture_changed');
    const [a,{parts:b}]=await Promise.all([capture(openai,captureFiles),closedPeer()]);
    delete b['process.json'];
    const refs=(parts:Record<string,Buffer>)=>Object.fromEntries(Object.entries(parts).map(([name,bytes])=>[name,hash(bytes)]));
    const originals=[...Object.values(a),...Object.values(b)];
    if(originals.reduce((bytes,value)=>bytes+value.length,0)>32*1024*1024)throw new Error('native_original_turn_capture_limit');
    host.q.formalReviews().retainEvidence(host.operation,new Map(originals.map(bytes=>[hash(bytes),bytes])));
    return {openai:{sessionId:completed.binding.sessionId,files:refs(a)},moonshot:{sessionId:peerFinal.sessionId,files:refs(b)}};
  };
  const finish=async(status:string,extra:Record<string,unknown>={})=>{
    const originalClosure=status==='pass'?await closedLanes(extra):undefined;
    await host.phaseEnded('analysis');
    return host.finish({status,candidate:source,...extra,...(originalClosure?{originalClosure}:{})});
  };
  try{
    const firstInput=reviewFor('independent-initial',null);
    const first=await capturePrompt('correctness-initial',firstInput,formalReviewSchema);
    const second=await captureImpact('impact-initial',firstInput,parseReview);
    const correctness=parseReview(first.report),impact=parseReview(second.report);
    const exchangedCorrectness=await capturePrompt('correctness-exchange',reviewFor('initial-report-exchange',impact),formalReviewSchema);
    const exchangedImpact=await captureImpact('impact-exchange',reviewFor('initial-report-exchange',correctness),parseReview);
    if(first.sessionId!==exchangedCorrectness.sessionId||second.sessionId!==exchangedImpact.sessionId)throw new Error('formal_original_reviewer_context_changed');
    const reviews=[parseReview(exchangedCorrectness.report),parseReview(exchangedImpact.report)];
    const verdicts={review:reviews[0],peerReview:reviews[1],reviewKey:key('correctness-exchange'),peerReviewKey:key('impact-exchange')};
    if(reviews.every(r=>r.verdict==='PASS'))return await finish('pass',verdicts);
    if(reviews.some(r=>r.verdict==='OWNER_DECISION_REQUIRED'))return await finish('owner_decision',verdicts);
    const findings=reviews.flatMap((r,index)=>r.findings.filter(f=>f.priority<2).map(f=>({...f,id:(index?'impact:':'correctness:')+f.id})));
    if(!findings.length)return await finish('needs_evidence',verdicts);
    const batch=formalBatch(source,{...reviews[0]!,verdict:'REWORK_REQUIRED',findings} satisfies FormalReview);
    const evidence=(prompt:CodingWorkflowPrompt,other:unknown)=>jsonInput({
      instructions:prompt.system,workflowSource:{revision:prompt.revision,use:prompt.use,sha256:prompt.sha256},
      material,batch,other,responseShape:formalVerificationSchema
    });
    const verification=(value:unknown)=>validateFormalVerification(value,batch);
    let fact=verification((await capturePrompt('fact-0',evidence(prompts.fact,null),formalVerificationSchema)).report);
    let assessed=verification((await captureImpact('impact-0',evidence(prompts.verificationImpact,null),verification)).report);
    let rounds=0;
    for(let round=1;round<=3;round++){
      const previous={fact,assessed};
      fact=verification((await capturePrompt('fact-'+round,evidence(prompts.fact,previous.assessed),formalVerificationSchema)).report);
      assessed=verification((await captureImpact('impact-'+round,evidence(prompts.verificationImpact,previous.fact),verification)).report);
      rounds=round;
      if(!formalDisagreements(fact,assessed).length&&fact.assessments.every(a=>a.decision!=='needs_evidence'))break;
    }
    const batchResult={...verdicts,batchSha256:batch.sha256,exchangeRounds:rounds,synthesis:fact};
    if(formalDisagreements(fact,assessed).length||fact.assessments.some(a=>a.decision==='needs_evidence'))return await finish('needs_evidence',batchResult);
    if(fact.assessments.every(a=>a.decision==='refuted')){
      const context={refutedBatch:batch,fact,assessed};
      const confirmed=await capturePrompt('correctness-final',reviewFor('conclude-unchanged-candidate',context),formalReviewSchema);
      const confirmedPeer=await captureImpact('impact-final',reviewFor('conclude-unchanged-candidate',context),parseReview);
      const a=parseReview(confirmed.report),b=parseReview(confirmedPeer.report);
      return await finish(a.verdict==='PASS'&&b.verdict==='PASS'?'pass':'needs_evidence',{
        ...batchResult,review:a,peerReview:b,reviewKey:key('correctness-final'),peerReviewKey:key('impact-final')
      });
    }
    await host.phaseEnded('analysis');
    if(!gpt)throw new Error('formal_original_reviewer_context_not_owned');
    if(gpt.sessionId!==first.sessionId)throw new Error('formal_original_reviewer_context_changed');
    const available=await host.fixAvailable();
    if(!available.available){
      retain=host.retainDual();
      const reason=available.reason??'formal_fix_authority_required';
      host.progress('waiting',{reason,waitingFor:'authorized_fix',batchSha256:batch.sha256});return {status:'waiting',reason};
    }
    // The peer's analysis is finished. Drain its transport while retaining the
    // owned Codex session, then bind the final ACP capture to the write gate.
    closingPeerForFix=true;
    await kimi?.close();
    delete host.dual.kimi;
    const {directory,parts}=await closedPeer();
    kimi?.assertCanForward();
    const checkFixPeer=()=>{
      try{lstatSync(join(directory,'capture-failure.json'));throw new Error('stage_capture_failed');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      for(const [name,bytes] of Object.entries(parts)){
        const path=join(directory,name),stat=lstatSync(path);
        if(!stat.isFile()||stat.nlink!==1||stat.size!==bytes.length||realpathSync(path)!==path||!readFileSync(path).equals(bytes))
          throw new Error('formal_original_impact_capture_unbound');
      }
    };
    const original:OwnedFormalFact={session:gpt,gate:await host.factGate(),firstSessionId:first.sessionId,firstThreadId:gpt.executionBinding.threadId};
    const inbox=await host.repairInbox(readInbox);
    const revisions=await host.admitRepairRevisions(inbox);
    const input=jsonInput({instructions:prompts.fact.system,stage:'authorized-repair',material,batch,fact,assessed,
      ...(inbox.length?{projectSupplements:{policy:'Acknowledge each related request by requestId and explain its impact or dependency. Only entries with a reviewed revision are adopted in this turn. Implement those within the authorized files and preserve the original findings and requirements. If the approved scope cannot cover a revision, report the blocker. The host verifies the registered acceptance against the resulting candidate separately.',items:inbox}}:{}),
      responseShape:findingSchema});
    const stage=await host.prepare(key('fix'),'fix',input,prompts.correctness.system,'fix');
    host.activate(stage);await host.refresh(stage);
    host.bindDualFixPeer(checkFixPeer);
    await original.gate.handoff(original.firstSessionId,'same_fact_verifier_session',checkFixPeer);
    const result=await capturePrompt('fix',input,findingSchema,original);
    if(result.report.decision!=='repaired'){
      await host.phaseEnded('fix');
      return await host.finish({status:result.report.decision==='needs_owner'?'owner_decision':'needs_evidence',candidate:source,...batchResult,report:result.report});
    }
    const fixed=await host.commitFix(result.report,original,revisions);await host.phaseEnded('fix');
    return await host.finish({status:'awaiting_publication',candidate:source,...batchResult,fix:fixed});
  }catch(error){retain=!closingPeerForFix&&host.retainDual();throw error;}
  finally{if(!retain)await host.closeDual();}
}
