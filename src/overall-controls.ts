import {QueueStore} from './queue-store.js';
import {overallReview,type OverallPlan} from './overall-review.js';
import {regular} from './repair-workspace.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messagePath,messageId} from './message-contract.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {OwnerControls} from './owner-controls.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';

type Row=Record<string,any>;
type Source={id:string;title:string;store:string;item:string};
export type OverallSelection={id:string;title:string;source:string;plan:{path:string;sha256:string}};
type Frozen={entry:OverallSelection;source:Source;bytes:Buffer;plan:OverallPlan;record?:Row;parent?:Frozen;discoveryProblem?:string};
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'overall_source_unavailable';
const preparedId=(id:string)=>'prepared-'+id.slice(0,55);
async function ensurePrivate(path:string){try{await privateDirectory(path,true);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await privateDirectory(path,false);}}
async function fixedFile(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,256*1024)).equals(bytes))throw new Error('overall_prepared_file_changed');}}
export function validateOverallSelections(values:unknown,sources:string[]):asserts values is OverallSelection[]{
  if(!Array.isArray(values)||!values.length||values.length>8)throw new Error('workbench_overall_selection_invalid');const ids=new Set();
  for(const v of values){if(!exactKeys(v,['id','title','source','plan'])||typeof v.id!=='string'||!/^[a-z0-9-]{1,64}$/.test(v.id)||ids.has(v.id)||typeof v.title!=='string'||!v.title.trim()||v.title.length>160||/[\x00-\x1f]/.test(v.title)||!sources.includes(v.source)||!exactKeys(v.plan,['path','sha256'])||!messagePath(v.plan.path)||!isAuthorityDigest(v.plan.sha256))throw new Error('workbench_overall_selection_invalid');ids.add(v.id);}
}
/** A UI over the existing on-demand review, not another model workflow. */
export class OverallControls{
  private active=new Map<string,Promise<unknown>>();private preparing=new Set<Promise<unknown>>();private problems=new Map<string,string>();private accepting=true;
  private constructor(private frozen:Frozen[],private ownerSelected:string[]){}
  static async load(selections:OverallSelection[],sources:Source[],ownerSelected:string[]=[]){
    validateOverallSelections(selections,sources.map(s=>s.id));const frozen:Frozen[]=[],identities=new Set();
    for(const entry of selections){const source=structuredClone(sources.find(s=>s.id===entry.source)!),bytes=await regular(entry.plan.path,128*1024);if(hash(bytes)!==entry.plan.sha256)throw new Error('overall_selected_plan_changed');const plan=JSON.parse(bytes.toString()) as OverallPlan;
      if(plan.kind!=='tongxu-overall-review'||plan.schemaVersion!==1||plan.store!==source.store||!plan.material||Object.keys(plan.material).sort().join()!=='acceptedBaseline,cumulativeChanges,currentBehavior,currentDocuments'||Object.values(plan.material).some(refs=>!Array.isArray(refs)||refs.some(m=>typeof m.name!=='string'||!isAuthorityDigest(m.sha256))))throw new Error('overall_selected_plan_invalid');
      const state=await QueueStore.observeOverallReview(source.store,source.item,bytes),identity=canonical([source.store,state.id]);if(identities.has(identity))throw new Error('overall_duplicate_selection');identities.add(identity);frozen.push({entry:structuredClone(entry),source,bytes,plan});
    }return new OverallControls(frozen,ownerSelected);
  }
  private identity(f:Frozen){return canonical([f.source.store,hash(canonical(f.plan))]);}
  private async selections(){
    const list=this.frozen.map(f=>({...f}));for(const f of this.frozen){try{const records=await QueueStore.observeWorkbenchOverall(f.source.store,f.source.item,hash(canonical(f.plan)));for(const record of records){const files=await QueueStore.observeWorkbenchOverall(f.source.store,f.source.item,hash(canonical(f.plan)),record.id),plan=JSON.parse(files.plan.toString()) as OverallPlan,entry={id:preparedId(record.id),title:'已接受基线复盘 · '+f.entry.title,source:f.entry.source,plan:{path:join(f.source.store,'workbench-overall',record.id,'input.json'),sha256:record.planSha256}},derived={entry,source:f.source,bytes:files.plan,plan,record,parent:f},same=list.find(x=>this.identity(x)===this.identity(derived));if(same){if(same.source.item!==f.source.item)throw new Error('overall_duplicate_selection');same.record=record;same.parent=f;continue;}if(list.some(x=>x.entry.id===entry.id))throw new Error('overall_prepared_display_id_conflict');list.push(derived);}}catch(e){list.find(x=>x.entry.id===f.entry.id)!.discoveryProblem=reason(e);}}return list;
  }
  private async selected(id:string){const f=(await this.selections()).find(f=>f.entry.id===id);if(!f)throw new Error('overall_review_not_selected');return f;}
  async state(){const activeAtRead=new Set(this.active.keys());return Promise.all((await this.selections()).map(async f=>{const key=this.identity(f),base={id:f.entry.id,title:f.entry.title,source:f.entry.source,trigger:structuredClone(f.plan.trigger),material:Object.fromEntries(Object.entries(f.plan.material).map(([kind,refs])=>[kind,refs.map(({name,sha256})=>({name,sha256}))])),active:activeAtRead.has(key)||this.active.has(key),currentControllerProblem:this.problems.get(key)??null,derivedPreparationProblem:f.discoveryProblem??null};try{const owner=this.ownerSelected.includes(f.entry.source)?(await new OwnerControls([f.entry.source],[f.source]).state())[0]:null,readyOwner=owner&&'requests' in owner&&owner.available?owner:null,scopeCurrent=readyOwner?readyOwner.currentScope?.kind==='adopt_scope'&&readyOwner.currentScope.scopeVersion===readyOwner.taskScope.version:null;return {...base,...await QueueStore.observeOverallReview(f.source.store,f.source.item,f.bytes),id:f.entry.id,available:true,adoptedScopeCurrent:scopeCurrent,...(f.record?{preparedFromBaseline:true,baseline:f.record.baseline,proposalSha256:f.record.proposalSha256,owner}:{canPrepareFromBaseline:!!readyOwner&&scopeCurrent===true,baselinePreparationExecutionKind:readyOwner?.executionKind??null,baselineChoices:readyOwner?readyOwner.requests.filter(r=>r.applied&&r.proposal.kind==='accept_baseline').map(r=>({proposalSha256:r.proposalSha256,adoption:(r.proposal as any).adoption,sourceUrl:r.sourceUrl,createdAt:r.createdAt})):[]})};}catch(e){return {...base,available:false,reason:reason(e)};}}));}
  async report(id:string){const f=await this.selected(id),r=await QueueStore.observeOverallReview(f.source.store,f.source.item,f.bytes,true);if(!('report' in r))throw new Error('report_not_found');return {...r,id,source:f.entry.source};}
  prepareFromBaseline(id:string,body:any){const work=this.prepareBaselineSelected(id,body);this.preparing.add(work);return work.finally(()=>this.preparing.delete(work));}
  private async prepareBaselineSelected(id:string,body:any){
    if(!this.accepting)throw new Error('overall_workbench_closing');if(!exactKeys(body,['requestId','baseline'])||!messageId(body.requestId)||!isAuthorityDigest(body.baseline))throw new Error('overall_baseline_selection_invalid');const f=this.frozen.find(x=>x.entry.id===id);if(!f||!this.ownerSelected.includes(f.entry.source))throw new Error('overall_baseline_not_selected');if(hash(await regular(f.entry.plan.path,128*1024))!==f.entry.plan.sha256)throw new Error('overall_selected_plan_changed');
    const expected=preparedId(hash(canonical([f.source.item,hash(canonical(f.plan)),body.requestId])));if(this.frozen.some(x=>x.entry.id===expected))throw new Error('overall_prepared_display_id_conflict');const q=await QueueStore.open(f.source.store);let record;try{record=q.overallWorkbench().prepare(f.source.item,f.bytes,body.requestId,body.baseline);}finally{q.close();}const selected=(await this.selections()).find(x=>x.record?.id===record.id&&x.source.store===f.source.store);if(!selected)throw new Error('overall_prepared_selection_unavailable');await this.materialize(selected);return {...record,selectionId:selected.entry.id,baselineAcceptanceIsNotExecutionPermission:true,modelDispatched:false};
  }
  private async materialize(f:Frozen){
    if(!f.record||!f.parent)return;const files=await QueueStore.observeWorkbenchOverall(f.source.store,f.source.item,hash(canonical(f.parent.plan)),f.record.id);
    for(const parent of [join(f.source.store,'workbench-baselines'),join(f.source.store,'workbench-baselines',f.record.baseline),join(f.source.store,'workbench-overall'),join(f.source.store,'workbench-overall',f.record.id)])await ensurePrivate(parent);
    for(const m of files.baseline.material)await fixedFile(join(f.source.store,'workbench-baselines',f.record.baseline,m.role+'.txt'),Buffer.from(m.text));await fixedFile(f.entry.plan.path,files.plan);
  }
  private async authorize(f:Frozen,selectedAuthorization?:string){
    const q=await QueueStore.open(f.source.store);try{const a=q.authority(),proposal=a.proposal(f.record!.proposalSha256).proposal;if(proposal.kind!=='confirm_action')throw new Error('overall_workbench_exact_action_required');const authorization=selectedAuthorization??f.record!.proposalSha256,decision=a.inspectRecordedDecision(authorization).proposal;if(!['delegate','confirm_action'].includes(decision.kind)||decision.kind==='confirm_action'&&canonical(decision.request)!==canonical(proposal.request))throw new Error('overall_workbench_exact_action_required');const root=join(f.source.store,'workbench-overall-sources');await ensurePrivate(root);const run=join(root,randomUUID());await privateDirectory(run,true);const observations:OwnerObservation[]=[];for(const [index,ref] of a.sourceRequests(authorization).entries())observations.push(await readOwnerSource(a.configuration().profile,ref.proposalSha256,ref.commentId,join(run,String(index))));a.reserveAction(f.record!.authorityIntent,proposal.request,'coordinator',authorization,observations);for(const request of f.record!.resources)q.resources().prepare(request,observations,'coordinator');}finally{q.close();}
  }
  begin(id:string,action:'prepare'|'run'|'reconcile'|'close-unstarted',body:any={}){const pending=this.beginSelected(id,action,body);this.preparing.add(pending);return pending.finally(()=>this.preparing.delete(pending));}
  private async beginSelected(id:string,action:'prepare'|'run'|'reconcile'|'close-unstarted',body:any){
    if(!this.accepting)throw new Error('overall_workbench_closing');const f=await this.selected(id),key=this.identity(f);if(!this.accepting)throw new Error('overall_workbench_closing');if(!exactKeys(body,action==='run'&&Object.hasOwn(body??{},'authorization')?['authorization']:[])||body.authorization!==undefined&&(!f.record||!isAuthorityDigest(body.authorization)))throw new Error('overall_no_runtime_arguments');if(this.active.has(key))return {accepted:true,id,duplicate:true,action:'read_original_active_operation',modelDispatched:false};if(!['prepare','run','reconcile','close-unstarted'].includes(action))throw new Error('overall_action_invalid');
    this.problems.delete(key);const work=(async()=>{if(f.record){await this.materialize(f);const original=await QueueStore.observeOverallReview(f.source.store,f.source.item,f.bytes);if(action==='run'&&['not_prepared','prepared_not_sent','confirmed_unstarted'].includes(original.phase)){if(!this.ownerSelected.includes(f.entry.source))throw new Error('overall_baseline_not_selected');if(hash(await regular(f.parent!.entry.plan.path,128*1024))!==f.parent!.entry.plan.sha256)throw new Error('overall_selected_plan_changed');await this.authorize(f,body.authorization);}}if(!this.accepting)throw new Error('overall_workbench_closing');return overallReview(f.entry.plan.path,action,action==='close-unstarted'?'fixed-workbench-confirmed-unstarted:'+f.entry.plan.sha256:undefined,f.entry.plan.sha256);})().catch(async e=>{
      this.problems.set(key,reason(e));let q:QueueStore|undefined;try{q=await QueueStore.open(f.source.store);q.reviewRecords().overallProblem(f.bytes,reason(e));}catch{}finally{q?.close();}return {failed:true,reason:reason(e),automaticResend:false};
    }).finally(()=>this.active.delete(key));this.active.set(key,work);return {accepted:true,id,action,registrationIsNotExecution:true};
  }
  async drain(){this.accepting=false;while(this.preparing.size||this.active.size)await Promise.allSettled([...this.preparing,...this.active.values()]);}
}
