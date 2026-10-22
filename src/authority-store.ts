import {queueFeatureVersion,setQueueFeatureVersion} from './queue-format.js';
import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import { parseAuthorityProfile, parseOwnerProposal, parseActionRequest, scopeBodyHash, actionHash, roleCanRequest, ownerDecisionText, isAuthorityDigest, type AuthorityProfile, type PreparedProposal, type OwnerProposal, type AuthorityRole, type ActionRequest,type DeliveryOutcomeProposal } from './authority-contract.js';
import { requireOwnerObservation,inspectStoredOwnerSource, type OwnerObservation } from './authority-source.js';
import {installRecompositionTestGuards} from './recomposition-test-guards.js';
import {publicationConsumerKey,legacyPublicationEffectGuard,governedPublicationEffectGuard,publicationGuardsCurrent,installPublicationGuards} from './publication-guards.js';

type Row=Record<string,any>;
const profileKey='owner_authority_profile';
const repairConsumerKey='owner_governed_repair_v1';
const receiverConsumerKey='owner_governed_receiver_v1';
const admittedRepair=`EXISTS(SELECT 1 FROM events a WHERE a.kind='authority_repair_admitted' AND a.object=NEW.id AND json_extract(a.data,'$.packet')=NEW.packet AND json_extract(a.data,'$.planSha256')=json_extract(NEW.result,'$.repair.planSha256') AND json_extract(a.data,'$.requestSha256')=json_extract(NEW.result,'$.repair.requestSha256') AND json_extract(a.data,'$.configSha256')=json_extract(NEW.result,'$.repair.configSha256') AND json_extract(a.data,'$.authorityIntent')=json_extract(NEW.result,'$.repair.authorityIntent'))`;
const admittedReceiver=`EXISTS(SELECT 1 FROM events a WHERE a.kind='integration_consumer_admitted' AND a.object=NEW.id AND a.id=(SELECT MAX(id) FROM events) AND json_extract(a.data,'$.packet')=NEW.packet AND json_extract(a.data,'$.status')=NEW.status AND json_extract(a.data,'$.planSha256')=json_extract(NEW.result,'$.receiver.planSha256') AND json_extract(a.data,'$.inputSha256')=json_extract(NEW.result,'$.receiver.inputSha256') AND json_extract(a.data,'$.bindingHash')=json_extract(NEW.result,'$.receiver.bindingHash') AND json_extract(a.data,'$.authorityIntent')=json_extract(NEW.result,'$.receiver.authorityIntent'))`;
const governedRepairGuard=`CREATE TRIGGER authority_legacy_native_guard BEFORE UPDATE ON operations WHEN EXISTS(SELECT 1 FROM meta WHERE key='${profileKey}') AND ((NEW.status='receiving' AND (OLD.status!='receiving' OR json_extract(NEW.result,'$.receiver.phase')='dispatch_registered' AND json_extract(OLD.result,'$.receiver.phase') IS NOT 'dispatch_registered')) OR NEW.status='repairing' AND OLD.status!='repairing' AND NOT ${admittedRepair}) BEGIN SELECT RAISE(ABORT,'authority_consumer_binding_required'); END`;
const governedReceiverGuard=(repair:boolean)=>`CREATE TRIGGER authority_legacy_native_guard BEFORE UPDATE ON operations WHEN EXISTS(SELECT 1 FROM meta WHERE key='${profileKey}') AND ((NEW.status='receiving' AND (OLD.status!='receiving' OR json_extract(NEW.result,'$.receiver.phase')='dispatch_registered' AND json_extract(OLD.result,'$.receiver.phase') IS NOT 'dispatch_registered') AND NOT ${admittedReceiver}) OR NEW.status='repairing' AND OLD.status!='repairing'${repair?' AND NOT '+admittedRepair:''}) BEGIN SELECT RAISE(ABORT,'authority_consumer_binding_required'); END`;
const receiverResourceGuard=`CREATE TRIGGER authority_receiver_resource_guard BEFORE INSERT ON events
WHEN NEW.kind='resource_claim_dispatched' AND EXISTS(SELECT 1 FROM events p JOIN events a ON a.object='authority-intent:'||json_extract(p.data,'$.authorityIntent') AND a.kind='authority_action_reserved' WHERE p.kind='resource_request_prepared' AND p.object=NEW.object AND json_extract(a.data,'$.request.action')='receive')
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events a JOIN events b ON b.kind='authority_receiver_bound' AND b.object=json_extract(NEW.data,'$.originalOperation') WHERE a.kind='member_resource_claim_admitted' AND a.object=NEW.object AND a.id=(SELECT MAX(id) FROM events) AND json_extract(a.data,'$.requestSha256')=json_extract(NEW.data,'$.requestSha256') AND json_extract(a.data,'$.operation')=json_extract(NEW.data,'$.originalOperation') AND json_extract(a.data,'$.receiverPlanSha256')=json_extract(b.data,'$.planSha256') AND json_extract(a.data,'$.receiverAuthorityIntent')=json_extract(b.data,'$.authorityIntent') AND EXISTS(SELECT 1 FROM json_each(b.data,'$.resourceRequests') WHERE value=json_extract(NEW.data,'$.requestSha256'))) THEN RAISE(ABORT,'receiver_resource_binding_required') END; END`;
const ownerStopPredicate=`EXISTS(SELECT 1 FROM events a WHERE a.kind='authority_control_applied' AND a.object=NEW.scope AND json_extract(a.data,'$.control')=NEW.kind AND json_extract(a.data,'$.state')='stopped' AND NOT EXISTS(SELECT 1 FROM events b WHERE b.kind='authority_control_applied' AND b.object=a.object AND json_extract(b.data,'$.control')=NEW.kind AND b.id>a.id))`;
const guards=[
  ...['INSERT','UPDATE'].map(verb=>({name:'authority_control_'+verb.toLowerCase(),sql:`CREATE TRIGGER authority_control_${verb.toLowerCase()} BEFORE ${verb} ON controls WHEN NEW.stopped=0 AND ${ownerStopPredicate} BEGIN SELECT RAISE(ABORT,'verified_owner_stop_requires_verified_resume'); END`})),
  {name:'authority_control_delete',sql:`CREATE TRIGGER authority_control_delete BEFORE DELETE ON controls WHEN EXISTS(SELECT 1 FROM meta WHERE key='${profileKey}') BEGIN SELECT RAISE(ABORT,'owner_controls_must_be_preserved'); END`},
  // Explicit integration boundary: old native consumers cannot silently bypass
  // the new owner source. Their original result reconciliation remains readable.
  {name:'authority_legacy_native_guard',sql:`CREATE TRIGGER authority_legacy_native_guard BEFORE UPDATE ON operations WHEN EXISTS(SELECT 1 FROM meta WHERE key='${profileKey}') AND ((NEW.status='receiving' AND (OLD.status!='receiving' OR json_extract(NEW.result,'$.receiver.phase')='dispatch_registered' AND json_extract(OLD.result,'$.receiver.phase') IS NOT 'dispatch_registered')) OR NEW.status='repairing' AND OLD.status!='repairing') BEGIN SELECT RAISE(ABORT,'authority_consumer_binding_required'); END`},
  {name:'authority_legacy_effect_guard',sql:legacyPublicationEffectGuard},
];

