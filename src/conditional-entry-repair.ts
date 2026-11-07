import {dirname,join,basename} from 'node:path';
import {realpath,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {exactKeys,isAuthorityDigest,safeRelativePath,scopeBodyHash,type ActionRequest} from './authority-contract.js';
import {messagePath} from './message-contract.js';
import type {ConditionalEntryPlan,ConditionalRef} from './conditional-entry-contract.js';
import type {CoordinationPlan} from './coordination-contract.js';
import type {QueueStore} from './queue-store.js';
import type {ProjectRequest} from './project-repair.js';
import {parsePlan} from './verification.js';
import {parseQueueRepairPlan} from './queue-repair.js';
import {readOwnerSource} from './authority-source.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';

export type ConditionalRepairProfile={schemaVersion:1;kind:'tongxu-conditional-repair-capability';objects:string;allowedPaths:string[];materialPaths:string[];protectedPaths:string[];contract:string;testPlan:ConditionalRef;config:ConditionalRef;authorization:ProjectRequest['authorization'];demonstrationFixture:boolean;generatedDirectories:string[]};
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!v.includes('\0');
const paths=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(safeRelativePath);
const ref=(r:any)=>exactKeys(r,['path','sha256'])&&messagePath(r.path)&&isAuthorityDigest(r.sha256);
export function parseConditionalRepairProfile(raw:Buffer):ConditionalRepairProfile{
 if(raw.length>128*1024)throw new Error('conditional_entry_repair_profile_invalid');let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('conditional_entry_repair_profile_invalid');}
 if(!exactKeys(p,['schemaVersion','kind','objects','allowedPaths','materialPaths','protectedPaths','contract','testPlan','config','authorization','demonstrationFixture','generatedDirectories'])||p.schemaVersion!==1||p.kind!=='tongxu-conditional-repair-capability'||!messagePath(p.objects)||!paths(p.allowedPaths,32)||!p.allowedPaths.length||!paths(p.materialPaths,64)||!paths(p.protectedPaths,128)||p.allowedPaths.some((x:string)=>!p.materialPaths.includes(x)||p.protectedPaths.includes(x))||!text(p.contract,16000)||!ref(p.testPlan)||!ref(p.config)||!exactKeys(p.authorization,['source','allowRepair','allowReconcileEnded','maxRepairRounds'])||!text(p.authorization.source,16000)||p.authorization.allowRepair!==true||typeof p.authorization.allowReconcileEnded!=='boolean'||!Number.isInteger(p.authorization.maxRepairRounds)||p.authorization.maxRepairRounds<1||p.authorization.maxRepairRounds>3||typeof p.demonstrationFixture!=='boolean'||!paths(p.generatedDirectories,16))throw new Error('conditional_entry_repair_profile_invalid');return p;
}
async function reference(ref:ConditionalRef){const b=await regular(ref.path,2*1024*1024);if(hash(b)!==ref.sha256)throw new Error('conditional_entry_repair_capability_changed');return b;}
async function fixed(path:string,b:Buffer){try{await writeFile(path,b,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}if(!(await regular(path,2*1024*1024)).equals(b))throw new Error('conditional_entry_original_repair_changed');}

/** Called under the normal entry derivation lock. The original queue repair
 * still owns the write reservation, native process and all resource effects. */
export async function prepareConditionalRepair(q:QueueStore,entry:ConditionalEntryPlan,plan:CoordinationPlan,id:string,root:string,taskId:string,finding?:number){
 const cap=entry.repairs?.find(r=>r.task===taskId),task=plan.tasks.find(t=>t.id===taskId);
 if(!cap||!task)throw new Error('conditional_entry_repair_not_configured');
 const key='repair-'+taskId,previous=q.coordination().normalEntryHistory(id,entry.id,key);
 if(previous){
  if(previous.reference.kind!=='repair'||previous.reference.finding!==(finding??null))throw new Error('conditional_entry_original_repair_selection_required');
  const p=parseQueueRepairPlan(previous.request),path=join(root,'repair-'+previous.requestSha256+'.json');await fixed(path,previous.request);
  return {path,plan:p,resources:(previous.reference.resources??[]) as ResourceRequest[],original:true};
 }
 const profile=parseConditionalRepairProfile(await reference(cap.profile)),config=await reference(profile.config);await reference(profile.testPlan);
 if(await realpath(profile.objects)!==profile.objects||!task.workspace||basename(task.workspace)!=='workspace')throw new Error('conditional_entry_repair_workspace_invalid');
 const assigned=[...task.independentPaths,...plan.shared.filter(p=>p.tasks.includes(task.id)).flatMap(p=>p.paths)];
 if(profile.allowedPaths.some(p=>!assigned.includes(p)))throw new Error('coordination_repair_path_not_assigned');
 const test=parsePlan(JSON.parse((await reference(profile.testPlan)).toString()));if(test.schemaVersion!==2)throw new Error('project_test_requires_registered_docker');
 const source=q.conditionalRepairSource(task.item,finding),coordination=q.coordination().repairHandoff(id,task.id);
 if(source.candidate.repository!==entry.repository||source.candidate.targetRef!==entry.target||(JSON.parse(config.toString()).executionKind??'native_capture')!==source.executionKind)throw new Error('conditional_entry_repair_source_changed');
 const directory=join(root,'repair-input-'+hash(canonical([task.id,source.operation])).slice(0,48));if(!await exists(directory))await privateDirectory(directory,true);else await privateDirectory(directory,false);
 const c=source.candidate,request:ProjectRequest={schemaVersion:1,kind:'tongxu-project-repair-request',executionRoot:dirname(task.workspace),objects:profile.objects,candidate:{kind:'github-pr',repository:c.repository,pr:c.pr,H:c.H,B:c.B,target:c.targetRef},allowedPaths:profile.allowedPaths,materialPaths:profile.materialPaths,protectedPaths:profile.protectedPaths,contract:profile.contract,testPlan:profile.testPlan.path,testPlanSha256:profile.testPlan.sha256,findings:[],authorization:profile.authorization,demonstrationFixture:profile.demonstrationFixture,generatedDirectories:profile.generatedDirectories};
 let operation=source.operation,memberReturn;
 if(source.kind==='member'){
  const selected=q.integrationMemberReturns().record(Buffer.from(canonical(source.selection)));memberReturn={id:selected.id,requestSha256:selected.requestSha256,sourceSha256:selected.sourceSha256};
  const begun=q.begin(task.item,'conditional-entry-member:'+entry.id);if(begun.blocked)throw new Error('conditional_entry_original_member_operation_waiting');operation=begun.operation;if(begun.status==='running')q.evaluate(operation);
 }
 const resources:ResourceRequest[]=[],auth=cap.authorization,owner=await ownerConfigured(entry,plan),intent=auth?'entry-implement-'+hash(canonical([entry.id,task.id,operation,source.packet,source.bindingHash??source.selection.reception.bindingHash])).slice(0,48):null;
 if(owner){
  if(!auth||!intent)throw new Error('conditional_entry_repair_authority_required');const a=q.authority(),decision=a.inspectRecordedDecision(auth.authorization);if(decision.proposal.kind!=='delegate'||decision.proposal.adoption!==auth.adoption)throw new Error('conditional_entry_existing_implementation_delegation_required');
  const path=join(root,'owner-repair-'+randomUUID()),observations=[];await privateDirectory(path,true);for(const [i,r] of a.sourceRequests(auth.authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,r.proposalSha256,r.commentId,join(path,String(i))));
  const baseline=a.adoptionBaseline(auth.adoption,observations),action:ActionRequest={schemaVersion:1,scopeId:source.context.scope.id,scopeVersion:source.context.scope.version,scopeBodySha256:scopeBodyHash(baseline.body),repository:c.repository,target:c.targetRef,action:'implement',item:task.item,candidate:{H:c.H,B:c.B,subjectSha256:null},paths:profile.allowedPaths,resourceRefs:auth.budgets.map(b=>b.resourceRef)};
  const reserved=a.reserveAction(intent,action,'implementer',auth.authorization,observations);if(reserved.mode!=='delegated')throw new Error('conditional_entry_existing_implementation_delegation_required');
  resources.push(...auth.budgets.map(b=>({schemaVersion:1 as const,...b,repository:c.repository,operation,authorityIntent:intent,role:'implementer' as const,actionSha256:hash(canonical(action))})));
 }else if(auth)throw new Error('conditional_entry_owner_profile_required');
 const project=Buffer.from(canonical(request)),projectPath=join(directory,'project.json'),configPath=join(directory,'config.json');await fixed(projectPath,project);await fixed(configPath,config);
 const p=parseQueueRepairPlan(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-queue-repair',store:entry.store,operation,packet:source.packet,judgmentId:source.judgmentId??source.selection.reception.judgmentId,bindingHash:source.bindingHash??source.selection.reception.bindingHash,context:source.context,request:projectPath,requestSha256:hash(project),config:configPath,configSha256:hash(config),coordination,...(memberReturn?{memberReturn}:{}),...(intent?{governance:{authorityIntent:intent,resourceRequests:resources.map(resourceRequestHash)}}:{})}))),raw=Buffer.from(canonical(p));
 const step=q.coordination().normalEntryStep(id,entry.id,key,raw,{kind:'repair',id:operation,item:task.item,task:task.id,finding:finding??null,memberReturn:memberReturn??null,resources}),path=join(root,'repair-'+step.requestSha256+'.json');await fixed(path,raw);return {path,plan:p,resources,original:false};
}

async function ownerConfigured(entry:ConditionalEntryPlan,plan:CoordinationPlan){
 // Keep detection identical to the other normal consumers without a new
 // profile registry or an assumption based on an AI preference.
 const {QueueStore}=await import('./queue-store.js');return (await QueueStore.observeOrganization(entry.store,plan.name,plan.tasks.map(t=>t.item))).ownerSourceConfigured;
}
