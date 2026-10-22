import {parsePublicationPlan,publicationAuthorityPayloadSha} from './publication-contract.js';
import {publicationGuardsCurrent,installPublicationResultGuard,publicationConsumerKey} from './publication-guards.js';
import {requirePublicationProcessEnded} from './publication-process.js';
import {requirePublicationDispatchCapture,type PublicationDispatchCapture} from './publication-dispatch-capture.js';
import {PublicationReturns} from './publication-return-store.js';
import {parseMemberRefutationRequest,type MemberRefutationRequest} from './member-refutation-contract.js';
import {verifyMemberRefutationOriginals} from './member-refutation-originals.js';
import {installMemberRefutationOriginalsGuard} from './member-refutation-format.js';
import {IntegrationRecords,type IntegrationSource} from './integration-store.js';
import {parseObservedCandidateRequest,integrationCandidateRequest,type ObservedCandidateRequest} from './observed-candidate-contract.js';
import {requireObservedCandidate,type ObservedCandidateBinding,type ObservedCandidateCapture} from './observed-candidate-source.js';
import {protectObservedCandidate} from './integration-format.js';
import {queueFeatureVersion,queueFormatVersion,setQueueFeatureVersion,enableIntegrationFormat,enableMemberRepairFormat,enableMemberRecompositionFormat,enableMemberRefutationFormat} from './queue-format.js';
import {parseIntegrationCandidate} from './integration-contract.js';
import {IntegrationMemberRecords,type IntegrationMemberSource} from './integration-member-store.js';
import {memberReturnReference,type IntegrationMemberReturn} from './integration-member-contract.js';
import {MemberRecompositionRecords} from './member-recomposition-store.js';
import type {RecompositionLink,MemberRecompositionPlan} from './member-recomposition-contract.js';
import {RecompositionTestRecords,type RecompositionTestSource} from './recomposition-test-store.js';
import { DatabaseSync } from 'node:sqlite';
import {withManagedRepairCapture,type ManagedRepairCapture} from './workspace-handoff-originals.js';
import type {RepairContinuation} from './repair-continuation-contract.js';
import { lstat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, privateDirectory } from './snapshot.js';
import { repoPattern, now } from './contract.js';
import { candidateKey, targetKey } from './queue-evidence.js';
import type { Packet, QueueContext } from './queue-evidence.js';
import type { Candidate } from './contract.js';
import { canonical } from './comparison.js';
import { ReviewRecords } from './review-record-store.js';
import { AuthorityRecords } from './authority-store.js';
import type {OwnerObservation} from './authority-source.js';
import { ResourceRecords, type ResourceOutcome } from './resource-store.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';
import { MergeRecords } from './merge-store.js';
import { EventRecords } from './event-store.js';
import { SessionRecords } from './session-store.js';
import { MessageRecords } from './message-store.js';
import { CoordinationRecords } from './coordination-store.js';
import { MessageResourceRecords } from './message-resource-store.js';
import { TaskCandidateLinks } from './task-link-store.js';
import { observeTaskLinkSource } from './task-link-source.js';
import { TaskInbox } from './task-inbox.js';
import { TaskRecords,taskOperationGuard } from './task-store.js';
import { observeTaskWorkspace } from './task-source.js';
import { CollaborationView } from './collaboration-view.js';
import {LocalScopeControls} from './scope-controls.js';
import {DeliveryRecords} from './delivery-store.js';
import {DeliveryValidationRecords} from './delivery-validation-store.js';
import {DeliveryAssessmentRecords} from './delivery-assessment-store.js';
import { inspectRolePrompt } from './role-prompts.js';
import { currentEventSource,effectiveEventCandidate,storedEventMaterial } from './event-gates.js';
import { rankQueue,parseQueuePreference,type RankItem,type SelectionHistory } from './event-contract.js';
import { composeSubject, currentMembers, type Composition } from './composition.js';

