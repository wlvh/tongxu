import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {parseScopeFollowup} from './task-scope-followup-store.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {observeTaskWorkspace,assertTaskObservationCurrentSync} from './task-source.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';
import {prepareTaskOwner} from './tasks.js';

async function exactFile(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,512*1024)).equals(bytes))throw new Error('task_scope_prepared_file_changed');}}
/** Preparation creates original records and fixed files only. The existing
 * authority, resources and task controls still own any subsequent execution. */
export async function prepareScopeFollowup(store:string,raw:Buffer,beforeRegistration?:()=>void){
  const p=parseScopeFollowup(raw),q=await QueueStore.open(store);let result:any;
  try{
    result=q.scopeFollowups().originalFor(raw);
    if(!result){
      const preview=q.scopeFollowups().preview(raw),a=q.authority(),{profile}=a.configuration(),root=join(store,'scope-followup-sources');await mkdir(root,{recursive:true,mode:0o700});const observations:OwnerObservation[]=[];
      for(const ref of a.sourceRequests(p.adoption))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,randomUUID())));
      const original=await observeTaskWorkspace(preview.current.definition),next=await observeTaskWorkspace(preview.definition);
      result=q.scopeFollowups().prepare(raw,original,next,observations,()=>{beforeRegistration?.();assertTaskObservationCurrentSync(preview.current.definition,original);assertTaskObservationCurrentSync(preview.definition,next);});
    }else result={...result,duplicate:true,newModelRequests:0};
    const request=q.scopeFollowups().request(result.task),directory=join(store,'task-scope-followups',result.task);await mkdir(directory,{recursive:true,mode:0o700});
    const requestPath=join(directory,'owner-request.json');await exactFile(requestPath,request.bytes);const selected=await prepareTaskOwner(store,result.task,result.ownerRequest);
    const source={id:'scope-'+result.task.slice(0,32),title:'新范围下的后续工作',store,item:result.task},contact={id:'scope-'+result.task.slice(0,32),title:'原负责人按新目标继续核查',source:source.id,packet:result.packet,sourceSha256:result.sourceSha256,request:{path:requestPath,sha256:hash(request.bytes)}},controls={schemaVersion:1,kind:'tongxu-task-controls',contacts:[contact]},controlsPath=join(directory,'controls.json');await exactFile(controlsPath,Buffer.from(canonical(controls)));
    const plan={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'原任务的新范围接续',goal:'同一原负责人，准确新目标与原报告；准备、实际发送和本人接受分别记录。',sources:[source],controls:{path:controlsPath,sha256:hash(canonical(controls))},ownerControls:[source.id]},planPath=join(directory,'workbench.json');await exactFile(planPath,Buffer.from(canonical(plan)));
    return {...result,selected,source,contact,controls:{path:controlsPath,sha256:hash(canonical(controls))},workbench:{path:planPath,sha256:hash(canonical(plan))},modelStarted:false};
  }finally{q.close();}
}
/** Resolve a recorded confirmation or existing delegation using the original
 * authority consumer. This only reserves the exact already prepared action. */
export async function authorizeScopeFollowup(store:string,task:string,authorization?:string){
  const q=await QueueStore.open(store);try{
    const {prepared}=q.scopeFollowups().request(task),a=q.authority(),proposal=a.proposal(prepared.proposalSha256).proposal;
    if(proposal.kind!=='confirm_action')throw new Error('task_scope_action_proposal_changed');
    const selected=authorization??prepared.proposalSha256,root=join(store,'scope-followup-authority');await mkdir(root,{recursive:true,mode:0o700});const {profile}=a.configuration(),observations=[];
    for(const ref of a.sourceRequests(selected))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,randomUUID())));
    const decision=a.inspectRecordedDecision(selected);if(decision.proposal.kind==='confirm_action'&&canonical(decision.proposal.request)!==canonical(proposal.request)||!['confirm_action','delegate'].includes(decision.proposal.kind))throw new Error('task_scope_exact_action_required');
    const result=a.reserveAction(prepared.authorityIntent,proposal.request,'coordinator',selected,observations);return {task,authorityIntent:prepared.authorityIntent,reservation:result,modelStarted:false};
  }finally{q.close();}
}
