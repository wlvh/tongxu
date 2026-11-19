import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {readCodingWorkflowSource,type CodingWorkflowPrompt} from './coding-workflow-source.js';
import {BoundedCodexSession,readRepairSession} from './repair-native.js';
import {checkAcpSessionEvents,ExtraCliSession,parseAcpPrompt} from './additional-cli.js';
import {checkCapture} from './live-process.js';
import {formalReviewSchema,validateFormalReview} from './formal-review-contract.js';
import {writeFixed} from './project-work-runtime.js';
import type {AIRuntimeChoice} from './ai-settings.js';
import type {RepairConfig} from './repair.js';

type ReviewMaterial={work:string;repository:string;issue:{number:number;body:string;bodySha256:string;url:string};goal:string;head:string};
type ReviewRequest={material:ReviewMaterial;correctness:CodingWorkflowPrompt;minimality:CodingWorkflowPrompt;peer:AIRuntimeChoice;executionKind:'fixture'|'native_capture'};
const subject=(m:ReviewMaterial)=>({kind:'local-git' as const,repository:'local/project-issue-review',pr:null,H:m.head,B:m.head,target:'issue-review'});
const envelope=(material:ReviewMaterial,peer:unknown)=>canonical({material,reviewedInputSha256:hash(canonical(material)),peer,responseShape:formalReviewSchema});
const read=async(directory:string,name:string)=>regular(join(directory,name),16*1024*1024);
const rows=(raw:Buffer)=>raw.toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const parse=(text:string,material:ReviewMaterial)=>validateFormalReview(JSON.parse(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)?.[1]??text),material.head,hash(canonical(material)));

async function peerCapture(directory:string,request:ReviewRequest){
  await checkCapture(directory);
  const [rawIn,rawOut,rawBoundaries,rawSession,rawExit]=await Promise.all([
    read(directory,'stdin.ndjson'),read(directory,'stdout.ndjson'),read(directory,'prompt-boundaries.ndjson'),read(directory,'session.json'),read(directory,'exit.json')
  ]);
  const sent=rows(rawIn),received=rows(rawOut),boundaries=rows(rawBoundaries),{sessionId}=JSON.parse(rawSession.toString()),exit=JSON.parse(rawExit.toString());
  const launch=JSON.parse((await read(directory,'launch.json')).toString()),selection=JSON.parse((await read(directory,'selection.json')).toString());
  if(launch.command!==request.peer.executable||canonical(selection.requested)!==canonical({model:request.peer.model,effort:request.peer.effort}))
    throw new Error('project_issue_review_peer_binding_changed');
  if(request.executionKind==='native_capture'){
    const observed=JSON.parse((await read(directory,'profile-observed.json')).toString());
    if(observed.systemPromptSha256!==hash(request.minimality.system.trim())||observed.activeToolNames?.length!==0||
      observed.subagents?.length!==0||observed.agentsMdPaths?.length!==0||observed.modelAlias!==request.peer.model||
      request.peer.effort!==null&&observed.thinkingEffort!==request.peer.effort)throw new Error('project_issue_review_peer_binding_changed');
  }
  const prompts=sent.filter(item=>item.method==='session/prompt');
  if(typeof sessionId!=='string'||!sessionId||exit.code!==0||exit.signal!==null||prompts.length!==2||boundaries.length!==2)throw new Error('project_issue_review_peer_incomplete');
  checkAcpSessionEvents(received,sessionId);
  let previous=-1;
  const turns=prompts.map((prompt,index)=>{
    const matches=received.filter(item=>item.id===prompt.id&&!item.method),boundary=boundaries[index],end=received.indexOf(matches[0]);
    if(matches.length!==1||matches[0].error||prompt.params.sessionId!==sessionId||prompt.params.prompt?.length!==1||
      boundary.requestId!==prompt.id||boundary.requestSha256!==hash(JSON.stringify(prompt)+'\n')||
      !Number.isSafeInteger(boundary.stdoutBytes)||!Number.isSafeInteger(boundary.stdinBytes)||boundary.stdoutBytes<0||boundary.stdinBytes<0||
      hash(rawOut.subarray(0,boundary.stdoutBytes))!==boundary.stdoutSha256||hash(rawIn.subarray(0,boundary.stdinBytes))!==boundary.stdinSha256||
      rows(rawOut.subarray(0,boundary.stdoutBytes)).length!==boundary.stdoutEvents||
      rawIn.subarray(boundary.stdinBytes).toString().split('\n')[0]!==JSON.stringify(prompt)||
      boundary.stdoutEvents<=previous||boundary.stdoutEvents>end||
      received.slice(previous+1,boundary.stdoutEvents).some(item=>item.params?.update?.sessionUpdate==='agent_message_chunk'))throw new Error('project_issue_review_peer_boundary_changed');
    previous=end;
    return {input:prompt.params.prompt[0].text,report:parse(parseAcpPrompt(received.slice(boundary.stdoutEvents,end+1),sessionId,matches[0].result,request.peer),request.material)};
  });
  if(received.slice(previous+1).some(item=>item.params?.update?.sessionUpdate==='agent_message_chunk'))throw new Error('project_issue_review_peer_boundary_changed');
  return {sessionId,turns};
}

