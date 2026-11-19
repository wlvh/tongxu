import {captureImplementationAI} from './implementation-ai.js';
import {readReviewedSupplement,type SupplementReviewInput} from './project-supplement-review.js';
import {selectedProviderOptions} from './ai-settings.js';
import {assertWorkCurrent,assertCurrentAttemptEnded,captureWorkBilling,sealWorkCurrent} from './project-work-current.js';
import {prepareWorkEnvironment,readWorkEnvironment} from './project-work-environment.js';
import {projectValidationConstraint,readableValidationConstraint} from './work-validation-definition.js';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertWorkEnvironmentEnded} from './project-work-environment.js';
import {ProjectWorkStore,type ProjectWorkDraft,type ProjectDevelopment} from './project-work-store.js';
import {prepareWorkProposal,readWorkProposal,checkWorkMaterial,fixedGit,readWorkPreparationDiagnostic,type FixedRepository} from './project-work-preparation.js';
import {applyWorkOwnerProposal,receiveWorkResult,verifyRepositoryPath,ensureWorkCommit,workAuthorityProfile,writeFixed} from './project-work-runtime.js';
import {exactKeys,isAuthorityDigest,type AuthorityProfile,type ScopeBody} from './authority-contract.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exists,regular,processState} from './repair-workspace.js';
import {chatId} from './project-chat-contract.js';
import {QueueStore} from './queue-store.js';
import {parseDockerConfig,type DockerConfig} from './docker-sandbox.js';
import type {RepairConfig} from './repair.js';
import type {ProjectChatScope,SupplementTarget} from './project-chat.js';
import type {IssueImplementationControls,ImplementationEntry} from './issue-implementation-controls.js';
import type {BoundedCodexSession} from './repair-native.js';
type Row=Record<string,any>;
export type ProjectWorkConfiguration={root:string;executor:{path:string;sha256:string};verification:DockerConfig;preparationTimeoutMs?:number;owner:Omit<AuthorityProfile,'repository'|'issue'|'kind'|'schemaVersion'>};
type Issue={number:number;title:string;body:string;url:string;defaultHead?:string|null};
type Job={stop:boolean;promise:Promise<void>;session?:BoundedCodexSession};
const now=()=>new Date().toISOString();
const problem=(e:unknown)=>e instanceof Error&&/^[a-z0-9_:,-]+$/.test(e.message)?e.message:'project_work_preparation_failed';
const sourceFor=(scope:ProjectChatScope,d:ProjectWorkDraft):FixedRepository=>({path:d.preparation!.repositoryPath,H:d.preparation!.H,repository:scope.repository.fullName});
/** Product-owned preparation around the existing implementation consumer.
 * This store has no independent execution queue, authority or model results. */
