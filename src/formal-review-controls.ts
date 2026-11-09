import {sourceTick} from './event-tick.js';
import {prepareFormalCandidate} from './formal-candidate.js';
import {mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {regular,exists} from './repair-workspace.js';
import {exactKeys,isAuthorityDigest,safeRelativePath} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {readEventSource,eventMaterialHash,type EventSourceObservation} from './event-source.js';
import {PublicationHttp} from './publication-http.js';
import {assemblePromptSet} from './role-prompts.js';
import {captureRoleAI,withAIPreferences,type AIPreferenceSnapshot} from './ai-settings.js';
import {formalReviewMaterial} from './formal-review-material.js';
import {runFormalReviewRound} from './formal-review.js';
import {QueueFormalRoundHost,type FormalFrozenRequest} from './formal-review-host.js';
import {withQueueRepairLock} from './queue-repair.js';
import type {ProjectRequest} from './project-repair.js';
type Row=Record<string,any>;
type Source={id:string;store:string;item:string};
export type FormalWorkbenchProject={account:number;repository:number;fullName:string};
export type FormalEntry={id:string;source:string;root:string;objects:string;config:{path:string;sha256:string};issue:{number:number;bodySha256:string;adjudication:string};requiredPaths:string[];contextPaths:string[];repair:Pick<ProjectRequest,'allowedPaths'|'materialPaths'|'protectedPaths'|'contract'|'testPlan'|'testPlanSha256'|'generatedDirectories'|'demonstrationFixture'>;authorization:FormalFrozenRequest['authorization'];budgets:FormalFrozenRequest['budgets']};
export type FormalSource={candidate:{repository:string;pr:number;H:string;B:string;target:string};issue:{number:number;body:string;url:string};evidence:unknown;observation?:EventSourceObservation};
export type FormalSourceReader=(entry:FormalEntry,source:Source)=>Promise<FormalSource>;
async function readSource(entry:FormalEntry,source:Source):Promise<FormalSource>{await sourceTick(source.store);const q=await QueueStore.open(source.store);try{const candidate=q.formalReviews().currentSource(source.item).candidate,p=q.events().configuration();if(candidate.repository.toLowerCase()!==p.repository.toLowerCase()||!p.prs.includes(candidate.pr))throw new Error('formal_source_profile_not_selected');const directory=join(entry.root,'source-'+randomUUID());await mkdir(entry.root,{recursive:true,mode:0o700});await privateDirectory(entry.root,false);const o=await readEventSource(p,candidate.pr,directory);if(!o.result.complete||!o.result.candidate)throw new Error('formal_live_source_incomplete');const c=o.result.candidate,issueDirectory=join(entry.root,'issue-'+randomUUID());await privateDirectory(issueDirectory,true);const http=new PublicationHttp(issueDirectory,p.ghExecutable,p.ghSha256,p.repository,candidate.pr,c.H,c.targetRef,true,p.executionKind==='github',{issues:[entry.issue.number],collection:false}),r=await http.request('GET',`repos/${p.repository}/issues/${entry.issue.number}`),issue=r.value;if(r.status!==200||issue.number!==entry.issue.number||typeof issue.body!=='string'||issue.html_url!==`https://github.com/${p.repository}/issues/${entry.issue.number}`)throw new Error('formal_issue_source_invalid');return {observation:o,candidate:{repository:p.repository,pr:c.pr,H:c.H,B:c.B,target:c.targetRef},issue:{number:issue.number,body:issue.body,url:issue.html_url},evidence:{candidateMaterial:q.status().items.filter((i:Row)=>i.candidate.H===c.H&&i.candidate.B===c.B&&i.candidate.targetRef===c.targetRef&&i.candidate.pr===c.pr).map((i:Row)=>({item:i.id,packet:i.currentPacket,summary:{evidenceComplete:i.summary.evidenceComplete,gaps:i.summary.gaps,tree:i.summary.tree,reportId:i.summary.reportId,limitations:i.summary.limitations}})),source:'original_registered_source_get',materialSha256:eventMaterialHash(o.result.semantic),observedAt:o.observedAt,nonAtomicRemoteObservation:true,records:o.records.filter(r=>['pr','comments','inline','reviews','target'].includes(r.kind)).map(r=>({kind:r.kind,page:r.page,endpoint:r.endpoint,bodySha256:hash(r.body),body:JSON.parse(r.body.toString())})),checks:o.result.semantic.checks,statuses:o.result.semantic.statuses}};}finally{q.close();}}
const paths=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(safeRelativePath);
const automaticCheckLimit=360;

/** Only installation configuration selects source, adopted Issue and repair
 * boundaries. The browser chooses one option and an id, never permissions or
 * arbitrary paths. Reads never launch roles or resume an unknown native turn. */
export class FormalReviewControls{
 private active=new Map<string,Promise<unknown>>();private hosts=new Map<string,QueueFormalRoundHost>();private accepting=true;private timer?:ReturnType<typeof setTimeout>;private checking?:Promise<void>;
 private automaticChecks=new Map<string,number>();
 start(){
  if(this.timer||this.checking||!this.accepting)return;
  const schedule=()=>{
   if(!this.accepting)return;
   this.timer=setTimeout(()=>{
    this.timer=undefined;
    this.checking=this.foregroundCheck().finally(()=>{this.checking=undefined;schedule();});
   },10000);
   this.timer.unref();
  };
  schedule();
 }
 private async foregroundCheck(){try{await this.advance(false);}catch{/* The original waiting record is updated by advance; no resend or inferred publication. */}}

 private constructor(private path:string,private sha256:string,private entries:Array<{entry:FormalEntry;source:Source}>,private read:FormalSourceReader,private verify:()=>Promise<void>,private workbenchProject?:FormalWorkbenchProject,private readPreferences?:()=>AIPreferenceSnapshot){}
 static async load(path:string,sha256:string,sources:Source[],selected?:ReadonlySet<string>,read:FormalSourceReader=readSource,verify:()=>Promise<void>=async()=>{},workbenchProject?:FormalWorkbenchProject,readPreferences?:()=>AIPreferenceSnapshot){
  const bytes=await regular(path,128*1024),p=JSON.parse(bytes.toString());if(hash(bytes)!==sha256||!exactKeys(p,['schemaVersion','kind','entries'])||p.schemaVersion!==1||p.kind!=='tongxu-formal-review-catalog'||!Array.isArray(p.entries)||p.entries.length>8)throw new Error('formal_catalog_invalid');
  const entries:Array<{entry:FormalEntry;source:Source}>=[];for(const e of p.entries as FormalEntry[]){if(selected&&!selected.has(e.source))continue;const source=sources.find(s=>s.id===e.source);if(!source||!exactKeys(e,['id','source','root','objects','config','issue','requiredPaths','contextPaths','repair','authorization','budgets'])||!messageId(e.id)||![e.root,e.objects,e.config?.path,e.repair?.testPlan].every(p=>typeof p==='string'&&resolve(p)===p)||!exactKeys(e.config,['path','sha256'])||!isAuthorityDigest(e.config.sha256)||!exactKeys(e.issue,['number','bodySha256','adjudication'])||!Number.isSafeInteger(e.issue.number)||e.issue.number<1||!isAuthorityDigest(e.issue.bodySha256)||!e.issue.adjudication?.trim()||!paths(e.requiredPaths,32)||!paths(e.contextPaths,64)||!exactKeys(e.repair,['allowedPaths','materialPaths','protectedPaths','contract','testPlan','testPlanSha256','generatedDirectories','demonstrationFixture'])||!paths(e.repair.allowedPaths,32)||!paths(e.repair.materialPaths,64)||!paths(e.repair.protectedPaths,128)||!paths(e.repair.generatedDirectories,16)||!isAuthorityDigest(e.repair.testPlanSha256)||typeof e.repair.demonstrationFixture!=='boolean'||!e.repair.contract?.trim()||!exactKeys(e.authorization,['receive','implement','test'])||!Object.values(e.authorization).every(isAuthorityDigest)||!Array.isArray(e.budgets)||e.budgets.length>16||e.budgets.some(b=>!exactKeys(b,['phase','ledgerId','resourceRef','unit','quantity'])||!['analysis','fix','candidate'].includes(b.phase)||!Number.isSafeInteger(b.quantity)||b.quantity<1))throw new Error('formal_entry_invalid');entries.push({entry:e,source});}
  if(new Set(entries.map(e=>e.entry.id)).size!==entries.length)throw new Error('formal_duplicate_entry');return new FormalReviewControls(path,sha256,entries,read,verify,workbenchProject,readPreferences);
 }
 private entry(id:string){const f=this.entries.find(f=>f.entry.id===id);if(!f)throw new Error('formal_entry_not_selected');return f;}
 private async catalog(){if(hash(await regular(this.path,128*1024))!==this.sha256)throw new Error('formal_catalog_changed');await this.verify();}
 private public(s:Row){const r=s.terminal?.result,used=this.automaticChecks.get(s.operation)??0;return {id:s.request.id,operation:s.operation,entry:s.request.entry,round:s.request.round,previousOperation:s.request.previousOperation,item:s.item,candidate:s.request.candidate,phase:r?.status??s.phase,detail:s.detail,stopped:s.stopped,controllerActive:this.active.has(s.operation),automaticContinuation:{used,limit:automaticCheckLimit,exhausted:used>=automaticCheckLimit},resourcesSettled:s.resourcesSettled,executionKind:s.request.executionKind,demonstrationFixture:s.request.project.demonstrationFixture,stages:s.stages.map((s:Row)=>({key:s.stage.key,role:s.stage.role,dispatched:s.dispatched,returned:!!s.returned})),newModelInputs:0};}
 async state(){return Promise.all(this.entries.map(async({entry,source})=>{const q=await QueueStore.open(source.store);try{return {id:entry.id,source:source.id,issue:entry.issue,requests:q.formalReviews().forEntry(entry.id).map(s=>this.public(s))};}finally{q.close();}}));}
 async prepare(id:string,requestId:string,previous?:Row,explicit=true){
  if(!this.accepting||!messageId(requestId))throw new Error('formal_request_invalid');await this.catalog();const {entry,source}=this.entry(id),q=await QueueStore.open(source.store);
  try{const records=q.formalReviews(),prior=records.forEntry(id).find(s=>s.request.id===requestId&&(!previous||s.request.round===previous.request.round+1));if(prior)return this.public(prior);let live=await this.read(entry,source);if(hash(live.issue.body)!==entry.issue.bodySha256)throw new Error('formal_adopted_issue_changed');
   if(this.workbenchProject&&this.workbenchProject.fullName.toLowerCase()!==live.candidate.repository.toLowerCase())throw new Error('formal_entry_not_selected');
   const published=previous??records.forEntry(id).find(s=>!s.stopped&&s.terminal?.result.status==='awaiting_publication'&&s.terminal.result.fix.H1===live.candidate.H&&s.request.candidate.B===live.candidate.B&&s.request.candidate.target===live.candidate.target);
   const original=records.currentSource(source.item);
   const select=()=>q.status().items.find((i:Row)=>i.candidate.repository.toLowerCase()===live.candidate.repository.toLowerCase()&&i.candidate.pr===live.candidate.pr&&i.candidate.H===live.candidate.H&&i.candidate.B===live.candidate.B&&i.candidate.targetRef===live.candidate.target&&canonical(i.context.scope)===canonical(original.context.scope));
   let selected=select();
   const verified=selected&&records.forEntry(id+':candidate-material').some(s=>s.item===selected.id&&s.terminal?.result.status==='candidate_material_recorded'&&s.resourcesSettled&&s.stages[0]?.returned?.result.run===selected.summary.reportId);
   if(published&&!selected?.summary.evidenceComplete&&!verified){
    const expected=canonical(live.candidate);
    await prepareFormalCandidate(q,entry,published,live,async()=>{
     if(!this.accepting)throw new Error('formal_controller_closing');
     await this.catalog();
     if(records.state(published.operation).stopped)throw new Error('formal_stopped');
     const current=await this.read(entry,source);
     if(canonical(current.candidate)!==expected||hash(current.issue.body)!==entry.issue.bodySha256)throw new Error('formal_candidate_or_requirements_changed');
    },explicit);
    live=await this.read(entry,source);
    if(canonical(live.candidate)!==expected||hash(live.issue.body)!==entry.issue.bodySha256)throw new Error('formal_candidate_or_requirements_changed');
    selected=select();
   }
   if(!selected)throw new Error('formal_current_candidate_material_not_imported');const current=records.currentSource(selected.id);if(!current.current||current.prerequisites.length)throw new Error('formal_current_candidate_material_not_imported');
   if(published){
    if(!live.observation)throw new Error('formal_actual_remote_publication_observation_required');
    records.admitPublication(published.operation,live.observation,q.events().configuration());
    q.reviewRecords().publishedFormalRepair(published.operation);
    const fixed=published.terminal?.result?.fix;
    if(!fixed||published.stopped||fixed.H1!==live.candidate.H||published.request.candidate.B!==live.candidate.B||published.request.candidate.target!==live.candidate.target)throw new Error('formal_new_candidate_requires_new_admission');
   }
   const adoption=q.authority().forScope(current.context.scope.id,{item:selected.id,target:live.candidate.target}).currentAdoption;if(!adoption)throw new Error('formal_adopted_scope_required');const adopted=q.authority().inspectRecordedDecision(adoption),adoptedScope={adoption,proposal:adopted.proposal,source:adopted.source.sourceUrl},candidate={...live.candidate,requirementsSha256:hash(canonical({issue:live.issue,adoptedScope}))},configBytes=await regular(entry.config.path),config=JSON.parse(configBytes.toString());if(hash(configBytes)!==entry.config.sha256||!['fixture','native_capture',undefined].includes(config.executionKind)||!Number.isSafeInteger(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>900000)throw new Error('formal_executor_configuration_invalid');
   const policies={reviewer:(await regular(config.prompts.reviewer)).toString(),fact:(await regular(config.prompts.fact)).toString(),impact:(await regular(config.prompts.impact)).toString()},prompts=await assemblePromptSet(policies,{reviewer:'reviewer',fact:'verifier_fact',impact:'verifier_impact'}),objects=published?.terminal?.result.fix.workspace??entry.objects,material=await formalReviewMaterial({objects,candidate,issue:live.issue,adoptedScope,requiredPaths:entry.requiredPaths,contextPaths:[...new Set([...entry.contextPaths,...entry.repair.materialPaths])],sourceEvidence:live.evidence}),round=published?published.request.round+1:1;
   if(round>32)throw new Error('formal_foreground_round_bound');await mkdir(entry.root,{recursive:true,mode:0o700});await privateDirectory(entry.root,false);const directory=join(entry.root,hash(canonical([id,requestId,round])).slice(0,48));if(await exists(directory)){await privateDirectory(directory,false);if((await readdir(directory)).length)throw new Error('formal_unregistered_original_directory_not_empty');}else await mkdir(directory,{mode:0o700});
   // Read this controller's project settings at new-request freeze time, including
   // timer callers. Existing registered requests returned above keep their choices.
   const capture=()=>captureRoleAI(['reviewer','verifier_fact','verifier_impact'],candidate.repository),aiSelections=this.readPreferences?withAIPreferences(this.readPreferences(),capture):capture();
   const project:ProjectRequest={schemaVersion:1,kind:'tongxu-project-repair-request',executionRoot:join(directory,'project'),objects,candidate:{kind:'github-pr',repository:candidate.repository,pr:candidate.pr,H:candidate.H,B:candidate.B,target:candidate.target},...entry.repair,findings:[],authorization:{source:entry.issue.adjudication,allowRepair:true,allowReconcileEnded:false,maxRepairRounds:1}},workSha256=hash(canonical({materialSha256:material.sha256,configSha256:entry.config.sha256,prompts,project,authorization:entry.authorization,budgets:entry.budgets,aiSelections}));
   const request:FormalFrozenRequest={kind:'tongxu-formal-pr-review',id:requestId,entry:id,item:selected.id,round,previousOperation:published?.operation??null,candidate,executionKind:config.executionKind??'native_capture',workSha256,directory,material,config,configRef:entry.config,prompts,project,authorization:entry.authorization,budgets:entry.budgets,aiSelections,...(this.workbenchProject?{workbenchProject:this.workbenchProject}:{})};const registered=records.register('fr-'+hash(canonical([id,requestId,round])).slice(0,60),selected.id,request);return this.public(registered);
  }finally{q.close();}
 }
 async begin(id:string,operation:string){const {source}=this.entry(id),q=await QueueStore.open(source.store);let state:Row;try{state=q.formalReviews().state(operation);if(state.request.entry!==id)throw new Error('formal_entry_not_selected');if(state.terminal||state.stopped)return this.public(state);}finally{q.close();}if(this.active.has(operation))return {...this.public(state),duplicate:true};if(!this.accepting)throw new Error('formal_controller_closing');const run=this.execute(id,operation);this.active.set(operation,run);run.catch(()=>{}).finally(()=>this.active.delete(operation));return {...this.public(state),controllerActive:true};}
 private async execute(id:string,operation:string){
  const {entry,source}=this.entry(id);
  const q=this.hosts.get(operation)?.q??await QueueStore.open(source.store);
  try{
   return await withQueueRepairLock(source.store,operation,async()=>{
    const state=q.formalReviews().state(operation);
    if(state.terminal||state.stopped)return state;
    let host=this.hosts.get(operation);
    if(!host){
     const request=state.request as FormalFrozenRequest;
     host=new QueueFormalRoundHost(q,operation,request,async()=>{
      await this.catalog();
      const live=await this.read(entry,source);
      const expected={repository:request.candidate.repository,pr:request.candidate.pr,H:request.candidate.H,B:request.candidate.B,target:request.candidate.target};
      if(canonical(live.candidate)!==canonical(expected)||hash(live.issue.body)!==entry.issue.bodySha256||(live.evidence as Row)?.materialSha256!==(request.material.sourceEvidence as Row)?.materialSha256)throw new Error('formal_candidate_or_requirements_changed');
     },()=>{if(!this.accepting)throw new Error('formal_controller_closing');});
     this.hosts.set(operation,host);
    }
    const closed=await host.settleRejectedReview();
    if(closed)return closed;
    try{
     return await runFormalReviewRound(host);
    }catch(error){
     const rejected=await host.settleRejectedReview();
     if(rejected)return rejected;
     throw error;
    }
   });
  }catch(error){
   q.formalReviews().progress(operation,'waiting',{reason:error instanceof Error?error.message:'formal_execution_unknown',originalExecutionRetained:true});
   throw error;
  }finally{
   if(!this.hosts.get(operation)?.ownedFact()){
    this.hosts.delete(operation);
    q.close();
   }
  }
 }
 async report(id:string,operation:string){const {source}=this.entry(id),q=await QueueStore.open(source.store);try{const s=q.formalReviews().state(operation);if(s.request.entry!==id)throw new Error('formal_entry_not_selected');return {...this.public(s),material:s.request.material,prompts:s.request.prompts,fullStages:s.stages.map((s:Row)=>({key:s.stage.key,role:s.stage.role,result:s.returned?.result??null,proof:s.returned?.proof??null})),result:s.terminal?.result??null,originalsRetained:true};}finally{q.close();}}
 async stop(id:string,operation:string,project:Pick<FormalWorkbenchProject,'account'|'repository'>|undefined=this.workbenchProject,legacyProject?:FormalWorkbenchProject){const {source}=this.entry(id),q=await QueueStore.open(source.store);try{const s=q.formalReviews().state(operation);if(s.request.entry!==id)throw new Error('formal_entry_not_selected');
  // New project requests retain their verified identity in the original blob,
  // so cleanup survives a cold/offline page. Old inputs stay immutable and need
  // an already discovered local selection rather than guessed header mapping.
  const bound=s.request.workbenchProject??legacyProject;if(project||bound){if(!project||!bound||!Number.isSafeInteger(project.account)||!Number.isSafeInteger(project.repository)||project.account!==bound.account||project.repository!==bound.repository||bound.fullName.toLowerCase()!==s.request.candidate.repository.toLowerCase())throw new Error('formal_stop_outside_project');}
  return this.public(q.formalReviews().stop(operation));}finally{q.close();}}
 /** Called only by the foreground controller after source/material refresh.
  * Publication is an external fact: no local commit is treated as remote H. */
 async advance(explicit=true){
  if(!this.accepting)return;
  for(const {entry,source} of this.entries){
   const q=await QueueStore.open(source.store);
   let previous:Row[];
   try{previous=q.formalReviews().forEntry(entry.id);}finally{q.close();}
   for(const old of previous.filter(s=>!s.stopped&&s.terminal?.result.status==='awaiting_publication'&&!previous.some(n=>n.request.previousOperation===s.operation))){
    if(!explicit){
     const used=this.automaticChecks.get(old.operation)??0;
     if(used>=automaticCheckLimit)continue;
     this.automaticChecks.set(old.operation,used+1);
    }
    try{
     const live=await this.read(entry,source);
     if(live.candidate.H!==old.terminal.result.fix.H1||live.candidate.B!==old.request.candidate.B||live.candidate.target!==old.request.candidate.target)continue;
     const next=await this.prepare(entry.id,old.request.id,old,explicit);
     await this.begin(entry.id,next.operation);
    }catch(error){
     const q=await QueueStore.open(source.store);
     try{q.formalReviews().progress(old.operation,'awaiting_publication',{reason:error instanceof Error?error.message:'formal_publication_check_failed',foregroundChecks:this.automaticChecks.get(old.operation)??0,originalExecutionRetained:true});}finally{q.close();}
     if(!['formal_current_candidate_material_not_imported','formal_new_candidate_requires_new_admission'].includes((error as Error).message))throw error;
    }
   }
  }
 }
 async drain(){this.accepting=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;await this.checking;await Promise.allSettled(this.active.values());for(const host of this.hosts.values()){await host.ownedFact()?.session.close();host.releaseFact();host.q.close();}this.hosts.clear();}
}
