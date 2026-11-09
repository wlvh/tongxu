import {retainW2TerminalCapture} from './w2-terminal-capture.js';
import {readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Snapshot,hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {collect} from './collector.js';
import {readFixedObjects} from './git.js';
import {verify,loadBundle,parsePlan} from './verification.js';
import {dockerTerminalEvidence} from './docker-sandbox.js';
import {readPacket} from './queue-evidence.js';
import {regular,exists} from './repair-workspace.js';
import {PublicationHttp} from './publication-http.js';
import {readEventSource} from './event-source.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {prepareResourceRequest,resourceAction} from './resource-claims.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';
import {withQueueRepairLock} from './queue-repair.js';
import type {QueueStore} from './queue-store.js';
import type {FormalEntry,FormalSource} from './formal-review-controls.js';
import type {FormalStage} from './formal-review-store.js';
type Row=Record<string,any>;

/** The existing collector/verifier produce real next-candidate originals.
 * A verifier's actual running report can bind test permission before its first
 * container launch. It is imported as incomplete, never fabricated W2/PASS.
 * Completion settles that operation before importing the final packet. */
export async function prepareFormalCandidate(q:QueueStore,entry:FormalEntry,previous:Row,live:FormalSource,checkLive:()=>Promise<void>,explicit=false){
 return withQueueRepairLock(q.directory,previous.operation,async()=>{
  const fix=previous.terminal?.result.fix,c=live.candidate;if(!fix||!live.observation||c.H!==fix.H1||c.B!==previous.request.candidate.B||c.target!==previous.request.candidate.target)throw new Error('formal_exact_published_fix_required');
  q.formalReviews().admitPublication(previous.operation,live.observation,q.events().configuration());q.reviewRecords().publishedFormalRepair(previous.operation);
  const root=join(previous.request.directory,'next-candidate'),snapshot=join(root,'snapshot'),contextPath=join(root,'context.json'),profile=q.events().configuration(),records=q.formalReviews(),parentSource=records.currentSource(previous.item),context=parentSource.context;
  if(!await exists(root))await privateDirectory(root,true);else await privateDirectory(root,false);
  if(!await exists(contextPath))await writeFile(contextPath,canonical(context),{flag:'wx',mode:0o600});else if((await regular(contextPath)).toString()!==canonical(context))throw new Error('formal_next_candidate_context_changed');
  if(!await exists(snapshot)){
   const s=await Snapshot.create(snapshot,c.repository,c.pr,[entry.issue.number],[]),httpRoot=join(root,'collection-http');await privateDirectory(httpRoot,true);const http=new PublicationHttp(httpRoot,profile.ghExecutable,profile.ghSha256,c.repository,c.pr,c.H,c.target,true,profile.executionKind==='github',{issues:[entry.issue.number],collection:true});
   try{const exit=await collect(s,{get:async endpoint=>{await checkLive();const r=await http.request('GET',endpoint);return {status:r.status,body:r.body.toString(),headers:r.headers,provenance:'gh-http-body'};}},candidate=>readFixedObjects(candidate,fix.workspace));if(exit!==0)throw new Error('formal_next_collection_incomplete');}finally{await s.close();}
  }
  const bundle=await loadBundle(snapshot);if(bundle.sourceGaps.length||bundle.candidate.H!==c.H||bundle.candidate.B!==c.B||bundle.candidate.targetRef!==c.target)throw new Error('formal_original_next_collection_incomplete_or_changed');
  const verificationEntry=entry.id+':candidate-material',prior=records.forEntry(verificationEntry).find(s=>s.request.previousOperation===previous.operation),planBytes=await regular(entry.repair.testPlan);if(hash(planBytes)!==entry.repair.testPlanSha256)throw new Error('formal_next_test_plan_changed');
  let output=prior?.stages[0]?.stage.directory??join(root,'verification');
  if(!prior&&await exists(output)){
   // Old controllers could reject the probe before registering any verifier.
   // Only an explicit check may continue after proving that exact preparation
   // never launched a client or test. Its directory and bytes stay untouched.
   if(!explicit)throw new Error('formal_next_verifier_preparation_requires_original_inspection');
   const reportBytes=await regular(join(output,'verification.json'),64*1024*1024),report=JSON.parse(reportBytes.toString()),plan=parsePlan(JSON.parse(planBytes.toString())),probe=join(output,'docker-runtime','probe'),proof=await regular(join(probe,'execution.json'),4*1024*1024);
   if(!plan.executor||report.planHash!==hash(planBytes)||report.status!=='partial'||!report.finishedAt||report.stages.length||report.inputs.length!==1||report.inputs[0].manifestHash!==hash(bundle.bytes)||(await readdir(output)).some(name=>name.startsWith('docker-tool-'))||dockerTerminalEvidence(proof,plan.executor,probe)!=='not_started')throw new Error('formal_original_next_verifier_unknown');
   const evidence=new Map([[hash(reportBytes),reportBytes],[hash(proof),proof]]),evidenceIndexSha256=records.retainEvidence(previous.operation,evidence);
   const recovery=join(root,'verification-after-unstarted-'+hash(Buffer.concat([reportBytes,proof])).slice(0,24));
   records.progress(previous.operation,'candidate_preparation_not_started',{directory:output,evidenceIndexSha256,nextDirectory:recovery,explicitCheck:true});
   output=recovery;
  }
  const candidate={...c,requirementsSha256:previous.request.candidate.requirementsSha256},workSha256=hash(canonical({previous:previous.operation,candidate,snapshotSha256:hash(bundle.bytes),planSha256:hash(planBytes),scope:context.scope}));
  let operation=prior?.operation as string|undefined,stage:FormalStage|undefined,observations:OwnerObservation[]=[],firstInput=true;
  const refreshOwner=async()=>{await checkLive();const a=q.authority(),{profile}=a.configuration();observations=[];for(const ref of a.sourceRequests(entry.authorization.test))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,'owner-'+randomUUID())));};
  const admit=async()=>{
   await refreshOwner();if(!operation){const packet=await readPacket(snapshot,output,contextPath),imported=q.import(packet),pollDir=join(q.directory,`source-poll-${c.pr}-${randomUUID()}`),poll=q.events().beginPoll(c.pr,pollDir,true);if(!poll.started)throw new Error('formal_next_source_refresh_not_due');q.events().observe(c.pr,poll.sequence,await readEventSource(profile,c.pr,pollDir,poll.knownPublished));q.events().reconcilePackets();
    const request={...previous.request,id:'candidate-'+previous.operation,entry:verificationEntry,item:imported.item,previousOperation:previous.operation,candidate,workSha256,directory:root,round:previous.request.round+1,candidateMaterialOnly:true};operation=records.register('cv-'+hash(canonical([previous.operation,c.H])).slice(0,60),imported.item,request).operation;
   }
   const source=records.currentSource(records.state(operation!).item),adoption=q.authority().forScope(source.context.scope.id,{item:source.item,target:c.target}).currentAdoption;if(adoption!==previous.request.material.adoptedScope.adoption)throw new Error('formal_next_adopted_scope_changed');const scopeBody=(q.authority().inspectRecordedDecision(adoption).proposal as Row).body,intent='fc-'+hash(operation!).slice(0,48),action={schemaVersion:1 as const,scopeId:context.scope.id,scopeVersion:context.scope.version,scopeBodySha256:hash(canonical(scopeBody)),repository:c.repository,target:c.target,action:'test' as const,item:source.item,candidate:{H:c.H,B:c.B,subjectSha256:null},paths:entry.repair.materialPaths,resourceRefs:entry.budgets.filter(b=>b.phase==='candidate').map(b=>b.resourceRef),payloadSha256:hash(planBytes),formalWorkSha256:workSha256};
   q.authority().reserveAction(intent,action,'background',entry.authorization.test,observations);const resources:ResourceRequest[]=entry.budgets.filter(b=>b.phase==='candidate').map(({phase:_phase,...b})=>({schemaVersion:1,...b,repository:c.repository,operation:operation!,authorityIntent:intent,role:'background',actionSha256:hash(canonical(action))}));
   stage={key:'round-'+(previous.request.round+1)+'/test-1',role:'test',candidate,inputSha256:hash(bundle.bytes),systemSha256:hash('existing fixed W2 verifier; no model'),materialSha256:hash(bundle.bytes),actorRole:'background',directory:output,authorityIntent:intent,budgetIntent:intent,action,authorization:entry.authorization.test,resources};records.prepareStage(operation!,stage);
   for(const r of resources){const s=await prepareResourceRequest(q.directory,Buffer.from(canonical(r)),'background');if(s.state==='prepared_not_sent')await resourceAction(q.directory,s.id,'claim','background');else await resourceAction(q.directory,s.id,'lookup','background');}records.checkStage(operation!,stage.key,observations);
  };
  const complete=async()=>{if(!operation||!stage)throw new Error('formal_original_next_verifier_binding_required');const reportBytes=await regular(join(output,'verification.json'),64*1024*1024),packet=await readPacket(snapshot,output,contextPath),report=JSON.parse(reportBytes.toString());await retainW2TerminalCapture(packet,output,records.progressHistory(operation,'registered_test_intent').map(e=>e.intent));const evidenceIndexSha256=records.retainEvidence(operation,packet.blobs);if(!['complete','partial'].includes(report.status)||!report.finishedAt||report.stages.some((s:Row)=>s.tools.some((t:Row)=>['running','unknown'].includes(t.status))))throw new Error('formal_original_next_verifier_unknown');
   records.returned(operation,stage.key,{status:report.status,run:report.id,reportSha256:hash(reportBytes),executionComplete:report.executionComplete,evidenceComplete:packet.summary.evidenceComplete,gaps:packet.summary.gaps},{evidenceIndexSha256,role:'test',candidate,inputSha256:stage.inputSha256,systemSha256:stage.systemSha256,completeCapture:true,executionKind:previous.request.executionKind},{'verification.json':reportBytes,'manifest.json':bundle.bytes});records.completeResourcePhase(operation,stage.budgetIntent);for(const r of stage.resources)await resourceAction(q.directory,resourceRequestHash(r),'record-result','background');records.finish(operation,{status:'candidate_material_recorded',candidate,reportSha256:hash(reportBytes),evidenceComplete:packet.summary.evidenceComplete,gaps:packet.summary.gaps});const imported=q.importFormalCandidate(packet,operation);q.events().reconcilePackets();return {item:imported.item,operation,reportSha256:hash(reportBytes)};
  };
  if(await exists(output)){
   if(!prior)throw new Error('formal_next_verifier_preparation_requires_original_inspection');const s=prior.stages[0];if(!s)throw new Error('formal_original_next_verifier_binding_required');stage=s.stage;operation=prior.operation;if(prior.terminal){const packet=await readPacket(snapshot,output,contextPath);return {item:q.importFormalCandidate(packet,operation!).item,operation,reportSha256:hash(await regular(join(output,'verification.json'),64*1024*1024))};}if(!s.dispatched)throw new Error('formal_next_verifier_unstarted_original_requires_inspection');return complete();
  }
  await verify({snapshots:[snapshot],objects:fix.workspace,plan:entry.repair.testPlan,output},{registered:()=>{},executionRegistered:async intent=>{if(operation)records.progress(operation,'registered_test_intent',{intent});},startGate:{refresh:async()=>{if(!stage)await admit();else{await refreshOwner();for(const r of stage.resources)await resourceAction(q.directory,resourceRequestHash(r),'lookup','background');records.checkStage(operation!,stage.key,observations);}},start:effect=>{if(!stage||!operation)throw new Error('formal_original_next_verifier_binding_required');records.effect(operation,stage.key,observations,effect,firstInput);firstInput=false;}}});
  if(!operation)throw new Error('formal_next_verifier_not_started');await checkLive();return complete();
 });
}
