import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from './queue-store.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest,type AuthorityRole} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {parseIntegrationMemberReturn} from './integration-member-contract.js';
import {parseQueueRepairPlan,runQueueRepair} from './queue-repair.js';
import {prepareResourceRequest} from './resource-claims.js';
import {parseResourceRequest,resourceRequestHash,type ResourceRequest} from './resource-contract.js';

type Ref={path:string;sha256:string};
export type MemberRepairEntry={schemaVersion:1;kind:'tongxu-integration-member-repair';id:string;store:string;selection:Ref;project:Ref;config:Ref;authorityIntent:string|null;resources:Array<{ledgerId:string;resourceRef:string;unit:string;quantity:number}>;coordination:null|{planId:string;task:string;capability:string;fromRun:string;fromMessage:string};replacesClosedBinding:string|null;source:string};
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&!!x.trim()&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
export function parseMemberRepairEntry(raw:Buffer):MemberRepairEntry{
  if(raw.length>64*1024)throw new Error('member_repair_entry_invalid');let p:any;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}catch{throw new Error('member_repair_entry_invalid');}
  if(!exactKeys(p,['schemaVersion','kind','id','store','selection','project','config','authorityIntent','resources','coordination','replacesClosedBinding','source'])||p.schemaVersion!==1||p.kind!=='tongxu-integration-member-repair'||!messageId(p.id)||!messagePath(p.store)||![p.selection,p.project,p.config].every(r=>exactKeys(r,['path','sha256'])&&messagePath(r.path)&&isAuthorityDigest(r.sha256))||!(p.authorityIntent===null||messageId(p.authorityIntent))||!(p.replacesClosedBinding===null||isAuthorityDigest(p.replacesClosedBinding))||!text(p.source,2048)||!Array.isArray(p.resources)||p.resources.length>32||p.resources.some((r:any)=>!exactKeys(r,['ledgerId','resourceRef','unit','quantity'])||!text(r.ledgerId,128)||!text(r.resourceRef,256)||!text(r.unit,64)||!Number.isSafeInteger(r.quantity)||r.quantity<1)||new Set(p.resources.map((r:any)=>r.resourceRef)).size!==p.resources.length||p.resources.length&&!p.authorityIntent)throw new Error('member_repair_entry_invalid');
  const c=p.coordination;if(c!==null&&(!exactKeys(c,['planId','task','capability','fromRun','fromMessage'])||!isAuthorityDigest(c.planId)||!isAuthorityDigest(c.fromRun)||![c.task,c.capability,c.fromMessage].every(messageId)))throw new Error('member_repair_coordination_invalid');return p;
}
async function freeze(path:string,b:Buffer){try{await writeFile(path,b,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,2*1024*1024)).equals(b))throw new Error('member_repair_frozen_input_changed');}}
/** A single operator entry records the actual parent/member evidence, uses
 * the original member operation, and calls the existing repair executor. */
