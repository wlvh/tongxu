import type {DatabaseSync} from 'node:sqlite';
import {installTestAuthorityGuard,requireTestAuthorityConsumer} from './test-authority.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {parsePlan} from './verification.js';
import {parseDeliveryValidation,deliveryValidationSha,type DeliveryValidationPlan} from './delivery-validation-contract.js';
import type {DeliveryRecords} from './delivery-store.js';
import type {OwnerObservation} from './authority-source.js';
import {requireDeliveryValidationCapture,type DeliveryValidationCapture} from './delivery-validation-capture.js';

type Row=Record<string,any>;
const authorityBindingIndex=`CREATE UNIQUE INDEX delivery_validation_authority_unique ON events(json_extract(data,'$.value.authorityIntent')) WHERE kind='delivery_validation_authority_bound'`;
const authorityBindingGuard=`CREATE TRIGGER delivery_validation_authority_guard BEFORE INSERT ON events
WHEN NEW.kind IN ('delivery_validation_registered','delivery_validation_started') AND EXISTS(SELECT 1 FROM meta WHERE key='owner_authority_profile')
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM events bound, blobs original
    WHERE bound.kind='delivery_validation_authority_bound' AND bound.object=NEW.object
      AND original.hash=CASE WHEN NEW.kind='delivery_validation_registered' THEN json_extract(NEW.data,'$.value.originalSha256') ELSE
        (SELECT json_extract(data,'$.value.originalSha256') FROM events WHERE kind='delivery_validation_registered' AND object=NEW.object) END
      AND json_extract(bound.data,'$.value.authorityIntent')=json_extract(CAST(original.bytes AS TEXT),'$.authorityIntent')
      AND json_extract(bound.data,'$.value.planSha256')=CASE WHEN NEW.kind='delivery_validation_registered' THEN json_extract(NEW.data,'$.value.planSha256') ELSE
        (SELECT json_extract(data,'$.value.planSha256') FROM events WHERE kind='delivery_validation_registered' AND object=NEW.object) END
  ) THEN RAISE(ABORT,'delivery_validation_authority_binding_required') END;
END`;
export class DeliveryValidationRecords{
  constructor(private db:DatabaseSync,private transaction:<T>(fn:()=>T)=>T,private batches:DeliveryRecords,private member:(id:string)=>Row,private authority:(id:string,observations:OwnerObservation[]|null)=>Row){}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('delivery_validation_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private events(id:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'delivery_validation_%' ORDER BY id").all('delivery-validation:'+id) as Row[]).map(e=>{const ref=JSON.parse(e.data),value=JSON.parse(this.bytes(ref.sha256).toString());if(canonical(value)!==canonical(ref.value))throw new Error('delivery_validation_index_changed');return {...e,data:value};});}
  private event(id:string,kind:string,value:Row){const sha256=this.blob(Buffer.from(canonical(value)));this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('delivery_validation_'+kind,'delivery-validation:'+id,canonical({sha256,value}),now());}
  private original(id:string){const e=this.events(id).find(e=>e.kind==='delivery_validation_registered');if(!e)throw new Error('delivery_validation_not_registered');const p=parseDeliveryValidation(this.bytes(e.data.originalSha256));if(p.id!==id||deliveryValidationSha(p)!==e.data.planSha256||e.data.batchSha256!==p.batchSha256||e.data.member!==p.member||e.data.testPlanSha256!==p.testPlan.sha256||canonical(e.data.snapshotSha256)!==canonical(p.snapshots.map(s=>s.sha256)))throw new Error('delivery_validation_original_changed');return {plan:p,record:e.data};}
  private registered(){return (this.db.prepare("SELECT object FROM events WHERE kind='delivery_validation_registered'").all() as Row[]).map(e=>this.original(e.object.slice('delivery-validation:'.length)));}
  private guards(){
    installTestAuthorityGuard(this.db);
    // Installed only in a write transaction. Reading old captures never upgrades
    // their database; an already-open older consumer cannot register an alias.
    for(const [name,sql] of [['delivery_validation_authority_unique',authorityBindingIndex],['delivery_validation_authority_guard',authorityBindingGuard]]){
      const old=this.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name!) as Row|undefined;
      if(old&&old.sql!==sql)throw new Error('delivery_validation_authority_guard_changed');if(!old)this.db.exec(sql!);
    }
  }
  private bindAuthority(p:DeliveryValidationPlan,bind:boolean){
    if(p.authorityIntent===null)return;
    requireTestAuthorityConsumer(this.db,p.authorityIntent,'delivery-validation:'+p.id);
    const sha=deliveryValidationSha(p);
    // Legacy records precede the binding event. They still consume their exact
    // reservation; ambiguous historical aliases never choose a new winner.
    for(const old of this.registered())if(old.plan.authorityIntent===p.authorityIntent&&(old.plan.id!==p.id||old.record.planSha256!==sha))throw new Error('delivery_validation_authority_intent_already_bound');
    const matches=this.db.prepare("SELECT object FROM events WHERE kind='delivery_validation_authority_bound' AND json_extract(data,'$.value.authorityIntent')=?").all(p.authorityIntent) as Row[];
    if(matches.length){const e=this.events(matches[0]!.object.slice('delivery-validation:'.length)).find(e=>e.kind==='delivery_validation_authority_bound');if(matches.length!==1||!e||e.object!=='delivery-validation:'+p.id||e.data.planSha256!==sha||e.data.authorityIntent!==p.authorityIntent)throw new Error('delivery_validation_authority_intent_already_bound');}
    else if(bind)this.event(p.id,'authority_bound',{authorityIntent:p.authorityIntent,planSha256:sha,member:p.member,batchSha256:p.batchSha256});
    else throw new Error('delivery_validation_authority_binding_required');
  }
  private predecessors(p:DeliveryValidationPlan,batchId:string){
    for(const old of this.registered())if(old.plan.id!==p.id&&old.record.batchId===batchId){
      // A result index alone does not prove the old run ended. Recheck its
      // original result and terminal capture before authorizing any new work.
      const state=this.stateOf(old.plan.id);if(!['recorded','closed_unstarted'].includes(state.phase))throw new Error('delivery_validation_previous_run_unresolved');
    }
  }
  private gate(p:DeliveryValidationPlan,observations:OwnerObservation[]|null){
    const batch=this.batches.state(p.batchSha256);if(!batch.currentVersion||!batch.currentMaterials)throw new Error('delivery_validation_batch_changed');
    const selected=batch.members.find((m:Row)=>m.item===p.member),item=this.member(p.member);if(!selected||!item.current||item.packet!==selected.packet||item.fingerprint!==selected.fingerprint)throw new Error('delivery_validation_member_changed');
    if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='investment' AND stopped=1").get(batch.scope.id))throw new Error('new_investment_stopped');
    const profile=this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get();
    if(profile){if(!p.authorityIntent||!batch.scope.currentAdoption)throw new Error('delivery_validation_authority_required');const a=this.authority(p.authorityIntent,observations),r=a.request;if(a.role!=='background'||r.action!=='test'||r.item!==p.member||a.adoption!==batch.scope.adoption||r.resourceRefs.length||r.candidate?.H!==item.candidate.H||r.candidate?.B!==item.candidate.B||r.candidate?.subjectSha256!==(item.subjectSha256??null))throw new Error('delivery_validation_authority_binding_mismatch');}
    else if(p.authorityIntent!==null)throw new Error('delivery_validation_authority_profile_missing');
    this.predecessors(p,batch.id);return {batch,item};
  }
  originalPlan(id:string){return this.transaction(()=>this.original(id).plan);}
  register(raw:Buffer,testPlan:Buffer,snapshots:Buffer[],observations:OwnerObservation[]){return this.transaction(()=>{
    const p=parseDeliveryValidation(raw),sha=deliveryValidationSha(p);if(this.events(p.id).length){const old=this.original(p.id);if(old.record.planSha256!==sha)throw new Error('delivery_validation_id_changed');return {...this.stateOf(p.id),duplicate:true};}
    const {batch,item}=this.gate(p,observations),plan=parsePlan(JSON.parse(testPlan.toString()));if(!plan.executor||hash(testPlan)!==p.testPlan.sha256)throw new Error('delivery_validation_isolated_plan_required');
    const expected=item.composition?.subject?.members.map((m:Row)=>m.manifestHash)??[item.manifestSha256];
    if(snapshots.length!==expected.length||snapshots.length!==p.snapshots.length||snapshots.some((b,i)=>hash(b)!==expected[i]||hash(b)!==p.snapshots[i]!.sha256))throw new Error('delivery_validation_snapshot_binding_mismatch');
    for(const s of p.scenarios){const scenario=batch.scenarios.find(x=>x.id===s.scenario),tool=plan.tools.find(t=>t.id===s.tool);if(!scenario||scenario.members.length!==1||scenario.members[0]!==p.member||!tool?.expectedSampleIds||s.samples.some(x=>!tool.expectedSampleIds!.includes(x)))throw new Error('delivery_validation_scenario_binding_mismatch');}
    this.guards();this.bindAuthority(p,true);
    this.event(p.id,'registered',{planSha256:sha,originalSha256:this.blob(raw),testPlanSha256:this.blob(testPlan),snapshotSha256:snapshots.map(b=>this.blob(b)),contextSha256:this.blob(Buffer.from(canonical(item.context))),batchId:batch.id,batchSha256:p.batchSha256,member:p.member,packet:item.packet,fingerprint:item.fingerprint,registeredAt:now(),demonstrationFixture:p.demonstrationFixture});return {...this.stateOf(p.id),duplicate:false};
  });}
  context(id:string){return this.transaction(()=>this.bytes(this.original(id).record.contextSha256));}
  testPlan(id:string){return this.transaction(()=>this.bytes(this.original(id).record.testPlanSha256));}
  snapshotContents(id:string){return this.transaction(()=>this.original(id).record.snapshotSha256.map((sha:string)=>{const manifest=this.bytes(sha),value=JSON.parse(manifest.toString());if(!Array.isArray(value.artifacts))throw new Error('delivery_validation_source_missing');const artifacts=value.artifacts.map((r:Row)=>{if(typeof r.path!=='string'||!/^(raw\/[a-f0-9]{64}\.json|git\/[a-f0-9]{64}\.(patch|json))$/.test(r.path))throw new Error('delivery_validation_source_path_invalid');const bytes=this.bytes(r.sha256);if(bytes.length!==r.bytes)throw new Error('delivery_validation_source_changed');return {path:r.path,bytes};});return {manifest,artifacts};}));}
  markStarted(id:string,run:string,testPlanSha256:string){return this.transaction(()=>{const x=this.original(id),events=this.events(id),old=events.find(e=>e.kind==='delivery_validation_started');if(events.some(e=>e.kind==='delivery_validation_closed_unstarted'))throw new Error('delivery_validation_closed');if(old){if(old.data.run!==run||old.data.testPlanSha256!==testPlanSha256)throw new Error('delivery_validation_original_run_changed');return old.data;}this.guards();this.bindAuthority(x.plan,false);this.predecessors(x.plan,x.record.batchId);if(!/^[a-f0-9-]{36}$/.test(run)||testPlanSha256!==x.record.testPlanSha256)throw new Error('delivery_validation_start_binding_mismatch');const value={run,testPlanSha256,startedAt:now()};this.event(id,'started',value);return value;});}
  closeUnstarted(id:string,evidence:Buffer){return this.transaction(()=>{this.original(id);const events=this.events(id);if(events.some(e=>e.kind==='delivery_validation_started'))throw new Error('delivery_validation_started_or_unknown');if(!events.some(e=>e.kind==='delivery_validation_closed_unstarted'))this.event(id,'closed_unstarted',{evidenceSha256:this.blob(evidence),existingRecordsPreserved:true,executionGranted:false});return this.stateOf(id);});}
  startEffect(id:string,observations:OwnerObservation[],effect:()=>void){return this.transaction(()=>{const p=this.original(id).plan,events=this.events(id);if(!events.some(e=>e.kind==='delivery_validation_started'))throw new Error('delivery_validation_original_run_missing');if(events.some(e=>e.kind==='delivery_validation_result'))throw new Error('delivery_validation_already_ended');this.guards();this.bindAuthority(p,false);this.gate(p,observations);effect();});}
  check(id:string,observations:OwnerObservation[]){return this.transaction(()=>{const p=this.original(id).plan,value=this.gate(p,observations);this.guards();this.bindAuthority(p,true);return value;});}
  problem(id:string,reason:string){return this.transaction(()=>{this.original(id);if(!/^[a-z0-9_]{1,160}$/.test(reason))throw new Error('delivery_validation_problem_invalid');this.event(id,'problem',{reason,observedAt:now(),automaticResend:false});});}
  complete(id:string,capture:DeliveryValidationCapture){return this.transaction(()=>{
    const {packet,binding}=requireDeliveryValidationCapture(capture);
    const x=this.original(id),events=this.events(id),started=events.find(e=>e.kind==='delivery_validation_started'),reportBytes=packet.blobs.get(packet.reportHash);if(!started||!reportBytes)throw new Error('delivery_validation_original_run_missing');
    if(binding.id!==id||binding.planSha256!==x.record.planSha256||binding.run!==started.data.run||binding.testPlanSha256!==x.record.testPlanSha256)throw new Error('delivery_validation_capture_binding_mismatch');
    const report=JSON.parse(reportBytes.toString());if(report.id!==started.data.run||report.planHash!==x.record.testPlanSha256||canonical(report.inputs.map((i:Row)=>i.manifestHash))!==canonical(x.record.snapshotSha256)||packet.contextHash!==x.record.contextSha256)throw new Error('delivery_validation_capture_binding_mismatch');
    // These are replayed execution records, not semantic product acceptance.
    // Incomplete/unknown executions retain the registered run for recovery.
    const gaps=packet.summary.gaps.filter(g=>!(g==='sample_failure_or_incomplete_comparison'&&report.comparisonComplete===true)),captureComplete=!gaps.length&&report.executionComplete===true&&report.comparisonComplete===true;
    const final=report.stages.at(-1),scenarios=x.plan.scenarios.map(s=>{const tool=final?.tools.find((t:Row)=>t.id===s.tool),rows=s.samples.map(id=>tool?.sampleSet?.samples.find((r:Row)=>r.id===id)),complete=captureComplete&&tool?.sampleSet?.complete&&rows.every((r:Row)=>!!r);return {scenario:s.scenario,tool:s.tool,samples:rows.filter((r:Row)=>!!r),passed:complete?rows.every((r:Row)=>r.status==='ok'):null};});
    const value={run:report.id,reportSha256:packet.reportHash,contextSha256:packet.contextHash,manifestSha256:packet.manifestHash,originals:[...packet.blobs.keys()].sort(),testedHead:final?.head??null,testedTree:final?.tree??null,scenarios,executionComplete:report.executionComplete===true,terminalExecutionProven:true,captureComplete,gaps,scenarioAssertionsPassed:scenarios.every(s=>s.passed===true),demonstrationFixture:x.plan.demonstrationFixture,userOutcomeAccepted:false,finishedAt:report.finishedAt};
    const old=events.find(e=>e.kind==='delivery_validation_result');if(old){if(canonical(old.data)!==canonical(value))throw new Error('delivery_validation_result_changed');return {...old.data,duplicate:true};}for(const [sha,b] of packet.blobs){if(hash(b)!==sha)throw new Error('delivery_validation_original_changed');this.blob(b);}this.event(id,'result',value);return {...value,duplicate:false};
  });}
  private stateOf(id:string){const x=this.original(id),events=this.events(id),started=events.find(e=>e.kind==='delivery_validation_started'),closed=events.find(e=>e.kind==='delivery_validation_closed_unstarted'),result=events.find(e=>e.kind==='delivery_validation_result')?.data;if(result)for(const sha of result.originals)this.bytes(sha);if(closed)this.bytes(closed.data.evidenceSha256);return {id,planSha256:x.record.planSha256,batchSha256:x.plan.batchSha256,member:x.plan.member,phase:result?'recorded':started?'started_or_unknown':closed?'closed_unstarted':'registered_not_started',run:started?.data.run??null,result:result??null,automaticResend:false,userOutcomeAccepted:false};}
  state(id:string){return this.transaction(()=>this.stateOf(id));}
  assessmentMaterial(id:string){return this.transaction(()=>{const state=this.stateOf(id),original=this.original(id);if(state.phase!=='recorded'||!state.result?.terminalExecutionProven)throw new Error('delivery_assessment_validation_not_terminal');
    const originals=state.result.originals.map((sha256:string)=>{const bytes=this.bytes(sha256);let encoding='utf8',content:string;try{content=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{encoding='base64';content=bytes.toString('base64');}return {sha256,bytes:bytes.length,encoding,content};});
    return {validationId:id,plan:original.plan,state,originals};
  });}
  forBatch(sha:string){return this.transaction(()=>{
    const rows=this.db.prepare("SELECT object FROM events WHERE kind='delivery_validation_registered' AND json_extract(data,'$.value.batchSha256')=? ORDER BY id").all(sha) as Row[];
    return rows.map(row=>this.original(row.object.slice('delivery-validation:'.length))).map(x=>{if(x.plan.batchSha256!==sha)throw new Error('delivery_validation_index_changed');const state=this.stateOf(x.plan.id),r=state.result;return {id:state.id,planSha256:state.planSha256,batchSha256:sha,member:state.member,phase:state.phase,run:state.run,demonstrationFixture:x.plan.demonstrationFixture,reportSha256:r?.reportSha256??null,terminalExecutionProven:r?.terminalExecutionProven??false,captureComplete:r?.captureComplete??false,scenarios:x.plan.scenarios.map(s=>({id:s.scenario,tool:s.tool,requestedSamples:s.samples,passed:r?.scenarios.find((x:Row)=>x.scenario===s.scenario)?.passed??null}))};});
  });}
}