/** Fixed owner decisions in the existing queue events/blobs. This is neither
 * a second operation scheduler nor a resource balance. Nothing executes here. */
export class AuthorityRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,
    private currentItem:(id:string)=>Row,private deliveryOutcomes?:{check:(p:DeliveryOutcomeProposal)=>unknown;record:(sha:string)=>unknown}){}
  private event(kind:string,object:string,data:unknown){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run(kind,object,JSON.stringify(data),now());}
  private events(object:string,kind?:string):Row[]{return (this.db.prepare('SELECT * FROM events WHERE object=? ORDER BY id').all(object) as Row[]).filter(e=>!kind||e.kind===kind).map(e=>({...e,data:JSON.parse(e.data)}));}
  private all(kind:string):Row[]{return (this.db.prepare('SELECT * FROM events WHERE kind=? ORDER BY id').all(kind) as Row[]).map(e=>({...e,data:JSON.parse(e.data)}));}
  private blob(b:Buffer){const h=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(h,b);this.bytes(h);return h;}
  private bytes(h:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(h) as Row;const b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==h)throw new Error('authority_original_changed');return b;}
  private mode(){const publication=Boolean(this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(publicationConsumerKey));if(publication&&!publicationGuardsCurrent(this.db))throw new Error('owner_publication_consumer_contract_changed');const repair=this.db.prepare('SELECT value FROM meta WHERE key=?').get(repairConsumerKey) as Row|undefined,receiver=this.db.prepare('SELECT value FROM meta WHERE key=?').get(receiverConsumerKey) as Row|undefined;if(repair&&repair.value!==hash(governedRepairGuard))throw new Error('owner_repair_consumer_contract_changed');if(receiver&&receiver.value!==hash(admittedReceiver))throw new Error('owner_receiver_consumer_contract_changed');if(receiver&&(this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='authority_receiver_resource_guard'").get() as Row|undefined)?.sql!==receiverResourceGuard)throw new Error('owner_receiver_resource_guard_changed');if(![12,13,14,15,16].includes(queueFeatureVersion(this.db))||!guards.every(g=>(this.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name) as Row)?.sql===(g.name==='authority_legacy_native_guard'?(receiver?governedReceiverGuard(Boolean(repair)):repair?governedRepairGuard:g.sql):g.name==='authority_legacy_effect_guard'&&publication?governedPublicationEffectGuard:g.sql)))throw new Error('owner_authority_not_enabled');}
  private profile(){this.mode();const ref=(this.db.prepare('SELECT value FROM meta WHERE key=?').get(profileKey) as Row)?.value;if(!isAuthorityDigest(ref))throw new Error('owner_authority_profile_missing');const p=parseAuthorityProfile(this.bytes(ref));if(hash(canonical(p))!==ref)throw new Error('authority_profile_changed');return {profile:p,profileSha256:ref};}
  configure(raw:Buffer){return this.transaction(()=>{
    const p=parseAuthorityProfile(raw),encoded=Buffer.from(canonical(p)),profileSha256=hash(encoded),version=queueFeatureVersion(this.db);
    if(p.repository.toLowerCase()!==(this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value)throw new Error('authority_repository_mismatch');
    const old=this.db.prepare('SELECT value FROM meta WHERE key=?').get(profileKey) as Row;
    if(old){this.mode();if(old.value!==profileSha256)throw new Error('authority_profile_is_fixed');return {configured:true,duplicate:true,profileSha256,ownerAdoptionVerified:false};}
    if(![11,15,16].includes(version))throw new Error('enable_receiver_corrections_before_authority');
    if((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n||(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n)throw new Error('queue_has_active_or_unknown_operation');
    if(this.all('overall_review_dispatched').some(e=>!this.events(e.object).some(x=>x.id>e.id&&['overall_review_result','overall_review_closed_unstarted'].includes(x.kind))))throw new Error('queue_has_active_or_unknown_overall_review');
    if(this.all('publication_intent').some(e=>!this.events(e.object).some(x=>x.id>e.id&&x.kind==='publication_verified'&&x.data.stage===e.data.stage)))throw new Error('queue_has_unresolved_publication');
    if(p.executionKind==='fixture'&&(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE json_extract(result,'$.receiver.executionKind')='native_capture'").get() as Row).n)throw new Error('fixture_authority_requires_non_native_queue');
    this.blob(encoded);this.blob(raw);this.db.prepare('INSERT INTO meta VALUES(?,?)').run(profileKey,profileSha256);
    this.db.exec(guards.map(g=>g.sql).join(';')+';');if(version<12)setQueueFeatureVersion(this.db,12);
    this.event('authority_profile_configured','authority-profile',{profileSha256,originalSha256:hash(raw),executionKind:p.executionKind,expectedOwnerId:p.ownerId,expectedExecutorId:p.executorId,adoptionVerified:false});
    return {configured:true,duplicate:false,profileSha256,ownerAdoptionVerified:false,externalActionSent:false};
  });}
  configuration(){return this.transaction(()=>this.profile());}
  enableGovernedRepair(){return this.transaction(()=>{
    this.profile();if(this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(repairConsumerKey))return {enabled:true,duplicate:true,executionGranted:false};
    if((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n||(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n)throw new Error('queue_has_active_or_unknown_operation');
    const previous=(this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='authority_legacy_native_guard'").get() as Row).sql,next=this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(receiverConsumerKey)?governedReceiverGuard(true):governedRepairGuard;
    this.db.exec('DROP TRIGGER authority_legacy_native_guard;'+next+';');this.db.prepare('INSERT INTO meta VALUES(?,?)').run(repairConsumerKey,hash(governedRepairGuard));this.event('authority_repair_consumer_enabled','authority-profile',{contract:'governed-repair-v1',previousGuardSha256:this.blob(Buffer.from(previous)),guardSha256:this.blob(Buffer.from(next)),executionGranted:false});return {enabled:true,duplicate:false,executionGranted:false};
  });}
  enableGovernedReceiver(){return this.transaction(()=>{
    this.profile();if(this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(receiverConsumerKey))return {enabled:true,duplicate:true,executionGranted:false};
    if(this.db.prepare('SELECT 1 FROM claims').get()||this.db.prepare("SELECT 1 FROM operations WHERE status!='complete'").get())throw new Error('queue_has_active_or_unknown_operation');
    const previous=(this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='authority_legacy_native_guard'").get() as Row).sql,next=governedReceiverGuard(Boolean(this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(repairConsumerKey)));
    this.db.exec('DROP TRIGGER authority_legacy_native_guard;'+next+';'+receiverResourceGuard+';');this.db.prepare('INSERT INTO meta VALUES(?,?)').run(receiverConsumerKey,hash(admittedReceiver));this.event('authority_receiver_consumer_enabled','authority-profile',{contract:'governed-receiver-v1',previousGuardSha256:this.blob(Buffer.from(previous)),guardSha256:this.blob(Buffer.from(next)),executionGranted:false});return {enabled:true,duplicate:false,executionGranted:false};
  });}
  enableGovernedPublication(){return this.transaction(()=>{
    this.profile();if(this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(publicationConsumerKey)){installPublicationGuards(this.db);return {enabled:true,duplicate:true,executionGranted:false};}
    if(this.db.prepare('SELECT 1 FROM claims').get()||this.db.prepare("SELECT 1 FROM operations WHERE status!='complete'").get())throw new Error('queue_has_active_or_unknown_operation');
    const previous=(this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='authority_legacy_effect_guard'").get() as Row).sql;
    if(previous!==legacyPublicationEffectGuard)throw new Error('publication_legacy_guard_changed');
    this.db.exec('DROP TRIGGER authority_legacy_effect_guard;'+governedPublicationEffectGuard+';');installPublicationGuards(this.db);this.db.prepare('INSERT INTO meta VALUES(?,?)').run(publicationConsumerKey,hash(governedPublicationEffectGuard));
    this.event('authority_publication_consumer_enabled','authority-profile',{contract:'governed-publication-v1',previousGuardSha256:this.blob(Buffer.from(previous)),guardSha256:this.blob(Buffer.from(governedPublicationEffectGuard)),executionGranted:false});return {enabled:true,duplicate:false,executionGranted:false};
  });}
  prepare(requestId:string,raw:Buffer){return this.transaction(()=>{
    const {profile,profileSha256}=this.profile();
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(requestId)||raw.length>128*1024)throw new Error('owner_proposal_request_invalid');
    const decoded=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw)),object='authority-request:'+requestId,old=this.events(object,'authority_proposal_prepared')[0];
    if(old){const prepared=this.prepared(old.data.proposalSha256);if(canonical(prepared.proposal)!==canonical(decoded))throw new Error('owner_request_id_changed');return {...old.data,prepared,ownerComment:ownerDecisionText(old.data.proposalSha256),duplicate:true,externalActionSent:false};}
    const proposal=parseOwnerProposal(decoded,profile,Date.now());
    this.proposalContext(proposal);
    const prepared:PreparedProposal={schemaVersion:1,requestId,profileSha256,repository:profile.repository,issue:profile.issue,createdAt:now(),proposal};
    const proposalSha256=this.blob(Buffer.from(canonical(prepared))),entry={requestId,proposalSha256,originalSha256:this.blob(raw),kind:proposal.kind,...(proposal.kind==='delivery_outcome'?{batchSha256:proposal.batchSha256}:{})};
    this.event('authority_proposal_prepared',object,entry);return {...entry,prepared,ownerComment:ownerDecisionText(proposalSha256),duplicate:false,externalActionSent:false};
  });}
  private prepared(sha:string):PreparedProposal{
    if(!isAuthorityDigest(sha)||!this.all('authority_proposal_prepared').some(e=>e.data.proposalSha256===sha))throw new Error('fixed_owner_proposal_missing');
    const p=JSON.parse(this.bytes(sha).toString()) as PreparedProposal,{profile,profileSha256}=this.profile();
    if(p.profileSha256!==profileSha256)throw new Error('owner_proposal_profile_mismatch');
    parseOwnerProposal(p.proposal,profile,Date.parse(p.createdAt));return p;
  }
  proposal(sha:string){return this.transaction(()=>this.prepared(sha));}
  forScope(scopeId:string){return this.transaction(()=>{
    const {profile}=this.profile(),current=this.currentScope(scopeId),requests=this.all('authority_proposal_prepared').flatMap(e=>{
      const p=this.prepared(e.data.proposalSha256),proposal=p.proposal;
      const adoption='adoption' in proposal?this.prepared(proposal.adoption).proposal:proposal.kind==='revoke'?this.decision(proposal.decision).proposal:null;
      const scope=proposal.kind==='adopt_scope'?proposal.scopeId:adoption?.kind==='adopt_scope'?adoption.scopeId:adoption&&'adoption' in adoption?this.adoption(adoption.adoption,false).proposal.scopeId:null;
      if(scope!==scopeId||proposal.kind==='delivery_outcome')return [];
      const applied=this.events('authority-decision:'+e.data.proposalSha256,'authority_decision_applied')[0]?.data;
      return [{proposalSha256:e.data.proposalSha256,proposal,createdAt:p.createdAt,applied:Boolean(applied),sourceUrl:applied?.source.sourceUrl??null,revoked:this.revoked(e.data.proposalSha256),ownerComment:ownerDecisionText(e.data.proposalSha256)}];
    });
    return {scopeId,currentAdoption:current?.proposalSha256??null,currentScope:current?this.prepared(current.proposalSha256).proposal:null,requests,repository:profile.repository,issue:profile.issue,executionKind:profile.executionKind,ownerDistinctFromExecutor:profile.ownerId!==profile.executorId,sourceFreshness:'recorded_only_recheck_before_action',permissionsGranted:false};
  });}
  inspectRecordedDecision(sha:string){return this.transaction(()=>{
    const {profile}=this.profile(),d=this.decision(sha),{originalCommentSha256,originalEditorSha256,...saved}=d.source;
    const checked=inspectStoredOwnerSource(profile,sha,saved.commentId,this.bytes(originalEditorSha256),this.bytes(originalCommentSha256),saved.readAt);
    if(d.proposalSha256!==sha||d.kind!==d.proposal.kind||d.executionKind!==profile.executionKind||canonical(saved)!==canonical(checked.source))throw new Error('authority_recorded_source_index_changed');
    return {proposalSha256:sha,proposal:d.proposal,source:checked.source,executionKind:d.executionKind,originalBytesVerified:true,freshForAction:false};
  });}
  private decision(sha:string){const e=this.events('authority-decision:'+sha,'authority_decision_applied')[0];if(!e)throw new Error('verified_owner_decision_missing');return {...e.data,proposal:this.prepared(sha).proposal};}
  private revoked(sha:string){return this.all('authority_revoked').some(e=>e.data.decision===sha);}
  private currentScope(id:string){return this.events('authority-scope:'+id,'authority_scope_adopted').at(-1)?.data??null;}
  private adoption(sha:string,current=true){const d=this.decision(sha);if(d.proposal.kind!=='adopt_scope'||this.revoked(sha)||(current&&this.currentScope(d.proposal.scopeId)?.proposalSha256!==sha))throw new Error('current_adopted_scope_required');return d;}
  private proposalContext(p:OwnerProposal){
    if(p.kind==='adopt_scope'){
      const old=this.currentScope(p.scopeId);
      if((old?.proposalSha256??null)!==p.previousAdoption)throw new Error('owner_scope_previous_version_changed');
      if(this.events('authority-scope:'+p.scopeId,'authority_scope_adopted').some(e=>e.data.scopeVersion===p.scopeVersion))throw new Error('owner_scope_new_version_required');
    }else if(p.kind==='revoke'){this.decision(p.decision);}
    else{
      const a=this.adoption(p.adoption).proposal;
      if(p.kind==='confirm_action'&&(p.request.scopeId!==a.scopeId||p.request.scopeVersion!==a.scopeVersion||p.request.scopeBodySha256!==scopeBodyHash(a.body)))throw new Error('owner_request_scope_mismatch');
      if(p.kind==='delivery_outcome'){if(!this.deliveryOutcomes)throw new Error('delivery_outcome_consumer_required');this.deliveryOutcomes.check(p);}
    }
  }
  private observe(value:OwnerObservation){
    const {profile,profileSha256}=this.profile();requireOwnerObservation(value,profile,profileSha256,Date.now());
    const object='authority-comment:'+value.commentId,previous=this.events(object,'authority_source_observed').at(-1)?.data;
    if(previous&&(Date.parse(value.updatedAt)<Date.parse(previous.updatedAt)||Date.parse(value.readAt)<Date.parse(previous.readAt)||value.updatedAt===previous.updatedAt&&value.sourceBodySha256!==previous.sourceBodySha256))throw new Error('owner_source_order_conflict');
    const {commentRaw,graphRaw,...data}=value;
    const entry={...data,originalCommentSha256:this.blob(commentRaw),originalEditorSha256:this.blob(graphRaw)};
    if(!previous||canonical(entry)!==canonical(previous))this.event('authority_source_observed',object,entry);return entry;
  }
  apply(proposalSha256:string,observation:OwnerObservation,dependencyObservations:OwnerObservation[]=[]){return this.transaction(()=>{
    const prepared=this.prepared(proposalSha256);
    if(observation.proposalSha256!==proposalSha256||Date.parse(observation.createdAt)<Date.parse(prepared.createdAt)-60000)throw new Error('owner_source_proposal_mismatch');
    const source=this.observe(observation),object='authority-decision:'+proposalSha256,old=this.events(object,'authority_decision_applied')[0];
    if(old){if(old.data.source.commentId!==observation.commentId||old.data.source.semanticSha256!==observation.semanticSha256)throw new Error('owner_decision_source_is_fixed');return {...old.data,duplicate:true,externalActionSent:false};}
    const p=prepared.proposal;
    // Expiry is validated again at the actual adoption boundary, never extended.
    parseOwnerProposal(p,this.profile().profile,Date.now());this.proposalContext(p);
    if(p.kind==='delivery_outcome')this.freshDecision(p.adoption,dependencyObservations);
    const control=p.kind==='control'?{kind:p.control,state:p.state}:p.kind==='delivery_outcome'&&p.outcome==='stopped'?{kind:'investment',state:'stopped'}:null;
    if(control&&'adoption' in p){
      const scope=this.adoption(p.adoption).proposal.scopeId,previous=this.events(scope,'authority_control_applied').filter(e=>e.data.control===control.kind).at(-1)?.data;
      if(previous&&(Date.parse(source.updatedAt)<Date.parse(previous.sourceUpdatedAt)||source.updatedAt===previous.sourceUpdatedAt&&source.commentId<=previous.sourceCommentId))throw new Error('owner_control_source_order_conflict');
    }
    const record={proposalSha256,kind:p.kind,source,executionKind:source.executionKind};this.event('authority_decision_applied',object,record);
    if(p.kind==='adopt_scope')this.event('authority_scope_adopted','authority-scope:'+p.scopeId,{proposalSha256,scopeId:p.scopeId,scopeVersion:p.scopeVersion,scopeBodySha256:scopeBodyHash(p.body),previousAdoption:p.previousAdoption,sourceUrl:source.sourceUrl});
    if(p.kind==='revoke')this.event('authority_revoked','authority-decision:'+p.decision,{decision:p.decision,revocation:proposalSha256,existingOperationsPreserved:true});
    if(p.kind==='delivery_outcome')this.deliveryOutcomes!.record(proposalSha256);
    if(control&&'adoption' in p){
      const scope=this.adoption(p.adoption).proposal.scopeId,prior=this.db.prepare('SELECT revision FROM controls WHERE scope=? AND kind=?').get(scope,control.kind) as Row|undefined,revision=(prior?.revision??0)+1,at=now();
      this.event('authority_control_applied',scope,{proposalSha256,adoption:p.adoption,control:control.kind,state:control.state,revision,sourceUpdatedAt:source.updatedAt,sourceCommentId:source.commentId});
      this.db.prepare('INSERT INTO controls VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,kind) DO UPDATE SET stopped=excluded.stopped,revision=excluded.revision,source=excluded.source,requested_at=excluded.requested_at,effective_at=excluded.effective_at').run(scope,control.kind,control.state==='stopped'?1:0,revision,source.sourceUrl,source.updatedAt,at);
    }
    return {...record,duplicate:false,externalActionSent:false};
  });}
  private freshDecision(sha:string,observations:OwnerObservation[]){
    const d=this.decision(sha);if(this.revoked(sha))throw new Error('owner_decision_revoked');
    const values=observations.filter(o=>o.proposalSha256===sha&&o.commentId===d.source.commentId);
    if(values.length!==1)throw new Error('fresh_exact_owner_source_required');
    const source=this.observe(values[0]!);
    if(source.semanticSha256!==d.source.semanticSha256)throw new Error('owner_decision_source_changed');return d;
  }
  private check(request:ActionRequest,role:AuthorityRole,authorization:string,observations:OwnerObservation[]){
    const {profile}=this.profile();parseActionRequest(request);
    if(!roleCanRequest(role,request.action))throw new Error('trusted_role_cannot_request_action');
    if(request.repository.toLowerCase()!==profile.repository.toLowerCase())throw new Error('authority_repository_mismatch');
    const d=this.freshDecision(authorization,observations),p=d.proposal;
    if(!['confirm_action','delegate'].includes(p.kind))throw new Error('owner_action_authorization_required');
    if(Date.parse(p.expiresAt)<=Date.now())throw new Error('owner_authorization_expired');
    const a=this.adoption(p.adoption),scope=a.proposal;this.freshDecision(p.adoption,observations);
    if(request.scopeId!==scope.scopeId||request.scopeVersion!==scope.scopeVersion||request.scopeBodySha256!==scopeBodyHash(scope.body))throw new Error('owner_request_scope_mismatch');
    if(p.kind==='confirm_action'&&(role!==p.performerRole||actionHash(request)!==actionHash(p.request)))throw new Error('owner_confirmation_exact_action_mismatch');
    if(p.kind==='delegate'&&(!p.roles.includes(role)||!p.targets.includes(request.target)||!p.actions.includes(request.action)||request.paths.some(x=>!p.paths.includes(x))||request.resourceRefs.some(x=>!p.resourceRefs.includes(x))))throw new Error('owner_delegation_boundary_mismatch');
    if(request.action==='implement'&&!request.paths.length)throw new Error('implementation_paths_required');
    const stops=this.db.prepare('SELECT kind FROM controls WHERE scope=? AND stopped=1').all(scope.scopeId) as Row[];
    if(stops.some(s=>s.kind==='investment'||s.kind==='implementation'&&request.action==='implement'||s.kind==='merge'&&request.action==='merge'))throw new Error('owner_action_stopped');
    let binding:Row|null=null;
    if(request.item!==null){
      binding=this.currentItem(request.item);const c=binding.candidate,context=binding.context;
      if(!binding.current||c.repository.toLowerCase()!==request.repository.toLowerCase()||c.targetRef!==request.target||c.H!==request.candidate?.H||c.B!==request.candidate?.B||(binding.subjectSha256??null)!==request.candidate?.subjectSha256||context.scope.id!==scope.scopeId||context.scope.version!==scope.scopeVersion)throw new Error('authority_current_candidate_or_scope_mismatch');
      // Coordination can record how to unblock an exact candidate. It grants
      // no implementation/receive/merge permission while prerequisites wait.
      if(binding.prerequisites.length&&request.action!=='coordinate')throw new Error('authority_prerequisites_unmet');
    }
    return {authorization,adoption:p.adoption,mode:p.kind==='delegate'?'delegated':'per_action',role,request,requestSha256:actionHash(request),profileSha256:d.source.profileSha256,executionKind:profile.executionKind,binding,checkedAt:now()};
  }
  checkAction(request:ActionRequest,role:AuthorityRole,authorization:string,observations:OwnerObservation[]){return this.transaction(()=>{
    const checked=this.check(request,role,authorization,observations);
    if(checked.mode==='per_action'&&this.all('authority_action_reserved').some(e=>e.data.authorization===authorization))throw new Error('owner_confirmation_already_reserved');
    return {...checked,authorityCheck:'passed',consumerActionAvailable:false,externalActionSent:false};
  });}
  /** Reserve the exact permission before a future consumer binds its existing
   * operation. Reentry never dispatches or returns a new one-shot permission. */
  reserveAction(requestId:string,request:ActionRequest,role:AuthorityRole,authorization:string,observations:OwnerObservation[]){return this.transaction(()=>{
    this.profile();if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(requestId))throw new Error('authority_action_request_id_invalid');parseActionRequest(request);
    if(request.action==='test'&&request.payloadSha256)installRecompositionTestGuards(this.db);
    if(request.action==='publish')installPublicationGuards(this.db);
    const object='authority-intent:'+requestId,old=this.events(object,'authority_action_reserved')[0];
    if(old){if(old.data.requestSha256!==actionHash(request)||old.data.role!==role||old.data.authorization!==authorization)throw new Error('authority_action_request_id_changed');return {...old.data,duplicate:true,next:'read_original_execution_before_any_dispatch',externalActionSent:false};}
    const checked=this.check(request,role,authorization,observations);
    if(checked.mode==='per_action'&&this.all('authority_action_reserved').some(e=>e.data.authorization===authorization))throw new Error('owner_confirmation_already_reserved');
    const entry={...checked,requestId,state:'reserved_execution_unproven',consumerActionAvailable:false};this.event('authority_action_reserved',object,entry);return {...entry,duplicate:false,externalActionSent:false};
  });}
  reservedAction(requestId:string){return this.transaction(()=>{
    this.profile();const old=this.events('authority-intent:'+requestId,'authority_action_reserved')[0];if(!old)throw new Error('authority_original_intent_missing');return old.data;
  });}
  refreshReservedAction(requestId:string,observations:OwnerObservation[]){return this.transaction(()=>{
    this.profile();const old=this.events('authority-intent:'+requestId,'authority_action_reserved')[0];if(!old)throw new Error('authority_original_intent_missing');
    // Rechecking an original reservation is not a second reservation. Consumers
    // still bind the original operation and cannot infer an unknown was unsent.
    const current=this.check(old.data.request,old.data.role,old.data.authorization,observations);
    if(current.binding?.packet!==old.data.binding?.packet||current.binding?.fingerprint!==old.data.binding?.fingerprint)throw new Error('authority_reserved_material_changed');
    return {...current,requestId,state:old.data.state};
  });}
  adoptionBaseline(adoption:string,observations:OwnerObservation[]){return this.transaction(()=>{
    const a=this.adoption(adoption);this.freshDecision(adoption,observations);
    return {adoption,scopeId:a.proposal.scopeId,scopeVersion:a.proposal.scopeVersion,scopeBodySha256:scopeBodyHash(a.proposal.body),body:a.proposal.body,source:a.source.sourceUrl,executionKind:a.source.executionKind,verifiedSource:true,productAcceptance:false};
  });}
  acceptedBaseline(baseline:string,material:Array<{name:string;sha256:string}>,observations:OwnerObservation[]){return this.transaction(()=>{
    const d=this.freshDecision(baseline,observations);if(d.proposal.kind!=='accept_baseline')throw new Error('explicit_baseline_acceptance_required');
    const a=this.adoption(d.proposal.adoption,false);this.freshDecision(d.proposal.adoption,observations);
    const expected=Object.values(d.proposal.material).sort((a:any,b:any)=>a.name.localeCompare(b.name));
    if(canonical([...material].sort((a,b)=>a.name.localeCompare(b.name)))!==canonical(expected))throw new Error('accepted_baseline_material_mismatch');
    return {decision:baseline,adoption:d.proposal.adoption,scopeId:a.proposal.scopeId,scopeVersion:a.proposal.scopeVersion,scopeBodySha256:scopeBodyHash(a.proposal.body),material:d.proposal.material,source:d.source.sourceUrl,executionKind:d.source.executionKind,verifiedSource:true,technicalPass:false,mergeApproved:false};
  });}
  sourceRequests(authorization:string){return this.transaction(()=>{const d=this.decision(authorization),refs=[{proposalSha256:authorization,commentId:d.source.commentId}];if('adoption' in d.proposal){const a=this.decision(d.proposal.adoption);refs.push({proposalSha256:d.proposal.adoption,commentId:a.source.commentId});}return refs;});}
  status(){return this.transaction(()=>{const {profile,profileSha256}=this.profile();return {profileSha256,executionKind:profile.executionKind,expectedOwnerId:profile.ownerId,expectedExecutorId:profile.executorId,scopes:this.all('authority_scope_adopted').map(e=>e.data),revocations:this.all('authority_revoked').map(e=>e.data),controls:this.all('authority_control_applied').map(e=>e.data),intents:this.all('authority_action_reserved').map(e=>e.data),externalActionSent:false,consumerActionAvailable:false,sourceFreshness:'recheck_exact_sources_before_action',unseenExternalRevocations:'not_observed_until_import_or_source_edit'};});}
}
