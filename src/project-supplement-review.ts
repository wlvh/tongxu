import {join} from 'node:path';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {hash} from './snapshot.js';
import {exists,regular} from './repair-workspace.js';
import {messagePath,messagePlanId,parseMessagePlan,type WorkMessage} from './message-contract.js';
import {runMessages} from './messages.js';
import {readCodingWorkflowSource} from './coding-workflow-source.js';
import {validateFormalReview} from './formal-review-contract.js';
import {QueueStore} from './queue-store.js';
import type {SupplementTarget} from './project-chat.js';

export type SupplementReviewInput={
  repository:string; target:SupplementTarget; H1:string; requestId:string; text:string; formalBase?:string;
};
export type ReviewedSupplement={
  inputSha256:string; reviewRun:string; requirement:string; acceptance:string[];
  validation:{description:string;script:string}; replies:Array<{seat:string;sessionId:string;sha256:string}>;
};
const materialName='project-supplement-requirement.json';
const text=(value:unknown,limit:number):value is string=>typeof value==='string'&&!!value.trim()&&!value.includes('\0')&&Buffer.byteLength(value)<=limit;
const company=(tool:string)=>({codex:'OpenAI',kimi:'Moonshot',claude:'Anthropic'}[tool]);

export async function projectSupplementReviewMessages(completion:string,minimality:string):Promise<WorkMessage[]>{
  const source=await readCodingWorkflowSource();
  const contract='Review the frozen requirements material, including the original request, proposed requirement and runnable acceptance. Return a JSON string in the report with candidateH=material.input.H1, reviewedInputSha256=the material SHA-256 supplied in the envelope, verdict=PASS, REWORK_REQUIRED or OWNER_DECISION_REQUIRED, report, findings, coverageGaps and ownerQuestions. PASS requires that every substantive issue is resolved. Findings each have id, priority (0, 1 or 2), description and evidence.';
  const exchange='Read the other seat’s complete original report. State the final decision for the same exact material after addressing its findings and differences. '+contract;
  return [
    {id:'completion',from:null,to:completion,replies:[],body:source.prompt('issue_review_completion').system+'\n\n'+contract},
    {id:'minimality',from:null,to:minimality,replies:[],body:source.prompt('issue_review_minimality').system+'\n\n'+contract},
    {id:'completion-exchange',from:minimality,to:completion,replies:['minimality'],body:exchange},
    {id:'minimality-exchange',from:completion,to:minimality,replies:['completion'],body:exchange},
  ];
}

/** Resolve a locally registered, ended requirements review. The browser cannot
 * supply paths, review verdicts, or executable validation. The referenced
 * run retains both independent inputs and the actual two-way exchange. */
export async function readReviewedSupplement(root:string,input:SupplementReviewInput,executionKind:string):Promise<ReviewedSupplement|null>{
  if(!/^supplement-[a-f0-9-]{36}$/.test(input.requestId))throw new Error('project_supplement_review_binding_changed');
  // The fixed locator names the legacy review only. The new verified base
  // uses its own planning and review originals under the same receipt ID.
  if(input.formalBase)return null;
  const path=join(root,'supplement-reviews',input.requestId+'.json');
  if(!await exists(path))return null;
  const ref=JSON.parse((await regular(path,4096)).toString());
  if(!exactKeys(ref,['store','path','sha256'])||!messagePath(ref.store)||!messagePath(ref.path)||!isAuthorityDigest(ref.sha256))throw new Error('project_supplement_review_binding_changed');
  const planBytes=await regular(ref.path,256*1024),plan=parseMessagePlan(planBytes);
  if(hash(planBytes)!==ref.sha256||plan.executionKind!==executionKind||
     plan.material.length!==1||plan.participants.length!==2||plan.participants.some(a=>a.parent!==null||!company(a.tool))||
     new Set(plan.participants.map(a=>company(a.tool))).size!==2||
     canonical(plan.consumeMaterial)!==canonical([materialName]))throw new Error('project_supplement_review_binding_changed');
  const [completion,minimality]=plan.participants;
  const expected=await projectSupplementReviewMessages(completion!.id,minimality!.id);
  if(completion!.role!=='reviewer'||minimality!.role!=='verifier_impact'||
     canonical(plan.messages)!==canonical(expected))throw new Error('project_supplement_review_binding_changed');
  const run=messagePlanId(plan);
  const q=await QueueStore.open(ref.store);
  let frozen;
  try{frozen=q.messages().frozen(run);}finally{q.close();}
  const material=frozen.materials[materialName];
  if(!material)throw new Error('project_supplement_review_binding_changed');
  const value=JSON.parse(material.toString()),inputSha256=hash(material);
  if(!exactKeys(value,['kind','input','requirement','acceptance','validation'])||
     value.kind!=='tongxu-project-supplement-requirement-v1'||canonical(value.input)!==canonical(input)||
     !text(value.requirement,8192)||!Array.isArray(value.acceptance)||value.acceptance.length<1||value.acceptance.length>12||
     !value.acceptance.every((line:unknown)=>text(line,2048))||!exactKeys(value.validation,['description','script'])||
     !text(value.validation.description,256)||!text(value.validation.script,8192))throw new Error('project_supplement_review_binding_changed');
  const result=await runMessages(ref.store,ref.path,true,run);
  if(!result.completed||!result.resourcesSettled||result.newModelRequests!==0||result.messages.length!==4)return null;
  const replies=result.messages.map(message=>{
    const route=result.runtimes.find(runtime=>runtime.participant===message.to)?.route;
    if(!route?.sessionId||!message.reply?.reportedConsumption||!isAuthorityDigest(message.reply.finalSha256))throw new Error('project_supplement_review_binding_changed');
    const review=validateFormalReview(JSON.parse(message.reply.report),input.H1,inputSha256);
    return {seat:message.id,sessionId:route.sessionId,sha256:message.reply.finalSha256,verdict:review.verdict};
  });
  if(replies[0]!.sessionId===replies[1]!.sessionId||replies[2]!.sessionId!==replies[0]!.sessionId||replies[3]!.sessionId!==replies[1]!.sessionId)throw new Error('project_supplement_review_binding_changed');
  if(replies.slice(2).some(reply=>reply.verdict!=='PASS'))return null;
  return {inputSha256,reviewRun:run,requirement:value.requirement,acceptance:value.acceptance,validation:value.validation,replies:replies.map(({verdict:_,...reply})=>reply)};
}
