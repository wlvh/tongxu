import {sourceTick} from './event-tick.js';
import {prepareFormalCandidate} from './formal-candidate.js';
import {mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {regular,exists,processState,tree,treeHash,git,checkRepairIndex} from './repair-workspace.js';
import {readRepairSession} from './repair-native.js';
import {checkCapture} from './live-process.js';
import {exactKeys,isAuthorityDigest,safeRelativePath} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {readEventSource,eventMaterialHash,type EventSourceObservation} from './event-source.js';
import {PublicationHttp} from './publication-http.js';
import {assemblePromptSet} from './role-prompts.js';
import {captureRoleAI,withAIPreferences,type AIPreferenceSnapshot,type WorkflowActivationEvidence} from './ai-settings.js';
import {formalReviewMaterial} from './formal-review-material.js';
import {readCodingWorkflowSource} from './coding-workflow-source.js';
import {runDualFormalReviewRound} from './formal-dual-review.js';
import {runFormalReviewRound} from './formal-review.js';
import {QueueFormalRoundHost,type FormalFrozenRequest} from './formal-review-host.js';
import {withQueueRepairLock} from './queue-repair.js';
import type {ProjectRequest} from './project-repair.js';
import {adoptedRepairRevisions,readRepairInbox,repairSupplementTest,verifiedRepairSupplementTests,type AdoptedRepairRevision,type FormalProjectWork,type ReadRepairInbox} from './formal-repair-inbox.js';
import type {EndedRepairSupplement,PublishedRepairPredecessor,SupplementTarget} from './project-chat.js';
import {readFailedValidationTests} from './implementation-validation.js';
import {bindProjectTestToCandidate,projectModelTestResult} from './project-repair.js';
type Row=Record<string,any>;
type Source={id:string;store:string;item:string};
export type FormalWorkbenchProject={account:number;repository:number;fullName:string};
export type FormalEntry={id:string;source:string;root:string;objects:string;config:{path:string;sha256:string};issue:{number:number;bodySha256:string;adjudication:string};requiredPaths:string[];contextPaths:string[];repair:Pick<ProjectRequest,'allowedPaths'|'materialPaths'|'protectedPaths'|'contract'|'testPlan'|'testPlanSha256'|'generatedDirectories'|'demonstrationFixture'>;authorization:FormalFrozenRequest['authorization'];budgets:FormalFrozenRequest['budgets'];workflowContract?:'coding-loop-v2'};
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

 private constructor(private path:string,private sha256:string,private entries:Array<{entry:FormalEntry;source:Source}>,private read:FormalSourceReader,private verify:()=>Promise<void>,private workbenchProject?:FormalWorkbenchProject,private readPreferences?:()=>AIPreferenceSnapshot,private readWorkInbox?:ReadRepairInbox){}
 static async load(path:string,sha256:string,sources:Source[],selected?:ReadonlySet<string>,read:FormalSourceReader=readSource,verify:()=>Promise<void>=async()=>{},workbenchProject?:FormalWorkbenchProject,readPreferences?:()=>AIPreferenceSnapshot,readWorkInbox?:ReadRepairInbox){
  const bytes=await regular(path,128*1024),p=JSON.parse(bytes.toString());if(hash(bytes)!==sha256||!exactKeys(p,['schemaVersion','kind','entries'])||p.schemaVersion!==1||p.kind!=='tongxu-formal-review-catalog'||!Array.isArray(p.entries)||p.entries.length>8)throw new Error('formal_catalog_invalid');
  const entries:Array<{entry:FormalEntry;source:Source}>=[];for(const e of p.entries as FormalEntry[]){if(selected&&!selected.has(e.source))continue;const source=sources.find(s=>s.id===e.source);if(!source||!exactKeys(e,['id','source','root','objects','config','issue','requiredPaths','contextPaths','repair','authorization','budgets',...(e.workflowContract!==undefined?['workflowContract']:[])])||e.workflowContract!==undefined&&e.workflowContract!=='coding-loop-v2'||!messageId(e.id)||![e.root,e.objects,e.config?.path,e.repair?.testPlan].every(p=>typeof p==='string'&&resolve(p)===p)||!exactKeys(e.config,['path','sha256'])||!isAuthorityDigest(e.config.sha256)||!exactKeys(e.issue,['number','bodySha256','adjudication'])||!Number.isSafeInteger(e.issue.number)||e.issue.number<1||!isAuthorityDigest(e.issue.bodySha256)||!e.issue.adjudication?.trim()||!paths(e.requiredPaths,32)||!paths(e.contextPaths,64)||!exactKeys(e.repair,['allowedPaths','materialPaths','protectedPaths','contract','testPlan','testPlanSha256','generatedDirectories','demonstrationFixture'])||!paths(e.repair.allowedPaths,32)||!paths(e.repair.materialPaths,64)||!paths(e.repair.protectedPaths,128)||!paths(e.repair.generatedDirectories,16)||!isAuthorityDigest(e.repair.testPlanSha256)||typeof e.repair.demonstrationFixture!=='boolean'||!e.repair.contract?.trim()||!exactKeys(e.authorization,['receive','implement','test'])||!Object.values(e.authorization).every(isAuthorityDigest)||!Array.isArray(e.budgets)||e.budgets.length>16||e.budgets.some(b=>!exactKeys(b,['phase','ledgerId','resourceRef','unit','quantity'])||!['analysis','fix','candidate'].includes(b.phase)||!Number.isSafeInteger(b.quantity)||b.quantity<1))throw new Error('formal_entry_invalid');entries.push({entry:e,source});}
  if(new Set(entries.map(e=>e.entry.id)).size!==entries.length)throw new Error('formal_duplicate_entry');return new FormalReviewControls(path,sha256,entries,read,verify,workbenchProject,readPreferences,readWorkInbox);
 }
 private entry(id:string){const f=this.entries.find(f=>f.entry.id===id);if(!f)throw new Error('formal_entry_not_selected');return f;}
 private async catalog(){if(hash(await regular(this.path,128*1024))!==this.sha256)throw new Error('formal_catalog_changed');await this.verify();}
 private public(s:Row){const r=s.terminal?.result,used=this.automaticChecks.get(s.operation)??0;return {id:s.request.id,operation:s.operation,entry:s.request.entry,round:s.request.round,executionRound:s.executionRound,previousOperation:s.request.previousOperation,item:s.item,candidate:s.request.candidate,phase:r?.status??s.phase,detail:s.detail,stopped:s.stopped,controllerActive:this.active.has(s.operation),ownsOriginalSessions:this.hosts.get(s.operation)?.ownsDual()===true,automaticContinuation:{used,limit:automaticCheckLimit,exhausted:used>=automaticCheckLimit},resourcesSettled:s.resourcesSettled,executionKind:s.request.executionKind,demonstrationFixture:s.request.project.demonstrationFixture,...(s.request.workflowReview?{workflowRevision:s.request.workflowReview.correctness.revision}:{}),stages:s.stages.map((s:Row)=>({key:s.stage.key,role:s.stage.role,dispatched:s.dispatched,returned:!!s.returned,...(s.returned?.proof?.native?.company?{company:s.returned.proof.native.company,sessionId:s.returned.proof.native.sessionId}:{})})),newModelInputs:0};}
 private async currentView(s:Row){
  if(s.terminal?.result.status==='pass'&&s.request.material?.sourceEvidence?.adoptedProjectSupplements?.length){
   try{
    if(!s.request.supplementVerification)throw new Error('formal_fixed_supplement_test_capture_changed');
    await verifiedRepairSupplementTests(s.request.supplementVerification,s.request.candidate.H);
   }
   catch{return {...s,terminal:{result:{...s.terminal.result,status:'needs_evidence',recordedStatus:'pass',reason:'formal_fixed_supplement_test_capture_changed'}}};}
  }
  return s;
 }
 async state(){return Promise.all(this.entries.map(async({entry,source})=>{const q=await QueueStore.open(source.store);try{return {id:entry.id,source:source.id,issue:entry.issue,...(entry.workflowContract?{workflowContract:entry.workflowContract}:{}),requests:await Promise.all(q.formalReviews().forEntry(entry.id).map(async s=>this.public(await this.currentView(s))))};}finally{q.close();}}));}
 async workflowReleaseProof(revision:string,runtimeHead:string,runtimeFilesSha256:string):Promise<WorkflowActivationEvidence|null>{
  await this.catalog();
  for(const {entry,source} of this.entries){
   const q=await QueueStore.open(source.store);
   try{
    const records=q.formalReviews(),all=records.forEntry(entry.id);
    const selected=all.findLast(s=>s.request.candidate.H===runtimeHead);
    if(!selected||selected.stopped||selected.request.executionKind!=='native_capture'||selected.request.project.demonstrationFixture||
       selected.request.workflowReview?.correctness.revision!==revision||!selected.resourcesSettled||
       (await this.currentView(selected)).terminal?.result.status!=='pass')continue;
    const report=q.status().items.find((item:Row)=>item.id===selected.item);
    if(!report?.summary.evidenceComplete||!report.summary.reportId)continue;
    const tree=await git(selected.request.project.objects,['rev-parse',runtimeHead+'^{tree}']);
    if(report.summary.tree!==tree||!selected.request.material.sourceEvidence?.candidateMaterial?.some((original:Row)=>
       original.item===selected.item&&original.summary?.evidenceComplete===true&&
       original.summary.reportId===report.summary.reportId&&original.summary.tree===tree))continue;
    const live=await this.read(entry,source),expected=selected.request.candidate;
    if(live.candidate.H!==expected.H||live.candidate.B!==expected.B||live.candidate.target!==expected.target||
       live.candidate.repository!==expected.repository||live.candidate.pr!==expected.pr||
       (live.evidence as Row)?.materialSha256!==selected.request.material.sourceEvidence?.materialSha256||
       hash(live.issue.body)!==entry.issue.bodySha256)continue;
    const current=records.currentSource(selected.item);
    if(!current.current||current.prerequisites.length)continue;
    return {runtimeHead,runtimeFilesSha256,operation:selected.operation,materialSha256:selected.request.material.sha256,testReport:report.summary.reportId};
   }finally{q.close();}
  }
  return null;
 }
 async forWork(issue:{number:number;bodySha256:string},H:string){
  const matched:Array<{entry:string;source:string;candidate:FormalSource['candidate']}>=[];
  for(const {entry,source} of this.entries){
   if(entry.issue.number!==issue.number||entry.issue.bodySha256!==issue.bodySha256)continue;
   const q=await QueueStore.open(source.store);
   try{
    const records=q.formalReviews(),configured=records.currentSource(source.item);
    const items=q.status().items.filter((item:Row)=>item.candidate.kind!=='development-task'&&item.candidate.pr===configured.candidate.pr&&
       item.candidate.repository===configured.candidate.repository&&item.candidate.targetRef===configured.candidate.targetRef&&
       item.candidate.H===H&&canonical(item.context.scope)===canonical(configured.context.scope));
    for(const item of items){
     const {repository,pr,B,targetRef}=item.candidate;
     const observation=records.currentSource(item.id);
     if(observation.current&&!observation.prerequisites.length)
      matched.push({entry:entry.id,source:source.id,candidate:{repository,pr,H,B,target:targetRef}});
    }
   }finally{q.close();}
  }
  return matched.length===1?matched[0]:null;
 }
 private async endedRepairSupplement(s:Row,stage:Row,entry:FormalEntry,source:Source,published?:Omit<PublishedRepairPredecessor,'image'>):Promise<EndedRepairSupplement>{
   const result=s.terminal?.result,report=stage.returned?.result;
   const changed=!!published;
   if(!s.request.workflowReview||s.stopped||!s.resourcesSettled||result?.status!==(changed?'awaiting_publication':'needs_evidence')||
      (!changed&&(report?.decision!=='no_change'||canonical(result.report)!==canonical(report)))||
      s.stages.some((item:Row)=>item.dispatched&&!item.returned))
     throw new Error('formal_repair_supplement_writer_unresolved');
   const round=s.executionRound,originalH=s.request.candidate.H,H=changed?result.fix.H1:originalH;
   if(!['round-'+round+'/fix',...(changed?['round-'+round+'/fix-supplement']:[])].includes(stage.stage.key))
     throw new Error('formal_repair_supplement_writer_unresolved');
   const directory=join(s.request.directory,'round-'+round+'-correctness-initial');
   const root=join(s.request.directory,round===s.request.round?'project':'project-round-'+round),workspace=join(root,'workspace'),operation=join(root,'operation');
   const json=async(path:string)=>JSON.parse((await regular(path,16*1024*1024)).toString());
   const process=await json(join(directory,'process.json')),capture=await readRepairSession(directory),native=stage.returned.proof.native;
   const final=capture.turns.at(-1),pairs:Row[]=await json(join(directory,'reconciled-tools.json'));
   const retained=async(dir:string,originals:Row,name:string,prefix=false)=>{
     const bytes=await regular(join(dir,name),16*1024*1024),ref=originals[name];
     if(!ref||bytes.length<ref.bytes||!prefix&&bytes.length!==ref.bytes||hash(bytes.subarray(0,ref.bytes))!==ref.sha256)
       throw new Error('formal_repair_supplement_writer_unresolved');
   };
   for(const name of ['stdin.ndjson','stdout.ndjson','process.json','executable.json','launch.json','effective-config.json'])
     await retained(directory,stage.returned.proof.originals,name,name.endsWith('.ndjson'));
   if(process.status!=='spawn_attempted'||processState(process.pid)!=='ended'||capture.binding.sessionId!==native.sessionId||
      capture.binding.threadId!==native.threadId||capture.binding.run!==s.request.directory||final?.id!==native.turnId||
      capture.binding.candidate.H!==originalH||capture.binding.inputManifestSha256!==s.request.material.sha256||
      canonical(JSON.parse(final?.final?.text??'null'))!==canonical(report)||
      pairs.some(pair=>!['tongxu_read_file','tongxu_run_tests',...(changed?['tongxu_replace_file']:[])].includes(pair.request?.params?.tool)))
     throw new Error('formal_repair_supplement_writer_unresolved');
   if(await exists(join(directory,'native-tool-transports.json'))){
     const transports=await json(join(directory,'native-tool-transports.json'));
     if(transports.some((item:Row)=>item.appServerPid!==process.pid||!Array.isArray(item.observedHelperPids)||
         item.observedHelperPids.some((pid:unknown)=>processState(pid)!=='ended')))
       throw new Error('formal_repair_supplement_writer_unresolved');
   }
   const plan=await json(join(root,'plan.json')),grant=await json(join(root,'grant.json'));
   if(plan.workspace!==workspace||plan.grant!==join(root,'grant.json')||canonical(plan.project?.sourceCandidate)!==canonical(s.request.project.candidate)||
      grant.H!==originalH||grant.workspace!==workspace||await exists(join(workspace,'.git','tongxu-writer.json')))
     throw new Error('formal_repair_supplement_writer_unresolved');
   const testDirectory=join(operation,'tests'),tests=new Map<string,Row>();
   for(const pair of pairs.filter(item=>item.request.params.tool==='tongxu_run_tests')){
     const id=pair.request.params.callId;
     if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('formal_repair_supplement_writer_unresolved');
     tests.set('tool-'+id,pair.response.result);
   }
   const directories=await exists(testDirectory)?await readdir(testDirectory):[];
   if(canonical(directories.sort())!==canonical([...tests.keys(),...(changed?['formal-final']:[])].sort()))throw new Error('formal_repair_supplement_writer_unresolved');
   for(const [name,reply] of tests){
     const {result}=await readFailedValidationTests(join(testDirectory,name),plan,false);
     if(canonical(projectModelTestResult(result))!==canonical(JSON.parse(reply.contentItems[0].text)))
       throw new Error('formal_repair_supplement_writer_unresolved');
   }
   const releases=(await readdir(join(operation,'ownership-history'))).filter(name=>name.endsWith('-released.json'));
   if(releases.length!==1)throw new Error('formal_repair_supplement_writer_unresolved');
   const released=await json(join(operation,'ownership-history',releases[0]!)),lease=released.lease;
   if(lease?.operation!==operation||lease.status!=='held'||released.outcome!==result.status||
      releases[0]!==lease.generation+'-released.json'||canonical(lease)!==canonical(await json(join(operation,'ownership-history',lease.generation+'-lock.json')))||
      canonical(await json(join(operation,'handoff-'+lease.generation+'-1.json')))!==canonical({from:'trusted-preparer',to:native.sessionId,
        sessionContinuity:'same_fact_verifier_session',grant,lease,verifiedTreeSha256:grant.treeSha256,backgroundCommands:'none-active-in-managed-workspace'}))
     throw new Error('formal_repair_supplement_writer_unresolved');
   const current=await tree(workspace,true);
   await checkRepairIndex(workspace,operation,[],current,undefined,true);
   if(changed){
     const peer=join(s.request.directory,'round-'+round+'-impact-initial');
     await checkCapture(peer);
     const exit=await json(join(peer,'exit.json')),peerProcess=await json(join(peer,'process.json'));
     const lastPeer=s.stages.findLast((item:Row)=>item.stage.role==='verifier_impact'&&item.stage.key.startsWith('round-'+round+'/')&&item.returned);
     if(!lastPeer||exit.code!==0||exit.signal!==null||peerProcess.status!=='spawn_attempted'||processState(peerProcess.pid)!=='ended')
       throw new Error('formal_repair_supplement_writer_unresolved');
     for(const name of ['stdin.ndjson','stdout.ndjson','prompt-boundaries.ndjson','process.json'])
       await retained(peer,lastPeer.returned.proof.originals,name,name.endsWith('.ndjson'));
     const fix=result.fix,binding=fix.testCandidateBinding;
     if(fix.workspace!==workspace||published.workspace!==workspace||fix.sessionId!==native.sessionId||fix.threadId!==native.threadId||
        fix.H0!==originalH||binding.candidate.H!==H||await git(workspace,['rev-parse','--verify',H+'^'])!==originalH||
        hash(await regular(join(root,'config.json')))!==s.request.configRef.sha256||
        canonical(await json(join(root,'request.json')))!==canonical({...s.request.project,executionRoot:root})||
        plan.project.testPlan!==join(root,'test-plan.json')||plan.project.testPlanSha256!==s.request.project.testPlanSha256)
       throw new Error('formal_repair_supplement_writer_unresolved');
     const tested=(await readFailedValidationTests(join(testDirectory,'formal-final'),plan,false)).result;
     if(!tested.passed||treeHash(current)!==tested.candidateTreeSha256||canonical(projectModelTestResult(tested))!==canonical(fix.tested)||
        canonical(await bindProjectTestToCandidate(workspace,binding.candidate,tested))!==canonical(binding))
       throw new Error('formal_repair_supplement_current_base_required');
     const testedImage=async(test:string)=>{
       const {connection}=await json(join(test,'runtime','probe','execution.json'));
       return connection.imageId??connection.config.image;
     };
     const image=await testedImage(join(testDirectory,'formal-final')),supplement=fix.reviewFixRecord.supplementVerification;
     if(!/^sha256:[a-f0-9]{64}$/.test(image)||supplement&&await testedImage(supplement.directory)!==image)
       throw new Error('formal_repair_supplement_test_config_changed');
     return {operation:s.operation,round,H,sessionId:native.sessionId,report:fix.report,published:{...published,image}};
   }
   if(treeHash(current)!==grant.treeSha256||await git(workspace,['rev-parse','HEAD'])!==H)
     throw new Error('formal_repair_supplement_current_base_required');
   await this.catalog();
   const live=await this.read(entry,source),{repository,pr,B,target}=s.request.candidate;
   if(canonical(live.candidate)!==canonical({repository,pr,H,B,target})||hash(live.issue.body)!==entry.issue.bodySha256||
      (live.evidence as Row)?.materialSha256!==s.request.material.sourceEvidence?.materialSha256)
     throw new Error('formal_repair_supplement_current_base_required');
   return {operation:s.operation,round,H,sessionId:native.sessionId,report};
 }
 private async publishedRepairSupplement(q:QueueStore,s:Row,requests:Row[],entry:FormalEntry,source:Source){
   const records=q.formalReviews(),work=s.request.projectWork,fix=s.terminal.result.fix;
   const successors=requests.filter(next=>next.request.previousOperation===s.operation);
   if(successors.length!==1)throw new Error('formal_repair_supplement_review_current_required');
   const successor=await this.currentView(successors[0]!),candidate=successor.request.candidate;
   const {repository,pr,H,B,target,requirementsSha256}=candidate;
   if(successor.stopped||!successor.resourcesSettled||!successor.request.workflowReview||successor.terminal?.result.status!=='pass'||
      this.active.has(successor.operation)||successor.stages.some((stage:Row)=>stage.stage.role==='fix'&&stage.dispatched)||
      canonical(successor.request.projectWork)!==canonical(work)||H!==fix.H1||B!==s.request.candidate.B||target!==s.request.candidate.target||
      repository!==s.request.candidate.repository||pr!==s.request.candidate.pr||successor.request.executionKind!==s.request.executionKind)
     throw new Error('formal_repair_supplement_review_current_required');
   const {published}=records.sourceForReviewRecords(s.operation);
   if(!published||published.H!==H||published.beforeH!==s.request.candidate.H||published.recordSha256!==fix.recordSha256||
      hash(canonical(fix.reviewFixRecord))!==fix.recordSha256||canonical(fix.reviewFixRecord.candidate)!==canonical(s.request.candidate)||
      fix.reviewFixRecord.H2!==H||canonical(fix.reviewFixRecord.testCandidateBinding)!==canonical(fix.testCandidateBinding))
     throw new Error('formal_repair_supplement_publication_required');
   const current=records.currentSource(successor.item),material=successor.request.material;
   if(!current.current||current.prerequisites.length||current.candidate.H!==H||current.candidate.B!==B||current.candidate.targetRef!==target||
      current.candidate.repository!==repository||current.candidate.pr!==pr||
      q.authority().forScope(current.context.scope.id,{item:successor.item,target}).currentAdoption!==material.adoptedScope.adoption||
      hash(canonical({issue:material.issue,adoptedScope:material.adoptedScope}))!==requirementsSha256)
     throw new Error('formal_repair_supplement_current_base_required');
   const initial=(state:Row,role:string)=>state.stages.find((item:Row)=>item.stage.key==='round-'+state.executionRound+'/'+role+'-initial')?.returned?.proof.native;
   for(const [role,company] of [['correctness','OpenAI'],['impact','Moonshot']]){
     const previous=initial(s,role!),fresh=initial(successor,role!);
     if(previous?.company!==company||fresh?.company!==company||!fresh.sessionId||previous.sessionId===fresh.sessionId)
       throw new Error('formal_repair_supplement_review_current_required');
   }
   const fixes=s.stages.filter((stage:Row)=>stage.stage.role==='fix'&&stage.dispatched);
   for(const stage of fixes){
     const checkpoint=stage.stage.key.endsWith('/fix-supplement')?'after-repair':'before-repair';
     const items=await readRepairInbox(s.request.directory,s.executionRound,work,checkpoint);
     if(!items||!records.originalStageInputIncludes(s.operation,stage.stage.key,input=>canonical(input.projectSupplements?.items??[])===canonical(items)))
       throw new Error('formal_repair_inbox_binding_changed');
   }
   const original=fixes.at(-1),verification=fix.reviewFixRecord.supplementVerification;
   const testPlan=join(fix.workspace,'..','test-plan.json'),testPlans=[{path:testPlan,sha256:s.request.project.testPlanSha256}];
   const revisions=(material.sourceEvidence?.adoptedProjectSupplements??[]) as AdoptedRepairRevision[];
   if(verification){
     const tested=await verifiedRepairSupplementTests(verification,H);
     if(canonical(verification)!==canonical(successor.request.supplementVerification)||
        canonical(tested.tools.map((tool:Row)=>tool.id))!==canonical(revisions.map(item=>repairSupplementTest(item.revision))))
       throw new Error('formal_repair_supplement_evidence_missing');
     testPlans.push({path:verification.plan.project.testPlan,sha256:verification.plan.project.testPlanSha256});
   }else if(revisions.length)throw new Error('formal_repair_supplement_evidence_missing');
   if(s.request.project.generatedDirectories.length||!original)throw new Error('formal_repair_supplement_evidence_missing');
   const handoff=await this.endedRepairSupplement(s,original,entry,source,{
     previousH:s.request.candidate.H,workspace:fix.workspace,reviewOperation:successor.operation,reviewMaterialSha256:material.sha256,requirementsSha256,
     publicationSha256:published.captureSha256,fixSha256:fix.recordSha256,testPlans,protectedPaths:s.request.project.protectedPaths,
     contract:s.request.project.contract,revisions:revisions.map(({revision})=>({requirement:revision.requirement,acceptance:revision.acceptance}))
   });
   await this.catalog();
   const live=await this.read(entry,source);
   const reviewed=records.state(successor.operation);
   if(canonical(live.candidate)!==canonical({repository,pr,H,B,target})||canonical(live.issue)!==canonical(material.issue)||
      (live.evidence as Row)?.materialSha256!==material.sourceEvidence?.materialSha256||!live.observation?.result.complete||
      !live.observation.records.some(record=>record.kind==='pr'&&JSON.parse(record.body.toString()).body?.includes(fix.publicRecord))||
      records.state(s.operation).stopped||reviewed.terminal?.result.status!=='pass'||reviewed.stopped)
     throw new Error('formal_repair_supplement_current_base_required');
   return handoff;
 }
 async workRepairInbox(target:SupplementTarget,receivedId?:string,text?:string,continuingOperation?:string){
  for(const {entry,source} of this.entries){
   const q=await QueueStore.open(source.store);
   try{
    const records=q.formalReviews();
    const requests=records.forEntry(entry.id).reverse();
    for(const s of requests){
     const work=s.request.projectWork;
     if(!work||canonical(work.target)!==canonical(target)||continuingOperation&&s.operation!==continuingOperation)continue;
     const stages=s.stages as Array<ReturnType<typeof records.stage>>;
     const owned=stages.some(stage=>stage.stage.role==='fix'&&stage.dispatched&&!stage.returned)||this.active.has(s.operation)||
       !s.stopped&&(!s.terminal||s.terminal.result.status==='awaiting_publication'&&!requests.some(r=>r.request.previousOperation===s.operation));
     const fixes=stages.filter(stage=>stage.stage.role==='fix').reverse();
     const conflictingRepair=()=>requests.some(other=>{
       if(other.operation===s.operation)return false;
       const fixDispatched=other.stages.some((row:Row)=>row.stage.role==='fix'&&row.dispatched);
       const unknown=other.stages.some((row:Row)=>row.stage.role==='fix'&&row.dispatched&&!row.returned);
       const guarded=continuingOperation&&other.request.projectWork&&canonical(other.request.projectWork.target)===canonical(target);
       return unknown||fixDispatched&&(!other.terminal||this.active.has(other.operation))||
         (!other.stopped&&other.terminal?.result.status==='awaiting_publication')||
         ((!guarded||fixDispatched)&&!other.stopped&&(!other.terminal||this.active.has(other.operation)));
     });
     for(const stage of fixes){
      const key=stage.stage.key,round=Number(key.split('/')[0]!.slice(6));
      const items=await readRepairInbox(s.request.directory,round,work,key.endsWith('/fix-supplement')?'after-repair':'before-repair');
      const item=items?.find(item=>item.requestId===receivedId&&item.text===text);
      if(!item)continue;
      const proof=stage.returned?.proof?.native;
      const delivered=proof?.company==='OpenAI'&&proof.sessionId&&records.originalStageInputIncludes(s.operation,key,input=>
        canonical(input.projectSupplements?.items)===canonical(items));
      const revision=delivered?item.revision:undefined,fix=s.terminal?.result.fix;
      let coveringCandidate:string|null=null,verificationMissing=false;
      if(revision&&fix?.reviewFixRecord?.supplementVerification){
       const verified=fix.reviewFixRecord.supplementVerification;
       try{
        const {result}=await readFailedValidationTests(verified.directory,verified.plan,false);
        if(hash(canonical(fix.reviewFixRecord))!==fix.recordSha256||verified.binding.candidate.H!==fix.H1||
           hash(canonical(result))!==verified.binding.testResultCanonicalSha256||
           canonical(projectModelTestResult(result))!==canonical(verified.tests))throw new Error('formal_fixed_supplement_test_capture_changed');
        if(result.passed&&result.tools.some((tool:Row)=>tool.id===repairSupplementTest(revision)&&tool.exitCode===0))coveringCandidate=fix.H1;
       }catch{verificationMissing=true;}
      }
      const changedBase=!!fix?.H1&&fix.H1!==s.request.candidate.H;
      let endedRepair:EndedRepairSupplement|undefined,endedProblem:string|undefined;
      if(delivered&&!revision&&!s.stopped&&s.terminal){
        if(owned&&changedBase)endedProblem='formal_repair_supplement_publication_required';
        if(!owned&&!conflictingRepair()){
          try{
            const candidate=s.request.candidate;
            const current=changedBase?null:records.currentSource(s.item);
            if(current&&(!current.current||current.prerequisites.length||current.candidate.H!==candidate.H||current.candidate.B!==candidate.B||current.candidate.targetRef!==candidate.target))
              throw new Error('formal_repair_supplement_current_base_required');
            endedRepair=changedBase?await this.publishedRepairSupplement(q,s,requests,entry,source):await this.endedRepairSupplement(s,stage,entry,source);
          }
          catch(error){const reason=(error as Error).message;endedProblem=/^formal_repair_(?:supplement_(?:publication_required|review_current_required|current_base_required|evidence_missing|test_config_changed)|inbox_binding_changed)$/.test(reason)?
            reason:'formal_repair_supplement_writer_unresolved';}
        }
      }
      return {owned,formalRepair:true,ready:false,successful:!!coveringCandidate,issue:entry.issue.number,H1:s.request.candidate.H,
        endedRepair,changedBase,reason:endedProblem??(verificationMissing?'formal_repair_supplement_evidence_missing':coveringCandidate?null:revision?
          (s.detail?.reason==='formal_fixed_supplement_tests_failed'?s.detail.reason:'formal_repair_supplement_coverage_pending'):
          delivered?'formal_repair_supplement_requires_adoption':'formal_repair_supplement_delivery_pending'),
        operation:s.operation,dispatchRecorded:stage.dispatched,delivered:!!delivered,adopted:!!revision,coveringCandidate,
        ...(revision?{requirementSha256:revision.inputSha256,reviewRun:revision.reviewRun}:{}),
        completeCapture:!!delivered,recipient:delivered?{role:'formal-repair',work:work.id,sessionId:proof.sessionId}:null,
        report:delivered?stage.returned.result:null};
     }
     if(owned)return {owned,formalRepair:true,ready:false,successful:false,issue:entry.issue.number,H1:s.request.candidate.H,endedRepair:undefined,
      reason:fixes.length?'formal_repair_supplement_next_checkpoint':'formal_repair_supplement_waiting_checkpoint',
      operation:s.operation,delivered:false,adopted:false,coveringCandidate:null};
     if(receivedId&&s.terminal?.result.fix?.H1&&s.terminal.result.fix.H1!==s.request.candidate.H){
       const frame={owned:false,formalRepair:true,ready:false,successful:false,issue:entry.issue.number,H1:s.request.candidate.H,repairedH:s.terminal.result.fix.H1 as string,
         operation:s.operation,delivered:false,adopted:false,coveringCandidate:null};
       if(!s.stopped&&!conflictingRepair()){
         try{
           const endedRepair=await this.publishedRepairSupplement(q,s,requests,entry,source);
           return {...frame,endedRepair,changedBase:true,reason:'formal_repair_supplement_current_base_ready'};
         }catch{/* Without a current verified successor the original commit cannot receive new work. */}
       }
       return {...frame,endedRepair:undefined,supersededBase:true,reason:'formal_repair_supplement_current_base_required'};
     }
    }
   }finally{q.close();}
  }
  return null;
 }
 async prepare(id:string,requestId:string,previous?:Row,explicit=true,expected?:FormalSource['candidate'],requestedWork?:FormalProjectWork){
  if(!this.accepting||!messageId(requestId))throw new Error('formal_request_invalid');await this.catalog();const {entry,source}=this.entry(id),q=await QueueStore.open(source.store);
  const checkCandidate=(candidate:FormalFrozenRequest['candidate']|FormalSource['candidate'])=>{
   if(expected&&canonical({repository:candidate.repository,pr:candidate.pr,H:candidate.H,B:candidate.B,target:candidate.target})!==canonical(expected))throw new Error('formal_candidate_or_requirements_changed');
  };
  try{const records=q.formalReviews(),prior=records.forEntry(id).find(s=>s.request.id===requestId&&(!previous||s.request.round===previous.request.round+1));if(prior){checkCandidate(prior.request.candidate);if(requestedWork&&canonical(prior.request.projectWork)!==canonical(requestedWork))throw new Error('formal_original_project_work_changed');return this.public(prior);}let live=await this.read(entry,source);if(hash(live.issue.body)!==entry.issue.bodySha256)throw new Error('formal_adopted_issue_changed');checkCandidate(live.candidate);
   if(this.workbenchProject&&this.workbenchProject.fullName.toLowerCase()!==live.candidate.repository.toLowerCase())throw new Error('formal_entry_not_selected');
   const published=previous??records.forEntry(id).find(s=>!s.stopped&&s.terminal?.result.status==='awaiting_publication'&&s.terminal.result.fix.H1===live.candidate.H&&s.request.candidate.B===live.candidate.B&&s.request.candidate.target===live.candidate.target);
   const capture=()=>captureRoleAI(['reviewer','verifier_fact','verifier_impact'],live.candidate.repository),preferences=()=>this.readPreferences?withAIPreferences(this.readPreferences(),capture):capture();
   const dual=published?!!published.request.workflowReview:entry.workflowContract==='coding-loop-v2';
   const projectWork=dual?(requestedWork??published?.request.projectWork):undefined;
   const dualSelections=dual?preferences():null;
   if(dualSelections&&dualSelections.verifier_impact?.tool!=='kimi')throw new Error('formal_second_company_not_configured');
   if(dualSelections?.reviewer&&dualSelections.reviewer.tool!=='codex')throw new Error('ai_selected_provider_not_supported_by_operation');
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
   const fixed=published?.terminal?.result.fix,previousWork=published?.request.projectWork;
   const supplementVerification=fixed?.reviewFixRecord?.supplementVerification;
   let sourceEvidence=live.evidence;
   const previousRevisions=(published?.request.material.sourceEvidence as Row)?.adoptedProjectSupplements as AdoptedRepairRevision[]|undefined;
   if(previousRevisions?.length&&!supplementVerification)throw new Error('formal_fixed_supplement_test_capture_changed');
   if(supplementVerification&&previousWork){
    const rounds=published!.executionRound,prior=published!,originalInbox=[];
    for(const [checkpoint,name] of [['before-repair','fix'],['after-repair','fix-supplement']] as const){
     const items=await readRepairInbox(prior.request.directory,rounds,previousWork,checkpoint);
     if(!items&&checkpoint==='before-repair'||items?.length&&!records.originalStageInputIncludes(prior.operation,'round-'+rounds+'/'+name,
       input=>canonical(input.projectSupplements?.items)===canonical(items)))throw new Error('formal_repair_inbox_binding_changed');
     if(items)originalInbox.push(...items);
    }
    const proof=await verifiedRepairSupplementTests(supplementVerification,fixed.H1);
    const adopted=[...new Map([...(previousRevisions??[]),...adoptedRepairRevisions(originalInbox)].map(item=>[item.requestId,item])).values()];
    if(!adopted.length||canonical(proof.tools.map((tool:Row)=>tool.id))!==canonical(adopted.map(item=>repairSupplementTest(item.revision))))
      throw new Error('formal_fixed_supplement_test_capture_changed');
    sourceEvidence={...(live.evidence as Row),adoptedProjectSupplements:adopted,
      supplementTests:{candidate:fixed.H1,tests:supplementVerification.tests,binding:supplementVerification.binding}};
   }
   const policies={reviewer:(await regular(config.prompts.reviewer)).toString(),fact:(await regular(config.prompts.fact)).toString(),impact:(await regular(config.prompts.impact)).toString()},prompts=await assemblePromptSet(policies,{reviewer:'reviewer',fact:'verifier_fact',impact:'verifier_impact'}),objects=fixed?.workspace??entry.objects,material=await formalReviewMaterial({objects,candidate,issue:live.issue,adoptedScope,requiredPaths:entry.requiredPaths,contextPaths:[...new Set([...entry.contextPaths,...entry.repair.materialPaths])],sourceEvidence}),round=published?published.request.round+1:1;
   if(round>32)throw new Error('formal_foreground_round_bound');await mkdir(entry.root,{recursive:true,mode:0o700});await privateDirectory(entry.root,false);const directory=join(entry.root,hash(canonical([id,requestId,round])).slice(0,48));if(await exists(directory)){await privateDirectory(directory,false);if((await readdir(directory)).length)throw new Error('formal_unregistered_original_directory_not_empty');}else await mkdir(directory,{mode:0o700});
   const aiSelections=dualSelections??preferences();
   let workflowReview=published?.request.workflowReview as FormalFrozenRequest['workflowReview'];
   if(!published&&entry.workflowContract==='coding-loop-v2'){
    const workflow=await readCodingWorkflowSource();
    workflowReview={correctness:workflow.prompt('pr_review_correctness'),impact:workflow.prompt('pr_review_impact'),
      fact:workflow.prompt('finding_verification_fact'),verificationImpact:workflow.prompt('finding_verification_impact')};
   }
   const project:ProjectRequest={schemaVersion:1,kind:'tongxu-project-repair-request',executionRoot:join(directory,'project'),objects,candidate:{kind:'github-pr',repository:candidate.repository,pr:candidate.pr,H:candidate.H,B:candidate.B,target:candidate.target},...entry.repair,findings:[],authorization:{source:entry.issue.adjudication,allowRepair:true,allowReconcileEnded:false,maxRepairRounds:1}},workSha256=hash(canonical({materialSha256:material.sha256,configSha256:entry.config.sha256,prompts,project,authorization:entry.authorization,budgets:entry.budgets,aiSelections,...(workflowReview?{workflowReview}:{}),...(projectWork?{projectWork}:{})}));
   const request:FormalFrozenRequest={kind:'tongxu-formal-pr-review',id:requestId,entry:id,item:selected.id,round,previousOperation:published?.operation??null,candidate,executionKind:config.executionKind??'native_capture',workSha256,directory,material,config,configRef:entry.config,prompts,project,authorization:entry.authorization,budgets:entry.budgets,aiSelections,...(workflowReview?{workflowReview}:{}),...(this.workbenchProject?{workbenchProject:this.workbenchProject}:{}),...(projectWork?{projectWork}:{}),...(supplementVerification?{supplementVerification}:{})};const registered=records.register('fr-'+hash(canonical([id,requestId,round])).slice(0,60),selected.id,request);return this.public(registered);
  }finally{q.close();}
 }
 async begin(id:string,operation:string){const {source}=this.entry(id),q=await QueueStore.open(source.store);let state:Row;try{state=q.formalReviews().state(operation);if(state.request.entry!==id)throw new Error('formal_entry_not_selected');if(state.terminal||state.stopped)return this.public(state);}finally{q.close();}if(this.active.has(operation))return {...this.public(state),duplicate:true};if(!this.accepting)throw new Error('formal_controller_closing');const run=this.execute(id,operation);this.active.set(operation,run);run.catch(()=>{}).finally(()=>this.active.delete(operation));return {...this.public(state),controllerActive:true};}
 private makeHost(q:QueueStore,operation:string,state:Row,entry:FormalEntry,source:Source){
   const request=state.request as FormalFrozenRequest;
   return new QueueFormalRoundHost(q,operation,request,async()=>{
    await this.catalog();
    const live=await this.read(entry,source);
    const expected={repository:request.candidate.repository,pr:request.candidate.pr,H:request.candidate.H,B:request.candidate.B,target:request.candidate.target};
    if(canonical(live.candidate)!==canonical(expected)||hash(live.issue.body)!==entry.issue.bodySha256||(live.evidence as Row)?.materialSha256!==(request.material.sourceEvidence as Row)?.materialSha256)throw new Error('formal_candidate_or_requirements_changed');
    if(request.supplementVerification)await verifiedRepairSupplementTests(request.supplementVerification,request.candidate.H);
   },()=>{if(!this.accepting)throw new Error('formal_controller_closing');},state.executionRound);
 }
 async replaceEndedDual(id:string,operation:string,round:number){
   if(!Number.isSafeInteger(round)||this.active.has(operation)||this.hosts.has(operation))throw new Error('formal_dual_replacement_not_verified');
   const {entry,source}=this.entry(id),q=await QueueStore.open(source.store);
   try{return await withQueueRepairLock(source.store,operation,async()=>{
     const state=q.formalReviews().state(operation);
     if(state.request.entry!==id||state.executionRound!==round||state.phase!=='waiting'||this.hosts.has(operation))throw new Error('formal_dual_replacement_not_verified');
     return this.public(await this.makeHost(q,operation,state,entry,source).replaceEndedDual());
   });}finally{q.close();}
 }
 private async execute(id:string,operation:string){
  const {entry,source}=this.entry(id);
  const q=this.hosts.get(operation)?.q??await QueueStore.open(source.store);
  try{
   return await withQueueRepairLock(source.store,operation,async()=>{
    const state=q.formalReviews().state(operation);
    if(state.terminal||state.stopped)return state;
    let host=this.hosts.get(operation);
    if(!host){
     host=this.makeHost(q,operation,state,entry,source);
     this.hosts.set(operation,host);
    }
    const closed=state.request.workflowReview?null:await host.settleRejectedReview();
    if(closed)return closed;
    try{
     return await (state.request.workflowReview?runDualFormalReviewRound(host,state.request.workflowReview,this.readWorkInbox):runFormalReviewRound(host));
    }catch(error){
     const rejected=state.request.workflowReview?null:await host.settleRejectedReview();
     if(rejected)return rejected;
     throw error;
    }
   });
  }catch(error){
   q.formalReviews().progress(operation,'waiting',{reason:error instanceof Error?error.message:'formal_execution_unknown',originalExecutionRetained:true});
   throw error;
  }finally{
   if(!this.hosts.get(operation)?.ownedFact()&&!this.hosts.get(operation)?.ownsDual()){
    this.hosts.delete(operation);
    q.close();
   }
  }
 }
 async report(id:string,operation:string){const {source}=this.entry(id),q=await QueueStore.open(source.store);try{const s=await this.currentView(q.formalReviews().state(operation));if(s.request.entry!==id)throw new Error('formal_entry_not_selected');return {...this.public(s),material:s.request.material,prompts:s.request.prompts,...(s.request.workflowReview?{workflowReview:s.request.workflowReview}:{}),fullStages:s.stages.map((s:Row)=>({key:s.stage.key,role:s.stage.role,result:s.returned?.result??null,proof:s.returned?.proof??null})),result:s.terminal?.result??null,...(s.replacement?{replacement:s.replacement}:{}),originalsRetained:true};}finally{q.close();}}
 async stop(id:string,operation:string,project:Pick<FormalWorkbenchProject,'account'|'repository'>|undefined=this.workbenchProject,legacyProject?:FormalWorkbenchProject){const {source}=this.entry(id),q=await QueueStore.open(source.store);try{const s=q.formalReviews().state(operation);if(s.request.entry!==id)throw new Error('formal_entry_not_selected');
  // New project requests retain their verified identity in the original blob,
  // so cleanup survives a cold/offline page. Old inputs stay immutable and need
  // an already discovered local selection rather than guessed header mapping.
  const bound=s.request.workbenchProject??legacyProject;if(project||bound){if(!project||!bound||!Number.isSafeInteger(project.account)||!Number.isSafeInteger(project.repository)||project.account!==bound.account||project.repository!==bound.repository||bound.fullName.toLowerCase()!==s.request.candidate.repository.toLowerCase())throw new Error('formal_stop_outside_project');}
  const stopped=this.public(q.formalReviews().stop(operation)),host=this.hosts.get(operation);
  if(host?.ownsDual()&&!this.active.has(operation)){
   this.hosts.delete(operation);try{await host.closeDual();}finally{host.q.close();}
  }
  return stopped;}finally{q.close();}}
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
 async drain(){this.accepting=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;await this.checking;await Promise.allSettled(this.active.values());for(const host of this.hosts.values()){await Promise.allSettled([host.ownedFact()?.session.close(),host.closeDual()]);host.releaseFact();host.q.close();}this.hosts.clear();}
}
