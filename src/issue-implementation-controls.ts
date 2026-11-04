import {readRepairSession} from './repair-native.js';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,git} from './repair-workspace.js';
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
type Row=Record<string,any>;
type Entry={id:string;repository:string;store:string;root:string;objects:string;H0:string;base:string;target:string;context:QueueContext;config:{path:string;sha256:string};allowedPaths:string[];materialPaths:string[];protectedPaths:string[];testPlan:string;testPlanSha256:string;approvedIssues:Array<{number:number;bodySha256:string;adjudication:string;goal:string;acceptance:string[]}>;authorization:{implement:string;test:string};budgets:Array<{action:'implement'|'test';ledgerId:string;resourceRef:string;unit:string;quantity:number}>;executionKind:'fixture'|'native_capture';demonstrationFixture:boolean};
type Issue={number:number;title:string;body:string;url:string};
type Reader=(number:number)=>Promise<Issue>;

/** Trusted installation fixes the project, source, adopted Issue, tests and
 * scope. The browser supplies only an option and a stable request identity. */
export class IssueImplementationControls{
  private active=new Map<string,Promise<unknown>>();private accepting=true;
  private constructor(private path:string,private sha256:string,private entries:Entry[],private read:Reader,private verify:()=>Promise<void>){}
  static async load(path:string,sha256:string,repository:string,read:Reader,verify:()=>Promise<void>){
    const bytes=await regular(path,128*1024),p=JSON.parse(bytes.toString());
    if(hash(bytes)!==sha256||!exactKeys(p,['schemaVersion','kind','entries'])||p.schemaVersion!==1||p.kind!=='tongxu-issue-implementation-catalog'||!Array.isArray(p.entries)||p.entries.length>8)throw new Error('implementation_catalog_invalid');
    const entries=p.entries.filter((e:Entry)=>e.repository?.toLowerCase()===repository.toLowerCase()) as Entry[];
    for(const e of entries){
      if(!exactKeys(e,['id','repository','store','root','objects','H0','base','target','context','config','allowedPaths','materialPaths','protectedPaths','testPlan','testPlanSha256','approvedIssues','authorization','budgets','executionKind','demonstrationFixture'])||!messageId(e.id)||![e.store,e.root,e.objects,e.config?.path,e.testPlan].every(path=>typeof path==='string'&&resolve(path)===path)||!isAuthorityDigest(e.config.sha256)||!isAuthorityDigest(e.testPlanSha256)||![e.H0,e.base].every(x=>/^[a-f0-9]{40}$/.test(x))||typeof e.demonstrationFixture!=='boolean'||!['fixture','native_capture'].includes(e.executionKind)||!Array.isArray(e.approvedIssues)||!e.approvedIssues.length||e.approvedIssues.length>32||!exactKeys(e.authorization,['implement','test'])||!Object.values(e.authorization).every(isAuthorityDigest)||!Array.isArray(e.budgets)||e.budgets.length>16||e.budgets.some(b=>!exactKeys(b,['action','ledgerId','resourceRef','unit','quantity'])||!['implement','test'].includes(b.action)))throw new Error('implementation_entry_invalid');
      e.context=parseQueueContext(e.context);if(new Set(e.approvedIssues.map(issue=>issue.number)).size!==e.approvedIssues.length)throw new Error('implementation_duplicate_adopted_issue');
      for(const issue of e.approvedIssues)if(!exactKeys(issue,['number','bodySha256','adjudication','goal','acceptance'])||!Number.isSafeInteger(issue.number)||issue.number<1||!isAuthorityDigest(issue.bodySha256)||!issue.adjudication?.trim()||!issue.goal?.trim()||!Array.isArray(issue.acceptance)||!issue.acceptance.length)throw new Error('implementation_adopted_issue_required');
    }
    if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new Error('implementation_duplicate_entry');
    return new IssueImplementationControls(path,sha256,entries,read,verify);
  }
  private entry(id:string){const entry=this.entries.find(e=>e.id===id);if(!entry)throw new Error('implementation_project_not_selected');return entry;}
  private async catalog(){if(hash(await regular(this.path,128*1024))!==this.sha256)throw new Error('implementation_catalog_changed');}
  options(){return this.entries.map(e=>({id:e.id,issues:e.approvedIssues.map(i=>({number:i.number,goal:i.goal,adjudication:i.adjudication,bodySha256:i.bodySha256})),H0:e.H0,allowedPaths:e.allowedPaths,executionKind:e.executionKind,demonstrationFixture:e.demonstrationFixture}));}
  async prepare(id:string,body:Row){
    try{return await this.prepareSelected(id,body);}catch(error){
      const entry=this.entries.find(e=>e.id===id);if(entry&&messageId(body?.requestId)){
        const q=await QueueStore.open(entry.store);try{if(q.issueImplementations().requests(id).some(r=>r.id===body.requestId))q.issueImplementations().problem(id,body.requestId,error instanceof Error?error.message:'implementation_preparation_failed');}finally{q.close();}
      }
      throw error;
    }
  }
  private async prepareSelected(id:string,body:Row){
    if(!this.accepting||!exactKeys(body,['requestId','issueNumber'])||!messageId(body.requestId)||!Number.isSafeInteger(body.issueNumber))throw new Error('implementation_start_request_invalid');
    await this.catalog();await this.verify();const entry=this.entry(id),adopted=entry.approvedIssues.find(i=>i.number===body.issueNumber);if(!adopted)throw new Error('implementation_issue_not_adopted');
    const previousQueue=await QueueStore.open(entry.store);let original:ImplementationRequest|undefined,originalTitle:string|undefined;
    try{const previous=previousQueue.issueImplementations().requests(id).find(r=>r.id===body.requestId);if(previous){
      if(previous.issue!==body.issueNumber)throw new Error('implementation_request_id_is_fixed');
      if(previous.phase!=='registered'||previous.stopped)return this.publicState(previous);
      original=previousQueue.issueImplementations().original(id,body.requestId);originalTitle=previousQueue.tasks().definition(original.task).title;
    }}finally{previousQueue.close();}
    const issue=await this.read(adopted.number);if(issue.number!==adopted.number||hash(issue.body)!==adopted.bodySha256)throw new Error('implementation_issue_source_changed');
    const root=join(entry.root,body.requestId),workspace=join(root,'workspace');
    const definition=parseDevelopmentTask(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-development-task',id:'implementation-'+body.requestId,repository:entry.repository,title:originalTitle??issue.title,goal:adopted.goal,acceptance:adopted.acceptance,source:issue.url+' body sha256 '+adopted.bodySha256,issue:issue.number,context:entry.context,workspace,base:entry.base,target:entry.target,paths:entry.materialPaths})));
    const task=developmentTaskId(definition);
    const scopeQueue=await QueueStore.open(entry.store);let adoptedScope:ImplementationRequest['adoptedScope'];try{const authority=scopeQueue.authority(),adoption=authority.forScope(entry.context.scope.id,{item:task,target:entry.target}).currentAdoption;if(!adoption)throw new Error('implementation_scope_adoption_required');const original=authority.inspectRecordedDecision(adoption);if(original.proposal.kind!=='adopt_scope')throw new Error('implementation_scope_adoption_required');adoptedScope={adoption,body:original.proposal.body,bodySha256:hash(canonical(original.proposal.body)),source:original.source.sourceUrl};}finally{scopeQueue.close();}
    const workspaceRequest:ProjectRequest={schemaVersion:1,kind:'tongxu-project-repair-request',executionRoot:root,objects:entry.objects,candidate:{kind:'local-git',repository:'local/issue-implementation-source',pr:null,H:entry.H0,B:entry.base,target:entry.target},allowedPaths:entry.allowedPaths,materialPaths:entry.materialPaths,protectedPaths:entry.protectedPaths,contract:adopted.goal,testPlan:entry.testPlan,testPlanSha256:entry.testPlanSha256,findings:[],authorization:{source:issue.url+' adopted requirement; actual implement/test permission checked by original authority consumer',allowRepair:true,allowReconcileEnded:false,maxRepairRounds:1},demonstrationFixture:entry.demonstrationFixture,generatedDirectories:[]};
    const request:ImplementationRequest={schemaVersion:1,kind:'tongxu-issue-implementation',id:body.requestId,task,adoptedScope,issue:{number:issue.number,body:issue.body,bodySha256:adopted.bodySha256,adjudication:adopted.adjudication},workspaceRequest};
    if(original&&canonical(request)!==canonical(original))throw new Error('implementation_request_id_is_fixed');
    const executorBytes=await regular(entry.config.path);if((JSON.parse(executorBytes.toString()).executionKind??'native_capture')!==entry.executionKind)throw new Error('implementation_executor_kind_mismatch');
    if(hash(executorBytes)!==entry.config.sha256)throw new Error('implementation_executor_changed');
    await mkdir(entry.root,{recursive:true,mode:0o700});await privateDirectory(entry.root,false);const prepared=await prepareIssueImplementation(entry.config.path,request,root),planBytes=await regular(prepared.plan),observation=await observeTaskWorkspace(definition);
    const q=await QueueStore.open(entry.store);
    try{
      q.registerIssueImplementation(id,request,definition,observation);
      const current=q.tasks().current(task),candidate=current.manifest.candidate,authority=q.authority(),baseline=authority.forScope(current.context.scope.id,{item:task,target:definition.target}),adoption=baseline.currentAdoption;
      if(!adoption||adoption!==request.adoptedScope.adoption)throw new Error('implementation_scope_adoption_changed');
      const adoptedScope=authority.inspectRecordedDecision(adoption).proposal as Row,scopeBodySha256=hash(canonical(adoptedScope.body));
      const prefix='implementation-'+hash(canonical([id,body.requestId])).slice(0,40),implementIntent=prefix+'-implement',testIntent=prefix+'-test';
      const action=(kind:'implement'|'test'):ActionRequest=>({schemaVersion:1,scopeId:current.context.scope.id,scopeVersion:current.context.scope.version,scopeBodySha256,repository:entry.repository,target:definition.target,action:kind,item:task,candidate:{H:candidate.H,B:candidate.B,subjectSha256:null},paths:kind==='implement'?entry.allowedPaths:entry.materialPaths,resourceRefs:entry.budgets.filter(b=>b.action===kind).map(b=>b.resourceRef),...(kind==='test'?{payloadSha256:entry.testPlanSha256}:{})});
      const actions={implement:action('implement'),test:action('test')};
      return this.publicState(q.issueImplementations().bind(id,body.requestId,{catalogSha256:this.sha256,path:prepared.plan,sha256:hash(planBytes),operationRoot:prepared.operation,workspace,executionKind:entry.executionKind,actions,implementIntent,testIntent,budgets:entry.budgets,authorization:entry.authorization,request}));
    }finally{q.close();}
  }
  private publicState(s:Row){return {sourceId:'implementation-'+hash(canonical([s.source,s.id])).slice(0,32),id:s.id,task:s.task,issue:s.issue,H0:s.H0,H1:s.result?.H1??null,phase:s.phase,reason:s.reason,controllerActive:this.active.has(s.source+':'+s.id),status:s.result?.status??null,stopped:s.stopped,completeCapture:s.result?.completeCapture===true};}
  async taskSources(){const sources:Array<{id:string;title:string;store:string;item:string}>=[];for(const entry of this.entries){const q=await QueueStore.open(entry.store);try{for(const state of q.issueImplementations().requests(entry.id)){const definition=q.tasks().definition(state.task);if(definition.repository.toLowerCase()!==entry.repository.toLowerCase())throw new Error('implementation_project_binding_changed');sources.push({id:'implementation-'+hash(canonical([entry.id,state.id])).slice(0,32),title:'Issue #'+state.issue+' · '+definition.title,store:entry.store,item:state.task});}}finally{q.close();}}return sources;}
  async state(){return Promise.all(this.entries.map(async entry=>{const q=await QueueStore.open(entry.store);try{return {id:entry.id,requests:q.issueImplementations().requests(entry.id).map(s=>this.publicState(s))};}finally{q.close();}}));}
  async begin(id:string,requestId:string){
    if(!this.accepting||!messageId(requestId))throw new Error('implementation_request_invalid');await this.catalog();this.entry(id);const key=id+':'+requestId;
    if(this.active.has(key))return {id:requestId,controllerActive:true,duplicate:true};
    const work=this.execute(id,requestId);this.active.set(key,work);work.catch(()=>{}).finally(()=>this.active.delete(key));return {id:requestId,controllerActive:true,registrationIsNotExecution:true};
  }
  private async execute(id:string,requestId:string){
    const entry=this.entry(id),q=await QueueStore.open(entry.store);let observations:OwnerObservation[]=[];
    try{
      const original=q.issueImplementations().state(id,requestId);if(original.result||original.phase==='active_or_unknown')return original;
      if(!original.plan)throw new Error('implementation_preparation_incomplete');const fixed=original.plan;
      return await withQueueRepairLock(entry.store,original.operation,async()=>{
        const refresh=async()=>{
          await this.catalog();if(fixed.catalogSha256!==this.sha256)throw new Error('implementation_original_catalog_changed');await this.verify();const issue=await this.read(original.issue);if(hash(issue.body)!==fixed.request.issue.bodySha256)throw new Error('implementation_issue_source_changed');
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
    q.issueImplementations().cancel(id,requestId);const state=q.issueImplementations().state(id,requestId);
    for(const resource of state.plan?.resourceRequests??[]){try{let value=q.resources().status(resource);if(value.pendingResultAttempt)value=await resourceAction(entry.store,resource,'lookup','implementer');if(value.claim?.state==='held')await resourceAction(entry.store,resource,'record-result','implementer');}catch(error){q.issueImplementations().problem(id,requestId,error instanceof Error?error.message:'implementation_resource_result_pending');}}
    return this.publicState(q.issueImplementations().state(id,requestId));
  }finally{q.close();}}
  async stop(id:string,requestId:string){const entry=this.entry(id),q=await QueueStore.open(entry.store);try{return this.publicState(q.issueImplementations().stop(id,requestId));}finally{q.close();}}
  async report(id:string,requestId:string){const entry=this.entry(id),q=await QueueStore.open(entry.store);try{
    const state=q.issueImplementations().state(id,requestId);if(!state.result){if(!state.plan)throw new Error('implementation_original_report_not_available');return {id:state.id,task:state.task,issue:state.issue,operation:state.operation,status:'partial_or_unknown',completeCapture:false,H0:state.H0,H1:null,report:null,reason:state.reason,diff:await git(state.plan.workspace,['diff','--no-ext-diff','--no-textconv',state.H0,'--',...state.plan.request.workspaceRequest.allowedPaths]),observationOnly:true,originalExecutionRetained:true};}
    if(state.result.completeCapture){
      const capture=await readRepairSession(join(state.plan.operationRoot,'implementer')),manifest=JSON.parse((await regular(join(state.plan.operationRoot,'input-manifest.json'))).toString()),{inputManifestSha256,...original}=manifest;
      if(hash(canonical(original))!==inputManifestSha256||capture.binding.inputManifestSha256!==inputManifestSha256||capture.binding.role!=='implementer'||capture.binding.sessionId!==state.result.sessionId||manifest.planSha256!==state.plan.sha256||canonical(manifest.request)!==canonical(state.plan.request)||canonical(JSON.parse(capture.turns.at(-1)!.final!.text))!==canonical(state.result.report))throw new Error('implementation_original_capture_changed');
    }
    return {id:state.id,task:state.task,issue:state.issue,operation:state.operation,...state.result};
  }finally{q.close();}}
  async drain(){this.accepting=false;await Promise.allSettled(this.active.values());}
}
