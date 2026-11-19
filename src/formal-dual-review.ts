import {join} from 'node:path';
import {selectedProviderOptions} from './ai-settings.js';
import {ExtraCliSession,extraProfileFiles} from './additional-cli.js';
import {BoundedCodexSession,findingSchema} from './repair-native.js';
import {canonical} from './comparison.js';
import {exists,regular} from './repair-workspace.js';
import type {CodingWorkflowPrompt} from './coding-workflow-source.js';
import type {FormalRoundHost,OwnedFormalFact} from './formal-review.js';
import {formalBatch,formalDisagreements,formalReviewSchema,formalVerificationSchema,validateFormalReview,validateFormalVerification,type FormalReview} from './formal-review-contract.js';

export type DualReviewPrompts={
  correctness:CodingWorkflowPrompt; impact:CodingWorkflowPrompt;
  fact:CodingWorkflowPrompt; verificationImpact:CodingWorkflowPrompt;
};
const jsonInput=(facts:unknown)=>canonical(facts);
const jsonReport=(raw:string)=>JSON.parse(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw)?.[1]??raw);

export async function runDualFormalReviewRound(host:FormalRoundHost,prompts:DualReviewPrompts){
  const {material,config}=host,source=material.candidate;
  const candidate={kind:'github-pr' as const,repository:source.repository,pr:source.pr,H:source.H,B:source.B,target:source.target};
  const key=(name:string)=>'round-'+host.round+'/'+name,kind=config.executionKind??'native_capture';
  const selected=host.aiSelections?.verifier_impact;
  if(selected?.tool!=='kimi'){
    const reason='formal_second_company_not_configured';
    host.progress('waiting',{reason,waitingFor:'Moonshot'});
    return {status:'waiting',reason};
  }
  let gpt=host.ownedFact()?.session,kimi:ExtraCliSession|undefined,retainGpt=false;
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
      gpt=await BoundedCodexSession.start({
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
    if(old)return {report:parse(jsonReport(old.finalText)),sessionId:old.sessionId as string};
    const stage=await host.prepare(key(name),'verifier_impact',input,system,'analysis');host.activate(stage);
    if(!kimi){
      if(name!=='impact-initial'||await exists(stage.directory))throw new Error('formal_original_impact_context_not_owned');
      await host.refresh(stage);
      kimi=await ExtraCliSession.open('kimi',selected.executable,stage.directory,system,kind==='fixture');
      await kimi.select({model:selected.model,effort:selected.effort});
    }
    const {final,requestId}=await kimi.prompt(input,config.timeoutMs,undefined,()=>host.refresh(stage),effect=>host.submit(stage,effect));
    const report=parse(jsonReport(final)),sessionId=kimi.session.sessionId,originals:Record<string,Buffer>={};
    const names=['stdin.ndjson','stdout.ndjson','profile.json','executable.json','launch.json','process.json','initialize.json','session.json','selection.json',
      ...Object.keys(extraProfileFiles('kimi',kimi.directory,system)),...(kind==='native_capture'?['profile-observed.json']:[])];
    let bytes=0;
    for(const file of names){
      const original=await regular(join(kimi.directory,file),16*1024*1024);
      if((bytes+=original.length)>24*1024*1024)throw new Error('native_original_turn_capture_limit');
      originals[file]=original;
    }
    kimi.assertCanForward();
    const native={company:'Moonshot',sessionId,requestId,model:selected.model};
    host.record(stage,{finalText:final,report},stageProof('verifier_impact',stage.inputSha256,stage.systemSha256,native),originals);
    return {report,sessionId};
  };
  const parseReview=(value:unknown)=>validateFormalReview(value,candidate.H,material.sha256);
  const reviewFor=(phase:string,context:unknown)=>jsonInput({phase,material,context,responseShape:formalReviewSchema});
  const finish=async(status:string,extra:Record<string,unknown>={})=>{
    await host.phaseEnded('analysis');
    return host.finish({status,candidate:source,...extra});
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
    const original:OwnedFormalFact={session:gpt,gate:await host.factGate(),firstSessionId:first.sessionId,firstThreadId:gpt.executionBinding.threadId};
    if(gpt.sessionId!==original.firstSessionId)throw new Error('formal_original_reviewer_context_changed');
    const available=await host.fixAvailable();
    if(!available.available){
      retainGpt=true;host.holdFact(original);
      const reason=available.reason??'formal_fix_authority_required';
      host.progress('waiting',{reason,waitingFor:'authorized_fix',batchSha256:batch.sha256});return {status:'waiting',reason};
    }
    const input=jsonInput({instructions:prompts.fact.system,stage:'authorized-repair',material,batch,fact,assessed,responseShape:findingSchema});
    const stage=await host.prepare(key('fix'),'fix',input,prompts.correctness.system,'fix');
    host.activate(stage);await host.refresh(stage);await original.gate.handoff(original.firstSessionId);
    const result=await capturePrompt('fix',input,findingSchema,original);
    if(result.report.decision!=='repaired'){
      await host.phaseEnded('fix');
      return await host.finish({status:result.report.decision==='needs_owner'?'owner_decision':'needs_evidence',candidate:source,...batchResult,report:result.report});
    }
    const fixed=await host.commitFix(result.report,original);await host.phaseEnded('fix');
    return await host.finish({status:'awaiting_publication',candidate:source,...batchResult,fix:fixed});
  }finally{
    await kimi?.close();
    if(!retainGpt){await gpt?.close();host.releaseFact();}
  }
}
