import {parseWorkbenchPlan} from './workbench.js';
import {OwnerControls} from './owner-controls.js';
import {OverallControls} from './overall-controls.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messagePath} from './message-contract.js';
import {QueueStore} from './queue-store.js';

export type SecretaryWorkbenchRef={path:string;sha256:string;source:string};
export function validateSecretaryWorkbench(ref:unknown):asserts ref is SecretaryWorkbenchRef{
  const r=ref as SecretaryWorkbenchRef;
  if(!exactKeys(r,['path','sha256','source'])||!messagePath(r.path)||!isAuthorityDigest(r.sha256)||typeof r.source!=='string'||!/^[a-z0-9-]{1,64}$/.test(r.source))throw new Error('secretary_workbench_selection_invalid');
}
/** Read the selected page's existing projections. This interface deliberately
 * exposes no preparation, application, model dispatch or control mutation. */
export class SecretaryWorkbench{
  private constructor(private ref:SecretaryWorkbenchRef,private owners:OwnerControls|null,private overall:OverallControls|null,private reviewIds:string[],private source:{store:string;item:string}){}
  static async load(ref:SecretaryWorkbenchRef,store:string,item:string){
    validateSecretaryWorkbench(ref);const bytes=await regular(ref.path,128*1024);if(hash(bytes)!==ref.sha256)throw new Error('secretary_workbench_selection_changed');
    const plan=parseWorkbenchPlan(bytes),source=plan.sources.find(s=>s.id===ref.source);
    if(!source||source.store!==store||source.item!==item)throw new Error('secretary_workbench_task_mismatch');
    const selected=(plan.overallReviews??[]).filter(r=>r.source===source.id),owners=plan.ownerControls?.includes(source.id)?new OwnerControls([source.id],[source]):null,overall=selected.length?await OverallControls.load(selected,[source]):null;
    return new SecretaryWorkbench(structuredClone(ref),owners,overall,selected.map(r=>r.id),{store,item});
  }
  manifest(){return {planSha256:this.ref.sha256,source:this.ref.source,ownerSelected:!!this.owners,overallReviewIds:this.reviewIds,readOnly:true,ownerDecisionToolsAvailable:false};}
  async owner(){
    let scopeFollowups:unknown={available:false,reason:'scope_followups_not_selected'};
    if(this.owners)try{scopeFollowups={available:true,...await QueueStore.observeScopeFollowups(this.source.store,this.source.item),controllerActivity:'not_observed'};}catch(e){scopeFollowups={available:false,reason:e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'scope_followup_source_unavailable'};}
    return {selection:this.manifest(),owner:this.owners?(await this.owners.state())[0]:{available:false,reason:'owner_control_not_selected'},scopeFollowups,permissionsGranted:false};
  }
  async followupReport(task:string){
    if(!this.owners||!isAuthorityDigest(task))throw new Error('secretary_followup_not_selected');const state=await QueueStore.observeScopeFollowups(this.source.store,this.source.item),selected=state.followups.find(f=>f.task===task);if(!selected)throw new Error('secretary_followup_not_selected');return QueueStore.observeMessageReport(this.source.store,task,selected.run,selected.ownerRequest);
  }
  async reviews(){
    // This readonly object is not the page's running controller. Its empty
    // process-local active map cannot prove that an original review is idle.
    const reviews=(this.overall?await this.overall.state():[]).map(({active,currentControllerProblem,...original})=>original);
    return {selection:{...this.manifest(),derivedReviewSelection:'only_exact_descendants_of_configured_plans'},reviews,controllerActivity:'not_observed',permissionsGranted:false};
  }
  async report(id:string){if(!this.overall)throw new Error('secretary_overall_report_not_selected');try{return await this.overall.report(id);}catch(e){if((e as Error).message==='overall_review_not_selected')throw new Error('secretary_overall_report_not_selected');throw e;}}
}
