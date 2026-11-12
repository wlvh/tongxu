import {implementationFirstInput} from './implementation-first-input.js';
import {checkFirstSendFiles,type FirstSendProof} from './implementation-first-send.js';
import {requireValidationFailure,verifyValidationFiles,type ValidationFailureProof,readFailedValidationTests} from './implementation-validation.js';
import {projectWorkOrigin,type ProjectWorkOrigin} from './project-chat-contract.js';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {save} from './live-process.js';
import {assembleRolePrompt} from './role-prompts.js';
import {BoundedCodexSession,implementationOutputSchema,readRepairSession} from './repair-native.js';
import {prepareProjectRepair,validateProjectContract,projectTestPlan,projectMaterial,projectModelTestResult,testProject,bindProjectTestToCandidate,type ProjectRequest} from './project-repair.js';
import {regular,exists,git,tree,treeHash,scopeChanges,acquireWorkspace,releaseWorkspace,RepairTools,commitScopedCandidate,assertUnselectedGitUnchanged,type Grant} from './repair-workspace.js';
import type {ScopeBody} from './authority-contract.js';
import type {RepairPlan} from './repair.js';

type Row=Record<string,any>;
export type ImplementationRequest={schemaVersion:1;kind:'tongxu-issue-implementation';id:string;task:string;adoptedScope:{adoption:string;body:ScopeBody;bodySha256:string;source:string};issue:{number:number;body:string;bodySha256:string;adjudication:string};workspaceRequest:ProjectRequest;origin?:ProjectWorkOrigin;continuation?:{logicalOwner:string;originalTarget:{source:string;requestId:string;task:string;operation:string};predecessor:{requestId:string;operation:string;H1:string;resultSha256:string};supplement:{id:string;text:string};history:Array<{requestId:string;operation:string;H0:string;H1:string;sessionId:string;report:Row;supplement?:{id:string;text:string}}>}};
export type ImplementationGate={refresh():Promise<void>;unsent():void;check(effect?:()=>void):void;dispatch():void;validationDefinition?:unknown};

/** The existing fixed-project preparer is used with an empty finding list.
 * Execution below is a new implementer consumer, never the repair/fact loop. */
export async function prepareIssueImplementation(config:string,request:ImplementationRequest,root:string){
  if(request.schemaVersion!==1||request.kind!=='tongxu-issue-implementation'||!request.id||!/^[a-f0-9]{64}$/.test(request.task)||!Number.isSafeInteger(request.issue?.number)||request.issue.number<1||typeof request.issue.body!=='string'||hash(request.issue.body)!==request.issue.bodySha256||!request.issue.adjudication?.trim()||!request.adoptedScope||hash(canonical(request.adoptedScope.body))!==request.adoptedScope.bodySha256||!request.adoptedScope.source||request.workspaceRequest.findings.length||request.workspaceRequest.executionRoot!==root||request.origin!==undefined&&!projectWorkOrigin(request.origin,request.id))throw new Error('issue_implementation_request_invalid');
  const requestPath=join(root+'-request.json');
  const bytes=Buffer.from(canonical(request.workspaceRequest));
  if(await exists(requestPath)){if(hash(await regular(requestPath))!==hash(bytes))throw new Error('issue_implementation_original_changed');}
  else await writeFile(requestPath,bytes,{flag:'wx',mode:0o600});
  const prepared=await prepareProjectRepair(config,requestPath,root);
  // A registered request may have failed queue admission after preparation.
  // Re-read its original files; never bind a modified plan merely because the
  // preparer found an existing directory. Config and request are fixed inputs.
  const r=request.workspaceRequest,plan=JSON.parse((await regular(prepared.plan)).toString()) as RepairPlan;
  const expected={...JSON.parse((await regular(config)).toString()),schemaVersion:1,kind:'tongxu-controlled-repair',workspace:join(root,'workspace'),candidate:{kind:'local-git',repository:'local/project-repair',pr:null,H:r.candidate.H,B:r.candidate.H,target:'project-base'},grant:join(root,'grant.json'),findings:[],test:'registered-project-tests-v1',demonstrationFixture:r.demonstrationFixture,project:{sourceCandidate:r.candidate,materialPaths:r.materialPaths,protectedPaths:r.protectedPaths,contract:r.contract,testPlan:join(root,'test-plan.json'),testPlanSha256:r.testPlanSha256,dependencyHash:plan.project?.dependencyHash,generatedDirectories:r.generatedDirectories,...(r.materialView?{materialView:r.materialView}:{})}};
  if(canonical(plan)!==canonical(expected))throw new Error('implementation_original_plan_changed');
  await projectTestPlan(plan.project!);
  return {...prepared,request,kind:'tongxu-issue-implementation' as const};
}

