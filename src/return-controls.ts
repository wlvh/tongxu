import {hash,privateDirectory} from './snapshot.js';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonical} from './comparison.js';
import {regular} from './repair-workspace.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {QueueStore} from './queue-store.js';
import {parseQueueRepairPlan,type QueueRepairPlan} from './queue-repair.js';
import {parseMemberRefutationPlan,type MemberRefutationPlan} from './member-refutation-contract.js';
import {LiveProcess,checkCapture,save} from './live-process.js';
import type {ProjectRequest} from './project-repair.js';
import {readRepairReports} from './repair.js';
import {loadReturnPreparation,resolvePreparedReturn,freezePreparedReturn,type ReturnPreparation,type ReturnPreparationEntry} from './return-preparation.js';
import {currentAIPreferences} from './ai-settings.js';

type Ref={path:string;sha256:string};
type Source={id:string;store:string;item:string};
type Entry={id:string;title:string;source:string;repair:Ref;afterRefutation:Ref|null};
type Frozen={entry:Entry;source:Source;raw:Buffer;plan:QueueRepairPlan;request:ProjectRequest;refutation:{raw:Buffer;plan:MemberRefutationPlan}|null;preparation?:{selectionSha256:string;prepared:boolean;originalOperation:string;permissionsGranted:boolean}};
const ref=(v:unknown):v is Ref=>exactKeys(v,['path','sha256'])&&messagePath((v as Ref).path)&&isAuthorityDigest((v as Ref).sha256);
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'original_return_work_unavailable';

/** A selected-plan consumer. All sending, writer ownership, authority and
 * recovery still belong to the original repair and receiver controllers. */
