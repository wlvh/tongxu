import {readFormalSource} from './formal-review-material.js';
import {selectedProviderOptions} from './ai-settings.js';
import {readRejectedFormalReview,type BoundedCodexSession} from './repair-native.js';
import type {ExtraCliSession} from './additional-cli.js';
import {checkCapture} from './live-process.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {QueueStore} from './queue-store.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {prepareResourceRequest,resourceAction} from './resource-claims.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';
import type {ActionRequest} from './authority-contract.js';
import type {FormalReviews,FormalStage} from './formal-review-store.js';
import type {DualReviewPrompts} from './formal-dual-review.js';
import type {FormalRoundHost,OwnedFormalFact} from './formal-review.js';
import {readRepairInbox,freezeRepairInbox,formalRepairSupplementPlan,type FormalProjectWork,type ReadRepairInbox,type FormalRepairInboxItem} from './formal-repair-inbox.js';
import type {RepairPlan} from './repair.js';
import {regular,exists,tree,treeHash,git,checkRepairIndex,scopeChanges,acquireWorkspace,releaseWorkspace,RepairTools,commitScopedCandidate,processState,type Grant,type Tree,type Lease} from './repair-workspace.js';
import {prepareProjectRepair,testProject,projectModelTestResult,bindProjectTestToCandidate,reconcileProjectTests,type ProjectRequest,type ProjectContract} from './project-repair.js';
import {readFailedValidationTests} from './implementation-validation.js';
type Row=Record<string,any>;
export type FormalFrozenRequest={kind:'tongxu-formal-pr-review';id:string;entry:string;item:string;round:number;previousOperation:string|null;candidate:FormalStage['candidate'];executionKind:'fixture'|'native_capture';workSha256:string;directory:string;material:FormalRoundHost['material'];config:FormalRoundHost['config'];configRef:{path:string;sha256:string};prompts:{prompts:FormalRoundHost['systems'];promptAssemblies:Row};project:ProjectRequest;authorization:{receive:string;implement:string;test:string};budgets:Array<{phase:'analysis'|'fix'|'candidate';ledgerId:string;resourceRef:string;unit:string;quantity:number}>;aiSelections:Row;workflowReview?:DualReviewPrompts;workbenchProject?:{account:number;repository:number;fullName:string};projectWork?:FormalProjectWork};

/** A host for one original operation. Every native turn, registered test and
 * atomic write passes the same authority/claim/source/stop consumers. */