export async function readProjectIssueReview(directory:string,material:ReviewMaterial){
  if(!await exists(directory))return null;
  try{
    const request=JSON.parse((await read(directory,'request.json')).toString()) as ReviewRequest;
    if(canonical(request.material)!==canonical(material)||request.peer.tool!=='kimi')throw new Error('project_issue_review_binding_changed');
    const [gpt,kimi]=await Promise.all([readRepairSession(join(directory,'correctness')),peerCapture(join(directory,'minimality'),request)]);
    const inputs=JSON.parse((await read(join(directory,'correctness'),'inputs.json')).toString());
    const wire=rows(await read(join(directory,'correctness'),'stdin.ndjson')),starts=wire.filter(m=>m.method==='thread/start'),turns=wire.filter(m=>m.method==='turn/start');
    if(starts.length!==1||starts[0].params.baseInstructions!==request.correctness.system||turns.length!==2||
      turns.some((turn,index)=>canonical(turn.params.input)!==canonical([{type:'text',text:inputs[index]?.input}])||
        canonical(turn.params.outputSchema)!==canonical(formalReviewSchema)))throw new Error('project_issue_review_binding_changed');
    if(gpt.binding.run!==directory||gpt.binding.inputManifestSha256!==hash(canonical(request))||gpt.binding.role!=='reviewer'||gpt.binding.sourceKind!==request.executionKind||
      canonical(gpt.binding.candidate)!==canonical(subject(material))||gpt.turns.length!==2||inputs.length!==2||
      inputs.some((input:any)=>canonical(input.schema)!==canonical(formalReviewSchema))||gpt.binding.sessionId===kimi.sessionId)throw new Error('project_issue_review_binding_changed');
    const originalCorrectness=parse(gpt.turns[0]!.final!.text,material),originalMinimality=kimi.turns[0]!.report;
    if(inputs[0].input!==envelope(material,null)||kimi.turns[0]!.input!==inputs[0].input||
      inputs[1].input!==envelope(material,originalMinimality)||kimi.turns[1]!.input!==envelope(material,originalCorrectness))throw new Error('project_issue_review_exchange_changed');
    const correctness=parse(gpt.turns[1]!.final!.text,material),minimality=kimi.turns[1]!.report;
    return {state:'returned' as const,issueBodySha256:material.issue.bodySha256,workflowRevision:request.correctness.revision,
      approved:correctness.verdict==='PASS'&&minimality.verdict==='PASS',executionKind:request.executionKind,
      correctness:{sessionId:gpt.binding.sessionId,initial:originalCorrectness,exchanged:correctness},
      minimality:{sessionId:kimi.sessionId,initial:originalMinimality,exchanged:minimality}};
  }catch{return {state:'pending_or_unknown' as const,issueBodySha256:material.issue.bodySha256};}
}

export async function runProjectIssueReview(directory:string,material:ReviewMaterial,peer:AIRuntimeChoice,config:RepairConfig,verify:()=>Promise<void>,admit:()=>void,onSession:(session:BoundedCodexSession)=>void,onPeer:(stop:()=>Promise<void>)=>void){
  if(peer.tool!=='kimi')throw new Error('project_issue_review_second_company_required');
  const source=await readCodingWorkflowSource(),correctness=source.prompt('issue_review_completion'),minimality=source.prompt('issue_review_minimality');
  const request:ReviewRequest={material,correctness,minimality,peer,executionKind:config.executionKind??'native_capture'},candidate=subject(material);
  await verify();await privateDirectory(directory,true);await writeFixed(join(directory,'request.json'),canonical(request));
  let gpt:BoundedCodexSession|undefined,kimi:ExtraCliSession|undefined;
  try{
    gpt=await BoundedCodexSession.start({
      executable:config.codexExecutable,directory:join(directory,'correctness'),operation:directory,candidate,role:'reviewer',
      system:correctness.system,inputManifestSha256:hash(canonical(request)),scopeSource:config.scopeSource,
      arrangementSource:'Read-only formal review of the exact published Issue and its acceptance plan',
      disabledMcpServers:config.disabledMcpServers,allowedInstructionSources:config.allowedInstructionSources,
      timeoutMs:config.timeoutMs,executionKind:request.executionKind,beforeTurn:verify,beforeSendSync:admit
    });
    onSession(gpt);
    kimi=await ExtraCliSession.open('kimi',peer.executable,join(directory,'minimality'),minimality.system,request.executionKind==='fixture');
    const openedPeer=kimi;onPeer(()=>openedPeer.close());
    await kimi.select({model:peer.model,effort:peer.effort});
    const check=(result:unknown)=>validateFormalReview(result,material.head,hash(canonical(material)));
    const initial=envelope(material,null);
    const a=check(await gpt.turn(initial,candidate,formalReviewSchema));
    const b=parse((await kimi.prompt(initial,config.timeoutMs,admit,verify)).final,material);
    check(await gpt.turn(envelope(material,b),candidate,formalReviewSchema));
    parse((await kimi.prompt(envelope(material,a),config.timeoutMs,admit,verify)).final,material);
  }finally{await Promise.allSettled([gpt?.close(),kimi?.close()]);}
  const result=await readProjectIssueReview(directory,material);
  if(result?.state!=='returned')throw new Error('project_issue_review_capture_unknown');
}