/** One bounded, nonpersistent implementer turn. Uncertain or failed runs are
 * retained for inspection. Only a complete, unchanged input-only preparation
 * can continue its first dispatch; native/failed writer recovery is excluded. */
export async function runIssueImplementation(planPath:string,expectedPlanSha256:string,request:ImplementationRequest,operation:string,external:ImplementationGate,firstSend?:{proof:FirstSendProof;reference:Row}){
  const planBytes=await regular(planPath),plan=JSON.parse(planBytes.toString()) as RepairPlan;
  if(!Number.isSafeInteger(plan.timeoutMs)||plan.timeoutMs<1000||plan.timeoutMs>900000||!['fixture','native_capture',undefined].includes(plan.executionKind)||!plan.scopeSource||hash(planBytes)!==expectedPlanSha256||plan.findings.length||!plan.project||plan.test!=='registered-project-tests-v1'||plan.project.priorReview||plan.project.queueOperation)throw new Error('issue_implementation_plan_changed');
  const grant=JSON.parse((await regular(plan.grant)).toString()) as Grant;
  validateProjectContract(plan.project,grant);await projectTestPlan(plan.project);
  if(plan.workspace!==grant.workspace||grant.H!==plan.candidate.H||grant.H!==request.workspaceRequest.candidate.H||canonical(grant.allowedPaths)!==canonical(request.workspaceRequest.allowedPaths)||canonical(plan.project.materialPaths)!==canonical(request.workspaceRequest.materialPaths)||canonical(plan.project.protectedPaths)!==canonical(request.workspaceRequest.protectedPaths)||plan.project.contract!==request.workspaceRequest.contract||plan.project.testPlanSha256!==request.workspaceRequest.testPlanSha256)throw new Error('implementation_original_scope_changed');
  const billing=plan.billing;
  if(billing?.mode!=='existing_subscription_only'||billing.usageCreditsEnabled!==false||!Number.isFinite(Date.parse(billing.observedAt))||hash(await regular(billing.evidence))!==billing.evidenceSha256||Date.now()-Date.parse(billing.observedAt)>24*3600000||Date.parse(billing.observedAt)>Date.now()+60000)throw new Error('implementation_billing_unavailable');
  external.unsent();
  if(operation!==join(request.workspaceRequest.executionRoot,'operation'))throw new Error('implementation_original_operation_changed');
  const initial=await tree(plan.workspace,true);if(treeHash(initial)!==grant.treeSha256||await git(plan.workspace,['rev-parse','HEAD'])!==grant.H||await git(plan.workspace,['status','--porcelain','--untracked-files=all','--ignored']))throw new Error('implementation_initial_tree_changed');
  const prompt=firstSend?firstSend.proof.manifest.prompt:await assembleRolePrompt('implementer'),inputManifestSha256=hash(canonical({request,planSha256:expectedPlanSha256,prompt}));
  const manifest={request,planSha256:expectedPlanSha256,prompt,inputManifestSha256};
  const readPreparation=async()=>{
    await privateDirectory(operation,false);await privateDirectory(join(operation,'attempt-1'),false);
    if((await readdir(operation)).sort().join()!=='attempt-1,initial-tree.json,input-manifest.json'||(await readdir(join(operation,'attempt-1'))).length)throw new Error('implementation_original_operation_must_be_read');
    if(canonical(JSON.parse((await regular(join(operation,'input-manifest.json'))).toString()))!==canonical(manifest)||canonical(JSON.parse((await regular(join(operation,'initial-tree.json'),20*1024*1024)).toString()))!==canonical(initial))throw new Error('implementation_original_input_changed');
    if(treeHash(await tree(plan.workspace,true))!==treeHash(initial)||await git(plan.workspace,['rev-parse','HEAD'])!==grant.H||await git(plan.workspace,['status','--porcelain','--untracked-files=all','--ignored']))throw new Error('implementation_initial_tree_changed');
  };
  if(firstSend)await checkFirstSendFiles(firstSend.proof,request.workspaceRequest.executionRoot);
  else if(await exists(operation))await readPreparation();
  else{
    await privateDirectory(operation,true);await mkdir(join(operation,'attempt-1'),{mode:0o700});
    await writeFile(join(operation,'initial-tree.json'),JSON.stringify(initial),{flag:'wx',mode:0o600});
    await writeFile(join(operation,'input-manifest.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
  }
  const originalPreparation=()=>firstSend?checkFirstSendFiles(firstSend.proof,request.workspaceRequest.executionRoot):readPreparation();
  await external.refresh();external.unsent();await originalPreparation();
  // Baseline failures stay before the native-dispatch boundary and writer
  // lease. The same original request can retry preparation after conditions
  // recover; every explicit check retains its own immutable test evidence.
  const baseline=firstSend?firstSend.proof.baseline:plan.project.materialView?await testProject(plan.workspace,join(request.workspaceRequest.executionRoot,'preflight-tests-'+randomUUID()),plan.project,{refresh:async()=>{await external.refresh();external.unsent();},start:effect=>{external.unsent();external.check(effect);}}):null;
  if(baseline&&!baseline.executionHealthy)throw new Error('implementation_baseline_environment_failed');
  await external.refresh();external.unsent();await originalPreparation();
  const lease=await acquireWorkspace(plan.workspace,operation,false,grant);
  let session:BoundedCodexSession|undefined;
  const gate=new RepairTools(plan.workspace,operation,grant,lease,plan.nodeExecutable,structuredClone(initial),plan.candidate.H,
    async directory=>{const result=await testProject(plan.workspace,directory,plan.project!,{refresh:()=>external.refresh(),start:effect=>external.check(effect)});if(!result.executionHealthy)throw new Error('project_test_environment_or_capture_failed');return projectModelTestResult(result);},
    effect=>external.check(effect),()=>external.refresh(),plan.project.materialView?{materialView:'selected_files',materialPaths:[...plan.project.materialPaths,...plan.project.protectedPaths]}:undefined);
  try{
    const nativeDirectory=firstSend?.reference.nativeDirectory??join(operation,'implementer');
    session=await BoundedCodexSession.start({executable:plan.codexExecutable,directory:nativeDirectory,operation,candidate:plan.candidate,role:'implementer',system:prompt.system,inputManifestSha256,scopeSource:plan.scopeSource,arrangementSource:'Explicit Issue implementation; one new bounded implementer context; no finding or native resume',disabledMcpServers:plan.disabledMcpServers,allowedInstructionSources:plan.allowedInstructionSources,timeoutMs:plan.timeoutMs,executionKind:plan.executionKind??'native_capture',projectRepair:true,gate,beforeTurn:()=>external.refresh(),beforeSendSync:()=>external.check(),dispatchGate:send=>{external.dispatch();return send();}});
    await gate.handoff(session.sessionId,'new_implementer_context');
    // This report belongs to its original H0. A test tool may also identify a
    // temporary tested commit; only the host can form the final H1 afterwards.
    const outputSchema=implementationOutputSchema(plan.candidate.H);
    const input=firstSend?firstSend.proof.input:implementationFirstInput(request,plan,initial,baseline,external.validationDefinition);
    const report=await session.turn(input,plan.candidate,outputSchema);
    const sessionId=session.sessionId,exercised=session.exercisedTools;await session.close();session=undefined;
    const capture=await readRepairSession(nativeDirectory);
    if(capture.binding.role!=='implementer'||capture.binding.inputManifestSha256!==inputManifestSha256||capture.turns.length!==1||canonical(JSON.parse(capture.turns[0]!.final!.text))!==canonical(report))throw new Error('implementation_complete_capture_required');
    const current=await gate.check(),changed=scopeChanges(initial,current,grant.allowedPaths);
    if(report.decision!=='implemented'){
      if(changed.length)throw new Error('implementation_report_change_mismatch');
      const status:'no_change'|'owner_decision_required'=report.decision==='no_change'?'no_change':'owner_decision_required';
      const result={status,requestId:request.id,task:request.task,H0:plan.project.sourceCandidate.H,H1:null,report,sessionId,completeCapture:true,newNativeContext:true,...(firstSend?{firstInputContinuation:firstSend.reference}:{})};
      save(join(operation,'result.json'),result);gate.phase='closed';await releaseWorkspace(plan.workspace,lease,result.status);return result;
    }
    if(!changed.length||!['tongxu_read_file','tongxu_replace_file','tongxu_run_tests'].every(name=>exercised.includes(name)))throw new Error('implementation_actual_change_and_tests_required');
    const tests=await testProject(plan.workspace,join(operation,'attempt-1','post-repair-1'),plan.project,{refresh:()=>external.refresh(),start:effect=>external.check(effect)});
    if(!tests.passed||!tests.executionHealthy)throw new Error('implementation_registered_tests_failed');
    const calls=await Promise.all((await readdir(join(operation,'calls'))).filter(name=>name.endsWith('.json')).map(async name=>JSON.parse((await regular(join(operation,'calls',name))).toString())));
    if(!calls.some(call=>call.request?.tool==='tongxu_run_tests'&&call.response&&JSON.parse(call.response.contentItems[0].text).passed===true&&JSON.parse(call.response.contentItems[0].text).candidateTreeSha256===treeHash(current)))throw new Error('implementation_agent_did_not_test_current_tree');
    const committed=await commitScopedCandidate(plan.workspace,operation,'attempt-1',1,plan.candidate,current,grant,gate,'implement: adopted Issue #'+request.issue.number,'tongxu controlled implementation runner');
    if(plan.project.materialView)await assertUnselectedGitUnchanged(plan.workspace,plan.project.sourceCandidate.H,committed.candidate.H,[...plan.project.materialPaths,...plan.project.protectedPaths]);
    const testCandidateBinding=await bindProjectTestToCandidate(plan.workspace,committed.candidate,tests);
    const result={status:'completed' as const,requestId:request.id,task:request.task,H0:plan.project.sourceCandidate.H,H1:committed.candidate.H,candidate:committed.candidate,changed,diff:committed.diff,treeSha256:treeHash(current),testCandidateBinding,tests,modelTests:projectModelTestResult(tests),report,sessionId,completeCapture:true,newNativeContext:true,nativeSessionResumed:false,formalReview:false,published:false,userAccepted:false,...(firstSend?{firstInputContinuation:firstSend.reference}:{})};
    save(join(operation,'result.json'),result);gate.phase='closed';await releaseWorkspace(plan.workspace,lease,'completed');return result;
  }catch(error){
    save(join(operation,firstSend?'first-input/failure.json':'failure.json'),{reason:error instanceof Error?error.message:'implementation_unknown',originalFilesPreserved:true,automaticRetry:false});throw error;
  }finally{await session?.close();}
}

export function validationCorrectionInput(proof:ValidationFailureProof,request:ImplementationRequest,definition:unknown){
 requireValidationFailure(proof);return 'Explicitly correct the retained implementation within the same adopted scope. This is one new bounded context, not a resume, repeated original input, new task or authority grant. Preserve the original H0 and protected files. Read the frozen validation definition but never edit it. Actually use the registered tools to fix and test the current tree. A lexical check failing does not prove a business requirement should change; never weaken the validator. Return implemented with your complete honest report; only the host can form H1 after passing tests.\n'+canonical({request,candidate:proof.plan.candidate,contract:proof.plan.project.contract,source:projectMaterial(proof.current,proof.plan.project),allowedPaths:request.workspaceRequest.allowedPaths,protectedPaths:proof.plan.project.protectedPaths,originalReport:proof.record.report,failedTests:proof.record.tests,validationDefinition:definition});
}
/** One explicit correction of a proved healthy validation failure. All new
 * artifacts are children; the original initial tree remains the commit base. */
export async function runValidationCorrection(proof:ValidationFailureProof,request:ImplementationRequest,reference:Row,input:string,firstInputContinuation:Row|null,external:ImplementationGate){
 const record=requireValidationFailure(proof),plan=proof.plan as RepairPlan,operation=record.operationRoot,directory=join(operation,'validation-correction'),grant=JSON.parse((await regular(plan.grant)).toString()) as Grant;
 await verifyValidationFiles(record);validateProjectContract(plan.project!,grant);
 if(reference.failureSha256!==hash(canonical(record))||reference.inputSha256!==hash(input)||reference.nativeDirectory!==join(directory,'native')||grant.maxRepairRounds!==1||plan.project?.materialView!=='selected_files')throw new Error('implementation_validation_binding_changed');
 const billing=plan.billing;if(billing?.mode!=='existing_subscription_only'||billing.usageCreditsEnabled!==false||hash(await regular(billing.evidence))!==billing.evidenceSha256||!Number.isFinite(Date.parse(billing.observedAt))||Date.now()-Date.parse(billing.observedAt)>86400000||Date.parse(billing.observedAt)>Date.now()+60000)throw new Error('implementation_billing_unavailable');
 const lease=await acquireWorkspace(plan.workspace,operation,false,grant);let session:BoundedCodexSession|undefined;
 const refresh=async()=>{await external.refresh();await verifyValidationFiles(record);if(await exists(join(operation,'revoked.json')))throw new Error('repair_revoked');};
 const gate=new RepairTools(plan.workspace,directory,grant,lease,plan.nodeExecutable,structuredClone(proof.current),plan.candidate.H,async d=>{const t=await testProject(plan.workspace,d,plan.project!,{refresh,start:effect=>external.check(effect)});if(!t.executionHealthy)throw new Error('project_test_environment_or_capture_failed');return projectModelTestResult(t);},effect=>external.check(effect),refresh,{materialView:'selected_files',materialPaths:[...plan.project!.materialPaths,...plan.project!.protectedPaths]});
 try{
  await mkdir(join(directory,'commit'),{mode:0o700});
  session=await BoundedCodexSession.start({executable:plan.codexExecutable,directory:reference.nativeDirectory,operation,candidate:plan.candidate,role:'implementer',system:proof.manifest.prompt.system,inputManifestSha256:proof.manifest.inputManifestSha256,scopeSource:plan.scopeSource,arrangementSource:'Explicit Issue implementation; one new bounded implementer context; no finding or native resume',disabledMcpServers:plan.disabledMcpServers,allowedInstructionSources:plan.allowedInstructionSources,timeoutMs:plan.timeoutMs,executionKind:plan.executionKind??'native_capture',projectRepair:true,gate,beforeTurn:refresh,beforeSendSync:()=>external.check(),dispatchGate:send=>{external.dispatch();return send();}});
  await gate.handoff(session.sessionId,'new_implementer_context');const report=await session.turn(input,plan.candidate,implementationOutputSchema(plan.candidate.H)),sessionId=session.sessionId,exercised=session.exercisedTools;await session.close();session=undefined;
  const capture=await readRepairSession(reference.nativeDirectory);if(capture.turns.length!==1||canonical(JSON.parse(capture.turns[0]!.final!.text))!==canonical(report))throw new Error('implementation_validation_complete_implemented_required');
  const current=await gate.check(),changed=scopeChanges(proof.initial,current,grant.allowedPaths);
  const testsDirectory=join(directory,'post-repair'),tests=await testProject(plan.workspace,testsDirectory,plan.project!,{refresh,start:effect=>external.check(effect)});
  if(!tests.executionHealthy)throw new Error('project_test_environment_or_capture_failed');
  const common={requestId:request.id,task:request.task,H0:request.workspaceRequest.candidate.H,report,sessionId,completeCapture:true,newNativeContext:true,nativeSessionResumed:false,validationCorrection:reference,...(firstInputContinuation?{firstInputContinuation}:{}),testsDirectory,tests,modelTests:projectModelTestResult(tests),treeSha256:treeHash(current)};
  if(!tests.passed){await readFailedValidationTests(testsDirectory,plan);const result={...common,status:'failed' as const,H1:null};save(join(directory,'result.json'),result);gate.phase='closed';await releaseWorkspace(plan.workspace,lease,'failed');return result;}
  if(report.decision!=='implemented'||!changed.length||!['tongxu_read_file','tongxu_replace_file','tongxu_run_tests'].every(n=>exercised.includes(n)))throw new Error('implementation_actual_change_and_tests_required');
  const calls=await Promise.all((await readdir(join(directory,'calls'))).filter(n=>n.endsWith('.json')).map(async n=>JSON.parse((await regular(join(directory,'calls',n))).toString())));
  if(!calls.some(c=>c.request.tool==='tongxu_run_tests'&&JSON.parse(c.response.contentItems[0].text).passed===true&&JSON.parse(c.response.contentItems[0].text).candidateTreeSha256===treeHash(current)))throw new Error('implementation_agent_did_not_test_current_tree');
  const committed=await commitScopedCandidate(plan.workspace,directory,'commit',1,plan.candidate,current,grant,gate,'implement: correct registered validation for adopted Issue #'+request.issue.number,'tongxu controlled implementation runner');await assertUnselectedGitUnchanged(plan.workspace,request.workspaceRequest.candidate.H,committed.candidate.H,[...plan.project!.materialPaths,...plan.project!.protectedPaths]);
  const result={...common,status:'completed' as const,H1:committed.candidate.H,candidate:committed.candidate,changed,diff:committed.diff,testCandidateBinding:await bindProjectTestToCandidate(plan.workspace,committed.candidate,tests),formalReview:false,published:false,userAccepted:false};save(join(directory,'result.json'),result);gate.phase='closed';await releaseWorkspace(plan.workspace,lease,'completed');return result;
 }catch(e){save(join(directory,'failure.json'),{reason:e instanceof Error?e.message:'implementation_unknown',automaticRetry:false,originalFilesPreserved:true});throw e;}finally{await session?.close();}
}
