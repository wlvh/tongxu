import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertWorkEnvironmentEnded} from './project-work-environment.js';
import {ProjectWorkStore,type ProjectWorkDraft} from './project-work-store.js';
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
export type ProjectWorkConfiguration={root:string;executor:{path:string;sha256:string};verification:DockerConfig;owner:Omit<AuthorityProfile,'repository'|'issue'|'kind'|'schemaVersion'>};
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
    if(!exactKeys(c,['root','executor','verification','owner'])||typeof c.root!=='string'||resolve(c.root)!==c.root||!exactKeys(c.executor,['path','sha256'])||resolve(c.executor.path)!==c.executor.path||!isAuthorityDigest(c.executor.sha256))throw new Error('project_work_configuration_invalid');
    c.verification=parseDockerConfig(c.verification);workAuthorityProfile(c.owner,{account:{id:c.owner.ownerId,login:'configuration'},repository:{id:1,nodeId:'configuration',fullName:'local/configuration'}} as ProjectChatScope,1);
    return new ProjectWork(c,await ProjectWorkStore.open(c.root),readIssue,verify,controls);
  }
  private directory(d:ProjectWorkDraft){return join(this.config.root,'works',d.id,'version-'+d.version);}
  private async executor(){const b=await regular(this.config.executor.path);if(hash(b)!==this.config.executor.sha256)throw new Error('project_work_executor_changed');return JSON.parse(b.toString()) as RepairConfig;}
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
    if(!b.newWork){const previous=this.store.list(scope).find(d=>d.issue.number===b.issueNumber&&!['delivered','cancelled'].includes(d.stage));if(previous)return previous;}
    let issue:Issue={number:b.issueNumber,title:'Issue #'+b.issueNumber,body:'',url:`https://github.com/${scope.repository.fullName}/issues/${b.issueNumber}`},failure:string|null=null;
    try{issue=await this.readIssue(scope,b.issueNumber);}catch(e){failure=problem(e);}
    const at=now();return this.store.create(scope,{id:b.requestId,conversationId:b.conversationId,issue:{...issue,bodySha256:hash(issue.body)},goal:b.goal,createdAt:at,updatedAt:at,revision:0,version:0,requestId:randomUUID(),stage:failure?'needs_input':'draft',problem:failure,events:[{at,kind:'draft_saved',detail:'Saved without model input or implementation'}]},!b.newWork);
  }
  private async recover(scope:ProjectChatScope,d:ProjectWorkDraft){
    if(d.stage!=='preparing'||this.active.has(d.id))return d;
    const prepared=d.preparation as Row|undefined;if(!prepared)return this.save(scope,{...d,stage:'needs_input',problem:'project_work_preparation_interrupted'},'preparation_interrupted','No native preparation was registered');
    try{
      const result=await readWorkProposal(prepared.directory,sourceFor(scope,d));return this.save(scope,{...d,preparation:{...d.preparation!,...result},stage:result.ready?'prepared':'needs_input',problem:result.ready?null:'project_work_requirements_need_clarification'},'preparation_recovered','Read original complete preparation; no new model input');
    }catch{}
    if(processState(prepared.pid)!=='ended')return {...d,problem:'project_work_preparation_active_or_unknown'};
    const native=join(prepared.directory,'native');
    if(await exists(native)&&!await exists(join(native,'exit.json')))return {...d,problem:'project_work_preparation_active_or_unknown'};
    return this.save(scope,{...d,stage:'needs_input',problem:'project_work_preparation_interrupted'},'preparation_interrupted','Original incomplete preparation retained; a new version requires an explicit action');
  }
  async state(scope:ProjectChatScope){
    const works=[];for(const d of this.store.list(scope))works.push(await this.recover(scope,d));
    const entries=works.some(d=>d.catalog)?await(await this.controls(scope)).state():[];
    return {available:true,settings:this.store.settings(scope),works:works.map(d=>({id:d.id,issue:{number:d.issue.number,title:d.issue.title,url:d.issue.url},conversationId:d.conversationId,version:d.version,stage:d.stage,problem:d.problem,hasImplementation:!!d.catalog,stopRequested:!!d.stopRequested,delivery:d.delivery,createdAt:d.createdAt,updatedAt:d.updatedAt,active:this.active.has(d.id),execution:entries.find(e=>e.id===d.source)?.requests.find((r:Row)=>r.id===d.requestId)??null})),supported:'Existing text files; registered Docker Node validation; separate result branch; no automatic merge',newModelInputs:0};
  }
  async detail(scope:ProjectChatScope,id:string){
    const draft=await this.recover(scope,this.store.get(scope,id));const result=draft.catalog?await this.implementationState(scope,draft):null;
    const diagnostic=async(d:ProjectWorkDraft)=>d.preparation&&!d.preparation.proposal?readWorkPreparationDiagnostic(d.preparation.directory,sourceFor(scope,d)):null;
    const history=[];for(const previous of draft.prior??[]){const old={...draft,...previous};history.push({version:previous.version,delivery:previous.delivery,execution:previous.catalog?await this.implementationState(scope,old):null,preparationDiagnostic:await diagnostic(old)});}
    return {draft,execution:result,history,preparationDiagnostic:await diagnostic(draft),firstInputContinuation:draft.catalog&&draft.source?await(await this.controls(scope)).firstInputContinuation(draft.source,draft.requestId):null,newModelInputs:0};
  }
  private job(scope:ProjectChatScope,id:string,action:(job:Job)=>Promise<void>){
    if(!this.accepting)throw new Error('project_work_closing');if(this.active.has(id))return {id,active:true,duplicate:true};
    const job:Job={stop:false,promise:Promise.resolve()};this.active.set(id,job);
    job.promise=action(job).catch(e=>{const d=this.store.get(scope,id);this.save(scope,{...d,stage:d.catalog?'execution':d.stage==='authorizing'?'authorizing':'needs_input',problem:problem(e)},'action_failed',problem(e));}).finally(()=>this.active.delete(id));
    return {id,active:true,registrationIsNotExecution:true};
  }
  async prepare(scope:ProjectChatScope,id:string,b:Row){
    if(!exactKeys(b,['goal'])||typeof b.goal!=='string'||b.goal.length>2048||b.goal.includes('\0'))throw new Error('project_work_goal_invalid');const current=await this.recover(scope,this.store.get(scope,id));
    if(current.stage==='preparing')return {id,active:!!this.active.get(id),originalRetained:true};
    return this.job(scope,id,async job=>{
      let d=this.store.get(scope,id);d=this.save(scope,{...d,...(d.version===0&&!d.preparation&&!d.catalog?{goal:b.goal}:{draftGoal:b.goal})},'preparation_goal_saved','Explicit draft input retained before checking conditions; fixed version goal stays unchanged');const setting=this.store.settings(scope);if(!setting)throw new Error('project_work_repository_location_required');await this.verify(scope);
      if(setting.verified===false)throw new Error(setting.problem??'project_work_repository_location_required');
      if(d.catalog){
        const controls=await this.controls(scope),entry=(await controls.state()).find(x=>x.id===d.source);
        if(entry?.requests.some((r:Row)=>r.controllerActive||r.phase==='active_or_unknown'))throw new Error('project_work_original_active_or_unknown');
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
      d=this.save(scope,{...d,prior,catalog:undefined,source:undefined,delivery:undefined,stopRequested:false,goal:b.goal,draftGoal:undefined,issue:{...issue,bodySha256:hash(issue.body)},version,requestId:randomUUID(),stage:'preparing',problem:null,preparation:{directory,H,repositoryPath,verification:this.config.verification,inputSha256:'',pid:process.pid,observedAt:now()}},'preparation_started','Explicit read-only engineering preparation');
      const result=await prepareWorkProposal({source,issue:d.issue,goal:d.goal,directory,config:await this.executor(),verification:this.config.verification,check:()=>this.verify(scope),stopped:()=>job.stop||!this.accepting,onSession:s=>{job.session=s;}});
      if(job.stop||!this.accepting)throw new Error('project_work_preparation_stopped');d=this.store.get(scope,id);
      this.save(scope,{...d,preparation:{...d.preparation!,...result},stage:result.ready?'prepared':'needs_input',problem:result.ready?null:'project_work_requirements_need_clarification'},'preparation_completed','Proposal only; no implementation or authority granted');
    });
  }
  async continueFirstInput(scope:ProjectChatScope,id:string){const d=this.store.get(scope,id);if(!d.catalog||!d.source||d.stopRequested)throw new Error('project_work_original_not_registered');await this.verify(scope);return(await this.controls(scope)).continueFirstInput(d.source,d.requestId);}
  async stop(scope:ProjectChatScope,id:string){let d=this.store.get(scope,id);d=this.save(scope,{...d,stopRequested:true,problem:'project_work_stopped'},'stop_requested','Stop original work and all later actions; preserve original records');const job=this.active.get(id);if(job){job.stop=true;await job.session?.close();}d=this.store.get(scope,id);if(d.source&&d.catalog)await(await this.controls(scope)).stop(d.source,d.requestId);return {id,stopRequested:true,originalRetained:true};}
  async stopSelected(account:number,repository:number,id:string){return this.stop(this.store.cleanupScope(account,repository,id),id);}
  private async initializeQueue(d:ProjectWorkDraft,scope:ProjectChatScope){
    const store=join(this.directory(d),'queue'),profile=workAuthorityProfile(this.config.owner,scope,d.issue.number);if(profile.executorId!==scope.account.id)throw new Error('project_work_owner_identity_not_configured');
    const q=await exists(join(store,'queue.sqlite'))?await QueueStore.open(store):await QueueStore.create(store,scope.repository.fullName,1);
    try{q.enableReceiver();q.enableSupplements();q.reviewRecords().enable();q.enableCompositions();q.enableReceiverCorrections();q.enableTasks();q.authority().configure(Buffer.from(canonical(profile)));}finally{q.close();}
    return {store,profile};
  }
  async confirmation(scope:ProjectChatScope,id:string,b:Row){
    if(!exactKeys(b,['version','proposalSha256'])||!Number.isSafeInteger(b.version)||!isAuthorityDigest(b.proposalSha256))throw new Error('project_work_confirmation_invalid');
    const d=this.store.get(scope,id);if(d.stopRequested)throw new Error('project_work_stopped');if(d.version!==b.version||!d.preparation?.proposal||hash(canonical(d.preparation.proposal))!==b.proposalSha256)throw new Error('project_work_preparation_changed');
    if(this.active.has(id))return {active:true};if(d.catalog)return {alreadyAuthorized:true};
    await this.verify(scope);const verified=await readWorkProposal(d.preparation.directory,sourceFor(scope,d)),issue=await this.readIssue(scope,d.issue.number),head=issue.defaultHead===undefined?scope.repository.defaultHead:issue.defaultHead;
    if(verified.validationEnvironment&&verified.validationEnvironment.configurationSha256!==hash(canonical(this.config.verification)))throw new Error('project_work_environment_changed_prepare_again');
    if(!verified.ready||hash(issue.body)!==d.issue.bodySha256||head!==d.preparation.H)throw new Error('project_work_source_changed_prepare_again');
    const profile=workAuthorityProfile(this.config.owner,scope,d.issue.number);if(profile.executorId!==scope.account.id)throw new Error('project_work_owner_identity_not_configured');
    const expiresAt=Date.parse(d.preparation.observedAt!)+Math.min(profile.maxGrantDurationMs,86400000);if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new Error('project_work_source_changed_prepare_again');
    return {expiresAt:new Date(expiresAt).toISOString(),project:scope.repository.fullName,issue:'#'+d.issue.number+' '+d.issue.title,goal:verified.proposal.goal,originalGoal:d.goal,acceptance:verified.proposal.acceptance,allowedPaths:verified.proposal.allowedPaths,validation:verified.proposal.validation.description,identity:profile.sharedAccountApproval?'同一 GitHub 账号；未证明实际操作人与执行者分离':'已有指定本人来源'};
  }
  async start(scope:ProjectChatScope,id:string,b:Row){
    if(!exactKeys(b,['version','proposalSha256'])||!Number.isSafeInteger(b.version)||!isAuthorityDigest(b.proposalSha256))throw new Error('project_work_confirmation_invalid');const d=this.store.get(scope,id);if(d.stopRequested)throw new Error('project_work_stopped');
    if(d.version!==b.version||!d.preparation?.proposal||hash(canonical(d.preparation.proposal))!==b.proposalSha256)throw new Error('project_work_preparation_changed');
    return this.job(scope,id,async job=>{
      let draft=this.store.get(scope,id);await this.verify(scope);
      if(draft.catalog){const controls=await this.controls(scope);await controls.prepare(draft.source!,{requestId:draft.requestId,issueNumber:draft.issue.number});if(!job.stop)await controls.begin(draft.source!,draft.requestId);return;}
      const verified=await readWorkProposal(draft.preparation!.directory,sourceFor(scope,draft));if(!verified.ready||canonical(verified.proposal)!==canonical(draft.preparation!.proposal))throw new Error('project_work_preparation_changed');
      if(verified.validationEnvironment&&verified.validationEnvironment.configurationSha256!==hash(canonical(this.config.verification)))throw new Error('project_work_environment_changed_prepare_again');
      const issue=await this.readIssue(scope,draft.issue.number),head=issue.defaultHead===undefined?scope.repository.defaultHead:issue.defaultHead;if(hash(issue.body)!==draft.issue.bodySha256||head!==draft.preparation!.H)throw new Error('project_work_source_changed_prepare_again');
      await verifyRepositoryPath(scope,draft.preparation!.repositoryPath);await checkWorkMaterial(sourceFor(scope,draft),verified.proposal);
      draft=this.save(scope,{...draft,stage:'authorizing',problem:null},'confirmation_requested','Explicit scope/implementation/test confirmation; exact Owner source still required');
      const {store,profile}=await this.initializeQueue(draft,scope),proposal=verified.proposal,source='work-'+draft.id+'-v'+draft.version,target='tongxu/work-'+draft.id+'-v'+draft.version;
      const scopeId=source,body:ScopeBody={goals:[...new Set([proposal.goal,...(draft.goal?[draft.goal]:[])])],nonGoals:['No automatic merge, deployment, production data or account reset'],preserve:['All unselected files and original user checkout','Original Issue, captures, results and same logical owner for supplements'],acceptance:proposal.acceptance,constraints:['Issue body '+draft.issue.bodySha256,'Initial full Git commit '+draft.preparation!.H,'Work '+draft.id,'Registered test '+hash(proposal.validation.script)]};
      const ownerDirectory=join(this.directory(draft),'owner');
      // This synchronous gate runs inside the sender after its last await.
      // A prior explicit approval does not cancel a later persisted stop.
      const beforePost=()=>{
        const current=this.store.get(scope,id);
        if(job.stop||!this.accepting||current.stopRequested)throw new Error('project_work_stopped');
        if(current.version!==draft.version||current.requestId!==draft.requestId||canonical(current.issue)!==canonical(draft.issue)||canonical(current.preparation)!==canonical(draft.preparation))throw new Error('project_work_preparation_changed');
      };
      const adoption=await applyWorkOwnerProposal(store,profile,{kind:'adopt_scope',scopeId,scopeVersion:'work-v'+draft.version,body,previousAdoption:null},source+'-adopt',ownerDirectory,beforePost);
      if(job.stop)throw new Error('project_work_preparation_stopped');
      const delegation=await applyWorkOwnerProposal(store,profile,{kind:'delegate',adoption,roles:['implementer'],targets:[target],actions:['implement','test'],paths:proposal.materialPaths,resourceRefs:[],expiresAt:new Date(Date.parse(draft.preparation!.observedAt!)+Math.min(profile.maxGrantDurationMs,86400000)).toISOString()},source+'-delegate',ownerDirectory,beforePost);
      if(job.stop||this.store.get(scope,id).stopRequested)throw new Error('project_work_stopped');
      const config=await this.executor(),billingEvidence=join(draft.preparation!.directory,'native','completed.json');
      config.scopeSource=draft.issue.url+' adopted scope '+adoption;
      config.billing={mode:'existing_subscription_only',usageCreditsEnabled:false,evidence:billingEvidence,evidenceSha256:hash(await regular(billingEvidence)),observedAt:(draft.preparation as Row).observedAt};
      const configPath=join(this.directory(draft),'executor.json');await writeFixed(configPath,canonical(config));
      const plan={schemaVersion:2,executor:this.config.verification,tools:[{id:'work-acceptance',argv:[this.config.verification.node,'--input-type=module','--eval',proposal.validation.script],timeoutMs:30000}]};
      const testPlan=join(this.directory(draft),'tests.json');await writeFixed(testPlan,canonical(plan));
      const entry:ImplementationEntry={id:source,repository:scope.repository.fullName,store,root:join(this.directory(draft),'executions'),objects:draft.preparation!.repositoryPath,H0:draft.preparation!.H,base:draft.preparation!.H,target,context:{schemaVersion:1,scope:{id:scopeId,version:'work-v'+draft.version,source:draft.issue.url+' adopted scope '+adoption},arrangement:{id:source,version:'1',source:draft.issue.url+' explicit project work'},decisionKind:'delegated_action',requires:[]},config:{path:configPath,sha256:hash(canonical(config))},allowedPaths:proposal.allowedPaths,materialPaths:proposal.materialPaths,protectedPaths:proposal.protectedPaths,testPlan,testPlanSha256:hash(canonical(plan)),approvedIssues:[{number:draft.issue.number,bodySha256:draft.issue.bodySha256,adjudication:'User-confirmed engineering preparation '+verified.captureSha256,goal:proposal.goal,acceptance:proposal.acceptance}],authorization:{implement:delegation,test:delegation},budgets:[],executionKind:config.executionKind??'native_capture',demonstrationFixture:false,materialView:'selected_files',workRequestId:draft.requestId};
      const bytes=canonical({schemaVersion:1,kind:'tongxu-issue-implementation-catalog',entries:[entry]}),path=join(this.directory(draft),'implementation.json');await writeFixed(path,bytes);
      draft=this.store.get(scope,id);draft=this.save(scope,{...draft,source,catalog:{path,sha256:hash(bytes)},stage:'execution',problem:null},'implementation_linked','Immutable original consumer input; execution state remains in original queue');
      const controls=await this.controls(scope);await controls.prepare(source,{requestId:draft.requestId,issueNumber:draft.issue.number});if(job.stop)throw new Error('project_work_preparation_stopped');await controls.begin(source,draft.requestId);
    });
  }
  private async implementationState(scope:ProjectChatScope,d:ProjectWorkDraft){
    const controls=await this.controls(scope),entry=(await controls.state()).find(e=>e.id===d.source),requests=entry?.requests??[];
    const reports=[];for(const r of requests)if(r.completeCapture)reports.push({requestId:r.id,...await controls.report(d.source!,r.id)});
    return {requests,reports};
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
