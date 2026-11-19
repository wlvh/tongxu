import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {exists,regular} from './repair-workspace.js';
import {prepareWorkProposal,readWorkProposal,type FixedRepository} from './project-work-preparation.js';
import {readProjectIssueReview,runProjectIssueReview} from './project-issue-review.js';
import {writeFixed} from './project-work-runtime.js';
import type {SupplementReviewInput,ReviewedSupplement} from './project-supplement-review.js';
import type {AIRuntimeChoice} from './ai-settings.js';
import type {RepairConfig} from './repair.js';
import type {DockerConfig} from './docker-sandbox.js';
import type {BoundedCodexSession} from './repair-native.js';
import type {CodingWorkflowPrompt} from './coding-workflow-source.js';

export type SupplementPlanningSource={
  input:SupplementReviewInput;source:FixedRepository;issue:{number:number;body:string;bodySha256:string;url:string};workflowPrompt:CodingWorkflowPrompt;
};
export const supplementPlanningDirectory=(root:string,id:string)=>join(root,'supplement-planning',id);
const reviewedMaterial=(source:SupplementPlanningSource,proposal:{goal:string;acceptance:string[];validation:{description:string;script:string}})=>{
  const revision={input:source.input,requirement:proposal.goal,acceptance:proposal.acceptance,validation:proposal.validation};
  const body=source.issue.body+'\n\n## 追加要求和验收版本\n\n'+canonical(revision);
  return {revision,material:{work:source.input.target.source,repository:source.input.repository,head:source.input.H1,goal:source.input.text,
    issue:{number:source.issue.number,body,bodySha256:hash(body),url:source.issue.url}}};
};
async function readPlanning(root:string,input:SupplementReviewInput){
  const directory=supplementPlanningDirectory(root,input.requestId),ref=join(directory,'request.json');
  if(!await exists(ref))return null;
  const request=JSON.parse((await regular(ref,1024*1024)).toString()) as SupplementPlanningSource;
  if(canonical(request.input)!==canonical(input))throw new Error('project_supplement_review_binding_changed');
  const proposal=await readWorkProposal(join(directory,'preparation'),request.source).catch(()=>null);
  if(!proposal?.ready||proposal.validationProblem)return {state:'awaiting_requirements' as const};
  const {revision,material}=reviewedMaterial(request,proposal.proposal);
  const review=await readProjectIssueReview(join(directory,'review'),material);
  if(review?.state!=='returned')return {state:'pending_or_unknown' as const};
  return {state:'returned' as const,revision,material,review};
}
export async function supplementPlanningStatus(root:string,input:SupplementReviewInput){
  const result=await readPlanning(root,input);
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
  const directory=supplementPlanningDirectory(root,source.input.requestId);
  await check();await privateDirectory(directory,true);
  await writeFixed(join(directory,'request.json'),canonical(source));
  const prepared=await prepareWorkProposal({
    source:source.source,issue:source.issue,goal:source.input.text,directory:join(directory,'preparation'),
    config,verification,check,stopped,onSession,workflowPrompt:source.workflowPrompt
  });
  if(!prepared.ready||prepared.validationProblem)return {state:'awaiting_requirements'};
  const {material}=reviewedMaterial(source,prepared.proposal);
  await runProjectIssueReview(join(directory,'review'),material,peer,config,check,admit,onSession,onPeer);
  return {state:'returned'};
}