type Row = Record<string, any>;
const parse = (row: Row | undefined, key: string): any => row ? JSON.parse(row[key]) : undefined;
const supplementGuard = `CREATE TRIGGER receiver_packet_material_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND (json_extract(NEW.result,'$.receiver.contractVersion') IS NOT 6 OR EXISTS(SELECT 1 FROM packets WHERE id=NEW.packet AND fingerprint IS NOT json_extract(NEW.result,'$.receiver.packetFingerprint')))
BEGIN SELECT RAISE(ABORT,'receiver_packet_material_binding_required'); END`;
const supplementLineageGuard = `CREATE TRIGGER receiver_supplement_lineage_guard BEFORE INSERT ON packets
WHEN json_type(NEW.summary,'$.supplement') IS NOT 'object' AND EXISTS(SELECT 1 FROM items JOIN packets ON packets.id=items.current_packet WHERE items.id=NEW.item AND json_type(packets.summary,'$.supplement')='object')
BEGIN SELECT RAISE(ABORT,'supplement_lineage_must_be_retained'); END`;
const compositionGuard = `CREATE TRIGGER composition_receiver_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND EXISTS(SELECT 1 FROM packets WHERE id=NEW.packet AND json_type(summary,'$.composition')='object' AND json_extract(summary,'$.composition.sha256') IS NOT json_extract(NEW.result,'$.receiver.subjectSha256'))
BEGIN SELECT RAISE(ABORT,'composition_receiver_subject_required'); END`;
const correctionGuard = `CREATE TRIGGER receiver_correction_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND EXISTS(SELECT 1 FROM packets WHERE id=NEW.packet AND json_type(summary,'$.correction')='object' AND json_extract(summary,'$.correction.sha256') IS NOT json_extract(NEW.result,'$.receiver.correctionSha256'))
BEGIN SELECT RAISE(ABORT,'receiver_correction_input_required'); END`;
const correctionLineageGuard = `CREATE TRIGGER receiver_correction_lineage_guard BEFORE INSERT ON packets
WHEN json_type(NEW.summary,'$.correction') IS NOT 'object' AND EXISTS(SELECT 1 FROM items JOIN packets ON packets.id=items.current_packet WHERE items.id=NEW.item AND json_type(packets.summary,'$.correction')='object')
BEGIN SELECT RAISE(ABORT,'receiver_correction_lineage_required'); END`;
export function materialIdentity(bytes: Buffer): string {
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  try { return hash('json:' + canonical(JSON.parse(text))); } catch { return hash('text:' + text); }
}
// A pre-opened older receiver cannot send the dependent stage without its
// bound upstream judgment. Same database/operations, no competing scheduler.
const pairPlanGuard = `CREATE TRIGGER pair_receiver_plan_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND (OLD.status!='receiving' OR (json_extract(OLD.result,'$.receiver.phase')='reserved' AND json_extract(NEW.result,'$.receiver.phase')='dispatch_registered'))
AND EXISTS(SELECT 1 FROM events p WHERE p.kind='pair_registered' AND (json_extract(p.data,'$.first.item')=NEW.item OR json_extract(p.data,'$.second.item')=NEW.item))
AND NOT EXISTS(SELECT 1 FROM events p WHERE p.kind='pair_registered'
 AND ((json_extract(p.data,'$.first.item')=NEW.item AND json_extract(p.data,'$.first.planSha256')=json_extract(NEW.result,'$.receiver.planSha256') AND json_extract(p.data,'$.first.packet')=NEW.packet)
 OR (json_extract(p.data,'$.second.item')=NEW.item AND json_extract(p.data,'$.second.planSha256')=json_extract(NEW.result,'$.receiver.planSha256') AND json_extract(p.data,'$.second.packet')=NEW.packet)))
BEGIN SELECT RAISE(ABORT,'paired_receiver_plan_changed'); END`;
const pairGuard = `CREATE TRIGGER pair_receiver_stage_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND (OLD.status!='receiving' OR (json_extract(OLD.result,'$.receiver.phase')='reserved' AND json_extract(NEW.result,'$.receiver.phase')='dispatch_registered'))
AND EXISTS(SELECT 1 FROM events p WHERE p.kind='pair_registered' AND json_extract(p.data,'$.second.item')=NEW.item)
AND NOT EXISTS(
 SELECT 1 FROM events p JOIN items ai ON ai.id=json_extract(p.data,'$.first.item')
 JOIN items bi ON bi.id=json_extract(p.data,'$.second.item')
 JOIN operations a ON a.item=ai.id AND a.packet=json_extract(p.data,'$.first.packet')
 WHERE p.kind='pair_registered' AND bi.id=NEW.item
 AND ai.current_packet=a.packet AND bi.current_packet=NEW.packet AND NEW.packet=json_extract(p.data,'$.second.packet')
 AND ai.observation_conflict=0 AND bi.observation_conflict=0 AND a.status='complete'
 AND json_extract(a.result,'$.receiver.planSha256')=json_extract(p.data,'$.first.planSha256')
 AND json_extract(a.result,'$.receiver.phase')='returned'
 AND json_extract(a.result,'$.receiver.judgment.verdict')='ACCEPT_WITHIN_SCOPE'
 AND json_extract(NEW.result,'$.receiver.prerequisite.operation')=a.id
 AND json_extract(NEW.result,'$.receiver.prerequisite.bindingHash')=json_extract(a.result,'$.receiver.bindingHash')
 AND json_extract(NEW.result,'$.receiver.prerequisite.judgment')=json_extract(a.result,'$.receiver.judgment')
)
BEGIN SELECT RAISE(ABORT,'paired_reception_stage_blocked'); END`;
const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE blobs(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE items(id TEXT PRIMARY KEY, candidate TEXT NOT NULL, context TEXT NOT NULL, current_packet INTEGER, created_at TEXT NOT NULL, latest_observation TEXT, latest_source_observation TEXT, observation_conflict INTEGER NOT NULL DEFAULT 0);
CREATE TABLE packets(id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL REFERENCES items(id), fingerprint TEXT NOT NULL, manifest_hash TEXT NOT NULL, report_hash TEXT NOT NULL, context_hash TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE observations(item TEXT NOT NULL, fingerprint TEXT NOT NULL, manifest_hash TEXT NOT NULL, report_hash TEXT NOT NULL, context_hash TEXT NOT NULL, observed_at TEXT NOT NULL, UNIQUE(item,manifest_hash,report_hash,context_hash));
CREATE TABLE operations(id TEXT PRIMARY KEY, item TEXT NOT NULL REFERENCES items(id), packet INTEGER NOT NULL UNIQUE REFERENCES packets(id), target TEXT NOT NULL, generation INTEGER NOT NULL, run_ref TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, result TEXT);
CREATE TABLE claims(target TEXT PRIMARY KEY, operation TEXT NOT NULL UNIQUE REFERENCES operations(id), generation INTEGER NOT NULL);
CREATE TABLE controls(scope TEXT NOT NULL, kind TEXT NOT NULL, stopped INTEGER NOT NULL, revision INTEGER NOT NULL, source TEXT NOT NULL, requested_at TEXT NOT NULL, effective_at TEXT NOT NULL, PRIMARY KEY(scope,kind));
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, object TEXT NOT NULL, data TEXT NOT NULL, observed_at TEXT NOT NULL);
PRAGMA user_version=3;
`;

export class QueueStore {
  private continuationCapture:ManagedRepairCapture|undefined;
  async withRepairContinuation<T>(reference:RepairContinuation|undefined,action:()=>Promise<T>):Promise<T>{
    if(!reference)return action();
    if(this.continuationCapture)throw new Error('repair_continuation_already_active');
    return withManagedRepairCapture({store:this.directory,operation:reference.operation,bindingHash:reference.bindingHash},()=>this.managedRepairOriginal(reference.operation),async capture=>{
      this.continuationCapture=capture;try{return await action();}finally{this.continuationCapture=undefined;}
    });
  }
  private publicationEffectCapabilities=new Map<string,{operation:string;stage:string}>();
  private activePublicationEffect:{operation:string;stage:string;directory:string;binding:Row}|null=null;
  private constructor(readonly directory: string, private db: DatabaseSync) {}
  static async create(directory: string, repository: string, seats = 2): Promise<QueueStore> {
    if (!repoPattern.test(repository) || !Number.isInteger(seats) || seats < 1 || seats > 8) throw new Error('invalid_queue_scope');
    await privateDirectory(directory, true);
    const path = join(directory, 'queue.sqlite'); await writeFile(path, '', { flag: 'wx', mode: 0o600 });
    const db = new DatabaseSync(path); const q = new QueueStore(directory, db);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      q.transaction(() => { db.exec(schema); db.prepare('INSERT INTO meta VALUES (?,?)').run('repository', repository.toLowerCase()); db.prepare('INSERT INTO meta VALUES (?,?)').run('seats', String(seats)); db.prepare('INSERT INTO meta VALUES (?,?)').run('mode', 'shadow'); });
      await chmod(path, 0o600); return q;
    } catch (e) { db.close(); throw e; }
  }
  static async open(directory: string): Promise<QueueStore> {
    return this.connect(directory, false);
  }
  static async observe(directory: string, receiverMetadataFor: readonly string[] = [], invalidOutputFor: readonly string[] = [], collaborationFor: readonly string[] = []): Promise<Row> {
    const q = await this.connect(directory, true);
    try { return q.status(receiverMetadataFor,invalidOutputFor,collaborationFor); } finally { q.close(); }
  }
  static async observeMessageReport(directory:string,item:string,run:string,message:string){
    const q=await this.connect(directory,true);try{q.db.exec('BEGIN');return q.collaborationView().messageReport(item,run,message);}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}
  }
  static async observeOwnerTask(directory:string,item:string){
    const q=await this.connect(directory,true);try{q.db.exec('BEGIN');const selected=q.authorityItem(item),a=new AuthorityRecords(q.db,fn=>fn(),id=>q.authorityItem(id));return {...a.forScope(selected.context.scope.id,{item,target:selected.candidate.targetRef}),taskCurrent:selected.current,taskScope:selected.context.scope,target:selected.candidate.targetRef};}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}
  }
  static async observeDeliveries(directory:string,batches:readonly string[]){
    if(!batches.length||batches.length>8||new Set(batches).size!==batches.length)throw new Error('delivery_selection_invalid');
    const q=await this.connect(directory,true);try{q.db.exec('BEGIN');return batches.map(sha=>q.deliveryRecords(fn=>fn()).state(sha));}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}
  }
  static async observeDeliveryValidation(directory:string,id:string){const q=await this.connect(directory,true);try{q.db.exec('BEGIN');return q.deliveryValidationRecords(fn=>fn()).state(id);}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}}
  static async observeDeliveryAssessment(directory:string,id:string,fullReport=false){const q=await this.connect(directory,true);try{q.db.exec('BEGIN');const a=q.deliveryAssessmentRecords(fn=>fn());return fullReport?a.report(id):a.state(id);}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}}
  static async observeTaskDeliveryReport(directory:string,item:string,id:string){const q=await this.connect(directory,true);try{q.db.exec('BEGIN');q.item(item);const report=q.deliveryAssessmentRecords(fn=>fn()).report(id),batch=q.deliveryRecords(fn=>fn()).manifest(report.batchSha256);if(!batch.members.some(m=>m.item===item))throw new Error('delivery_assessment_outside_task');return report;}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}}
  static async observeTaskDeliveries(directory:string,item:string){const q=await this.connect(directory,true);try{q.db.exec('BEGIN');q.item(item);return q.deliveryRecords(fn=>fn()).forItem(item);}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}}
  static async observeDeliveryRequests(directory:string,sha:string):Promise<Row[]>{const q=await this.connect(directory,true);try{
    q.db.exec('BEGIN');const batch=q.deliveryRecords(fn=>fn()).state(sha),a=new AuthorityRecords(q.db,fn=>fn(),id=>q.authorityItem(id)),rows=q.db.prepare("SELECT data FROM events WHERE kind='authority_proposal_prepared' AND json_extract(data,'$.kind')='delivery_outcome' AND (json_extract(data,'$.batchSha256')=? OR json_extract(data,'$.batchSha256') IS NULL) ORDER BY id").all(sha) as Row[];
    if(rows.length>64)throw new Error('delivery_outcome_request_history_limit');return rows.flatMap<Row>(row=>{const ref=JSON.parse(row.data);try{const prepared=a.proposal(ref.proposalSha256),p=prepared.proposal;if(p.kind!=='delivery_outcome'||p.batchSha256!==sha){if(ref.batchSha256===sha)throw new Error('delivery_outcome_preparation_changed');return [];}
      return [{proposalSha256:ref.proposalSha256,available:true,requestId:prepared.requestId,createdAt:prepared.createdAt,repository:prepared.repository,issue:prepared.issue,proposal:p,applied:batch.outcomes.some(o=>o.proposalSha256===ref.proposalSha256),current:batch.currentVersion&&batch.currentMaterials&&batch.scope.currentAdoption&&batch.evidenceSha256===p.evidenceSha256&&batch.latestOutcomeDecision===p.previousOutcome}];
    }catch(e){return [{proposalSha256:ref.proposalSha256,available:false,reason:e instanceof Error?e.message:'delivery_outcome_preparation_unavailable'}];}});
  }finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}}
  private collaborationView(){
    const noAction=()=>{throw new Error('readonly_view_cannot_authorize');},m=new MessageRecords(this.db,fn=>fn(),this.directory,id=>this.authorityItem(id),noAction),r=this.resourceRecords(fn=>fn()),c=this.coordinationRecords(fn=>fn()),mr=this.messageResourceRecords(fn=>fn()),repair=new ReviewRecords(this.db,fn=>fn(),noAction,noAction);
    return new CollaborationView(this.db,{item:id=>this.authorityItem(id),message:run=>m.status(run),messageAssociation:run=>this.taskInboxRecords(fn=>fn()).associationStatus(run),messageClosedUnstarted:run=>this.deliveryAssessmentRecords(fn=>fn()).messageClosedUnstarted(run),coordination:id=>c.status(id),resource:id=>r.status(id),settled:id=>r.settledOutcome(id),messageResource:run=>mr.state(run),repair:id=>repair.state(id)});
  }
  private static async connect(directory: string, readOnly: boolean): Promise<QueueStore> {
    await privateDirectory(directory, false);
    for (const name of ['queue.sqlite', 'queue.sqlite-wal', 'queue.sqlite-shm']) {
      try { const st = await lstat(join(directory, name)); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077)) throw new Error('invalid_queue_storage'); }
      catch (e) { if (name === 'queue.sqlite' || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const db = new DatabaseSync(join(directory, 'queue.sqlite'), { readOnly });
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      if (readOnly) db.exec('PRAGMA query_only=ON;');
      const version = queueFeatureVersion(db);
      if (![3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(version) || (db.prepare("SELECT value FROM meta WHERE key='mode'").get() as Row)?.value !== 'shadow') throw new Error('unsupported_queue_schema_or_mode');
      return new QueueStore(directory, db);
    } catch (e) { db.close(); throw e; }
  }
  close(): void { this.db.close(); }
  enableReceiver(): Row {
    return this.transaction(() => {
      const version = queueFeatureVersion(this.db);
      if ([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(version) && this.receiverGuardsInstalled()) return { receiverEnabled: true, duplicate: true, productionActionAllowed: false };
      if (![3, 4].includes(version) || (this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n || (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n) throw new Error('queue_has_active_or_unknown_operation');
      // Same tables/ledger, explicit format opt-in. Older v3 clients must refuse
      // rather than evaluate and release a claim owned by a native receiver.
      this.db.exec(`
CREATE TRIGGER IF NOT EXISTS receiver_record_guard BEFORE UPDATE ON operations
WHEN json_type(OLD.result,'$.receiver')='object' AND (NEW.packet!=OLD.packet OR json_extract(NEW.result,'$.receiver.bindingHash') IS NOT json_extract(OLD.result,'$.receiver.bindingHash'))
BEGIN SELECT RAISE(ABORT,'receiver_record_is_bound'); END;
CREATE TRIGGER IF NOT EXISTS receiver_claim_guard BEFORE DELETE ON claims
WHEN EXISTS(SELECT 1 FROM operations WHERE id=OLD.operation AND status='receiving')
BEGIN SELECT RAISE(ABORT,'receiver_claim_active'); END;
`);setQueueFeatureVersion(this.db,4);
      this.event('receiver_format_enabled', this.directory, { from: version, to: 4, guardsInstalled: true });
      return { receiverEnabled: true, schemaVersion: 4, productionActionAllowed: false };
    });
  }
  enableSupplements(): Row {
    return this.transaction(() => {
      const version = queueFeatureVersion(this.db);
      if ([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(version) && this.supplementGuardInstalled()) return { supplementsEnabled: true, duplicate: true, productionActionAllowed: false };
      if (![4, 5, 6].includes(version) || !this.receiverGuardsInstalled()) throw new Error('enable_receiver_before_supplements');
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n || (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n) throw new Error('queue_has_active_or_unknown_operation');
      this.db.exec(`DROP TRIGGER IF EXISTS receiver_packet_material_guard; DROP TRIGGER IF EXISTS receiver_supplement_lineage_guard; ${supplementGuard}; ${supplementLineageGuard};`);setQueueFeatureVersion(this.db,6);
      this.event('receiver_supplements_enabled', this.directory, { from: version, to: 6 });
      return { supplementsEnabled: true, schemaVersion: 6, productionActionAllowed: false };
    });
  }
  requireReceiverMode(): void { if (![4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(queueFeatureVersion(this.db))) throw new Error('receiver_mode_not_enabled'); }
  enableCompositions(): Row {
    return this.transaction(()=>{
      const version=queueFeatureVersion(this.db);
      if([10,11,12,13,14,15,16].includes(version)){this.requireCompositionMode();return {enabled:true,duplicate:true,productionActionAllowed:false};}
      if(version!==9)throw new Error('enable_review_records_before_compositions');
      if((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n||(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n)throw new Error('queue_has_active_or_unknown_operation');
      this.db.exec(compositionGuard+';');setQueueFeatureVersion(this.db,10);this.event('composition_format_enabled',this.directory,{from:version,to:10});return {enabled:true,duplicate:false,productionActionAllowed:false};
    });
  }
  private requireCompositionMode(){if(![10,11,12,13,14,15,16].includes(queueFeatureVersion(this.db))||(this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='composition_receiver_guard'").get() as Row)?.sql!==compositionGuard)throw new Error('compositions_not_enabled');}
  enableReceiverCorrections(): Row {
    return this.transaction(() => {
      const version = queueFeatureVersion(this.db);
      if ([11,12,13,14,15,16].includes(version)) { this.requireCorrections(); return { enabled: true, duplicate: true }; }
      if (version !== 10) throw new Error('enable_compositions_before_corrections');
      this.requireCompositionMode();
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n || (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n) throw new Error('queue_has_active_or_unknown_operation');
      if ((this.db.prepare("SELECT COUNT(*) AS n FROM events a WHERE a.kind='overall_review_dispatched' AND NOT EXISTS(SELECT 1 FROM events b WHERE b.object=a.object AND b.id>a.id AND b.kind IN ('overall_review_result','overall_review_closed_unstarted'))").get() as Row).n) throw new Error('queue_has_active_or_unknown_overall_review');
      this.db.exec(correctionGuard + ';' + correctionLineageGuard + ';');setQueueFeatureVersion(this.db,11);
      this.event('receiver_correction_format_enabled', 'receiver-correction', { from: 10, to: 11 }); return { enabled: true, duplicate: false };
    });
  }
  private requireCorrections() {
    if (![11,12,13,14,15,16].includes(queueFeatureVersion(this.db)) || ![['receiver_correction_guard',correctionGuard],['receiver_correction_lineage_guard',correctionLineageGuard]].every(([name,sql]) => (this.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name!) as Row)?.sql === sql)) throw new Error('receiver_corrections_not_enabled');
  }
  enableTasks():Row {
    return this.transaction(()=>{
      const version=queueFeatureVersion(this.db);
      this.requireCorrections();
      if([15,16].includes(version)){if((this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='development_task_operation_guard'").get() as Row)?.sql!==taskOperationGuard)throw new Error('development_task_format_not_enabled');return {enabled:true,duplicate:true,schemaVersion:version};}
      if(![11,12,13,14].includes(version))throw new Error('development_task_requires_current_queue_format');
      this.requireIdleTaskFormat();
      this.db.exec(taskOperationGuard+';');setQueueFeatureVersion(this.db,15);this.event('development_task_format_enabled',this.directory,{from:version,to:15});return {enabled:true,duplicate:false,schemaVersion:15};
    });
  }
  private requireIdleTaskFormat(){
      if(this.db.prepare("SELECT 1 FROM claims").get()||this.db.prepare("SELECT 1 FROM operations WHERE status!='complete'").get())throw new Error('queue_has_active_or_unknown_operation');
      if(this.db.prepare("SELECT 1 FROM events a WHERE a.kind='overall_review_dispatched' AND NOT EXISTS(SELECT 1 FROM events b WHERE b.object=a.object AND b.id>a.id AND b.kind IN ('overall_review_result','overall_review_closed_unstarted'))").get())throw new Error('queue_has_active_or_unknown_overall_review');
      if(this.db.prepare("SELECT 1 FROM events a WHERE a.kind='publication_intent' AND NOT EXISTS(SELECT 1 FROM events b WHERE b.object=a.object AND b.id>a.id AND b.kind='publication_verified' AND json_extract(a.data,'$.stage')=json_extract(b.data,'$.stage'))").get())throw new Error('queue_has_unresolved_publication');
      // Native runtimes are recorded in the same event ledger, not claims.
      const records=new MessageRecords(this.db,fn=>fn(),this.directory,id=>this.authorityItem(id),()=>{throw new Error('format_inspection_cannot_authorize');});
      for(const row of this.db.prepare("SELECT object FROM events WHERE kind='message_registered'").all() as Row[]){const m=records.status(row.object.slice(9));if(m.runtimes.some((r:Row)=>r.started&&(!r.ended||r.captureVerification?.proof.successfulCapture!==true&&r.ended.proof.knownUnstarted!==true))||m.messages.some((x:Row)=>['Unknown','Delivered'].includes(x.state)))throw new Error('queue_has_active_or_unknown_message');}
  }
  enableTaskLinks(){return this.transaction(()=>{
    const version=queueFeatureVersion(this.db);
    if(version===16){this.taskLinkRecords(fn=>fn()).configuration();return {enabled:true,duplicate:true,schemaVersion:16};}
    if(version!==15)throw new Error('enable_development_tasks_before_candidate_links');
    this.requireCorrections();this.requireIdleTaskFormat();
    this.db.prepare('INSERT INTO meta VALUES(?,?)').run('task_candidate_link_contract','exact-original-packets-v1');setQueueFeatureVersion(this.db,16);this.event('task_candidate_link_format_enabled',this.directory,{from:15,to:16});return {enabled:true,duplicate:false,schemaVersion:16};
  });}
  tasks(){return new TaskRecords(this.db,fn=>this.transaction(fn));}
  private taskRecords(){return new TaskRecords(this.db,fn=>fn());}
  taskLinks(){return this.taskLinkRecords(fn=>this.transaction(fn));}
  private taskLinkRecords(transaction:<T>(f:()=>T)=>T){return new TaskCandidateLinks(this.db,transaction,this.taskRecords(),id=>{const item=this.item(id);if(parse(item,'candidate').kind==='development-task')throw new Error('task_link_requires_individual_pr_candidate');const packet=this.packet(item.current_packet),e=this.packetEvidence(packet);return {...this.authorityItem(id),manifestSha256:packet.manifest_hash,verificationSha256:packet.report_hash,collection:e.manifest,verification:e.report};});}
  async refreshTaskLinkSource(id:string){this.taskLinks().configuration();const p=this.tasks().definition(id),source=await observeTaskLinkSource(p);this.transaction(()=>{this.taskRecords().observe(p,source.observation);this.taskLinkRecords(fn=>fn()).observe(source);});return source;}
  taskInbox(){return this.taskInboxRecords(fn=>this.transaction(fn));}
  private taskInboxRecords(transaction:<T>(f:()=>T)=>T){
    const m=new MessageRecords(this.db,fn=>fn(),this.directory,id=>this.authorityItem(id),()=>{throw new Error('task_history_read_cannot_authorize');});
    return new TaskInbox(this.db,transaction,this.directory,this.taskRecords(),run=>{
      const state=m.status(run);let resourcesSettled=!state.plan.resourceBudget;
      if(state.plan.resourceBudget)try{const b=this.messageResourceRecords(fn=>fn()).state(run),r=this.resourceRecords(fn=>fn());resourcesSettled=b.phase==='returned'&&b.resourceRequests.length>0&&b.resourceRequests.every((id:string)=>r.settledOutcome(id));}catch{}
      return {state:{...state,resourcesSettled},inputs:state.plan.participants.flatMap(p=>m.submitted(run,p.id))};
    },(task,link)=>this.taskLinkRecords(fn=>fn()).material(task,link),(task,link)=>{this.taskLinkRecords(fn=>fn()).requireCurrent(task,link);},task=>this.taskLinkRecords(fn=>fn()).state(task),(task,ref)=>this.publicationReturnRecords(fn=>fn()).material(task,ref));
  }

  async refreshMessageTaskSources(run:string){
    const state=this.messages().status(run),ids=[...new Set<string>([...state.plan.participants.map(p=>p.item),...this.taskInboxRecords(fn=>fn()).sourceTasks(run)])];
    for(const id of ids)if(parse(this.item(id),'candidate').kind==='development-task'){if(this.taskLinks().hasSource(id))await this.refreshTaskLinkSource(id);else{const p=this.tasks().definition(id);this.tasks().observe(p,await observeTaskWorkspace(p));}}
  }
  private authorityItem(id:string):Row {
    const item=this.item(id),packet=this.packet(item.current_packet),evidence=this.packetEvidence(packet),summary=this.effectiveSummary(item,packet);
    return {item:id,packet:item.current_packet,fingerprint:packet.fingerprint,candidate:evidence.manifest.candidate,context:evidence.context,subjectSha256:summary.composition?.sha256??null,current:!item.observation_conflict&&this.receiverCandidateCurrent(item),prerequisites:this.prerequisites(item),evidenceComplete:summary.evidenceComplete};
  }
  authority(): AuthorityRecords { return new AuthorityRecords(this.db,fn=>this.transaction(fn),id=>this.authorityItem(id),{check:p=>this.deliveryRecords(fn=>fn()).checkOutcome(p),record:sha=>this.deliveryRecords(fn=>fn()).recordOutcome(sha)}); }
  withOwnerTask<T>(item:string,scopeId:string,target:string,action:(a:AuthorityRecords)=>T):T{return this.transaction(()=>{
    const selected=this.authorityItem(item);if(selected.context.scope.id!==scopeId||selected.candidate.targetRef!==target)throw new Error('owner_control_task_changed');
    return action(new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id)));
  });}
  deliveries(){return this.deliveryRecords(fn=>this.transaction(fn));}
  private deliveryRecords(transaction:<T>(fn:()=>T)=>T):DeliveryRecords{const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id));return new DeliveryRecords(this.db,transaction,id=>this.authorityItem(id),sha=>a.inspectRecordedDecision(sha),sha=>this.deliveryValidationRecords(fn=>fn()).forBatch(sha),(sha,exclude)=>this.deliveryAssessmentRecords(fn=>fn()).forBatch(sha,exclude),members=>this.deliveryMemberReturns(members));}
  private deliveryMemberReturns(members:Row[]){
    return members.flatMap(member=>{
      const packet=this.packet(member.packet),e=this.packetEvidence(packet),summary=parse(packet,'summary'),integration=this.integrationMaterial(packet,false),selected=integration?.source.composition.subject.members??summary.composition?.subject.members??[{candidate:e.manifest.candidate}],returns=this.integrationMemberRecords(fn=>fn()).contextFor(selected,e.context),subject=integration?.source.composition.sha256??summary.composition?.sha256,repairs=subject?this.memberRecompositionRecords(fn=>fn()).forSubject(subject):[];
      return returns.length||repairs.length?[{item:member.item,packet:member.packet,returns,...(repairs.length?{repairs}:{})}]:[];
    });
  }
  deliveryValidations(){return this.deliveryValidationRecords(fn=>this.transaction(fn));}
  private deliveryValidationRecords(transaction:<T>(fn:()=>T)=>T):DeliveryValidationRecords{const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id));return new DeliveryValidationRecords(this.db,transaction,this.deliveryRecords(fn=>fn()),id=>{const item=this.item(id),packet=this.packet(item.current_packet),e=this.packetEvidence(packet);if(e.manifest.candidate.kind==='development-task')throw new Error('delivery_validation_formal_candidate_required');return {...this.authorityItem(id),manifestSha256:packet.manifest_hash,composition:this.effectiveSummary(item,packet).composition};},(id,observations)=>observations===null?a.reservedAction(id):a.refreshReservedAction(id,observations));}
  integrations(){return this.integrationRecords(fn=>this.transaction(fn));}
  private integrationRecords(transaction:<T>(f:()=>T)=>T){const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id));return new IntegrationRecords(this.db,transaction,this.directory,operation=>this.integrationSource(operation),(id,observations)=>observations===null?a.reservedAction(id):a.refreshReservedAction(id,observations));}
  integrationMemberReturns(){return this.integrationMemberRecords(fn=>this.transaction(fn));}
  private integrationMemberRecords(transaction:<T>(fn:()=>T)=>T){return new IntegrationMemberRecords(this.db,transaction,p=>this.integrationMemberSource(p),()=>{enableMemberRecompositionFormat(this.db);});}
  private memberReceptionCurrent(item:string){return !this.integrationMemberRecords(fn=>fn()).hasPendingForItem(item);}
  private integrationApplicability(op:Row,receiver:Row){try{const proof=this.memberRefutationEvidence(this.packet(op.packet),true);if((receiver.memberRefutationSha256??null)!==(proof?.sha256??null))return false;const m=this.integrationMaterial(this.packet(op.packet),true,op.id),empty=hash(canonical([]));return !m||(receiver.memberReturnEvidenceSha256??empty)===m.memberReturnEvidenceSha256&&(receiver.memberRepairEvidenceSha256??empty)===(m.memberRepairEvidenceSha256??empty);}catch{return false;}}
  memberRecompositions(){return this.memberRecompositionRecords(fn=>this.transaction(fn));}
  private memberRecompositionRecords(transaction:<T>(fn:()=>T)=>T){return new MemberRecompositionRecords(this.db,transaction,p=>this.memberRecompositionSource(p));}
  recompositionTests(){return this.recompositionTestRecords(fn=>this.transaction(fn));}
  private recompositionTestRecords(transaction:<T>(fn:()=>T)=>T){const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id));return new RecompositionTestRecords(this.db,transaction,this.directory,(p,m,t,current)=>this.recompositionTestSource(p,m,t,current),(id,observations)=>observations===null?a.reservedAction(id):a.refreshReservedAction(id,observations),()=>this.resourceRecords(fn=>fn()));}
  private recompositionTestSource(p:MemberRecompositionPlan,newManifest:Buffer,testPlan:Buffer,current:boolean):RecompositionTestSource{
    const matches=this.db.prepare("SELECT * FROM operations WHERE json_extract(result,'$.repair.planSha256')=?").all(p.repairPlan.sha256) as Row[];
    if(matches.length!==1)throw new Error('recomposition_test_original_repair_ambiguous');const op=matches[0]!,repair=new ReviewRecords(this.db,fn=>fn(),()=>{throw new Error('recomposition_read_cannot_authorize');},()=>{throw new Error('recomposition_read_cannot_authorize');}).state(op.id).repair;
    const original=this.integrationMemberRecords(fn=>fn()).material(p.memberReturn.id),selected=original.request.member,old=original.proof.integration.source.composition.subject.members,member=original.proof.member,manifest=JSON.parse(newManifest.toString()),c=manifest.candidate;
    if(original.state.requestSha256!==p.memberReturn.requestSha256||original.state.sourceSha256!==p.memberReturn.sourceSha256||canonical(repair.memberReturn)!==canonical(p.memberReturn)||op.status!=='complete'||op.item!==selected.item||op.packet!==selected.packet||repair.phase!=='returned'||!repair.controllerReturned||!['completed','completed_recovered_candidate'].includes(repair.result.status)||!repair.result.actualRepairPerformed||!(repair.counters.actualFileWrites>0)||!['fixture','native_capture'].includes(repair.result.executionKind))throw new Error('recomposition_test_completed_repair_required');
    const repairPlan=JSON.parse(this.blob(repair.planSha256).toString());if(repairPlan.store!==this.directory||repairPlan.operation!==op.id||canonical(repairPlan.memberReturn)!==canonical(p.memberReturn)||hash(newManifest)!==p.newMember.sha256||hash(testPlan)!==p.testPlan.sha256||!c||c.H!==repair.result.after.H||c.H===selected.H||['repository','pr','B','targetRef'].some(k=>c[k]!==old[selected.index].candidate[k]))throw new Error('recomposition_test_fixed_input_mismatch');
    if(current){this.memberRepairSource(op.id,p.memberReturn,true);if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND stopped=1 AND kind IN ('investment','implementation','candidate')").get(member.context.scope.id))throw new Error('member_recomposition_stopped');}
    const previous=this.integrationRecords(fn=>fn()).sourceMaterial(original.request.integration),originals=new Map<string,Buffer>([...original.originals,...previous.originals].map(x=>[x.sha256,x.bytes]));for(const sha of [repair.planSha256,repair.resultSha256,repair.evidenceSha256])originals.set(sha,this.blob(sha));originals.set(p.newMember.sha256,newManifest);originals.set(p.testPlan.sha256,testPlan);
    const contextBytes=Buffer.from(canonical(member.context)),contextSha256=hash(contextBytes);originals.set(contextSha256,contextBytes);
    return {operation:op.id,item:op.item,packet:op.packet,fingerprint:this.packet(op.packet).fingerprint,candidate:member.manifest.candidate,context:member.context,subjectSha256:null,executionKind:repair.result.executionKind,inputManifests:old.map((m:Row,i:number)=>i===selected.index?p.newMember.sha256:m.manifestHash),contextSha256,proof:{memberReturn:p.memberReturn,selectedMember:original.proof.selectedMember,previousIntegration:original.request.integration,repair:{operation:op.id,planSha256:repair.planSha256,bindingHash:repair.bindingHash,resultSha256:repair.resultSha256,evidenceSha256:repair.evidenceSha256},newMemberManifestSha256:p.newMember.sha256,testPlanSha256:p.testPlan.sha256,priorAcceptanceTransferred:false},originals};
  }
  private memberRecompositionSource(p:RecompositionLink){
    const original=this.integrationMemberRecords(fn=>fn()).material(p.memberReturn.id),s=original.state,source=original.proof,repair=new ReviewRecords(this.db,fn=>fn(),()=>{throw new Error('recomposition_read_cannot_authorize');},()=>{throw new Error('recomposition_read_cannot_authorize');}).state(p.repair.operation).repair,item=this.item(p.composition.item),packet=this.packet(p.composition.packet),e=this.packetEvidence(packet),summary=parse(packet,'summary'),composition=summary.composition;
    if(s.requestSha256!==p.memberReturn.requestSha256||s.sourceSha256!==p.memberReturn.sourceSha256||canonical(repair.memberReturn)!==canonical(p.memberReturn)||repair.phase!=='returned'||repair.bindingHash!==p.repair.bindingHash||repair.resultSha256!==p.repair.resultSha256||repair.evidenceSha256!==p.repair.evidenceSha256||!['completed','completed_recovered_candidate'].includes(repair.result.status)||!repair.result.actualRepairPerformed||!(repair.counters.actualFileWrites>0))throw new Error('member_recomposition_completed_repair_required');
    const selected=original.request.member,previous=source.integration.source.composition.subject.members,next=composition?.subject.members,candidate=repair.result.sourceCandidate;
    if(candidate.H!==selected.H||candidate.B!==selected.B||candidate.repository!==source.member.manifest.candidate.repository||candidate.pr!==source.member.manifest.candidate.pr||candidate.target!==source.member.manifest.candidate.targetRef||repair.result.after.H===selected.H||packet.item!==item.id||item.current_packet!==packet.id||packet.fingerprint!==p.composition.fingerprint||item.observation_conflict||!this.receiverCandidateCurrent(item)||!composition||composition.sha256!==p.composition.subjectSha256||canonical(e.context)!==canonical(source.member.context)||next.length!==previous.length||summary.gaps.some((g:string)=>g!=='sample_failure_or_incomplete_comparison')||!e.report.executionComplete)throw new Error('member_recomposition_exact_candidate_required');
    for(const [i,m] of next.entries()){const old=previous[i];if(i===selected.index){if(m.candidate.H!==repair.result.after.H||['repository','pr','B','targetRef'].some(k=>m.candidate[k]!==old.candidate[k]))throw new Error('member_recomposition_selected_version_mismatch');}else if(canonical(m)!==canonical(old))throw new Error('member_recomposition_other_members_changed');}
    const originals=new Map<string,Buffer>(original.originals.map(x=>[x.sha256,x.bytes]));for(const sha of [repair.resultSha256,repair.evidenceSha256,packet.manifest_hash,packet.report_hash,packet.context_hash,...e.report.inputs.map((x:Row)=>x.manifestHash)])originals.set(sha,this.blob(sha));
    return {proof:{parent:source.parent,selectedMember:source.selectedMember,selectedFindings:source.selectedFindings,memberReturn:p.memberReturn,repair:{...p.repair,result:repair.result},composition:{...p.composition,subject:composition.subject},previousIntegration:{id:original.request.integration,candidate:source.integration.candidate,subject:source.integration.source.composition.subject},permissionGranted:false,priorAcceptanceTransferred:false},originals};
  }
  memberRepairInput(operation:string,reference:unknown,current=true){return this.transaction(()=>this.memberRepairSource(operation,reference,current));}
  private memberRefutationProof(request:MemberRefutationRequest){
    const original=this.integrationMemberRecords(fn=>fn()).material(request.memberReturn.id),reference=request.memberReturn;
    if(original.state.requestSha256!==reference.requestSha256||original.state.sourceSha256!==reference.sourceSha256)throw new Error('member_refutation_original_return_changed');
    const r=new ReviewRecords(this.db,fn=>fn(),()=>{throw new Error('refutation_cannot_authorize');},()=>{throw new Error('refutation_cannot_authorize');}).state(request.repair.operation).repair;
    if(canonical(r.memberReturn)!==canonical(reference)||r.phase!=='returned'||['planSha256','bindingHash','resultSha256','evidenceSha256'].some(k=>r[k]!==request.repair[k as keyof typeof request.repair]))throw new Error('member_refutation_original_repair_changed');
    const result=JSON.parse(this.blob(r.resultSha256).toString()),evidence=JSON.parse(this.blob(r.evidenceSha256).toString()),H=original.request.member.H,c=original.proof.member.manifest.candidate,decision=result.data?.decision??result.data?.factReport;
    if(canonical(result)!==canonical(r.result)||canonical(evidence.counters)!==canonical(r.counters)||result.status!=='skipped_refuted'||result.actualRepairPerformed!==false||result.before.H!==H||result.after.H!==H||r.counters.actualFileWrites!==0||r.counters.fixedNewCandidates!==0||r.counters.writeHandoffs!==0||decision?.decision!=='refuted'||decision.candidateH!==H||!decision.report?.trim()||result.sourceCandidate?.H!==H||result.sourceCandidate.B!==c.B||result.sourceCandidate.repository!==c.repository||result.sourceCandidate.pr!==c.pr||result.sourceCandidate.target!==c.targetRef)throw new Error('member_refutation_ended_unchanged_result_required');
    const parent=this.receiverOperation(original.request.reception.operation),packet=this.packet(parent.op.packet),e=this.packetEvidence(packet);
    if(parent.op.status!=='complete'||parent.receiver?.phase!=='returned'||parent.receiver.bindingHash!==original.request.reception.bindingHash||canonical(parent.receiver.judgment)!==canonical(original.proof.parent.judgment))throw new Error('member_refutation_original_parent_changed');
    return {schemaVersion:1,kind:'tongxu-member-refutation-evidence',memberReturn:reference,selectedFindings:original.proof.selectedFindings,
      parent:{...original.proof.parent,item:parent.op.item,candidate:e.manifest.candidate,context:e.context,manifestSha256:packet.manifest_hash,reportSha256:packet.report_hash,contextSha256:packet.context_hash},
      member:{item:original.request.member.item,packet:original.request.member.packet,fingerprint:original.request.member.fingerprint,candidate:c},
      repair:{...request.repair,result,counters:r.counters,terminalRecordSha256:evidence.terminalRecordSha256},source:request.source,
      permissionGranted:false,priorAcceptanceTransferred:false,individualReceptionInferred:false};
  }
  private memberRefutationOriginal(id:string){
    const row=this.db.prepare("SELECT data FROM events WHERE kind='member_refutation_attached' AND object=?").get('member-refutation:'+id) as Row|undefined;if(!row)throw new Error('member_refutation_not_recorded');
    const value=JSON.parse(row.data),request=parseMemberRefutationRequest(this.blob(value.requestSha256)),proof=JSON.parse(this.blob(value.proofSha256).toString()),packet=this.packet(value.packet),ref=parse(packet,'summary').memberRefutation;
    if(request.id!==id||canonical(proof)!==canonical(this.memberRefutationProof(request))||packet.item!==proof.parent.item||packet.fingerprint!==value.fingerprint||canonical(ref)!==canonical({id,sha256:value.proofSha256}))throw new Error('member_refutation_record_changed');
    return {value,request,proof};
  }
  private memberRefutationEvidence(packet:Row,current:boolean):Row|null{
    const ref=parse(packet,'summary').memberRefutation;if(!ref)return null;const {proof,value}=this.memberRefutationOriginal(ref.id);
    if(ref.sha256!==value.proofSha256||packet.item!==proof.parent.item)throw new Error('member_refutation_packet_changed');
    if(current){const repair=new ReviewRecords(this.db,fn=>fn(),()=>{throw new Error('refutation_cannot_authorize');},()=>{throw new Error('refutation_cannot_authorize');}).state(proof.repair.operation).repair;
      verifyMemberRefutationOriginals(repair.executionRoot,proof.repair.terminalRecordSha256,proof.repair.result,repair.requestSha256);
      const member=this.item(proof.member.item),memberPacket=this.packet(member.current_packet);
      if(member.current_packet!==proof.member.packet||memberPacket.fingerprint!==proof.member.fingerprint||member.observation_conflict||!this.receiverCandidateCurrent(member)||packet.manifest_hash!==proof.parent.manifestSha256||packet.report_hash!==proof.parent.reportSha256||packet.context_hash!==proof.parent.contextSha256)throw new Error('member_refutation_source_no_longer_current');}
    return {sha256:ref.sha256,...proof};
  }
  memberRefutation(id:string){return this.transaction(()=>{const original=this.memberRefutationOriginal(id);let current=false,reason:string|null=null;
    try{const packet=this.packet(original.value.packet),item=this.item(packet.item);this.memberRefutationEvidence(packet,true);current=item.current_packet===packet.id&&!item.observation_conflict&&this.receiverCandidateCurrent(item);if(!current)reason='member_refutation_source_no_longer_current';}catch(e){reason=e instanceof Error?e.message:'member_refutation_source_unavailable';}
    const op=this.db.prepare('SELECT id,status,result FROM operations WHERE packet=?').get(original.value.packet) as Row|undefined,receiver=op?parse(op,'result')?.receiver:null;
    return {...original.value,id,current,reason,proof:original.proof,reception:op?{operation:op.id,status:op.status,phase:receiver?.phase??null,planSha256:receiver?.planSha256??null}:null,duplicate:true,newModelInputs:0};});}
  enableMemberRefutationSourceChecks(item:string){return this.transaction(()=>{if(parse(this.packet(this.item(item).current_packet),'summary').memberRefutation)installMemberRefutationOriginalsGuard(this.db);});}
  attachMemberRefutation(raw:Buffer){return this.transaction(()=>{
    const request=parseMemberRefutationRequest(raw),requestSha256=hash(raw),known=this.db.prepare("SELECT 1 FROM events WHERE kind='member_refutation_attached' AND object=?").get('member-refutation:'+request.id);
    if(known){const old=this.memberRefutationOriginal(request.id);if(canonical(old.request)!==canonical(request))throw new Error('member_refutation_request_changed');return {...old.value,id:request.id,duplicate:true,newModelInputs:0};}
    const original=this.integrationMemberRecords(fn=>fn()).material(request.memberReturn.id);if(!original.state.current)throw new Error('member_refutation_source_no_longer_current');
    const proof=this.memberRefutationProof(request),packet=this.packet(proof.parent.packet);
    const repair=new ReviewRecords(this.db,fn=>fn(),()=>{throw new Error('refutation_cannot_authorize');},()=>{throw new Error('refutation_cannot_authorize');}).state(request.repair.operation).repair;
    verifyMemberRefutationOriginals(repair.executionRoot,proof.repair.terminalRecordSha256,proof.repair.result,repair.requestSha256);
    if(parse(packet,'summary').memberRefutation)throw new Error('member_refutation_single_source_limit');
    this.requireReceiverEntry(proof.parent.item);
    if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='investment' AND stopped=1").get(proof.parent.context.scope.id))throw new Error('new_investment_stopped');
    enableMemberRefutationFormat(this.db);
    installMemberRefutationOriginalsGuard(this.db);
    const bytes=Buffer.from(canonical(proof)),proofSha256=hash(bytes);for(const b of [raw,bytes])this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(b),b);
    const attached=this.supplementReceiverCurrent(proof.parent.operation,{judgmentId:proof.parent.judgment.judgmentId,bindingHash:proof.parent.judgment.bindingHash,source:request.source,reason:'Ended unchanged-member refutation requires a new independent judgment; no prior acceptance is restored.',material:[{name:'complete-original-member-refutation.json',bytes}]},{id:request.id,sha256:proofSha256});
    const value={item:attached.item,packet:attached.packet,fingerprint:attached.fingerprint,previousOperation:proof.parent.operation,requestSha256,proofSha256,memberReturn:request.memberReturn,repair:request.repair,newModelInputs:0,permissionGranted:false,priorAcceptanceTransferred:false};
    this.event('member_refutation_attached','member-refutation:'+request.id,value);return {...value,id:request.id,duplicate:false};
  });}
  /** Hold the original queue transaction through the synchronous spawn. A
   * separately committed stop/source update cannot slip between the last
   * read and the actual new Git or isolated test process. */
  memberRecompositionEffect<T>(reference:unknown,effect:()=>T):T{return this.transaction(()=>{
    if(!memberReturnReference(reference))throw new Error('member_repair_reference_invalid');this.requireUnprofiledConsumer();const m=this.integrationMemberRecords(fn=>fn()).material(reference.id);
    if(m.state.requestSha256!==reference.requestSha256||m.state.sourceSha256!==reference.sourceSha256||!m.state.current)throw new Error('member_recomposition_source_no_longer_current');
    if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND stopped=1 AND kind IN ('investment','implementation','candidate')").get(m.proof.member.context.scope.id))throw new Error('member_recomposition_stopped');return effect();
  });}
  private memberRepairSource(operation:string,reference:unknown,current:boolean):Row{
    if(!memberReturnReference(reference))throw new Error('member_repair_reference_invalid');const m=this.integrationMemberRecords(fn=>fn()).material(reference.id),request=m.request,op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row|undefined;
    if(m.state.requestSha256!==reference.requestSha256||m.state.sourceSha256!==reference.sourceSha256||!op||op.item!==request.member.item||op.packet!==request.member.packet)throw new Error('member_repair_original_operation_mismatch');
    if(current&&(!m.state.current||this.prerequisites(this.item(op.item)).length))throw new Error('member_repair_source_no_longer_current');
    const proof=m.proof,parent=this.receiverOperation(request.reception.operation).receiver;if(!parent||parent.bindingHash!==request.reception.bindingHash||parent.judgmentId!==request.reception.judgmentId||parent.inputSha256!==request.reception.inputSha256||canonical(parent.judgment)!==canonical(proof.parent.judgment))throw new Error('member_repair_parent_judgment_changed');
    if(proof.selectedFindings.length>10)throw new Error('member_repair_selected_finding_bound');
    const parentInput=JSON.parse(this.blob(parent.inputSha256).toString()),priorReview={operation:request.reception.operation,packet:request.reception.packet,judgmentId:parent.judgmentId,bindingHash:parent.bindingHash,inputSha256:parent.inputSha256,report:parent.judgment.report,findings:parent.judgment.findings,context:proof.member.context,integrationMember:{reference,parentFinal:proof.parent.fullFinal,association:proof.integration.association,composition:proof.integration.source.composition,compositionReport:proof.integration.source.report,candidateDiff:proof.integration.diff,candidateReport:parentInput.data.evidence.report,sources:parentInput.data.sources,material:parentInput.data.material,selectedMember:proof.selectedMember,selectedFindings:proof.selectedFindings,member:proof.member,sourceArtifactScope:'Full parent final, original structured reports and supplied source/material are included. Raw provider and Git captures remain exact originals in the queue, not an implied model inspection of every raw field.'}},findings=proof.selectedFindings.map((x:Row)=>({id:parent.judgmentId+':'+x.index,description:x.finding.description})),queueOperation={store:this.directory,operation,sourceReviewOperation:request.reception.operation,memberReturnSha256:reference.sourceSha256};
    return {kind:'integration-member-return',operation,packet:op.packet,candidate:proof.member.manifest.candidate,context:proof.member.context,reception:parent,receptionOperation:request.reception.operation,memberReturn:reference,priorReview,findings,queueOperation};
  }
  private memberRepairAdmission(operation:string,proposed:{plan:Buffer;request:Buffer;config:Buffer}|undefined){
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row,stage=parse(op,'result')?.repair,plan=proposed?.plan??this.blob(stage?.planSha256),p=JSON.parse(plan.toString()),history=this.db.prepare("SELECT data FROM events WHERE kind='integration_member_repair_bound' AND object=? ORDER BY id DESC LIMIT 1").get(operation) as Row|undefined;
    if(!p.memberReturn){if(history)throw new Error('member_repair_original_return_required');return;}
    const source=this.memberRepairSource(operation,p.memberReturn,true),request=proposed?.request??this.blob(stage.requestSha256),config=proposed?.config??this.blob(stage.configSha256),r=JSON.parse(request.toString());
    if(canonical(r.priorReview)!==canonical(source.priorReview)||canonical(r.findings)!==canonical(source.findings)||canonical(r.queueOperation)!==canonical(source.queueOperation))throw new Error('member_repair_complete_parent_material_required');
    const entry={memberReturn:p.memberReturn,packet:op.packet,planSha256:hash(plan),requestSha256:hash(request),configSha256:hash(config),memberReturnSha256:p.memberReturn.sourceSha256};
    if(history&&canonical(JSON.parse(history.data))!==canonical(entry)&&!(stage?.phase==='closed_unstarted'&&p.replacesClosedBinding===stage.bindingHash))throw new Error('member_repair_original_binding_changed');
    enableMemberRepairFormat(this.db);if(!history||canonical(JSON.parse(history.data))!==canonical(entry))this.event('integration_member_repair_bound',operation,entry);
    this.event('integration_member_repair_admitted',operation,entry);
  }
  private integrationMemberSource(p:IntegrationMemberReturn):IntegrationMemberSource{
    const parent=this.reviewSource(p.reception.operation,true),r=parent.receiver,op=this.receiverOperation(p.reception.operation).op,packet=this.packet(op.packet),integration=this.integrationMaterial(packet,true,p.reception.operation),member=this.item(p.member.item),memberPacket=this.packet(p.member.packet),e=this.packetEvidence(memberPacket),summary=this.effectiveSummary(member,memberPacket);
    if(op.status!=='complete'||!r.controllerReturned||r.judgment.verdict!=='RETURN_FOR_WORK'||op.packet!==p.reception.packet||r.bindingHash!==p.reception.bindingHash||r.judgmentId!==p.reception.judgmentId||r.inputSha256!==p.reception.inputSha256||!integration||integration.id!==p.integration||r.integrationSha256!==integration.sha256||r.judgment.consumedIntegration!==integration.sha256)throw new Error('integration_member_original_return_required');
    const completed=r.blobs?.['completed.json'];if(!completed)throw new Error('integration_member_final_original_required');const receipt=JSON.parse(this.blob(completed.sha256).toString());if(typeof receipt.finalText!=='string'||hash(receipt.finalText)!==p.reception.finalSha256||receipt.inputSha256!==p.reception.inputSha256)throw new Error('integration_member_final_original_changed');
    const selected=integration.source.composition.subject.members[p.member.index],c=e.manifest.candidate;
    if(!selected||selected.manifestHash!==p.member.manifestSha256||selected.candidate.H!==p.member.H||selected.candidate.B!==p.member.B||['repository','pr','H','B','targetRef'].some(k=>selected.candidate[k]!==c[k])||memberPacket.item!==member.id||member.current_packet!==memberPacket.id||memberPacket.fingerprint!==p.member.fingerprint||member.observation_conflict||!this.receiverCandidateCurrent(member)||summary.composition||this.integrationRecords(fn=>fn()).candidateProducer(c))throw new Error('integration_member_current_exact_source_required');
    if(canonical(e.context)!==canonical(parent.context)||hash(canonical(e.context.scope))!==p.scopeSha256||hash(canonical(e.context.arrangement))!==p.arrangementSha256)throw new Error('integration_member_scope_or_arrangement_changed');
    // A completely captured failing test is a legitimate repair input. Missing,
    // unknown or internally inconsistent execution evidence is not equivalent.
    if(e.report.executionComplete!==true||e.report.comparisonComplete!==true||summary.gaps.some((g:string)=>g!=='sample_failure_or_incomplete_comparison'))throw new Error('integration_member_execution_originals_incomplete');
    if(p.findingIndexes.some(i=>!r.judgment.findings[i]))throw new Error('integration_member_finding_not_in_original');
    const originals=new Map<string,Buffer>(),add=(sha:string)=>{originals.set(sha,this.blob(sha));};for(const ref of Object.values(r.blobs) as Row[])add(ref.sha256);add(r.inputSha256);add(r.systemSha256);for(const sha of [memberPacket.manifest_hash,memberPacket.report_hash,memberPacket.context_hash,e.report.plan.sha256])add(sha);for(const a of e.manifest.artifacts)add(a.sha256);for(const input of e.report.inputs)add(input.manifest.sha256);for(const stage of e.report.stages){if(stage.mergeOutput)add(stage.mergeOutput.sha256);for(const tool of stage.tools)for(const key of ['stdout','stderr','result','sandbox'])if(tool[key])add(tool[key].sha256);}
    return {proof:{parent:{operation:op.id,packet:op.packet,integrationSha256:integration.sha256,judgment:r.judgment,fullFinal:receipt.finalText,inputSha256:r.inputSha256,systemSha256:r.systemSha256,executionKind:r.executionKind},integration,selectedMember:selected,member:{item:member.id,packet:memberPacket.id,fingerprint:memberPacket.fingerprint,manifest:e.manifest,report:e.report,context:e.context},selectedFindings:p.findingIndexes.map(i=>({index:i,finding:r.judgment.findings[i]})),permissionGranted:false,individualReceptionInferred:false},originals};
  }
  private observedCandidateBinding(p:ObservedCandidateRequest):ObservedCandidateBinding{
    const item=this.item(p.item),packet=this.packet(p.packet),current=this.packet(item.current_packet),e=this.packetEvidence(packet),summary=parse(packet,'summary'),m=this.integrationRecords(fn=>fn()).candidateMaterial(p.integration),c=e.manifest.candidate;
    if(packet.item!==item.id||packet.fingerprint!==p.fingerprint||item.observation_conflict||!this.receiverCandidateCurrent(item,true)||!m.current)throw new Error('observed_candidate_original_not_current');
    if(current.id!==packet.id){const prior=parse(current,'summary').integration,proof=prior&&JSON.parse(this.blob(prior.sha256).toString());if(prior?.id!==p.integration||proof.originalCandidatePacket!==packet.id||proof.originalCandidateFingerprint!==packet.fingerprint||current.manifest_hash!==packet.manifest_hash||current.report_hash!==packet.report_hash||current.context_hash!==packet.context_hash)throw new Error('observed_candidate_original_packet_changed');}
    if(summary.composition||c.kind==='development-task'||!summary.evidenceComplete||e.report.inputs.length!==1||summary.tree!==m.candidate.T||c.H!==m.candidate.H||c.B!==m.candidate.B||c.targetRef!==m.candidate.target||c.repository.toLowerCase()!==m.candidate.repository.toLowerCase()||m.source.composition.subject.members.some((x:Row)=>x.candidate.pr===c.pr)||canonical(e.context)!==canonical(m.source.context))throw new Error('integration_own_candidate_verification_required');
    const latest=this.db.prepare("SELECT MAX(id) AS version FROM events WHERE kind='integration_remote_observation' AND object=? AND json_extract(data,'$.integration')=?").get(p.item,p.integration) as Row;
    return {repository:c.repository,pr:c.pr,H:c.H,B:c.B,T:summary.tree,targetRef:c.targetRef,integration:p.integration,integrationRequestSha256:m.requestSha256,item:p.item,packet:p.packet,fingerprint:p.fingerprint,manifestSha256:packet.manifest_hash,reportSha256:packet.report_hash,contextSha256:packet.context_hash,observationVersion:latest.version??0};
  }
  observedCandidateSource(raw:Buffer){return this.transaction(()=>this.observedCandidateBinding(parseObservedCandidateRequest(raw)));}
  observedCandidateProblem(raw:Buffer,reason:string,started:ObservedCandidateBinding){return this.transaction(()=>{
    const p=parseObservedCandidateRequest(raw),binding=this.observedCandidateBinding(p);if(canonical(binding)!==canonical(started))throw new Error('observed_candidate_superseded_read');protectObservedCandidate(this.db);this.event('integration_remote_observation',p.item,{integration:p.integration,requestSha256:hash(canonical(p)),binding,matched:false,reason,observedAt:now(),permissionGranted:false});
  });}
  attachObservedCandidate(raw:Buffer,capture:ObservedCandidateCapture){return this.transaction(()=>{
    const p=parseObservedCandidateRequest(raw),binding=this.observedCandidateBinding(p),actual=requireObservedCandidate(capture,p,binding),item=this.item(p.item),packet=this.packet(item.current_packet),summary=parse(packet,'summary'),m=this.integrationRecords(fn=>fn()).candidateMaterial(p.integration),source=this.packet(p.packet),e=this.packetEvidence(source),previous=summary.integration&&JSON.parse(this.blob(summary.integration.sha256).toString());
    const last=this.db.prepare("SELECT data FROM events WHERE kind='integration_remote_observation' AND object=? AND json_extract(data,'$.integration')=? ORDER BY id DESC LIMIT 1").get(p.item,p.integration) as Row|undefined;if(last&&JSON.parse(last.data).observedAt>=actual.observedAt)throw new Error('observed_candidate_newer_read_required');protectObservedCandidate(this.db);
    const keep=(b:Buffer)=>{const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.blob(sha);return sha;},captureSha256=keep(Buffer.from(canonical(actual))),requestSha256=keep(Buffer.from(canonical(p)));
    const checked=()=>this.event('integration_remote_observation',p.item,{integration:p.integration,requestSha256,binding,matched:true,captureSha256,observedAt:actual.observedAt,permissionGranted:false});
    if(previous?.remoteObservation?.requestSha256===requestSha256){this.integrationMaterial(packet,false);checked();return {item:p.item,packet:packet.id,fingerprint:packet.fingerprint,integrationSha256:summary.integration.sha256,originalRemoteObservationSha256:previous.remoteObservation.captureSha256,currentReadSha256:captureSha256,duplicate:true};}
    if(this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(targetKey(e.manifest.candidate)))throw new Error('target_occupied_or_unknown');
    enableIntegrationFormat(this.db);
    const link=Buffer.from(canonical(integrationCandidateRequest(p))),proof={schemaVersion:1,id:p.integration,requestSha256:m.requestSha256,sourceOperation:m.source.operation,sourcePacket:m.source.packet,sourceFingerprint:m.source.fingerprint,subjectSha256:m.source.composition.sha256,candidate:e.manifest.candidate,candidateTree:binding.T,context:e.context,originalCandidatePacket:source.id,originalCandidateFingerprint:source.fingerprint,originalCandidateManifestSha256:source.manifest_hash,originalCandidateReportSha256:source.report_hash,linkRequestSha256:keep(link),...(previous?{previousAssociationSha256:summary.integration.sha256}:{}),remoteObservation:{requestSha256,captureSha256,request:p,capture:actual,historicalObservationOnly:true}};
    const integration={id:p.integration,sha256:keep(Buffer.from(canonical(proof)))},fingerprint=hash(canonical({previous:packet.fingerprint,integration})),inserted=this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id,fingerprint,packet.manifest_hash,packet.report_hash,packet.context_hash,JSON.stringify({...summary,baseFingerprint:this.basePacketFingerprint(packet),integration}),now()),packetId=Number(inserted.lastInsertRowid);
    this.db.prepare('UPDATE items SET current_packet=? WHERE id=?').run(packetId,item.id);this.event('integration_candidate_linked',item.id,{packet:packetId,previousPacket:packet.id,integrationSha256:integration.sha256,requestSha256:keep(link),remoteObservationSha256:captureSha256});checked();
    return {item:item.id,packet:packetId,fingerprint,integrationSha256:integration.sha256,originalRemoteObservationSha256:captureSha256,currentReadSha256:captureSha256,duplicate:false,priorJudgmentTransferred:false};
  });}
  attachIntegrationCandidate(raw:Buffer){return this.transaction(()=>{
    const p=parseIntegrationCandidate(raw),item=this.item(p.item),packet=this.packet(item.current_packet),summary=parse(packet,'summary'),e=this.packetEvidence(packet),records=this.integrationRecords(fn=>fn()),m=records.candidateMaterial(p.integration),c=e.manifest.candidate;
    if(summary.integration?.id===p.integration){const value=this.integrationMaterial(packet,true);if(canonical(parseIntegrationCandidate(this.blob(value!.association.linkRequestSha256)))!==canonical(p))throw new Error('integration_candidate_request_changed');return {item:p.item,packet:packet.id,fingerprint:packet.fingerprint,integrationSha256:value!.sha256,duplicate:true,newModelInputs:0};}
    if(packet.id!==p.packet||packet.fingerprint!==p.fingerprint)throw new Error('integration_candidate_packet_changed');
    if(!m.current||!this.receiverCandidateCurrent(item,true)||item.observation_conflict)throw new Error('integration_source_or_candidate_not_current');
    if(summary.composition||c.kind==='development-task'||m.source.composition.subject.members.some((x:Row)=>x.candidate.pr===c.pr)||!summary.evidenceComplete||e.report.inputs.length!==1||summary.tree!==m.candidate.T||records.candidateProducer(c)!==p.integration||canonical(e.context)!==canonical(m.source.context))throw new Error('integration_own_candidate_verification_required');
    if(this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(targetKey(c)))throw new Error('target_occupied_or_unknown');
    enableIntegrationFormat(this.db);
    const proof={schemaVersion:1,id:p.integration,requestSha256:m.requestSha256,sourceOperation:m.source.operation,sourcePacket:m.source.packet,sourceFingerprint:m.source.fingerprint,subjectSha256:m.source.composition.sha256,candidate:c,candidateTree:summary.tree,context:e.context,originalCandidatePacket:packet.id,originalCandidateFingerprint:packet.fingerprint,originalCandidateManifestSha256:packet.manifest_hash,originalCandidateReportSha256:packet.report_hash,linkRequestSha256:hash(raw)};
    const bytes=Buffer.from(canonical(proof)),sha256=hash(bytes);for(const b of [raw,bytes])this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(b),b);
    const integration={id:p.integration,sha256},fingerprint=hash(canonical({previous:packet.fingerprint,integration})),inserted=this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id,fingerprint,packet.manifest_hash,packet.report_hash,packet.context_hash,JSON.stringify({...summary,baseFingerprint:this.basePacketFingerprint(packet),integration}),now()),packetId=Number(inserted.lastInsertRowid);
    this.db.prepare('UPDATE items SET current_packet=? WHERE id=?').run(packetId,item.id);this.event('integration_candidate_linked',item.id,{packet:packetId,previousPacket:packet.id,integrationSha256:sha256,requestSha256:hash(raw)});
    return {item:item.id,packet:packetId,fingerprint,integrationSha256:sha256,duplicate:false,newModelInputs:0,priorJudgmentTransferred:false};
  });}
  private integrationMaterial(packet:Row,requireCurrent:boolean,excludeReception?:string):Row|null{
    const e=this.packetEvidence(packet),records=this.integrationRecords(fn=>fn()),id=records.candidateProducer(e.manifest.candidate),ref=parse(packet,'summary').integration;
    if(!id){if(ref)throw new Error('integration_producer_binding_changed');return null;}if(!ref||ref.id!==id)throw new Error('integration_candidate_link_required');
    const proof=JSON.parse(this.blob(ref.sha256).toString()),m=records.candidateMaterial(id),c=e.manifest.candidate,summary=parse(packet,'summary');
    if(proof.id!==id||proof.requestSha256!==m.requestSha256||proof.sourceOperation!==m.source.operation||proof.sourcePacket!==m.source.packet||proof.sourceFingerprint!==m.source.fingerprint||proof.subjectSha256!==m.source.composition.sha256||['repository','pr','H','B','targetRef'].some(k=>proof.candidate[k]!==c[k])||proof.candidateTree!==m.candidate.T||summary.tree!==m.candidate.T||canonical(proof.context)!==canonical(e.context)||canonical(e.context)!==canonical(m.source.context))throw new Error('integration_candidate_link_changed');
    this.blob(proof.linkRequestSha256);this.blob(proof.originalCandidateManifestSha256);this.blob(proof.originalCandidateReportSha256);
    if(proof.remoteObservation){const r=proof.remoteObservation;if(!this.blob(r.captureSha256).equals(Buffer.from(canonical(r.capture)))||!this.blob(r.requestSha256).equals(Buffer.from(canonical(r.request)))||r.capture.requestSha256!==r.requestSha256||r.capture.binding.integration!==id||r.capture.binding.H!==c.H||r.capture.binding.B!==c.B||r.capture.binding.T!==summary.tree||r.capture.binding.item!==packet.item||r.capture.binding.manifestSha256!==proof.originalCandidateManifestSha256||r.capture.binding.reportSha256!==proof.originalCandidateReportSha256)throw new Error('integration_remote_observation_original_changed');}
    const latestRemote=this.db.prepare("SELECT data FROM events WHERE kind='integration_remote_observation' AND object=? AND json_extract(data,'$.integration')=? ORDER BY id DESC LIMIT 1").get(packet.item,id) as Row|undefined;
    if(requireCurrent&&latestRemote&&JSON.parse(latestRemote.data).matched!==true)throw new Error('integration_remote_observation_unresolved');
    if(requireCurrent&&(!m.current||!summary.evidenceComplete))throw new Error('integration_original_or_validation_no_longer_current');
    const {current:_current,...material}=m,memberReturns=this.integrationMemberRecords(fn=>fn()).contextFor(m.source.composition.subject.members,m.source.context,excludeReception),memberRepairs=this.memberRecompositionRecords(fn=>fn()).forSubject(m.source.composition.sha256);return {sha256:ref.sha256,association:proof,...material,memberReturns,memberReturnEvidenceSha256:hash(canonical(memberReturns)),...(memberRepairs.length?{memberRepairs,memberRepairEvidenceSha256:hash(canonical(memberRepairs))}:{})};
  }
  private integrationAdmission(op:Row,status:'receiving'|'merging',authority?:Row){
    const material=this.integrationMaterial(this.packet(op.packet),true,op.id);if(!material&&!authority)return;
    if(!this.receiverCandidateCurrent(this.item(op.item)))throw new Error('integration_current_candidate_required');
    const refutation=this.memberRefutationEvidence(this.packet(op.packet),true);if(refutation)installMemberRefutationOriginalsGuard(this.db);
    this.event('integration_consumer_admitted',op.id,{...authority,packet:op.packet,status,integrationSha256:material?.sha256??null,...(refutation?{memberRefutationSha256:refutation.sha256,memberRefutationTerminalSha256:refutation.repair.terminalRecordSha256}:{})});
  }
  static async observeIntegration(directory:string,id:string){const q=await QueueStore.connect(directory,true);try{q.db.exec('BEGIN');return q.integrationRecords(fn=>fn()).state(id);}finally{if(q.db.isTransaction)q.db.exec('ROLLBACK');q.close();}}
  private integrationSource(operation:string):IntegrationSource{
    const {op}=this.receiverOperation(operation),item=this.item(op.item),packet=this.packet(op.packet),e=this.packetEvidence(packet),summary=parse(packet,'summary'),composition=summary.composition;
    if(!composition)throw new Error('integration_original_composition_required');this.requireCompositionMode();this.basePacketFingerprint(packet);
    const originals=new Map<string,Buffer>(),add=(ref:Row)=>{const b=this.blob(ref.sha256);if(ref.bytes!==undefined&&ref.bytes!==b.length)throw new Error('integration_original_length_changed');originals.set(ref.sha256,b);};
    for(const sha of [packet.manifest_hash,packet.report_hash,packet.context_hash])add({sha256:sha});add(e.report.plan);
    for(const input of e.report.inputs){add(input.manifest);const manifest=JSON.parse(this.blob(input.manifestHash).toString());for(const ref of manifest.artifacts)add(ref);}
    for(const stage of e.report.stages){if(stage.mergeOutput)add(stage.mergeOutput);for(const tool of stage.tools)for(const key of ['stdout','stderr','result','sandbox'])if(tool[key])add(tool[key]);}
    if(e.report.failureOutput){add(e.report.failureOutput.stdout);add(e.report.failureOutput.stderr);}
    return {operation,item:op.item,packet:op.packet,fingerprint:packet.fingerprint,current:op.status==='complete'&&item.current_packet===op.packet&&!item.observation_conflict&&this.receiverCandidateCurrent(item),context:e.context,composition,report:e.report,manifestSha256:packet.manifest_hash,reportSha256:packet.report_hash,contextSha256:packet.context_hash,originals};
  }
  deliveryAssessments(){return this.deliveryAssessmentRecords(fn=>this.transaction(fn));}
  private deliveryAssessmentRecords(transaction:<T>(fn:()=>T)=>T):DeliveryAssessmentRecords{return new DeliveryAssessmentRecords(this.db,transaction,this.directory,this.deliveryRecords(fn=>fn()),this.deliveryValidationRecords(fn=>fn()),()=>this.messageRecords(fn=>fn()),(run,p)=>{if(!p.resourceBudget)return !this.db.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get();try{const b=this.messageResourceRecords(fn=>fn()).state(run),r=this.resourceRecords(fn=>fn());return b.phase==='returned'&&b.resourceRequests.length===p.resourceBudget.length&&b.resourceRequests.every((id:string)=>r.settledOutcome(id));}catch{return false;}});}
  events(): EventRecords { const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id));return new EventRecords(this.db,fn=>this.transaction(fn),this.directory,(id,observations)=>a.refreshReservedAction(id,observations)); }
  sessions(): SessionRecords { return new SessionRecords(this.db,fn=>this.transaction(fn),this.directory,id=>this.authorityItem(id)); }
  messages():MessageRecords{return this.messageRecords(fn=>this.transaction(fn));}
  private messageRecords(transaction:<T>(fn:()=>T)=>T): MessageRecords { const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id)),c=this.coordinationRecords(fn=>fn());return new MessageRecords(this.db,transaction,this.directory,id=>this.authorityItem(id),(id,observations)=>a.refreshReservedAction(id,observations),(run,message,participant,effect)=>{c.messageGate(run,message,participant);this.taskInboxRecords(fn=>fn()).gate(run);this.deliveryAssessmentRecords(fn=>fn()).gate(run,effect);},(run,action)=>this.messageResourceRecords(fn=>fn()).requireHeld(run,action),run=>{try{const b=this.messageResourceRecords(fn=>fn()).state(run),r=this.resourceRecords(fn=>fn());return ['returned','partial_returned'].includes(b.phase)&&b.resourceRequests.length>0&&b.resourceRequests.every((id:string)=>r.settledOutcome(id));}catch{return false;}}); }
  messageResources(){return this.messageResourceRecords(fn=>this.transaction(fn));}
  private messageResourceRecords(transaction:<T>(f:()=>T)=>T){const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id)),m=new MessageRecords(this.db,fn=>fn(),this.directory,id=>this.authorityItem(id),(id,observations)=>a.refreshReservedAction(id,observations),(run,message,participant)=>{this.coordinationRecords(fn=>fn()).messageGate(run,message,participant);this.taskInboxRecords(fn=>fn()).gate(run);this.deliveryAssessmentRecords(fn=>fn()).gate(run);});return new MessageResourceRecords(this.db,transaction,run=>m.status(run),(id,observations)=>a.refreshReservedAction(id,observations),()=>this.resourceRecords(fn=>fn()),run=>m.continuation(run),run=>m.continuationSource(run),run=>m.partialExecutionProof(run),(run,observations)=>{m.admission(run,observations);});}
  coordination(): CoordinationRecords {return this.coordinationRecords(fn=>this.transaction(fn));}
  private coordinationRecords(transaction:<T>(f:()=>T)=>T):CoordinationRecords {
    const messages=new MessageRecords(this.db,fn=>fn(),this.directory,id=>this.authorityItem(id),()=>{throw new Error('coordination_read_cannot_authorize_messages');});
    return new CoordinationRecords(this.db,transaction,id=>this.authorityItem(id),run=>({state:messages.status(run),materials:messages.frozen(run).materials,submitted:participant=>messages.submitted(run,participant)}),this.directory);
  }
  resources(): ResourceRecords {
    // Persist the old-consumer guard before any result validation can fail.
    // Read-only projections use resourceRecords directly and do not mutate.
    this.transaction(()=>{if(this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(publicationConsumerKey))installPublicationResultGuard(this.db);});
    return this.resourceRecords(fn=>this.transaction(fn));
  }
  private resourceRecords(transaction:<T>(f:()=>T)=>T):ResourceRecords {
    const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id));
    return new ResourceRecords(this.db,transaction,(id,observations)=>observations===null?a.reservedAction(id):a.refreshReservedAction(id,observations),(operation,action,claimedAt)=>this.resourceExecution(operation,action,claimedAt),(action,request,dispatch)=>{
      if(action.request.action==='coordinate')this.deliveryAssessmentRecords(fn=>fn()).gate(action.request.payloadSha256);
      if(dispatch){
        if(action.request.action==='implement')this.memberRepairResourceGate(action,request);
        const receiver=action.request.action==='receive'&&this.db.prepare("SELECT 1 FROM meta WHERE key='owner_governed_receiver_v1'").get()?this.receiverResourceClaimGate(action,request):null;
        const test=action.request.action==='test'&&action.request.payloadSha256?this.recompositionTestRecords(fn=>fn()).resourceClaimGate(action,request):null;
        const publication=action.request.action==='publish'?this.publicationResourceClaimGate(action,request):null;
        if(queueFormatVersion(this.db)>=20||receiver||test||publication){queueFeatureVersion(this.db);this.event('member_resource_claim_admitted','resource:'+resourceRequestHash(request),{operation:request.operation,requestSha256:resourceRequestHash(request),...(receiver?{receiverPlanSha256:receiver.planSha256,receiverAuthorityIntent:receiver.authorityIntent}:{}),...(test?{recompositionTestId:test.id,recompositionTestPlanSha256:test.planSha256}:{}),...(publication?{publicationBindingSha256:publication.bindingSha256}:{})});}
      }
    },(request,record,dispatch)=>{
      const action=a.reservedAction(request.authorityIntent);if(action.request.action!=='publish')return;
      this.publicationOriginalProcessesEnded(request.operation);
      if(dispatch)this.event('publication_resource_result_admitted','resource:'+resourceRequestHash(request),{originalOperation:request.operation,outcomeSha256:record.outcomeSha256});
    });
  }
  private receiverResourceClaimGate(action:Row,request:ResourceRequest){
    const row=this.db.prepare("SELECT data FROM events WHERE kind='authority_receiver_bound' AND object=?").get(request.operation) as Row|undefined;if(!row)throw new Error('receiver_resource_binding_required');
    const b=JSON.parse(row.data),{op,receiver}=this.receiverOperation(request.operation),p=JSON.parse(this.blob(b.planSha256).toString());
    if(receiver||op.status!=='complete'||b.packet!==op.packet||b.authorityIntent!==action.requestId||b.actionSha256!==action.requestSha256||!b.resourceRequests.includes(resourceRequestHash(request))||canonical(p.governance?.resourceRequests)!==canonical(b.resourceRequests))throw new Error('receiver_resource_binding_changed');this.receiverGate(op);return b;
  }
  private memberRepairResourceGate(action:Row,request:ResourceRequest){
    const row=this.db.prepare("SELECT data FROM events WHERE kind='member_repair_resource_bound' AND object=? ORDER BY id DESC LIMIT 1").get(request.operation) as Row|undefined;
    if(!row){if(this.integrationMemberRecords(fn=>fn()).hasPendingForItem(action.request.item))throw new Error('member_repair_resource_binding_required');return;}
    const binding=JSON.parse(row.data),op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(request.operation) as Row|undefined;
    if(!op||binding.packet!==op.packet||binding.authorityIntent!==action.requestId||!binding.resourceRequests.includes(resourceRequestHash(request)))throw new Error('member_repair_resource_binding_changed');
    const plan=JSON.parse(this.blob(binding.planSha256).toString());this.blob(binding.requestSha256);this.blob(binding.configSha256);if(canonical(plan.memberReturn)!==canonical(binding.memberReturn)||plan.operation!==request.operation)throw new Error('member_repair_resource_binding_changed');
    this.memberRepairSource(request.operation,binding.memberReturn,true);
  }
  merges(): MergeRecords {
    const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id));
    const authority=(id:string,observations:import('./authority-source.js').OwnerObservation[]|null)=>observations===null?a.reservedAction(id):a.refreshReservedAction(id,observations);
    const resources=()=>this.resourceRecords(fn=>fn());
    return new MergeRecords(this.db,fn=>this.transaction(fn),authority,(operation,current)=>{
      const r=this.reviewSource(operation,current),op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row;
      const summary=this.effectiveSummary(this.item(op.item),this.packet(op.packet));
      if(current)this.integrationAdmission(op,'merging');return {...r,tree:summary.tree,evidenceComplete:summary.evidenceComplete};
    },resources);
  }
  private resourceExecution(operation:string,action:Row,claimedAt:string):ResourceOutcome {
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row,result=parse(op,'result');
    if(!op||op.status!=='complete'||op.item!==action.request.item||op.packet!==action.binding?.packet)throw new Error('original_resource_execution_still_unknown');
    const kind=action.request.action,stage=kind==='receive'?result?.receiver:kind==='implement'?result?.repair:kind==='merge'?result?.merge:null;
    if(kind==='coordinate')return this.messageResourceRecords(fn=>fn()).outcome(operation,action,claimedAt);
    if(kind==='publish')return this.publicationResourceOutcome(operation,action,claimedAt);
    if(kind==='test'&&action.request.payloadSha256)return this.recompositionTestRecords(fn=>fn()).outcome(operation,action,claimedAt);
    if(kind==='merge'){
      const original=this.mergesResourceOutcome(operation,action,claimedAt);
      return original;
    }
    if(!stage||stage.authorityIntent!==action.requestId||stage.controllerReturned!==true||!Number.isFinite(Date.parse(stage.registeredAt))||Date.parse(stage.registeredAt)<Date.parse(claimedAt))throw new Error('resource_execution_consumer_binding_required');
    let state:ResourceOutcome['state'],executionKind:'fixture'|'external',proof:Row;
    if(kind==='receive'){
      if(stage.phase!=='returned'&&!stage.invalidResult)throw new Error('original_resource_execution_still_unknown');
      const originals=Object.fromEntries(Object.entries(stage.blobs??{}).map(([name,ref]:[string,any])=>[name,{sha256:hash(this.blob(ref.sha256)),bytes:ref.bytes}]));
      if(!originals['completed.json']||!originals['exit.json']||!originals['stdout.ndjson']||!originals['capture-status.json'])throw new Error('resource_execution_capture_missing');
      if(!['fixture','native_capture'].includes(stage.executionKind))throw new Error('resource_execution_kind_unknown');state=stage.invalidResult?'failed':'completed';executionKind=stage.executionKind==='fixture'?'fixture':'external';
      proof={operation,authorityIntent:action.requestId,source:'verified_receiver_capture',bindingHash:stage.bindingHash,inputSha256:stage.inputSha256,state,originals};
    }else{
      if(stage.phase!=='returned'||!stage.resultSha256||!stage.evidenceSha256)throw new Error('original_resource_execution_still_unknown');
      const value=JSON.parse(this.blob(stage.resultSha256).toString()),receipt=JSON.parse(this.blob(stage.evidenceSha256).toString());
      const terminal=['completed','completed_recovered_candidate','skipped_no_finding','skipped_refuted_by_fixed_contract','skipped_refuted','owner_decision_required','repair_round_budget_reached'];
      if(!terminal.includes(value.status)||receipt.operation!==operation||receipt.bindingHash!==stage.bindingHash||receipt.resultSha256!==stage.resultSha256)throw new Error('resource_execution_terminal_mismatch');
      if(!['fixture','native_capture'].includes(value.executionKind))throw new Error('resource_execution_kind_unknown');state=value.status==='skipped_no_finding'?'cancelled':['owner_decision_required','repair_round_budget_reached'].includes(value.status)?'failed':'completed';executionKind=value.executionKind==='fixture'?'fixture':'external';
      proof={operation,authorityIntent:action.requestId,source:'verified_repair_terminal',bindingHash:stage.bindingHash,resultSha256:stage.resultSha256,evidenceSha256:stage.evidenceSha256,sourceStatus:value.status,state};
    }
    return {state,source:proof.source,proof:Buffer.from(canonical(proof)),executionKind};
  }
  private mergesResourceOutcome(operation:string,action:Row,claimedAt:string):ResourceOutcome {
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row,stage=parse(op,'result')?.merge;
    if(!stage||stage.authorityIntent!==action.requestId||!stage.controllerReturned||!['refused','cancelled_before_send','exact_merge_result_verified','actual_merge_result_verified','merged_wrong_target'].includes(stage.phase)||!Number.isFinite(Date.parse(stage.dispatchedAt??stage.cancelledAt))||Date.parse(stage.dispatchedAt??stage.cancelledAt)<Date.parse(claimedAt))throw new Error('resource_merge_execution_still_unknown');
    const plan=JSON.parse(this.blob(stage.planSha256).toString());
    if(plan.binding.operation!==operation||plan.binding.authorityIntent!==action.requestId)throw new Error('resource_merge_binding_mismatch');
    if(stage.phase==='cancelled_before_send'){
      if(stage.attempts.some((a:Row)=>!a.closedUnstarted))throw new Error('resource_merge_cancellation_not_proven');
      return {state:'cancelled',source:'managed_merge_known_unstarted',executionKind:stage.executionKind,proof:Buffer.from(canonical({operation,authorityIntent:action.requestId,bindingHash:stage.bindingHash,cancelledAt:stage.cancelledAt,planSha256:stage.planSha256,attempts:stage.attempts}))};
    }
    if(!stage.readback?.sha256)throw new Error('resource_merge_binding_mismatch');
    const readback=JSON.parse(this.blob(stage.readback.sha256).toString());
    if(canonical(readback.result)!==canonical(stage.readback.result))throw new Error('resource_merge_readback_changed');
    if(stage.phase==='actual_merge_result_verified')this.blob(stage.validationSha256);
    for(const row of this.db.prepare("SELECT data FROM events WHERE object=? AND kind LIKE 'managed_merge_%'").all('merge:'+operation) as Row[])for(const ref of JSON.parse(row.data).blobs??[])this.blob(ref);
    if(!['fixture','external'].includes(stage.executionKind))throw new Error('resource_execution_kind_unknown');
    const state=['exact_merge_result_verified','actual_merge_result_verified'].includes(stage.phase)?'completed':'failed';
    return {state,source:'captured_managed_merge_result',executionKind:stage.executionKind,proof:Buffer.from(canonical({operation,authorityIntent:action.requestId,bindingHash:stage.bindingHash,phase:stage.phase,readbackSha256:stage.readback.sha256,attempts:stage.attempts}))};
  }
  requireUnprofiledConsumer(): void { if(this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get())throw new Error('authority_consumer_binding_required'); }
  requireReceiverEntry(id:string,plan?:Buffer): {governed:boolean;original:boolean} {
    const governed=Boolean(this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get());
    const i=this.item(id),op=this.db.prepare('SELECT result FROM operations WHERE packet=?').get(i.current_packet) as Row|undefined;
    const original=Boolean(op&&parse(op,'result')?.receiver),g=plan?JSON.parse(plan.toString()).governance:undefined;
    if(!governed&&g!==undefined)throw new Error('receiver_authority_profile_missing');
    if(governed&&!original&&!g)throw new Error('authority_consumer_binding_required');return {governed,original};
  }
  private receiverAuthorization(op:Row,plan:Buffer,observations:OwnerObservation[],requireHeld:boolean){
    const p=JSON.parse(plan.toString()),g=p.governance,configured=Boolean(this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get());
    if(!configured){if(g!==undefined)throw new Error('receiver_authority_profile_missing');return null;}
    if(!this.db.prepare("SELECT 1 FROM meta WHERE key='owner_governed_receiver_v1'").get()||!g||Object.keys(g).sort().join()!=='authorityIntent,resourceRequests'||typeof g.authorityIntent!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(g.authorityIntent)||!Array.isArray(g.resourceRequests)||g.resourceRequests.length>32||new Set(g.resourceRequests).size!==g.resourceRequests.length||g.resourceRequests.some((id:unknown)=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new Error('receiver_authority_consumer_binding_required');
    const a=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id)),action=a.refreshReservedAction(g.authorityIntent,observations);
    if(p.kind!=='tongxu-queue-receiver'||p.item!==op.item||p.store!==this.directory||!['receiver','background'].includes(action.role)||action.request.action!=='receive'||action.request.item!==op.item||action.binding?.packet!==op.packet||action.binding?.fingerprint!==this.packet(op.packet).fingerprint||action.request.paths.length||(action.executionKind==='fixture')!==(p.executionKind==='fixture'))throw new Error('receiver_exact_authority_mismatch');
    const resources=this.resourceRecords(fn=>fn()),claims=g.resourceRequests.map((id:string)=>requireHeld?resources.requireHeldForExecution(id,op.id,g.authorityIntent):resources.status(id));
    if(claims.some((r:Row)=>r.request.operation!==op.id||r.request.authorityIntent!==g.authorityIntent||r.request.actionSha256!==action.requestSha256||r.request.role!==action.role))throw new Error('receiver_original_resource_operation_mismatch');
    if(new Set(claims.map((r:Row)=>r.request.resourceRef)).size!==claims.length||canonical(claims.map((r:Row)=>r.request.resourceRef).sort())!==canonical([...action.request.resourceRefs].sort()))throw new Error('receiver_resource_claim_set_mismatch');
    if(this.db.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get()&&!claims.length)throw new Error('receiver_configured_resource_claim_required');
    return {authorityIntent:g.authorityIntent,resourceRequests:g.resourceRequests as string[],actionSha256:action.requestSha256,role:action.role,planSha256:hash(plan),packet:op.packet,operation:op.id};
  }
  receiverResourceAdmission(id:string,plan:Buffer,observations:OwnerObservation[]){return this.transaction(()=>{
    const {op,receiver}=this.receiverOperation(id);if(receiver||op.status!=='complete')throw new Error('receiver_original_started_or_unknown');this.receiverGate(op);const b=this.receiverAuthorization(op,plan,observations,false);if(!b)return {governed:false,newModelInputs:0};
    const sql="CREATE UNIQUE INDEX receiver_authority_unique ON events(json_extract(data,'$.authorityIntent')) WHERE kind='authority_receiver_bound'",oldIndex=this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='receiver_authority_unique'").get() as Row|undefined;if(oldIndex&&oldIndex.sql!==sql)throw new Error('receiver_authority_guard_changed');if(!oldIndex)this.db.exec(sql);
    const old=this.db.prepare("SELECT data FROM events WHERE kind='authority_receiver_bound' AND object=?").get(id) as Row|undefined;
    if(old&&canonical(JSON.parse(old.data))!==canonical(b))throw new Error('receiver_original_authority_binding_changed');this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(plan),plan);if(!old)this.event('authority_receiver_bound',id,b);return {...b,newModelInputs:0};
  });}
  private receiverAuthorityAdmission(op:Row,record:Row,plan:Buffer,observations:OwnerObservation[]){
    const b=this.receiverAuthorization(op,plan,observations,true);if(!b)return;
    const old=this.db.prepare("SELECT data FROM events WHERE kind='authority_receiver_bound' AND object=?").get(op.id) as Row|undefined;
    if(!old||canonical(JSON.parse(old.data))!==canonical(b)||record.authorityIntent!==b.authorityIntent||canonical(record.resourceRequests)!==canonical(b.resourceRequests))throw new Error('receiver_original_authority_binding_changed');
    return {...b,inputSha256:record.inputSha256,bindingHash:record.bindingHash};
  }
  reviewRecords(): ReviewRecords {
    const coordination=this.coordinationRecords(fn=>fn());
    return new ReviewRecords(this.db, fn => this.transaction(fn), (id, current) => this.reviewSource(id, current), id => this.publicationHistory(id),(operation,proposed,observations)=>{
      this.repairAuthorization(operation,proposed,observations);
      coordination.repairGate(operation,proposed,true,this.continuationCapture);
      this.memberRepairAdmission(operation,proposed);
    },(operation,reference,current)=>this.memberRepairSource(operation,reference,current));
  }
  managedRepairOriginal(operation:string){return this.transaction(()=>{
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row;if(!op)throw new Error('operation_not_found');const repair=JSON.parse(op.result)?.repair;
    if(!repair?.evidenceSha256)throw new Error('handoff_original_reconciliation_required');
    return {op,repair,plan:this.blob(repair.planSha256),request:this.blob(repair.requestSha256),config:this.blob(repair.configSha256),evidence:this.blob(repair.evidenceSha256)};
  });}
  repairResourceAdmission(operation:string,proposed:{plan:Buffer;request:Buffer;config:Buffer},observations:import('./authority-source.js').OwnerObservation[]){return this.transaction(()=>{
    this.repairAuthorization(operation,proposed,observations,false);this.coordinationRecords(fn=>fn()).repairGate(operation,proposed,false,this.continuationCapture);const p=JSON.parse(proposed.plan.toString());
    if(p.memberReturn){enableMemberRecompositionFormat(this.db);const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row,stage=parse(op,'result')?.repair,value={packet:op.packet,memberReturn:p.memberReturn,planSha256:hash(proposed.plan),requestSha256:hash(proposed.request),configSha256:hash(proposed.config),authorityIntent:p.governance.authorityIntent,resourceRequests:p.governance.resourceRequests},old=this.db.prepare("SELECT data FROM events WHERE kind='member_repair_resource_bound' AND object=? ORDER BY id DESC LIMIT 1").get(operation) as Row|undefined;
      if(old&&canonical(JSON.parse(old.data))!==canonical(value)&&!(stage?.phase==='closed_unstarted'&&p.replacesClosedBinding===stage.bindingHash))throw new Error('member_repair_resource_binding_changed');
      for(const b of [proposed.plan,proposed.request,proposed.config])this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(b),b);if(!old||canonical(JSON.parse(old.data))!==canonical(value))this.event('member_repair_resource_bound',operation,value);
    }
    return {operation,preparationChecked:true,modelExecutionAllowed:false};
  });}
  private repairAuthorization(operation:string,proposed:{plan:Buffer;request:Buffer;config:Buffer}|undefined,observations:import('./authority-source.js').OwnerObservation[],requireHeld=true){
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operation) as Row;if(!op)throw new Error('operation_not_found');const stage=parse(op,'result')?.repair;
    if(this.integrationRecords(fn=>fn()).candidateProducer(parse(this.item(op.item),'candidate')))throw new Error('integration_requires_member_scoped_repair');
    const p=JSON.parse((proposed?.plan??this.blob(stage?.planSha256)).toString()),request=JSON.parse((proposed?.request??this.blob(stage?.requestSha256)).toString()),config=JSON.parse((proposed?.config??this.blob(stage?.configSha256)).toString()),governance=p.governance;
    if(p.memberReturn)this.memberRepairSource(operation,p.memberReturn,true);
    const configured=Boolean(this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get());
    if(!configured){if(governance!==undefined)throw new Error('queue_repair_authority_profile_missing');return;}
    if(!governance||Object.keys(governance).sort().join()!=='authorityIntent,resourceRequests'||typeof governance.authorityIntent!=='string'||!Array.isArray(governance.resourceRequests)||governance.resourceRequests.length>32||new Set(governance.resourceRequests).size!==governance.resourceRequests.length||governance.resourceRequests.some((r:unknown)=>typeof r!=='string'||!/^[a-f0-9]{64}$/.test(r)))throw new Error('queue_repair_authority_consumer_binding_required');
    const authority=new AuthorityRecords(this.db,fn=>fn(),id=>this.authorityItem(id)),action=authority.refreshReservedAction(governance.authorityIntent,observations);
    if(!['implementer','background'].includes(action.role)||action.request.action!=='implement'||action.request.item!==op.item||action.binding?.packet!==op.packet||!Array.isArray(request.allowedPaths)||request.allowedPaths.some((path:unknown)=>typeof path!=='string'||!action.request.paths.includes(path))||(action.executionKind==='fixture')!==(config.executionKind==='fixture'))throw new Error('queue_repair_exact_authority_mismatch');
    const resources=this.resourceRecords(fn=>fn()),held=governance.resourceRequests.map((id:string)=>requireHeld?resources.requireHeldForExecution(id,operation,governance.authorityIntent):resources.status(id));
    if(held.some((r:Row)=>r.request.operation!==operation||r.request.authorityIntent!==governance.authorityIntent||r.request.actionSha256!==action.requestSha256||r.request.role!==action.role))throw new Error('queue_repair_original_resource_operation_mismatch');
    if(new Set(held.map((r:Row)=>r.request.resourceRef)).size!==held.length||canonical(held.map((r:Row)=>r.request.resourceRef).sort())!==canonical([...action.request.resourceRefs].sort()))throw new Error('queue_repair_resource_claim_set_mismatch');
    if(this.db.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get()&&!held.length)throw new Error('queue_repair_configured_resource_claim_required');
    if(requireHeld&&proposed){
      // This stamp is emitted only after the exact current source and original
      // resource claims pass in this same transaction. The database guard
      // still rejects an older/unbound consumer's transition to repairing.
      this.event('authority_repair_admitted',operation,{packet:op.packet,planSha256:hash(proposed.plan),requestSha256:hash(proposed.request),configSha256:hash(proposed.config),authorityIntent:governance.authorityIntent,actionSha256:action.requestSha256,resourceRequests:governance.resourceRequests,checkedAt:action.checkedAt});
    }
  }
  private reviewSource(id: string, requireCurrent: boolean): Row {
    const { op, result, receiver } = this.receiverOperation(id), item = this.item(op.item), packet = this.packet(op.packet);
    const evidence = this.packetEvidence(packet);
    if (receiver?.phase !== 'returned' || !receiver.judgment || receiver.bindingHash !== receiver.judgment.bindingHash) throw new Error('original_receiver_judgment_unavailable');
    for (const ref of Object.values(receiver.blobs) as Row[]) this.blob(ref.sha256);
    this.blob(receiver.inputSha256); this.blob(receiver.systemSha256);
    if (requireCurrent && (item.current_packet !== op.packet || item.observation_conflict || !this.receiverCandidateCurrent(item) || !this.memberReceptionCurrent(item.id) || !this.integrationApplicability(op,receiver) || !this.pairedApplicability(op, receiver) || !this.effectiveSummary(item, packet).evidenceComplete || this.prerequisites(item).length)) throw new Error('queue_repair_source_no_longer_current');
    return { operation: id, packet: op.packet, receiver, candidate: evidence.manifest.candidate, context: evidence.context, result };
  }
  private supplementGuardInstalled(): boolean { return [['receiver_packet_material_guard', supplementGuard], ['receiver_supplement_lineage_guard', supplementLineageGuard]].every(([name, sql]) => (this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name!) as Row | undefined)?.sql === sql); }
  private receiverGuardsInstalled(): boolean { return (this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name IN ('receiver_record_guard','receiver_claim_guard')").get() as Row).n === 2; }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private event(kind: string, object: string, data: unknown): void { this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run(kind, object, JSON.stringify(data), now()); }
  private publicationBinding(id:string):Row|null{
    const row=this.db.prepare("SELECT data FROM events WHERE kind='authority_publication_bound' AND object=?").get('publication:'+id) as Row|undefined;if(!row)return null;
    const b=JSON.parse(row.data),{bindingSha256,...value}=b;if(hash(canonical(value))!==bindingSha256||!this.blob(bindingSha256).equals(Buffer.from(canonical(value))))throw new Error('publication_authority_binding_changed');return b;
  }
  private publicationCurrent(id:string){
    const state=this.publicationHistory(id),{op,receiver}=this.receiverOperation(id),item=this.item(op.item),packet=this.packet(op.packet),context=this.packetEvidence(packet).context;
    if(!state.prepared||op.status!=='complete'||receiver?.phase!=='returned'||receiver.executionKind!=='native_capture'||receiver.bindingHash!==state.prepared.bindingHash||item.current_packet!==op.packet||item.observation_conflict||!this.receiverCandidateCurrent(item)||!this.memberReceptionCurrent(item.id)||!this.integrationApplicability(op,receiver)||!this.effectiveSummary(item,packet).evidenceComplete)throw new Error('publication_source_no_longer_current');
    if(this.prerequisites(item).length)throw new Error('publication_prerequisites_unmet');
    if((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(context.scope.id) as Row|undefined)?.stopped)throw new Error('new_investment_stopped');
    if(this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(op.target))throw new Error('target_occupied_or_unknown');return {state,op,receiver};
  }
  private publicationAuthorization(id:string,observations:OwnerObservation[],held:boolean){
    if(!publicationGuardsCurrent(this.db))throw new Error('governed_publication_not_enabled');
    const {state,op,receiver}=this.publicationCurrent(id),p=parsePublicationPlan(this.blob(state.prepared.planSha256)),g=p.governance;
    if(p.operation!==id||p.store!==this.directory||!g)throw new Error('publication_authority_binding_required');
    const a=new AuthorityRecords(this.db,fn=>fn(),item=>this.authorityItem(item)),action=a.refreshReservedAction(g.authorityIntent,observations);
    if(action.role!=='background'||action.request.action!=='publish'||action.request.item!==op.item||action.binding?.packet!==op.packet||action.request.payloadSha256!==publicationAuthorityPayloadSha(p,state.prepared.documentSha256)||action.request.paths.length||action.executionKind!=='github'||a.configuration().profile.executorId!==p.actor.id)throw new Error('publication_exact_authority_required');
    const resources=this.resourceRecords(fn=>fn()),claims=g.resourceRequests.map(r=>held?resources.requireHeldForExecution(r,id,g.authorityIntent):resources.status(r));
    if(claims.some(r=>r.request.operation!==id||r.request.authorityIntent!==g.authorityIntent||r.request.actionSha256!==action.requestSha256||r.request.role!=='background'))throw new Error('publication_original_resource_mismatch');
    if(new Set(claims.map(r=>r.request.resourceRef)).size!==claims.length||canonical(claims.map(r=>r.request.resourceRef).sort())!==canonical([...action.request.resourceRefs].sort()))throw new Error('publication_resource_set_mismatch');
    if(this.db.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get()&&!claims.length)throw new Error('publication_configured_resource_required');
    const value={operation:id,item:op.item,packet:op.packet,planSha256:state.prepared.planSha256,documentSha256:state.prepared.documentSha256,receiverBindingHash:receiver.bindingHash,authorityIntent:g.authorityIntent,actionSha256:action.requestSha256,resourceRequests:g.resourceRequests},b={...value,bindingSha256:hash(canonical(value))},old=this.publicationBinding(id);
    if(old&&canonical(old)!==canonical(b))throw new Error('publication_authority_binding_changed');return {state,action,binding:b};
  }
  publicationResourceAdmission(id:string,observations:OwnerObservation[]){return this.transaction(()=>{
    const {binding}=this.publicationAuthorization(id,observations,false);if(!this.publicationBinding(id)){const bytes=Buffer.from(canonical((({bindingSha256,...rest})=>rest)(binding)));this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(binding.bindingSha256,bytes);this.event('authority_publication_bound','publication:'+id,binding);}return binding;
  });}
  private publicationResourceClaimGate(action:Row,request:ResourceRequest){
    const b=this.publicationBinding(request.operation);if(!b||b.authorityIntent!==action.requestId||b.actionSha256!==action.requestSha256||!b.resourceRequests.includes(resourceRequestHash(request)))throw new Error('publication_resource_binding_required');
    const {state}=this.publicationCurrent(request.operation);if(state.events.some((e:Row)=>['intent','recovered_intent','dispatch_prepared'].includes(e.kind)))throw new Error('publication_resource_original_execution_required');return b;
  }
  publicationDispatchPrepared(id:string,stage:'comment'|'status',data:Row,originals:Record<string,Buffer>,retrySource?:string){const result=this.transaction(()=>{
    const state=this.publicationHistory(id),b=this.publicationBinding(id),{receiver}=this.receiverOperation(id);
    if(!state.prepared||!b||!receiver||state.pendingDispatches.length||state.events.some((e:Row)=>e.directory===data.directory))throw new Error('publication_original_dispatch_unresolved');
    const basename=typeof data.directory==='string'?data.directory.split('/').at(-1):'';if(!basename||!/^http-[a-f0-9-]{36}$/.test(basename)||join(receiver.directory,basename)!==data.directory)throw new Error('publication_original_directory_required');
    const prior=state.stages[stage];if(stage==='status'&&state.stages.comment.lastState!=='verified')throw new Error('publication_detail_not_verified');
    if(prior.intent&&(!retrySource?.trim()||retrySource.length>2048||!prior.response?.rejected||prior.lastState==='verified'||prior.attempts>=3))throw new Error('publication_request_already_registered');
    const payload=stage==='comment'?{body:state.document.commentBody}:{...state.document.status,target_url:state.stages.comment.verified.remote.url};
    const endpoint=`repos/${state.document.candidate.repository}/${stage==='comment'?`issues/${state.document.candidate.pr}/comments`:`statuses/${state.document.candidate.H}`}`;
    if(data.endpoint!==endpoint||data.requestSha256!==hash(canonical(payload))||!originals.request||!originals.request.equals(Buffer.from(JSON.stringify(payload))))throw new Error('publication_dispatch_payload_changed');
    const blobs:Row={};for(const [name,bytes] of Object.entries(originals)){const sha256=hash(bytes);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256,bytes);this.blob(sha256);blobs[name]={sha256,bytes:bytes.length};}
    this.event('publication_dispatch_prepared','publication:'+id,{...data,stage,planSha256:b.planSha256,documentSha256:b.documentSha256,publicationBindingSha256:b.bindingSha256,...(retrySource?{retrySource}:{}),blobs});return this.publicationHistory(id);
  });this.publicationEffectCapabilities.set(data.directory,{operation:id,stage});return result;}
  publicationEffect<T>(id:string,stage:'comment'|'status',directory:string,observations:OwnerObservation[],effect:()=>T):T{
    const capability=this.publicationEffectCapabilities.get(directory);if(!capability||capability.operation!==id||capability.stage!==stage)throw new Error('publication_live_preparation_required');this.publicationEffectCapabilities.delete(directory);let invoked=false;
    try{return this.transaction(()=>{
      if(this.activePublicationEffect)throw new Error('publication_effect_already_active');const {state,binding}=this.publicationAuthorization(id,observations,true),prepared=state.pendingDispatches.find((x:Row)=>x.stage===stage&&x.directory===directory);
      if(!prepared||prepared.publicationBindingSha256!==binding.bindingSha256||state.pendingDispatches.length!==1)throw new Error('publication_original_dispatch_required');
      this.activePublicationEffect={operation:id,stage,directory,binding};try{invoked=true;const value=effect();if(value&&typeof (value as any).then==='function')throw new Error('publication_effect_must_be_synchronous');return value;}finally{this.activePublicationEffect=null;}
    });}catch(error){
      // Only this live controller can prove it never invoked the effect. A
      // saved error file (or a missing process record) cannot establish that.
      if(!invoked)try{this.transaction(()=>{const s=this.publicationHistory(id),p=s.pendingDispatches.find((p:Row)=>p.directory===directory&&p.stage===stage);if(!p)throw new Error('publication_original_dispatch_required');this.event('publication_dispatch_unstarted','publication:'+id,{directory,stage,preparedSha256:hash(canonical(p)),proof:'trusted_live_effect_not_invoked',reason:error instanceof Error?error.message:'publication_effect_rejected'});});}catch{}
      throw error;
    }
  }
  publicationRecoverDispatch(id:string,value:PublicationDispatchCapture){return this.transaction(()=>{
    const c=requirePublicationDispatchCapture(value),state=this.publicationHistory(id),prepared=state.pendingDispatches.find((x:Row)=>x.directory===c.directory);
    if(!prepared||c.processIdentity||hash(canonical(prepared))!==c.preparedSha256||prepared.planSha256!==state.prepared.planSha256||prepared.documentSha256!==state.prepared.documentSha256)throw new Error('publication_original_dispatch_binding_changed');
    const originals:Row={};for(const [name,bytes] of c.originals){const sha256=hash(bytes);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256,bytes);this.blob(sha256);originals['capture:'+name]={sha256,bytes:bytes.length};}
    this.event('publication_recovered_intent','publication:'+id,{...prepared,blobs:{...prepared.blobs,...originals},directory:c.directory,stage:prepared.stage,observedPid:c.observedPid,recoveredFromOriginalCapture:true,inputMayHaveBeenSubmitted:true,captureSha256:c.digest});return this.publicationHistory(id);
  });}
  publicationDispatchMaterial(id:string){return this.transaction(()=>{const s=this.publicationHistory(id);return s.pendingDispatches.map((p:Row)=>({prepared:p,request:this.blob(p.blobs.request.sha256)}));});}
  publicationOriginalDispatches(id:string){return this.transaction(()=>{
    const state=this.publicationHistory(id);return ['comment','status'].flatMap(stage=>{const intent=state.stages[stage].intent;if(!intent)return [];const prepared=state.events.find((e:Row)=>e.kind==='dispatch_prepared'&&e.stage===stage&&e.directory===intent.directory);if(!prepared)throw new Error('publication_original_dispatch_required');return [{prepared,request:this.blob(prepared.blobs.request.sha256),registered:state.stages[stage].started}];});
  });}
  /** Includes valid earlier unprofiled requests, using their immutable intent
   * and original request bytes. It never invents a governed dispatch event. */
  publicationReturnDispatches(id:string){return this.transaction(()=>this.publicationReturnOriginals(id));}
  private publicationReturnOriginals(id:string){
    const state=this.publicationHistory(id);if(!state.prepared)throw new Error('publication_return_original_publication_required');
    return ['comment','status'].map(stage=>{const s=state.stages[stage];if(!s.intent||!s.started||s.lastState!=='verified')throw new Error('publication_return_complete_publication_required');
      const endpoint=`repos/${state.document.candidate.repository}/${stage==='comment'?`issues/${state.document.candidate.pr}/comments`:`statuses/${state.document.candidate.H}`}`;
      const prepared=state.events.find((e:Row)=>e.kind==='dispatch_prepared'&&e.stage===stage&&e.directory===s.intent.directory)??{...s.intent,endpoint,legacyOriginalIntent:true};
      return {prepared,request:this.blob(s.intent.blobs.request.sha256),registered:s.started};});
  }
  publicationReturns(){return this.publicationReturnRecords(fn=>this.transaction(fn));}
  private publicationReturnRecords(transaction:<T>(f:()=>T)=>T){return new PublicationReturns(this.db,transaction,(operation,current)=>{
    const source=this.reviewSource(operation,current),{op,receiver:r}=this.receiverOperation(operation),state=this.publicationHistory(operation);
    if(op.status!=='complete'||r?.phase!=='returned'||!r.controllerReturned||r.executionKind!=='native_capture'||r.judgment.verdict!=='RETURN_FOR_WORK'||!state.prepared||state.prepared.bindingHash!==r.bindingHash||state.document.judgment!=='RETURN_FOR_WORK'||state.document.inputSha256!==r.inputSha256)throw new Error('publication_return_complete_original_required');
    for(const original of this.publicationReturnOriginals(operation))requirePublicationProcessEnded(original.registered.pid,original.registered.identity);
    const completed=r.blobs['completed.json'];if(!completed)throw new Error('publication_return_final_original_required');const receipt=JSON.parse(this.blob(completed.sha256).toString());
    if(typeof receipt.finalText!=='string'||receipt.inputSha256!==r.inputSha256)throw new Error('publication_return_final_original_changed');
    return {operation,item:op.item,packet:op.packet,candidate:source.candidate,context:source.context,judgment:r.judgment,fullFinal:receipt.finalText,fullFinalSha256:hash(receipt.finalText),inputSha256:r.inputSha256,bindingHash:r.bindingHash,publication:{id:state.document.publicationId,planSha256:state.prepared.planSha256,documentSha256:state.prepared.documentSha256,comment:state.stages.comment.verified.remote,status:state.stages.status.verified.remote,governance:state.plan.governance?'recorded_governed_plan':'historical_unprofiled',remoteSource:'original_verified_readback',liveRemoteAtRoleSend:false}};
  },id=>this.publicationReturnOriginals(id),(task,link)=>this.taskLinkRecords(fn=>fn()).material(task,link));}
  publicationRecordResult(id:string,values:PublicationDispatchCapture[]){return this.transaction(()=>{
    const state=this.publicationHistory(id),binding=this.publicationBinding(id);if(!binding||state.pendingDispatches.length||values.length!==2||!['comment','status'].every(stage=>state.stages[stage].lastState==='verified'))throw new Error('publication_verified_original_result_required');
    const captured=values.map(requirePublicationDispatchCapture);if(new Set(captured.map(c=>c.directory)).size!==2)throw new Error('publication_original_dispatch_duplicate');
    const stages=['comment','status'].map(stage=>{const original=state.stages[stage],prepared=state.events.find((e:Row)=>e.kind==='dispatch_prepared'&&e.directory===original.intent.directory),c=captured.find(c=>c.directory===original.intent.directory);
      if(!prepared||!c||c.phase!=='ended_possible'||c.preparedSha256!==hash(canonical(prepared))||prepared.publicationBindingSha256!==binding.bindingSha256||original.started?.pid!==c.observedPid||canonical(original.started?.identity??null)!==canonical(c.processIdentity??null))throw new Error('publication_original_result_capture_changed');
      const originals:Row={};for(const [name,bytes] of c.originals){const sha256=hash(bytes);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256,bytes);this.blob(sha256);originals[name]={sha256,bytes:bytes.length};}
      return {stage,directory:c.directory,preparedAt:prepared.at,requestSha256:prepared.requestSha256,remote:original.verified.remote,captureSha256:c.digest,originals};});
    const result={operation:id,publicationId:state.document.publicationId,publicationBindingSha256:binding.bindingSha256,planSha256:binding.planSha256,documentSha256:binding.documentSha256,authorityIntent:binding.authorityIntent,actionSha256:binding.actionSha256,judgment:state.document.judgment,stages,source:'verified_publication_original_capture',businessAcceptance:false},bytes=Buffer.from(canonical(result)),resultSha256=hash(bytes),old=state.events.find((e:Row)=>e.kind==='result_recorded');
    if(old){if(old.resultSha256!==resultSha256||!this.blob(resultSha256).equals(bytes))throw new Error('publication_original_result_changed');return {resultSha256,duplicate:true};}
    this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(resultSha256,bytes);this.event('publication_result_recorded','publication:'+id,{resultSha256,publicationBindingSha256:binding.bindingSha256});return {resultSha256,duplicate:false};
  });}
  private publicationResourceOutcome(operation:string,action:Row,claimedAt:string):ResourceOutcome{
    this.publicationOriginalProcessesEnded(operation);
    const state=this.publicationHistory(operation),binding=this.publicationBinding(operation),record=state.events.find((e:Row)=>e.kind==='result_recorded');
    if(!binding||!record||binding.authorityIntent!==action.requestId||binding.actionSha256!==action.requestSha256||record.publicationBindingSha256!==binding.bindingSha256)throw new Error('publication_verified_original_result_required');
    const proof=this.blob(record.resultSha256),value=JSON.parse(proof.toString());if(value.publicationBindingSha256!==binding.bindingSha256||value.stages.length!==2||value.stages.some((s:Row)=>!Number.isFinite(Date.parse(s.preparedAt))||Date.parse(s.preparedAt)<Date.parse(claimedAt)))throw new Error('publication_original_result_binding_changed');for(const stage of value.stages)for(const ref of Object.values(stage.originals) as Row[])this.blob(ref.sha256);
    return {state:'completed',source:value.source,executionKind:'external',proof};
  }
  private publicationOriginalProcessesEnded(operation:string){
    const state=this.publicationHistory(operation);
    for(const name of ['comment','status']){const stage=state.stages?.[name];if(!stage?.intent)throw new Error('publication_verified_original_result_required');requirePublicationProcessEnded(stage.started?.pid,stage.started?.identity);}
  }
  private publicationHistory(id: string): Row {
    const events = (this.db.prepare("SELECT kind,data,observed_at FROM events WHERE object=? AND kind LIKE 'publication_%' ORDER BY id").all(`publication:${id}`) as Row[]).map(e => ({ ...parse(e, 'data'), kind: e.kind.slice(12), at: e.observed_at }));
    const preparedIndex = events.findLastIndex(e => e.kind === 'prepared'), prepared = events[preparedIndex];
    if (!prepared) return { operation: id, prepared: null, stages: {}, events };
    for (const e of events) for (const ref of Object.values(e.blobs ?? {}) as Row[]) this.blob(ref.sha256);
    const stages: Row = {};
    for (const name of ['comment', 'status']) {
      const stage: Row = { attempts: 0 };
      for (const event of events.slice(preparedIndex + 1).filter(e => e.stage === name)) {
        if (['intent','recovered_intent'].includes(event.kind)) { Object.keys(stage).filter(k => k !== 'attempts').forEach(k => delete stage[k]); stage.attempts++; }
        stage[event.kind==='recovered_intent'?'intent':event.kind] = event;if(event.kind==='recovered_intent'&&event.observedPid)stage.started={pid:event.observedPid,recoveredFrom:'original_process_record'};
        if (['verified', 'problem'].includes(event.kind)) stage.lastState = event.kind;
      }
      stages[name] = stage;
    }
    const pendingDispatches=events.filter(e=>e.kind==='dispatch_prepared'&&!events.some(x=>x.directory===e.directory&&['intent','recovered_intent','dispatch_unstarted'].includes(x.kind)));
    return { operation: id, prepared, plan: JSON.parse(this.blob(prepared.planSha256).toString()), document: JSON.parse(this.blob(prepared.documentSha256).toString()), stages, events, pendingDispatches };
  }
  publicationState(id: string): Row { return this.transaction(() => this.publicationHistory(id)); }
  preparePublication(id: string, plan: Buffer, document: Buffer, allowUnsentRevision = false): Row {
    return this.transaction(() => {
      const { op, receiver } = this.receiverOperation(id), existing = this.publicationHistory(id);
      if (existing.prepared) {
        if (existing.prepared.planSha256 === hash(plan) && existing.prepared.documentSha256 === hash(document)) return existing;
        if (!allowUnsentRevision || existing.events.some((e: Row) => ['intent','recovered_intent','dispatch_prepared'].includes(e.kind)) || this.publicationBinding(id)) throw new Error('publication_plan_or_result_changed');
      }
      if (op.status !== 'complete' || receiver?.phase !== 'returned' || receiver.executionKind !== 'native_capture') throw new Error('publication_requires_complete_native_judgment');
      const body = JSON.parse(document.toString());
      if (body.operation !== id || body.inputSha256 !== receiver.inputSha256 || body.bindingHash !== receiver.bindingHash) throw new Error('publication_source_binding_mismatch');
      for (const b of [plan, document]) { this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(b), b); this.blob(hash(b)); }
      this.event('publication_prepared', `publication:${id}`, { publicationId: body.publicationId, planSha256: hash(plan), documentSha256: hash(document), packet: op.packet, bindingHash: receiver.bindingHash, priorUnsentPlanSha256: existing.prepared?.planSha256 ?? null });
      return this.publicationHistory(id);
    });
  }
  publicationEvent(id: string, kind: 'intent' | 'started' | 'response' | 'problem' | 'verified', stage: 'comment' | 'status', data: Row, originals: Record<string, Buffer> = {}, retrySource?: string): Row {
    if(!['intent','started','response','problem','verified'].includes(kind)||!['comment','status'].includes(stage))throw new Error('publication_event_kind_invalid');
    const action=() => {
      const state = this.publicationHistory(id), prior = state.stages[stage];
      if (!state.prepared) throw new Error('publication_not_prepared');
      const governed=Boolean(this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get());
      if(governed&&['intent','started'].includes(kind)&&(!this.activePublicationEffect||this.activePublicationEffect.operation!==id||this.activePublicationEffect.stage!==stage))throw new Error('publication_actual_effect_required');
      if (kind === 'intent') {
        if(governed){const prepared=state.pendingDispatches.find((p:Row)=>p.directory===this.activePublicationEffect!.directory);if(!prepared||data.directory!==prepared.directory||data.requestSha256!==prepared.requestSha256||canonical(data.remotePreflight)!==canonical(prepared.remotePreflight)||!originals.request||hash(originals.request)!==prepared.blobs.request.sha256)throw new Error('publication_original_dispatch_changed');}
        const { op, receiver } = this.receiverOperation(id), item = this.item(op.item), packet = this.packet(op.packet), context = this.packetEvidence(packet).context;
        if (op.status !== 'complete' || receiver?.phase !== 'returned' || receiver.bindingHash !== state.prepared.bindingHash || item.current_packet !== op.packet || item.observation_conflict || !this.receiverCandidateCurrent(item) || !this.memberReceptionCurrent(item.id) || !this.integrationApplicability(op,receiver) || !this.effectiveSummary(item, packet).evidenceComplete) throw new Error('publication_source_no_longer_current');
        if (this.prerequisites(item).length) throw new Error('publication_prerequisites_unmet');
        if ((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(context.scope.id) as Row | undefined)?.stopped) throw new Error('new_investment_stopped');
        if (this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(op.target)) throw new Error('target_occupied_or_unknown');
        if (stage === 'status' && state.stages.comment.lastState !== 'verified') throw new Error('publication_detail_not_verified');
        if (prior.intent && (!retrySource?.trim() || retrySource.length > 2048 || !prior.response?.rejected || prior.lastState === 'verified' || prior.attempts >= 3)) throw new Error('publication_request_already_registered');
      } else if (!prior.intent && kind !== 'problem') throw new Error('publication_intent_required');
      if (kind === 'started' && prior.started) throw new Error('publication_child_already_registered');
      if (kind === 'verified' && prior.lastState === 'verified' && canonical(prior.verified.remote) === canonical(data.remote)) return state;
      if (kind === 'problem' && prior.lastState === 'problem' && prior.problem.reason === data.reason) return state;
      if (kind === 'response' && prior.response) throw new Error('publication_response_already_recorded');
      const blobs: Row = {};
      for (const [name, b] of Object.entries(originals)) { const sha256 = hash(b); this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256, b); this.blob(sha256); blobs[name] = { sha256, bytes: b.length }; }
      if(kind==='intent'&&(queueFormatVersion(this.db)>=20||governed)){queueFeatureVersion(this.db);this.event('member_publication_admitted','publication:'+id,{stage,planSha256:state.prepared.planSha256,documentSha256:state.prepared.documentSha256,...(governed?{publicationBindingSha256:this.activePublicationEffect!.binding.bindingSha256}:{})});}
      if(kind==='started'&&governed)this.event('authority_publication_start_admitted','publication:'+id,{stage,publicationBindingSha256:this.activePublicationEffect!.binding.bindingSha256});
      this.event(`publication_${kind}`, `publication:${id}`, { ...data, stage, ...(retrySource ? { retrySource } : {}), blobs });
      return this.publicationHistory(id);
    };return this.activePublicationEffect?action():this.transaction(action);
  }
  private blob(h: string): Buffer {
    const row = this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(h) as Row | undefined;
    if (!row || hash(Buffer.from(row.bytes)) !== h) throw new Error('stored_evidence_hash_mismatch');
    return Buffer.from(row.bytes);
  }
  private item(id: string): Row { const r = this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Row | undefined; if (!r) throw new Error('queue_item_not_found'); return r; }
  private packet(id: number): Row { const r = this.db.prepare('SELECT * FROM packets WHERE id=?').get(id) as Row | undefined; if (!r) throw new Error('queue_packet_not_found'); return r; }
  private basePacketFingerprint(packet: Row, depth = 0): string {
    if (depth > 2) throw new Error('supplement_lineage_unverified');
    const summary = parse(packet, 'summary');
    if (summary.baseFingerprint) return summary.baseFingerprint;
    if (!summary.supplement) {
      // An old buggy importer could already have discarded a received chain.
      // Keep that history readable, but do not treat it as a new blank budget.
      if (this.db.prepare("SELECT 1 FROM packets WHERE item=? AND id<? AND json_type(summary,'$.supplement')='object'").get(packet.item, packet.id)) throw new Error('supplement_lineage_unverified');
      return packet.fingerprint;
    }
    const previous = this.packet(summary.supplement.previousPacket);
    if (previous.id >= packet.id || previous.item !== packet.item || ['manifest_hash', 'report_hash', 'context_hash'].some(k => previous[k] !== packet[k])) throw new Error('supplement_lineage_unverified');
    return this.basePacketFingerprint(previous, depth + 1);
  }
  private packetEvidence(packet: Row): { context: QueueContext; manifest: any; report: any } {
    const context = parseQueueContextBlob(this.blob(packet.context_hash)), manifest = JSON.parse(this.blob(packet.manifest_hash).toString()), report = JSON.parse(this.blob(packet.report_hash).toString());
    if(manifest.kind==='tongxu-development-task-source'||parse(packet,'summary').kind==='development-task')return this.taskRecords().evidence(packet);
    const references = [report.plan, ...report.inputs.map((i: any) => i.manifest), ...manifest.artifacts];
    if (report.failureOutput) references.push(report.failureOutput.stdout, report.failureOutput.stderr);
    for (const stage of report.stages) {
      if (stage.mergeOutput) references.push(stage.mergeOutput);
      for (const tool of stage.tools) for (const key of ['stdout', 'stderr', 'result', 'sandbox']) if (tool[key]) references.push(tool[key]);
    }
    for (const ref of references) this.blob(ref.sha256);
    const composition=parse(packet,'summary').composition;
    if(composition&&canonical(composeSubject(report,h=>this.blob(h)))!==canonical(composition))throw new Error('stored_composition_changed');
    const eventSources=parse(packet,'summary').eventSources;
    if(eventSources){
      if(!Array.isArray(eventSources)||!eventSources.length||eventSources.length>8||new Set(eventSources.map((r:Row)=>r.pr)).size!==eventSources.length)throw new Error('event_packet_material_invalid');
      const members=composition?currentMembers(composition):[manifest.candidate];
      for(const ref of eventSources){const source=storedEventMaterial(this.db,ref),member=members.find((c:Candidate)=>c.pr===ref.pr);if(!member||['repository','H','B','targetRef'].some(k=>source.candidate[k]!==member[k]))throw new Error('event_packet_candidate_mismatch');}
    }
    for (let s = parse(packet, 'summary').supplement; s; s = s.previous) {
      this.blob(s.priorJudgmentSha256);
      this.blob(s.priorInputSha256);
      for (const m of s.material) if (materialIdentity(this.blob(m.sha256)) !== m.identity) throw new Error('supplement_material_identity_changed');
    }
    const correction = parse(packet, 'summary').correction;
    if (correction) {
      const { sha256, ...binding } = correction;
      if (hash(canonical(binding)) !== sha256) throw new Error('receiver_correction_binding_changed');
      this.blob(correction.finalTextSha256); this.blob(correction.priorInputSha256); this.blob(correction.planSha256);
      for (const m of correction.material) this.blob(m.sha256);
    }
    const refutation=parse(packet,'summary').memberRefutation;if(refutation){if(!refutation.id||!refutation.sha256||hash(this.blob(refutation.sha256))!==refutation.sha256)throw new Error('member_refutation_material_changed');}
    return { context, manifest, report };
  }
  /** Explicit new evidence packet, never a retry of the prior native task. */
  supplementReceiver(id: string, fixed: { judgmentId: string; bindingHash: string; source: string; reason: string; material: Array<{ name: string; bytes: Buffer }> }): Row {
    return this.transaction(()=>this.supplementReceiverCurrent(id,fixed));
  }
  private supplementReceiverCurrent(id:string,fixed:{judgmentId:string;bindingHash:string;source:string;reason:string;material:Array<{name:string;bytes:Buffer}>},memberRefutation?:{id:string;sha256:string}):Row{
      if (queueFeatureVersion(this.db) < 6 || !this.supplementGuardInstalled()) throw new Error('receiver_supplements_not_enabled');
      const { op, receiver } = this.receiverOperation(id), item = this.item(op.item), packet = this.packet(op.packet), summary = parse(packet, 'summary');
      if (op.status !== 'complete' || receiver?.phase !== 'returned' || receiver.judgment?.verdict !== (memberRefutation?'RETURN_FOR_WORK':'INSUFFICIENT_EVIDENCE') || receiver.judgmentId !== fixed.judgmentId || receiver.bindingHash !== fixed.bindingHash || !receiver.controllerReturned) throw new Error('supplement_requires_completed_insufficient_judgment');
      this.packetEvidence(packet);
      for (const ref of Object.values(receiver.blobs) as Row[]) this.blob(ref.sha256);
      const material = fixed.material.map(m => ({ name: m.name, sha256: hash(m.bytes), bytes: m.bytes.length, identity: materialIdentity(m.bytes) }));
      if (!material.length || material.length > 30 || new Set(material.map(m => m.identity)).size !== material.length || material.reduce((n, m) => n + m.bytes, 0) > 768 * 1024) throw new Error('invalid_supplement_material');
      const identity = hash(canonical(material.map(m => m.identity).sort()));
      const known = (this.db.prepare("SELECT data FROM events WHERE kind='receiver_supplement_registered' AND object=? ORDER BY id").all(id) as Row[]).map(e => parse(e, 'data')).find(e => e.identity === identity);
      if (known) { this.packetEvidence(this.packet(known.packet)); return { ...known, duplicate: true, currentPacket: item.current_packet, modelDispatched: false }; }
      if (item.current_packet !== op.packet || item.observation_conflict || !this.receiverCandidateCurrent(item)) throw new Error('supplement_original_no_longer_current');
      if (this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(op.target)) throw new Error('target_occupied_or_unknown');
      if ((summary.supplement?.depth ?? 0) >= 2 || this.receiverDispatchCount(item.id) >= 3) throw new Error('supplement_three_batch_limit');
      const oldInput = JSON.parse(this.blob(receiver.inputSha256).toString()), delivered = new Set<string>();
      for (const object of [oldInput, oldInput.data, ...Object.values(oldInput.data.evidence), receiver.judgment]) delivered.add(materialIdentity(Buffer.from(JSON.stringify(object))));
      for (const m of [...oldInput.data.material, ...oldInput.data.sources]) delivered.add(materialIdentity(Buffer.from(m.text)));
      for (const output of oldInput.data.evidence.outputs) for (const ref of Object.values(output.originals) as Row[]) if (ref.encoding === 'utf8') delivered.add(materialIdentity(Buffer.from(ref.text)));
      for (let s = summary.supplement; s; s = s.previous) for (const m of s.material) delivered.add(m.identity);
      if (material.every(m => delivered.has(m.identity))) throw new Error('supplement_contains_no_new_material');
      const judgment = Buffer.from(JSON.stringify(receiver.judgment)), priorJudgmentSha256 = hash(judgment);
      for (const bytes of [judgment, ...fixed.material.map(m => m.bytes)]) { this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(bytes), bytes); this.blob(hash(bytes)); }
      const supplement = { depth: (summary.supplement?.depth ?? 0) + 1, previous: summary.supplement ?? null, previousPacket: op.packet, previousOperation: id, priorJudgmentSha256, priorInputSha256: receiver.inputSha256, priorBindingHash: receiver.bindingHash, priorJudgmentId: receiver.judgmentId, source: fixed.source, reason: fixed.reason, material, identity };
      const fingerprint = hash(canonical({ previous: packet.fingerprint, added: identity }));
      const inserted = this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id, fingerprint, packet.manifest_hash, packet.report_hash, packet.context_hash, JSON.stringify({ ...summary, baseFingerprint: this.basePacketFingerprint(packet), supplement,...(memberRefutation?{memberRefutation}:{}) }), now());
      const packetId = Number(inserted.lastInsertRowid);
      this.db.prepare('UPDATE items SET current_packet=? WHERE id=?').run(packetId, item.id);
      const result = { item: item.id, packet: packetId, previousPacket: op.packet, previousOperation: id, identity, fingerprint, depth: supplement.depth, mode: 'shadow', productionActionAllowed: false };
      this.event('receiver_supplement_registered', id, result);
      return { ...result, duplicate: false, currentPacket: packetId, modelDispatched: false };
  }
  import(packet: Packet): Row {
    return this.transaction(() => {
      if ((this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value !== packet.candidate.repository.toLowerCase()) throw new Error('queue_repository_mismatch');
      if(packet.summary.composition){this.requireCompositionMode();if(canonical(composeSubject(JSON.parse(packet.blobs.get(packet.reportHash)!.toString()),h=>{const b=packet.blobs.get(h);if(!b)throw new Error('composition_original_missing');return b;}))!==canonical(packet.summary.composition))throw new Error('composition_import_changed');}
      const id = candidateKey(packet.candidate, packet.context,packet.summary.composition);
      for (const [digest, bytes] of packet.blobs) { if (hash(bytes) !== digest) throw new Error('invalid_import_blob'); this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(digest, bytes); this.blob(digest); }
      this.db.prepare('INSERT OR IGNORE INTO items(id,candidate,context,created_at) VALUES(?,?,?,?)').run(id, JSON.stringify(packet.candidate), JSON.stringify(packet.context), now());
      const item = this.item(id), previous = item.current_packet ? this.packet(item.current_packet) : undefined;
      const priorSummary = parse(previous, 'summary'), previousBase = previous ? this.basePacketFingerprint(previous) : undefined;
      const known = this.db.prepare('SELECT 1 FROM observations WHERE item=? AND manifest_hash=? AND report_hash=? AND context_hash=?').get(id, packet.manifestHash, packet.reportHash, packet.contextHash);
      if (known) return { item: id, packet: item.current_packet, duplicate: true, currentPacket: item.current_packet, mode: 'shadow' };
      this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?)').run(id, packet.fingerprint, packet.manifestHash, packet.reportHash, packet.contextHash, now());
      const incoming = [packet.summary.observation, packet.summary.sourceObservation], watermark = [item.latest_observation, item.latest_source_observation];
      const order = incoming.map((value, i) => !value || !watermark[i] ? null : value < watermark[i] ? -1 : value > watermark[i] ? 1 : 0);
      // Conflict is a persistent state, not a property recomputed from the next pair.
      // Only an observation strictly beyond BOTH known watermarks can replace it.
      // Raw-byte novelty, equal times, new report IDs and one advancing dimension
      // cannot prove reconciliation. Keep raw hashes as evidence, not freshness.
      const jointlyNewer = incoming.every((value, i) => value && (!watermark[i] || value > watermark[i]));
      const conflict = Boolean(previous && (item.observation_conflict
        ? !jointlyNewer
        : order.includes(null) || (order.includes(-1) && order.includes(1)) || (order.every(n => n === 0) && previousBase !== packet.fingerprint)));
      const older = Boolean(previous && !conflict && order.includes(-1));
      const effectiveConflict = conflict;
      const maximum = incoming.map((value, i) => value && (!watermark[i] || value > watermark[i]) ? value : watermark[i] ?? null);
      this.db.prepare('UPDATE items SET latest_observation=?,latest_source_observation=?,observation_conflict=? WHERE id=?').run(maximum[0], maximum[1], effectiveConflict ? 1 : 0, id);
      // Deduplication is relative to the current state, not every fingerprint in history.
      if (previous && previousBase === packet.fingerprint && !item.observation_conflict && !conflict) {
        this.event(older ? 'older_duplicate_archived' : 'duplicate_observation_recorded', id, { packet: previous.id, observation: packet.summary.observation, sourceObservation: packet.summary.sourceObservation });
        return { item: id, packet: previous.id, duplicate: true, archived: older, currentPacket: item.current_packet, mode: 'shadow' };
      }
      // A fresh W1/W2 observation of this same candidate must not erase received
      // supplementary originals or reset the candidate's registered call budget.
      const supplement = priorSummary?.supplement, correction = priorSummary?.correction,eventSources=priorSummary?.eventSources,integration=priorSummary?.integration,memberRefutation=priorSummary?.memberRefutation;
      const inherited={...(supplement?{supplement}:{}),...(correction?{correction}:{}),...(eventSources?{eventSources}:{}),...(integration?{integration}:{}),...(memberRefutation?{memberRefutation}:{})};
      const fingerprint = Object.keys(inherited).length ? hash(canonical({ base: packet.fingerprint,...inherited })) : packet.fingerprint;
      const summary = Object.keys(inherited).length ? { ...packet.summary, baseFingerprint: packet.fingerprint,...inherited } : packet.summary;
      const inserted = this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(id, fingerprint, packet.manifestHash, packet.reportHash, packet.contextHash, JSON.stringify(summary), now());
      const packetId = Number(inserted.lastInsertRowid);
      if (!older && !conflict) this.db.prepare('UPDATE items SET current_packet=?,candidate=?,context=? WHERE id=?').run(packetId, JSON.stringify(packet.candidate), JSON.stringify(packet.context), id);
      this.event(conflict ? 'conflicting_observation_retained' : older ? 'older_observation_archived' : 'material_changed', id, { packet: packetId, fingerprint: packet.fingerprint });
      return { item: id, packet: packetId, duplicate: false, archived: older, observationConflict: effectiveConflict, currentPacket: this.item(id).current_packet, mode: 'shadow' };
    });
  }
  control(scope: string, kind: string, state: string, source: string): Row {
    if (!scope || scope.length > 128 || !source || source.length > 2048 || !['implementation', 'investment', 'merge'].includes(kind) || !['stopped', 'open'].includes(state)) throw new Error('invalid_shadow_control');
    return this.transaction(() => this.applyLocalControl(scope,kind,state,source));
  }
  scopeControls(){return new LocalScopeControls(this.db,fn=>this.transaction(fn),id=>this.authorityItem(id),(scope,kind,state,source)=>this.applyLocalControl(scope,kind,state,source));}
  private applyLocalControl(scope:string,kind:string,state:string,source:string):Row{
      const prior = this.db.prepare('SELECT * FROM controls WHERE scope=? AND kind=?').get(scope, kind) as Row | undefined;
      const revision = (prior?.revision ?? 0) + 1, at = now();
      this.db.prepare('INSERT INTO controls VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,kind) DO UPDATE SET stopped=excluded.stopped,revision=excluded.revision,source=excluded.source,requested_at=excluded.requested_at,effective_at=excluded.effective_at').run(scope, kind, state === 'stopped' ? 1 : 0, revision, source, at, at);
      this.event('shadow_control', scope, { kind, state, revision, source });
      return { scope, kind, state, revision, requestedAt: at, effectiveAt: at, effect: 'local_shadow_only', externalControl: 'unverified' };
  }
  private prerequisites(item: Row): string[] {
    const gaps: string[] = [], visiting = new Set<string>(), visited = new Set<string>();
    const walk = (row: Row) => {
      if (visiting.has(row.id)) { gaps.push('dependency_cycle'); return; }
      if (visited.has(row.id)) return;
      if (visited.size + visiting.size >= 1000) { gaps.push('dependency_scan_limit'); return; }
      visiting.add(row.id);
      if (row.observation_conflict) gaps.push(`observation_order_conflict:${row.id}`);
      for (const req of (parse(row, 'context') as QueueContext).requires.filter(r => r.blocks === 'shadow_review')) {
        const parent = this.db.prepare('SELECT * FROM items WHERE id=?').get(req.item) as Row | undefined;
        if (!parent || !parent.current_packet) { gaps.push(`missing_dependency:${req.item}`); continue; }
        const parentPacket = this.packet(parent.current_packet), candidate = parse(parent, 'candidate') as Candidate, summary = parse(parentPacket, 'summary');
        try { this.packetEvidence(parentPacket); } catch { gaps.push(`dependency_evidence_unreadable:${req.item}`); }
        if (candidate.H !== req.version) gaps.push(`dependency_version_mismatch:${req.item}`);
        if (req.type !== 'development' && req.type !== 'parent') gaps.push(`external_dependency_unverified:${req.item}`);
        if (!summary.evidenceComplete) gaps.push(`dependency_evidence_incomplete:${req.item}`);
        walk(parent);
      }
      visiting.delete(row.id); visited.add(row.id);
    };
    walk(item); return [...new Set(gaps)];
  }
  begin(id: string, run: string): Row {
    if (!run || run.length > 256 || run.includes('\0')) throw new Error('invalid_run_reference');
    return this.transaction(() => this.beginCurrent(id,run));
  }
  private beginCurrent(id:string,run:string):Row {
      const item = this.item(id);
      const existing = this.db.prepare('SELECT * FROM operations WHERE packet=?').get(item.current_packet) as Row | undefined;
      if (item.observation_conflict) return { blocked: ['observation_order_conflict'], originalOperation: existing?.id ?? null, next: existing?.status === 'running' ? 'evaluate_original_operation' : 'import_jointly_current_observation', mode: 'shadow' };
      if (existing) return { operation: existing.id, status: existing.status, duplicate: true, next: existing.status === 'merging' ? 'reconcile_original_merge' : existing.status === 'repairing' ? 'reconcile_original_repair' : existing.status === 'receiving' ? 'reconcile_original_receiver' : existing.status === 'running' ? 'evaluate_original_operation' : 'read_saved_result', mode: 'shadow' };
      const eventGaps=this.eventSourceGaps(item);if(eventGaps.length)return {blocked:eventGaps,next:'refresh_source_and_reconcile_material',mode:'shadow'};
      if (parse(this.packet(item.current_packet), 'summary').composition && !this.receiverCandidateCurrent(item)) return { blocked: ['composition_member_currentness_unverified'], next: 'import_jointly_current_observation', mode: 'shadow' };
      const context = parse(item, 'context') as QueueContext;
      if ((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(context.scope.id) as Row | undefined)?.stopped) return { blocked: ['new_investment_stopped'], mode: 'shadow' };
      const blocked = this.prerequisites(item); if (blocked.length) return { blocked, mode: 'shadow' };
      const candidate = parse(item, 'candidate'), target = candidate.kind==='development-task'?'task-investigation:'+item.id:targetKey(candidate);
      if (this.db.prepare('SELECT operation FROM claims WHERE target=?').get(target)) return { blocked: ['target_occupied_or_unknown'], mode: 'shadow' };
      const seats = Number((this.db.prepare("SELECT value FROM meta WHERE key='seats'").get() as Row).value);
      if ((this.db.prepare('SELECT COUNT(*) AS count FROM claims').get() as Row).count >= seats) return { blocked: ['reception_seats_full'], mode: 'shadow' };
      const generation = (this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM operations WHERE target=?').get(target) as Row).n + 1;
      const operation = randomUUID();
      this.db.prepare("INSERT INTO operations(id,item,packet,target,generation,run_ref,status,started_at) VALUES(?,?,?,?,?,?,'running',?)").run(operation, id, item.current_packet, target, generation, run, now());
      this.db.prepare('INSERT INTO claims VALUES(?,?,?)').run(target, operation, generation);
      this.event('shadow_evaluation_started', operation, { item: id, packet: item.current_packet, generation });
      return { operation, generation, status: 'running', mode: 'shadow', next: 'evaluate_original_operation', externalActionSent: false };
  }
  private schedulingCurrent(){
    if(!this.db.prepare("SELECT 1 FROM meta WHERE key='bounded_event_source_profile'").get())throw new Error('bounded_event_source_not_configured');
    const all=this.db.prepare('SELECT * FROM items ORDER BY created_at,id').all() as Row[];
    if(all.length>256)throw new Error('bounded_event_queue_limit');
    const rows:RankItem[]=all.map(item=>{
      const packet=this.packet(item.current_packet),summary=this.effectiveSummary(item,packet),candidate=parse(item,'candidate') as Candidate,context=parse(item,'context') as QueueContext;
      const op=this.db.prepare('SELECT * FROM operations WHERE packet=?').get(packet.id) as Row|undefined,result=parse(op,'result'),receiver=result?.receiver;
      const target=targetKey(candidate),active=Boolean(this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(target)),waiting=[...this.prerequisites(item),...this.eventSourceGaps(item)];
      let current=!item.observation_conflict&&this.receiverCandidateCurrent(item),stage:RankItem['stage']=!op||op.status==='running'?'evaluate':'receive',classification:RankItem['classification']='ordinary';const evidence:string[]=[];
      try{this.packetEvidence(packet);}catch{current=false;waiting.push('stored_evidence_unreadable');}
      if(!summary.evidenceComplete){stage='materials';waiting.push('required_evidence_incomplete');}
      if(op?.status==='repairing')stage='repair';else if(op?.status==='merging')stage='merge';
      if(receiver){
        if(receiver.phase==='returned'&&current){
          try{
            this.reviewSource(op!.id,true);evidence.push(receiver.inputSha256,receiver.blobs['stdout.ndjson'].sha256);
            if(receiver.judgment.verdict==='RETURN_FOR_WORK'){classification='verified_return';stage='repair';}
            else if(receiver.judgment.verdict==='ACCEPT_WITHIN_SCOPE'){classification='verified_finish';const publication=this.publicationHistory(op!.id);stage=['comment','status'].every(name=>publication.stages[name]?.lastState==='verified')?'merge':'publish';}
            else stage='materials';
          }catch{stage='materials';waiting.push('original_judgment_unverified');}
        }else if(op?.status==='receiving')stage='receive';else stage='materials';
      }
      const stops=this.db.prepare('SELECT kind FROM controls WHERE scope=? AND stopped=1').all(context.scope.id) as Row[];
      if(stops.some(s=>s.kind==='investment'))waiting.push('new_investment_stopped');
      if(stage==='repair'&&stops.some(s=>s.kind==='implementation'))waiting.push('implementation_stopped');
      if(stage==='merge'&&stops.some(s=>s.kind==='merge'))waiting.push('merge_stopped');
      // This selector starts only the existing local evaluation. Other stages
      // remain concrete pending work for their separately bound consumers.
      if(['exact_merge_result_verified','actual_merge_result_verified'].includes(result?.merge?.phase))stage='finished';
      if(stage!=='evaluate'&&stage!=='finished')waiting.push(stage==='materials'?'material_or_arrangement_required':'bound_role_consumer_required:'+stage);
      let priority=0;
      const prefRow=this.db.prepare("SELECT data FROM events WHERE kind='source_preference_applied' AND json_extract(data,'$.preference.item')=? ORDER BY id DESC LIMIT 1").get(item.id) as Row|undefined;
      if(prefRow){const record=parse(prefRow,'data'),pref=parseQueuePreference(this.blob(record.sha256));if(pref.item!==item.id||canonical(pref)!==canonical(record.preference))throw new Error('stored_queue_preference_changed');priority=pref.priority;evidence.push(record.sha256);if(pref.mainIncident)classification='adopted_main_incident';}
      let estimatedCost:number|null=null;
      try{const report=JSON.parse(this.blob(packet.report_hash).toString()),tools=report.stages.flatMap((s:Row)=>s.tools);if(tools.length&&tools.every((t:Row)=>Number.isFinite(t.durationMs)&&t.durationMs>=0)){estimatedCost=tools.reduce((n:number,t:Row)=>n+t.durationMs,0);evidence.push(packet.report_hash);}}catch{}
      return {item:item.id,packet:packet.id,H:candidate.H,createdAt:item.created_at,current,waiting:[...new Set(waiting)],target,active,stage,classification,priority,estimatedCost,requires:context.requires.map(r=>({item:r.item,H:r.version})),evidence};
    });
    const history=(this.db.prepare("SELECT data FROM events WHERE kind='queue_ranked_evaluation_started' ORDER BY id DESC LIMIT 3").all() as Row[]).reverse().map(e=>parse(e,'data').history as SelectionHistory);
    return rankQueue(rows,history,Date.now());
  }
  scheduling(){return this.transaction(()=>this.schedulingCurrent());}
  selectEvaluation(run:string):Row{
    if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(run))throw new Error('selection_run_reference_invalid');
    return this.transaction(()=>{
      const prior=this.db.prepare("SELECT data FROM events WHERE kind='queue_ranked_evaluation_started' AND object=?").get('selection:'+run) as Row|undefined;
      if(prior)return {...parse(prior,'data'),duplicate:true};
      if(!this.db.prepare("SELECT 1 FROM meta WHERE key='bounded_event_source_profile'").get())throw new Error('bounded_event_source_not_configured');
      const original=this.db.prepare("SELECT id FROM operations WHERE status='running' ORDER BY started_at,id LIMIT 1").get() as Row|undefined;
      if(original)return {operation:original.id,duplicate:true,recovery:'evaluate_original_operation',modelTasksStarted:0};
      const ranking=this.schedulingCurrent();
      const selected=ranking.selected;if(!selected)return {selected:null,waiting:ranking.items.map(r=>({item:r.item,stage:r.stage,reasons:r.reasons})),modelTasksStarted:0};
      const started=this.beginCurrent(selected.item,run);if(started.blocked)return started;
      const record={...started,item:selected.item,packet:selected.packet,reasons:selected.reasons,policy:ranking.policy,history:{item:selected.item,class:selected.rank<2?'urgent':'ordinary',selectedAt:now()},modelTasksStarted:0};
      this.event('queue_ranked_evaluation_started','selection:'+run,record);return record;
    });
  }
  evaluate(id: string): Row {
    return this.transaction(() => {
      const op = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined;
      if (!op) throw new Error('operation_not_found');
      if (op.status === 'repairing') throw new Error('original_repair_pending');
      if (op.status === 'merging') throw new Error('original_managed_merge_pending');
      if (op.status === 'receiving') throw new Error('original_receiver_pending');
      if (op.status === 'messaging') throw new Error('original_message_resource_consumer_pending');
      if (op.status === 'complete') return { operation: id, duplicate: true, ...this.currentReceiverResult(op, parse(op, 'result')) };
      const claim = this.db.prepare('SELECT * FROM claims WHERE target=?').get(op.target) as Row | undefined;
      if (!claim || claim.operation !== id || claim.generation !== op.generation) throw new Error('operation_claim_mismatch');
      const item = this.item(op.item), packet = this.packet(op.packet);
      // A damaged unrelated candidate must not block this operation's intact evidence.
      const { context, manifest, report } = this.packetEvidence(packet);
      const summary = this.effectiveSummary(item, packet), gaps = [...summary.gaps, ...this.prerequisites({ ...item, context: JSON.stringify(context) }), 'independent_receiver_unavailable', 'production_authorization_unverified', 'pending_publish', 'live_candidate_and_rules_not_rechecked'];
      if (item.current_packet !== op.packet) gaps.push('newer_material_requires_own_evaluation');
      const controls = this.db.prepare('SELECT kind,stopped,revision FROM controls WHERE scope=? ORDER BY kind').all(context.scope.id);
      const result = { mode: 'shadow', status: 'evaluated', item: item.id, packet: op.packet, generation: op.generation, candidate: manifest.candidate, tree: summary.tree, evidenceComplete: summary.evidenceComplete, businessCorrectness: report.businessCorrectness, independentReception: 'pending', permissionModes: { shadow: 'active', perAction: 'unavailable', delegated: 'unavailable' }, productionActionAllowed: false, externalActionSent: false, gaps: [...new Set(gaps)], controls, originalOperations: summary.originalOperations, limitations: summary.limitations, next: 'review_fixed_materials_and_resolve_reported_gaps' };
      this.db.prepare("UPDATE operations SET status='complete',finished_at=?,result=? WHERE id=? AND status='running'").run(now(), JSON.stringify(result), id);
      this.db.prepare('DELETE FROM claims WHERE target=? AND operation=? AND generation=?').run(op.target, id, op.generation);
      this.event('shadow_evaluation_completed', id, { packet: op.packet, generation: op.generation });
      return { operation: id, ...result };
    });
  }
  receiverEvidence(id: string): Row {
    return this.transaction(() => {
      const { op } = this.receiverOperation(id), packet = this.packet(op.packet);
      const { context, manifest, report } = this.packetEvidence(packet);
      if(manifest.kind==='tongxu-development-task-source')throw new Error('development_task_requires_formal_candidate');
      const integration=this.integrationMaterial(packet,true,id);
      const outputs = report.stages.flatMap((stage: Row) => stage.tools.map((tool: Row) => ({ stage: stage.index, tool: tool.id,
        originals: Object.fromEntries(['stdout', 'stderr', 'result', 'sandbox'].filter(k => tool[k]).map(k => {
          const bytes = this.blob(tool[k].sha256); let text: string, encoding: string;
          try { text = new TextDecoder('utf8', { fatal: true }).decode(bytes); encoding = 'utf8'; } catch { text = bytes.toString('base64'); encoding = 'base64'; }
          return [k, { ...tool[k], encoding, text }];
        })) })));
      const supplements = [];
      for (let s = parse(packet, 'summary').supplement; s; s = s.previous) supplements.unshift({ ...s, previous: undefined, priorJudgment: JSON.parse(this.blob(s.priorJudgmentSha256).toString()), material: s.material.map((m: Row) => ({ ...m, text: new TextDecoder('utf8', { fatal: true }).decode(this.blob(m.sha256)) })) });
      const correction = parse(packet, 'summary').correction,memberRefutation=this.memberRefutationEvidence(packet,true);
      return { ...(memberRefutation?{memberRefutation}:{}),operation: id, packet: op.packet, fingerprint: packet.fingerprint, context, manifest, report, plan: JSON.parse(this.blob(report.plan.sha256).toString()), outputs,...(integration?{integration}:{}),
        ...(correction ? { correction: { ...correction, originalFinalText: this.blob(correction.finalTextSha256).toString(), material: correction.material.map((m: Row) => ({ ...m, text: new TextDecoder('utf8', { fatal: true }).decode(this.blob(m.sha256)) })), originalResultIsValidJudgment: false } } : {}),
        ...(parse(packet,'summary').composition?{composition:parse(packet,'summary').composition}:{}),
        sourceEvents:(parse(packet,'summary').eventSources??[]).map((r:Row)=>storedEventMaterial(this.db,r)),
        ...(supplements.length ? { supplements } : {}),
        ...(this.pairedPrerequisite(op.item) ? { prerequisite: this.pairedPrerequisite(op.item) } : {}),
        sourceArtifactScope: 'W1 artifact index included; selected exact-H source and reports supplied separately. Unprovided artifacts are not reviewed.' };
    });
  }
  registerPair(plan: Buffer, firstItem: string, secondItem: string, source: string): Row {
    return this.transaction(() => {
      const id = hash(plan), prior = this.db.prepare("SELECT data FROM events WHERE kind='pair_registered'").get() as Row | undefined;
      if (prior) { const p = parse(prior, 'data'); if (p.id !== id) throw new Error('pair_already_bound'); this.blob(id); return { ...p, duplicate: true }; }
      const version = queueFeatureVersion(this.db);
      if (![6, 8, 9, 10, 11].includes(version) || !this.supplementGuardInstalled() || !this.receiverGuardsInstalled()) throw new Error('pair_requires_idle_format6');
      if (!source?.trim() || source.length > 2048 || firstItem === secondItem) throw new Error('invalid_pair_scope');
      const first = this.item(firstItem), second = this.item(secondItem), ac = parse(first, 'context'), bc = parse(second, 'context');
      if (canonical(ac.scope) !== canonical(bc.scope) || targetKey(parse(first, 'candidate')) === targetKey(parse(second, 'candidate'))) throw new Error('pair_requires_same_scope_distinct_targets');
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n || (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n) throw new Error('pair_requires_idle_queue');
      const fixed = (i: Row) => {
        const p = this.packet(i.current_packet); this.packetEvidence(p);
        if (i.observation_conflict || !this.receiverCandidateCurrent(i) || !this.effectiveSummary(i, p).evidenceComplete) throw new Error('pair_current_material_unverified');
        return { item: i.id, packet: p.id, fingerprint: p.fingerprint, candidate: parse(i, 'candidate') };
      };
      const requested = JSON.parse(plan.toString());
      if (![requested.first?.sha256, requested.second?.sha256].every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h))) throw new Error('pair_receiver_plan_binding_missing');
      const record = { id, source, first: { ...fixed(first), planSha256: requested.first.sha256 }, second: { ...fixed(second), planSha256: requested.second.sha256 }, schemaVersion: 1, scope: ac.scope };
      for (const f of [record.first, record.second]) {
        const prior = this.db.prepare('SELECT result FROM operations WHERE item=? AND packet=?').get(f.item, f.packet) as Row | undefined, r = parse(prior, 'result')?.receiver;
        if (r && r.planSha256 !== f.planSha256) throw new Error('paired_existing_receiver_plan_changed');
      }
      this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(id, plan);
      this.db.exec(pairPlanGuard + ';' + pairGuard + ';');setQueueFeatureVersion(this.db,version >= 8 ? version : 7); this.event('pair_registered', 'pair:' + id, record);
      return { ...record, duplicate: false };
    });
  }
  private pairFor(item: string): Row | undefined {
    const r = this.db.prepare("SELECT data FROM events WHERE kind='pair_registered' AND (json_extract(data,'$.first.item')=? OR json_extract(data,'$.second.item')=?)").get(item, item) as Row | undefined;
    if (!r) return undefined;
    const p = parse(r, 'data'); this.blob(p.id);
    for (const [name, sql] of [['pair_receiver_stage_guard', pairGuard], ['pair_receiver_plan_guard', pairPlanGuard]]) if ((this.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name!) as Row | undefined)?.sql !== sql) throw new Error('pair_storage_guard_missing');
    return p;
  }
  private pairFixed(p: Row, side: 'first' | 'second'): Row {
    const f = p[side], i = this.item(f.item), packet = this.packet(f.packet);
    if (i.current_packet !== f.packet || packet.fingerprint !== f.fingerprint || i.observation_conflict || !this.receiverCandidateCurrent(i) || canonical(parse(i, 'candidate')) !== canonical(f.candidate)) throw new Error('paired_candidate_or_material_changed');
    this.packetEvidence(packet); return i;
  }
  private pairedPrerequisite(item: string): Row | undefined {
    const p = this.pairFor(item); if (!p) return undefined;
    this.pairFixed(p, p.first.item === item ? 'first' : 'second');
    if (p.first.item === item) return undefined;
    this.pairFixed(p, 'first');
    const op = this.db.prepare('SELECT * FROM operations WHERE item=? AND packet=?').get(p.first.item, p.first.packet) as Row | undefined;
    const r = op && parse(op, 'result')?.receiver;
    if (!op || op.status !== 'complete' || r?.phase !== 'returned' || r.judgment?.verdict !== 'ACCEPT_WITHIN_SCOPE') throw new Error('paired_upstream_reception_pending_or_not_accepted');
    if(!this.memberReceptionCurrent(op.item)||!this.integrationApplicability(op,r))throw new Error('paired_upstream_new_member_evidence_requires_reception');
    for (const ref of Object.values(r.blobs ?? {}) as Row[]) this.blob(ref.sha256);
    if (r.planSha256 !== p.first.planSha256) throw new Error('paired_upstream_plan_changed');
    this.blob(r.inputSha256); this.blob(r.systemSha256); this.blob(r.planSha256);
    const receipt = { pair: p.id, item: p.first.item, packet: op.packet, candidate: p.first.candidate, ...(r.subject?{subject:r.subject,subjectSha256:r.subjectSha256}:{}), operation: op.id, bindingHash: r.bindingHash, planSha256: r.planSha256, judgment: r.judgment, inputSha256: r.inputSha256, executionKind: r.executionKind, reportSha256: hash(r.judgment.report) };
    return { ...receipt, receiptSha256: hash(canonical(receipt)) };
  }
  pairedStatus(id: string): Row {
    return this.transaction(() => {
      const r = this.db.prepare("SELECT data FROM events WHERE kind='pair_registered' AND object=?").get('pair:' + id) as Row | undefined;
      if (!r) throw new Error('pair_not_found');
      const p = parse(r, 'data'); let prerequisite, blocked: string | null = null;
      try { prerequisite = this.pairedPrerequisite(p.second.item); } catch (e) { blocked = e instanceof Error ? e.message : 'pair_unknown'; }
      const operations = (this.db.prepare('SELECT * FROM operations WHERE packet IN (?,?) ORDER BY started_at,id').all(p.first.packet, p.second.packet) as Row[]).map(o => ({ ...o, result: this.currentReceiverResult(o, parse(o, 'result') ?? null) }));
      return { ...p, prerequisite: prerequisite ?? null, blocked, operations, productionActionAllowed: false };
    });
  }
  inspectPairedMaterial(id: string): Row {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT data FROM events WHERE kind='pair_registered' AND object=?").get('pair:' + id) as Row | undefined;
      if (!row) throw new Error('pair_not_found');
      const p = parse(row, 'data'), item = this.pairFixed(p, 'second'), packet = this.packet(p.second.packet);
      const summary = this.effectiveSummary(item, packet);
      return { kind: 'paired-local-material-inspection', item: item.id, packet: packet.id, fingerprint: packet.fingerprint, candidate: parse(item, 'candidate'), evidenceComplete: summary.evidenceComplete, gaps: [...summary.gaps, ...this.prerequisites(item)], localMaterialInspected: true, newModelTasks: 0, productionActionAllowed: false };
    });
  }
  private pairPlanCheck(op: Row, planSha256: string): void {
    const p = this.pairFor(op.item); if (!p) return;
    const f = p.first.item === op.item ? p.first : p.second;
    if (op.packet !== f.packet || planSha256 !== f.planSha256) throw new Error('paired_receiver_plan_changed');
  }
  pairNote(id: string, phase: 'independent_inspection' | 'shared_waiting' | 'shared_consumed', data: Row): void {
    this.transaction(() => {
      const object = 'pair:' + id, kind = 'pair_' + phase;
      if (!this.db.prepare("SELECT 1 FROM events WHERE kind='pair_registered' AND object=?").get(object)) throw new Error('pair_not_found');
      const previous = this.db.prepare('SELECT data FROM events WHERE object=? AND kind=? ORDER BY id DESC LIMIT 1').get(object, kind) as Row | undefined;
      if (!previous || canonical(parse(previous, 'data')) !== canonical(data)) this.event(kind, object, data);
    });
  }
  private pairedApplicability(op: Row, receiver: Row): boolean {
    try { this.pairPlanCheck(op, receiver.planSha256); return canonical(this.pairedPrerequisite(op.item) ?? null) === canonical(receiver.prerequisite ?? null); } catch { return false; }
  }
  private receiverOperation(id: string): { op: Row; result: Row; receiver: Row | undefined } {
    const op = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined;
    if (!op) throw new Error('operation_not_found');
    const result = parse(op, 'result'); return { op, result, receiver: result?.receiver };
  }
  receiverState(id: string): Row {
    this.requireReceiverMode();
    return this.transaction(() => {
      const { op, result, receiver } = this.receiverOperation(id);
      if (receiver) for (const ref of Object.values(receiver.blobs ?? {}) as Row[]) this.blob(ref.sha256);
      return { operation: id, status: op.status, result: this.currentReceiverResult(op, result), receiver, currentPacket: this.item(op.item).current_packet,
        ...(receiver ? { input: this.blob(receiver.inputSha256), system: this.blob(receiver.systemSha256), plan: this.blob(receiver.planSha256),...(receiver.promptAssemblySha256?{promptAssembly:this.blob(receiver.promptAssemblySha256)}:{}) } : {}) };
    });
  }
  private receiverGate(op: Row): void {
    const item = this.item(op.item), packet = this.packet(op.packet), { context } = this.packetEvidence(packet);
    if(parse(packet,'summary').composition)this.requireCompositionMode();
    this.basePacketFingerprint(packet); this.pairedPrerequisite(op.item);this.memberRefutationEvidence(packet,true);
    if(!this.memberReceptionCurrent(item.id))throw new Error('member_return_requires_repair_or_refutation_reception');
    if (item.current_packet !== op.packet || item.observation_conflict || !this.effectiveSummary(item, packet).evidenceComplete || !this.receiverCandidateCurrent(item)) throw new Error('receiver_current_material_unverified');
    if (this.prerequisites(item).length) throw new Error('receiver_prerequisites_unmet');
    if ((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(context.scope.id) as Row | undefined)?.stopped) throw new Error('new_investment_stopped');
    const version = queueFeatureVersion(this.db);
    if (version === 5) throw new Error('receiver_supplements_require_format6');
    if (version >= 6 && this.receiverDispatchCount(item.id) >= 3) throw new Error('receiver_three_batch_limit');
  }
  private receiverDispatchCount(item: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE item=? AND json_extract(result,'$.receiver.dispatchRegisteredAt') IS NOT NULL").get(item) as Row).n;
  }
  /** Later phase of the same operation; no second queue or automatic retries. */
  reserveReceiver(id: string, fixed: { plan: Buffer; input: Buffer; system: Buffer; promptAssembly?:Buffer;bindingHash: string; judgmentId: string; fingerprint: string; executionKind: string },observations:OwnerObservation[]=[]): Row {
    this.requireReceiverMode();
    if (!this.receiverGuardsInstalled()) throw new Error('receiver_storage_guards_missing_enable_when_idle');
    if (queueFeatureVersion(this.db) >= 6 && !this.supplementGuardInstalled()) throw new Error('receiver_supplement_guard_missing_enable_when_idle');
    return this.transaction(() => {
      const { op, result, receiver } = this.receiverOperation(id);
      if (receiver) {
        if (receiver.planSha256 !== hash(fixed.plan)) throw new Error('receiver_plan_changed');
        return { duplicate: true, receiver };
      }
      if (op.status !== 'complete' || result?.status !== 'evaluated' || this.packet(op.packet).fingerprint !== fixed.fingerprint) throw new Error('receiver_shadow_evaluation_required');
      this.receiverGate(op);
      this.pairPlanCheck(op, hash(fixed.plan));
      const prerequisite = this.pairedPrerequisite(op.item);
      if (prerequisite && (prerequisite.executionKind !== fixed.executionKind || canonical(JSON.parse(fixed.input.toString()).data.evidence.prerequisite) !== canonical(prerequisite))) throw new Error('paired_input_prerequisite_mismatch');
      if (this.db.prepare('SELECT operation FROM claims WHERE target=?').get(op.target)) throw new Error('target_occupied_or_unknown');
      const seats = Number((this.db.prepare("SELECT value FROM meta WHERE key='seats'").get() as Row).value);
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n >= seats) throw new Error('reception_seats_full');
      const generation = (this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM operations WHERE target=?').get(op.target) as Row).n + 1;
      for (const bytes of [fixed.plan, fixed.input, fixed.system]) this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(bytes), bytes);
      if(fixed.promptAssembly){const assembly=JSON.parse(fixed.promptAssembly.toString());inspectRolePrompt(assembly,'receiver');if(assembly.system!==fixed.system.toString()||JSON.parse(fixed.input.toString()).binding.promptAssemblySha256!==hash(fixed.promptAssembly))throw new Error('receiver_prompt_assembly_binding_mismatch');this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(fixed.promptAssembly),fixed.promptAssembly);}
      const composition=parse(this.packet(op.packet),'summary').composition as Composition|undefined;
      if(composition){this.requireCompositionMode();const input=JSON.parse(fixed.input.toString());if(input.binding.subjectSha256!==composition.sha256||canonical(input.binding.subject)!==canonical(composition.subject)||canonical(input.data.evidence.composition)!==canonical(composition))throw new Error('receiver_composition_input_mismatch');}
      const correction=parse(this.packet(op.packet),'summary').correction;
      if(correction){this.requireCorrections();const input=JSON.parse(fixed.input.toString());if(input.binding.correctionSha256!==correction.sha256||input.data.evidence.correction?.sha256!==correction.sha256||input.data.evidence.correction.originalFinalText!==this.blob(correction.finalTextSha256).toString())throw new Error('receiver_correction_input_mismatch');}
      const sourceEvents=(parse(this.packet(op.packet),'summary').eventSources??[]).map((r:Row)=>storedEventMaterial(this.db,r));
      if(this.eventSourceStates(this.item(op.item)).some(s=>s.registered)&&canonical(JSON.parse(fixed.input.toString()).data.evidence.sourceEvents)!==canonical(sourceEvents))throw new Error('receiver_event_source_input_mismatch');
      const integration=this.integrationMaterial(this.packet(op.packet),true,op.id),input=JSON.parse(fixed.input.toString());if(integration&&(input.binding.integrationSha256!==integration.sha256||input.binding.memberReturnEvidenceSha256!==integration.memberReturnEvidenceSha256||input.binding.memberRepairEvidenceSha256!==integration.memberRepairEvidenceSha256||canonical(input.data.evidence.integration)!==canonical(integration)))throw new Error('receiver_integration_input_mismatch');
      const refutation=this.memberRefutationEvidence(this.packet(op.packet),true);if(refutation&&(input.binding.memberRefutationSha256!==refutation.sha256||canonical(input.data.evidence.memberRefutation)!==canonical(refutation)))throw new Error('member_refutation_input_mismatch');
      const governance=JSON.parse(fixed.plan.toString()).governance;
      const record = { ...(governance?{authorityIntent:governance.authorityIntent,resourceRequests:governance.resourceRequests}:{}),...(refutation?{memberRefutationSha256:refutation.sha256}:{}),judgmentId: fixed.judgmentId, bindingHash: fixed.bindingHash, contractVersion: 6, packetFingerprint: fixed.fingerprint, eventSourcePacket:op.packet,planSha256: hash(fixed.plan), inputSha256: hash(fixed.input), systemSha256: hash(fixed.system),
        ...(integration?{integrationSha256:integration.sha256,memberReturnEvidenceSha256:integration.memberReturnEvidenceSha256,...(integration.memberRepairEvidenceSha256?{memberRepairEvidenceSha256:integration.memberRepairEvidenceSha256}:{})}:{}),
        ...(fixed.promptAssembly?{promptAssemblySha256:hash(fixed.promptAssembly)}:{}),
        ...(correction ? { correctionSha256: correction.sha256, correctionOf: correction.previousOperation } : {}),
        ...(composition?{subject:composition.subject,subjectSha256:composition.sha256}:{}),
        ...(prerequisite ? { prerequisite } : {}), executionKind: fixed.executionKind, controllerPid: process.pid, controllerReturned: false, phase: 'reserved', registeredAt: now(), directory: join(this.directory, `receiver-${id}`) };
      this.integrationAdmission(op,'receiving',this.receiverAuthorityAdmission(op,record,fixed.plan,observations));this.db.prepare("UPDATE operations SET status='receiving',generation=?,result=?,finished_at=NULL WHERE id=?").run(generation, JSON.stringify({ ...result, generation, shadowEvaluation: result, independentReception: 'running_or_unknown', receiver: record }), id);
      this.db.prepare('INSERT INTO claims VALUES(?,?,?)').run(op.target, id, generation);
      this.event('receiver_reserved', id, { generation, judgmentId: record.judgmentId, bindingHash: record.bindingHash });
      return { duplicate: false, receiver: record };
    });
  }
  private dispatchReceiver(id: string, bindingHash: string,observations:OwnerObservation[]): void {
      if (!this.receiverGuardsInstalled()) throw new Error('receiver_storage_guards_missing_enable_when_idle');
      const { op, result, receiver } = this.receiverOperation(id);
      if (op.status !== 'receiving' || receiver?.phase !== 'reserved' || receiver.bindingHash !== bindingHash) throw new Error('receiver_dispatch_already_registered');
      this.pairPlanCheck(op, receiver.planSha256); this.receiverGate(op); if (!this.pairedApplicability(op, receiver)) throw new Error('paired_prerequisite_changed_before_dispatch'); this.receiverClaim(op); receiver.phase = 'dispatch_registered'; receiver.dispatchRegisteredAt = now();
      result.externalActionSent = receiver.executionKind === 'fixture' ? false : 'unknown'; result.externalActionKind = 'readonly_model_request'; result.externalProductionActionSent = false;
      this.integrationAdmission(op,'receiving',this.receiverAuthorityAdmission(op,receiver,this.blob(receiver.planSha256),observations));this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result), id); this.event('receiver_dispatch_registered', id, { bindingHash });
  }
  receiverDispatch(id:string,bindingHash:string,observations:OwnerObservation[]=[]):void{this.transaction(()=>this.dispatchReceiver(id,bindingHash,observations));}
  receiverEffect<T>(id:string,bindingHash:string,observations:OwnerObservation[],effect:()=>T):T{
    return this.transaction(()=>{this.dispatchReceiver(id,bindingHash,observations);return effect();});
  }
  receiverControllerReturned(id: string): void {
    this.transaction(() => {
      const { result, receiver } = this.receiverOperation(id);
      if (receiver?.controllerPid !== process.pid) throw new Error('receiver_controller_mismatch');
      receiver.controllerReturned = true; this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result), id);
    });
  }
  private receiverClaim(op: Row): void {
    const c = this.db.prepare('SELECT * FROM claims WHERE target=?').get(op.target) as Row | undefined;
    if (!c || c.operation !== op.id || c.generation !== op.generation) throw new Error('operation_claim_mismatch');
  }
  private eventSourceStates(item:Row):Row[]{if(parse(item,'candidate').kind==='development-task')return [];const composition=parse(this.packet(item.current_packet),'summary').composition;return (composition?currentMembers(composition):[parse(item,'candidate')]).map((c:Candidate)=>currentEventSource(this.db,effectiveEventCandidate(c,item.latest_source_observation),item.id,item.current_packet));}
  private eventSourceGaps(item:Row):string[]{return this.eventSourceStates(item).filter(s=>s.registered&&(!s.current||!s.materialBound)).map(s=>s.reason??'current_event_source_and_material_required');}
  private receiverCandidateCurrent(item: Row,ignoreIntegration=false): boolean {
    if(!ignoreIntegration){try{this.integrationMaterial(this.packet(item.current_packet),true);}catch{return false;}}
    if(parse(item,'candidate').kind==='development-task'){this.taskRecords().current(item.id);return true;}
    if(this.eventSourceGaps(item).length)return false;
    const primary = parse(item, 'candidate') as Candidate, context = parse(item, 'context') as QueueContext;
    const composition=parse(this.packet(item.current_packet),'summary').composition as Composition|undefined;
    const effective=(c:Candidate,watermark:string|null)=>({...c,observedAt:(!c.observedAt||watermark&&watermark>c.observedAt)?watermark:c.observedAt});
    const selected=(composition?currentMembers(composition):[primary]).map(c=>effective(c,item.latest_source_observation));
    // H/B/target changes create another item. Compare source observations across
    // the PR, never W2 completion/arrival time: a fresh test of old H is not new H.
    const others = this.db.prepare("SELECT items.candidate,items.context,items.latest_source_observation,items.latest_observation,items.observation_conflict,packets.summary FROM items JOIN packets ON packets.id=items.current_packet WHERE items.id!=? AND lower(json_extract(candidate,'$.repository'))=?").all(item.id, primary.repository.toLowerCase()) as Row[];
    for(const current of selected){
    for (const other of others) {
      const otherComposition=parse(other,'summary').composition as Composition|undefined, otherCandidates=(otherComposition?currentMembers(otherComposition):[parse(other,'candidate') as Candidate]).map(c=>effective(c,other.latest_source_observation)),otherContext=parse(other,'context') as QueueContext;
      for(const candidate of otherCandidates){
      if(candidate.pr!==current.pr)continue;
      // Equal candidate/context identities do not settle contradictory originals.
      // Reuse the joint source/execution ordering rule: only a later complete
      // observation can supersede a related conflict, never arrival time alone.
      if (other.observation_conflict && context.scope.id === otherContext.scope.id &&
        (!current.observedAt || !other.latest_source_observation || current.observedAt <= other.latest_source_observation ||
         !item.latest_observation || !other.latest_observation || item.latest_observation <= other.latest_observation)) return false;
      // A new context version in this same scope can make the selected task
      // ambiguous; it does not adopt another scope or grant any new permission.
      const sameContext = context.scope.id !== otherContext.scope.id || context.scope.version === otherContext.scope.version && context.arrangement.id === otherContext.arrangement.id && context.arrangement.version === otherContext.arrangement.version;
      if (candidate.H === current.H && candidate.B === current.B && candidate.targetRef === current.targetRef && sameContext) continue;
      if (!current.observedAt || !candidate.observedAt || candidate.observedAt >= current.observedAt) return false;
      }
    }
    }
    return true;
  }
  private currentReceiverResult(op: Row, result: Row | null): Row | null {
    if (!result?.receiver) return result;
    const item = this.item(op.item), current = item.current_packet === op.packet && !item.observation_conflict && this.receiverCandidateCurrent(item) && this.memberReceptionCurrent(item.id) && this.integrationApplicability(op,result.receiver) && this.pairedApplicability(op, result.receiver);
    return { ...result, receiver: { ...result.receiver, materialMatchedAtReturn: result.receiver.currentMaterialMatches, currentMaterialMatches: current },
      gaps: [...new Set([...result.gaps, ...(!current ? ['newer_material_requires_own_reception'] : [])])] };
  }
  finishReceiver(id: string, bindingHash: string, judgment: Row | null, originals: Record<string, Buffer>, closeSource?: string, invalid?: { reason: string; finalText: string }): Row {
    return this.transaction(() => {
      const { op, result, receiver } = this.receiverOperation(id);
      if (!receiver || receiver.bindingHash !== bindingHash) throw new Error('receiver_binding_mismatch');
      if (op.status === 'complete') return { operation: id, duplicate: true, ...this.currentReceiverResult(op, result) };
      if (op.status !== 'receiving' || (!judgment && !closeSource)) throw new Error('receiver_completion_unverified');
      this.receiverClaim(op); this.packetEvidence(this.packet(op.packet));
      if (invalid && (judgment || closeSource !== 'verified_completed_invalid_judgment' || !['receiver_final_binding_or_judgment_invalid','receiver_invalid_json','receiver_prerequisite_not_consumed','receiver_integration_not_consumed','receiver_member_refutation_not_consumed'].includes(invalid.reason) || JSON.parse(originals['completed.json']?.toString() ?? '{}').finalText !== invalid.finalText || JSON.parse(originals['capture-status.json']?.toString() ?? '{}').status !== 'complete')) throw new Error('receiver_invalid_completion_proof_missing');
      if (invalid) originals = { ...originals, 'invalid-final.txt': Buffer.from(invalid.finalText) };
      const blobs: Record<string, Row> = {};
      for (const [name, bytes] of Object.entries(originals)) {
        const sha256 = hash(bytes); this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256, bytes); blobs[name] = { sha256, bytes: bytes.length };
      }
      const item = this.item(op.item), current = item.current_packet === op.packet && !item.observation_conflict && this.receiverCandidateCurrent(item) && this.memberReceptionCurrent(item.id) && this.integrationApplicability(op,receiver) && this.pairedApplicability(op, receiver);
      const r = { ...receiver, phase: judgment ? 'returned' : 'closed_unresolved', finishedAt: now(), judgment, closeSource: closeSource ?? null, blobs,
        ...(invalid ? { invalidResult: { kind: 'completed_invalid_judgment', reason: invalid.reason, finalTextSha256: hash(invalid.finalText), executionCompleted: true, validJudgment: false } } : {}),
        currentMaterialMatches: current, newTaskSentOnRecovery: false };
      // Files survive a rolled-back dispatch transaction. A missing queue
      // timestamp cannot turn a captured launch/input into proof of no send.
      const queueDispatchRegistered=Boolean(receiver.dispatchRegisteredAt),capturedInputPresent=Boolean(originals['stdin.ndjson']?.length),executionEvidence=['launch.json','process.json','stdout.ndjson'].filter(name=>Boolean(originals[name]?.length)),dispatchPossible=queueDispatchRegistered||capturedInputPresent||executionEvidence.length>0;
      const completed = { ...result, status: invalid ? 'receiver_invalid_result' : 'receiver_evaluated', receiver: r, independentReception: judgment ? receiver.executionKind === 'fixture' ? 'fixture_judgment_recorded' : receiver.subject?'composition_judgment_recorded':'judgment_recorded' : invalid ? 'completed_output_not_a_valid_judgment' : 'closed_without_judgment',
        productionActionAllowed: false, externalProductionActionSent: false, externalActionKind: 'readonly_model_request',
        externalActionSent: receiver.executionKind === 'fixture' ? false : judgment || invalid ? true : dispatchPossible ? 'unknown' : false,
        modelDispatchStatus: judgment ? 'returned_final' : invalid ? 'returned_invalid' : dispatchPossible ? 'submitted_or_unknown' : 'not_dispatched',modelRequestRegistered:queueDispatchRegistered,
        queueDispatchRegistered,dispatchCapture:{capturedInputPresent,inputSha256:capturedInputPresent?hash(originals['stdin.ndjson']!):null,executionEvidence,queueRegistrationMissing:dispatchPossible&&!queueDispatchRegistered},
        controlsAtReturn: this.db.prepare('SELECT kind,stopped,revision FROM controls WHERE scope=? ORDER BY kind').all(parse(item, 'context').scope.id),
        gaps: [...result.gaps.filter((g: string) => g !== 'independent_receiver_unavailable' || !judgment || receiver.executionKind === 'fixture'), ...(!current ? ['newer_material_requires_own_reception'] : []), ...(invalid ? ['receiver_judgment_invalid'] : !judgment ? ['original_receiver_result_unresolved'] : [])],
        next: judgment ? 'read_scoped_judgment_no_automatic_merge' : invalid ? 'read_invalid_original_explicit_bounded_correction_available' : 'retain_unresolved_original_no_automatic_retry' };
      this.db.prepare("UPDATE operations SET status='complete',finished_at=?,result=? WHERE id=?").run(now(), JSON.stringify(completed), id);
      this.db.prepare('DELETE FROM claims WHERE target=? AND operation=? AND generation=?').run(op.target, id, op.generation);
      this.event(judgment ? 'receiver_judgment_recorded' : invalid ? 'receiver_invalid_result_recorded' : 'receiver_closed_unresolved', id, { bindingHash, currentMaterialMatches: current, closeSource: closeSource ?? null });
      return { operation: id, ...completed };
    });
  }
  correctReceiver(id: string, plan: Buffer, material: Array<{ name: string; bytes: Buffer }>): Row {
    return this.transaction(() => {
      this.requireCorrections(); const { op, receiver } = this.receiverOperation(id), item = this.item(op.item), packet = this.packet(op.packet), summary = parse(packet, 'summary'), request = JSON.parse(plan.toString());
      const semanticPlan = hash(canonical(request)), known = this.db.prepare("SELECT data FROM events WHERE kind='receiver_correction_registered' AND object=?").get(id) as Row | undefined;
      if (known) { const prior = parse(known, 'data'); if (prior.semanticPlan !== semanticPlan || item.current_packet !== prior.packet) throw new Error('receiver_correction_plan_or_material_changed'); this.packetEvidence(this.packet(prior.packet)); return { ...prior, duplicate: true }; }
      let controllerEnded = receiver?.controllerReturned === true;
      if (!controllerEnded && receiver && Number.isSafeInteger(receiver.controllerPid) && receiver.controllerPid > 0) { try { process.kill(receiver.controllerPid,0); } catch (e) { controllerEnded = (e as NodeJS.ErrnoException).code === 'ESRCH'; } }
      if (op.status !== 'complete' || receiver?.phase !== 'closed_unresolved' || !receiver.invalidResult || !controllerEnded || request.bindingHash !== receiver.bindingHash || request.operation !== id) throw new Error('receiver_known_ended_invalid_result_required');
      if (summary.correction || this.receiverDispatchCount(item.id) >= 3) throw new Error('receiver_correction_limit');
      if (this.db.prepare("SELECT 1 FROM events WHERE kind='pair_registered' AND (json_extract(data,'$.first.item')=? OR json_extract(data,'$.second.item')=?)").get(item.id,item.id)) throw new Error('paired_correction_requires_new_explicit_binding');
      if (item.current_packet !== op.packet || item.observation_conflict || !this.receiverCandidateCurrent(item) || !this.effectiveSummary(item,packet).evidenceComplete || this.prerequisites(item).length) throw new Error('receiver_correction_source_no_longer_current');
      if ((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(parse(item,'context').scope.id) as Row)?.stopped) throw new Error('new_investment_stopped');
      if (this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(op.target)) throw new Error('target_occupied_or_unknown');
      for (const ref of Object.values(receiver.blobs) as Row[]) this.blob(ref.sha256);
      if (!request.source?.trim() || request.source.length > 2048 || !request.reason?.trim() || request.reason.length > 2048 || material.length > 10 || material.reduce((n,m)=>n+m.bytes.length,0)>512*1024) throw new Error('receiver_correction_scope_invalid');
      const refs = material.map(m => ({ name: m.name, sha256: hash(m.bytes), bytes: m.bytes.length }));
      for (const bytes of [plan, ...material.map(m => m.bytes)]) this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(bytes),bytes);
      const binding = { previousOperation: id, previousPacket: op.packet, priorInputSha256: receiver.inputSha256, finalTextSha256: receiver.invalidResult.finalTextSha256, rejection: receiver.invalidResult.reason, planSha256: hash(plan), source: request.source, reason: request.reason, material: refs, depth: 1 };
      const correction = { ...binding, sha256: hash(canonical(binding)) }, fingerprint = hash(canonical({ previous: packet.fingerprint, correction }));
      const inserted = this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id,fingerprint,packet.manifest_hash,packet.report_hash,packet.context_hash,JSON.stringify({...summary,baseFingerprint:this.basePacketFingerprint(packet),correction}),now());
      const packetId = Number(inserted.lastInsertRowid); this.db.prepare('UPDATE items SET current_packet=? WHERE id=?').run(packetId,item.id);
      const saved = { item: item.id, operation: id, packet: packetId, semanticPlan, correctionSha256: correction.sha256, originalUnchanged: true, modelDispatched: false };
      this.event('receiver_correction_registered',id,saved);return {...saved,duplicate:false};
    });
  }
  private effectiveSummary(item: Row, packet: Row): Row {
    const original = parse(packet, 'summary');
    const linked=original.kind==='development-task'&&this.taskLinkRecords(fn=>fn()).state(item.id).some(l=>l.current);
    const summary=linked?{...original,gaps:original.gaps.filter((g:string)=>g!=='formal_candidate_not_attached'),limitations:['Development-task source and linked PR evidence retain separate identities.','Only declared paths were observed; this is not a task acceptance report.'],linkedCandidateAvailable:true}:original;
    return { ...summary, evidenceComplete: summary.evidenceComplete && !item.observation_conflict, gaps: [...summary.gaps, ...(item.observation_conflict ? ['observation_order_conflict'] : [])] };
  }
  private itemStatus(item: Row): Row {
    const composition = parse(this.packet(item.current_packet), 'summary').composition;
    if(composition)this.packetEvidence(this.packet(item.current_packet));
    return { id: item.id, candidate: parse(item, 'candidate'), ...(parse(item,'candidate').kind==='development-task'?{developmentTask:{...this.taskRecords().status(item.id),inbox:this.taskInboxRecords(fn=>fn()).status(item.id),controllerReturns:this.taskInboxRecords(fn=>fn()).controllerReturns(item.id),candidateLinks:this.taskLinkRecords(fn=>fn()).state(item.id)}}:{}), ...(composition ? { compositionCurrent: !item.observation_conflict && this.receiverCandidateCurrent(item) } : {}), currentPacket: item.current_packet, eventSource:this.eventSourceStates(item).map(s=>({registered:s.registered,current:s.current,materialBound:s.materialBound,reason:s.reason??null})), latestObservation: item.latest_observation, latestSourceObservation: item.latest_source_observation, observationConflict: Boolean(item.observation_conflict), context: parse(item, 'context'), summary: this.effectiveSummary(item, this.packet(item.current_packet)), dependencyGaps: this.prerequisites(item), ...(item.observation_conflict ? { materialHistory: (this.db.prepare('SELECT id,manifest_hash,report_hash,summary FROM packets WHERE item=? ORDER BY id').all(item.id) as Row[]).map(p => ({ packet: p.id, manifestHash: p.manifest_hash, reportHash: p.report_hash, summary: parse(p, 'summary') })) } : {}) };
  }
  // Read only original, registered capture blobs inside the same status
  // transaction. Never probe today's executable or follow a recorded path.
  private receiverMetadata(receiver: Row | undefined): Row {
    if (!receiver) return { state: 'not_dispatched' };
    const base = { executionKind: receiver.executionKind, tool: 'Claude Code' };
    try {
      const initRef = receiver.blobs?.['init.json'];
      if (!initRef) return { ...base, state: 'unavailable', reason: 'original_init_not_registered' };
      const bytes = this.blob(initRef.sha256);
      if (bytes.length !== initRef.bytes || bytes.length > 65536) throw new Error('original_init_invalid');
      const init = JSON.parse(bytes.toString());
      if (init.type !== 'system' || init.subtype !== 'init' || ![init.claude_code_version, init.model, init.session_id].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\x00-\x1f]/.test(x))) throw new Error('original_init_invalid');
      return { ...base, state: 'recorded', version: init.claude_code_version, model: init.model, session: init.session_id, evidenceSha256: initRef.sha256 };
    } catch { return { ...base, state: 'unavailable', reason: 'original_metadata_unreadable_or_invalid' }; }
  }
  status(receiverMetadataFor: readonly string[] = [], invalidOutputFor: readonly string[] = [], collaborationFor: readonly string[] = []): Row {
    this.db.exec('BEGIN');
    try {
      const publications = (this.db.prepare("SELECT DISTINCT object FROM events WHERE kind='publication_prepared' ORDER BY object").all() as Row[]).map(e => { const p = this.publicationHistory(e.object.slice(12)); return { operation: p.operation, publicationId: p.prepared.publicationId, comment: p.stages.comment.lastState ?? 'pending', status: p.stages.status.lastState ?? 'pending', githubState: p.document.status.state, judgment: p.document.judgment, materialDigest: p.document.materialDigest, commentReference: p.stages.comment.verified?.remote ?? null, recordedAt: p.stages.status.verified?.at ?? p.prepared.at, historicalReceiverResultUnmodified: true }; });
      const result = { schemaVersion: queueFormatVersion(this.db), receiverEnabled: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(queueFeatureVersion(this.db)), mode: 'shadow', repository: (this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value, productionActionAllowed: false, publisher: 'explicit_result_publication', publications, independentReceiver: 'explicit_cli_requires_preflight', items: (this.db.prepare('SELECT * FROM items ORDER BY created_at,id').all() as Row[]).map(i => this.itemStatus(i)), controls: this.db.prepare('SELECT * FROM controls ORDER BY scope,kind').all(), claims: this.db.prepare('SELECT * FROM claims').all(), operations: (this.db.prepare('SELECT * FROM operations ORDER BY started_at,id').all() as Row[]).map(o => ({ ...o, result: this.currentReceiverResult(o, parse(o, 'result') ?? null), recovery: o.status === 'merging' ? 'merge_unknown_reconcile_original_operation' : o.status === 'repairing' ? 'repair_unknown_reconcile_original_operation' : o.status === 'receiving' ? 'receiver_unknown_reconcile_original_operation' : o.status === 'running' ? 'result_unknown_evaluate_original_operation' : null })), events: this.db.prepare('SELECT * FROM events ORDER BY id').all() };
      for (const operation of result.operations as Row[]) if (receiverMetadataFor.includes(operation.item)) Object.assign(operation, { nativeExecution: this.receiverMetadata(operation.result?.receiver) });
      for (const operation of result.operations as Row[]) if (invalidOutputFor.includes(operation.id) && operation.result?.receiver?.invalidResult) operation.invalidOutput = this.blob(operation.result.receiver.invalidResult.finalTextSha256).toString();
      const collaboration=Object.fromEntries(collaborationFor.map(id=>[id,this.collaborationView().state(id)]));
      this.db.exec('COMMIT'); return {...result,...(collaborationFor.length?{collaboration}:{})};
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

function parseQueueContextBlob(bytes: Buffer): QueueContext { return JSON.parse(bytes.toString()) as QueueContext; }
