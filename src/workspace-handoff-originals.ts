import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,processState} from './repair-workspace.js';
import {readRepairSession} from './repair-native.js';
import {readClaudeExecution} from './live-claude.js';
import {observeManagedWorkspace,requireManagedWorkspaceObservation,managedWorkspaceStateSha256,type ManagedWorkspaceObservation} from './workspace-handoff-source.js';

type Row=Record<string,any>;
export type ManagedRepairReference={store:string;operation:string;bindingHash:string};
export type ManagedRepairSource={op:Row;repair:Row;plan:Buffer;request:Buffer;config:Buffer;evidence:Buffer};
export type ManagedRepairCapture={reference:ManagedRepairReference;sourceSignature:string;workspace:ManagedWorkspaceObservation;workspaceStateSha256:string;originals:Map<string,Buffer>;processes:Array<{directory:string;pid:number;ended:true}>;dockerExecutions:Array<{directory:string;id:string;cleanup:'removed'}>;originalControllerExclusivelyHeld:true;registeredExecutionsEnded:true;newPermissionGranted:false};
const issued=new WeakMap<object,{sha:string;active:boolean}>(),sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9-]{36}$/;
const safePath=(p:string)=>p.length>0&&!p.startsWith('/')&&!/[\x00-\x1f]/.test(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
const signature=(s:ManagedRepairSource)=>hash(canonical({operation:s.op.id,status:s.op.status,repair:s.repair,plan:hash(s.plan),request:hash(s.request),config:hash(s.config)}));
const captureHash=(c:ManagedRepairCapture)=>hash(canonical({...c,workspace:c.workspace,originals:[...c.originals].map(([h,b])=>[h,hash(b)]).sort()}));

/** Keep the original controller's existing mutex held through the consumer's
 * callback. A serialized snapshot is never a transferable write permission. */
export async function withManagedRepairCapture<T>(ref:ManagedRepairReference,readSource:()=>ManagedRepairSource,consume:(capture:ManagedRepairCapture)=>Promise<T>):Promise<T>{
  if(!uuid.test(ref.operation)||!sha.test(ref.bindingHash))throw new Error('handoff_original_reference_invalid');await privateDirectory(ref.store,false);
  const lockPath=join(ref.store,`repair-controller-${ref.operation}.sqlite`);await regular(lockPath);const lock=new DatabaseSync(lockPath);let capture:ManagedRepairCapture|undefined;
  try{
    try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('handoff_original_controller_active');}
    const s=readSource(),r=s.repair;
    if(s.op.id!==ref.operation||s.op.status!=='complete'||r.bindingHash!==ref.bindingHash||r.phase!=='returned'||r.controllerReturned!==true||![r.planSha256,r.requestSha256,r.configSha256,r.resultSha256,r.evidenceSha256].every(x=>sha.test(x)))throw new Error('handoff_original_reconciliation_required');
    if(hash(s.plan)!==r.planSha256||hash(s.request)!==r.requestSha256||hash(s.config)!==r.configSha256)throw new Error('handoff_original_queue_bytes_changed');
    const request=JSON.parse(s.request.toString()),root=r.executionRoot,operation=join(root,'operation'),originals=new Map<string,Buffer>();
    const keep=async(path:string,limit=32*1024*1024)=>{const b=await regular(path,limit);originals.set(hash(b),b);return b;};
    if(request.executionRoot!==root||hash(await keep(join(root,'request.json')))!==r.requestSha256||hash(await keep(join(root,'config.json')))!==r.configSha256)throw new Error('handoff_original_preparation_changed');
    const terminalBytes=await keep(join(operation,'terminal-record.json'),4*1024*1024),terminal=JSON.parse(terminalBytes.toString()),evidence=s.op.result?JSON.parse(s.op.result).repair:undefined;
    // The queue's result is checked directly; its original proof also binds
    // this exact terminal record. Nothing in the model report can supply it.
    if(!r.result||canonical(terminal.result)!==canonical(r.result)||!terminal.files||Object.keys(terminal.files).length>20000||evidence?.bindingHash!==r.bindingHash)throw new Error('handoff_original_terminal_changed');
    const qResult=Buffer.from(JSON.stringify(r.result));if(hash(qResult)!==r.resultSha256)throw new Error('handoff_original_result_changed');originals.set(hash(qResult),qResult);
    const queueEvidence=s.evidence;
    if(!queueEvidence||hash(queueEvidence)!==r.evidenceSha256||JSON.parse(queueEvidence.toString()).terminalRecordSha256!==hash(terminalBytes))throw new Error('handoff_original_terminal_proof_required');originals.set(hash(queueEvidence),queueEvidence);
    let total=0;for(const [name,digest] of Object.entries(terminal.files)){if(!safePath(name)||typeof digest!=='string'||!sha.test(digest))throw new Error('handoff_original_terminal_path_invalid');const b=await keep(join(operation,name));total+=b.length;if(total>512*1024*1024||hash(b)!==digest)throw new Error('handoff_original_terminal_changed');}
    const projectPlan=await keep(join(root,'plan.json')),plan=JSON.parse(projectPlan.toString());if(!projectPlan.equals(await keep(join(operation,'plan.json')))||plan.test!=='registered-project-tests-v1'||plan.project?.queueOperation?.operation!==ref.operation||plan.project.queueOperation.store!==ref.store||canonical(plan.project.sourceCandidate)!==canonical(request.candidate))throw new Error('handoff_original_project_binding_changed');
    for(const name of r.result.codexStages??[]){if(!safePath(name))throw new Error('handoff_original_stage_invalid');await readRepairSession(join(operation,name));}
    for(const name of r.result.claudeStages??[]){if(!safePath(name))throw new Error('handoff_original_stage_invalid');await readClaudeExecution(join(operation,name));}
    const processes:ManagedRepairCapture['processes']=[],dockerExecutions:ManagedRepairCapture['dockerExecutions']=[];
    const ended=async(directory:string)=>{const p=JSON.parse((await keep(join(directory,'process.json'))).toString()),e=JSON.parse((await keep(join(directory,'exit.json'))).toString());if(processState(p.pid)!=='ended'||!(Number.isInteger(e.code)||typeof e.signal==='string'&&e.signal.length>0))throw new Error('handoff_registered_process_active_or_unknown');processes.push({directory,pid:p.pid,ended:true});};
    for(const name of Object.keys(terminal.files)){
      if(name==='launch.json'||name.endsWith('/launch.json'))await ended(join(operation,name.slice(0,-'/launch.json'.length)));
      if(name.endsWith('/execution.json')){const e=JSON.parse((await keep(join(operation,name))).toString());if(e.kind!=='tongxu-docker-execution')continue;if(e.phase!=='finished'||e.cleanup!=='removed'||e.clientPid!==undefined&&processState(e.clientPid)!=='ended'||e.clientPid===undefined&&e.startGateRejected!==true)throw new Error('handoff_registered_container_active_or_unknown');dockerExecutions.push({directory:e.directory,id:e.id,cleanup:'removed'});}
    }
    for(const name of (await readdir(root)).filter(n=>/^preparation-git-\d+$/.test(n)))await ended(join(root,name));
    // Current work may legitimately contain preserved changes or a later
    // owner's lease. Admission must bind/verify that exact current state;
    // proving the old registered children ended does not grant it ownership.
    const workspace=await observeManagedWorkspace(plan.workspace);
    if(signature(readSource())!==signature(s))throw new Error('handoff_original_queue_changed');
    capture={reference:ref,sourceSignature:signature(s),workspace,workspaceStateSha256:managedWorkspaceStateSha256(workspace),originals,processes,dockerExecutions,originalControllerExclusivelyHeld:true,registeredExecutionsEnded:true,newPermissionGranted:false};issued.set(capture,{sha:captureHash(capture),active:true});return await consume(capture);
  }finally{if(capture)issued.get(capture)!.active=false;if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
}
export function requireManagedRepairCapture(c:ManagedRepairCapture){const fixed=issued.get(c);if(fixed?.active)try{requireManagedWorkspaceObservation(c.workspace);if(captureHash(c)===fixed.sha)return c;}catch{/* Changed facts cannot authorize a transfer. */}throw new Error('actual_exclusive_original_repair_capture_required');}
