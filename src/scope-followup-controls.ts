import {QueueStore} from './queue-store.js';
import {prepareScopeFollowup,authorizeScopeFollowup} from './task-scope-followup.js';
import {OwnerControls} from './owner-controls.js';
import {TaskControls} from './task-controls.js';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';

type Source={id:string;title:string;store:string;item:string};
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'task_scope_source_unavailable';
/** Bounded composition of the original Owner and task controls. Preparation
 * and checking a source never create a model input. */
export class ScopeFollowupControls{
  private controllers=new Map<string,TaskControls>();private active=new Map<string,Promise<unknown>>();private preparing=new Set<Promise<unknown>>();private problems=new Map<string,string>();private accepting=true;
  constructor(private selected:string[],private sources:Source[]){}
  private key(s:Source,task:string){return canonical([s.store,task]);}
  private source(id:string){const s=this.sources.find(s=>s.id===id);if(!s||!this.selected.includes(id))throw new Error('task_scope_source_not_selected');return s;}
  private async known(source:Source,task:string,allowParent=false){if(!isAuthorityDigest(task))throw new Error('task_scope_task_not_selected');const state=await QueueStore.observeScopeFollowups(source.store,source.item);if(!(allowParent&&task===source.item)&&!state.followups.some(f=>f.task===task))throw new Error('task_scope_task_not_selected');return state;}
  async state(){const activeAtRead=new Set(this.active.keys());return Promise.all(this.selected.map(async id=>{const s=this.source(id);try{
    const state=await QueueStore.observeScopeFollowups(s.store,s.item),followups=await Promise.all(state.followups.map(async f=>{const child={id:'scope-'+f.task.slice(0,32),title:f.view.title,store:s.store,item:f.task},owner=(await new OwnerControls([child.id],[child]).state())[0],control=this.controllers.get(this.key(s,f.task)),controls=control?await control.state():null;return {...f,source:child.id,owner,control:controls?.[0]??null,controllerActive:activeAtRead.has(this.key(s,f.task))||this.active.has(this.key(s,f.task)),currentControllerProblem:this.problems.get(this.key(s,f.task))??null};}));return {source:id,available:true,original:state.original,followups};
  }catch(e){return {source:id,available:false,reason:reason(e)};}}));}
  prepare(id:string,body:any){const work=this.prepareSelected(id,body);this.preparing.add(work);return work.finally(()=>this.preparing.delete(work));}
  private async prepareSelected(id:string,body:any){
    if(!this.accepting)throw new Error('task_scope_workbench_closing');const s=this.source(id);
    if(!exactKeys(body,['task','adoption','expectedPacket','expectedSourceSha256','goal','acceptance']))throw new Error('task_scope_prepare_form_invalid');await this.known(s,body.task,true);
    if(!this.accepting)throw new Error('task_scope_workbench_closing');return prepareScopeFollowup(s.store,Buffer.from(canonical({schemaVersion:1,kind:'tongxu-task-scope-followup',...body})),()=>{if(!this.accepting)throw new Error('task_scope_workbench_closing');});
  }
  async observe(id:string,body:any){
    if(!this.accepting)throw new Error('task_scope_workbench_closing');if(!exactKeys(body,['task']))throw new Error('task_scope_observation_invalid');const s=this.source(id);await this.known(s,body.task,true);const q=await QueueStore.open(s.store);try{if(!this.accepting)throw new Error('task_scope_workbench_closing');await q.refreshSelectedTaskSources([body.task]);return {source:id,current:q.scopeFollowups().view(body.task),modelStarted:false,newModelRequests:0,workspaceModified:false};}finally{q.close();}
  }
  async owner(id:string,action:'prepare'|'apply',body:any){
    if(!exactKeys(body,['task','request']))throw new Error('task_scope_owner_request_invalid');const s=this.source(id);await this.known(s,body.task);const child={id:'scope-'+body.task.slice(0,32),store:s.store,item:body.task},owner=new OwnerControls([child.id],[child]);return action==='prepare'?owner.prepare(child.id,body.request):owner.apply(child.id,body.request);
  }
  private async control(s:Source,task:string){const key=this.key(s,task),old=this.controllers.get(key);if(old)return old;const q=await QueueStore.open(s.store);let bytes:Buffer;try{bytes=q.scopeFollowups().request(task).input;}finally{q.close();}const prepared=await prepareScopeFollowup(s.store,bytes),control=await TaskControls.load(prepared.controls.path,prepared.controls.sha256,[prepared.source]);this.controllers.set(key,control);return control;}
  begin(id:string,action:'start'|'cancel'|'close-interrupted',body:any){
    if(!this.accepting)throw new Error('task_scope_workbench_closing');if(!exactKeys(body,['task',...(Object.hasOwn(body??{},'authorization')?['authorization']:[])])||!isAuthorityDigest(body.task)||body.authorization!==undefined&&!isAuthorityDigest(body.authorization)||action!=='start'&&body.authorization!==undefined)throw new Error('task_scope_action_invalid');const s=this.source(id),task=body.task,key=this.key(s,task);
    if(this.active.has(key))return {accepted:true,duplicate:true,task,action:'read_original_active_operation',modelDispatched:false};
    this.problems.delete(key);const work=(async()=>{
      await this.known(s,task);const control=await this.control(s,task);if(!this.accepting)throw new Error('task_scope_workbench_closing');const selected=(await control.state())[0];if(!selected?.available)throw new Error('task_scope_control_unavailable');
      const controlId='scope-'+task.slice(0,32);
      if(action==='cancel')return control.cancel(controlId);
      if(action==='close-interrupted')return control.closeInterrupted(controlId);
      if(['not_registered','queued','prepared','waiting'].includes((selected as any).phase))await authorizeScopeFollowup(s.store,task,body.authorization);
      if(!this.accepting)throw new Error('task_scope_workbench_closing');return control.execute(controlId);
    })().catch(e=>{this.problems.set(key,reason(e));return {failed:true,reason:reason(e),automaticResend:false};}).finally(()=>this.active.delete(key));this.active.set(key,work);return {accepted:true,task,action,registrationIsNotExecution:true};
  }
  async native(id:string,body:any){if(!exactKeys(body,['task','request']))throw new Error('task_scope_native_request_invalid');const s=this.source(id);await this.known(s,body.task);const control=this.controllers.get(this.key(s,body.task));if(!control)throw new Error('task_scope_owned_controller_required');return control.controlNative('scope-'+body.task.slice(0,32),body.request);}
  async report(id:string,task:string){const s=this.source(id),state=await this.known(s,task),f=state.followups.find(f=>f.task===task)!;return QueueStore.observeMessageReport(s.store,task,f.run,f.ownerRequest);}
  async drain(){this.accepting=false;await Promise.allSettled([...this.active.values(),...this.preparing,...[...this.controllers.values()].map(c=>c.drain())]);await Promise.allSettled([...this.controllers.values()].map(c=>c.drain()));}
}
