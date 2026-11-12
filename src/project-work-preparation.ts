import {workValidationInvocation,workPreparationBudgets,workValidationProblem} from './work-validation-invocation.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {BoundedCodexSession,findingSchema,readRepairSession} from './repair-native.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,safeEnv} from './repair-workspace.js';
import {exactKeys} from './authority-contract.js';
import {parseWorkProposal,preparationToolSpecs,workPreparationInstructions,workPreparationInstructionsV1,workPreparationInstructionsV2,type WorkProposal} from './project-work-contract.js';
import type {RepairConfig} from './repair.js';
import {checkConfig,type Candidate} from './live-codex.js';
import {prepareWorkEnvironment,readWorkEnvironment} from './project-work-environment.js';
import type {DockerConfig} from './docker-sandbox.js';
import {checkCapture} from './live-process.js';
import {parseCodexResult} from './codex-results.js';
import {currentAIChoice} from './ai-settings.js';
import {modelChoice} from './ai-execution.js';
const exec=promisify(execFile);
export type FixedRepository={path:string;H:string;repository:string};
export async function fixedGit(source:FixedRepository,args:string[]){return (await exec('/usr/bin/git',['--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-C',source.path,...args],{env:{...safeEnv,GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0'},encoding:'buffer',timeout:15000,maxBuffer:8*1024*1024})).stdout;}
export async function repositoryFiles(source:FixedRepository){
  const raw=(await fixedGit(source,['ls-tree','-r','-l','-z',source.H])).toString();
  return raw.split('\0').filter(Boolean).map(line=>{const m=/^([0-7]{6}) (blob|commit) ([a-f0-9]{40}) +([0-9-]+)\t(.+)$/.exec(line);if(!m)throw new Error('project_work_source_manifest_invalid');return {path:m[5]!,mode:m[1]!,object:m[3]!,bytes:Number(m[4])};});
}
function readable(path:string){return /^[A-Za-z0-9_.\/-]+$/.test(path)&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p!=='.git')&&!/(?:^|\/)(?:\.env(?:\..*)?|credentials|id_rsa|id_ed25519)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i.test(path);}
export async function repositoryFile(source:FixedRepository,path:string){
  if(!readable(path))throw new Error('project_work_file_not_readable');
  const file=(await repositoryFiles(source)).find(f=>f.path===path);
  if(!file||!['100644','100755'].includes(file.mode)||file.bytes>256*1024)throw new Error('project_work_file_not_readable');
  const bytes=await fixedGit(source,['cat-file','blob',file.object]);if(bytes.length!==file.bytes)throw new Error('project_work_source_changed');
  return {path,text:new TextDecoder('utf8',{fatal:true}).decode(bytes),sha256:hash(bytes),bytes:bytes.length};
}
export async function checkWorkMaterial(source:FixedRepository,proposal:WorkProposal){
  let total=0,editable=0;const material:Record<string,unknown>={};for(const path of proposal.materialPaths){const f=await repositoryFile(source,path);total+=f.bytes;material[path]=f;if(proposal.allowedPaths.includes(path))editable+=f.bytes;}
  // This is the initial editable/material budget. Generic observations use a
  // representative file; execution still checks the complete selected tree.
  if(editable>384*1024||Buffer.byteLength(canonical(material))>768*1024)throw new Error('project_work_material_limit');
  return total;
}
export async function prepareWorkProposal(o:{source:FixedRepository;issue:unknown;goal:string;directory:string;config:RepairConfig;verification:DockerConfig;check:()=>Promise<void>;stopped:()=>boolean;onSession:(s:BoundedCodexSession)=>void}){
  await privateDirectory(o.directory,true);const files=await repositoryFiles(o.source);
  if(files.length>8192)throw new Error('project_work_repository_listing_limit');
  const check=async()=>{if(o.stopped())throw new Error('project_work_preparation_stopped');await o.check();if(o.stopped())throw new Error('project_work_preparation_stopped');};
  const T=(await fixedGit(o.source,['rev-parse',o.source.H+'^{tree}'])).toString().trim();
  const validationEnvironment=await prepareWorkEnvironment(o.verification,join(o.directory,'environment'),o.source.H,T,{refresh:check,start:effect=>{if(o.stopped())throw new Error('project_work_preparation_stopped');effect();}});
  await check();
  const input={preparationVersion:3,validationInvocation:workValidationInvocation(o.verification.node),materialBudgets:workPreparationBudgets,validationEnvironment,kind:'project_work_engineering_preparation',source:o.source,issue:o.issue,userGoal:o.goal,files:files.map(({path,mode,bytes})=>({path,mode,bytes})),supportedValidation:'Registered Docker Node validation with the observed optional in-container capabilities below; no installation,network or host shell',toolLimit:32,timeLimitMs:o.config.timeoutMs};
  const bytes=canonical(input);if(Buffer.byteLength(bytes)>512*1024)throw new Error('project_work_preparation_input_limit');
  await writeFile(join(o.directory,'input.json'),bytes,{flag:'wx',mode:0o600});
  const candidate:Candidate={kind:'local-git',repository:'local/project-work-preparation',pr:null,H:o.source.H,B:o.source.H,target:'preparation'},observations:unknown[]=[];let calls=0,total=0,turnStarted:number|null=null;
  const gate={check,call:async(p:{tool:string;arguments:any;callId:string},before?:()=>void)=>{
    await check();before?.();if(++calls>32)throw new Error('project_work_preparation_tool_limit');let data;
    if(p.tool==='tongxu_repository_files'&&exactKeys(p.arguments,[]))data=files.map(({path,mode,bytes})=>({path,mode,bytes}));
    else if(p.tool==='tongxu_repository_file'&&exactKeys(p.arguments,['path'])&&typeof p.arguments.path==='string')data=await repositoryFile(o.source,p.arguments.path);
    else throw new Error('project_work_preparation_tool_not_allowed');
    const base={tool:p.tool,arguments:p.arguments,data};total+=Buffer.byteLength(canonical(base));if(total>768*1024)throw new Error('project_work_preparation_material_limit');
    const elapsedMs=turnStarted===null?null:Math.max(0,Math.floor(performance.now()-turnStarted));
    const result={...base,remainingTools:32-calls,materialBudget:{limitBytes:768*1024,usedDataBytes:total,remainingDataBytes:768*1024-total},timeBudget:{limitMs:o.config.timeoutMs,elapsedMs,remainingMs:elapsedMs===null?null:Math.max(0,o.config.timeoutMs-elapsedMs)}};
    observations.push(result);await writeFile(join(o.directory,'observations.json'),canonical(observations),{mode:0o600});await check();before?.();
    return {success:true,contentItems:[{type:'inputText',text:canonical(result)}]};
  }};
  const choice=currentAIChoice('secretary');if(choice&&choice.tool!=='codex')throw new Error('project_work_preparation_codex_required');
  let session:BoundedCodexSession|undefined;
  try{
    session=await BoundedCodexSession.start({executable:choice?.executable??o.config.codexExecutable,...(choice?{aiModel:modelChoice(choice)}:{}),directory:join(o.directory,'native'),operation:o.directory,candidate,role:'verifier_fact',projectPreparation:true,system:workPreparationInstructions,inputManifestSha256:hash(bytes),scopeSource:'User requested engineering preparation for '+o.source.repository,arrangementSource:'Read-only work preparation; no implementation, approval or dispatch',disabledMcpServers:o.config.disabledMcpServers,allowedInstructionSources:o.config.allowedInstructionSources,timeoutMs:o.config.timeoutMs,executionKind:o.config.executionKind??'native_capture',beforeTurn:check,afterTurnStarted:()=>{turnStarted=performance.now();},beforeSendSync:()=>{if(o.stopped())throw new Error('project_work_preparation_stopped');},gate});o.onSession(session);
    await session.turn(bytes,candidate,findingSchema);await session.close();session=undefined;
    return await readWorkProposal(o.directory,o.source);
  }finally{await session?.close();}
}
export async function readWorkProposal(directory:string,source:FixedRepository){
  if(resolve(directory)!==directory)throw new Error('project_work_preparation_path_invalid');
  const {bytes,input,instructions}=await readPreparationInput(directory,source),capture=await readRepairSession(join(directory,'native'));
  if(capture.binding.role!=='verifier_fact'||capture.binding.inputManifestSha256!==hash(bytes)||capture.turns.length!==1||!capture.turns[0]?.final)throw new Error('project_work_preparation_capture_changed');
  await checkPreparationBinding(directory,source,bytes,instructions,capture.binding);
  const result=JSON.parse(capture.turns[0].final.text);if(!['confirmed','needs_owner'].includes(result.decision)||result.candidateH!==source.H)throw new Error('project_work_preparation_invalid_result');
  const proposal=parseWorkProposal(JSON.parse(result.report));if(result.decision==='confirmed'&&!proposal.questions.length){const names=new Set((await repositoryFiles(source)).map(f=>f.path));for(const path of proposal.allowedPaths){const parts=path.split('/');for(let n=0;n<parts.length;n++){const instruction=[...parts.slice(0,n),'AGENTS.md'].join('/');if(names.has(instruction)&&(!proposal.materialPaths.includes(instruction)||!proposal.protectedPaths.includes(instruction)))throw new Error('project_work_instructions_material_required');}}}await checkWorkMaterial(source,proposal);
  const fileList=await repositoryFiles(source),observationFits=proposal.allowedPaths.some(path=>fileList.some(f=>f.path===path&&f.bytes<=64*1024));
  const validationProblem=(proposal.validation.script?workValidationProblem(proposal.validation.script):null)??(!proposal.questions.length&&!observationFits?'project_work_observation_material_limit':null);
  return {proposal,...(validationProblem?{validationProblem}:{}),proposalDigest:hash(canonical(proposal)),inputSha256:hash(bytes),captureSha256:hash(await regular(join(directory,'native','completed.json'))),ready:result.decision==='confirmed'&&!proposal.questions.length&&!validationProblem,...([2,3].includes(input.preparationVersion)?{preparationVersion:input.preparationVersion as 2|3,validationEnvironment:input.validationEnvironment}:{})};
}

async function readPreparationInput(directory:string,source:FixedRepository){
  const bytes=await regular(join(directory,'input.json'),512*1024),input=JSON.parse(bytes.toString());
  if(canonical(input.source)!==canonical(source))throw new Error('project_work_preparation_capture_changed');
  const sent=(await regular(join(directory,'native','stdin.ndjson'),16*1024*1024)).toString().trim().split('\n').map(l=>JSON.parse(l)),starts=sent.filter((m:any)=>m.method==='thread/start'),turns=sent.filter((m:any)=>m.method==='turn/start');
  if(starts.length!==1||turns.length!==1)throw new Error('project_work_preparation_capture_changed');
  const instructions=starts[0].params.baseInstructions;
  if(instructions===workPreparationInstructionsV1){if(input.preparationVersion!==undefined||input.validationEnvironment!==undefined||input.validationInvocation!==undefined||input.materialBudgets!==undefined)throw new Error('project_work_preparation_version_changed');}
  else if(instructions===workPreparationInstructions||instructions===workPreparationInstructionsV2){
    if(input.preparationVersion!==(instructions===workPreparationInstructions?3:2))throw new Error('project_work_preparation_version_changed');
    const T=(await fixedGit(source,['rev-parse',source.H+'^{tree}'])).toString().trim();
    if(canonical(input.validationEnvironment)!==canonical(await readWorkEnvironment(join(directory,'environment'),source.H,T)))throw new Error('project_work_environment_binding_changed');
    if(input.preparationVersion===3){const evidence=JSON.parse((await regular(join(directory,'environment/observation.json'))).toString());if(canonical(input.validationInvocation)!==canonical(workValidationInvocation(evidence.configuration.node))||canonical(input.materialBudgets)!==canonical(workPreparationBudgets))throw new Error('project_work_validation_invocation_changed');}else if(input.validationInvocation!==undefined||input.materialBudgets!==undefined)throw new Error('project_work_preparation_version_changed');
  }else throw new Error('project_work_preparation_version_unknown');
  if(!isDeepStrictEqual(starts[0].params.dynamicTools,preparationToolSpecs)||turns[0].params.input?.[0]?.text!==bytes.toString()||!isDeepStrictEqual(turns[0].params.outputSchema,findingSchema))throw new Error('project_work_preparation_capture_changed');
  return {bytes,input,instructions,sent,start:starts[0],turn:turns[0]};
}
async function checkPreparationBinding(directory:string,source:FixedRepository,bytes:Buffer,instructions:string,binding:any){
  const candidate={kind:'local-git',repository:'local/project-work-preparation',pr:null,H:source.H,B:source.H,target:'preparation'},native=join(directory,'native'),inputs=JSON.parse((await regular(join(native,'inputs.json'))).toString());
  if(binding.role!=='verifier_fact'||binding.run!==directory||binding.workspace!==join(native,'workspace')||binding.inputManifestSha256!==hash(bytes)||canonical(binding.candidate)!==canonical(candidate)||binding.turnIds.length!==1||canonical(inputs)!==canonical([{input:bytes.toString(),subjectCandidate:candidate,schema:findingSchema}])||binding.promptSha256!==hash(JSON.stringify({system:instructions,inputs})))throw new Error('project_work_preparation_capture_changed');
}
export type WorkPreparationDiagnostic={accepted:false;reason:'non_terminal_agent_message';questions:string[];source:{inputSha256:string;stdoutSha256:string;threadId:string;turnId:string};nextStep:string};
/** Rejected questions are unaccepted text, never a proposal or authority.
 * This cold read deliberately writes nothing and cannot resume a native turn. */
export async function readWorkPreparationDiagnostic(directory:string,source:FixedRepository):Promise<WorkPreparationDiagnostic|null>{
  try{
    const native=join(directory,'native');await checkCapture(native);
    const read=async(name:string)=>JSON.parse((await regular(join(native,name),16*1024*1024)).toString());
    const exit=await read('exit.json'),failure=await read('native-boundary-failure.json');checkConfig((await read('effective-config.json')).config,true);
    if(exit.code!==0||exit.signal!==null||failure.reason!=='controlled_result_not_final:non_terminal_agent_message')return null;
    const {bytes,instructions,sent,start,turn}=await readPreparationInput(directory,source),binding=await read('binding.json'),pairs=await read('reconciled-tools.json');
    await checkPreparationBinding(directory,source,bytes,instructions,binding);
    const raw=await regular(join(native,'stdout.ndjson'),16*1024*1024),frames=raw.toString().trim().split('\n').map(l=>JSON.parse(l)),parsed=parseCodexResult(raw,binding,pairs);
    const thread=await read('thread.json'),response=frames.filter(m=>m.id===start.id&&!m.method);
    if(canonical(sent)!==canonical(await read('expected-requests.json'))||response.length!==1||canonical(response[0].result)!==canonical(thread)||thread.thread?.id!==binding.threadId||thread.thread?.sessionId!==binding.sessionId||thread.cwd!==binding.workspace||thread.thread?.cwd!==binding.workspace||thread.modelProvider!=='openai'||thread.approvalPolicy!=='never'||thread.sandbox?.type!=='readOnly'||thread.sandbox.networkAccess!==false||turn.params.threadId!==binding.threadId||parsed.gaps.length!==1||parsed.gaps[0]!=='non_terminal_agent_message'||parsed.waiting.length||parsed.turns[0]?.terminal!=='completed'||canonical(failure.turnIds)!==canonical(binding.turnIds))return null;
    const questions:string[]=[];
    for(const m of frames){const item=m.params?.item;if(m.method!=='item/completed'||m.params.threadId!==binding.threadId||m.params.turnId!==binding.turnIds[0]||item?.type!=='agentMessage'||item.phase!=='final_answer'||item.delivery!=='async'||!Array.isArray(item.questions))continue;
      for(const q of item.questions){if(typeof q?.title!=='string'||!q.title.trim()||q.title.length>2048||q.title.includes('\0'))return null;if(!questions.includes(q.title))questions.push(q.title);if(questions.length>8)return null;}
    }
    return questions.length?{accepted:false,reason:'non_terminal_agent_message',questions,source:{inputSha256:hash(bytes),stdoutSha256:hash(raw),threadId:binding.threadId,turnId:binding.turnIds[0]},nextStep:'在普通目标中答复这些问题，再明确重新准备同一工作的一个新版本；原失败捕获保留，不回复或重发旧原生轮次。'}:null;
  }catch{return null;}
}
