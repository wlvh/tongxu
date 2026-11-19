import {join} from 'node:path';
import {canonical} from './comparison.js';
import {readCodingWorkflowSource} from './coding-workflow-source.js';
import {BoundedCodexSession,deliveryExplanationSchema,readRepairSession} from './repair-native.js';
import {exists,regular} from './repair-workspace.js';
import {hash,privateDirectory} from './snapshot.js';
import {writeFixed} from './project-work-runtime.js';
import type {RepairConfig} from './repair.js';
import type {Candidate} from './live-codex.js';

type Material={
  work:string;issue:{number:number;title:string;url:string;body:string;bodySha256:string};
  candidate:Candidate;goal:string;workflowRevision:string;technicalEvidence:unknown;
};

export async function readProjectExplanation(directory:string,work:string,H:string){
  if(!await exists(directory))return null;
  try{
    const request=JSON.parse((await regular(join(directory,'request.json'),1024*1024)).toString());
    const parsed=await readRepairSession(join(directory,'native'));
    const inputs=JSON.parse((await regular(join(directory,'native','inputs.json'),1024*1024)).toString());
    const outcome=JSON.parse(parsed.turns[0]?.final?.text??'null');
    const wire=(await regular(join(directory,'native','stdin.ndjson'),16*1024*1024)).toString().trim().split('\n').map(line=>JSON.parse(line));
    const sent=wire.filter(line=>line.method==='turn/start');
    if(sent.length!==1||canonical(sent[0].params.input)!==canonical([{type:'text',text:canonical(request.material)}])||
      canonical(sent[0].params.outputSchema)!==canonical(deliveryExplanationSchema)||request.material.work!==work||request.material.candidate.H!==H||request.prompt.use!=='delivery_explanation'||
      parsed.binding.run!==directory||parsed.binding.role!=='reviewer'||parsed.binding.inputManifestSha256!==hash(canonical(request))||
      parsed.turns.length!==1||canonical(inputs.map((i:any)=>[i.input,i.subjectCandidate,i.schema]))!==
        canonical([[canonical(request.material),request.material.candidate,deliveryExplanationSchema]])||
      outcome?.candidateH!==H||typeof outcome.report!=='string'||!outcome.report.trim())throw new Error('project_delivery_explanation_capture_changed');
    return {state:'returned' as const,H,report:outcome.report,sessionId:parsed.binding.sessionId,
      workflowRevision:request.prompt.revision,promptSha256:request.prompt.sha256,executionKind:parsed.binding.sourceKind};
  }catch{
    return {state:'pending_or_unknown' as const,H};
  }
}

export async function runProjectExplanation(directory:string,material:Material,config:RepairConfig,check:()=>Promise<void>,allowed:()=>void,onSession:(s:BoundedCodexSession)=>void){
  const source=await readCodingWorkflowSource(),prompt=source.prompt('delivery_explanation'),candidate=material.candidate;
  if(prompt.revision!==material.workflowRevision)throw new Error('project_delivery_explanation_workflow_unavailable');
  const request={material,prompt},input=canonical(material);
  if(Buffer.byteLength(canonical(request))>512*1024)throw new Error('project_delivery_explanation_material_limit');
  await check();
  // This directory is the durable admission fence. A stopped or interrupted
  // attempt is read back in place and is never implicitly resent.
  await privateDirectory(directory,true);
  await writeFixed(join(directory,'request.json'),canonical(request));
  const session=await BoundedCodexSession.start({
    executable:config.codexExecutable,directory:join(directory,'native'),operation:directory,candidate,role:'reviewer',
    system:prompt.system,inputManifestSha256:hash(canonical(request)),scopeSource:config.scopeSource,
    arrangementSource:'Read-only delivery explanation of the exact tested project candidate',disabledMcpServers:config.disabledMcpServers,
    allowedInstructionSources:config.allowedInstructionSources,timeoutMs:config.timeoutMs,executionKind:config.executionKind??'native_capture',
    beforeTurn:check,beforeSendSync:allowed
  });
  onSession(session);
  try{await session.turn(input,candidate,deliveryExplanationSchema);}
  finally{await session.close();}
}
