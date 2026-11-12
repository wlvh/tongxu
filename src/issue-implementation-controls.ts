import {projectWorkOrigin,type ProjectWorkOrigin} from './project-chat-contract.js';
import {readRepairSession} from './repair-native.js';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,git,tree,treeHash,exists} from './repair-workspace.js';
import {messageId} from './message-contract.js';
import {exactKeys,isAuthorityDigest,type ActionRequest} from './authority-contract.js';
import {parseDevelopmentTask,developmentTaskId} from './task-contract.js';
import {parseQueueContext,type QueueContext} from './queue-evidence.js';
import {observeTaskWorkspace} from './task-source.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {prepareResourceRequest,resourceAction} from './resource-claims.js';
import {withQueueRepairLock} from './queue-repair.js';
import {prepareIssueImplementation,runIssueImplementation,type ImplementationRequest} from './issue-implementation.js';
import type {ProjectRequest} from './project-repair.js';
import type {SupplementTarget,ProjectWorkRequest,ProjectWorkLink} from './project-chat.js';
import {readImplementationResult,readImplementationOwnerProof,implementationOwnerTarget,type ImplementationOwnerTarget,type ImplementationOwnerProof} from './implementation-owner-feedback.js';
type Row=Record<string,any>;
export type ImplementationEntry={id:string;repository:string;store:string;root:string;objects:string;H0:string;base:string;target:string;context:QueueContext;config:{path:string;sha256:string};allowedPaths:string[];materialPaths:string[];protectedPaths:string[];testPlan:string;testPlanSha256:string;approvedIssues:Array<{number:number;bodySha256:string;adjudication:string;goal:string;acceptance:string[]}>;authorization:{implement:string;test:string};budgets:Array<{action:'implement'|'test';ledgerId:string;resourceRef:string;unit:string;quantity:number}>;executionKind:'fixture'|'native_capture';demonstrationFixture:boolean;materialView?:'selected_files';workRequestId?:string};
type Entry=ImplementationEntry;
type ReadEntry=Pick<Entry,'id'|'repository'|'store'|'target'>;
type HistorySource={store:string;item:string};
type Issue={number:number;title:string;body:string;url:string};
type Reader=(number:number)=>Promise<Issue>;

/** Trusted installation fixes the project, source, adopted Issue, tests and
 * scope. The browser supplies only an option and a stable request identity. */
