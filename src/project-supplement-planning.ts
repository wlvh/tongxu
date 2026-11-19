import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {exists,regular,processState} from './repair-workspace.js';
import {prepareWorkProposal,readWorkProposal,type FixedRepository} from './project-work-preparation.js';
import {readProjectIssueReview,runProjectIssueReview} from './project-issue-review.js';
import {writeFixed} from './project-work-runtime.js';
import {assertWorkEnvironmentEnded} from './project-work-environment.js';
import {withQueueRepairLock} from './queue-repair.js';
import type {SupplementReviewInput,ReviewedSupplement} from './project-supplement-review.js';
import type {AIRuntimeChoice} from './ai-settings.js';
import type {RepairConfig} from './repair.js';
import type {DockerConfig} from './docker-sandbox.js';
import type {BoundedCodexSession} from './repair-native.js';
import type {CodingWorkflowPrompt} from './coding-workflow-source.js';

export type SupplementPlanningSource={
  input:SupplementReviewInput;source:FixedRepository;issue:{number:number;body:string;bodySha256:string;url:string};workflowPrompt:CodingWorkflowPrompt;
};
export function supplementPlanningDirectory(root:string,input:SupplementReviewInput){
  if(!/^supplement-[a-f0-9-]{36}$/.test(input.requestId)||input.formalBase!==undefined&&!/^[a-f0-9]{64}$/.test(input.formalBase))
    throw new Error('project_supplement_review_binding_changed');
  return join(root,'supplement-planning',input.requestId+(input.formalBase?'-'+input.formalBase:''));
}
async function preparationAttempt(directory:string){
  const entries=(await readdir(directory)).flatMap(name=>{
    if(name==='preparation')return [1];
    const n=/^preparation-([2-9]\d*|1\d+)$/.exec(name)?.[1];
    return n&&Number.isSafeInteger(Number(n))?[Number(n)]:[];
  });
  const attempt=Math.max(0,...entries);
  return {attempt,path:join(directory,attempt>1?'preparation-'+attempt:'preparation')};
}
async function unsentPreparation(path:string,verification:DockerConfig){
  if(!await exists(path))return true;
  try{
    await assertWorkEnvironmentEnded(join(path,'environment'),verification);
    const native=join(path,'native');
    if(!await exists(native))return true;
    if(await exists(join(native,'turn-1-intent.json')))return false;
    const stdin=join(native,'stdin.ndjson');
    if(await exists(stdin)){
      const wire=(await regular(stdin,16*1024*1024)).toString();
      if(wire&&!wire.endsWith('\n')||wire.trim().split('\n').filter(Boolean).some(line=>JSON.parse(line).method==='turn/start'))return false;
    }
    if(!await exists(join(native,'launch.json')))return !await exists(join(native,'process.json'));
    const process=JSON.parse((await regular(join(native,'process.json'))).toString());
    const exit=JSON.parse((await regular(join(native,'exit.json'))).toString());
    return process.status==='spawn_attempted'&&Number.isSafeInteger(process.pid)&&process.pid>0&&
      processState(process.pid)==='ended'&&await exists(stdin)&&(Number.isInteger(exit.code)||typeof exit.signal==='string');
  }catch{return false;}
}
const reviewedMaterial=(source:SupplementPlanningSource,proposal:{goal:string;acceptance:string[];validation:{description:string;script:string}})=>{
  const revision={input:source.input,requirement:proposal.goal,acceptance:proposal.acceptance,validation:proposal.validation};
  const body=source.issue.body+'\n\n## 追加要求和验收版本\n\n'+canonical(revision);
  return {revision,material:{work:source.input.target.source,repository:source.input.repository,head:source.input.H1,goal:source.input.text,
    issue:{number:source.issue.number,body,bodySha256:hash(body),url:source.issue.url}}};
};
async function readPlanning(root:string,input:SupplementReviewInput,verification?:DockerConfig){
  const directory=supplementPlanningDirectory(root,input),ref=join(directory,'request.json');
  if(!await exists(ref))return null;
  const request=JSON.parse((await regular(ref,1024*1024)).toString()) as SupplementPlanningSource;
  if(canonical(request.input)!==canonical(input))throw new Error('project_supplement_review_binding_changed');
  const preparation=await preparationAttempt(directory),proposal=await readWorkProposal(preparation.path,request.source).catch(()=>null);
  if(!proposal){
    const retry=verification&&!await exists(join(directory,'review'))&&await unsentPreparation(preparation.path,verification);
    return {state:retry?'ready_to_retry' as const:'pending_or_unknown' as const};
  }
  if(!proposal.ready||proposal.validationProblem)return {state:'awaiting_requirements' as const};
  const {revision,material}=reviewedMaterial(request,proposal.proposal);
  const review=await readProjectIssueReview(join(directory,'review'),material);
  if(review?.state!=='returned')return {state:await exists(join(directory,'review'))?'pending_or_unknown' as const:'ready_to_retry' as const};
  return {state:'returned' as const,revision,material,review};
}
export async function supplementPlanningStatus(root:string,input:SupplementReviewInput,verification:DockerConfig){
  const result=await readPlanning(root,input,verification);
  if(!result)return null;
  if(result.state!=='returned')return {state:result.state};
  return {state:result.state,approved:result.review.approved,openai:result.review.correctness.exchanged,
    moonshot:result.review.minimality.exchanged,executionKind:result.review.executionKind};
}
export async function readPlannedSupplement(root:string,input:SupplementReviewInput,executionKind:string):Promise<ReviewedSupplement|null>{
  const result=await readPlanning(root,input);
  if(result?.state!=='returned'||!result.review.approved||result.review.executionKind!==executionKind)return null;
  const {review,revision,material}=result;
  const replies=[review.correctness,review.minimality].flatMap((p,index)=>[
    {seat:index?'minimality':'completion',sessionId:p.sessionId,sha256:hash(canonical(p.initial))},
    {seat:index?'minimality-exchange':'completion-exchange',sessionId:p.sessionId,sha256:hash(canonical(p.exchanged))}
  ]);
  return {inputSha256:material.issue.bodySha256,reviewRun:hash(canonical({material,replies})),requirement:revision.requirement,acceptance:revision.acceptance,validation:revision.validation,replies};
}
export async function planAndReviewSupplement(root:string,source:SupplementPlanningSource,peer:AIRuntimeChoice,config:RepairConfig,verification:DockerConfig,
  check:()=>Promise<void>,admit:()=>void,stopped:()=>boolean,onSession:(s:BoundedCodexSession)=>void,onPeer:(stop:()=>Promise<void>)=>void){
  const directory=supplementPlanningDirectory(root,source.input);
  return withQueueRepairLock(join(root,'supplement-planning'),source.input.requestId.slice('supplement-'.length),async()=>{
    await check();await privateDirectory(directory,!await exists(directory));
    await writeFixed(join(directory,'request.json'),canonical(source));
    if(await exists(join(directory,'review')))return {state:'pending_or_unknown'};
    const previous=await preparationAttempt(directory);
    let prepared=await readWorkProposal(previous.path,source.source).catch(()=>null);
    if(!prepared){
      if(!await unsentPreparation(previous.path,verification))throw new Error('project_supplement_original_preparation_unknown');
      const attempt=previous.attempt?join(directory,'preparation-'+(previous.attempt+1)):previous.path;
      prepared=await prepareWorkProposal({source:source.source,issue:source.issue,goal:source.input.text,directory:attempt,
        config,verification,check,stopped,onSession,workflowPrompt:source.workflowPrompt});
    }
    if(!prepared.ready||prepared.validationProblem)return {state:'awaiting_requirements'};
    const {material}=reviewedMaterial(source,prepared.proposal);
    await runProjectIssueReview(join(directory,'review'),material,peer,config,check,admit,onSession,onPeer);
    return {state:'returned'};
  });
}
