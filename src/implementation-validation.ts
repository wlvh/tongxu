import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular,exists,tree,treeHash,scopeChanges,processState,checkRepairIndex,type Tree} from './repair-workspace.js';
import {projectTestPlan,projectModelTestResult} from './project-repair.js';
import {dockerTerminalEvidence,dockerEvidenceMatches} from './docker-sandbox.js';
import {readRepairSession,implementationOutputSchema} from './repair-native.js';
import {implementationCaptureDirectory} from './implementation-first-send.js';
import {fingerprint} from './verification.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {safeEnv,projectRepairToolSpecs} from './repair-workspace.js';
type Row=Record<string,any>;
const exec=promisify(execFile),gitRead=async(w:string,a:string[])=>(await exec('/usr/bin/git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',w,...a],{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'},timeout:15000,maxBuffer:8*1024*1024})).stdout.trim();
const json=async(p:string)=>JSON.parse((await regular(p,32*1024*1024)).toString());
export async function verifyValidationFiles(record:Row){for(const [p,sha] of Object.entries(record.files))if(hash(await regular(p,32*1024*1024))!==sha)throw new Error('implementation_validation_original_changed');}
/** A completed healthy failed test is distinct from a broken/unknown run.
 * This reads original Docker evidence only; it never launches/reconciles. */
export async function readFailedValidationTests(directory:string,plan:Row,requireFailed=true){
 const result=await json(join(directory,'result.json')),input=await json(join(directory,'input.json')),intent=await json(join(directory,'test-intent.json')),progress=await json(join(directory,'test-progress.json')),fixed=await projectTestPlan(plan.project),tested=await tree(join(directory,'material-work'),true),frozen=treeHash(tested);
 if((requireFailed&&result.passed!==false)||typeof result.passed!=='boolean'||result.exit?.code!==(result.passed?0:1)||result.executionHealthy!==true||result.failure!==null||result.candidateTreeSha256!==frozen||input.candidateTreeSha256!==frozen||intent.candidateTreeSha256!==frozen||intent.directory!==directory||intent.workspace!==plan.workspace||intent.kind!=='registered-project-tests-v1'||progress.phase!=='completed'||progress.toolsRequested!==fixed.plan.tools.length||result.tools.length!==fixed.plan.tools.length||[result,input,intent].some(x=>x.testPlanSha256!==plan.project.testPlanSha256)||canonical(input.sourceCandidate)!==canonical(plan.project.sourceCandidate)||result.sourceInput?.sourceHead!==plan.candidate.H||input.H!==result.H||input.T!==result.T||await gitRead(join(directory,'work'),['rev-parse','HEAD'])!==result.H||await gitRead(join(directory,'work'),['rev-parse','HEAD^{tree}'])!==result.T||await fingerprint(join(directory,'work'),Object.keys(tested))!==input.preFingerprint||input.dependencyHash!==plan.project.dependencyHash||canonical(input.protectedPaths)!==canonical(plan.project.protectedPaths))throw new Error('implementation_validation_test_unknown');
 const probeDir=join(directory,'runtime/probe'),probeBytes=await regular(join(probeDir,'execution.json')),probe=JSON.parse(probeBytes.toString());
 if(dockerTerminalEvidence(probeBytes,fixed.plan.executor!,probeDir)!=='ended'||processState(probe.clientPid)!=='ended'||probe.status!=='completed'||probe.exitCode!==0||probe.capture?.complete!==true||hash(await regular(join(probeDir,'stdout')))!==probe.capture.stdoutSha256||hash(await regular(join(probeDir,'stderr')))!==probe.capture.stderrSha256)throw new Error('implementation_validation_test_unknown');
 for(const [i,t] of result.tools.entries()){
  const dir=join(directory,'tool-'+i),raw=await regular(join(dir,'execution.json')),r=JSON.parse(raw.toString()),out=await regular(join(dir,'stdout'),4*1024*1024),err=await regular(join(dir,'stderr'),4*1024*1024);
  if(canonical(r.connection)!==canonical(probe.connection)||processState(r.clientPid)!=='ended'||r.after?.State?.OOMKilled===true||hash(raw)!==t.dockerRecordSha256||hash(out)!==t.stdoutSha256||hash(err)!==t.stderrSha256||t.stdout!==out.toString().slice(0,16000)||t.stderr!==err.toString().slice(0,16000)||!t.inputUnchanged||!t.dependenciesUnchanged||t.sampleSet||canonical(t.registeredSampleIds)!=='[]'||t.id!==fixed.plan.tools[i]!.id||canonical(t.argv)!==canonical(fixed.plan.tools[i]!.argv)||!dockerEvidenceMatches(raw,fixed.plan.executor!,{run:frozen,stage:i,tool:t.id,head:result.H,tree:result.T,planHash:plan.project.testPlanSha256},{...t,dockerExecutionDirectory:'tool-'+i,stdout:{sha256:hash(out),bytes:out.length},stderr:{sha256:hash(err),bytes:err.length}},fixed.plan.tools[i]!.timeoutMs))throw new Error('implementation_validation_test_unknown');
 }
 if(result.passed!==result.tools.every((t:any)=>t.exitCode===0&&t.status==='completed')||result.sourceInput.frozenWorkingTreeSha256!==frozen||result.sourceInput.testedCommit!==result.H||result.sourceInput.testedTree!==result.T||result.sourceInput.sourceHeadTree!==await gitRead(plan.workspace,['rev-parse',plan.candidate.H+'^{tree}']))throw new Error('implementation_validation_test_unknown');
 return {result,tested,controllerPid:intent.controllerPid};
}
async function registeredChildrenEnded(directory:string){
 const launch=await exists(join(directory,'launch.json')),processFile=join(directory,'process.json');
 if(launch){if(await exists(processFile)){if(processState((await json(processFile)).pid)!=='ended')throw new Error('implementation_validation_child_active_or_unknown');}else if(!await exists(join(directory,'blocked-before-spawn.json')))throw new Error('implementation_validation_child_active_or_unknown');}
 for(const e of await readdir(directory,{withFileTypes:true})){if(!e.isDirectory()||['work','material-work','output','workspace'].includes(e.name)||e.name.startsWith('generated-'))continue;await registeredChildrenEnded(join(directory,e.name));}
}
const issued=new WeakMap<object,string>();
export type ValidationFailureProof={record:Row;initial:Tree;current:Tree;plan:Row;manifest:Row;lease:Row};
export function requireValidationFailure(p:ValidationFailureProof){if(issued.get(p)!==hash(canonical(p.record))||treeHash(p.current)!==p.record.treeSha256||treeHash(p.initial)!==p.record.initialTreeSha256)throw new Error('implementation_validation_proof_required');return p.record;}
/** No current workspace/liveness requirement is needed to read a retained
 * failure. Sending is admitted separately, under the original operation lock. */
export async function observeValidationFailure(s:Row):Promise<ValidationFailureProof>{
 const fixed=s.plan,op=fixed.operationRoot,planBytes=await regular(fixed.path),plan=JSON.parse(planBytes.toString()),initial=await json(join(op,'initial-tree.json')),manifest=await json(join(op,'input-manifest.json')),{inputManifestSha256,...original}=manifest;
 if(hash(planBytes)!==fixed.sha256||plan.project?.materialView!=='selected_files'||canonical(manifest.request)!==canonical(fixed.request)||manifest.planSha256!==fixed.sha256||hash(canonical(original))!==inputManifestSha256)throw new Error('implementation_validation_original_changed');
 const grant=await json(plan.grant);if(grant.H!==plan.candidate.H||treeHash(initial)!==grant.treeSha256)throw new Error('implementation_validation_original_changed');
 const native=await implementationCaptureDirectory({...s,result:s.firstInputContinuation?{firstInputContinuation:s.firstInputContinuation}:null}),capture=await readRepairSession(native),report=JSON.parse(capture.turns[0]?.final?.text??'null'),nativeProcess=await json(join(native,'process.json'));
 if(capture.turns.length!==1||capture.binding.role!=='implementer'||capture.binding.run!==op||capture.binding.inputManifestSha256!==inputManifestSha256||report?.decision!=='implemented'||report.candidateH!==plan.candidate.H||processState(nativeProcess.pid)!=='ended')throw new Error('implementation_validation_capture_unknown');
 const inputs=await json(join(native,'inputs.json')),sent=(await regular(join(native,'stdin.ndjson'),16*1024*1024)).toString().trim().split('\n').map(x=>JSON.parse(x)),start=sent.filter(x=>x.method==='thread/start');
 if(inputs.length!==1||canonical(inputs[0].subjectCandidate)!==canonical(plan.candidate)||canonical(inputs[0].schema)!==canonical(implementationOutputSchema(plan.candidate.H))||start.length!==1||start[0].params.baseInstructions!==manifest.prompt.system||canonical(start[0].params.dynamicTools)!==canonical(projectRepairToolSpecs))throw new Error('implementation_validation_capture_unknown');
 if(await exists(join(native,'native-tool-transports.json'))){for(const t of await json(join(native,'native-tool-transports.json'))){if(t.appServerPid!==nativeProcess.pid||!Array.isArray(t.observedHelperPids))throw new Error('implementation_validation_child_active_or_unknown');for(const pid of t.observedHelperPids){if(!Number.isSafeInteger(pid)||pid<=0||(await json(join(native,'tool-host-'+pid,'process.json'))).pid!==pid||processState(pid)!=='ended')throw new Error('implementation_validation_child_active_or_unknown');}}}
 await registeredChildrenEnded(native);await registeredChildrenEnded(join(op,'attempt-1'));
 const tests=await readFailedValidationTests(join(op,'attempt-1/post-repair-1'),plan),changed=scopeChanges(initial,tests.tested,fixed.request.workspaceRequest.allowedPaths);
 if(!changed.length||plan.project.protectedPaths.some((p:string)=>initial[p]?.sha256!==tests.tested[p]?.sha256))throw new Error('implementation_validation_tree_changed');
 const calls:Row[]=[];for(const n of await readdir(join(op,'calls'))){if(!n.endsWith('.json'))throw new Error('implementation_validation_calls_unknown');const path=join(op,'calls',n),c=await json(path);if(!c.response||c.status==='write_registered')throw new Error('implementation_validation_calls_unknown');calls.push(c);}
 const pairs=await json(join(native,'reconciled-tools.json')),expected=structuredClone(initial) as Tree;
 if(calls.length!==pairs.length)throw new Error('implementation_validation_calls_unknown');
 for(const pair of pairs){const c:Row|undefined=calls.find((c:Row)=>c.request.callId===pair.request.params.callId);if(!c||c.request.tool!==pair.request.params.tool||canonical(c.request.arguments)!==canonical(pair.request.params.arguments)||canonical(c.response)!==canonical(pair.response.result))throw new Error('implementation_validation_calls_unknown');
   if(c.request.tool==='tongxu_replace_file'){const p=c.request.arguments.path;if(!fixed.request.workspaceRequest.allowedPaths.includes(p)||c.status!=='applied'||expected[p]?.sha256!==c.beforeSha256||c.request.arguments.expectedSha256!==c.beforeSha256||hash(c.beforeText)!==c.beforeSha256||hash(c.afterText)!==c.afterSha256||c.request.arguments.text!==c.afterText||c.beforeExecutable!==expected[p]?.executable||c.afterExecutable!==expected[p]?.executable)throw new Error('implementation_validation_unregistered_change');expected[p]={...expected[p]!,text:c.afterText,sha256:c.afterSha256,bytes:Buffer.byteLength(c.afterText)};}
   if(c.request.tool==='tongxu_run_tests'){const t=await readFailedValidationTests(join(op,'tests','tool-'+c.request.callId),plan,false);if(treeHash(t.tested)!==treeHash(expected)||canonical(JSON.parse(c.response.contentItems[0].text))!==canonical(projectModelTestResult(t.result)))throw new Error('implementation_validation_calls_unknown');}
   if(c.afterTreeSha256!==treeHash(expected))throw new Error('implementation_validation_unregistered_change');
 }
 if(treeHash(expected)!==treeHash(tests.tested))throw new Error('implementation_validation_unregistered_change');
 if((await readdir(join(op,'attempt-1'))).some(n=>n!=='post-repair-1')||await exists(join(op,'result.json')))throw new Error('implementation_validation_commit_or_result_exists');
 const files:Record<string,string>={};let total=0;async function seal(p:string){for(const e of await readdir(p,{withFileTypes:true})){const path=join(p,e.name);if(e.isSymbolicLink())throw new Error('implementation_validation_unsafe_original');if(e.isDirectory())await seal(path);else{const b=await regular(path,32*1024*1024);if((total+=b.length)>128*1024*1024)throw new Error('implementation_validation_evidence_limit');files[path]=hash(b);}}}
 for(const p of [native,join(op,'calls'),join(op,'attempt-1')])await seal(p);
 const failurePath=s.firstInputContinuation?join(op,'first-input/failure.json'):join(op,'failure.json');if((await json(failurePath)).reason!=='implementation_registered_tests_failed')throw new Error('implementation_validation_failure_reason_unknown');
 for(const p of [failurePath,fixed.path,plan.grant,plan.project.testPlan,join(op,'input-manifest.json'),join(op,'initial-tree.json')])files[p]=hash(await regular(p,32*1024*1024));
 const lease=await exists(join(plan.workspace,'.git/tongxu-writer.json'))?await json(join(plan.workspace,'.git/tongxu-writer.json')):null;
 const record={schemaVersion:1,operationRoot:op,requestSha256:s.requestSha256,planSha256:fixed.sha256,inputManifestSha256,nativeDirectory:native,sessionId:capture.binding.sessionId,report,tests:projectModelTestResult(tests.result),testsDirectory:join(op,'attempt-1/post-repair-1'),initialTreeSha256:treeHash(initial),treeSha256:treeHash(tests.tested),changed,controllerPid:tests.controllerPid,files};
 if(s.validationFailure&&canonical(s.validationFailure)!==canonical(record))throw new Error('implementation_validation_original_changed');
 const proof={record,initial,current:tests.tested,plan,manifest,lease};issued.set(proof,hash(canonical(record)));return proof;
}
export async function readRecordedValidationFailure(s:Row){
 const record=s.validationFailure;if(!record||record.operationRoot!==s.plan.operationRoot||record.requestSha256!==s.requestSha256||record.planSha256!==s.plan.sha256)throw new Error('implementation_validation_original_changed');await verifyValidationFiles(record);
 const native=await implementationCaptureDirectory({...s,result:s.firstInputContinuation?{firstInputContinuation:s.firstInputContinuation}:null}),capture=await readRepairSession(native);if(native!==record.nativeDirectory||capture.turns.length!==1||capture.binding.sessionId!==record.sessionId||canonical(JSON.parse(capture.turns[0]!.final!.text))!==canonical(record.report))throw new Error('implementation_validation_capture_changed');return record;
}
export async function checkValidationWorkspace(p:ValidationFailureProof,ownController=false){
 requireValidationFailure(p);await verifyValidationFiles(p.record);const {plan,record,lease}=p;
 if(await gitRead(plan.workspace,['rev-parse','HEAD'])!==plan.candidate.H||treeHash(await tree(plan.workspace,true))!==record.treeSha256)throw new Error('implementation_validation_tree_changed');
 await checkRepairIndex(plan.workspace,record.operationRoot,p.manifest.request.workspaceRequest.allowedPaths,p.current,{materialView:'selected_files',materialPaths:[...plan.project.materialPaths,...plan.project.protectedPaths]},true);
 if(!lease||lease.operation!==record.operationRoot||lease.status!=='held'||lease.controllerPid!==record.controllerPid||canonical(await json(join(plan.workspace,'.git/tongxu-writer.json')))!==canonical(lease)||processState(lease.controllerPid)!=='ended'&&!(ownController&&lease.controllerPid===process.pid))throw new Error('implementation_validation_writer_active_or_unknown');
}
/** Correction result readers verify both immutable original failure evidence
 * and the unique registered successor capture. */
export async function validationResultCapture(s:Row){
 const ref=s.result?.validationCorrection;if(!ref)return implementationCaptureDirectory(s);
 if(canonical(ref)!==canonical(s.validationCorrection)||!s.validationFailure||ref.failureSha256!==hash(canonical(s.validationFailure))||ref.nativeDirectory!==join(s.plan.operationRoot,'validation-correction/native'))throw new Error('implementation_validation_capture_changed');
 await verifyValidationFiles(s.validationFailure);if(await implementationCaptureDirectory({...s,result:s.firstInputContinuation?{firstInputContinuation:s.firstInputContinuation}:null})!==s.validationFailure.nativeDirectory)throw new Error('implementation_validation_capture_changed');const old=await readRepairSession(s.validationFailure.nativeDirectory);if(old.turns.length!==1||canonical(JSON.parse(old.turns[0]!.final!.text))!==canonical(s.validationFailure.report))throw new Error('implementation_validation_capture_changed');
 const wire=(await regular(join(ref.nativeDirectory,'stdin.ndjson'),16*1024*1024)).toString().trim().split('\n').map(x=>JSON.parse(x)),starts=wire.filter(x=>x.method==='thread/start');
 const inputs=await json(join(ref.nativeDirectory,'inputs.json')),binding=await json(join(ref.nativeDirectory,'binding.json')),manifest=await json(join(s.plan.operationRoot,'input-manifest.json')),plan=await json(s.plan.path);
 if(starts.length!==1||starts[0].params.baseInstructions!==manifest.prompt.system||canonical(starts[0].params.dynamicTools)!==canonical(projectRepairToolSpecs)||inputs.length!==1||hash(inputs[0].input)!==ref.inputSha256||binding.run!==s.plan.operationRoot||binding.role!=='implementer'||binding.inputManifestSha256!==manifest.inputManifestSha256||canonical(inputs[0].schema)!==canonical(implementationOutputSchema(plan.candidate.H))||canonical(inputs[0].subjectCandidate)!==canonical(plan.candidate))throw new Error('implementation_validation_capture_changed');
 return ref.nativeDirectory;
}
