import {implementationEditProfile} from './repair-edits.js';
import {implementationChoice,implementationTools,verifyImplementationModel} from './implementation-ai.js';
import {modelChoice,codexThreadChoice,codexTurnChoice,checkMetadataModelRequests} from './ai-execution.js';
import {lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical} from './comparison.js';
import {exactKeys} from './authority-contract.js';
import {hash} from './snapshot.js';
import {regular,exists,tree,treeHash,processState,checkRepairIndex,safeEnv,type Lease,type Tree} from './repair-workspace.js';
import {fingerprint} from './verification.js';
import {projectTestPlan,validateProjectContract} from './project-repair.js';
import {dockerEvidenceMatches,dockerTerminalEvidence} from './docker-sandbox.js';
import {checkCapture} from './live-process.js';
import {disabledFeatures,checkConfig} from './live-codex.js';
import {boundedRoleDeveloperInstructions,implementationOutputSchema} from './repair-native.js';
import {capturedExternalExecutable} from './external-executable.js';
import {cliVersion} from './cli-capabilities.js';
import {resultCliVersion} from './codex-results.js';
import {inspectRolePrompt} from './role-prompts.js';
import {implementationFirstInput} from './implementation-first-input.js';
import {assertFixedWorkspaceSnapshot} from './implementation-validation.js';
import type {RepairPlan} from './repair.js';
type Row=Record<string,any>;
export type FirstSendProof={record:Row;input:string;baseline:Row|null;manifest:Row;lease:Lease};
const issued=new WeakMap<object,string>();
const intentSnapshots=new WeakMap<FirstSendProof,{plan:RepairPlan;initial:Tree;index:string;nativePid:number;ownController:boolean;allowed:string[];nativeNames:string[]}>();
const exec=promisify(execFile),readGit=async(workspace:string,args:string[])=>(await exec('/usr/bin/git',['--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',workspace,...args],{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'},timeout:15000,maxBuffer:8*1024*1024})).stdout.trim();
export function requireFirstSendProof(proof:FirstSendProof){if(issued.get(proof)!==hash(canonical(proof.record))||hash(proof.input)!==proof.record.firstInputSha256||hash(canonical(proof.baseline))!==proof.record.baselineCanonicalSha256||hash(canonical(proof.manifest))!==proof.record.manifestCanonicalSha256)throw new Error('implementation_first_send_proof_required');return proof.record;}
const json=async(path:string)=>JSON.parse((await regular(path,24*1024*1024)).toString());
const frames=(b:Buffer)=>{if(!b.length||b.at(-1)!==10)throw new Error('implementation_metadata_partial_frame');return new TextDecoder('utf8',{fatal:true}).decode(b).trim().split('\n').map(l=>JSON.parse(l));};
async function readFirstSendMaterial(fixed:Row){
  const planBytes=await regular(fixed.path),plan=JSON.parse(planBytes.toString()) as RepairPlan,root=fixed.request.workspaceRequest.executionRoot,op=fixed.operationRoot;
  if(hash(planBytes)!==fixed.sha256||op!==join(root,'operation')||plan.workspace!==fixed.workspace||
     !plan.project||(!plan.project.projectFiles&&plan.project.materialView!=='selected_files')||
     plan.project.projectFiles!==fixed.request.workspaceRequest.projectFiles)throw new Error('implementation_first_send_plan_changed');
  const initial=await json(join(op,'initial-tree.json')),manifest=await json(join(op,'input-manifest.json')),{inputManifestSha256,...original}=manifest;
  if(manifest.planSha256!==fixed.sha256||canonical(manifest.request)!==canonical(fixed.request)||hash(canonical(original))!==inputManifestSha256)throw new Error('implementation_first_send_manifest_changed');
  if(fixed.request.workflowPrompt){
    if(canonical(manifest.prompt)!==canonical(fixed.request.workflowPrompt))throw new Error('implementation_first_send_manifest_changed');
  }else inspectRolePrompt(manifest.prompt,'implementer');
  implementationChoice(fixed.request,plan,manifest);implementationEditProfile(fixed.request,plan,manifest);
  const grant=await json(plan.grant);
  validateProjectContract(plan.project,grant);
  if(grant.workspace!==plan.workspace||grant.H!==plan.candidate.H||grant.treeSha256!==treeHash(initial))
    throw new Error('implementation_first_send_source_changed');
  return {plan,initial,manifest,grant};
}
/** Read one original baseline without launching or reconciling Docker. */
export async function readFirstSendBaseline(fixed:Row){
  const {plan,initial,manifest,grant}=await readFirstSendMaterial(fixed),root=fixed.request.workspaceRequest.executionRoot;
  if(plan.project?.materialView!=='selected_files')throw new Error('implementation_first_send_plan_changed');
  const names=(await readdir(root)).filter(n=>n.startsWith('preflight-tests-'));if(names.length!==1)throw new Error('implementation_first_send_baseline_not_unique');
  const directory=join(root,names[0]!),intent=await json(join(directory,'test-intent.json')),input=await json(join(directory,'input.json')),result=await json(join(directory,'result.json')),progress=await json(join(directory,'test-progress.json')),test=await projectTestPlan(plan.project),frozen=treeHash(initial),T=await readGit(plan.workspace,['rev-parse',plan.candidate.H+'^{tree}']);
  if(intent.directory!==directory||intent.workspace!==plan.workspace||intent.kind!=='registered-project-tests-v1'||intent.candidateTreeSha256!==frozen||result.candidateTreeSha256!==frozen||frozen!==grant.treeSha256||canonical(input.sourceCandidate)!==canonical(plan.project.sourceCandidate)||[intent,input,result].some(x=>x.testPlanSha256!==plan.project!.testPlanSha256)||progress.phase!=='completed'||progress.toolsRequested!==test.plan.tools.length||result.tools.length!==test.plan.tools.length||result.executionHealthy!==true||result.failure!==null||result.sourceInput?.sourceHead!==plan.candidate.H||result.sourceInput.sourceHeadTree!==T||result.T!==T||input.T!==T||input.H!==result.H||await fingerprint(join(directory,'work'),Object.keys(initial))!==input.preFingerprint||await readGit(join(directory,'work'),['rev-parse','HEAD'])!==result.H||treeHash(await tree(join(directory,'material-work'),true))!==frozen)throw new Error('implementation_first_send_baseline_changed');
  const expectedPassed=result.tools.every((t:any)=>t.status==='completed'&&t.exitCode===0&&!t.sampleSet);
  if(result.passed!==expectedPassed||result.exit?.code!==(expectedPassed?0:1)||result.sourceInput.frozenWorkingTreeSha256!==frozen||result.sourceInput.testedCommit!==result.H||result.sourceInput.testedTree!==result.T||input.dependencyHash!==plan.project.dependencyHash||canonical(input.protectedPaths)!==canonical(plan.project.protectedPaths))throw new Error('implementation_first_send_baseline_changed');
  const probeDir=join(directory,'runtime/probe'),probe=await regular(join(probeDir,'execution.json'));
  const probeRecord=JSON.parse(probe.toString()),probeOut=await regular(join(probeDir,'stdout')),probeErr=await regular(join(probeDir,'stderr'));
  if(dockerTerminalEvidence(probe,test.plan.executor!,probeDir)!=='ended'||processState(probeRecord.clientPid)!=='ended'||probeRecord.status!=='completed'||probeRecord.exitCode!==0||probeRecord.capture?.complete!==true||hash(probeOut)!==probeRecord.capture.stdoutSha256||hash(probeErr)!==probeRecord.capture.stderrSha256)throw new Error('implementation_first_send_baseline_active');
  for(const [i,tool] of result.tools.entries()){
    const dir=join(directory,'tool-'+i),raw=await regular(join(dir,'execution.json')),record=JSON.parse(raw.toString()),out=await regular(join(dir,'stdout'),4*1024*1024),err=await regular(join(dir,'stderr'),4*1024*1024);
    if(canonical(record.connection)!==canonical(probeRecord.connection)||tool.id!==test.plan.tools[i]!.id||canonical(tool.argv)!==canonical(test.plan.tools[i]!.argv)||processState(record.clientPid)!=='ended'||hash(raw)!==tool.dockerRecordSha256||hash(out)!==tool.stdoutSha256||hash(err)!==tool.stderrSha256||!tool.inputUnchanged||!tool.dependenciesUnchanged||tool.stdout!==out.toString().slice(0,16000)||tool.stderr!==err.toString().slice(0,16000)||canonical(tool.registeredSampleIds)!=='[]'||tool.sampleSet||!dockerEvidenceMatches(raw,test.plan.executor!,{run:frozen,stage:i,tool:tool.id,head:result.H,tree:result.T,planHash:plan.project.testPlanSha256},{...tool,dockerExecutionDirectory:'tool-'+i,stdout:{sha256:hash(out),bytes:out.length},stderr:{sha256:hash(err),bytes:err.length}},test.plan.tools[i]!.timeoutMs))throw new Error('implementation_first_send_baseline_changed');
  }
  return {plan,initial,manifest,grant,baseline:result,directory,controllerPid:intent.controllerPid,input:implementationFirstInput(fixed.request,plan,initial,result)};
}
function controllerEnded(lease:Lease,ownController:boolean){
  return processState(lease.controllerPid)==='ended'||ownController&&lease.controllerPid===process.pid;
}

/** Verify metadata and the complete transported prefix, then bind the exact
 * original dispatch. A prepared request in the contract is not a wire frame. */
export async function readFirstSendProof(fixed:Row,dispatchEvent:number,ownController=false):Promise<FirstSendProof>{
  const op=fixed.operationRoot,native=join(op,'implementer'),root=fixed.request.workspaceRequest.executionRoot;
  const hasIntent=await exists(join(native,'turn-1-intent.json'));
  const data=fixed.request.workspaceRequest.projectFiles
    ? {...await readFirstSendMaterial(fixed),baseline:null,directory:null,controllerPid:null,input:null}
    : await readFirstSendBaseline(fixed);
  const {plan,initial,manifest,grant}=data,lease=await json(join(plan.workspace,'.git/tongxu-writer.json')) as Lease;
  if(!exactKeys(lease,['operation','controllerPid','generation','status'])||lease.operation!==op||lease.status!=='held'||
     typeof lease.generation!=='string'||!/^[a-f0-9-]{36}$/.test(lease.generation)||
     data.controllerPid!==null&&lease.controllerPid!==data.controllerPid||
     !controllerEnded(lease,hasIntent&&ownController))throw new Error('implementation_original_controller_active_or_unknown');
  const handoffName='handoff-'+lease.generation+'-1.json',failure=await exists(join(op,'failure.json'));
  const allowed=['attempt-1','implementer','initial-tree.json','input-manifest.json',...(failure?['failure.json']:[]),...(hasIntent?[handoffName]:[])].sort();
  if(!hasIntent&&(!failure||!data.baseline)||canonical((await readdir(op)).sort())!==canonical(allowed)||
     (await readdir(join(op,'attempt-1'))).length||!data.baseline&&(await readdir(root)).some(n=>n.startsWith('preflight-tests-')))
    throw new Error('implementation_first_send_operation_not_metadata');
  const index=hasIntent?hash(await regular(join(plan.workspace,'.git/index'),8*1024*1024)):'';
  const files:Record<string,string>={};let total=0;
  const seal=async(dir:string)=>{for(const e of await readdir(dir,{withFileTypes:true})){if(dir===root&&e.name==='workspace')continue;const path=join(dir,e.name);if(e.isSymbolicLink())throw new Error('implementation_first_send_unsafe_evidence');if(e.isDirectory())await seal(path);else{const b=await regular(path,24*1024*1024);total+=b.length;if(total>48*1024*1024)throw new Error('implementation_first_send_evidence_limit');files[path.slice(root.length+1)]=hash(b);}}};await seal(root);
  if(hasIntent&&!await exists(join(native,'capture-status.json')))throw new Error('implementation_first_send_capture_incomplete');
  await checkCapture(native);
  const read=(n:string)=>json(join(native,n)),binding=await read('binding.json'),exit=await read('exit.json'),processRecord=await read('process.json'),identity=await read('executable.json'),launch=await read('launch.json'),thread=await read('thread.json'),configuration=await read('effective-config.json');
  checkConfig(configuration.config,true);
  const ended=hasIntent
    ? processRecord.status==='spawn_attempted'&&Number.isFinite(Date.parse(exit.at))&&
      (Number.isInteger(exit.code)&&exit.signal===null||exit.code===null&&/^SIG[A-Z0-9]+$/.test(exit.signal))
    : exit.code===0&&exit.signal===null;
  if(!ended||processState(processRecord.pid)!=='ended'||binding.role!=='implementer'||binding.scopeSource!==plan.scopeSource||binding.arrangementSource!=='Explicit Issue implementation; one new bounded implementer context; no finding or native resume'||binding.run!==op||binding.sourceKind!==(plan.executionKind??'native_capture')||binding.workspace!==join(native,'workspace')||canonical(binding.candidate)!==canonical(plan.candidate)||binding.inputManifestSha256!==manifest.inputManifestSha256||binding.promptSha256!==hash(manifest.prompt.system)||canonical(binding.turnIds)!=='[]'||canonical(await read('reconciled-tools.json'))!=='[]')throw new Error('implementation_first_send_metadata_changed');
  const nativeNames=await readdir(native);
  if(nativeNames.some(n=>n==='completed.json'||n.startsWith('tool-host-')||n==='native-tool-transports.json'||
    n.startsWith('turn-')&&(!hasIntent||n!=='turn-1-intent.json')||
    !hasIntent&&['inputs.json','native-boundary-failure.json'].includes(n)))throw new Error('implementation_first_send_input_possible');
  if(hasIntent){
    const known=['binding.json','capture-status.json','effective-config.json','executable.json','exit.json',
      'expected-requests.json','inputs.json','launch.json','model-choice.json','native-boundary-failure.json',
      'process.json','reconciled-tools.json','stderr.txt','stdin.ndjson','stdout.ndjson','thread.json',
      'tool-host.json','turn-1-intent.json'];
    if(nativeNames.some(name=>name!=='workspace'&&(!known.includes(name)||!Object.hasOwn(files,'operation/implementer/'+name))))
      throw new Error('implementation_first_send_input_possible');
  }
  const selected=implementationChoice(fixed.request,plan,manifest),model=selected?modelChoice(selected):undefined;
  const sent=frames(await regular(join(native,'stdin.ndjson'))),received=frames(await regular(join(native,'stdout.ndjson')));checkMetadataModelRequests(sent);
  let id=0;const request=(method:string,params:any)=>({id:++id,method,params}),cwd=binding.workspace;
  const expected=[request('initialize',{clientInfo:{name:'tongxu-controlled-repair',version:'0.1.0'},capabilities:{experimentalApi:true}}),{method:'initialized',params:{}},request('account/read',{refreshToken:false}),request('config/read',{includeLayers:false,cwd}),request('account/rateLimits/read',{}),...(model?sent.filter(m=>m.method==='model/list').map(m=>request('model/list',m.params)):[]),request('thread/start',{...codexThreadChoice(model),cwd,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',baseInstructions:manifest.prompt.system,developerInstructions:boundedRoleDeveloperInstructions,dynamicTools:implementationTools(fixed.request,plan,manifest),environments:[],selectedCapabilityRoots:[],runtimeWorkspaceRoots:[cwd]})];
  const threadRequestId=id;
  if(hasIntent)expected.push(request('account/rateLimits/read',{}));
  const expectedRequests=await read('expected-requests.json');
  let input=data.input;
  if(hasIntent){
    const [saved,...other]=await read('inputs.json'),schema=implementationOutputSchema(plan.candidate.H);
    const intent=await read('turn-1-intent.json'),handoff=await json(join(op,handoffName));
    if(!saved||other.length||typeof saved.input!=='string'||canonical(saved.subjectCandidate)!==canonical(plan.candidate)||
       canonical(saved.schema)!==canonical(schema)||canonical(intent)!==canonical({subjectCandidate:plan.candidate,inputSha256:hash(saved.input),status:'send_registered'})||
       canonical(handoff)!==canonical({from:'trusted-preparer',to:binding.sessionId,sessionContinuity:'new_implementer_context',grant,lease,verifiedTreeSha256:treeHash(initial),backgroundCommands:'none-active-in-managed-workspace'}))
      throw new Error('implementation_first_send_intent_changed');
    const {validationDefinition}=JSON.parse(saved.input.slice(saved.input.lastIndexOf('\n')+1));
    if(saved.input!==implementationFirstInput(fixed.request,plan,initial,data.baseline,validationDefinition))
      throw new Error('implementation_first_send_intent_changed');
    input=saved.input;
    const attempted={id:id+1,method:'turn/start',params:{threadId:binding.threadId,input:[{type:'text',text:input}],approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},...codexTurnChoice(model),outputSchema:schema}};
    if(canonical(expectedRequests)!==canonical(expected)&&canonical(expectedRequests)!==canonical([...expected,attempted]))
      throw new Error('implementation_first_send_intent_changed');
    if(nativeNames.includes('native-boundary-failure.json')&&canonical(await read('native-boundary-failure.json'))!==canonical({reason:'executor_closed',stage:'turn_rejected',turnIds:[]}))
      throw new Error('implementation_first_send_input_possible');
  }
  const replies=new Map<number,any>(),accountUpdates:Row[]=[];
  if(canonical(sent)!==canonical(expected)||!hasIntent&&canonical(expectedRequests)!==canonical(expected))throw new Error('implementation_first_send_metadata_unknown');
  for(const m of received){if(Object.hasOwn(m,'id')){if(m.method||!Number.isSafeInteger(m.id)||m.id<1||m.id>id||replies.has(m.id)||!Object.hasOwn(m,'result')||Object.hasOwn(m,'error'))throw new Error('implementation_first_send_metadata_unknown');replies.set(m.id,m.result);}else if(m.method==='thread/started'){if(canonical(m.params?.thread)!==canonical(thread.thread))throw new Error('implementation_first_send_metadata_unknown');}else if(m.method==='thread/status/changed'){if(m.params?.threadId!==binding.threadId||m.params?.status?.type!=='idle')throw new Error('implementation_first_send_metadata_unknown');}else if(m.method==='account/updated'){if(!exactKeys(m.params,['authMode','planType']))throw new Error('implementation_first_send_metadata_unknown');accountUpdates.push(m.params);}else if(m.method==='remoteControl/status/changed'){const p=m.params;if(!exactKeys(p,['status','serverName','installationId','environmentId'])||p.status!=='disabled'||p.environmentId!==null||typeof p.serverName!=='string'||p.serverName.length>256||typeof p.installationId!=='string'||!/^[-A-Za-z0-9]{1,128}$/.test(p.installationId))throw new Error('implementation_first_send_metadata_unknown');}else if(m.method!=='account/rateLimits/updated')throw new Error('implementation_first_send_metadata_unknown');}
  const t=thread.thread;
  if(accountUpdates.some(p=>p.authMode!=='chatgpt'||p.planType!==replies.get(2)?.account?.planType)||replies.size!==id||replies.get(2)?.account?.type!=='chatgpt'||replies.get(4)?.ordinaryUsageAllowed!==true||canonical(replies.get(3))!==canonical(configuration)||hasIntent&&replies.get(id)?.ordinaryUsageAllowed!==true||canonical(replies.get(threadRequestId))!==canonical(thread)||t?.id!==binding.threadId||t?.sessionId!==binding.sessionId||t?.cwd!==cwd||t?.cliVersion!==resultCliVersion(binding)||t?.parentThreadId!=null||t?.forkedFromId!=null||thread.approvalPolicy!=='never'||thread.sandbox?.type!=='readOnly'||thread.sandbox.networkAccess!==false||thread.modelProvider!=='openai'||thread.cwd!==cwd)throw new Error('implementation_first_send_metadata_changed');
  await verifyImplementationModel(fixed.request,plan,manifest,native,true);
  for(const path of thread.instructionSources??[]){const ref=plan.allowedInstructionSources.find(x=>x.path===path);if(!ref||hash(await regular(path))!==ref.sha256)throw new Error('implementation_first_send_instructions_changed');}
  const args=disabledFeatures.flatMap(n=>['-c',`features.${n}=${n==='code_mode_host'}`]);for(const n of plan.disabledMcpServers)args.push('-c',`mcp_servers.${n}.enabled=false`);args.push('-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','model_provider="openai"','-c','service_tier="default"','app-server','--listen','stdio://');
  if(!capturedExternalExecutable(identity.externalSelection,plan.codexExecutable)||identity.externalSelection.sha256!==identity.sha256||identity.externalSelection.realpath!==identity.realpath||cliVersion(identity.version,'codex')!==resultCliVersion(binding)||identity.path!==plan.codexExecutable||launch.command!==identity.path||launch.cwd!==cwd||canonical(launch.args)!==canonical(args)||canonical(launch.executableSelection??null)!==canonical(identity.externalSelection??null))throw new Error('implementation_first_send_launch_changed');
  if(await readGit(plan.workspace,['rev-parse','HEAD'])!==plan.candidate.H||await readGit(plan.workspace,['status','--porcelain','--untracked-files=all','--ignored'])||treeHash(await tree(plan.workspace,true))!==treeHash(initial))throw new Error('implementation_first_send_source_changed');
  const view=plan.project!.materialView;
  await checkRepairIndex(plan.workspace,op,[],initial,view?{materialView:view,materialPaths:[...plan.project!.materialPaths,...plan.project!.protectedPaths]}:undefined,true);
  if(hasIntent){
    const tracked=(await readGit(plan.workspace,['ls-tree','-r','--name-only','-z',plan.candidate.H])).split('\0').filter(Boolean);
    const expectedFlags=tracked.map(path=>(Object.hasOwn(initial,path)?'H ':'S ')+path).sort();
    for(const flag of ['-v','-f']){
      const actual=(await readGit(plan.workspace,['ls-files',flag,'-z'])).split('\0').filter(Boolean).sort();
      if(canonical(actual)!==canonical(expectedFlags))throw new Error('implementation_first_send_index_flags_changed');
    }
    if(await readGit(plan.workspace,['symbolic-ref','HEAD'])!=='refs/heads/repair-project'||
       await readGit(plan.workspace,['rev-parse','refs/heads/project-base'])!==plan.candidate.H||
       hash(await regular(join(plan.workspace,'.git/index'),8*1024*1024))!==index||
       (await readdir(cwd)).length)throw new Error('implementation_first_send_source_changed');
  }
  if(input===null)throw new Error('implementation_first_send_input_possible');
  const record={schemaVersion:1,dispatchEvent,operationRoot:op,requestSha256:hash(canonical(fixed.request)),planSha256:fixed.sha256,inputManifestSha256:manifest.inputManifestSha256,baselineDirectory:data.directory,baselineResultSha256:data.directory?hash(await regular(join(data.directory,'result.json'))):null,baselineCanonicalSha256:hash(canonical(data.baseline)),manifestCanonicalSha256:hash(canonical(manifest)),firstInputSha256:hash(input),nativeDirectory:join(op,'first-input','native'),lease,files,...(hasIntent?{dispatchIntentSha256:files['operation/implementer/turn-1-intent.json']}: {})};
  const proof={record,input,baseline:data.baseline,manifest,lease};
  issued.set(proof,hash(canonical(record)));
  if(hasIntent)intentSnapshots.set(proof,{plan,initial,index,nativePid:processRecord.pid,ownController,allowed,nativeNames:nativeNames.sort()});
  await checkFirstSendFiles(proof,root);
  assertFirstSendCurrent(proof,root);
  if(!controllerEnded(lease,hasIntent&&ownController))throw new Error('implementation_original_controller_active_or_unknown');
  return proof;
}

/** The operation lock is held when the caller consumes this observation. */
export function assertFirstSendCurrent(proof:FirstSendProof,root:string,expectedInput?:{validationDefinition:unknown}){
  const record=requireFirstSendProof(proof),snapshot=intentSnapshots.get(proof);
  if(!snapshot)return;
  const {plan,initial,index,nativePid,ownController,allowed,nativeNames}=snapshot;
  if(!controllerEnded(proof.lease,ownController)||processState(nativePid)!=='ended')
    throw new Error('implementation_original_controller_active_or_unknown');
  if(expectedInput&&proof.input!==implementationFirstInput(proof.manifest.request,plan,initial,proof.baseline,expectedInput.validationDefinition))
    throw new Error('implementation_first_send_intent_changed');
  const op=record.operationRoot,native=join(op,'implementer');
  if(canonical(readdirSync(op).sort())!==canonical(allowed)||readdirSync(join(op,'attempt-1')).length||
     canonical(readdirSync(native).sort())!==canonical(nativeNames)||readdirSync(join(native,'workspace')).length)
    throw new Error('implementation_first_send_original_changed');
  assertFixedWorkspaceSnapshot(plan.workspace,plan.candidate.H,initial,index,proof.lease);
  const gitRefs=execFileSync('/usr/bin/git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-C',plan.workspace,'rev-parse','--symbolic-full-name','HEAD'],{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'},timeout:15000,maxBuffer:4096,encoding:'utf8'}).trim();
  const base=execFileSync('/usr/bin/git',['--no-replace-objects','-C',plan.workspace,'rev-parse','refs/heads/project-base'],
    {env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'},timeout:15000,maxBuffer:4096,encoding:'utf8'}).trim();
  if(gitRefs!=='refs/heads/repair-project'||base!==plan.candidate.H)throw new Error('implementation_first_send_source_changed');
  for(const [name,sha] of Object.entries(record.files) as Array<[string,string]>){
    const path=join(root,name),stat=lstatSync(path);
    if(!stat.isFile()||stat.nlink!==1||stat.size>24*1024*1024||realpathSync(path)!==path||hash(readFileSync(path))!==sha)
      throw new Error('implementation_first_send_original_changed');
  }
}
export async function checkFirstSendFiles(proof:FirstSendProof,root:string){requireFirstSendProof(proof);for(const [name,sha] of Object.entries(proof.record.files))if(hash(await regular(join(root,name),24*1024*1024))!==sha)throw new Error('implementation_first_send_original_changed');}
/** Legacy results retain their old path; continuations must match the original store event. */
export async function implementationCaptureDirectory(state:Row){
  const root=state.plan.operationRoot,ref=state.result?.firstInputContinuation;if(!ref)return join(root,'implementer');
  const recorded=state.firstInputContinuation;
  if(!recorded||ref.proof?.operationRoot!==root||ref.proof.requestSha256!==state.requestSha256||canonical(ref)!==canonical(recorded)||ref.nativeDirectory!==join(root,'first-input','native')||ref.requestSha256!==state.requestSha256||ref.planSha256!==state.plan.sha256)throw new Error('implementation_first_send_capture_changed');
  if(hash(canonical(ref.proof))!==ref.proofSha256)throw new Error('implementation_first_send_capture_changed');
  for(const [name,sha] of Object.entries(ref.proof.files) as Array<[string,string]>)if(hash(await regular(join(state.plan.request.workspaceRequest.executionRoot,name),24*1024*1024))!==sha)throw new Error('implementation_first_send_original_changed');
  const inputs=await json(join(ref.nativeDirectory,'inputs.json')),binding=await json(join(ref.nativeDirectory,'binding.json')),manifest=await json(join(root,'input-manifest.json')),plan=await json(state.plan.path),sent=frames(await regular(join(ref.nativeDirectory,'stdin.ndjson'),16*1024*1024)),turns=sent.filter(m=>m.method==='turn/start'),starts=sent.filter(m=>m.method==='thread/start');
  if(inputs.length!==1||hash(inputs[0].input)!==ref.firstInputSha256||turns.length!==1||starts.length!==1||canonical(turns[0].params.input)!==canonical([{type:'text',text:inputs[0].input}])||canonical(inputs[0].subjectCandidate)!==canonical(plan.candidate)||canonical(inputs[0].schema)!==canonical(implementationOutputSchema(plan.candidate.H))||starts[0].params.baseInstructions!==manifest.prompt.system||canonical(starts[0].params.dynamicTools)!==canonical(implementationTools(state.plan.request,plan,manifest))||binding.role!=='implementer'||binding.run!==root||binding.workspace!==join(ref.nativeDirectory,'workspace')||canonical(binding.candidate)!==canonical(plan.candidate)||binding.inputManifestSha256!==manifest.inputManifestSha256||binding.promptSha256!==hash(JSON.stringify({system:manifest.prompt.system,inputs})))throw new Error('implementation_first_send_capture_changed');
  return ref.nativeDirectory;
}
