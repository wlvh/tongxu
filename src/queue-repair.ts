import { writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from './queue-store.js';
import { reconcileReception } from './receiver.js';
import { prepareProjectRepair, type ProjectRequest } from './project-repair.js';
import { runRepair } from './repair.js';
import { regular, exists, processState,tree,treeHash,git } from './repair-workspace.js';
import { hash } from './snapshot.js';
import { canonical } from './comparison.js';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './snapshot.js';
import { readOwnerSource,type OwnerObservation } from './authority-source.js';
import { resourceAction } from './resource-claims.js';
import type { AuthorityRole } from './authority-contract.js';
import {memberReturnReference,type MemberReturnReference} from './integration-member-contract.js';
import {parseRepairContinuation,type RepairContinuation} from './repair-continuation-contract.js';

type Row = Record<string, any>;
export type QueueRepairPlan = { schemaVersion: 1; kind: 'tongxu-queue-repair'; store: string; operation: string; packet: number; judgmentId: string; bindingHash: string; context: unknown;
  request: string; requestSha256: string; config: string; configSha256: string; replacesClosedBinding?:string; governance?:{authorityIntent:string;resourceRequests:string[]};coordination?:{planId:string;task:string;capability:string;fromRun:string;fromMessage:string};memberReturn?:MemberReturnReference;continuation?:RepairContinuation };
const uuid = /^[a-f0-9-]{36}$/, digest = /^[a-f0-9]{64}$/;
export function parseQueueRepairPlan(bytes: Buffer): QueueRepairPlan {
  const p = JSON.parse(bytes.toString());
  if (p.schemaVersion !== 1 || p.kind !== 'tongxu-queue-repair' || !uuid.test(p.operation) || !uuid.test(p.judgmentId) || !Number.isSafeInteger(p.packet) || p.packet < 1 || !digest.test(p.bindingHash) || !digest.test(p.requestSha256) || !digest.test(p.configSha256) || !p.context || p.replacesClosedBinding!==undefined&&!digest.test(p.replacesClosedBinding) || Object.keys(p).filter(k=>!['replacesClosedBinding','governance','coordination','memberReturn','continuation'].includes(k)).sort().join() !== 'bindingHash,config,configSha256,context,judgmentId,kind,operation,packet,request,requestSha256,schemaVersion,store') throw new Error('invalid_queue_repair_plan');
  if(p.continuation!==undefined)parseRepairContinuation(p.continuation);
  if(p.memberReturn!==undefined&&!memberReturnReference(p.memberReturn))throw new Error('invalid_queue_repair_member_return');
  if(p.coordination!==undefined&&(!p.coordination||Object.keys(p.coordination).sort().join()!=='capability,fromMessage,fromRun,planId,task'||!digest.test(p.coordination.planId)||!digest.test(p.coordination.fromRun)||['task','capability','fromMessage'].some(k=>typeof p.coordination[k]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(p.coordination[k]))))throw new Error('invalid_queue_repair_coordination');
  if(p.governance!==undefined&&(!p.governance||Object.keys(p.governance).sort().join()!=='authorityIntent,resourceRequests'||typeof p.governance.authorityIntent!=='string'||!p.governance.authorityIntent.trim()||p.governance.authorityIntent.length>128||!Array.isArray(p.governance.resourceRequests)||p.governance.resourceRequests.length>32||new Set(p.governance.resourceRequests).size!==p.governance.resourceRequests.length||p.governance.resourceRequests.some((r:unknown)=>typeof r!=='string'||!digest.test(r))))throw new Error('invalid_queue_repair_governance');
  for (const path of [p.store, p.request, p.config]) if (typeof path !== 'string' || resolve(path) !== path) throw new Error('queue_repair_path_not_canonical');
  return p;
}
async function putFixed(path: string, bytes: Buffer) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (e: any) { if (e.code !== 'EEXIST') throw e; if (hash(await regular(path)) !== hash(bytes)) throw new Error('queue_repair_original_changed'); }
}
export async function withQueueRepairLock<T>(store: string, operation: string, action: () => Promise<T>) {
  if(!uuid.test(operation))throw new Error('invalid_queue_repair_operation');
  if (await realpath(store) !== store) throw new Error('queue_repair_store_not_canonical');
  const path = join(store, `repair-controller-${operation}.sqlite`);
  try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  await regular(path); const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); } catch { db.close(); throw new Error('queue_repair_controller_active'); }
  try { return await action(); } finally { db.exec('ROLLBACK'); db.close(); }
}
/** Derive counts from immutable original records, not model prose or exit zero. */
export async function repairEvidence(operation: string, queueOperation: string, bindingHash: string, resultBytes: Buffer) {
  const terminalBytes = await regular(join(operation, 'terminal-record.json'), 4 * 1024 * 1024), terminal = JSON.parse(terminalBytes.toString());
  if (canonical(terminal.result) !== canonical(JSON.parse(resultBytes.toString()))) throw new Error('queue_repair_terminal_result_changed');
  const names = Object.keys(terminal.files) as string[], calls = [], candidates = new Set<string>();
  for (const path of names) {
    if (/^calls\/[^/]+\.json$/.test(path)) { const b = await regular(join(operation,path)); if (hash(b)!==terminal.files[path]) throw new Error('queue_repair_call_changed'); calls.push(JSON.parse(b.toString())); }
    if (/^attempt-\d+\/candidate-\d+\.json$/.test(path)) { const b = await regular(join(operation,path),32*1024*1024); if (hash(b)!==terminal.files[path]) throw new Error('queue_repair_candidate_changed'); candidates.add(JSON.parse(b.toString()).candidate.H); }
  }
  const result = terminal.result; if (result.after.H !== result.before.H) candidates.add(result.after.H);
  const counters = {
    recoveryAttempts: new Set(names.map(n=>/^attempt-\d+\//.exec(n)?.[0]).filter(Boolean)).size,
    nativeProcessesStarted: names.filter(n=>/^attempt-\d+\/(?:fact-and-repair|impact-\d+|review-(?:\d+|recovered))\/process\.json$/.test(n)).length,
    evidenceExchangeRoundsStarted: names.filter(n=>/^attempt-\d+\/impact-\d+\/launch\.json$/.test(n)).length,
    impactReportsCompleted: names.filter(n=>/^attempt-\d+\/impact-\d+\/completed\.json$/.test(n)).length,
    writeHandoffs: names.filter(n=>/^attempt-\d+\/repair-context-\d+\.json$/.test(n)).length,
    actualFileWrites: calls.filter(c=>c.status==='applied' && c.request?.tool==='tongxu_replace_file' && c.beforeSha256!==c.afterSha256).length,
    fixedNewCandidates: candidates.size,
    publishedReworkBatches: 0,
    publicationCountSource: 'separate verified publication events; no publication inferred from a local commit'
  };
  return { operation:queueOperation, bindingHash, resultSha256:hash(resultBytes), terminalRecordSha256:hash(terminalBytes), counters, nativeEvidenceRevalidatedBy:'runRepair terminal reader', productionActionAllowed:false };
}
export async function runQueueRepair(planPath: string, reconcileEnded = false,expectedPlanSha256?:string): Promise<Row> {
  const planBytes = await regular(planPath), p = parseQueueRepairPlan(planBytes);
  if(expectedPlanSha256!==undefined&&hash(planBytes)!==expectedPlanSha256)throw new Error('queue_repair_selected_plan_changed');
  return withQueueRepairLock(p.store,p.operation,async()=> {
    // Re-read the supplier capture before using the stored finding. No resend.
    let actualReception=p.operation;
    if(p.memberReturn){const q=await QueueStore.open(p.store);try{actualReception=q.memberRepairInput(p.operation,p.memberReturn,false).receptionOperation;}finally{q.close();}}
    await reconcileReception(p.store,actualReception);
    const q = await QueueStore.open(p.store), records = q.reviewRecords();
    try {
      const member=p.memberReturn?q.memberRepairInput(p.operation,p.memberReturn,false):null,original=member?null:q.receiverState(p.operation),evidence=member?{packet:member.packet,context:member.context}:q.receiverEvidence(p.operation),r=member?member.reception:original!.receiver;
      const requestBytes = await regular(p.request), configBytes = await regular(p.config);
      if (hash(requestBytes)!==p.requestSha256 || hash(configBytes)!==p.configSha256) throw new Error('queue_repair_plan_inputs_changed');
      const request = JSON.parse(requestBytes.toString()) as ProjectRequest;
      if (request.priorReview || request.queueOperation || request.findings.length) throw new Error('queue_repair_findings_must_come_from_original');
      const effective: ProjectRequest = { ...request,
        findings:member?member.findings:r.judgment.findings.map((f: Row,i: number)=>({id:r.judgmentId+':'+i,description:f.description})),
        priorReview:member?member.priorReview:{operation:p.operation,packet:evidence.packet,judgmentId:r.judgmentId,bindingHash:r.bindingHash,inputSha256:r.inputSha256,report:r.judgment.report,findings:r.judgment.findings,context:evidence.context},
        queueOperation:member?member.queueOperation:{store:p.store,operation:p.operation}
      };
      if(p.continuation){
        const old=q.managedRepairOriginal(p.continuation.operation),result=old.repair.result;
        effective.priorReview!.continuation={...p.continuation,priorResult:{status:result.status,before:result.before,after:result.after,treeSha256:result.treeSha256,factReport:result.data?.factReport??null,independentReview:result.data?.review??null},adoptedSource:'exact committed candidate; staged/working/untracked originals preserved separately in the original queue',newExecutionContext:true,nativeSessionResumed:false,reportsGrantPermissions:false};
      }
      const effectiveBytes = Buffer.from(JSON.stringify(effective));
      return await q.withRepairContinuation(p.continuation,async()=>{
      let observations:OwnerObservation[]=[],role:AuthorityRole='implementer',prior:Row|null=null;
      try{prior=records.state(p.operation).repair;}catch(e){if(!(e instanceof Error)||e.message!=='queue_repair_not_registered')throw e;}
      // Refuse aliases before any resource preparation/claim or new model
      // admission. A known unstarted replacement keeps its explicit lineage.
      if(prior&&(prior.planSha256!==hash(planBytes)||prior.requestSha256!==hash(effectiveBytes)||prior.configSha256!==hash(configBytes))&&!(prior.phase==='closed_unstarted'&&p.replacesClosedBinding===prior.bindingHash&&request.executionRoot!==prior.executionRoot))throw new Error('queue_repair_fixed_input_changed');
      const terminalRead=prior?.planSha256===hash(planBytes)&&['returned','closed_unstarted'].includes(prior.phase);
      const refresh=async()=>{
        if(!p.governance)return;
        const authority=q.authority(),intent=authority.reservedAction(p.governance.authorityIntent),profile=authority.configuration().profile;role=intent.role;
        if(!['implementer','background'].includes(role))throw new Error('queue_repair_authority_role_mismatch');
        const root=join(p.store,'repair-authority-'+p.operation+'-'+randomUUID());await privateDirectory(root,true);const results=await Promise.allSettled(authority.sourceRequests(intent.authorization).map((source,index)=>readOwnerSource(profile,source.proposalSha256,source.commentId,join(root,'source-'+index))));
        observations=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
        for(const id of p.governance.resourceRequests)await resourceAction(p.store,id,'lookup',role);
      };
      if(!terminalRead&&p.governance){
        q.authority().enableGovernedRepair();
        await refresh();q.repairResourceAdmission(p.operation,{plan:planBytes,request:effectiveBytes,config:configBytes},observations);
        for(const id of p.governance.resourceRequests){const state=q.resources().status(id);if(state.state==='prepared_not_sent')await resourceAction(p.store,id,'claim',role);else if(state.state!=='held')throw new Error('queue_repair_original_resource_unresolved');}
        await refresh();
      }
      const registered = records.reserve(p.operation,planBytes,effectiveBytes,configBytes,observations), bound = registered.repair.bindingHash;
      if(registered.repair.phase==='closed_unstarted')return {operation:p.operation,status:'closed_unstarted',duplicate:true,modelExecutionStarted:false,productionActionAllowed:false};
      if (registered.duplicate && registered.repair.phase !== 'returned' && !registered.repair.controllerReturned && processState(registered.repair.controllerPid) !== 'ended') throw new Error('original_queue_repair_controller_active_or_unknown');
      if (registered.duplicate && registered.repair.phase !== 'returned' && !reconcileEnded) throw new Error('explicit_queue_repair_reconciliation_required');
      const requestPath = join(p.store,`repair-${p.operation}-${bound}-request.json`), configPath = join(p.store,`repair-${p.operation}-${bound}-config.json`);
      await putFixed(requestPath,effectiveBytes); await putFixed(configPath,configBytes);
      try {
        if (registered.repair.phase !== 'returned') records.check(p.operation,bound,undefined,observations);
        const prepared = await prepareProjectRepair(configPath,requestPath,request.executionRoot);
        if (registered.repair.phase !== 'returned') records.controller(p.operation,bound,'prepared',{plan:prepared.plan});
        if (registered.repair.phase !== 'returned') records.controller(p.operation,bound,'dispatched',{operation:prepared.operation,reconcileEnded});
        const result = await runRepair(prepared.plan,prepared.operation,reconcileEnded,effect=>{records.check(p.operation,bound,effect,observations);},refresh);
        const resultBytes = Buffer.from(JSON.stringify(result)), proof = await repairEvidence(prepared.operation,p.operation,bound,resultBytes);
        const receipt = records.complete(p.operation,bound,resultBytes,Buffer.from(JSON.stringify(proof)));
        let output:Row|null=null;if(p.coordination&&['completed','completed_recovered_candidate'].includes(result.status)){
          const workspace=join(request.executionRoot,'workspace'),source=await tree(workspace,true);
          if(treeHash(source)!==result.treeSha256||await git(workspace,['rev-parse','HEAD'])!==result.after.H)throw new Error('coordination_repair_output_source_changed');
          const material=Object.fromEntries(request.materialPaths.map(path=>{if(!source[path])throw new Error('coordination_repair_output_material_missing');return [path,source[path]];})),diff=await git(workspace,['diff','--no-ext-diff','--no-textconv',result.before.H,result.after.H,'--',...request.materialPaths]);
          output=q.coordination().recordRepairOutput(p.operation,Buffer.from(canonical({result,material,diff})));
        }
        const resources:Row[]=[];if(p.governance){role=q.authority().reservedAction(p.governance.authorityIntent).role;for(const id of p.governance.resourceRequests){try{let state=q.resources().status(id);if(state.pendingResultAttempt&&!['consumed','released'].includes(state.state))state=await resourceAction(p.store,id,'lookup',role);resources.push(await resourceAction(p.store,id,'record-result',role));}catch(e){resources.push({id,status:'result_pending_or_unknown',error:e instanceof Error?e.message:'resource_record_unavailable',newExecutionAllowed:false});}}}
        return {operation:p.operation,status:'repair_result_recorded',repairStatus:result.status,after:result.after,counters:receipt.counters,duplicate:receipt.duplicate,resources,coordinationOutput:output,manualReportCopyRequired:false,manualRepairRequired:false,productionActionAllowed:false};
      } catch (e) {
        records.controller(p.operation,bound,'unknown',{reason:e instanceof Error?e.message:'repair_unavailable'}); throw e;
      }
      });
    } finally { q.close(); }
  });
}
export async function closeUnstartedQueueRepair(planPath:string,source:string,expectedPlanSha256?:string){
  const bytes=await regular(planPath),p=parseQueueRepairPlan(bytes);
  if(expectedPlanSha256!==undefined&&hash(bytes)!==expectedPlanSha256)throw new Error('queue_repair_selected_plan_changed');
  return withQueueRepairLock(p.store,p.operation,async()=>{
    const q=await QueueStore.open(p.store);try{
      const records=q.reviewRecords(),state=records.state(p.operation),r=state.repair,root=r.executionRoot;
      if(r.planSha256!==hash(bytes)||!source.trim()||source.length>2048)throw new Error('unstarted_close_plan_changed');
      if(!r.controllerReturned&&processState(r.controllerPid)!=='ended')throw new Error('original_queue_repair_controller_active_or_unknown');
      if(await exists(join(root,'operation'))||await exists(join(root,'workspace/.git/tongxu-writer.json')))throw new Error('repair_execution_may_have_started');
      const processes=[];
      if(await exists(root)){
        if(hash(await regular(join(root,'request.json')))!==r.requestSha256||hash(await regular(join(root,'config.json')))!==r.configSha256)throw new Error('preparation_original_changed');
        const intent=JSON.parse((await regular(join(root,'preparation-intent.json'))).toString()),exit=JSON.parse((await regular(join(root,'preparation-exit.json'))).toString());
        if(intent.requestSha256!==r.requestSha256||exit.controllerPid!==intent.controllerPid||!['failed','prepared'].includes(exit.status)||exit.modelDispatched!==false)throw new Error('preparation_end_unverified');
        for(const name of (await readdir(root)).filter(n=>/^preparation-git-\d+$/.test(n))){const dir=join(root,name),proc=JSON.parse((await regular(join(dir,'process.json'))).toString()),end=JSON.parse((await regular(join(dir,'exit.json'))).toString());if(end.code===null&&end.signal===null||processState(proc.pid)!=='ended')throw new Error('preparation_child_active_or_unknown');processes.push({directory:name,pid:proc.pid,exit:end});}
      }
      return records.closeUnstarted(p.operation,r.bindingHash,source,Buffer.from(JSON.stringify({operation:p.operation,bindingHash:r.bindingHash,executionRoot:root,modelExecutionStarted:false,managedOperationAbsent:true,preparationProcesses:processes,originalFilesPreserved:true})));
    }finally{q.close();}
  });
}