export class QueueFormalRoundHost implements FormalRoundHost{
 readonly directory:string;readonly round:number;readonly material:FormalRoundHost['material'];readonly config:FormalRoundHost['config'];readonly systems:FormalRoundHost['systems'];readonly aiSelections:Row;
 readonly dual:{gpt?:BoundedCodexSession;kimi?:ExtraCliSession}={};
 private dualFixPeerCheck?:()=>void;
 private observations:OwnerObservation[]=[];private active?:FormalStage;private fact:OwnedFormalFact|null=null;private gate?:RepairTools;private plan?:RepairPlan;private initial?:Tree;private readCalls=0;private readBytes=0;private tests=0;private projectPromise?:Promise<RepairTools>;
 constructor(readonly q:QueueStore,readonly operation:string,readonly request:FormalFrozenRequest,private live:()=>Promise<void>,private accepting:()=>void,round=request.round){this.directory=request.directory;this.round=round;this.material=request.material;this.config=request.config;this.systems=request.prompts.prompts;this.aiSelections=request.aiSelections;}
 private records(){return this.q.formalReviews();}
 ownsDual(){return !!(this.dual.gpt||this.dual.kimi);}
 async closeDual(){
  const {gpt,kimi}=this.dual;
  delete this.dual.gpt;delete this.dual.kimi;
  const closed=await Promise.allSettled([gpt?.close(),kimi?.close()]);
  for(const result of closed)if(result.status==='rejected')throw result.reason;
 }
 retainDual(){
  if(!this.ownsDual()||this.dual.gpt&&!this.dual.gpt.canContinueTurn()||this.dual.kimi&&(this.dual.kimi.rpc.failure||this.dual.kimi.rpc.exit))return false;
  const state=this.records().state(this.operation);
  return !state.stopped&&!state.terminal&&!this.roundStages(state).some(s=>s.dispatched&&!s.returned||s.stage.role==='fix'&&s.dispatched);
 }
 private roundStages(state:ReturnType<ReturnType<QueueStore['formalReviews']>['state']>){
  return (state.stages as ReturnType<FormalReviews['stage']>[]).filter(s=>s.stage.key.startsWith('round-'+this.round+'/'));
 }
 private projectRoot(){return join(this.directory,this.round===this.request.round?'project':'project-round-'+this.round);}
 private async verifyEndedReviewWorkspace(){
  const root=this.projectRoot();
  if(!await exists(root))return null;
  const workspace=join(root,'workspace'),operation=join(root,'operation'),grantPath=join(root,'grant.json');
  const plan=JSON.parse((await regular(join(root,'plan.json'))).toString()) as RepairPlan;
  if(!plan.project||plan.workspace!==workspace||plan.grant!==grantPath||
     plan.candidate.H!==this.request.candidate.H||canonical(plan.project.sourceCandidate)!==canonical(this.request.project.candidate)||
     plan.project.testPlanSha256!==this.request.project.testPlanSha256)throw new Error('formal_dual_replacement_workspace_unresolved');
  const lock=join(workspace,'.git','tongxu-writer.json');
  const lease=await exists(lock)?JSON.parse((await regular(lock)).toString()) as Lease:null;
  if(lease&&(lease.operation!==operation||lease.status!=='held'||processState(lease.controllerPid)!=='ended'))throw new Error('formal_dual_replacement_writer_unresolved');
  await reconcileProjectTests(operation,plan.project);
  const grant=JSON.parse((await regular(grantPath)).toString()) as Grant,current=await tree(workspace,true);
  if(grant.H!==plan.candidate.H||treeHash(current)!==grant.treeSha256||await git(workspace,['rev-parse','HEAD'])!==grant.H)
    throw new Error('formal_dual_replacement_workspace_unresolved');
  await checkRepairIndex(workspace,operation,[],current,undefined,true);
  return {workspace,lease,H:grant.H,treeSha256:grant.treeSha256};
 }
 async replaceEndedDual(){
  await this.refresh();
  let state=this.records().state(this.operation);
  const stages=this.roundStages(state);
  if(!state.request.workflowReview||this.ownsDual()||!stages.some(s=>s.returned)||
     stages.some(s=>s.dispatched&&(!s.returned||s.stage.role==='fix')))throw new Error('formal_dual_replacement_not_verified');
  const ended=[];
  for(const [initial,lane,method] of [
    ['correctness-initial','reviewer','turn/start'],
    ['impact-initial','verifier_impact','session/prompt'],
  ] as const){
    const original=stages.find(s=>s.stage.key==='round-'+this.round+'/'+initial);
    const returned=stages.filter(s=>s.stage.role===lane&&s.returned);
    if(!original){if(returned.length)throw new Error('formal_dual_replacement_capture_changed');continue;}
    const directory=original.stage.directory;
    if(!await exists(directory)){if(returned.length)throw new Error('formal_dual_replacement_capture_changed');continue;}
    await checkCapture(directory);
    const bytes=await regular(join(directory,'process.json')),process=JSON.parse(bytes.toString());
    const exit=await regular(join(directory,'exit.json')),capture=await regular(join(directory,'capture-status.json'));
    if(process.status!=='spawn_attempted'||processState(process.pid)!=='ended'||!Number.isFinite(Date.parse(JSON.parse(exit.toString()).at)))throw new Error('formal_dual_replacement_process_unresolved');
    const stdin=await regular(join(directory,'stdin.ndjson'),24*1024*1024),stdout=await regular(join(directory,'stdout.ndjson'),16*1024*1024);
    if(stdin.toString().split('\n').filter(line=>line&&JSON.parse(line).method===method).length!==returned.length)throw new Error('formal_dual_replacement_dispatch_unresolved');
    for(const stage of returned){
      const originals=stage.returned!.proof.originals;
      for(const [name,wire] of [['process.json',bytes],['stdin.ndjson',stdin],['stdout.ndjson',stdout]] as const){
        const saved=originals[name];
        if(!saved||saved.bytes>wire.length||hash(wire.subarray(0,saved.bytes))!==saved.sha256)throw new Error('formal_dual_replacement_capture_changed');
      }
    }
    ended.push({directory,processSha256:hash(bytes),exitSha256:hash(exit),captureSha256:hash(capture),stdinSha256:hash(stdin),stdoutSha256:hash(stdout)});
  }
  const workspace=await this.verifyEndedReviewWorkspace();
  if(!state.resourcesSettled){
    await this.phaseEnded('analysis',this.round);
    state=this.records().state(this.operation);
  }
  if(!state.resourcesSettled)throw new Error('formal_dual_replacement_resources_unresolved');
  await this.refresh();
  if(workspace?.lease)await releaseWorkspace(workspace.workspace,workspace.lease,'ended_formal_review_replaced',true);
  return this.records().replaceEndedDual(this.operation,this.round,stages.map(s=>s.stage.key),ended,workspace,this.observations);
 }
 private async sources(){const authority=this.q.authority(),{profile}=authority.configuration(),refs=new Map<string,ReturnType<typeof authority.sourceRequests>[number]>();for(const grant of Object.values(this.request.authorization))for(const ref of authority.sourceRequests(grant))refs.set(ref.proposalSha256,ref);const root=join(this.directory,'authority-'+randomUUID());await mkdir(root,{recursive:true,mode:0o700});this.observations=[];for(const ref of refs.values())this.observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,ref.proposalSha256)));}
 async refresh(stage?:FormalStage){
  this.accepting();if(this.records().state(this.operation).stopped)throw new Error('formal_stopped');await this.live();this.records().check(this.operation);if(hash(await regular(this.request.configRef.path))!==this.request.configRef.sha256||canonical(JSON.parse((await regular(this.request.configRef.path)).toString()))!==canonical(this.config))throw new Error('formal_original_executor_config_changed');
  const billing=this.config.billing,age=Date.now()-Date.parse(billing?.observedAt);if(billing?.mode!=='existing_subscription_only'||billing.usageCreditsEnabled!==false||!Number.isFinite(age)||age < -60000||age>86400000||hash(await regular(billing.evidence))!==billing.evidenceSha256)throw new Error('formal_billing_boundary_unavailable');
  for(const ref of this.config.allowedInstructionSources)if(hash(await regular(ref.path))!==ref.sha256)throw new Error('instruction_source_changed');
  await this.sources();this.accepting();this.records().check(this.operation,this.observations);
  if(stage){for(const r of stage.resources){const state=this.q.resources().status(resourceRequestHash(r));if(state.state!=='prepared_not_sent'&&state.state!=='refused')await resourceAction(this.q.directory,resourceRequestHash(r),'lookup','background');}this.records().checkStage(this.operation,stage.key,this.observations);}
 }
 async original(key:string,input:string,system:string){let s;try{s=this.records().stage(this.operation,key);}catch(error){if((error as Error).message==='formal_original_stage_required')return null;throw error;}if(s.stage.inputSha256!==hash(input)||s.stage.systemSha256!==hash(system)||s.stage.materialSha256!==this.material.sha256)throw new Error('formal_original_input_is_fixed');if(s.returned){if(this.request.workflowReview&&s.stage.role==='verifier_impact'&&s.returned.proof.native?.promptBoundaryVerified!==true)throw new Error('formal_original_impact_capture_unbound');return s.returned.proof.native?{...s.returned.proof.native,...(s.stage.role==='verifier_impact'?s.returned.result:{report:s.returned.result})}:s.returned.result;}if(s.dispatched)throw new Error('formal_original_sent_or_unknown_no_resend');return null;}
 private action(phase:'analysis'|'fix',test=false,testPlanSha256=this.request.project.testPlanSha256):ActionRequest{const source=this.records().currentSource(this.request.item),adoption=this.q.authority().forScope(source.context.scope.id,{item:this.request.item,target:this.request.candidate.target}).currentAdoption;if(!adoption)throw new Error('formal_adopted_scope_required');const body=(this.q.authority().inspectRecordedDecision(adoption).proposal as Row).body;
  return {schemaVersion:1,scopeId:source.context.scope.id,scopeVersion:source.context.scope.version,scopeBodySha256:hash(canonical(body)),repository:this.request.candidate.repository,target:this.request.candidate.target,item:this.request.item,candidate:{H:this.request.candidate.H,B:this.request.candidate.B,subjectSha256:null},action:test?'test':phase==='analysis'?'receive':'implement',paths:phase==='analysis'&&!test?[]:test?this.request.project.materialPaths:this.request.project.allowedPaths,resourceRefs:this.request.budgets.filter(b=>b.phase===phase).map(b=>b.resourceRef),formalWorkSha256:this.records().state(this.operation).workSha256,...(test?{payloadSha256:testPlanSha256}:{})};
 }
 private intent(phase:string){return 'fr-'+hash(canonical(this.round===this.request.round?[this.operation,phase]:[this.operation,this.round,phase])).slice(0,48);}
 async prepare(key:string,role:FormalStage['role'],input:string,system:string,phase:'analysis'|'fix'){
  const existing=this.records().state(this.operation).stages.find((s:Row)=>s.stage.key===key);if(existing){if(existing.stage.inputSha256!==hash(input)||existing.stage.systemSha256!==hash(system))throw new Error('formal_original_input_is_fixed');return existing.stage;}
  await this.refresh();const action=this.action(phase),intent=this.intent(phase),authorization=this.request.authorization[phase==='analysis'?'receive':'implement'];this.q.authority().reserveAction(intent,action,'background',authorization,this.observations);
  const resources:ResourceRequest[]=this.request.budgets.filter(b=>b.phase===phase).map(({phase:_phase,...b})=>({schemaVersion:1,...b,repository:action.repository,operation:this.operation,authorityIntent:intent,role:'background',actionSha256:hash(canonical(action))}));
  const stage:FormalStage={key,role,candidate:this.request.candidate,inputSha256:hash(input),systemSha256:hash(system),materialSha256:this.material.sha256,actorRole:'background',directory:join(this.directory,key.replace('/','-')),authorityIntent:intent,budgetIntent:intent,action,authorization,resources};
  this.records().prepareStage(this.operation,stage);
  for(const r of resources){const state=await prepareResourceRequest(this.q.directory,Buffer.from(canonical(r)),'background');if(state.state==='prepared_not_sent')await resourceAction(this.q.directory,state.id,'claim','background');}
  return stage;
 }
 activeStage(){if(!this.active)throw new Error('formal_active_stage_required');return this.active;}
 async repairInbox(read?:ReadRepairInbox){
  const work=this.request.projectWork;if(!work)return [];
  const prior=await readRepairInbox(this.directory,this.round,work);
  if(prior)return prior;
  if(!read)throw new Error('formal_repair_inbox_unavailable');
  return freezeRepairInbox(this.directory,this.round,work,await read(work,this.operation,this.round,this.request.candidate.H,this.request.executionKind));
 }
 async admitRepairRevisions(inbox:FormalRepairInboxItem[]){
  if(!inbox.some(item=>item.revision))return null;
  await this.refresh();
  const plan=await formalRepairSupplementPlan(this.plan!.project!,join(this.projectRoot(),'supplement-tests.json'),inbox);
  if(!plan)throw new Error('formal_repair_supplement_plan_required');
  this.q.authority().reserveAction(this.intent('supplement-validation'),this.action('fix',true,plan.testPlanSha256),
    'background',this.request.authorization.test,this.observations);
  return plan;
 }
 activate(stage:FormalStage){this.active=stage;this.progress(stage.key,{candidate:stage.candidate,role:stage.role});}
 bindDualFixPeer(check:()=>void){this.dualFixPeerCheck=check;}
 submit<T>(stage:FormalStage,effect:()=>T):T{
  this.accepting();
  return this.records().effect(this.operation,stage.key,this.observations,()=>{
   if(this.request.workflowReview&&stage.role==='fix'){
    if(!this.dualFixPeerCheck)throw new Error('formal_dual_terminal_capture_missing');
    this.dualFixPeerCheck();
   }
   return effect();
  },true);
 }
 record(stage:FormalStage,result:Row,proof:Row,originals:Record<string,Buffer>){this.records().returned(this.operation,stage.key,result,proof,originals);}
 async phaseEnded(phase:'analysis'|'fix',endedDualRound?:number){const intent=this.intent(phase);this.records().completeResourcePhase(this.operation,intent,endedDualRound);for(const b of this.request.budgets.filter(b=>b.phase===phase)){const stage=this.records().state(this.operation).stages.find((s:Row)=>s.stage.budgetIntent===intent)!;const resource=stage.stage.resources.find((r:ResourceRequest)=>r.ledgerId===b.ledgerId&&r.resourceRef===b.resourceRef)!;const id=resourceRequestHash(resource);if(!this.q.resources().settledOutcome(id))await resourceAction(this.q.directory,id,'record-result','background');}}
 /** Reconcile only the original closed, read-only first reviewer. No native
  * input, replacement judgment or new authority is created by this cleanup. */
 async settleRejectedReview(){
  const state=this.records().state(this.operation);
  if(state.stages.length!==1||this.fact)return null;
  const original=state.stages[0]!,stage=original.stage;
  if(stage.role!=='reviewer'||stage.key!=='round-'+this.round+'/review'||!original.dispatched||!await exists(join(stage.directory,'native-boundary-failure.json')))return null;
  const boundary=JSON.parse((await regular(join(stage.directory,'native-boundary-failure.json'))).toString());
  if(boundary.stage!=='turn_rejected'||boundary.reason!=='formal_pass_has_unresolved_work')return null;
  if(stage.systemSha256!==hash(this.systems.reviewer)||stage.materialSha256!==this.material.sha256)throw new Error('formal_rejected_original_stage_changed');
  const candidate={kind:'github-pr' as const,repository:stage.candidate.repository,pr:stage.candidate.pr,H:stage.candidate.H,B:stage.candidate.B,target:stage.candidate.target};
  const selection=selectedProviderOptions(this.aiSelections.reviewer,'codex',this.config.codexExecutable);
  const capture=await readRejectedFormalReview(stage.directory,{
   operation:this.directory,candidate,materialSha256:this.material.sha256,
   inputSha256:stage.inputSha256,system:this.systems.reviewer,
   executable:selection.executable,executionKind:this.request.executionKind,
   scopeSource:this.config.scopeSource,aiModel:selection.aiModel,
   allowedInstructionSources:this.config.allowedInstructionSources,
  });
  const planPath=join(this.directory,'project','plan.json');
  let release:{workspace:string;lease:Lease}|undefined;
  if(await exists(planPath)){
   const plan=JSON.parse((await regular(planPath)).toString()) as RepairPlan;
   const operation=join(this.directory,'project','operation');
   if(plan.workspace!==join(this.directory,'project','workspace')||!plan.project)throw new Error('formal_rejected_project_binding_changed');
   await reconcileProjectTests(operation,plan.project);
   const grant=JSON.parse((await regular(plan.grant)).toString()) as Grant;
   if(treeHash(await tree(plan.workspace,true))!==grant.treeSha256||await git(plan.workspace,['rev-parse','HEAD'])!==candidate.H)throw new Error('formal_rejected_review_workspace_changed');
   const lock=join(plan.workspace,'.git','tongxu-writer.json');
   if(await exists(lock)){
    const lease=JSON.parse((await regular(lock)).toString()) as Lease;
    if(lease.operation!==operation||lease.status!=='held')throw new Error('formal_rejected_review_lease_changed');
    release={workspace:plan.workspace,lease};
   }
  }
  const result={report:capture.finalText,protocolRejection:capture.protocolRejection,formalJudgmentAccepted:false};
  this.record(stage,result,{
   role:'reviewer',candidate:stage.candidate,inputSha256:stage.inputSha256,
   systemSha256:stage.systemSha256,completeCapture:true,executionKind:this.request.executionKind,
   native:{sessionId:capture.binding.sessionId,threadId:capture.binding.threadId,wholeProcessCompleted:true,formalJudgmentAccepted:false},
  },capture.originals);
  await this.phaseEnded('analysis');
  if(release){await releaseWorkspace(release.workspace,release.lease,'rejected formal reviewer ended');if(this.gate)this.gate.phase='closed';}
  return this.records().finish(this.operation,{
   status:'needs_evidence',candidate:stage.candidate,reviewKey:stage.key,
   reason:capture.protocolRejection,formalJudgmentAccepted:false,originalExecutionRetained:true,
  });
 }
 ownedFact(){return this.fact;}holdFact(value:OwnedFormalFact){this.fact=value;}releaseFact(){this.fact=null;}
 async reviewGate(){return {check:async()=>{await this.refresh(this.activeStage());},call:async(p:{tool:string;arguments:any;callId:string},beforeRegistration?:()=>void)=>{await this.refresh(this.activeStage());beforeRegistration?.();if(p.tool==='tongxu_run_tests'){const gate=await this.factGate();return gate.call(p,beforeRegistration);}if(p.tool!=='tongxu_read_file'||!p.arguments||Object.keys(p.arguments).join()!=='path'||++this.readCalls>128)throw new Error('formal_readonly_review_tool_required');const result=await readFormalSource(this.request.project.objects,this.request.candidate.H,p.arguments.path);if((this.readBytes+=result.bytes)>4*1024*1024)throw new Error('formal_additional_source_input_limit');this.records().effect(this.operation,this.activeStage().key,this.observations,()=>{beforeRegistration?.();});this.progress('additional_source_read',{stage:this.activeStage().key,path:result.path,H:result.H,object:result.object,sha256:result.sha256,bytes:result.bytes});return {success:true,contentItems:[{type:'inputText',text:canonical(result)}]};}};}
 factGate(){return this.projectPromise??=this.prepareProject();}
 private async prepareProject(){const root=this.projectRoot(),request={...this.request.project,executionRoot:root},path=root+'-request.json';if(!await exists(path))await writeFile(path,canonical(request),{flag:'wx',mode:0o600});else if((await regular(path)).toString()!==canonical(request))throw new Error('formal_project_request_changed');await prepareProjectRepair(this.request.configRef.path,path,root);const plan=JSON.parse((await regular(join(root,'plan.json'))).toString()) as RepairPlan,grant=JSON.parse((await regular(plan.grant)).toString()) as Grant;
  await privateDirectory(join(root,'operation'),true);const lease=await acquireWorkspace(plan.workspace,join(root,'operation'),false,grant);this.plan=plan;
  const current=await tree(plan.workspace,true);this.initial=structuredClone(current);if(treeHash(current)!==grant.treeSha256||await git(plan.workspace,['rev-parse','HEAD'])!==grant.H)throw new Error('formal_project_initial_tree_changed');
  const refresh=async()=>{if(!this.active)throw new Error('formal_active_stage_required');await this.refresh(this.active);},effect=(run?:()=>void)=>{if(!this.active)throw new Error('formal_active_stage_required');this.accepting();return this.records().effect(this.operation,this.active.key,this.observations,run??(()=>{}));};
  this.gate=new RepairTools(plan.workspace,join(root,'operation'),grant,lease,plan.nodeExecutable,current,grant.H,async(directory,checkNative)=>projectModelTestResult(await this.test(directory,checkNative)),effect,refresh);return this.gate;
 }
 private async test(directory:string,beforeRegistration?:()=>void,supplement?:ProjectContract){if(!this.plan||!this.active)throw new Error('formal_project_not_prepared');await this.refresh(this.active);const test=this.action(this.active.action.action==='receive'?'analysis':'fix',true,supplement?.testPlanSha256),intent=supplement?this.intent('supplement-validation'):this.intent('test-'+this.active.key+'-'+(++this.tests));this.q.authority().reserveAction(intent,test,'background',this.request.authorization.test,this.observations);
  const start={refresh:async()=>{await this.refresh(this.active);this.q.authority().refreshReservedAction(intent,this.observations);beforeRegistration?.();},start:(effect:()=>void)=>{this.accepting();beforeRegistration?.();this.q.authority().refreshReservedAction(intent,this.observations);this.records().effect(this.operation,this.active!.key,this.observations,effect);}};
  const result=await testProject(this.plan.workspace,directory,supplement??this.plan.project!,start);if(!result.executionHealthy)throw new Error('project_test_environment_or_capture_failed');this.progress('registered_test',{stage:this.active.key,testPlanSha256:result.testPlanSha256,passed:result.passed,H:result.H,T:result.T});return result;
 }
 async fixAvailable(){try{await this.refresh();this.q.reviewRecords().formalFixAllowed(this.operation);const action=this.action('fix'),test=this.action('fix',true);this.q.authority().reserveAction(this.intent('fix'),action,'background',this.request.authorization.implement,this.observations);this.q.authority().reserveAction(this.intent('fix-test'),test,'background',this.request.authorization.test,this.observations);return {available:true,reason:null};}catch(error){return {available:false,reason:error instanceof Error?error.message:'formal_fix_authority_unavailable'};}}
 async commitFix(report:Row,fact:OwnedFormalFact,supplement:ProjectContract|null=null){if(!this.plan||this.gate!==fact.gate||!this.active||this.active.role!=='fix')throw new Error('formal_same_fact_fix_required');await mkdir(join(fact.gate.operation,'final'),{mode:0o700});const current=await fact.gate.check(),changed=scopeChanges(this.initial!,current,fact.gate.grant.allowedPaths);
  const tested=await this.test(join(fact.gate.operation,'tests','formal-final'));if(!tested.passed)throw new Error('formal_fixed_candidate_tests_failed');
  const directory=join(this.projectRoot(),'supplement-tests');
  const updated=supplement?await this.test(directory,undefined,supplement):null;
  if(updated&&!updated.passed)throw new Error('formal_fixed_supplement_tests_failed');
  const validationPlan=supplement?{workspace:this.plan.workspace,candidate:this.plan.candidate,project:supplement}:null;
  if(updated&&canonical((await readFailedValidationTests(directory,validationPlan!,false)).result)!==canonical(updated))
    throw new Error('formal_fixed_supplement_test_capture_changed');
  const before=this.plan.candidate,fixed=await commitScopedCandidate(this.plan.workspace,fact.gate.operation,'final',this.round,before,current,fact.gate.grant,fact.gate,'fix: resolve verified formal PR findings');if(fixed.candidate.H===before.H)throw new Error('formal_repair_requires_actual_change');const binding=await bindProjectTestToCandidate(this.plan.workspace,fixed.candidate,tested);
  const supplementVerification=updated?{directory,plan:validationPlan,tests:projectModelTestResult(updated),
    binding:await bindProjectTestToCandidate(this.plan.workspace,fixed.candidate,updated)}:null;
  const stages=this.records().state(this.operation).stages,reviewFixRecord={candidate:this.request.candidate,H2:fixed.candidate.H,stages:stages.map((s:Row)=>({key:s.stage.key,role:s.stage.role,result:s.returned?.result??null,inputSha256:s.stage.inputSha256,systemSha256:s.stage.systemSha256,originals:s.returned?.proof.originals??null})),registeredTests:projectModelTestResult(tested),testCandidateBinding:binding,
    ...(supplementVerification?{supplementVerification}:{})},recordSha256=hash(canonical(reviewFixRecord));
  const publicRecord='<!-- tongxu-formal-fix:'+recordSha256+' -->\n### Review / Fix Record\n\nFormal review candidate: `'+this.request.candidate.H+'` on `'+this.request.candidate.B+'` → tested fix: `'+fixed.candidate.H+'`.\n\nOriginal review, whole-batch verification and repair in the original authorized context are retained with record SHA-256 `'+recordSha256+'`. Registered test plan: `'+tested.testPlanSha256+'`; tested tree: `'+tested.T+'`. Full formal review of the published new candidate remains required. No merge or acceptance is granted.\n<!-- /tongxu-formal-fix -->';
  const source=this.material.sourceEvidence as Row|undefined,prBody=source?.records?.find((r:Row)=>r.kind==='pr')?.body?.body??'',proposedPRBody=prBody+'\n\n'+publicRecord;
  const result={reviewFixRecord,recordSha256,publicRecord,proposedPRBody,H0:this.request.candidate.H,H1:fixed.candidate.H,B:this.request.candidate.B,target:this.request.candidate.target,workspace:this.plan.workspace,changedPaths:changed,diff:fixed.diff,report,tested:projectModelTestResult(tested),testCandidateBinding:binding,sessionId:fact.firstSessionId,threadId:fact.firstThreadId,actualPublished:false,nextStep:'Publish the fixed candidate and Review/Fix Record with the existing authorized project delivery path; then check the PR source to start its new full review.'};this.progress('fix_record',result);return result;
 }
 async finish(result:Row){await this.refresh();const out=this.records().finish(this.operation,result);if(this.gate){this.gate.phase='closed';await releaseWorkspace(this.gate.workspace,this.gate.lease,result.status);}return out;}
 progress(phase:string,detail:Row){this.records().progress(this.operation,phase,detail);}
}