export class IssueImplementationControls{
  private active=new Map<string,Promise<unknown>>();private accepting=true;private finished?: (target:SupplementTarget)=>Promise<void>;
  private generated=new Map<string,{path:string;sha256:string}>();
  private retired=new Set<string>();
  onFinished(callback:(target:SupplementTarget)=>Promise<void>){this.finished=callback;}
  private constructor(private path:string,private sha256:string,private entries:Entry[],private read:Reader,private verify:()=>Promise<void>,private repository:string,private historySources:()=>Promise<readonly HistorySource[]>){}
  static async load(path:string,sha256:string,repository:string,read:Reader,verify:()=>Promise<void>,historySources:()=>Promise<readonly HistorySource[]>=async()=>[]){
    const bytes=await regular(path,128*1024),p=JSON.parse(bytes.toString());
    if(hash(bytes)!==sha256||!exactKeys(p,['schemaVersion','kind','entries'])||p.schemaVersion!==1||p.kind!=='tongxu-issue-implementation-catalog'||!Array.isArray(p.entries)||p.entries.length>8)throw new Error('implementation_catalog_invalid');
    const entries=p.entries.filter((e:Entry)=>e.repository?.toLowerCase()===repository.toLowerCase()) as Entry[];
    for(const e of entries){
      if(!exactKeys(e,['id','repository','store','root','objects','H0','base','target','context','config','allowedPaths','materialPaths','protectedPaths','testPlan','testPlanSha256','approvedIssues','authorization','budgets','executionKind','demonstrationFixture',...(e.materialView!==undefined?['materialView']:[]),...(e.workRequestId!==undefined?['workRequestId']:[])])||e.materialView!==undefined&&e.materialView!=='selected_files'||e.workRequestId!==undefined&&!messageId(e.workRequestId)||!messageId(e.id)||![e.store,e.root,e.objects,e.config?.path,e.testPlan].every(path=>typeof path==='string'&&resolve(path)===path)||!isAuthorityDigest(e.config.sha256)||!isAuthorityDigest(e.testPlanSha256)||![e.H0,e.base].every(x=>/^[a-f0-9]{40}$/.test(x))||typeof e.demonstrationFixture!=='boolean'||!['fixture','native_capture'].includes(e.executionKind)||!Array.isArray(e.approvedIssues)||!e.approvedIssues.length||e.approvedIssues.length>32||!exactKeys(e.authorization,['implement','test'])||!Object.values(e.authorization).every(isAuthorityDigest)||!Array.isArray(e.budgets)||e.budgets.length>16||e.budgets.some(b=>!exactKeys(b,['action','ledgerId','resourceRef','unit','quantity'])||!['implement','test'].includes(b.action)))throw new Error('implementation_entry_invalid');
      e.context=parseQueueContext(e.context);if(new Set(e.approvedIssues.map(issue=>issue.number)).size!==e.approvedIssues.length)throw new Error('implementation_duplicate_adopted_issue');
      for(const issue of e.approvedIssues)if(!exactKeys(issue,['number','bodySha256','adjudication','goal','acceptance'])||!Number.isSafeInteger(issue.number)||issue.number<1||!isAuthorityDigest(issue.bodySha256)||!issue.adjudication?.trim()||!issue.goal?.trim()||!Array.isArray(issue.acceptance)||!issue.acceptance.length)throw new Error('implementation_adopted_issue_required');
    }
    if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new Error('implementation_duplicate_entry');
    return new IssueImplementationControls(path,sha256,entries,read,verify,repository,historySources);
  }
  private entry(id:string){const entry=this.entries.find(e=>e.id===id);if(!entry)throw new Error('implementation_project_not_selected');return entry;}
  private async readEntry(id:string,requestId:string){
    const current=this.entries.find(entry=>entry.id===id);
    if(current)return {entry:current,historical:this.retired.has(id)};
    await this.catalog();
    const sources=await this.historySources();
    let selected:ReadEntry|undefined;
    for(const store of new Set([...this.entries.map(entry=>entry.store),...sources.map(source=>source.store)])){
      const q=await QueueStore.open(store);
      try{
        const state=q.issueImplementations().findState(id,requestId);
        if(!state)continue;
        if(!this.entries.some(entry=>entry.store===store)&&!sources.some(source=>source.store===store&&source.item===state.task))continue;
        const request=q.issueImplementations().original(id,requestId),definition=q.tasks().definition(state.task);
        if(definition.repository.toLowerCase()!==this.repository.toLowerCase()||request.task!==state.task||request.workspaceRequest.candidate.target!==definition.target)throw new Error('implementation_history_project_mismatch');
        if(state.phase!=='returned'||!['completed','no_change'].includes(state.result?.status)||!state.result.completeCapture)throw new Error('implementation_history_incomplete');
        if(selected)throw new Error('implementation_history_ambiguous');
        selected={id,store,repository:definition.repository,target:definition.target};
      }finally{q.close();}
    }
    if(!selected)throw new Error('implementation_history_not_configured');
    return {entry:selected,historical:true};
  }
  /** Product preparation supplies immutable catalogues, never browser entries.
   * Each original request stays bound to its own catalogue as other work grows. */
  async includeGenerated(refs:readonly {path:string;sha256:string}[]){
    if(refs.length>128)throw new Error('implementation_history_limit');
    for(const ref of refs){
      const selected=await IssueImplementationControls.load(ref.path,ref.sha256,this.repository,this.read,this.verify,this.historySources);
      if(selected.entries.length!==1)throw new Error('implementation_generated_entry_invalid');
      const entry=selected.entries[0]!,previous=this.entries.find(x=>x.id===entry.id),known=this.generated.get(entry.id);
      if(previous){if(!known||canonical(known)!==canonical(ref)||canonical(previous)!==canonical(entry))throw new Error('implementation_generated_entry_changed');}
      else{this.entries.push(entry);this.generated.set(entry.id,{...ref});}
    }
  }
  markGeneratedCurrent(ids:ReadonlySet<string>){this.retired=new Set([...this.generated.keys()].filter(id=>!ids.has(id)));}
  private catalogHash(id:string){return this.generated.get(id)?.sha256??this.sha256;}
  private async catalog(){for(const ref of [{path:this.path,sha256:this.sha256},...this.generated.values()])if(hash(await regular(ref.path,128*1024))!==ref.sha256)throw new Error('implementation_catalog_changed');}
  options(){return this.entries.filter(e=>!this.generated.has(e.id)).map(e=>({id:e.id,issues:e.approvedIssues.map(i=>({number:i.number,goal:i.goal,adjudication:i.adjudication,bodySha256:i.bodySha256})),H0:e.H0,allowedPaths:e.allowedPaths,executionKind:e.executionKind,demonstrationFixture:e.demonstrationFixture}));}
  async prepare(id:string,body:Row){
    try{return await this.prepareSelected(id,body);}catch(error){
      const entry=this.entries.find(e=>e.id===id);if(entry&&messageId(body?.requestId)){
        const q=await QueueStore.open(entry.store);try{if(q.issueImplementations().requests(id).some(r=>r.id===body.requestId))q.issueImplementations().problem(id,body.requestId,error instanceof Error?error.message:'implementation_preparation_failed');}finally{q.close();}
      }
      throw error;
    }
  }
  private async prepareSelected(id:string,body:Row,followup?:{entry:Entry;continuation:NonNullable<ImplementationRequest['continuation']>;beforeRegistration:()=>void},work?:{origin?:ProjectWorkOrigin;beforeRegistration:()=>void;afterRegistration:()=>void;uniqueFirst?:boolean}){
    if(!this.accepting||!exactKeys(body,['requestId','issueNumber'])||!messageId(body.requestId)||!Number.isSafeInteger(body.issueNumber))throw new Error('implementation_start_request_invalid');
    await this.catalog();await this.verify();let entry=followup?.entry??this.entry(id);if(this.retired.has(id))throw new Error('implementation_prepared_work_retired');if(entry.workRequestId&&body.requestId!==entry.workRequestId&&!followup)throw new Error('implementation_prepared_work_identity_required');const adopted=entry.approvedIssues.find(i=>i.number===body.issueNumber);if(!adopted)throw new Error('implementation_issue_not_adopted');
    const previousQueue=await QueueStore.open(entry.store);let original:ImplementationRequest|undefined,originalTitle:string|undefined;
    try{const previous=previousQueue.issueImplementations().requests(id).find(r=>r.id===body.requestId);if(previous){
      if(previous.issue!==body.issueNumber)throw new Error('implementation_request_id_is_fixed');
      original=previousQueue.issueImplementations().original(id,body.requestId);
      if(work?.origin&&canonical(original.origin??null)!==canonical(work.origin))throw new Error('implementation_request_id_is_fixed');
      if(original.continuation)await this.checkSupplementPredecessor(entry,original,previous.phase==='registered'&&!previous.stopped);
      if(previous.phase!=='registered'||previous.stopped)return this.publicState(previous);
      if(original.continuation)entry={...entry,H0:original.workspaceRequest.candidate.H,objects:original.workspaceRequest.objects};
      originalTitle=previousQueue.tasks().definition(original.task).title;
    }}finally{previousQueue.close();}
    const issue=await this.read(adopted.number);if(issue.number!==adopted.number||hash(issue.body)!==adopted.bodySha256)throw new Error('implementation_issue_source_changed');
    const root=join(entry.root,body.requestId),workspace=join(root,'workspace');
    const definition=parseDevelopmentTask(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-development-task',id:'implementation-'+body.requestId,repository:entry.repository,title:originalTitle??issue.title,goal:adopted.goal,acceptance:adopted.acceptance,source:issue.url+' body sha256 '+adopted.bodySha256,issue:issue.number,context:entry.context,workspace,base:entry.base,target:entry.target,paths:entry.materialView?entry.allowedPaths:entry.materialPaths})));
    const task=developmentTaskId(definition);
    const scopeQueue=await QueueStore.open(entry.store);let adoptedScope:ImplementationRequest['adoptedScope'];try{const authority=scopeQueue.authority(),adoption=authority.forScope(entry.context.scope.id,{item:task,target:entry.target}).currentAdoption;if(!adoption)throw new Error('implementation_scope_adoption_required');const original=authority.inspectRecordedDecision(adoption);if(original.proposal.kind!=='adopt_scope')throw new Error('implementation_scope_adoption_required');adoptedScope={adoption,body:original.proposal.body,bodySha256:hash(canonical(original.proposal.body)),source:original.source.sourceUrl};}finally{scopeQueue.close();}
    const workspaceRequest:ProjectRequest={schemaVersion:1,kind:'tongxu-project-repair-request',executionRoot:root,objects:entry.objects,candidate:{kind:'local-git',repository:'local/issue-implementation-source',pr:null,H:entry.H0,B:entry.base,target:entry.target},allowedPaths:entry.allowedPaths,materialPaths:entry.materialPaths,protectedPaths:entry.protectedPaths,contract:adopted.goal,testPlan:entry.testPlan,testPlanSha256:entry.testPlanSha256,findings:[],authorization:{source:issue.url+' adopted requirement; actual implement/test permission checked by original authority consumer',allowRepair:true,allowReconcileEnded:false,maxRepairRounds:1},demonstrationFixture:entry.demonstrationFixture,generatedDirectories:[],...(entry.materialView?{materialView:entry.materialView}:{})};
    const continuation=original?.continuation??followup?.continuation;
    const request:ImplementationRequest={schemaVersion:1,kind:'tongxu-issue-implementation',id:body.requestId,task,adoptedScope,issue:{number:issue.number,body:issue.body,bodySha256:adopted.bodySha256,adjudication:adopted.adjudication},workspaceRequest,...(continuation?{continuation}:{}),...((original?.origin??work?.origin)?{origin:original?.origin??work?.origin}:{})};
    if(original&&canonical(request)!==canonical(original))throw new Error('implementation_request_id_is_fixed');
    const executorBytes=await regular(entry.config.path);if((JSON.parse(executorBytes.toString()).executionKind??'native_capture')!==entry.executionKind)throw new Error('implementation_executor_kind_mismatch');
    if(hash(executorBytes)!==entry.config.sha256)throw new Error('implementation_executor_changed');
    await mkdir(entry.root,{recursive:true,mode:0o700});await privateDirectory(entry.root,false);const prepared=await prepareIssueImplementation(entry.config.path,request,root),planBytes=await regular(prepared.plan),observation=await observeTaskWorkspace(definition);
    const q=await QueueStore.open(entry.store);
    try{
      followup?.beforeRegistration();q.registerIssueImplementation(id,request,definition,observation,work?currentAdoption=>{
        work.beforeRegistration();if(currentAdoption!==request.adoptedScope.adoption)throw new Error('implementation_scope_adoption_changed');if(work.uniqueFirst){const existing=this.projectWorkOriginal(q,id,entry,body.issueNumber,currentAdoption!);if(existing&&existing.id!==body.requestId)throw new Error('implementation_project_work_original_exists');}
      }:undefined);
      work?.afterRegistration();
      const current=q.tasks().current(task),candidate=current.manifest.candidate,authority=q.authority(),baseline=authority.forScope(current.context.scope.id,{item:task,target:definition.target}),adoption=baseline.currentAdoption;
      if(!adoption||adoption!==request.adoptedScope.adoption)throw new Error('implementation_scope_adoption_changed');
      const adoptedScope=authority.inspectRecordedDecision(adoption).proposal as Row,scopeBodySha256=hash(canonical(adoptedScope.body));
      const prefix='implementation-'+hash(canonical([id,body.requestId])).slice(0,40),implementIntent=prefix+'-implement',testIntent=prefix+'-test';
      const action=(kind:'implement'|'test'):ActionRequest=>({schemaVersion:1,scopeId:current.context.scope.id,scopeVersion:current.context.scope.version,scopeBodySha256,repository:entry.repository,target:definition.target,action:kind,item:task,candidate:{H:candidate.H,B:candidate.B,subjectSha256:null},paths:kind==='implement'?entry.allowedPaths:entry.materialPaths,resourceRefs:entry.budgets.filter(b=>b.action===kind).map(b=>b.resourceRef),...(kind==='test'?{payloadSha256:entry.testPlanSha256}:{})});
      const actions={implement:action('implement'),test:action('test')};
      work?.beforeRegistration();return this.publicState(q.issueImplementations().bind(id,body.requestId,{catalogSha256:this.catalogHash(entry.id),path:prepared.plan,sha256:hash(planBytes),operationRoot:prepared.operation,workspace,executionKind:entry.executionKind,actions,implementIntent,testIntent,budgets:entry.budgets,authorization:entry.authorization,request}));
    }finally{q.close();}
  }
  private projectWorkOriginal(q:QueueStore,id:string,entry:Entry,issueNumber:number,adoption?:string){
    const adopted=entry.approvedIssues.find(i=>i.number===issueNumber);if(!adopted)throw new Error('implementation_issue_not_adopted');
    const matches=q.issueImplementations().requests(id).filter(s=>{
      const r=q.issueImplementations().original(id,s.id);if(r.continuation||s.issue!==issueNumber||s.result?.status==='cancelled_unstarted'||r.issue.bodySha256!==adopted.bodySha256||r.workspaceRequest.candidate.H!==entry.H0||r.workspaceRequest.objects!==entry.objects)return false;
      return (adoption??q.authority().forScope(entry.context.scope.id,{item:s.task,target:entry.target}).currentAdoption)===r.adoptedScope.adoption;
    });
    if(matches.length>1)throw new Error('implementation_project_work_original_ambiguous');return matches[0]??null;
  }
  private projectWorkState(q:QueueStore,entry:ReadEntry,issueNumber:number,request:ProjectWorkRequest){
    const {origin,original}=request;if(!projectWorkOrigin(origin,origin.requestId))throw new Error('project_work_origin_invalid');
    const requestId=original?.requestId??origin.requestId,state=q.issueImplementations().requests(entry.id).find(s=>s.id===requestId);
    if(!state){if(original)throw new Error('project_work_original_not_registered');return null;}
    const fixed=q.issueImplementations().original(entry.id,requestId),definition=q.tasks().definition(fixed.task);
    if(fixed.continuation||state.issue!==issueNumber||definition.repository.toLowerCase()!==entry.repository.toLowerCase()||definition.target!==entry.target||
      (original?.linked?requestId===origin.requestId:requestId!==origin.requestId||canonical(fixed.origin??null)!==canonical(origin)))throw new Error('project_work_original_mismatch');
    return state;
  }
  /** Only a saved user work request calls this host consumer. Original task
   * registration remains the final serial check, including concurrent chats. */
  async coordinateProjectWork(id:string,issueNumber:number,request:ProjectWorkRequest,checkpoint:(link?:ProjectWorkLink)=>void){
    const {origin}=request;if(!projectWorkOrigin(origin,origin.requestId))throw new Error('project_work_origin_invalid');await this.catalog();await this.verify();const entry=this.entry(id);
    for(let attempt=0;attempt<2;attempt++){
      const q=await QueueStore.open(entry.store);let previous:Row|null,link:ProjectWorkLink;try{
        previous=this.projectWorkState(q,entry,issueNumber,request)??this.projectWorkOriginal(q,id,entry,issueNumber);
        link={requestId:previous?.id??origin.requestId,linked:!!previous&&previous.id!==origin.requestId};
        if(previous)this.projectWorkState(q,entry,issueNumber,{origin,original:link});
      }finally{q.close();}
      checkpoint(previous?link:undefined);
      let prepared:Row;try{prepared=await this.prepareSelected(id,{requestId:link.requestId,issueNumber},undefined,{...(link.linked?{}:{origin}),beforeRegistration:()=>checkpoint(),afterRegistration:()=>checkpoint(link),uniqueFirst:!previous});}
      catch(error){if((error as Error).message==='implementation_project_work_original_exists'&&attempt===0)continue;throw error;}
      checkpoint(link);if(!prepared.status&&!prepared.stopped)await this.begin(id,link.requestId);return link;
    }
    throw new Error('implementation_project_work_original_changed');
  }
  async readProjectWork(id:string,issueNumber:number,request:ProjectWorkRequest){
    if(!projectWorkOrigin(request.origin,request.origin?.requestId))throw new Error('project_work_origin_invalid');
    const {entry,historical}=await this.readEntry(id,request.original?.requestId??request.origin.requestId),q=await QueueStore.open(entry.store);let s:Row,resourcesSettled=false;try{const checked=this.projectWorkState(q,entry,issueNumber,request);if(!checked)return null;s=checked;if(s.result)resourcesSettled=(s.plan?.resourceRequests??[]).every((resource:string)=>{try{const state=q.issueImplementations().terminalResource(id,s.id,resource);return !state||s.result.status==='cancelled_unstarted'&&['prepared_not_sent','refused'].includes(state.state)||!!q.resources().settledOutcome(resource);}catch{return false;}});}finally{q.close();}
    // Capture liveness alongside the resource snapshot. Reading the complete
    // report may yield while the controller settles resources and exits.
    const state=this.publicState(s),report=s.result?.completeCapture?await readImplementationResult(s):null;
    return {...state,operation:s.operation,resourcesSettled,originPrepared:!!s.plan?.request.origin,originIncludedInCompleteCapture:!!report&&!!s.plan?.request.origin,report:report?{status:report.status,H0:report.H0,H1:report.H1,report:report.report,completeCapture:report.completeCapture}:null,permissionsGranted:false,...(historical?{historical:true}:{})};
  }
  async cancelProjectWork(id:string,issueNumber:number,request:ProjectWorkRequest){
    // Even without a saved chat link, inspect the queue after the cancellation
    // fence. Registration may have committed in the other database. A matching
    // ID is only a lookup hint; the immutable target/origin must also match.
    const entry=this.entry(id),q=await QueueStore.open(entry.store);let s:Row|null;try{s=this.projectWorkState(q,entry,issueNumber,request);}finally{q.close();}
    if(!s)return {cancelled:true,originalRegistered:false,newModelInputs:0};
    if(s.result&&s.result.status!=='cancelled_unstarted')throw new Error('project_work_original_already_ended');
    return {cancelled:true,originalRegistered:true,original:await this.cancel(id,s.id),newModelInputs:0};
  }
  async stopProjectWork(id:string,issueNumber:number,request:ProjectWorkRequest){const entry=this.entry(id),q=await QueueStore.open(entry.store);let s:Row|null;try{s=this.projectWorkState(q,entry,issueNumber,request);}finally{q.close();}if(!s)throw new Error('project_work_original_not_registered');return this.stop(id,s.id);}
  private publicState(s:Row){return {sourceId:'implementation-'+hash(canonical([s.source,s.id])).slice(0,32),id:s.id,task:s.task,logicalOwner:s.logicalOwner,supplement:s.supplement,issue:s.issue,H0:s.H0,H1:s.result?.H1??null,phase:s.phase,reason:s.reason,controllerActive:this.active.has(s.source+':'+s.id),status:s.result?.status??null,stopped:s.stopped,completeCapture:s.result?.completeCapture===true};}
  async taskSources(){const sources:Array<{id:string;title:string;store:string;item:string}>=[];for(const entry of this.entries){const q=await QueueStore.open(entry.store);try{for(const state of q.issueImplementations().requests(entry.id)){if(q.issueImplementations().original(entry.id,state.id).continuation)continue;const definition=q.tasks().definition(state.task);if(definition.repository.toLowerCase()!==entry.repository.toLowerCase())throw new Error('implementation_project_binding_changed');sources.push({id:'implementation-'+hash(canonical([entry.id,state.id])).slice(0,32),title:'Issue #'+state.issue+' · '+definition.title,store:entry.store,item:state.task});}}finally{q.close();}}return sources;}
  async state(){return Promise.all(this.entries.map(async entry=>{const q=await QueueStore.open(entry.store);try{return {id:entry.id,requests:q.issueImplementations().requests(entry.id).map(s=>this.publicState(s))};}finally{q.close();}}));}
  async begin(id:string,requestId:string){
    if(!this.accepting||!messageId(requestId))throw new Error('implementation_request_invalid');await this.catalog();this.entry(id);if(this.retired.has(id))throw new Error('implementation_prepared_work_retired');const key=id+':'+requestId;
    if(this.active.has(key))return {id:requestId,controllerActive:true,duplicate:true};
    const work=this.execute(id,requestId).then(async result=>{if(['completed','no_change'].includes(result?.result?.status)&&this.finished){const q=await QueueStore.open(this.entry(id).store);let target:SupplementTarget;try{const request=q.issueImplementations().original(id,requestId);target=request.continuation?.originalTarget??{source:id,requestId,task:request.task,operation:result.operation};}finally{q.close();}await this.finished(target);}return result;});this.active.set(key,work);work.catch(()=>{}).finally(()=>this.active.delete(key));return {id:requestId,controllerActive:true,registrationIsNotExecution:true};
  }
  private async execute(id:string,requestId:string){
    const entry=this.entry(id),q=await QueueStore.open(entry.store);let observations:OwnerObservation[]=[];
    try{
      const original=q.issueImplementations().state(id,requestId);if(original.result||original.phase==='active_or_unknown')return original;
      if(!original.plan)throw new Error('implementation_preparation_incomplete');const fixed=original.plan;
      return await withQueueRepairLock(entry.store,original.operation,async()=>{
        const refresh=async()=>{
          if(fixed.request.continuation)await this.checkSupplementPredecessor(entry,fixed.request);await this.catalog();if(fixed.catalogSha256!==this.catalogHash(entry.id))throw new Error('implementation_original_catalog_changed');await this.verify();const issue=await this.read(original.issue);if(hash(issue.body)!==fixed.request.issue.bodySha256)throw new Error('implementation_issue_source_changed');
          const authority=q.authority(),profile=authority.configuration().profile,refs=new Map<string,ReturnType<typeof authority.sourceRequests>[number]>();
          for(const authorization of Object.values(fixed.authorization) as string[])for(const ref of authority.sourceRequests(authorization))refs.set(ref.proposalSha256,ref);
          const root=join(entry.store,'implementation-authority',randomUUID());await mkdir(root,{recursive:true,mode:0o700});observations=[];
          for(const ref of refs.values())observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,ref.proposalSha256)));
          for(const resource of fixed.resourceRequests as string[]){let state:Row;try{state=q.resources().status(resource);}catch(error){if((error as Error).message==='original_resource_request_required')continue;throw error;}if(!['prepared_not_sent','refused'].includes(state.state))await resourceAction(entry.store,resource,'lookup','implementer');}
        };
        await refresh();const authority=q.authority();
        authority.reserveAction(fixed.implementIntent,fixed.actions.implement,'implementer',fixed.authorization.implement,observations);authority.reserveAction(fixed.testIntent,fixed.actions.test,'implementer',fixed.authorization.test,observations);
        for(const request of fixed.resourceRequestDefinitions as Row[]){const prepared=await prepareResourceRequest(entry.store,Buffer.from(canonical(request)),'implementer');if(prepared.state==='prepared_not_sent')await resourceAction(entry.store,prepared.id,'claim','implementer');}
        await refresh();
        q.issueImplementations().problem(id,requestId,'');
        const accepting=()=>{if(!this.accepting)throw new Error('implementation_controller_closing');};
        const result=await runIssueImplementation(fixed.path,fixed.sha256,fixed.request,fixed.operationRoot,{refresh,unsent:()=>{accepting();q.issueImplementations().unsent(id,requestId,observations);},check:effect=>{accepting();q.issueImplementations().check(id,requestId,observations,effect);},dispatch:()=>q.issueImplementations().dispatch(id,requestId,observations)});
        const state=q.issueImplementations().complete(id,requestId,result);
        if(result.status==='completed'){const definition=q.tasks().definition(fixed.request.task);q.tasks().observe(definition,await observeTaskWorkspace(definition));}
        for(const resource of fixed.resourceRequests as string[])await resourceAction(entry.store,resource,'record-result','implementer');
        return state;
      });
    }catch(error){q.issueImplementations().problem(id,requestId,error instanceof Error?error.message:'implementation_unknown');throw error;}finally{q.close();}
  }
  async cancel(id:string,requestId:string){const entry=this.entry(id),q=await QueueStore.open(entry.store);try{
    const request=q.issueImplementations().original(id,requestId);if(request.continuation)await this.checkSupplementPredecessor(entry,request,false);
    q.issueImplementations().cancel(id,requestId);const state=q.issueImplementations().state(id,requestId);
    for(const resource of state.plan?.resourceRequests??[]){try{let value=q.issueImplementations().terminalResource(id,requestId,resource);if(!value)continue;if(value.pendingResultAttempt)value=await resourceAction(entry.store,resource,'lookup','implementer');if(value.claim?.state==='held')await resourceAction(entry.store,resource,'record-result','implementer');}catch(error){q.issueImplementations().problem(id,requestId,error instanceof Error?error.message:'implementation_resource_result_pending');}}
    return this.publicState(q.issueImplementations().state(id,requestId));
  }finally{q.close();}}
  async stop(id:string,requestId:string){const entry=this.entry(id),q=await QueueStore.open(entry.store);try{return this.publicState(q.issueImplementations().stop(id,requestId));}finally{q.close();}}
  async report(id:string,requestId:string){const entry=this.entry(id),q=await QueueStore.open(entry.store);try{
    const state=q.issueImplementations().state(id,requestId);if(!state.result){if(!state.plan)throw new Error('implementation_original_report_not_available');return {id:state.id,task:state.task,issue:state.issue,operation:state.operation,status:'partial_or_unknown',completeCapture:false,H0:state.H0,H1:null,report:null,reason:state.reason,diff:await git(state.plan.workspace,['diff','--no-ext-diff','--no-textconv',state.H0,'--',...state.plan.request.workspaceRequest.allowedPaths]),observationOnly:true,originalExecutionRetained:true};}
    return readImplementationResult(state);
  }finally{q.close();}}
  async ownerFeedbackTarget(store:string,target:ImplementationOwnerTarget){
    if(!implementationOwnerTarget(target))throw new Error('owner_feedback_target_invalid');await this.catalog();await this.verify();const entry=this.entry(target.source);if(entry.store!==store)throw new Error('owner_feedback_target_queue_mismatch');
    const q=await QueueStore.open(store);try{const s=q.implementationOwnerSnapshot(target);if(s.state.task!==target.task||s.state.operation!==target.operation||s.state.requestSha256!==target.requestSha256||s.definition.repository.toLowerCase()!==entry.repository.toLowerCase()||canonical(s.definition.context.scope)!==canonical(entry.context.scope))throw new Error('owner_feedback_original_target_changed');return {target,logicalOwner:s.state.logicalOwner};}finally{q.close();}
  }
  async ownerFeedbackProof(store:string,target:ImplementationOwnerTarget):Promise<ImplementationOwnerProof>{
    await this.ownerFeedbackTarget(store,target);const q=await QueueStore.open(store);try{
      const snapshot=q.implementationOwnerSnapshot(target),issue=await this.read(snapshot.request.issue.number);
      if(hash(issue.body)!==snapshot.request.issue.bodySha256)throw new Error('owner_feedback_adopted_requirement_changed');
      const proof=await readImplementationOwnerProof(snapshot);q.tasks().observe(proof.definition,proof.observation);return proof;
    }finally{q.close();}
  }
  private async checkSupplementPredecessor(entry:ReadEntry,request:ImplementationRequest,current=true){
    const continuation=request.continuation!;
    const target=continuation.originalTarget,source=entry.id,q=await QueueStore.open(entry.store);try{
      const records=q.issueImplementations(),fixed=records.original(source,request.id),root=records.state(source,target.requestId),rootRequest=records.original(source,target.requestId),parent=records.state(source,continuation.predecessor.requestId),parentRequest=records.original(source,parent.id);
      if(target.source!==source||canonical(fixed)!==canonical(request)||rootRequest.continuation||root.task!==continuation.logicalOwner||root.task!==target.task||root.operation!==target.operation||request.id!==continuation.supplement.id||request.issue.number!==root.issue||request.workspaceRequest.candidate.H!==continuation.predecessor.H1||request.workspaceRequest.objects!==parent.plan?.workspace||parent.operation!==continuation.predecessor.operation||parent.result?.status!=='completed'||!parent.result.completeCapture||parent.result.H1!==continuation.predecessor.H1||hash(canonical(parent.result))!==continuation.predecessor.resultSha256||parent.id!==root.id&&(parentRequest.continuation?.logicalOwner!==root.task||canonical(parentRequest.continuation.originalTarget)!==canonical(target)))throw new Error('project_supplement_predecessor_changed');
      await readImplementationResult(parent);
      if(current){
        for(const resource of parent.plan.resourceRequests as string[])if(!q.resources().settledOutcome(resource))throw new Error('implementation_original_resources_unresolved');
        if(await exists(join(parent.plan.workspace,'.git','tongxu-writer.json'))||await git(parent.plan.workspace,['rev-parse','HEAD'])!==parent.result.H1||treeHash(await tree(parent.plan.workspace,true))!==parent.result.treeSha256||await git(parent.plan.workspace,['status','--porcelain','--untracked-files=all','--ignored']))throw new Error('project_supplement_committed_result_changed');
      }
    }finally{q.close();}
  }
  private async boundSupplement(target:SupplementTarget,id:string,text:string,entry:ReadEntry=this.entry(target.source)){
    const q=await QueueStore.open(entry.store);let request:ImplementationRequest;
    try{
      request=q.issueImplementations().original(target.source,id);const continuation=request.continuation;
      if(!continuation||continuation.logicalOwner!==target.task||canonical(continuation.originalTarget)!==canonical(target)||canonical(continuation.supplement)!==canonical({id,text}))throw new Error('project_supplement_compiled_target_changed');
    }finally{q.close();}
    // Identity and original capture must also hold for history/cancellation;
    // a later workspace edit blocks sending, but must not block unsent cancel.
    await this.checkSupplementPredecessor(entry,request,false);return request;
  }
  async cancelSupplement(target:SupplementTarget,id:string,text:string){
    const q=await QueueStore.open(this.entry(target.source).store);
    try{if(!q.issueImplementations().requests(target.source).some(r=>r.id===id))return;}finally{q.close();}
    await this.boundSupplement(target,id,text);return this.cancel(target.source,id);
  }
  async supplementTargets(){const targets:Array<SupplementTarget&{title:string}>=[];for(const entry of this.entries){if(this.retired.has(entry.id))continue;const q=await QueueStore.open(entry.store);try{for(const s of q.issueImplementations().requests(entry.id)){const request=q.issueImplementations().original(entry.id,s.id);if(!request.continuation&&s.operation)targets.push({source:entry.id,requestId:s.id,task:s.task,operation:s.operation,title:'Issue #'+s.issue+' · '+q.tasks().definition(s.task).title});}}finally{q.close();}}return targets;}
  private async supplementSource(target:SupplementTarget){
    await this.catalog();await this.verify();const entry=this.entry(target.source),q=await QueueStore.open(entry.store);
    try{const records=q.issueImplementations(),root=records.state(entry.id,target.requestId),rootRequest=records.original(entry.id,target.requestId);if(root.task!==target.task||root.operation!==target.operation||rootRequest.continuation)throw new Error('project_supplement_original_target_changed');
      const family=records.requests(entry.id).filter(s=>(s.id===root.id||records.original(entry.id,s.id).continuation?.logicalOwner===root.task)&&s.result?.status!=='cancelled_unstarted'),last=family.at(-1)??root,latest=last.result?.status==='no_change'?[...family].reverse().find(s=>s.result?.status==='completed')??last:last,request=records.original(entry.id,latest.id);
      if(latest.stopped||latest.result?.status!=='completed'||!latest.result?.H1||!latest.result.completeCapture)return {entry,root,rootRequest,latest,request,ready:false,reason:latest.reason??(latest.stopped?'implementation_stopped':latest.result?'project_supplement_requires_successful_commit':'project_supplement_original_pending_or_unknown')};
      await this.report(entry.id,latest.id);for(const resource of latest.plan.resourceRequests as string[])if(!q.resources().settledOutcome(resource))return {entry,root,rootRequest,latest,request,ready:false,reason:'implementation_original_resources_unresolved'};
      const workspace=latest.plan.workspace;if(await exists(join(workspace,'.git','tongxu-writer.json'))||await git(workspace,['rev-parse','HEAD'])!==latest.result.H1||treeHash(await tree(workspace,true))!==latest.result.treeSha256||await git(workspace,['status','--porcelain','--untracked-files=all','--ignored']))throw new Error('project_supplement_committed_result_changed');
      return {entry,root,rootRequest,latest,request,ready:true,reason:null};
    }finally{q.close();}
  }
  async readSupplement(target:SupplementTarget,compiled:string|null,text:string):Promise<Row>{
    if(!compiled){const original=await this.supplementSource(target);return {ready:original.ready,reason:original.reason,originalOperation:original.root.operation,predecessorOperation:original.latest.operation,H1:original.latest.result?.H1??null};}
    const {entry,historical}=await this.readEntry(target.source,target.requestId);
    const request=await this.boundSupplement(target,compiled,text,entry);
    const q=await QueueStore.open(entry.store);
    try{
      let original:{ready:boolean;reason:string|null}={ready:false,reason:null};
      if(!historical)try{original=await this.supplementSource(target);}catch(error){original={ready:false,reason:error instanceof Error?error.message:'project_supplement_original_pending_or_unknown'};}
      const state=q.issueImplementations().state(target.source,compiled);
      if(historical){
        const definition=q.tasks().definition(state.task);
        if(definition.repository.toLowerCase()!==entry.repository.toLowerCase()||definition.target!==entry.target||request.workspaceRequest.candidate.target!==entry.target)throw new Error('implementation_history_project_mismatch');
        if(!['completed','no_change'].includes(state.result?.status)||!state.result.completeCapture)throw new Error('implementation_history_incomplete');
      }
      const report=state.result?.completeCapture?await readImplementationResult(state):null;
      return {ready:false,successful:!historical&&['completed','no_change'].includes(state.result?.status)&&original.ready,status:state.phase,reason:state.reason||original.reason,operation:state.operation,task:state.task,H0:state.H0,H1:state.result?.H1??null,completeCapture:state.result?.completeCapture===true,report:report?.report??null,sessionId:report?.sessionId??null,newNativeContext:true,nativeSessionResumed:false,...(historical?{historical:true}:{})};
    }finally{q.close();}
  }
  async workSupplement(target:SupplementTarget,id:string,text:string,beforeRegistration:()=>void){
    await this.catalog();await this.verify();if(this.retired.has(target.source))throw new Error('implementation_prepared_work_retired');const entry=this.entry(target.source),q=await QueueStore.open(entry.store);let existing:ImplementationRequest|undefined;
    try{if(q.issueImplementations().requests(target.source).some(r=>r.id===id))existing=q.issueImplementations().original(target.source,id);}finally{q.close();}
    if(existing){
      await this.boundSupplement(target,id,text);beforeRegistration();
      await this.prepareSelected(target.source,{requestId:id,issueNumber:existing.issue.number},{entry,continuation:existing.continuation!,beforeRegistration});
    }else{
      const source=await this.supplementSource(target);if(!source.ready)throw new Error(source.reason??'project_supplement_original_pending_or_unknown');
      const queue=await QueueStore.open(entry.store),history:NonNullable<ImplementationRequest['continuation']>['history']=[];
      try{
        // Keep reports flat and supplement strings opaque; never copy request envelopes.
        for(const s of queue.issueImplementations().requests(target.source)){const request=queue.issueImplementations().original(target.source,s.id);if(s.id!==source.root.id&&request.continuation?.logicalOwner!==target.task)continue;if(s.result?.status==='cancelled_unstarted')continue;if(!['completed','no_change'].includes(s.result?.status))throw new Error('project_supplement_original_pending_or_unknown');const result=await this.report(target.source,s.id);history.push({requestId:s.id,operation:s.operation,H0:s.H0,H1:result.H1??result.H0,sessionId:result.sessionId,report:result.report,...(request.continuation?{supplement:request.continuation.supplement}:{})});}
      }finally{queue.close();}
      const continuation:NonNullable<ImplementationRequest['continuation']>={logicalOwner:target.task,originalTarget:target,predecessor:{requestId:source.latest.id,operation:source.latest.operation,H1:source.latest.result.H1,resultSha256:hash(canonical(source.latest.result))},supplement:{id,text},history};if(Buffer.byteLength(canonical(continuation))>192*1024||history.length>32)throw new Error('project_supplement_context_limit');
      await this.prepareSelected(target.source,{requestId:id,issueNumber:source.root.issue},{entry:{...entry,H0:source.latest.result.H1,objects:source.latest.plan.workspace},continuation,beforeRegistration});
    }
    await this.boundSupplement(target,id,text);
    try{beforeRegistration();}catch(error){await this.cancelSupplement(target,id,text);throw error;}await this.begin(target.source,id);return id;
  }
  async drain(){this.accepting=false;await Promise.allSettled(this.active.values());}
}
