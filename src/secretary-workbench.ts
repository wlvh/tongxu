import {parseWorkbenchPlan} from './workbench.js';
import {OwnerControls} from './owner-controls.js';
import {OverallControls} from './overall-controls.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messagePath} from './message-contract.js';

export type SecretaryWorkbenchRef={path:string;sha256:string;source:string};
export function validateSecretaryWorkbench(ref:unknown):asserts ref is SecretaryWorkbenchRef{
  const r=ref as SecretaryWorkbenchRef;
  if(!exactKeys(r,['path','sha256','source'])||!messagePath(r.path)||!isAuthorityDigest(r.sha256)||typeof r.source!=='string'||!/^[a-z0-9-]{1,64}$/.test(r.source))throw new Error('secretary_workbench_selection_invalid');
}
/** Read the selected page's existing projections. This interface deliberately
 * exposes no preparation, application, model dispatch or control mutation. */
export class SecretaryWorkbench{
  private constructor(private ref:SecretaryWorkbenchRef,private owners:OwnerControls|null,private overall:OverallControls|null,private reviewIds:string[]){}
  static async load(ref:SecretaryWorkbenchRef,store:string,item:string){
    validateSecretaryWorkbench(ref);const bytes=await regular(ref.path,128*1024);if(hash(bytes)!==ref.sha256)throw new Error('secretary_workbench_selection_changed');
    const plan=parseWorkbenchPlan(bytes),source=plan.sources.find(s=>s.id===ref.source);
    if(!source||source.store!==store||source.item!==item)throw new Error('secretary_workbench_task_mismatch');
    const selected=(plan.overallReviews??[]).filter(r=>r.source===source.id),owners=plan.ownerControls?.includes(source.id)?new OwnerControls([source.id],[source]):null,overall=selected.length?await OverallControls.load(selected,[source]):null;
    return new SecretaryWorkbench(structuredClone(ref),owners,overall,selected.map(r=>r.id));
  }
  manifest(){return {planSha256:this.ref.sha256,source:this.ref.source,ownerSelected:!!this.owners,overallReviewIds:this.reviewIds,readOnly:true,ownerDecisionToolsAvailable:false};}
  async owner(){return {selection:this.manifest(),owner:this.owners?(await this.owners.state())[0]:{available:false,reason:'owner_control_not_selected'},permissionsGranted:false};}
  async reviews(){
    // This readonly object is not the page's running controller. Its empty
    // process-local active map cannot prove that an original review is idle.
    const reviews=(this.overall?await this.overall.state():[]).map(({active,currentControllerProblem,...original})=>original);
    return {selection:this.manifest(),reviews,controllerActivity:'not_observed',permissionsGranted:false};
  }
  async report(id:string){if(!this.overall||!this.reviewIds.includes(id))throw new Error('secretary_overall_report_not_selected');return this.overall.report(id);}
}
