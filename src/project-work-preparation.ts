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
import {parseWorkProposal,preparationToolSpecs,workPreparationInstructions,type WorkProposal} from './project-work-contract.js';
import type {RepairConfig} from './repair.js';
import type {Candidate} from './live-codex.js';
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
  // Generic task observations cover this work's editable paths; the original
  // implementation separately retains and checks all protected/read material.
  if(editable>384*1024||Buffer.byteLength(canonical(material))>768*1024)throw new Error('project_work_material_limit');
  return total;
}
export async function prepareWorkProposal(o:{source:FixedRepository;issue:unknown;goal:string;directory:string;config:RepairConfig;check:()=>Promise<void>;stopped:()=>boolean;onSession:(s:BoundedCodexSession)=>void}){
  await privateDirectory(o.directory,true);const files=await repositoryFiles(o.source);
  if(files.length>8192)throw new Error('project_work_repository_listing_limit');
  const input={kind:'project_work_engineering_preparation',source:o.source,issue:o.issue,userGoal:o.goal,files:files.map(({path,mode,bytes})=>({path,mode,bytes})),supportedValidation:'Registered isolated Docker Node built-ins; no installation,network or host shell',toolLimit:32,timeLimitMs:o.config.timeoutMs};
  const bytes=canonical(input);if(Buffer.byteLength(bytes)>512*1024)throw new Error('project_work_preparation_input_limit');
  await writeFile(join(o.directory,'input.json'),bytes,{flag:'wx',mode:0o600});
  const candidate:Candidate={kind:'local-git',repository:'local/project-work-preparation',pr:null,H:o.source.H,B:o.source.H,target:'preparation'},observations:unknown[]=[];let calls=0,total=0,turnStarted:number|null=null;
  const check=async()=>{if(o.stopped())throw new Error('project_work_preparation_stopped');await o.check();if(o.stopped())throw new Error('project_work_preparation_stopped');};
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
  const bytes=await regular(join(directory,'input.json'),512*1024),input=JSON.parse(bytes.toString()),capture=await readRepairSession(join(directory,'native'));
  if(canonical(input.source)!==canonical(source)||capture.binding.role!=='verifier_fact'||capture.binding.inputManifestSha256!==hash(bytes)||capture.turns.length!==1||!capture.turns[0]?.final)throw new Error('project_work_preparation_capture_changed');
  const sent=(await readFile(join(directory,'native','stdin.ndjson'),'utf8')).trim().split('\n').map(l=>JSON.parse(l)),start=sent.find(m=>m.method==='thread/start'),turn=sent.find(m=>m.method==='turn/start');
  if(!isDeepStrictEqual(start?.params.dynamicTools,preparationToolSpecs)||start.params.baseInstructions!==workPreparationInstructions||turn?.params.input?.[0]?.text!==bytes.toString()||!isDeepStrictEqual(turn.params.outputSchema,findingSchema))throw new Error('project_work_preparation_capture_changed');
  const result=JSON.parse(capture.turns[0].final.text);if(!['confirmed','needs_owner'].includes(result.decision)||result.candidateH!==source.H)throw new Error('project_work_preparation_invalid_result');
  const proposal=parseWorkProposal(JSON.parse(result.report));if(result.decision==='confirmed'&&!proposal.questions.length){const names=new Set((await repositoryFiles(source)).map(f=>f.path));for(const path of proposal.allowedPaths){const parts=path.split('/');for(let n=0;n<parts.length;n++){const instruction=[...parts.slice(0,n),'AGENTS.md'].join('/');if(names.has(instruction)&&(!proposal.materialPaths.includes(instruction)||!proposal.protectedPaths.includes(instruction)))throw new Error('project_work_instructions_material_required');}}}await checkWorkMaterial(source,proposal);
  return {proposal,proposalDigest:hash(canonical(proposal)),inputSha256:hash(bytes),captureSha256:hash(await regular(join(directory,'native','completed.json'))),ready:result.decision==='confirmed'&&!proposal.questions.length};
}
