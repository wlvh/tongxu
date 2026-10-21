import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {parseMemberRecompositionPlan} from './member-recomposition-contract.js';
import {parseQueueRepairPlan,runQueueRepair} from './queue-repair.js';
import {loadBundle,parsePlan,verify} from './verification.js';
import {readPacket} from './queue-evidence.js';
import {captureIntegrationGit,readIntegrationGit,type GitStep} from './integration-git.js';
import {inspectObjectSource,verifyObjectSource} from './integration-objects.js';
import {runIntegration} from './integration.js';
import {recompositionTestRuntime,reserveRecompositionIntegration} from './recomposition-test-runtime.js';

const encoded=(x:unknown)=>Buffer.from(canonical(x));
async function freeze(path:string,b:Buffer){try{await writeFile(path,b,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,64*1024*1024)).equals(b))throw new Error('member_recomposition_frozen_input_changed');}}

/** Consume a genuinely completed member repair and a separately observed new
 * member snapshot. A local repair commit never manufactures a GitHub PR
 * observation. Configured Owner grants bind this test's fixed inputs and
 * resources separately from the repaired member and successor integration. */
export async function runMemberRecomposition(path:string){
  const raw=await regular(path,32768),p=parseMemberRecompositionPlan(raw),id=hash(canonical({memberReturn:p.memberReturn,repairPlan:p.repairPlan.sha256})),directory=join(p.store,'member-recomposition-'+id),q=await QueueStore.open(p.store);let mutex:DatabaseSync|undefined;
  try{
    if(!await exists(directory))await privateDirectory(directory,true);else await privateDirectory(directory,false);await freeze(join(directory,'request.json'),raw);const lock=join(directory,'controller.sqlite');try{await writeFile(lock,'',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await regular(lock);mutex=new DatabaseSync(lock);try{mutex.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{throw new Error('member_recomposition_controller_active');}
    const fixedPlan=join(directory,'repair-plan.json');if(!await exists(fixedPlan)){const b=await regular(p.repairPlan.path);if(hash(b)!==p.repairPlan.sha256)throw new Error('member_recomposition_repair_plan_changed');await freeze(fixedPlan,b);}const repairPlanBytes=await regular(fixedPlan),repairPlan=parseQueueRepairPlan(repairPlanBytes);if(hash(repairPlanBytes)!==p.repairPlan.sha256||repairPlan.store!==p.store||canonical(repairPlan.memberReturn)!==canonical(p.memberReturn))throw new Error('member_recomposition_repair_plan_changed');
    let repair=q.reviewRecords().state(repairPlan.operation).repair;if(repair.phase!=='returned'||!['completed','completed_recovered_candidate'].includes(repair.result.status)||!repair.result.actualRepairPerformed)throw new Error('member_recomposition_completed_repair_required');
    // This original terminal reader checks saved tests, tool calls, sessions
    // and source hashes; it cannot dispatch a new model from a returned stage.
    await runQueueRepair(fixedPlan);repair=q.reviewRecords().state(repairPlan.operation).repair;
    const original=q.integrationMemberReturns().material(p.memberReturn.id);if(original.state.requestSha256!==p.memberReturn.requestSha256||original.state.sourceSha256!==p.memberReturn.sourceSha256||canonical(repair.memberReturn)!==canonical(p.memberReturn))throw new Error('member_recomposition_original_return_changed');
    const proof=original.proof,selected=original.request.member,old=proof.integration.source.composition.subject.members,context=proof.member.context,resultPath=join(directory,'result.json');
    const checkLink=(link:any)=>{if(canonical(link.memberReturn)!==canonical(p.memberReturn)||link.repair.operation!==repairPlan.operation||link.repair.bindingHash!==repair.bindingHash||link.repair.resultSha256!==repair.resultSha256||link.repair.evidenceSha256!==repair.evidenceSha256||link.source!==p.source)throw new Error('member_recomposition_original_transfer_changed');};
    const governed=p.governance?recompositionTestRuntime(q,p,directory):undefined;
    // A registered original is consumed from its capture before any new
    // permission check. Revocation blocks new work, not factual completion.
    if(governed?.state()?.binding){await governed.complete();const resources=await governed.settle();if(!resources.settled)return {phase:'recomposition_test_resource_result_pending',directory,resources,newModelInputs:0};}
    const integrationRequest=(link:any,operation:string)=>({schemaVersion:1,kind:'tongxu-minimal-integration',id:p.id,operation,subjectSha256:link.composition.subjectSha256,scopeSha256:hash(canonical(context.scope)),arrangementSha256:hash(canonical(context.arrangement)),objects:join(directory,'objects.git'),selectionReason:'Adopt only the verified repaired member version; retain every other original member and all prior return evidence. The resulting candidate needs its own tests and independent reception.',source:p.source,authorityIntent:p.governance?.integrationAuthorityIntent??null});
    const checkIntegration=(integration:any,request:any)=>{if(integration.id!==p.id||integration.operation!==request.operation||integration.subjectSha256!==request.subjectSha256||integration.requestSha256!==hash(canonical(request)))throw new Error('member_recomposition_original_integration_changed');};
    const resultValue=(link:any,proofSha256:string,candidate:any)=>({requestSha256:hash(canonical(p)),repairResultSha256:repair.resultSha256,phase:'new_integration_candidate_requires_own_reception',directory,memberHead:repair.result.after.H,subjectSha256:link.composition.subjectSha256,linkProofSha256:proofSha256,composition:link.composition,integrationId:p.id,candidate,manualReportCopyRequired:false,priorAcceptanceTransferred:false,remotePublicationInferred:false,userOutcomeAccepted:false});
    if(await exists(resultPath)){
      const saved=JSON.parse((await regular(resultPath)).toString()),linked=q.memberRecompositions().state(p.id);checkLink(linked.request);const originalIntegration=q.integrations().sourceMaterial(p.id),request=integrationRequest(linked.request,originalIntegration.source.operation);if(canonical(originalIntegration.request)!==canonical(request)||originalIntegration.source.item!==linked.request.composition.item||originalIntegration.source.packet!==linked.request.composition.packet||originalIntegration.source.fingerprint!==linked.request.composition.fingerprint)throw new Error('member_recomposition_original_integration_changed');await freeze(join(directory,'integration-request.json'),encoded(request));const integrated=await runIntegration(p.store,join(directory,'integration-request.json'),'reconcile');checkIntegration(integrated,request);if(integrated.phase!=='produced'||!('result' in integrated)||!integrated.result)throw new Error('member_recomposition_original_candidate_unavailable');const result=resultValue(linked.request,linked.value.proofSha256,integrated.result.candidate);
      if(canonical(saved)!==canonical(result))throw new Error('member_recomposition_result_changed');return {...result,integration:integrated,duplicate:true,newGitProcesses:0,newModelInputs:0};
    }
    const finish=async(link:any,proofSha256:string,operation:string,processes:number)=>{
      const integration=integrationRequest(link,operation),integrationPath=join(directory,'integration-request.json');await freeze(integrationPath,encoded(integration));
      const authorization=await reserveRecompositionIntegration(q,p,link,directory);if(!authorization.ready)return {phase:'recomposition_integration_authority_pending',directory,authorization,newModelInputs:0};
      const integrated=await runIntegration(p.store,integrationPath);checkIntegration(integrated,integration);if(integrated.phase!=='produced'||!('result' in integrated)||!integrated.result)return {phase:'recomposition_integration_unresolved',directory,integration:integrated,newModelInputs:0};
      const result=resultValue(link,proofSha256,integrated.result.candidate);await freeze(resultPath,encoded(result));return {...result,integration:integrated,duplicate:false,newGitProcesses:processes+('newGitProcesses' in integrated?integrated.newGitProcesses:0),newModelInputs:0};
    };
    // Importing the repaired composition legitimately retires the old source.
    // A controller ending after that transfer resumes the same linked result,
    // never tries to re-authorize/retest the obsolete parent or changes IDs.
    let linked:ReturnType<ReturnType<typeof q.memberRecompositions>['state']>|undefined;try{linked=q.memberRecompositions().state(p.id);}catch(e){if(!(e instanceof Error)||e.message!=='member_recomposition_not_recorded')throw e;}
    if(linked){const link=linked.request;checkLink(link);const operations=q.status().operations.filter((o:any)=>o.item===link.composition.item&&o.packet===link.composition.packet&&o.status==='complete');if(operations.length!==1)throw new Error('member_recomposition_original_operation_ambiguous');await freeze(join(directory,'link.json'),encoded(link));return await finish(link,linked.value.proofSha256,operations[0].id,0);}
    const effectGate=<T>(effect:()=>T)=>governed?governed.effect(effect):q.memberRecompositionEffect(p.memberReturn,effect),gate=()=>governed?governed.check():effectGate(()=>undefined);
    const transferPath=join(directory,'transfer-intent.json'),transferring=await exists(transferPath),testRecorded=governed?.state()?.phase==='recorded';if(!transferring&&!governed)gate();
    const observedPath=transferring||testRecorded?join(directory,'snapshot-'+selected.index):p.newMember.path,source=await loadBundle(observedPath);if(hash(source.bytes)!==p.newMember.sha256||source.candidate.H!==repair.result.after.H||['repository','pr','B','targetRef'].some(k=>(source.candidate as any)[k]!==old[selected.index].candidate[k])||source.sourceGaps.length)throw new Error('member_recomposition_new_member_observation_mismatch');
    const testBytes=await regular(transferring||testRecorded?join(directory,'test-plan.json'):p.testPlan.path,1024*1024);if(hash(testBytes)!==p.testPlan.sha256||!parsePlan(JSON.parse(testBytes.toString())).executor)throw new Error('member_recomposition_isolated_test_plan_required');await freeze(join(directory,'test-plan.json'),testBytes);await freeze(join(directory,'context.json'),encoded(context));
    if(governed&&!testRecorded)await governed.prepare(raw,source.bytes,testBytes);
    const previous=q.integrations().sourceMaterial(original.request.integration),originals=new Map([...original.originals,...previous.originals].map(x=>[x.sha256,x.bytes] as [string,Buffer])),snapshots:string[]=[];
    for(const [i,m] of old.entries()){
      const root=join(directory,'snapshot-'+i);if(!await exists(root))await privateDirectory(root,true);for(const name of ['raw','git'])await mkdir(join(root,name),{recursive:true,mode:0o700});const bytes=i===selected.index?source.bytes:originals.get(m.manifestHash);if(!bytes)throw new Error('member_recomposition_original_manifest_missing');const manifest=JSON.parse(bytes.toString());
      for(const ref of manifest.artifacts){if(!/^(raw\/[a-f0-9]{64}\.json|git\/[a-f0-9]{64}\.(patch|json))$/.test(ref.path))throw new Error('member_recomposition_artifact_path_invalid');const b=i===selected.index?await regular(join(observedPath,ref.path),64*1024*1024):originals.get(ref.sha256);if(!b||hash(b)!==ref.sha256||b.length!==ref.bytes)throw new Error('member_recomposition_artifact_changed');await freeze(join(root,ref.path),b);}await freeze(join(root,'manifest.json'),bytes);snapshots.push(root);
    }
    const cache=join(directory,'objects.git');if(!await exists(cache))await privateDirectory(cache,true);let processes=0;
    const step=async(name:string,s:GitStep)=>{const root=join(directory,'git-'+name);if(await exists(root)){const r=await readIntegrationGit(root,s);if(!r.successful)throw new Error('member_recomposition_git_failed');return r;}if(transferring||testRecorded)throw new Error('member_recomposition_original_git_missing');if(governed)await governed.refresh();gate();const r=await captureIntegrationGit(root,s,effect=>effectGate(()=>{processes++;return effect();}));if(!r.successful)throw new Error('member_recomposition_git_failed');return r;};
    await step('init',{cwd:cache,args:['init','--bare','--object-format=sha1','--template='],stdin:Buffer.alloc(0)});
    const sources=[{name:'original',path:join(previous.directory,'candidate.git'),heads:[...new Set<string>(old.flatMap((m:any)=>[m.candidate.B,m.candidate.H]))]},{name:'repaired',path:join(repair.executionRoot,'workspace'),heads:[repair.result.after.H]}];
    for(const s of sources){const layoutPath=join(directory,s.name+'-object-source.json');if(!await exists(layoutPath))await freeze(layoutPath,encoded(await inspectObjectSource(s.path)));const layout=verifyObjectSource(JSON.parse((await regular(layoutPath)).toString()),s.path),pack=await step(s.name+'-pack',{cwd:cache,args:['pack-objects','--stdout','--revs','--no-reuse-delta','--no-reuse-object','--threads=1'],stdin:Buffer.from(s.heads.join('\n')+'\n'),objectDirectory:layout.objectDirectory});await step(s.name+'-import',{cwd:cache,args:['index-pack','--stdin','--strict'],stdin:pack.stdout});}
    const output=join(directory,'verification');if(!await exists(output)){if(transferring||testRecorded||governed?.state()?.binding)throw new Error('member_recomposition_original_verification_missing');if(governed)await governed.refresh();await verify({snapshots,objects:cache,plan:join(directory,'test-plan.json'),output},{registered:(run,planSha,inputs)=>governed?governed.registered(run,planSha,inputs):gate(),...(governed?{executionRegistered:governed.executionRegistered}:{}),startGate:{refresh:async()=>{if(governed)await governed.refresh();else gate();},start:effect=>effectGate(effect)}});}
    // A partially captured W2 operation is read as partial, never relaunched
    // in a fresh directory. readPacket validates the original raw results.
    const packet=governed?await governed.complete():await readPacket(snapshots.at(-1)!,output,join(directory,'context.json'),snapshots);
    if(governed){const resources=await governed.settle();if(!resources.settled)return {phase:'recomposition_test_resource_result_pending',directory,resources,newModelInputs:0};}
    if(packet.summary.gaps.some(g=>g!=='sample_failure_or_incomplete_comparison')||!packet.summary.composition?.subject.testedTree)throw new Error('member_recomposition_original_verification_incomplete');
    if(!transferring&&!governed)gate();await freeze(transferPath,encoded({requestSha256:hash(canonical(p)),repairResultSha256:repair.resultSha256,packetFingerprint:packet.fingerprint,subjectSha256:packet.summary.composition.sha256,reportSha256:packet.reportHash}));const imported=q.import(packet),begun=q.begin(imported.item,'member-recomposition:'+id);if(!begun.operation)throw new Error('member_recomposition_queue_occupied');if(begun.status==='running')q.evaluate(begun.operation);
    const link={schemaVersion:1,kind:'tongxu-member-recomposition-link',id:p.id,memberReturn:p.memberReturn,repair:{operation:repairPlan.operation,bindingHash:repair.bindingHash,resultSha256:repair.resultSha256,evidenceSha256:repair.evidenceSha256},composition:{item:imported.item,packet:imported.packet,fingerprint:packet.fingerprint,subjectSha256:packet.summary.composition.sha256},source:p.source},recorded=q.memberRecompositions().record(encoded(link));await freeze(join(directory,'link.json'),encoded(link));return await finish(link,recorded.proofSha256,begun.operation,processes);
  }finally{if(mutex?.isTransaction)mutex.exec('ROLLBACK');mutex?.close();q.close();}
}
