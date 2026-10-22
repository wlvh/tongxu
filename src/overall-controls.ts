import {QueueStore} from './queue-store.js';
import {overallReview,type OverallPlan} from './overall-review.js';
import {regular} from './repair-workspace.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messagePath} from './message-contract.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';

type Source={id:string;title:string;store:string;item:string};
export type OverallSelection={id:string;title:string;source:string;plan:{path:string;sha256:string}};
type Frozen={entry:OverallSelection;source:Source;bytes:Buffer;plan:OverallPlan};
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'overall_source_unavailable';
export function validateOverallSelections(values:unknown,sources:string[]):asserts values is OverallSelection[]{
  if(!Array.isArray(values)||!values.length||values.length>8)throw new Error('workbench_overall_selection_invalid');const ids=new Set();
  for(const v of values){if(!exactKeys(v,['id','title','source','plan'])||typeof v.id!=='string'||!/^[a-z0-9-]{1,64}$/.test(v.id)||ids.has(v.id)||typeof v.title!=='string'||!v.title.trim()||v.title.length>160||/[\x00-\x1f]/.test(v.title)||!sources.includes(v.source)||!exactKeys(v.plan,['path','sha256'])||!messagePath(v.plan.path)||!isAuthorityDigest(v.plan.sha256))throw new Error('workbench_overall_selection_invalid');ids.add(v.id);}
}
/** A UI over the existing on-demand review, not another model workflow. */
export class OverallControls{
  private active=new Map<string,Promise<unknown>>();private problems=new Map<string,string>();private accepting=true;
  private constructor(private frozen:Frozen[]){}
  static async load(selections:OverallSelection[],sources:Source[]){
    validateOverallSelections(selections,sources.map(s=>s.id));const frozen:Frozen[]=[],identities=new Set();
    for(const entry of selections){const source=structuredClone(sources.find(s=>s.id===entry.source)!),bytes=await regular(entry.plan.path,128*1024);if(hash(bytes)!==entry.plan.sha256)throw new Error('overall_selected_plan_changed');const plan=JSON.parse(bytes.toString()) as OverallPlan;
      if(plan.kind!=='tongxu-overall-review'||plan.schemaVersion!==1||plan.store!==source.store||!plan.material||Object.keys(plan.material).sort().join()!=='acceptedBaseline,cumulativeChanges,currentBehavior,currentDocuments'||Object.values(plan.material).some(refs=>!Array.isArray(refs)||refs.some(m=>typeof m.name!=='string'||!isAuthorityDigest(m.sha256))))throw new Error('overall_selected_plan_invalid');
      const state=await QueueStore.observeOverallReview(source.store,source.item,bytes),identity=canonical([source.store,state.id]);if(identities.has(identity))throw new Error('overall_duplicate_selection');identities.add(identity);frozen.push({entry:structuredClone(entry),source,bytes,plan});
    }return new OverallControls(frozen);
  }
  private selected(id:string){const f=this.frozen.find(f=>f.entry.id===id);if(!f)throw new Error('overall_review_not_selected');return f;}
  async state(){return Promise.all(this.frozen.map(async f=>{const base={id:f.entry.id,title:f.entry.title,source:f.entry.source,trigger:structuredClone(f.plan.trigger),material:Object.fromEntries(Object.entries(f.plan.material).map(([kind,refs])=>[kind,refs.map(({name,sha256})=>({name,sha256}))])),active:this.active.has(f.entry.id),currentControllerProblem:this.problems.get(f.entry.id)??null};try{return {...base,...await QueueStore.observeOverallReview(f.source.store,f.source.item,f.bytes),id:f.entry.id,available:true};}catch(e){return {...base,available:false,reason:reason(e)};}}));}
  async report(id:string){const f=this.selected(id),r=await QueueStore.observeOverallReview(f.source.store,f.source.item,f.bytes,true);if(!('report' in r))throw new Error('report_not_found');return {...r,id,source:f.entry.source};}
  begin(id:string,action:'prepare'|'run'|'reconcile'|'close-unstarted'){
    if(!this.accepting)throw new Error('overall_workbench_closing');const f=this.selected(id);if(this.active.has(id))return {accepted:true,id,duplicate:true,action:'read_original_active_operation',modelDispatched:false};
    if(!['prepare','run','reconcile','close-unstarted'].includes(action))throw new Error('overall_action_invalid');
    this.problems.delete(id);const work=overallReview(f.entry.plan.path,action,action==='close-unstarted'?'fixed-workbench-confirmed-unstarted:'+f.entry.plan.sha256:undefined,f.entry.plan.sha256).catch(async e=>{
      this.problems.set(id,reason(e));
      // The normal controller records failures after preparation. Also retain
      // an early fixed-file failure against this selected original if present.
      let q:QueueStore|undefined;try{q=await QueueStore.open(f.source.store);q.reviewRecords().overallProblem(f.bytes,reason(e));}catch{}finally{q?.close();}
      return {failed:true,reason:reason(e),automaticResend:false};
    }).finally(()=>this.active.delete(id));this.active.set(id,work);return {accepted:true,id,action,registrationIsNotExecution:true};
  }
  async drain(){this.accepting=false;await Promise.allSettled([...this.active.values()]);}
}
