import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import { eventKey,parseEventProfile,parseEventHint,parseQueuePreference,type EventProfile } from './event-contract.js';
import type { OwnerObservation } from './authority-source.js';
import { requireEventSource,eventMaterialHash,type EventSourceObservation } from './event-source.js';
import { currentEventSource,effectiveEventCandidate,eventGuards,legacyEventGuards,eventGuardsPresent,packetSourceMaterial,storedEventMaterial } from './event-gates.js';
import { currentMembers,composeSubject } from './composition.js';
import { targetKey } from './queue-evidence.js';
import { dirname,basename } from 'node:path';

type Row=Record<string,any>;
const profileKey='bounded_event_source_profile';
const sourceKey=(repo:string,pr:number)=>'event-source:'+eventKey(repo,pr);

/** Notification and source observations live beside existing queue events and
 * blobs. This class does not create a second task queue or call an agent. */
export class EventRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private directory:string,private refreshIntent?:(id:string,observations:OwnerObservation[])=>Row){}
  private event(kind:string,object:string,data:unknown){const r=this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('source_'+kind,object,JSON.stringify(data),now());return Number(r.lastInsertRowid);}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('event_original_missing_or_changed');return b;}
  private profile():EventProfile{const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(profileKey) as Row;if(!row)throw new Error('bounded_event_source_not_configured');return parseEventProfile(this.bytes(row.value));}
  private events(object:string,kind:string){return (this.db.prepare('SELECT * FROM events WHERE object=? AND kind=? ORDER BY id').all(object,'source_'+kind) as Row[]).map(e=>({...e,data:JSON.parse(e.data)}));}
  private state(pr:number){const p=this.profile();if(!p.prs.includes(pr))throw new Error('event_subject_not_registered');const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(sourceKey(p.repository,pr)) as Row;if(!r)throw new Error('event_subject_state_missing');const s=JSON.parse(r.value);if(s.projectionSha256)this.bytes(s.projectionSha256);return s as Row;}
  private save(pr:number,s:Row){this.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(s),sourceKey(this.profile().repository,pr));}
  configure(raw:Buffer){return this.transaction(()=>{
    const p=parseEventProfile(raw),sha=hash(canonical(p));if(p.repository.toLowerCase()!==(this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value)throw new Error('event_repository_mismatch');
    const old=this.db.prepare('SELECT value FROM meta WHERE key=?').get(profileKey) as Row;if(old){
      if(old.value!==sha)throw new Error('event_profile_is_fixed');
      if(!eventGuardsPresent(this.db)){
        if(!legacyEventGuards.every(g=>(this.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name) as Row)?.sql===g.sql))throw new Error('event_storage_guards_missing_or_unknown');
        if((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n||(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n)throw new Error('event_guard_upgrade_requires_idle_queue');
        for(const guard of eventGuards)this.db.exec(`DROP TRIGGER ${guard.name};`+guard.sql);
        for(const pr of p.prs){const state=this.state(pr);state.bindings={};this.save(pr,state);}
        this.event('guards_upgraded','event-profile',{profileSha256:sha,from:'629cd5b',materialReconciliationRequired:true});
        return {duplicate:false,upgraded:true,profileSha256:sha,modelTasksStarted:0};
      }
      return {duplicate:true,profileSha256:sha,modelTasksStarted:0};
    }
    if((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n||(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n)throw new Error('queue_has_active_or_unknown_operation');
    const owner=(this.db.prepare("SELECT value FROM meta WHERE key='owner_authority_profile'").get() as Row)?.value;
    if(owner&&(JSON.parse(this.bytes(owner).toString()).executionKind==='fixture')!==(p.executionKind==='fixture'))throw new Error('event_owner_profile_kind_mismatch');
    if(p.executionKind==='fixture'&&(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE json_extract(result,'$.receiver.executionKind')='native_capture'").get() as Row).n)throw new Error('fixture_event_source_requires_non_native_queue');
    this.blob(raw);this.blob(Buffer.from(canonical(p)));this.db.prepare('INSERT INTO meta VALUES(?,?)').run(profileKey,sha);
    for(const pr of p.prs)this.db.prepare('INSERT INTO meta VALUES(?,?)').run(sourceKey(p.repository,pr),JSON.stringify({pr,complete:false,revision:0,sequence:0,lastStartedAt:null,nextDueAt:null,lastFinishedAt:null,lastGoodAt:null,lastGoodProjectionSha256:null,projectionSha256:null,lastHint:0,consumedHint:0,changes:[],candidate:null,bindings:{},validUntilAt:null}));
    for(const guard of eventGuards)this.db.exec(guard.sql);
    this.event('configured','event-profile',{profileSha256:sha,executionKind:p.executionKind,automaticModelDispatch:false});return {duplicate:false,profileSha256:sha,modelTasksStarted:0};
  });}
  configuration(){return this.transaction(()=>this.profile());}
  controlReceipt(kind:'hint'|'preference',id:string){return this.transaction(()=>{
    this.profile();if(!/^qe-[a-f0-9]{64}-[a-f0-9]{32}$/.test(id))throw new Error('event_control_receipt_id_invalid');
    const object=(kind==='hint'?'event-hint:':'queue-preference:')+id,event=this.events(object,kind==='hint'?'hint':'preference_applied')[0] as Row|undefined;
    if(!event)return null;this.bytes(event.data.sha256);return {...event.data,eventId:event.id,recordedAt:event.observed_at,modelTasksStarted:0};
  });}
  controlReceipts(kind:'hint'|'preference',prefix:string){return this.transaction(()=>{
    this.profile();if(!/^qe-[a-f0-9]{64}-$/.test(prefix))throw new Error('event_control_receipt_prefix_invalid');
    const head=(kind==='hint'?'event-hint:':'queue-preference:')+prefix,rows=this.db.prepare('SELECT id,data,observed_at FROM events WHERE kind=? AND substr(object,1,?)=? ORDER BY id DESC LIMIT 32').all('source_'+(kind==='hint'?'hint':'preference_applied'),head.length,head) as Row[];
    return rows.map(e=>{const data=JSON.parse(e.data);this.bytes(data.sha256);return {...data,eventId:e.id,recordedAt:e.observed_at,modelTasksStarted:0};});
  });}
  applyPreference(intentId:string,raw:Buffer,observations:OwnerObservation[]){return this.transaction(()=>{
    const p=this.profile(),preference=parseQueuePreference(raw),sha256=hash(canonical(preference)),object='queue-preference:'+intentId,old=this.events(object,'preference_applied')[0];
    if(old){if(old.data.sha256!==sha256)throw new Error('original_preference_intent_changed');this.bytes(old.data.sha256);return {...old.data,duplicate:true};}
    if(!this.refreshIntent)throw new Error('preference_authority_consumer_unavailable');
    const intent=this.refreshIntent(intentId,observations),request=intent.request;
    if(intent.executionKind!==p.executionKind||!['background','coordinator','secretary'].includes(intent.role)||request.action!=='coordinate'||request.item!==preference.item||request.payloadSha256!==sha256||request.paths.length||request.resourceRefs.length||request.repository.toLowerCase()!==p.repository.toLowerCase())throw new Error('preference_exact_authority_binding_required');
    const data={intentId,preference,sha256:this.blob(Buffer.from(canonical(preference))),originalSha256:this.blob(raw),authorization:intent.authorization,adoption:intent.adoption,binding:intent.binding,executionKind:intent.executionKind,appliedAt:now(),effect:'local_queue_preference_applied',technicalIncidentVerified:false,executionPermissionGranted:false};
    this.event('preference_applied',object,data);return {...data,duplicate:false};
  });}
  hint(raw:Buffer){return this.transaction(()=>{
    const p=this.profile(),hint=parseEventHint(raw,p),object='event-hint:'+hint.id,old=this.events(object,'hint')[0];
    if(old){if(old.data.sha256!==hash(canonical(hint)))throw new Error('event_hint_id_content_conflict');return {...old.data,duplicate:true,modelTasksStarted:0};}
    const sha256=this.blob(Buffer.from(canonical(hint))),id=this.event('hint',object,{hint,sha256}),state=this.state(hint.pr);state.lastHint=id;this.save(hint.pr,state);
    return {hint,sha256,duplicate:false,sourceVerified:false,modelTasksStarted:0};
  });}
  private dueAt(at:number){
    const p=this.profile();const rows=p.prs.map(pr=>this.state(pr)).filter(s=>!s.nextDueAt||at>=Date.parse(s.nextDueAt)||s.lastHint>s.consumedHint&&(!s.lastStartedAt||at-Date.parse(s.lastStartedAt)>=Math.min(p.pollIntervalMs,5000)));
    rows.sort((a,b)=>(Date.parse(a.lastStartedAt??'1970-01-01T00:00:00Z')-Date.parse(b.lastStartedAt??'1970-01-01T00:00:00Z'))||a.pr-b.pr);
    return rows.map(s=>({pr:s.pr,reason:s.lastHint>s.consumedHint?'hint_requires_source_check':'periodic_backfill',originalSequence:s.sequence}));
  }
  due(){return this.transaction(()=>{const all=this.dueAt(Date.now()),p=this.profile();return {subjects:all.slice(0,p.maxSubjectsPerTick),deferred:all.slice(p.maxSubjectsPerTick),modelTasksStarted:0};});}
  private knownPublished(pr:number){
    const p=this.profile(),known:Array<{id:number;bodySha256:string}>=[];
    const rows=this.db.prepare("SELECT e.data,o.id AS operation,i.candidate FROM events e JOIN operations o ON e.object='publication:'||o.id JOIN items i ON i.id=o.item WHERE e.kind='publication_verified'").all() as Row[];
    for(const row of rows){const d=JSON.parse(row.data),candidate=JSON.parse(row.candidate);if(d.stage!=='comment'||candidate.repository.toLowerCase()!==p.repository.toLowerCase()||candidate.pr!==pr||!Number.isSafeInteger(d.remote?.id))continue;
      const prepared=this.db.prepare("SELECT data FROM events WHERE object=? AND kind='publication_prepared' ORDER BY id DESC LIMIT 1").get('publication:'+row.operation) as Row|undefined;
      if(!prepared)continue;const document=JSON.parse(this.bytes(JSON.parse(prepared.data).documentSha256).toString());if(hash(document.commentBody)!==d.remote.bodySha256)continue;
      known.push({id:d.remote.id,bodySha256:d.remote.bodySha256});
    }
    return known.filter((k,i)=>known.findIndex(x=>x.id===k.id&&x.bodySha256===k.bodySha256)===i).sort((a,b)=>a.id-b.id);
  }
  beginPoll(pr:number,directory:string){return this.transaction(()=>{
    if(dirname(directory)!==this.directory||!new RegExp(`^source-poll-${pr}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(basename(directory)))throw new Error('event_capture_must_belong_to_original_queue');
    const p=this.profile(),s=this.state(pr),due=this.dueAt(Date.now()).find(x=>x.pr===pr);if(!due)return {started:false as const,reason:'not_due',originalSequence:s.sequence};
    s.sequence++;s.lastStartedAt=now();s.nextDueAt=new Date(Date.now()+p.pollIntervalMs).toISOString();
    const data={pr,sequence:s.sequence,directory,startedAt:s.lastStartedAt,controllerPid:process.pid,hintWatermark:s.lastHint,reason:due.reason,profileSha256:hash(canonical(p)),knownPublished:this.knownPublished(pr)};
    this.save(pr,s);this.event('poll_started',sourceKey(p.repository,pr),data);return {started:true as const,...data};
  });}
  observe(pr:number,sequence:number,observation:EventSourceObservation){return this.transaction(()=>{
    const p=this.profile(),s=this.state(pr),object=sourceKey(p.repository,pr),start=this.events(object,'poll_started').find(e=>e.data.sequence===sequence);
    if(!start)throw new Error('original_source_poll_required');requireEventSource(observation,p,pr);
    if(canonical(start.data.knownPublished)!==canonical(observation.knownPublished)||observation.records.some(r=>!r.directory.startsWith(start.data.directory+'/')))throw new Error('event_original_poll_capture_mismatch');
    const index={profileSha256:observation.profileSha256,pr,sequence,observedAt:observation.observedAt,knownPublished:observation.knownPublished,result:observation.result,records:observation.records.map(r=>({kind:r.kind,endpoint:r.endpoint,page:r.page,status:r.status,headers:r.headers,directory:r.directory,sha256:hash(r.body),bytes:r.body.length}))};
    const encoded=Buffer.from(canonical(index)),existing=this.events(object,'poll_finished').find(e=>e.data.sequence===sequence);if(existing){if(existing.data.projectionSha256!==hash(encoded))throw new Error('original_event_poll_result_changed');return {duplicate:true,...existing.data,modelTasksStarted:0};}
    for(const r of observation.records)this.blob(r.body);
    const projectionSha256=this.blob(encoded),previous=s.projectionSha256?JSON.parse(this.bytes(s.projectionSha256).toString()).result:null,baseline=s.lastGoodProjectionSha256?JSON.parse(this.bytes(s.lastGoodProjectionSha256).toString()).result:null,changes:string[]=[];
    if(observation.result.complete){
      if(!previous?.complete)changes.push(s.lastGoodAt?'source_recovered':'source_first_observed');
      if(baseline?.semantic){for(const field of ['candidate','prBodySha256','comments','inline','reviews','checks','statuses'])if(canonical(baseline.semantic[field])!==canonical((observation.result.semantic as Row)[field]))changes.push(field==='candidate'?'candidate_changed':['checks','statuses'].includes(field)?'conditions_changed':'material_changed');}
    }else changes.push('source_unavailable_or_partial');
    const archived=sequence<s.sequence;
    if(!archived){s.complete=observation.result.complete;s.lastFinishedAt=now();s.projectionSha256=projectionSha256;s.consumedHint=Math.max(s.consumedHint,start.data.hintWatermark);s.candidate=observation.result.candidate;s.changes=[...new Set(changes)];delete s.lastProblem;if(observation.result.complete){s.lastGoodAt=observation.observedAt;s.lastGoodProjectionSha256=projectionSha256;s.validUntilAt=new Date(Date.parse(observation.observedAt)+Math.max(60000,2*p.pollIntervalMs)).toISOString();if(!baseline||baseline.semanticSha256!==observation.result.semanticSha256)s.revision++;if(!baseline||changes.includes('candidate_changed')||changes.includes('material_changed'))s.bindings={};}this.save(pr,s);}
    const event={pr,sequence,projectionSha256,complete:observation.result.complete,semanticSha256:observation.result.semanticSha256,revision:s.revision,changes:[...new Set(changes)],archived,rawBytes:observation.records.reduce((n,r)=>n+r.body.length,0),newModelTaskCreated:false};this.event('poll_finished',object,event);return {duplicate:false,...event,modelTasksStarted:0};
  });}
  problem(pr:number,sequence:number,reason:string){return this.transaction(()=>{
    const p=this.profile(),s=this.state(pr),start=this.events(sourceKey(p.repository,pr),'poll_started').find(e=>e.data.sequence===sequence);if(!start)throw new Error('original_source_poll_required');
    const data={pr,sequence,reason:reason.slice(0,512),archived:sequence<s.sequence};this.event('poll_problem',sourceKey(p.repository,pr),data);if(!data.archived){s.complete=false;s.lastProblem=data;this.save(pr,s);}return data;
  });}
  /** Material changes create a local packet, not another model task. Original
   * calls, immutable W1/W2 evidence and candidate-wide dispatch limits remain. */
  reconcilePackets(){return this.transaction(()=>{
    this.profile();const results:Row[]=[];
    const items=this.db.prepare('SELECT * FROM items ORDER BY created_at,id').all() as Row[];
    if(items.length>256)throw new Error('bounded_event_queue_limit');
    for(const item of items){
      const packet=this.db.prepare('SELECT * FROM packets WHERE id=?').get(item.current_packet) as Row,summary=JSON.parse(packet.summary),candidate=JSON.parse(item.candidate);
      const members=summary.composition?currentMembers(summary.composition):[candidate];
      const sources=members.map(c=>({candidate:c,source:currentEventSource(this.db,effectiveEventCandidate(c,item.latest_source_observation),item.id,packet.id)})).filter(x=>x.source.registered);
      if(!sources.length)continue;
      const reasons=sources.filter(x=>!x.source.current).map(x=>`${x.candidate.pr}:${x.source.reason}`);
      if(item.observation_conflict)reasons.push('observation_order_conflict');
      if(reasons.length){results.push({item:item.id,packet:packet.id,waiting:reasons});continue;}
      if(sources.every(x=>x.source.materialBound)){results.push({item:item.id,packet:packet.id,changed:false});continue;}
      if(this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(targetKey(candidate))){results.push({item:item.id,packet:packet.id,waiting:['original_execution_active_or_unknown']});continue;}
      const manifest=JSON.parse(this.bytes(packet.manifest_hash).toString()),report=JSON.parse(this.bytes(packet.report_hash).toString());
      if(summary.composition&&canonical(composeSubject(report,h=>this.bytes(h)))!==canonical(summary.composition))throw new Error('stored_composition_changed');
      const previous=summary.eventSources??[],references:Row[]=[];let changed=false;
      for(const {candidate:c,source} of sources){
        const materialSha256=eventMaterialHash(source.index.result.semantic),prior=previous.find((r:Row)=>r.pr===c.pr);
        if(prior)storedEventMaterial(this.db,prior);
        let memberManifest=manifest;
        if(summary.composition){
          // A1 -> B1 -> A2 may contain two versions of the same PR. Only the
          // exact final member's source is a baseline for its current material.
          const member=summary.composition.subject.members.findLast((m:Row)=>m.candidate.pr===c.pr),input=member&&report.inputs[member.index];
          if(!member||!input||canonical(member.candidate)!==canonical(c)||canonical(input.candidate)!==canonical(c)||input.manifestHash!==member.manifestHash||input.manifest.sha256!==member.manifestHash)throw new Error('current_composition_member_source_unverified');
          memberManifest=JSON.parse(this.bytes(member.manifestHash).toString());
        }
        const baseline=prior?.materialSha256??packetSourceMaterial(this.db,memberManifest,source.index.knownPublished);
        if(baseline!==materialSha256){changed=true;references.push({pr:c.pr,projectionSha256:source.state.projectionSha256,materialSha256});}
        else if(prior)references.push(prior);
      }
      let packetId=packet.id;
      if(changed){
        if(this.db.prepare("SELECT 1 FROM events WHERE kind='pair_registered' AND (json_extract(data,'$.first.item')=? OR json_extract(data,'$.second.item')=?)").get(item.id,item.id)){results.push({item:item.id,packet:packet.id,waiting:['paired_arrangement_requires_new_material_binding']});continue;}
        const eventSources=references.sort((a,b)=>a.pr-b.pr),fingerprint=hash(canonical({previous:packet.fingerprint,eventSources}));
        const inserted=this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id,fingerprint,packet.manifest_hash,packet.report_hash,packet.context_hash,JSON.stringify({...summary,baseFingerprint:summary.baseFingerprint??packet.fingerprint,eventSources}),now());
        packetId=Number(inserted.lastInsertRowid);this.db.prepare('UPDATE items SET current_packet=? WHERE id=?').run(packetId,item.id);
        this.event('material_packet',item.id,{packet:packetId,previousPacket:packet.id,previousFingerprint:packet.fingerprint,fingerprint,eventSources,modelTasksStarted:0});
      }
      for(const {candidate:c} of sources){const state=this.state(c.pr);state.bindings[item.id]=packetId;this.save(c.pr,state);}
      this.event('material_bound',item.id,{packet:packetId,changed,sources:sources.map(x=>({pr:x.candidate.pr,projectionSha256:x.source.state.projectionSha256}))});
      results.push({item:item.id,packet:packetId,previousPacket:packet.id,changed});
    }
    return {items:results,modelTasksStarted:0};
  });}
  private view(pr:number):Row{
    const s=this.state(pr),index=s.projectionSha256?JSON.parse(this.bytes(s.projectionSha256).toString()):null;
    if(index)for(const ref of index.records){const b=this.bytes(ref.sha256);if(b.length!==ref.bytes)throw new Error('event_capture_length_changed');}
    return {...s,currentResult:s.lastProblem?{complete:false,gaps:[s.lastProblem.reason],candidate:null}:index?.result??null,lastCapturedResult:index?.result??null,originals:index?.records??[],next:'bounded_source_check_and_existing_queue_assessment',modelTasksStarted:0};
  }
  status(){return this.transaction(()=>{const p=this.profile();return {profileSha256:hash(canonical(p)),subjects:p.prs.map(pr=>this.view(pr)),automaticMerge:false,modelTasksStarted:0};});}
}