export class ProjectWork{
  private active=new Map<string,Job>();private receiving=new Map<string,Promise<unknown>>();private accepting=true;
  private constructor(private config:ProjectWorkConfiguration,private store:ProjectWorkStore,private readIssue:(scope:ProjectChatScope,n:number)=>Promise<Issue>,private verify:(scope:ProjectChatScope)=>Promise<void>,private controls:(scope:ProjectChatScope)=>Promise<IssueImplementationControls>){}
  static async open(reference:{path:string;sha256:string},readIssue:(scope:ProjectChatScope,n:number)=>Promise<Issue>,verify:(scope:ProjectChatScope)=>Promise<void>,controls:(scope:ProjectChatScope)=>Promise<IssueImplementationControls>){
    const bytes=await regular(reference.path,128*1024);if(hash(bytes)!==reference.sha256)throw new Error('project_work_configuration_changed');const c=JSON.parse(bytes.toString()) as ProjectWorkConfiguration;
    if(!exactKeys(c,['root','executor','verification','owner',...(c.preparationTimeoutMs!==undefined?['preparationTimeoutMs']:[])])||typeof c.root!=='string'||resolve(c.root)!==c.root||!exactKeys(c.executor,['path','sha256'])||resolve(c.executor.path)!==c.executor.path||!isAuthorityDigest(c.executor.sha256))throw new Error('project_work_configuration_invalid');
    if(c.preparationTimeoutMs!==undefined&&(!Number.isSafeInteger(c.preparationTimeoutMs)||c.preparationTimeoutMs<1000||c.preparationTimeoutMs>900000))throw new Error('project_work_preparation_timeout_invalid');
    c.verification=parseDockerConfig(c.verification);workAuthorityProfile(c.owner,{account:{id:c.owner.ownerId,login:'configuration'},repository:{id:1,nodeId:'configuration',fullName:'local/configuration'}} as ProjectChatScope,1);
    return new ProjectWork(c,await ProjectWorkStore.open(c.root),readIssue,verify,controls);
  }
  supplementReview(input:SupplementReviewInput,executionKind:string){return readReviewedSupplement(this.config.root,input,executionKind);}
  private directory(d:ProjectWorkDraft){return join(this.config.root,'works',d.id,'version-'+d.version);}
  private activeDevelopment(scope:ProjectChatScope){
    const grant=this.store.development(scope);
    return grant?.approval&&Date.parse(grant.expiresAt)>Date.now()?grant:null;
  }
  private developmentScope(grant:ProjectDevelopment){return 'development-'+grant.work+'-v'+grant.version;}
  private async executor(preparation=false){const b=await regular(this.config.executor.path);if(hash(b)!==this.config.executor.sha256)throw new Error('project_work_executor_changed');const config=JSON.parse(b.toString()) as RepairConfig;return preparation&&this.config.preparationTimeoutMs!==undefined?{...config,timeoutMs:this.config.preparationTimeoutMs}:config;}
  async emptyCatalog(){const path=join(this.config.root,'empty-implementation-catalog.json'),bytes=canonical({schemaVersion:1,kind:'tongxu-issue-implementation-catalog',entries:[]});await writeFixed(path,bytes);return {path,sha256:hash(bytes)};}
  catalogs(scope:ProjectChatScope){return this.store.list(scope).flatMap(d=>[...(d as Row).prior??[],d].flatMap(v=>v.catalog?[v.catalog]:[])) as Array<{path:string;sha256:string}>;}
  currentSources(scope:ProjectChatScope){return new Set(this.store.list(scope).flatMap(d=>d.source&&!d.stopRequested?[d.source]:[]));}
  private save(scope:ProjectChatScope,d:ProjectWorkDraft,kind:string,detail:string){d.events.push({at:now(),kind,detail});if(d.events.length>256)throw new Error('project_work_history_limit');return this.store.save(scope,d,d.revision);}
  async settings(scope:ProjectChatScope,body:unknown){
    if(!exactKeys(body,['repositoryPath'])||typeof (body as Row).repositoryPath!=='string'||(body as Row).repositoryPath.length>4096||(body as Row).repositoryPath.includes('\0'))throw new Error('project_work_settings_invalid');await this.verify(scope);
    try{const repositoryPath=await verifyRepositoryPath(scope,(body as Row).repositoryPath);this.store.setSettings(scope,{repositoryPath,verified:true,problem:null});return {repositoryPath,saved:true};}
    catch(e){this.store.setSettings(scope,{repositoryPath:(body as Row).repositoryPath,verified:false,problem:problem(e)});throw e;}
  }
  recordActionProblem(scope:ProjectChatScope,id:string,version:number,value:string|null){const d=this.store.get(scope,id);if(d.version!==version)return;this.save(scope,{...d,problem:value},value?'action_failed':'owner_confirmation_requested',value??'Local Owner window requested; not an approval');}
  async create(scope:ProjectChatScope,b:Row){
    if(!exactKeys(b,['requestId','conversationId','issueNumber','goal','newWork'])||!chatId(b.requestId)||!chatId(b.conversationId)||!Number.isSafeInteger(b.issueNumber)||b.issueNumber<1||typeof b.goal!=='string'||b.goal.length>2048||b.goal.includes('\0')||typeof b.newWork!=='boolean')throw new Error('project_work_draft_invalid');await this.verify(scope);
    try{const old=this.store.get(scope,b.requestId);if(old.issue.number!==b.issueNumber||old.conversationId!==b.conversationId||old.goal!==b.goal)throw new Error('project_work_id_is_fixed');return old;}catch(e){if((e as Error).message!=='project_work_outside_project')throw e;}
    if(!b.newWork){const previous=this.store.list(scope).find(d=>d.issue.number===b.issueNumber);if(previous)return previous;}
    let issue:Issue={number:b.issueNumber,title:'Issue #'+b.issueNumber,body:'',url:`https://github.com/${scope.repository.fullName}/issues/${b.issueNumber}`},failure:string|null=null;
    try{issue=await this.readIssue(scope,b.issueNumber);}catch(e){failure=problem(e);}
    const at=now();return this.store.create(scope,{id:b.requestId,conversationId:b.conversationId,issue:{...issue,bodySha256:hash(issue.body)},goal:b.goal,createdAt:at,updatedAt:at,revision:0,version:0,requestId:randomUUID(),stage:failure?'needs_input':'draft',problem:failure,events:[{at,kind:'draft_saved',detail:'Saved without model input or implementation'}]},!b.newWork);
  }
  private async recover(scope:ProjectChatScope,d:ProjectWorkDraft){
    if(d.stage!=='preparing'||this.active.has(d.id))return d;
    const prepared=d.preparation as Row|undefined;if(!prepared)return this.save(scope,{...d,stage:'needs_input',problem:'project_work_preparation_interrupted'},'preparation_interrupted','No native preparation was registered');
    try{
      const result=await readWorkProposal(prepared.directory,sourceFor(scope,d));return this.save(scope,{...d,preparation:{...d.preparation!,...result},stage:result.ready?'prepared':'needs_input',problem:result.ready?null:result.validationProblem??'project_work_requirements_need_clarification'},'preparation_recovered','Read original complete preparation; no new model input');
    }catch{}
    if(processState(prepared.pid)!=='ended')return {...d,problem:'project_work_preparation_active_or_unknown'};
    const native=join(prepared.directory,'native');
    if(await exists(native)&&!await exists(join(native,'exit.json')))return {...d,problem:'project_work_preparation_active_or_unknown'};
    return this.save(scope,{...d,stage:'needs_input',problem:'project_work_preparation_interrupted'},'preparation_interrupted','Original incomplete preparation retained; a new version requires an explicit action');
  }
  async state(scope:ProjectChatScope){
    const works=[];for(const d of this.store.list(scope))works.push(await this.recover(scope,d));
    const entries=works.some(d=>d.catalog)?await(await this.controls(scope)).state():[];
    const development=this.activeDevelopment(scope);
    return {available:true,settings:this.store.settings(scope),development:development&&{issue:development.issue,expiresAt:development.expiresAt},works:works.map(d=>({id:d.id,issue:{number:d.issue.number,title:d.issue.title,url:d.issue.url},conversationId:d.conversationId,version:d.version,stage:d.stage,problem:d.problem,hasImplementation:!!d.catalog,stopRequested:!!d.stopRequested,delivery:d.delivery,createdAt:d.createdAt,updatedAt:d.updatedAt,active:this.active.has(d.id),execution:entries.find(e=>e.id===d.source)?.requests.find((r:Row)=>r.id===d.requestId)??null})),supported:'Registered Docker Node validation; separate result branch; no automatic merge',newModelInputs:0};
  }
  async detail(scope:ProjectChatScope,id:string){
    const draft=await this.recover(scope,this.store.get(scope,id));const result=draft.catalog?await this.implementationState(scope,draft):null;
    const diagnostic=async(d:ProjectWorkDraft)=>d.preparation&&!d.preparation.proposal?readWorkPreparationDiagnostic(d.preparation.directory,sourceFor(scope,d)):null;
    let validationProblem:string|null=null;if(draft.preparation?.proposal&&!draft.catalog){try{validationProblem=(await readWorkProposal(draft.preparation.directory,sourceFor(scope,draft))).validationProblem??null;}catch{}}
    const history=[];for(const previous of draft.prior??[]){const old={...draft,...previous};history.push({version:previous.version,delivery:previous.delivery,execution:previous.catalog?await this.implementationState(scope,old):null,preparationDiagnostic:await diagnostic(old)});}
    return {draft,execution:result,history,validationProblem,preparationDiagnostic:await diagnostic(draft),validationFailure:draft.catalog&&draft.source?await(await this.controls(scope)).validationState(draft.source,draft.requestId):null,firstInputContinuation:draft.catalog&&draft.source?await(await this.controls(scope)).firstInputContinuation(draft.source,draft.requestId):null,newModelInputs:0};
  }
  private job(scope:ProjectChatScope,id:string,action:(job:Job)=>Promise<void>){
    if(!this.accepting)throw new Error('project_work_closing');if(this.active.has(id))return {id,active:true,duplicate:true};
    const job:Job={stop:false,promise:Promise.resolve()};this.active.set(id,job);
    job.promise=action(job).catch(e=>{const d=this.store.get(scope,id);this.save(scope,{...d,stage:d.catalog?'execution':d.stage==='authorizing'?'authorizing':'needs_input',problem:problem(e)},'action_failed',problem(e));}).finally(()=>this.active.delete(id));
    return {id,active:true,registrationIsNotExecution:true};
  }
  async prepare(scope:ProjectChatScope,id:string,b:Row){
    if(!exactKeys(b,['goal'])||typeof b.goal!=='string'||b.goal.length>2048||b.goal.includes('\0'))throw new Error('project_work_goal_invalid');const current=await this.recover(scope,this.store.get(scope,id));
    if(current.stage==='authorizing'&&!current.stopRequested)throw new Error('project_work_owner_source_unknown');if(current.restart)throw new Error('project_work_restart_requires_current_check');
    if(current.stage==='preparing')return {id,active:!!this.active.get(id),originalRetained:true};
    return this.job(scope,id,async job=>{
      let d=this.store.get(scope,id);d=this.save(scope,{...d,...(d.version===0&&!d.preparation&&!d.catalog?{goal:b.goal}:{draftGoal:b.goal})},'preparation_goal_saved','Explicit draft input retained before checking conditions; fixed version goal stays unchanged');const setting=this.store.settings(scope);if(!setting)throw new Error('project_work_repository_location_required');await this.verify(scope);
      if(setting.verified===false)throw new Error(setting.problem??'project_work_repository_location_required');
      if(d.catalog){
        const controls=await this.controls(scope),entry=(await controls.state()).find(x=>x.id===d.source);
        if(entry?.requests.some((r:Row)=>r.controllerActive||r.phase==='active_or_unknown'||r.phase==='validation_failed'))throw new Error('project_work_original_active_or_unknown');
        for(const r of entry?.requests??[])if(['registered','prepared'].includes(r.phase))await controls.cancel(d.source!,r.id);
        if(d.delivery?.status==='pending')throw new Error('project_work_previous_result_not_received');
      }
      if(d.preparation&&await exists(join(d.preparation.directory,'environment')))await assertWorkEnvironmentEnded(join(d.preparation.directory,'environment'),d.preparation.verification??this.config.verification);
      const issue=await this.readIssue(scope,d.issue.number),repositoryPath=await verifyRepositoryPath(scope,setting.repositoryPath),H=issue.defaultHead===undefined?scope.repository.defaultHead:issue.defaultHead;
      if(!H||!/^[a-f0-9]{40}$/.test(H))throw new Error('project_work_repository_commit_required');
      const source:FixedRepository={path:repositoryPath,H,repository:scope.repository.fullName};
      await ensureWorkCommit(source,workAuthorityProfile(this.config.owner,scope,d.issue.number));if(job.stop||!this.accepting)throw new Error('project_work_preparation_stopped');
      const version=d.version+1,directory=join(this.config.root,'works',d.id,'version-'+version,'preparation');await mkdir(join(directory,'..'),{recursive:true,mode:0o700});
      const prior=d.version?[...(d.prior??[]),{version:d.version,requestId:d.requestId,source:d.source,catalog:d.catalog,preparation:d.preparation,delivery:d.delivery}]:d.prior;
      if((prior?.length??0)>32)throw new Error('project_work_history_limit');
      // Only the immediately preceding version obtained through this scoped
      // store may contribute data. Never search older works or caller paths.
      const previous=!d.catalog&&d.preparation?.directory===join(this.directory(d),'preparation')?{directory:d.preparation.directory,source:{path:d.preparation.repositoryPath,H:d.preparation.H,repository:scope.repository.fullName},issue:{number:d.issue.number,bodySha256:d.issue.bodySha256},goal:d.goal}:undefined;
      d=this.save(scope,{...d,prior,catalog:undefined,source:undefined,delivery:undefined,currentCheck:undefined,checking:undefined,stopRequested:false,projectDevelopment:undefined,goal:b.goal,draftGoal:undefined,issue:{...issue,bodySha256:hash(issue.body)},version,requestId:randomUUID(),stage:'preparing',problem:null,preparation:{directory,H,repositoryPath,verification:this.config.verification,inputSha256:'',pid:process.pid,observedAt:now()}},'preparation_started','Explicit read-only engineering preparation');
      const result=await prepareWorkProposal({source,issue:d.issue,goal:d.goal,directory,config:await this.executor(true),verification:this.config.verification,previous,check:()=>this.verify(scope),stopped:()=>job.stop||!this.accepting,onSession:s=>{job.session=s;}});
      if(job.stop||!this.accepting)throw new Error('project_work_preparation_stopped');d=this.store.get(scope,id);
      this.save(scope,{...d,preparation:{...d.preparation!,...result},stage:result.ready?'prepared':'needs_input',problem:result.ready?null:result.validationProblem??'project_work_requirements_need_clarification'},'preparation_completed','Proposal only; no implementation or authority granted');
    });
  }
  async continueFirstInput(scope:ProjectChatScope,id:string){const d=this.store.get(scope,id);if(!d.catalog||!d.source||d.stopRequested)throw new Error('project_work_original_not_registered');await this.verify(scope);return(await this.controls(scope)).continueFirstInput(d.source,d.requestId);}
  private currentBinding(d:ProjectWorkDraft){
    const restart=d.restart&&d.version===d.restart.successor.version&&d.requestId===d.restart.successor.requestId?d.restart:undefined;
    return {work:d.id,version:d.version,requestId:d.requestId,proposalSha256:hash(canonical(d.preparation!.proposal)),preparationDirectory:d.preparation!.directory,preparationCaptureSha256:d.preparation!.captureSha256,preparationInputSha256:d.preparation!.inputSha256,issueBodySha256:d.issue.bodySha256,H:d.preparation!.H,configurationSha256:hash(canonical(this.config.verification)),executorSha256:this.config.executor.sha256,implementationAI:d.checking?.implementationAI??null,queueDirectory:join(this.directory(d),'queue'),restartSha256:restart?hash(canonical(restart)):null,predecessor:restart?{...restart.predecessor,store:join(this.config.root,'works',d.id,'version-'+restart.predecessor.version,'queue')}:null,metadataDirectory:join(d.checking!.directory,'billing')};
  }
  private currentGate(scope:ProjectChatScope,d:ProjectWorkDraft,allowExpired=false){const current=this.store.get(scope,d.id);if(!this.accepting||current.stopRequested)throw new Error('project_work_stopped');if(current.version!==d.version||current.requestId!==d.requestId||canonical(current.issue)!==canonical(d.issue)||canonical(current.preparation)!==canonical(d.preparation)||canonical(current.checking)!==canonical(d.checking)||canonical(current.restart)!==canonical(d.restart))throw new Error('project_work_preparation_changed');if(d.currentCheck){if(canonical(current.currentCheck)!==canonical(d.currentCheck))throw new Error('project_work_current_check_changed');assertWorkCurrent(d.currentCheck,this.currentBinding(d),allowExpired);}}
  private async unchanged(scope:ProjectChatScope,d:ProjectWorkDraft,allowExpired=false){
    this.currentGate(scope,d,allowExpired);await this.verify(scope);if(d.draftGoal!=null&&d.draftGoal!==d.goal)throw new Error('project_work_goal_changed_prepare_again');
    const p=await readWorkProposal(d.preparation!.directory,sourceFor(scope,d)),issue=await this.readIssue(scope,d.issue.number),H=issue.defaultHead===undefined?scope.repository.defaultHead:issue.defaultHead;
    if(!p.ready||canonical(p.proposal)!==canonical(d.preparation!.proposal)||hash(issue.body)!==d.issue.bodySha256||H!==d.preparation!.H)throw new Error('project_work_source_changed_prepare_again');
    if(p.validationEnvironment&&p.validationEnvironment.configurationSha256!==hash(canonical(this.config.verification)))throw new Error('project_work_environment_changed_prepare_again');
    await verifyRepositoryPath(scope,d.preparation!.repositoryPath);await this.executor();this.currentGate(scope,d,allowExpired);
  }
  private async buildCurrent(scope:ProjectChatScope,id:string){
    let d=this.store.get(scope,id);if(d.currentCheck){await this.unchanged(scope,d);return d.stage==='needs_input'?this.save(scope,{...d,stage:'prepared',problem:null},'current_check_recovered','Original current check retained; no new observation or model'):d;}
    await this.unchanged(scope,d);
    if(!d.checking){const selected=captureImplementationAI(scope.repository.fullName);d=this.save(scope,{...d,checking:{directory:join(this.directory(d),'current-'+randomUUID()),...(selected?{implementationAI:selected}:{})}},'current_check_started','Explicit host recheck; no preparation model or historical timestamp changes');}
    const directory=d.checking!.directory,binding=this.currentBinding(d),path=join(directory,'check.json');await mkdir(directory,{recursive:true,mode:0o700});
    if(await exists(path)){const ref={path,sha256:hash(await regular(path))};assertWorkCurrent(ref,binding);return this.save(scope,{...d,currentCheck:ref,stage:'prepared',problem:null},'current_check_recovered','Read original complete current check; no new metadata or model input');}
    const template=await this.executor(),config={...template,codexExecutable:selectedProviderOptions(d.checking?.implementationAI?.roles.implementer,'codex',template.codexExecutable).executable},billingDirectory=join(directory,'billing');
    // A partial metadata capture is retained, never silently replaced.
    const billing=await captureWorkBilling(config,billingDirectory,()=>this.currentGate(scope,d));
    const T=(await fixedGit(sourceFor(scope,d),['rev-parse',d.preparation!.H+'^{tree}'])).toString().trim(),environment=join(directory,'environment');
    if(await exists(join(environment,'observation.json')))await readWorkEnvironment(environment,d.preparation!.H,T);
    else await prepareWorkEnvironment(this.config.verification,environment,d.preparation!.H,T,{start:effect=>{this.currentGate(scope,d);effect();}});
    await this.unchanged(scope,d);const predecessorFiles=d.restart?await(await this.controls(scope)).failureRestartFiles(d.restart.predecessor.source,d.restart.predecessor.requestId,d.restart.predecessor):[];
    const ref=await sealWorkCurrent(path,binding,billing.observedAt,Math.min(this.config.owner.maxGrantDurationMs,86400000),[billingDirectory,environment,join(d.preparation!.directory,'native')],[join(d.preparation!.directory,'input.json'),this.config.executor.path,...predecessorFiles]);
    this.currentGate(scope,d);d=this.store.get(scope,id);return this.save(scope,{...d,currentCheck:ref,stage:'prepared',problem:null},'current_check_completed','Exact old proposal rechecked against current source/environment and official metadata; no preparation model input');
  }
  async recheck(scope:ProjectChatScope,id:string){return this.job(scope,id,async()=>{let d=this.store.get(scope,id);if(d.catalog||!d.preparation?.proposal||d.stopRequested)throw new Error('project_work_recheck_unavailable');if(d.stage==='authorizing')throw new Error('project_work_authorizing_current_check_fixed');if(!d.currentCheck&&d.checking&&await exists(join(d.checking.directory,'check.json'))){const ref={path:join(d.checking.directory,'check.json'),sha256:hash(await regular(join(d.checking.directory,'check.json')))};assertWorkCurrent(ref,this.currentBinding(d),true);d=this.save(scope,{...d,currentCheck:ref},'current_check_recovered','Recover exact finished check before explicit recheck');}if(d.currentCheck){const value=assertWorkCurrent(d.currentCheck,this.currentBinding(d),true);let fresh=Date.parse(value.expiresAt)<=Date.now()||canonical(d.checking?.implementationAI??null)!==canonical(captureImplementationAI(scope.repository.fullName)??null);if(!fresh){try{assertWorkCurrent(d.currentCheck,this.currentBinding(d));}catch(e){if((e as Error).message!=='external_executable_changed_during_operation')throw e;fresh=true;}}if(fresh)d=this.save(scope,{...d,currentCheck:undefined,checking:undefined},'current_check_expired','Explicit fresh check; prior immutable evidence '+d.currentCheck.sha256+' retained');}else if(d.checking&&!await exists(join(d.checking.directory,'check.json'))){await assertCurrentAttemptEnded(d.checking.directory,this.config.verification);d=this.save(scope,{...d,checking:undefined},'current_check_ended','Previous read-only attempt known ended; retained at '+d.checking.directory);}await this.buildCurrent(scope,id);});}
  async restartFailure(scope:ProjectChatScope,id:string){
    return this.job(scope,id,async()=>{
      let d=this.store.get(scope,id);if(d.stopRequested)throw new Error('project_work_stopped');
      if(d.restart){const {predecessor:p,successor:s}=d.restart,last=d.prior?.at(-1);if(!chatId(s.requestId)||s.version!==p.version+1||p.source!=='work-'+d.id+'-v'+p.version||!(d.version===p.version&&d.source===p.source&&d.requestId===p.requestId||d.version===s.version&&d.requestId===s.requestId&&last?.version===p.version&&last.source===p.source&&last.requestId===p.requestId))throw new Error('project_work_restart_predecessor_changed');}
      if(d.restart&&d.version===d.restart.successor.version){if(d.catalog){await(await this.controls(scope)).settleClosedFailure(d.source!,d.requestId);return;}await this.buildCurrent(scope,id);return;}
      if(!d.catalog||!d.source||!d.preparation?.proposal)throw new Error('project_work_original_not_registered');await this.unchanged(scope,d,true);const controls=await this.controls(scope);
      if(!d.restart){const info=await controls.failureRestartInfo(d.source,d.requestId);d=this.save(scope,{...d,restart:{predecessor:{...info,version:d.version,source:d.source,requestId:d.requestId},successor:{version:d.version+1,requestId:randomUUID()}}},'failure_restart_requested','Explicitly settle strictly proved ended failure and redo once from original H0; original WIP retained, not transferred');}
      const intent=d.restart!,guard=()=>this.currentGate(scope,d,true);await controls.closeKnownFailure(intent.predecessor.source,intent.predecessor.requestId,intent.predecessor,guard);guard();
      const prior=[...(d.prior??[]),{version:d.version,requestId:d.requestId,source:d.source,catalog:d.catalog,preparation:d.preparation,delivery:d.delivery}];if(prior.length>32)throw new Error('project_work_history_limit');
      d=this.save(scope,{...d,prior,version:intent.successor.version,requestId:intent.successor.requestId,catalog:undefined,source:undefined,delivery:undefined,currentCheck:undefined,checking:undefined,stage:'prepared',problem:null},'failed_work_successor_prepared','Original failed/H1=null and own release verified; same work new version starts clean H0, one initial context and zero further corrections');
      await this.buildCurrent(scope,id);
    });
  }
  async validationConfirmation(scope:ProjectChatScope,id:string){const d=this.store.get(scope,id);if(!d.catalog||!d.source||d.stopRequested)throw new Error('project_work_original_not_registered');await this.verify(scope);const p=await(await this.controls(scope)).definitionConsentPreview(d.source,d.requestId);if(p.alreadyAuthorized)return {alreadyAuthorized:true};
    const profile=workAuthorityProfile(this.config.owner,scope,d.issue.number),expiresAt=Date.parse(d.preparation!.observedAt!)+Math.min(profile.maxGrantDurationMs,86400000);if(expiresAt<=Date.now())throw new Error('project_work_source_changed_prepare_again');return {materialOnly:true,version:d.version,proposalSha256:p.proposalSha256,project:scope.repository.fullName,issue:'#'+d.issue.number+' '+d.issue.title,goal:d.preparation!.proposal!.goal,originalGoal:d.goal,acceptance:d.preparation!.proposal!.acceptance,allowedPaths:d.preparation!.proposal!.allowedPaths,validation:p.definition!.description,readableDefinition:{script:p.definition!.script,sha256:p.definition!.scriptSha256,notice:'仅同意把这份原冻结验收定义只读提供给原实施者；原目标、执行权限、路径与到期不变。'},expiresAt:new Date(expiresAt).toISOString(),identity:profile.sharedAccountApproval?'同一 GitHub 账号；未证明实际操作人与执行者分离':'已有指定本人来源'};
  }
  async correctValidation(scope:ProjectChatScope,id:string){const d=this.store.get(scope,id);if(!d.catalog||!d.source||d.stopRequested)throw new Error('project_work_original_not_registered');return(await this.controls(scope)).correctValidation(d.source,d.requestId);}
  async approveValidationMaterial(scope:ProjectChatScope,id:string,payload:{version:number;proposalSha256:string}){
    const d=this.store.get(scope,id);if(d.version!==payload.version||d.stopRequested||!d.source)throw new Error('project_work_preparation_changed');const controls=await this.controls(scope),preview=await controls.definitionConsentPreview(d.source,d.requestId);if(!preview.alreadyAuthorized){if(preview.proposalSha256!==payload.proposalSha256)throw new Error('work_validation_material_consent_changed');
      const {store,profile}=await this.initializeQueue(this.directory(d),d.issue.number,scope,1),q=await QueueStore.open(store);let proposal,requestId;try{const prepared=q.authority().proposal(payload.proposalSha256);proposal=prepared.proposal;requestId=prepared.requestId;}finally{q.close();}if(proposal.kind!=='accept_baseline')throw new Error('work_validation_material_consent_changed');
      const beforePost=()=>{const current=this.store.get(scope,id);if(!this.accepting||current.stopRequested||current.version!==d.version||current.requestId!==d.requestId)throw new Error('project_work_stopped');};
      await applyWorkOwnerProposal(store,profile,proposal,requestId!,join(this.directory(d),'validation-material-owner'),beforePost);await controls.recordDefinitionConsent(d.source,d.requestId,payload.proposalSha256);
    }return this.correctValidation(scope,id);
  }
  async stop(scope:ProjectChatScope,id:string){let d=this.store.get(scope,id);d=this.save(scope,{...d,stopRequested:true,problem:'project_work_stopped'},'stop_requested','Stop original work and all later actions; preserve original records');const job=this.active.get(id);if(job){job.stop=true;await job.session?.close();}d=this.store.get(scope,id);if(d.source&&d.catalog)await(await this.controls(scope)).stopWorkFamily(d.source,d.requestId);return {id,stopRequested:true,originalRetained:true};}
  async stopSelected(account:number,repository:number,id:string){return this.stop(this.store.cleanupScope(account,repository,id),id);}
  private async initializeQueue(directory:string,issue:number,scope:ProjectChatScope,seats:number){
    await mkdir(directory,{recursive:true,mode:0o700});
    const store=join(directory,'queue'),profile=workAuthorityProfile(this.config.owner,scope,issue);if(profile.executorId!==scope.account.id)throw new Error('project_work_owner_identity_not_configured');
    const q=await exists(join(store,'queue.sqlite'))?await QueueStore.open(store):await QueueStore.create(store,scope.repository.fullName,seats);
    try{q.enableReceiver();q.enableSupplements();q.reviewRecords().enable();q.enableCompositions();q.enableReceiverCorrections();q.enableTasks();q.authority().configure(Buffer.from(canonical(profile)));}finally{q.close();}
    return {store,profile};
  }
  async confirmation(scope:ProjectChatScope,id:string,b:Row){
    if(!exactKeys(b,['version','proposalSha256',...(b.projectDevelopment===true?['projectDevelopment']:[])])||!Number.isSafeInteger(b.version)||!isAuthorityDigest(b.proposalSha256))throw new Error('project_work_confirmation_invalid');
    const d=this.store.get(scope,id);if(d.stopRequested)throw new Error('project_work_stopped');if(b.projectDevelopment===true&&d.restart)throw new Error('project_development_restart_requires_original_scope');if(d.stage==='authorizing'&&!!d.projectDevelopment!==(b.projectDevelopment===true))throw new Error('project_work_authorization_mode_changed');if(d.version!==b.version||!d.preparation?.proposal||hash(canonical(d.preparation.proposal))!==b.proposalSha256)throw new Error('project_work_preparation_changed');
    if(this.active.has(id))return {active:true,alreadyAuthorized:undefined,currentCheckSha256:undefined};if(d.catalog)return {active:undefined,alreadyAuthorized:true,currentCheckSha256:d.currentCheck?.sha256};
    await this.verify(scope);if(!d.currentCheck)captureImplementationAI(scope.repository.fullName);const verified=await readWorkProposal(d.preparation.directory,sourceFor(scope,d)),issue=await this.readIssue(scope,d.issue.number),head=issue.defaultHead===undefined?scope.repository.defaultHead:issue.defaultHead;
    if(verified.validationProblem)throw new Error(verified.validationProblem);
    if(verified.validationEnvironment&&verified.validationEnvironment.configurationSha256!==hash(canonical(this.config.verification)))throw new Error('project_work_environment_changed_prepare_again');
    if(!verified.ready||hash(issue.body)!==d.issue.bodySha256||head!==d.preparation.H)throw new Error('project_work_source_changed_prepare_again');
    const profile=workAuthorityProfile(this.config.owner,scope,d.issue.number);if(profile.executorId!==scope.account.id)throw new Error('project_work_owner_identity_not_configured');
    const current=d.currentCheck?assertWorkCurrent(d.currentCheck,this.currentBinding(d)):null,expiresAt=current?Date.parse(current.expiresAt):Date.parse(d.preparation.observedAt!)+Math.min(profile.maxGrantDurationMs,86400000);if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new Error('project_work_preparation_expired_recheck');
    return {active:undefined,alreadyAuthorized:b.projectDevelopment===true&&!!this.activeDevelopment(scope),projectDevelopment:b.projectDevelopment===true,currentCheckSha256:d.currentCheck?.sha256,...(current?{implementationModel:current.binding.implementationAI?['Codex',current.binding.implementationAI.roles.implementer.model,current.binding.implementationAI.roles.implementer.effort??'程序默认强度'].join(' / ')+'（本次核对已固定）':'Codex CLI 默认模型与强度（实际发送时回报）'}:{}),...(d.restart?{restartNotice:'原失败已结清，原改动和报告保留；从原代码起点（H0）在同一工作新版本重做一次，不迁移旧改动，不再增加修正。'}:{}),expiresAt:new Date(expiresAt).toISOString(),project:scope.repository.fullName,issue:'#'+d.issue.number+' '+d.issue.title,goal:verified.proposal.goal,originalGoal:d.goal,acceptance:verified.proposal.acceptance,allowedPaths:verified.proposal.allowedPaths,validation:verified.proposal.validation.description,readableDefinition:{script:verified.proposal.validation.script,sha256:hash(verified.proposal.validation.script),notice:'同意后，这份准确验收定义会只读提供给原工作实施者；定义和测试计划不可修改。'},identity:profile.sharedAccountApproval?'同一 GitHub 账号；未证明实际操作人与执行者分离':'已有指定本人来源'};
  }
  async start(scope:ProjectChatScope,id:string,b:Row,ownerConfirmed=false){
    if(!exactKeys(b,['version','proposalSha256',...(b.currentCheckSha256!==undefined?['currentCheckSha256']:[]),...(b.projectDevelopment===true?['projectDevelopment']:[])])||!Number.isSafeInteger(b.version)||!isAuthorityDigest(b.proposalSha256))throw new Error('project_work_confirmation_invalid');const d=this.store.get(scope,id);if(d.stopRequested)throw new Error('project_work_stopped');if(b.projectDevelopment===true&&d.restart)throw new Error('project_development_restart_requires_original_scope');if(d.stage==='authorizing'&&!!d.projectDevelopment!==(b.projectDevelopment===true))throw new Error('project_work_authorization_mode_changed');if(d.currentCheck&&(b.currentCheckSha256!==d.currentCheck.sha256))throw new Error('project_work_current_check_changed');
    if(d.version!==b.version||!d.preparation?.proposal||hash(canonical(d.preparation.proposal))!==b.proposalSha256)throw new Error('project_work_preparation_changed');
    return this.job(scope,id,async job=>{
      let draft=this.store.get(scope,id);if(draft.currentCheck)await this.unchanged(scope,draft);await this.verify(scope);
      if(draft.catalog){const controls=await this.controls(scope);await controls.prepare(draft.source!,{requestId:draft.requestId,issueNumber:draft.issue.number});if(!job.stop)await controls.begin(draft.source!,draft.requestId);return;}
      const verified=await readWorkProposal(draft.preparation!.directory,sourceFor(scope,draft));if(!verified.ready||canonical(verified.proposal)!==canonical(draft.preparation!.proposal))throw new Error('project_work_preparation_changed');
      if(verified.validationProblem)throw new Error(verified.validationProblem);
    if(verified.validationEnvironment&&verified.validationEnvironment.configurationSha256!==hash(canonical(this.config.verification)))throw new Error('project_work_environment_changed_prepare_again');
      const issue=await this.readIssue(scope,draft.issue.number),head=issue.defaultHead===undefined?scope.repository.defaultHead:issue.defaultHead;if(hash(issue.body)!==draft.issue.bodySha256||head!==draft.preparation!.H)throw new Error('project_work_source_changed_prepare_again');
      await verifyRepositoryPath(scope,draft.preparation!.repositoryPath);await checkWorkMaterial(sourceFor(scope,draft),verified.proposal);
      draft=this.save(scope,{...draft,stage:'authorizing',problem:null,...(b.projectDevelopment===true?{projectDevelopment:true as const}:{})},'confirmation_requested','Explicit scope/implementation/test confirmation; exact Owner source still required');
      const proposal=verified.proposal,source='work-'+draft.id+'-v'+draft.version,target='tongxu/work-'+draft.id+'-v'+draft.version;
      const expiresAt=draft.currentCheck?assertWorkCurrent(draft.currentCheck,this.currentBinding(draft)).expiresAt:new Date(Date.parse(draft.preparation!.observedAt!)+Math.min(this.config.owner.maxGrantDurationMs,86400000)).toISOString();
      let grant=b.projectDevelopment===true?this.activeDevelopment(scope):null;
      if(b.projectDevelopment===true&&!grant){
        if(!ownerConfirmed)throw new Error('project_development_owner_confirmation_required');
        grant=this.store.reserveDevelopment(scope,{work:id,version:draft.version,issue:draft.issue.number,expiresAt});
      }
      if(grant&&Date.parse(grant.expiresAt)<=Date.now())throw new Error('owner_authorization_expired');
      const scopeId=grant?this.developmentScope(grant):source,scopeVersion=grant?'project-development-v1':'work-v'+draft.version;
      const authorizationDirectory=grant?join(this.config.root,'works',grant.work,'version-'+grant.version,'development'):this.directory(draft);
      const {store,profile}=await this.initializeQueue(authorizationDirectory,grant?.issue??draft.issue.number,scope,grant?3:1);
      const body:ScopeBody=grant?{goals:['Implement explicitly started, verified Issue work in '+scope.repository.fullName],nonGoals:['No automatic merge, deployment, production data or account reset'],preserve:['Original user checkout, protected paths, and the records of each independent work'],acceptance:['Each work retains its own Issue, fixed start, and registered test outcomes'],constraints:['Use project files only, in the separate controlled checkout of the selected work',projectValidationConstraint]}:{goals:[...new Set([proposal.goal,...(draft.goal?[draft.goal]:[])])],nonGoals:['No automatic merge, deployment, production data or account reset'],preserve:['All unselected files and original user checkout','Original Issue, captures, results and same logical owner for supplements'],acceptance:proposal.acceptance,constraints:['Issue body '+draft.issue.bodySha256,'Initial full Git commit '+draft.preparation!.H,'Work '+draft.id,'Registered test '+hash(proposal.validation.script),readableValidationConstraint(hash(proposal.validation.script))]};
      const ownerDirectory=join(authorizationDirectory,'owner');
      // This synchronous gate runs inside the sender after its last await.
      // A prior explicit approval does not cancel a later persisted stop.
      const beforePost=()=>{
        const current=this.store.get(scope,id);
        if(job.stop||!this.accepting||current.stopRequested)throw new Error('project_work_stopped');if(draft.currentCheck)this.currentGate(scope,draft);
        if(current.version!==draft.version||current.requestId!==draft.requestId||canonical(current.issue)!==canonical(draft.issue)||canonical(current.preparation)!==canonical(draft.preparation))throw new Error('project_work_preparation_changed');
      };
      const adoption=grant?.approval?.adoption??await applyWorkOwnerProposal(store,profile,{kind:'adopt_scope',scopeId,scopeVersion,body,previousAdoption:null},scopeId+'-adopt',ownerDirectory,beforePost);
      if(job.stop)throw new Error('project_work_preparation_stopped');
      const delegation=grant?.approval?.delegation??await applyWorkOwnerProposal(store,profile,{kind:'delegate',adoption,roles:['implementer'],targets:grant?[]:[target],actions:['implement','test'],paths:grant?[]:proposal.materialPaths,...(grant?{projectFiles:true as const}:{}),resourceRefs:[],expiresAt:grant?.expiresAt??expiresAt},scopeId+'-delegate',ownerDirectory,beforePost);
      if(grant&&!grant.approval)this.store.confirmDevelopment(scope,grant,{adoption,delegation});
      if(job.stop||this.store.get(scope,id).stopRequested)throw new Error('project_work_stopped');
      const config=await this.executor(),billingEvidence=join(draft.preparation!.directory,'native','completed.json');
      config.scopeSource=draft.issue.url+' adopted scope '+adoption;
      config.billing=draft.currentCheck?{mode:'existing_subscription_only',usageCreditsEnabled:false,evidence:draft.currentCheck.path,evidenceSha256:draft.currentCheck.sha256,observedAt:assertWorkCurrent(draft.currentCheck,this.currentBinding(draft)).observedAt}:{mode:'existing_subscription_only',usageCreditsEnabled:false,evidence:billingEvidence,evidenceSha256:hash(await regular(billingEvidence)),observedAt:(draft.preparation as Row).observedAt};
      const configPath=join(this.directory(draft),'executor.json');await writeFixed(configPath,canonical(config));
      const plan={schemaVersion:2,executor:this.config.verification,tools:[{id:'work-acceptance',argv:[this.config.verification.node,'--input-type=module','--eval',proposal.validation.script],timeoutMs:30000}]};
      const testPlan=join(this.directory(draft),'tests.json');await writeFixed(testPlan,canonical(plan));
      const entry:ImplementationEntry={id:source,repository:scope.repository.fullName,store,root:join(this.directory(draft),'executions'),objects:draft.preparation!.repositoryPath,H0:draft.preparation!.H,base:draft.preparation!.H,target,context:{schemaVersion:1,scope:{id:scopeId,version:scopeVersion,source:draft.issue.url+' adopted scope '+adoption},arrangement:{id:source,version:'1',source:draft.issue.url+' explicit project work'},decisionKind:'delegated_action',requires:[]},config:{path:configPath,sha256:hash(canonical(config))},allowedPaths:grant?[]:proposal.allowedPaths,materialPaths:proposal.materialPaths,protectedPaths:proposal.protectedPaths,testPlan,testPlanSha256:hash(canonical(plan)),approvedIssues:[{number:draft.issue.number,bodySha256:draft.issue.bodySha256,adjudication:'User-confirmed engineering preparation '+verified.captureSha256,goal:proposal.goal,acceptance:proposal.acceptance}],authorization:{implement:delegation,test:delegation},budgets:[],executionKind:config.executionKind??'native_capture',demonstrationFixture:false,...(grant?{projectFiles:true as const}:{materialView:'selected_files' as const}),workRequestId:draft.requestId,...(draft.currentCheck?{currentCheck:draft.currentCheck}:{}),...(draft.restart?{initialRepairRounds:0 as const}:{})};
      const bytes=canonical({schemaVersion:1,kind:'tongxu-issue-implementation-catalog',entries:[entry]}),path=join(this.directory(draft),'implementation.json');await writeFixed(path,bytes);
      draft=this.store.get(scope,id);draft=this.save(scope,{...draft,source,catalog:{path,sha256:hash(bytes)},stage:'execution',problem:null},'implementation_linked','Immutable original consumer input; execution state remains in original queue');
      const controls=await this.controls(scope);await controls.prepare(source,{requestId:draft.requestId,issueNumber:draft.issue.number});if(job.stop)throw new Error('project_work_preparation_stopped');await controls.begin(source,draft.requestId);
    });
  }
  private async implementationState(scope:ProjectChatScope,d:ProjectWorkDraft){
    const controls=await this.controls(scope),entry=(await controls.state()).find(e=>e.id===d.source),requests=entry?.requests??[];
    const reports=[],reportGaps=[];
    for(const r of requests){
      if(!r.completeCapture&&!r.hostEvidenceComplete)continue;
      try{reports.push({requestId:r.id,...await controls.report(d.source!,r.id)});}
      catch(error){
        if(problem(error)!=='implementation_validation_capture_changed')throw error;
        reportGaps.push({requestId:r.id,H1:r.H1,reason:problem(error)});
      }
    }
    return {requests,reports,...(reportGaps.length?{reportGaps}:{})};
  }
  async receive(scope:ProjectChatScope,id:string){
    this.store.get(scope,id);const prior=this.receiving.get(id);if(prior)return prior;
    const operation=this.receiveOriginal(scope,id);this.receiving.set(id,operation);try{return await operation;}finally{this.receiving.delete(id);}
  }
  private async receiveOriginal(scope:ProjectChatScope,id:string){
    let d=this.store.get(scope,id);if(!d.catalog||!d.source)throw new Error('project_work_original_not_registered');await this.verify(scope);
    const source=d.source,catalog=JSON.parse((await regular(d.catalog.path)).toString()),entry=catalog.entries[0] as ImplementationEntry;
    if(hash(canonical(catalog))!==d.catalog.sha256)throw new Error('project_work_fixed_input_changed');
    // A later supplement does not replace an already persisted receipt. Finish
    // that exact result before selecting the latest request (including no-change
    // or unfinished requests). Ambiguous/missing original results stay pending.
    if(d.delivery?.status==='pending'){
      const pending=d.delivery,q=await QueueStore.open(entry.store);let original:Row;
      try{
        const matches=q.issueImplementations().requests(source).filter(r=>r.result?.status==='completed'&&r.result.completeCapture&&r.result.H1===pending.H);
        if(matches.length!==1)throw new Error('project_work_pending_result_not_unique');
        original=matches[0]!;
        for(const resource of original.plan.resourceRequests)if(!q.resources().settledOutcome(resource))throw new Error('implementation_original_resources_unresolved');
      }finally{q.close();}
      const controls=await this.controls(scope);await controls.report(source,original.id);
      try{
        await receiveWorkResult({repositoryPath:entry.objects,executionWorkspace:original.plan.workspace,H:pending.H,previous:pending.previous,branch:pending.branch,workspace:pending.workspace,evidence:join(this.directory(d),'receipt-'+pending.H)});
        d=this.store.get(scope,id);d=this.save(scope,{...d,stage:'delivered',problem:null,delivery:{...pending,status:'received',problem:null}},'result_received',pending.H+' returned to the real project branch and result workspace');
      }catch(e){d=this.store.get(scope,id);this.save(scope,{...d,stage:'waiting_return',problem:problem(e),delivery:{...pending,problem:problem(e)}},'result_receipt_waiting',problem(e));throw e;}
    }
    const q=await QueueStore.open(entry.store);let latest:Row;
    try{const rows=q.issueImplementations().requests(source);latest=rows.at(-1)!;if(latest?.result?.status==='no_change'&&latest.result.completeCapture){this.save(scope,{...d,stage:d.delivery?.status==='received'?'delivered':'no_change',problem:null},'no_change','Original complete no-change result retained; no new commit claimed');return {status:'no_change',newCommit:false};}if(!latest||latest.result?.status!=='completed'||!latest.result.completeCapture||!latest.result.H1){this.save(scope,{...d,stage:'waiting_return',problem:'project_work_result_not_complete'},'result_waiting','Latest original request has no complete committed result');throw new Error('project_work_result_not_complete');}for(const resource of latest.plan.resourceRequests)if(!q.resources().settledOutcome(resource))throw new Error('implementation_original_resources_unresolved');}finally{q.close();}
    const controls=await this.controls(scope);await controls.report(source,latest.id);
    const H=latest.result.H1;
    if(d.delivery?.status==='received'&&d.delivery.H===H){
      try{return await receiveWorkResult({repositoryPath:entry.objects,executionWorkspace:latest.plan.workspace,H,previous:d.delivery.previous,branch:entry.target,workspace:d.delivery.workspace,evidence:join(this.directory(d),'receipt-'+H)});}
      catch(e){this.save(scope,{...d,stage:'waiting_return',problem:problem(e),delivery:{...d.delivery,status:'pending',problem:problem(e)}},'result_receipt_changed',problem(e));throw e;}
    }
    const previous=d.delivery?.status==='received'?d.delivery.H:d.delivery?.previous??null,workspace=join(this.directory(d),'result');
    if(d.delivery?.status==='pending'&&d.delivery.H!==H)throw new Error('project_work_previous_result_not_received');
    d=this.save(scope,{...d,stage:'waiting_return',delivery:{H,previous,branch:entry.target,workspace,status:'pending',problem:null}},'result_receipt_requested','Original complete result; not another implementation');
    try{
      const result=await receiveWorkResult({repositoryPath:entry.objects,executionWorkspace:latest.plan.workspace,H,previous,branch:entry.target,workspace,evidence:join(this.directory(d),'receipt-'+H)});
      d=this.store.get(scope,id);this.save(scope,{...d,stage:'delivered',problem:null,delivery:{...d.delivery!,status:'received'}},'result_received',H+' returned to the real project branch and result workspace');return result;
    }catch(e){d=this.store.get(scope,id);this.save(scope,{...d,stage:'waiting_return',problem:problem(e),delivery:{...d.delivery!,problem:problem(e)}},'result_receipt_waiting',problem(e));throw e;}
  }
  async onFinished(scope:ProjectChatScope,target:SupplementTarget){const draft=this.store.list(scope).find(d=>d.source===target.source);if(draft)await this.receive(scope,draft.id);}
  async drain(){this.accepting=false;for(const job of this.active.values()){job.stop=true;await job.session?.close();}await Promise.allSettled([...this.active.values()].map(j=>j.promise));await Promise.allSettled(this.receiving.values());this.store.close();}
}