export async function runMemberRepairEntry(path:string,action:'prepare'|'run'|'reconcile-ended'='run'){
  const raw=await regular(path,64*1024),p=parseMemberRepairEntry(raw),sha=hash(canonical(p)),directory=join(p.store,'member-repair-'+sha),q=await QueueStore.open(p.store);let lock:DatabaseSync|undefined;
  try{
    if(!await exists(directory))await privateDirectory(directory,true);else await privateDirectory(directory,false);await freeze(join(directory,'request.json'),raw);const lockPath=join(directory,'controller.sqlite');try{await writeFile(lockPath,'',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await regular(lockPath);lock=new DatabaseSync(lockPath);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('member_repair_entry_controller_active');}
    const inner=join(directory,'repair-plan.json'),bindingPath=join(directory,'binding.json');let binding:any;
    if(await exists(bindingPath)){
      binding=JSON.parse((await regular(bindingPath,256*1024)).toString());if(binding.directory!==directory||binding.entrySha256!==sha)throw new Error('member_repair_original_entry_required');
      for(const [name,digest] of Object.entries(binding.files) as [string,string][]){if(!['selection.json','project-request.json','execution-config.json','repair-plan.json'].includes(name)||hash(await regular(join(directory,name),2*1024*1024))!==digest)throw new Error('member_repair_original_input_changed');}
    }else{
      const [selection,project,config]=await Promise.all([p.selection,p.project,p.config].map(async r=>{const b=await regular(r.path,2*1024*1024);if(hash(b)!==r.sha256)throw new Error('member_repair_input_changed');return b;})),selected=parseIntegrationMemberReturn(selection!),recorded=q.integrationMemberReturns().record(selection!),memberReturn={id:recorded.id,requestSha256:recorded.requestSha256,sourceSha256:recorded.sourceSha256};
      if(!recorded.current)throw new Error('member_repair_source_no_longer_current');const begun=q.begin(selected.member.item,'integration-member:'+sha);if(!begun.operation)return {entry:sha,directory,blocked:begun.blocked,newModelInputs:0};
      if(begun.status==='running')q.evaluate(begun.operation);const source=q.memberRepairInput(begun.operation,memberReturn,true),resources:ResourceRequest[]=[];let role:AuthorityRole='implementer';
      if(p.authorityIntent){const a=q.authority().reservedAction(p.authorityIntent);if(!['implementer','background'].includes(a.role)||a.request.action!=='implement'||a.request.item!==selected.member.item)throw new Error('member_repair_own_implementation_grant_required');role=a.role;
        for(const r of p.resources)resources.push(parseResourceRequest({schemaVersion:1,...r,repository:source.candidate.repository,operation:begun.operation,authorityIntent:p.authorityIntent,role,actionSha256:a.requestSha256},q.resources().configuration(r.ledgerId)));
      }
      const plan=parseQueueRepairPlan(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-queue-repair',store:p.store,operation:begun.operation,packet:selected.member.packet,judgmentId:selected.reception.judgmentId,bindingHash:selected.reception.bindingHash,context:source.context,request:join(directory,'project-request.json'),requestSha256:hash(project!),config:join(directory,'execution-config.json'),configSha256:hash(config!),memberReturn,...(p.authorityIntent?{governance:{authorityIntent:p.authorityIntent,resourceRequests:resources.map(resourceRequestHash)}}:{}),...(p.coordination?{coordination:p.coordination}:{}),...(p.replacesClosedBinding?{replacesClosedBinding:p.replacesClosedBinding}:{})}))),planBytes=Buffer.from(canonical(plan));
      let old:any;try{old=q.reviewRecords().state(begun.operation).repair;}catch(e){if(!(e instanceof Error)||e.message!=='queue_repair_not_registered')throw e;}
      if(old&&old.planSha256!==hash(planBytes)&&!(old.phase==='closed_unstarted'&&p.replacesClosedBinding===old.bindingHash&&JSON.parse(project!.toString()).executionRoot!==old.executionRoot))throw new Error('member_repair_original_plan_required');
      const files={'selection.json':selection!,'project-request.json':project!,'execution-config.json':config!,'repair-plan.json':planBytes};for(const [name,b] of Object.entries(files))await freeze(join(directory,name),b);
      binding={entrySha256:sha,directory,operation:begun.operation,memberReturn,role,resources,files:Object.fromEntries(Object.entries(files).map(([name,b])=>[name,hash(b)])),createdAt:new Date().toISOString()};await freeze(bindingPath,Buffer.from(canonical(binding)));
    }
    let terminal=false;try{terminal=['returned','closed_unstarted'].includes(q.reviewRecords().state(binding.operation).repair.phase);}catch(e){if(!(e instanceof Error)||e.message!=='queue_repair_not_registered')throw e;}
    // Reading a completed original does not re-prepare a resource or ask a
    // revoked grant to authorize the already-ended execution again.
    if(!terminal)for(const resource of binding.resources)await prepareResourceRequest(p.store,Buffer.from(canonical(resource)),binding.role);
    if(action==='prepare')return {entry:sha,directory,operation:binding.operation,repairPlan:inner,phase:'prepared',newModelInputs:0,writePermissionGranted:false};
    const result=await runQueueRepair(inner,action==='reconcile-ended');return {entry:sha,directory,operation:binding.operation,repairPlan:inner,result,manualReportCopyRequired:false,manualRepairRequired:false};
  }finally{if(lock?.isTransaction)lock.exec('ROLLBACK');lock?.close();q.close();}
}
