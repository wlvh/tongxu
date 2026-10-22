import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {DeliveryWorkspaceControls} from './delivery-workspace-controls.js';
import {OwnerControls} from './owner-controls.js';
import {parseDeliveryProfiles,type DeliveryExecutionProfile,type DeliveryExecutionPreparation} from './delivery-workbench-contract.js';
import {parsePlan} from './verification.js';
import {regular,exists} from './repair-workspace.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {readOwnerSource} from './authority-source.js';
import {runDeliveryValidation} from './delivery-validation.js';
import {runDeliveryAssessment} from './delivery-assessment.js';

type Frozen={profile:DeliveryExecutionProfile;sha256:string;tools:Array<{id:string;samples:string[]}>};
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]{1,160}$/.test(e.message)?e.message:'delivery_execution_failed';
async function fixed(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,256*1024)).equals(bytes))throw new Error('delivery_execution_prepared_file_changed');}}
/** UI selects a frozen capability; original consumers own execution, capture,
 * authority/resources and recovery. Browser bodies never supply commands. */
export class DeliveryExecutionControls{
 private active=new Map<string,Promise<unknown>>();private preparing=new Set<Promise<unknown>>();private problems=new Map<string,string>();private accepting=true;
 private constructor(private workspace:DeliveryWorkspaceControls,private frozen:Frozen[]){}
 static async load(workspace:DeliveryWorkspaceControls,path:string,sha256:string,sources:string[]){
  const bytes=await regular(path,256*1024);if(hash(bytes)!==sha256)throw new Error('delivery_profiles_changed');const catalog=parseDeliveryProfiles(bytes,sources),frozen:Frozen[]=[];
  for(const profile of catalog.profiles){let tools:Frozen['tools']=[];if(profile.kind==='validation'){const test=await regular(profile.testPlan.path,64*1024);if(hash(test)!==profile.testPlan.sha256)throw new Error('delivery_profile_test_plan_changed');const plan=parsePlan(JSON.parse(test.toString()));if(!plan.executor)throw new Error('delivery_profile_isolation_required');tools=plan.tools.filter(t=>t.expectedSampleIds?.length).map(t=>({id:t.id,samples:t.expectedSampleIds!}));if(!tools.length)throw new Error('delivery_profile_structured_samples_required');}frozen.push({profile,sha256:hash(canonical(profile)),tools});}
  return new DeliveryExecutionControls(workspace,frozen);
 }
 private key(store:string,id:string){return canonical([store,id]);}
 private async selected(batchId:string,id:string){if(!messageId(id))throw new Error('delivery_execution_id_invalid');const context=await this.workspace.context(batchId),q=await QueueStore.open(context.source.store);try{const files=q.deliveryWorkbench().files(id);if(files.record.batchSha256!==context.batch.batchSha256||!context.batch.members.some((m:any)=>m.item===files.record.member))throw new Error('delivery_execution_not_selected');return {...context,...files};}finally{q.close();}}
 async state(batchId:string){const activeAtRead=new Set(this.active.keys()),c=await this.workspace.context(batchId),profiles=this.frozen.flatMap(f=>{const root=c.roots.find(s=>s.id===f.profile.source);if(!root)return [];const members=c.members.filter(m=>m.selectedFrom===root.item&&c.batch.members.some((x:any)=>x.item===m.item));return members.length?[{id:f.profile.id,title:f.profile.title,kind:f.profile.kind,source:f.profile.source,members:members.map(m=>({source:m.source,title:m.title,item:m.item})),tools:f.tools,...(f.profile.kind==='assessment'?{tool:f.profile.runner.tool,executionKind:f.profile.executionKind}:{demonstrationFixture:f.profile.demonstrationFixture})}]:[];}),records=await QueueStore.observeDeliveryWorkbench(c.source.store,c.batch.batchSha256),executions=[];
  for(const r of records){const member=c.members.find(m=>m.item===r.member),source=member?{id:member.source,store:c.source.store,item:member.item}:null,owner=source?(await new OwnerControls([source.id],[source]).state())[0]:null;executions.push({...r,original:{id:r.original.id,phase:r.original.phase,run:r.original.run,inputSubmitted:r.original.inputSubmitted,knownUnstarted:r.original.knownUnstarted,problems:r.original.problems,transportProblems:r.original.transportProblems},owner,active:activeAtRead.has(this.key(c.source.store,r.id))||this.active.has(this.key(c.source.store,r.id)),currentControllerProblem:this.problems.get(this.key(c.source.store,r.id))??null,profileAvailable:this.frozen.some(f=>f.sha256===r.profileSha256)});}
  return {batchId,profiles,executions};
 }
 prepare(batchId:string,body:any){const work=this.prepareSelected(batchId,body);this.preparing.add(work);return work.finally(()=>this.preparing.delete(work));}
 private async prepareSelected(batchId:string,body:any){
  if(!this.accepting)throw new Error('delivery_execution_workbench_closing');if(!exactKeys(body,['requestId','profile','memberSource','evidenceSha256','scenarios','validations','mappings','question'])||!messageId(body.requestId)||!isAuthorityDigest(body.evidenceSha256))throw new Error('delivery_execution_form_invalid');const c=await this.workspace.context(batchId),f=this.frozen.find(f=>f.profile.id===body.profile),root=f&&c.roots.find(s=>s.id===f.profile.source),member=root&&c.members.find(m=>m.source===body.memberSource&&m.selectedFrom===root.item);if(!f||!member||!c.batch.members.some((m:any)=>m.item===member.item))throw new Error('delivery_execution_profile_not_selected');
  if(f.profile.kind==='validation'){if(!Array.isArray(body.mappings)||body.mappings.some((m:any)=>!exactKeys(m,['scenario','tool','samples'])||!Array.isArray(m.samples)||!f.tools.some(t=>t.id===m.tool&&m.samples.length&&m.samples.every((s:unknown)=>typeof s==='string'&&t.samples.includes(s)))))throw new Error('delivery_execution_mapping_invalid');}
  const id='delivery-'+hash(canonical([body.requestId,c.batch.batchSha256,f.profile.id,member.item])).slice(0,48),p:DeliveryExecutionPreparation={id,batchSha256:c.batch.batchSha256,member:member.item,profileSha256:f.sha256,profile:f.profile,evidenceSha256:body.evidenceSha256,scenarios:body.scenarios,validations:body.validations,mappings:body.mappings,question:body.question},q=await QueueStore.open(c.source.store);let prepared;
  try{if(!this.accepting)throw new Error('delivery_execution_workbench_closing');prepared=q.deliveryWorkbench().prepare(p);}finally{q.close();}
  await this.materialize(batchId,id);return {...prepared,modelStarted:false,permissionGranted:false};
 }
 private async materialize(batchId:string,id:string){const selected=await this.selected(batchId,id),root=join(selected.source.store,'workbench-delivery-executions');if(!await exists(root))await privateDirectory(root,true);else await privateDirectory(root,false);const directory=join(root,id);if(!await exists(directory))await privateDirectory(directory,true);else await privateDirectory(directory,false);const path=join(directory,'input.json');await fixed(path,selected.plan);return {...selected,path};}
 async applyOwner(batchId:string,body:any){if(!exactKeys(body,['execution','proposalSha256','sourceUrl']))throw new Error('delivery_execution_owner_form_invalid');const c=await this.selected(batchId,body.execution);if(body.proposalSha256!==c.record.proposalSha256)throw new Error('delivery_execution_owner_proposal_changed');const member=c.members.find(m=>m.item===c.record.member);if(!member)throw new Error('delivery_execution_member_not_selected');const source={id:member.source,store:c.source.store,item:member.item};return new OwnerControls([source.id],[source]).apply(source.id,{proposalSha256:body.proposalSha256,sourceUrl:body.sourceUrl});}
 async report(batchId:string,id:string){const c=await this.selected(batchId,id);return c.record.kind==='validation'?{kind:'validation',...await QueueStore.observeDeliveryValidationReport(c.source.store,id)}:{kind:'assessment',...await QueueStore.observeMessageReport(c.source.store,c.record.member,c.record.run,'assess')};}
 private async authorize(c:Awaited<ReturnType<DeliveryExecutionControls['selected']>>,authorization?:string){
  const q=await QueueStore.open(c.source.store);try{const a=q.authority(),proposal=a.proposal(c.record.proposalSha256).proposal;if(proposal.kind!=='confirm_action')throw new Error('delivery_execution_action_required');const chosen=authorization??c.record.proposalSha256,decision=a.inspectRecordedDecision(chosen);if(!['confirm_action','delegate'].includes(decision.proposal.kind)||decision.proposal.kind==='confirm_action'&&canonical(decision.proposal.request)!==canonical(proposal.request))throw new Error('delivery_execution_exact_action_required');const {profile}=a.configuration(),directory=join(c.source.store,'workbench-delivery-owner-sources');await mkdir(directory,{recursive:true,mode:0o700});const run=join(directory,randomUUID()),observations=[];await privateDirectory(run,true);for(const [i,ref] of a.sourceRequests(chosen).entries())observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(run,String(i))));return a.reserveAction(c.record.authorityIntent,proposal.request,proposal.performerRole,chosen,observations);}finally{q.close();}
 }
 begin(batchId:string,action:'run'|'reconcile'|'close-unstarted',body:any){
  if(!this.accepting)throw new Error('delivery_execution_workbench_closing');if(!exactKeys(body,['execution',...(Object.hasOwn(body??{},'authorization')?['authorization']:[])])||!messageId(body.execution)||body.authorization!==undefined&&(!isAuthorityDigest(body.authorization)||action!=='run'))throw new Error('delivery_execution_action_invalid');
  const pending=this.beginSelected(batchId,action,body);this.preparing.add(pending);return pending.finally(()=>this.preparing.delete(pending));
 }
 private async beginSelected(batchId:string,action:'run'|'reconcile'|'close-unstarted',body:any){
  const c=await this.materialize(batchId,body.execution),key=this.key(c.source.store,body.execution);if(!this.accepting)throw new Error('delivery_execution_workbench_closing');if(this.active.has(key))return {accepted:true,duplicate:true,execution:body.execution,automaticResend:false};
  const work=(async()=>{this.problems.delete(key);const q=await QueueStore.open(c.source.store);let state;try{state=q.deliveryWorkbench().state(body.execution);}finally{q.close();}
    if(action==='run'&&['prepared_not_registered','registered_not_started','prepared_not_started','known_unstarted'].includes(state.original.phase)){if(!this.frozen.some(f=>f.sha256===c.record.profileSha256))throw new Error('delivery_execution_profile_no_longer_selected');await this.authorize(c,body.authorization);}
    if(!this.accepting)throw new Error('delivery_execution_workbench_closing');return c.record.kind==='validation'?runDeliveryValidation(c.source.store,c.path,action):runDeliveryAssessment(c.source.store,c.path,action);
  })().catch(async e=>{const code=reason(e);this.problems.set(key,code);let q:QueueStore|undefined;try{q=await QueueStore.open(c.source.store);q.deliveryWorkbench().problem(body.execution,code,Buffer.from(e instanceof Error?e.stack??e.message:String(e)));}catch{}finally{q?.close();}return {failed:true,reason:code,automaticResend:false};}).finally(()=>this.active.delete(key));this.active.set(key,work);return {accepted:true,execution:body.execution,action,registrationIsNotExecution:true};
 }
 async drain(){this.accepting=false;while(this.preparing.size||this.active.size)await Promise.allSettled([...this.preparing,...this.active.values()]);}
}