export class ReturnControls {
  private accepting=true;
  private preparing=new Set<Promise<unknown>>();
  private active=new Map<string,Promise<unknown>>();
  private problems=new Map<string,string>();
  private constructor(private entries:Frozen[],private incoming:ReturnPreparation[]){}
  static async load(path:string,sha256:string,sources:Source[],selectedSources?:ReadonlySet<string>){
    if(!messagePath(path)||!isAuthorityDigest(sha256))throw new Error('return_control_reference_invalid');const raw=await regular(path,128*1024);if(hash(raw)!==sha256)throw new Error('return_control_catalog_changed');const p=JSON.parse(raw.toString());
    if(!exactKeys(p,['schemaVersion','kind','entries'])||![1,2].includes(p.schemaVersion)||p.kind!=='tongxu-return-controls'||!Array.isArray(p.entries)||!p.entries.length||p.entries.length>8)throw new Error('return_control_catalog_invalid');
    const ids=new Set(),operations=new Set(),entries:Frozen[]=[],incoming:ReturnPreparation[]=[];
    for(const e of p.entries as (Entry&Partial<ReturnPreparationEntry>)[]){
      const source=sources.find(s=>s.id===e?.source);
      if(!source||!messageId(e.id)||ids.has(e.id)||typeof e.title!=='string'||!e.title.trim()||e.title.length>160||/[\x00-\x1f]/.test(e.title))throw new Error('return_control_entry_invalid');
      if(selectedSources&&!selectedSources.has(source.id))continue;
      if(p.schemaVersion===2&&Object.hasOwn(e,'prepare')){
        if(!exactKeys(e,['id','title','source','prepare'])||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(e.id))throw new Error('return_preparation_entry_invalid');
        incoming.push(await loadReturnPreparation(e as ReturnPreparationEntry,source));ids.add(e.id);continue;
      }
      if(!exactKeys(e,['id','title','source','repair','afterRefutation'])||!ref(e.repair)||e.afterRefutation!==null&&!ref(e.afterRefutation))throw new Error('return_control_entry_invalid');
      const raw=await regular(e.repair.path,128*1024);if(hash(raw)!==e.repair.sha256)throw new Error('return_control_plan_changed');const plan=parseQueueRepairPlan(raw),key=canonical([plan.store,plan.operation]);
      if(plan.store!==source.store||operations.has(key))throw new Error('return_control_task_mismatch');let refutation:Frozen['refutation']=null;
      if(e.afterRefutation){const b=await regular(e.afterRefutation.path,32768);if(hash(b)!==e.afterRefutation.sha256)throw new Error('return_control_plan_changed');const rp=parseMemberRefutationPlan(b);if(rp.store!==plan.store||rp.repairPlan.sha256!==hash(raw)||canonical(rp.memberReturn)!==canonical(plan.memberReturn))throw new Error('return_control_refutation_source_mismatch');refutation={raw:b,plan:rp};}
      // The selected-task database binding is checked per view/action, so an
      // unavailable task cannot hide unrelated tasks at workbench startup.
      const requestRaw=await regular(plan.request,2*1024*1024);if(hash(requestRaw)!==plan.requestSha256)throw new Error('return_control_request_changed');const request=JSON.parse(requestRaw.toString()) as ProjectRequest;
      if(!Array.isArray(request.allowedPaths)||request.allowedPaths.some(p=>typeof p!=='string')||!Array.isArray(request.protectedPaths)||!messagePath(request.executionRoot)||typeof request.contract!=='string')throw new Error('return_control_request_invalid');
      ids.add(e.id);operations.add(key);entries.push({entry:structuredClone(e),source:structuredClone(source),raw,plan,request,refutation});
    }
    if(incoming.some(p=>entries.some(e=>e.entry.id.startsWith(p.entry.id+':')))||new Set(incoming.map(p=>p.source.store+':'+p.source.item)).size!==incoming.length)throw new Error('return_preparation_selection_ambiguous');
    return new ReturnControls(entries,incoming);
  }
  private incomingFor(id:string){const f=this.incoming.find(f=>id.startsWith(f.entry.id+':'));return f?{f,operation:id.slice(f.entry.id.length+1)}:null;}
  private async selected(id:string):Promise<Frozen>{const f=this.entries.find(f=>f.entry.id===id);if(f)return f;const p=this.incomingFor(id);if(!p)throw new Error('return_control_not_selected');return resolvePreparedReturn(p.f,p.operation);}
  private key(f:Frozen){return canonical([f.source.store,f.plan.operation]);}
  private async invoke(f:Frozen,action:string,plan:Ref){
    const directory=join(f.source.store,'return-work-'+f.plan.operation+'-'+randomUUID()),worker=fileURLToPath(new URL('./return-work-worker.js',import.meta.url));await privateDirectory(directory,true);
    const aiPreferences=currentAIPreferences(['reviewer','verifier_fact','verifier_impact']),input=join(directory,'input.json');
    save(input,{kind:'fixed-original-return-invocation',action,plan,operation:f.plan.operation,item:f.source.item,workerSha256:hash(await regular(worker,128*1024)),originalQueueIsAuthoritative:true,...(aiPreferences?{aiPreferences}:{})});
    if(!this.accepting){save(join(directory,'held-before-launch.json'),{reason:'return_control_closing',controllerLaunched:false,newModelInputs:0});throw new Error('return_control_closing');}
    const child=new LiveProcess(directory,process.execPath,[worker,action,plan.path,plan.sha256,...(aiPreferences?[input,hash(await regular(input,256*1024))]:[])],directory,process.env);
    await child.closed;await checkCapture(directory);const result=child.events[0];
    if(child.events.length!==1||result?.kind!=='tongxu-return-worker'||result.action!==action||result.inputSha256!==plan.sha256)throw new Error('return_worker_result_unknown');
    if(child.exit?.code!==0||result.controllerReturned!==true)throw new Error(typeof result.reason==='string'&&/^[a-z0-9_]+$/.test(result.reason)?result.reason:'original_return_worker_failed');
    // This receipt only says that the owned controller returned. The next
    // action and displayed result are derived from the original queue below.
  }
  private async view(f:Frozen,full=false){
    const key=this.key(f),base={id:f.entry.id,title:f.entry.title,source:f.entry.source,active:this.active.has(key),currentControllerProblem:this.problems.get(key)??null,...(f.preparation?{preparation:f.preparation}:{}),selectedWork:{executionRoot:f.request.executionRoot,allowedPaths:f.request.allowedPaths,protectedPaths:f.request.protectedPaths,contract:f.request.contract,authorizationSource:f.request.authorization?.source??null,authorizationIsRecheckedByOriginalExecutor:true}};
    try{const repair=await QueueStore.observeQueueRepair(f.source.store,f.source.item,f.raw,full);let refutation=null;
      if(f.refutation&&repair.result?.status==='skipped_refuted')refutation=await QueueStore.observeMemberRefutation(f.source.store,f.source.item,f.refutation.raw,full);
      let originalReports=null;
      if(full&&repair.originalResult){try{originalReports={available:true,...await readRepairReports(repair.originalRequest.executionRoot,repair.originalRequestSha256!,repair.originalResult,repair.originalEvidence.terminalRecordSha256)};}catch(e){originalReports={available:false,reason:reason(e),complete:false,modelCallsStartedByThisRead:0};}}
      return {...base,available:true,repair,originalReports,refutation,refutationConfigured:!!f.refutation,refutedNeedsNewReception:repair.result?.status==='skipped_refuted'&&refutation?.phase!=='returned',modelCallsStartedByThisRead:0,ownerApproval:false,productionActionAllowed:false};
    }catch(e){return {...base,available:false,reason:reason(e),modelCallsStartedByThisRead:0,ownerApproval:false};}
  }
  async state(){
    const original=await Promise.all(this.entries.map(f=>this.view(f))),incoming=await Promise.all(this.incoming.map(async f=>{
      const base={id:f.entry.id,title:f.entry.title,source:f.entry.source,active:false,permissionsGranted:false};
      try{const rows=await QueueStore.observeIncomingReturns(f.source.store,f.source.item);if(!rows.length)return [{...base,available:true,waitingForReturn:true}];
        return Promise.all(rows.map(async row=>{try{return await this.view(await resolvePreparedReturn(f,row.operation));}catch(e){return {...base,id:f.entry.id+':'+row.operation,available:false,reason:reason(e)};}}));
      }catch(e){return [{...base,available:false,reason:reason(e)}];}
    }));return [...original,...incoming.flat()];
  }
  async report(id:string){return this.view(await this.selected(id),true);}
  begin(id:string,action:string,body:any){const work=this.beginSelected(id,action,body);this.preparing.add(work);return work.finally(()=>this.preparing.delete(work));}
  private async beginSelected(id:string,action:string,body:any){
    if(!this.accepting)throw new Error('return_control_closing');const incoming=this.incomingFor(id);
    if(!['start','reconcile','close-unstarted'].includes(action)||!(incoming?exactKeys(body,['selectionSha256'])&&isAuthorityDigest(body.selectionSha256):exactKeys(body,[])))throw new Error('return_control_fixed_action_required');
    let f=await this.selected(id);const key=this.key(f);if(incoming&&f.preparation?.selectionSha256!==body.selectionSha256)throw new Error('return_preparation_selection_changed');if(this.active.has(key))return {accepted:true,duplicate:true,id,action:'read_original_active_operation',newModelInputs:0};
    if(incoming){if(action!=='start'&&!f.preparation?.prepared)throw new Error('return_preparation_not_started');f=await freezePreparedReturn(incoming.f,incoming.operation,body.selectionSha256,()=>{if(!this.accepting)throw new Error('return_control_closing');});}
    if(!(await regular(f.entry.repair.path,128*1024)).equals(f.raw)||f.refutation&&!(await regular(f.entry.afterRefutation!.path,32768)).equals(f.refutation.raw))throw new Error('return_control_plan_changed');
    await QueueStore.observeQueueRepair(f.source.store,f.source.item,f.raw);
    if(!this.accepting)throw new Error('return_control_closing');if(this.active.has(key))return {accepted:true,duplicate:true,id,action:'read_original_active_operation',newModelInputs:0};
    this.problems.delete(key);
    const pending=(async()=>{
      await this.invoke(f,action,f.entry.repair);if(action==='close-unstarted')return;
      const original=await QueueStore.observeQueueRepair(f.source.store,f.source.item,f.raw);
      if(original.phase==='returned'&&original.result?.status==='skipped_refuted'&&f.refutation&&this.accepting)await this.invoke(f,'refutation',f.entry.afterRefutation!);
    })().catch(e=>{this.problems.set(key,reason(e));return {failed:true,reason:reason(e),automaticResend:false};}).finally(()=>this.active.delete(key));
    this.active.set(key,pending);return {accepted:true,id,action,registrationIsNotExecution:true};
  }
  async drain(){this.accepting=false;while(this.preparing.size||this.active.size)await Promise.allSettled([...this.preparing,...this.active.values()]);}
}
