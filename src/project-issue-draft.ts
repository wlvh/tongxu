import {join} from 'node:path';
import {canonical} from './comparison.js';
import {readCodingWorkflowSource} from './coding-workflow-source.js';
import {BoundedCodexSession,projectIssueDraftSchema,deliveryExplanationSchema,deliveryExplanationOutputSchema,readRepairSession} from './repair-native.js';
import {exists,regular} from './repair-workspace.js';
import {hash,privateDirectory} from './snapshot.js';
import {writeFixed} from './project-work-runtime.js';
import type {RepairConfig} from './repair.js';

type Draft={requestId:string;repository:string;head:string;goal:string};
const candidate=(d:Draft)=>({kind:'local-git' as const,repository:'local/project-issue-draft',pr:null,H:d.head,B:d.head,target:'issue-draft'});
async function sourceParts(){
  const source=await readCodingWorkflowSource(),author=source.prompt('issue_author');
  const readme=source.entrypointSource;
  const plan=readme.text.match(/\*\*另一个 LLM 对话制定用户视角验收计划[^\n]*\n\n *```text\n([\s\S]*?)\n *```/)?.[1]?.split('\n').map(line=>line.trim()).join('\n');
  if(!plan)throw new Error('coding_workflow_acceptance_plan_prompt_missing');
  return {author,plan,readmeSha256:readme.sha256};
}
type Manifest={draft:Draft;workflow:Awaited<ReturnType<typeof sourceParts>>;acceptanceCandidateInInput?:true};

function acceptanceRequest(manifest:Manifest,author:{title:string;report:string}){
  const {draft,acceptanceCandidateInInput}=manifest;
  return {
    input:canonical({draft,issue:{title:author.title,body:author.report},...(acceptanceCandidateInInput?{candidateH:draft.head}:{})}),
    schema:acceptanceCandidateInInput?deliveryExplanationOutputSchema(draft.head):deliveryExplanationSchema,
  };
}

async function completed(directory:string,manifest:Manifest,stage:'author'|'plan',input:string,system:string,schema:unknown){
  const native=join(directory,stage),capture=await readRepairSession(native);
  const read=async(name:string)=>(await regular(join(native,name),16*1024*1024)).toString();
  const wire=(await read('stdin.ndjson')).trim().split('\n').map(line=>JSON.parse(line)),starts=wire.filter(m=>m.method==='turn/start');
  const inputManifestSha256=hash(canonical({manifest,stage,input}));
  if(capture.binding.run!==directory||capture.binding.role!=='reviewer'||capture.binding.inputManifestSha256!==inputManifestSha256||
     canonical(capture.binding.candidate)!==canonical(candidate(manifest.draft))||capture.turns.length!==1||
     starts.length!==1||canonical(starts[0].params.input)!==canonical([{type:'text',text:input}])||
     canonical(starts[0].params.outputSchema)!==canonical(schema))throw new Error('project_issue_draft_original_changed');
  const recorded=wire.filter(m=>m.method==='thread/start');
  if(recorded.length!==1||recorded[0].params.baseInstructions!==system)throw new Error('project_issue_draft_original_changed');
  const report=JSON.parse(capture.turns[0]?.final?.text??'null');
  if(report?.candidateH!==manifest.draft.head||typeof report.report!=='string'||!report.report.trim()||
     stage==='author'&&(typeof report.title!=='string'||!report.title.trim()))throw new Error('project_issue_draft_original_changed');
  return {report,sessionId:capture.binding.sessionId};
}

export async function readProjectIssueDraft(directory:string,requestId:string,repository:string){
  if(!await exists(directory))return null;
  try{
    const manifest=JSON.parse((await regular(join(directory,'manifest.json'),1024*1024)).toString()) as Manifest;
    const {draft,workflow}=manifest;
    if(draft.requestId!==requestId||draft.repository!==repository)throw new Error('project_issue_draft_original_changed');
    const a=await completed(directory,manifest,'author',canonical(draft),workflow.author.system,projectIssueDraftSchema);
    const plan=acceptanceRequest(manifest,a.report);
    const b=await completed(directory,manifest,'plan',plan.input,workflow.plan,plan.schema);
    if(a.sessionId===b.sessionId)throw new Error('project_issue_draft_planner_must_be_independent');
    const body=a.report.report+'\n\n## 用户视角验收计划\n\n'+b.report.report;
    return {requestId,state:'ready' as const,head:draft.head,title:a.report.title,body,bodySha256:hash(body),
      workflowRevision:workflow.author.revision,authorSession:a.sessionId,plannerSession:b.sessionId};
  }catch{return {requestId,state:'pending_or_unknown' as const};}
}

export async function runProjectIssueDraft(directory:string,draft:Draft,config:RepairConfig,check:()=>Promise<void>,beforeSend:()=>void,onSession:(s:BoundedCodexSession)=>void){
  const workflow=await sourceParts(),manifest:Manifest={draft,workflow,acceptanceCandidateInInput:true};
  await check();await privateDirectory(directory,true);await writeFixed(join(directory,'manifest.json'),canonical(manifest));
  const turn=async(stage:'author'|'plan',system:string,input:string,schema:unknown)=>{
    await check();
    const session=await BoundedCodexSession.start({
      executable:config.codexExecutable,directory:join(directory,stage),operation:directory,candidate:candidate(draft),role:'reviewer',
      system,inputManifestSha256:hash(canonical({manifest,stage,input})),scopeSource:config.scopeSource,
      arrangementSource:'Read-only project Issue proposal or independent acceptance planning',disabledMcpServers:config.disabledMcpServers,
      allowedInstructionSources:config.allowedInstructionSources,timeoutMs:config.timeoutMs,executionKind:config.executionKind??'native_capture',
      beforeTurn:check,beforeSendSync:beforeSend
    });
    onSession(session);
    try{await session.turn(input,candidate(draft),schema);}finally{await session.close();}
    return completed(directory,manifest,stage,input,system,schema);
  };
  const a=await turn('author',workflow.author.system,canonical(draft),projectIssueDraftSchema);
  const plan=acceptanceRequest(manifest,a.report);
  const b=await turn('plan',workflow.plan,plan.input,plan.schema);
  if(a.sessionId===b.sessionId)throw new Error('project_issue_draft_planner_must_be_independent');
}
