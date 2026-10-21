import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { now } from './contract.js';
import type { OwnerObservation } from './authority-source.js';

type Row = Record<string, any>;
const digest = /^[a-f0-9]{64}$/;
const text = (x: unknown, max = 2048): x is string => typeof x === 'string' && Boolean(x.trim()) && x.length <= max && !x.includes('\0');
const chainKey = (s: Row) => hash(canonical({ repository:s.candidate.repository.toLowerCase(),pr:s.candidate.pr,scope:s.context.scope }));
const repairClaimGuard = `CREATE TRIGGER review_repair_claim_guard BEFORE DELETE ON claims
WHEN EXISTS(SELECT 1 FROM operations WHERE id=OLD.operation AND status='repairing')
BEGIN SELECT RAISE(ABORT,'repair_claim_active'); END`;
const repairRecordGuard = `CREATE TRIGGER review_repair_record_guard BEFORE UPDATE ON operations
WHEN json_type(OLD.result,'$.repair')='object' AND (NEW.packet!=OLD.packet OR (json_extract(NEW.result,'$.repair.bindingHash') IS NOT json_extract(OLD.result,'$.repair.bindingHash') AND (json_extract(OLD.result,'$.repair.phase') IS NOT 'closed_unstarted' OR json_extract(NEW.result,'$.repair.previousBindingHash') IS NOT json_extract(OLD.result,'$.repair.bindingHash'))))
BEGIN SELECT RAISE(ABORT,'repair_record_is_bound'); END`;
const legacyRepairRecordGuard = `CREATE TRIGGER review_repair_record_guard BEFORE UPDATE ON operations
WHEN json_type(OLD.result,'$.repair')='object' AND (NEW.packet!=OLD.packet OR json_extract(NEW.result,'$.repair.bindingHash') IS NOT json_extract(OLD.result,'$.repair.bindingHash'))
BEGIN SELECT RAISE(ABORT,'repair_record_is_bound'); END`;

/** An extension of the SAME QueueStore connection, transaction and originals.
 * No additional scheduler, resource balance or inferred permission store. */
export class ReviewRecords {
  constructor(private db: DatabaseSync, private transaction: <T>(f: () => T) => T,
    private source: (id: string, requireCurrent: boolean) => Row,
    private publication: (id: string) => Row,private repairGate?:(operation:string,proposed:{plan:Buffer;request:Buffer;config:Buffer}|undefined,observations:OwnerObservation[])=>void) {}
  private event(kind: string, object: string, data: unknown) { this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run(kind, object, JSON.stringify(data), now()); }
  private events(object: string, kind?: string): Row[] { return (this.db.prepare('SELECT * FROM events WHERE object=? ORDER BY id').all(object) as Row[]).filter(e => !kind || e.kind === kind).map(e => ({ ...e, data: JSON.parse(e.data) })); }
  private blob(bytes: Buffer) { const sha256 = hash(bytes); this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256, bytes); this.bytes(sha256); return sha256; }
  private bytes(sha256: string): Buffer { const r = this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha256) as Row; if (!r || hash(Buffer.from(r.bytes)) !== sha256) throw new Error('review_original_changed'); return Buffer.from(r.bytes); }
  private requireMode(legacyReadOrClose=false) {
    const version=(this.db.prepare('PRAGMA user_version').get() as Row).user_version;
    if (!([9,10,11,12,13,14,15].includes(version) || legacyReadOrClose&&version===8) || ![['review_repair_claim_guard', repairClaimGuard], ['review_repair_record_guard', version===8?legacyRepairRecordGuard:repairRecordGuard]].every(([name, sql]) => (this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name!) as Row)?.sql === sql)) throw new Error('review_records_not_enabled');
  }
  enable() {
    return this.transaction(() => {
      const version = (this.db.prepare('PRAGMA user_version').get() as Row).user_version;
      if ([9,10,11,12,13,14,15].includes(version)) { this.requireMode(); return { enabled: true, duplicate: true, productionActionAllowed: false }; }
      if (![6, 7, 8].includes(version)) throw new Error('enable_receiver_supplements_before_review_records');
      if(version===8)this.requireMode(true);
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n || (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n) throw new Error('queue_has_active_or_unknown_operation');
      if((this.db.prepare("SELECT COUNT(*) AS n FROM events a WHERE a.kind='overall_review_dispatched' AND NOT EXISTS(SELECT 1 FROM events b WHERE b.object=a.object AND b.id>a.id AND b.kind IN ('overall_review_result','overall_review_closed_unstarted'))").get() as Row).n)throw new Error('queue_has_active_or_unknown_overall_review');
      if(version===8)this.db.exec('DROP TRIGGER review_repair_claim_guard; DROP TRIGGER review_repair_record_guard;');
      this.db.exec(`${repairClaimGuard}; ${repairRecordGuard}; PRAGMA user_version=9;`);
      this.event('review_records_enabled', 'review-records', { from: version, to: 9 }); return { enabled: true, duplicate: false, productionActionAllowed: false };
    });
  }
  private operation(id: string) { const o = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row; if (!o) throw new Error('operation_not_found'); return { op: o, result: JSON.parse(o.result) }; }
  private fixed(id: string) {
    const { op, result } = this.operation(id), r = result.repair;
    if (!r) throw new Error('queue_repair_not_registered');
    return { op, result, repair: r, plan: this.bytes(r.planSha256), request: this.bytes(r.requestSha256), config: this.bytes(r.configSha256) };
  }
  state(id: string) { return this.transaction(() => { this.requireMode(true); const x = this.fixed(id); if (x.repair.resultSha256) this.bytes(x.repair.resultSha256); return { ...x, events: this.events(id).filter(e => e.kind.startsWith('repair_')) }; }); }
  reserve(id: string, plan: Buffer, request: Buffer, config: Buffer,observations:OwnerObservation[]=[]) {
    return this.transaction(() => {
      this.requireMode(); const { op, result } = this.operation(id);
      if (result.repair) {
        const x = this.fixed(id);
        if (x.repair.planSha256 === hash(plan) && x.repair.requestSha256 === hash(request) && x.repair.configSha256 === hash(config)) return { ...x, duplicate: true };
        const replacement=JSON.parse(plan.toString()),nextRequest=JSON.parse(request.toString());
        if(x.repair.phase!=='closed_unstarted'||replacement.replacesClosedBinding!==x.repair.bindingHash||nextRequest.executionRoot===x.repair.executionRoot)throw new Error('queue_repair_fixed_input_changed');
      }
      const s = this.source(id, true);
      this.repairGate?.(id,{plan,request,config},observations);
      if(s.receiver.subject)throw new Error('composition_requires_member_scoped_repair_and_reverification');
      if (op.status !== 'complete' || s.receiver.judgment.verdict !== 'RETURN_FOR_WORK' || !s.receiver.controllerReturned) throw new Error('repair_requires_completed_return');
      const p = JSON.parse(plan.toString()), r = JSON.parse(request.toString()), c = JSON.parse(config.toString());
      if (p.operation !== id || p.judgmentId !== s.receiver.judgmentId || p.bindingHash !== s.receiver.bindingHash || p.packet !== op.packet || canonical(p.context) !== canonical(s.context)) throw new Error('queue_repair_source_mismatch');
      if (r.candidate.H !== s.candidate.H || r.candidate.B !== s.candidate.B || r.candidate.repository !== s.candidate.repository || r.candidate.pr !== s.candidate.pr || r.candidate.target !== s.candidate.targetRef || c.executionKind !== s.receiver.executionKind) throw new Error('queue_repair_candidate_or_execution_mismatch');
      if (!r.authorization?.allowRepair || !text(r.authorization.source)) throw new Error('queue_repair_authorization_missing');
      if (this.db.prepare('SELECT 1 FROM claims WHERE target=?').get(op.target)) throw new Error('target_occupied_or_unknown');
      if (this.reflectionDue(chainKey(s))) throw new Error('simplification_reflection_due');
      const seats = Number((this.db.prepare("SELECT value FROM meta WHERE key='seats'").get() as Row).value);
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n >= seats) throw new Error('reception_seats_full');
      const bindingHash = hash(canonical({ operation: id, packet: op.packet, originalBinding: s.receiver.bindingHash, plan: hash(plan), request: hash(request), config: hash(config) }));
      const repair = { bindingHash, ...(result.repair?{previousBindingHash:result.repair.bindingHash}:{}),...(p.governance?{authorityIntent:p.governance.authorityIntent,resourceRequests:p.governance.resourceRequests}:{}), phase: 'reserved', planSha256: this.blob(plan), requestSha256: this.blob(request), configSha256: this.blob(config), executionRoot: r.executionRoot, controllerPid: process.pid, controllerReturned: false, sourceJudgmentId: s.receiver.judgmentId, sourceBindingHash: s.receiver.bindingHash, scope: s.context.scope.id, registeredAt: now() };
      const generation = (this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM operations WHERE target=?').get(op.target) as Row).n + 1;
      this.db.prepare("UPDATE operations SET status='repairing',generation=?,finished_at=NULL,result=? WHERE id=?").run(generation, JSON.stringify({ ...result, repair }), id);
      this.db.prepare('INSERT INTO claims VALUES(?,?,?)').run(op.target, id, generation);
      this.event('repair_reserved', id, { bindingHash, generation, root: r.executionRoot, requestSha256: repair.requestSha256 });
      return { ...this.fixed(id), duplicate: false };
    });
  }
  check(id: string, bindingHash: string, effect?: () => void,observations:OwnerObservation[]=[]) {
    return this.transaction(() => {
      this.requireMode(); const x = this.fixed(id); this.source(id, true);
      this.repairGate?.(id,undefined,observations);
      const c = this.db.prepare('SELECT * FROM claims WHERE operation=?').get(id) as Row;
      if (x.op.status !== 'repairing' || x.repair.phase === 'returned' || x.repair.bindingHash !== bindingHash || !c || c.generation !== x.op.generation || c.target !== x.op.target) throw new Error('queue_repair_claim_changed');
      const context = JSON.parse(this.db.prepare('SELECT context FROM items WHERE id=?').get(x.op.item)!.context as string);
      if ((this.db.prepare("SELECT COUNT(*) AS n FROM controls WHERE scope=? AND kind IN ('investment','implementation') AND stopped=1").get(context.scope.id) as Row).n) throw new Error('queue_repair_stopped');
      effect?.(); return { operation: id, bindingHash, generation: x.op.generation };
    });
  }
  closeUnstarted(id:string,bindingHash:string,source:string,proof:Buffer){
    return this.transaction(()=>{
      this.requireMode(true);const x=this.fixed(id);
      if(x.repair.bindingHash!==bindingHash||!text(source)||JSON.parse(proof.toString()).modelExecutionStarted!==false)throw new Error('unstarted_close_binding_invalid');
      if(x.repair.phase==='closed_unstarted')return {...x.repair,duplicate:true};
      if(x.op.status!=='repairing'||x.repair.phase==='returned')throw new Error('unstarted_close_requires_pending_repair');
      const claim=this.db.prepare('SELECT * FROM claims WHERE operation=?').get(id) as Row;
      if(!claim||claim.generation!==x.op.generation)throw new Error('queue_repair_claim_changed');
      Object.assign(x.repair,{phase:'closed_unstarted',controllerReturned:true,closeSource:source,closeProofSha256:this.blob(proof),modelExecutionStarted:false});
      this.db.prepare("UPDATE operations SET status='complete',finished_at=?,result=? WHERE id=?").run(now(),JSON.stringify(x.result),id);
      this.db.prepare('DELETE FROM claims WHERE operation=? AND generation=?').run(id,x.op.generation);
      this.event('repair_closed_unstarted',id,{bindingHash,source,proofSha256:hash(proof),originalRepair:x.repair});return {...x.repair,duplicate:false};
    });
  }
  controller(id: string, bindingHash: string, phase: 'prepared' | 'dispatched' | 'returned' | 'unknown', data: Row = {}) {
    return this.transaction(() => {
      this.requireMode(); const x = this.fixed(id); if (x.repair.bindingHash !== bindingHash) throw new Error('queue_repair_binding_changed');
      if (x.repair.phase === 'returned') return;
      x.repair.controllerPid = process.pid; x.repair.controllerReturned = phase === 'returned' || phase === 'unknown'; x.repair.phase = phase === 'unknown' ? 'unknown' : phase;
      this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(x.result), id);
      this.event('repair_' + phase, id, { bindingHash, controllerPid: process.pid, ...data });
    });
  }
  complete(id: string, bindingHash: string, result: Buffer, evidence: Buffer) {
    return this.transaction(() => {
      this.requireMode(); const x = this.fixed(id), value = JSON.parse(result.toString()), e = JSON.parse(evidence.toString());
      if (x.repair.bindingHash !== bindingHash || value.sourceCandidate?.H !== JSON.parse(x.request.toString()).candidate.H || e.operation !== id || e.bindingHash !== bindingHash || !digest.test(e.terminalRecordSha256) || e.resultSha256 !== hash(result)) throw new Error('queue_repair_completion_binding_mismatch');
      if (x.repair.phase === 'returned') { if (x.repair.resultSha256 !== hash(result) || x.repair.evidenceSha256 !== hash(evidence)) throw new Error('queue_repair_result_changed'); return { ...x.repair, duplicate: true }; }
      const claim = this.db.prepare('SELECT * FROM claims WHERE operation=?').get(id) as Row;
      if (x.op.status !== 'repairing' || !claim || claim.generation !== x.op.generation) throw new Error('queue_repair_claim_changed');
      Object.assign(x.repair, { phase: 'returned', controllerReturned: true, resultSha256: this.blob(result), evidenceSha256: this.blob(evidence), result: value, counters: e.counters, finishedAt: now(), productionActionAllowed: false });
      this.db.prepare("UPDATE operations SET status='complete',finished_at=?,result=? WHERE id=?").run(now(), JSON.stringify(x.result), id);
      this.db.prepare('DELETE FROM claims WHERE operation=? AND generation=?').run(id, x.op.generation);
      this.event('repair_result_recorded', id, { bindingHash, resultSha256: hash(result), evidenceSha256: hash(evidence), counters: e.counters, afterH: value.after.H });
      return { ...x.repair, duplicate: false };
    });
  }
  private reflectionDue(scope: string) { const events = this.events(`reflection:${scope}`); return events.some(e => e.kind === 'simplification_reflection_due' && !events.some(r => r.kind === 'simplification_reflection_response' && r.data.triggerEvent === e.id)); }
  reflectionResponse(scope: string, triggerEvent: number, source: string, report: Buffer, responsibleResponse: Buffer) {
    return this.transaction(() => {
      this.requireMode(); const object=`reflection:${scope}`, events=this.events(object), trigger=events.find(e=>e.id===triggerEvent && e.kind==='simplification_reflection_due');
      if (!trigger || !text(source) || !report.length || !responsibleResponse.length || report.length>1024*1024 || responsibleResponse.length>128000) throw new Error('reflection_response_evidence_required');
      const entry={triggerEvent,source,throughOrdinal:trigger.data.trigger.ordinal,reportSha256:this.blob(report),responsibleResponseSha256:this.blob(responsibleResponse),evidenceKind:'explicit_responsible_import_of_existing_simplification',newPermissionGranted:false,newModelDispatched:false};
      const prior=events.find(e=>e.kind==='simplification_reflection_response'&&e.data.triggerEvent===triggerEvent);
      if(prior){if(canonical(prior.data)!==canonical(entry)) throw new Error('reflection_response_changed');return {...entry,duplicate:true};}
      this.event('simplification_reflection_response',object,entry);return {...entry,duplicate:false};
    });
  }
  publishedRepair(id: string, publicationOperation: string) {
    return this.transaction(() => {
      this.requireMode(); const x = this.fixed(id), r = x.repair.result, p = this.publication(publicationOperation), source = this.source(id, false), published = this.source(publicationOperation, false);
      if (x.repair.phase !== 'returned' || !r.actualRepairPerformed || !(x.repair.counters.actualFileWrites>0) || r.executionKind !== 'native_capture' || !['completed','completed_recovered_candidate'].includes(r.status) || p.stages.comment?.lastState !== 'verified' || p.stages.status?.lastState !== 'verified' || p.document.candidate.H !== r.after.H || p.document.candidate.B !== source.candidate.B || p.document.candidate.repository !== source.candidate.repository || p.document.candidate.pr !== source.candidate.pr || p.document.candidate.targetRef !== source.candidate.targetRef || canonical(published.context.scope)!==canonical(source.context.scope)) throw new Error('published_repair_not_bound_to_verified_new_candidate');
      const chain=chainKey(source),key = `published-repair:${chain}`, known = this.events(key, 'repair_batch_published'), duplicate = known.find(e => e.data.H === r.after.H);
      if (duplicate) return { ...duplicate.data, duplicate: true };
      const entry = { operation: id, publicationOperation, publicationId: p.document.publicationId, H: r.after.H, beforeH: r.before.H, scope: source.context.scope, chain, ordinal: known.length + 1, comment: p.stages.comment.verified.remote, status: p.stages.status.verified.remote, evidenceSha256: x.repair.evidenceSha256 };
      this.event('repair_batch_published', key, entry);
      const responses=this.events(`reflection:${chain}`,'simplification_reflection_response'), through=responses.at(-1)?.data.throughOrdinal??0;
      if (entry.ordinal-through > 3 && !this.reflectionDue(chain)) this.event('simplification_reflection_due', `reflection:${chain}`, { trigger: entry, afterOrdinal:through, source: 'adopted #7 more than three actually published repair batches', kind: 'existing_web_gpt_simplification', status: 'awaiting_responsible_response_and_authorized_existing_entry', modelDispatched: false, newPermissionGranted: false });
      return { ...entry, duplicate: false, reflectionDue: this.reflectionDue(chain) };
    });
  }
  registerJudgment(id: string, classification: { taskClass: string; riskClass: string; coverageWindow: string; source: string }) {
    return this.transaction(() => {
      this.requireMode(); const s = this.source(id, false);
      if (Object.values(classification).some(x => !text(x)) || Object.keys(classification).sort().join() !== 'coverageWindow,riskClass,source,taskClass') throw new Error('judgment_classification_required');
      const j = s.receiver.judgment, object = `judgment:${j.judgmentId}`, existing = this.events(object, 'judgment_registered')[0];
      const init = JSON.parse(this.bytes(s.receiver.blobs['init.json'].sha256).toString());
      const entry = { operation: id, judgmentId: j.judgmentId, bindingHash: s.receiver.bindingHash, candidate: s.candidate, ...(s.receiver.subject?{subject:s.receiver.subject,subjectSha256:s.receiver.subjectSha256}:{}), context: s.context, classification, verdict: j.verdict, findings: j.findings, executionKind: s.receiver.executionKind, inputSha256: s.receiver.inputSha256, systemSha256: s.receiver.systemSha256, rawOutputSha256: s.receiver.blobs['stdout.ndjson'].sha256, model: init.model, toolVersion: init.claude_code_version, session: init.session_id, outcome: 'unobserved' };
      if (existing) { if (canonical(existing.data) !== canonical(entry)) throw new Error('judgment_classification_changed'); return { ...existing.data, duplicate: true }; }
      this.event('judgment_registered', object, entry); return { ...entry, duplicate: false };
    });
  }
  feedback(judgmentId: string, record: Row, originals: Record<string, Buffer>) {
    return this.transaction(() => {
      this.requireMode(); const object = `judgment:${judgmentId}`, original = this.events(object, 'judgment_registered')[0]; if (!original) throw new Error('judgment_not_registered');
      if (!['observation','counterexample','new_requirement','later_code','attribution_dispute','responsible_response','assessment'].includes(record.kind) || !text(record.id,128) || !text(record.source) || !text(record.report,128000) || !/^[a-f0-9]{40}$/.test(record.candidate?.H) || !/^[a-f0-9]{40}$/.test(record.candidate?.B) || record.candidate?.repository !== original.data.candidate.repository || !text(record.coverageWindow) || !Array.isArray(record.references) || record.references.length > 30 || Object.keys(originals).length < 1 || Object.keys(originals).length > 30 || Object.keys(record).sort().join()!=='candidate,coverageWindow,id,kind,references,report,source') throw new Error('feedback_record_invalid');
      const history = this.events(object, 'judgment_feedback'), existing = history.find(e => e.data.id === record.id);
      const blobs = Object.fromEntries(Object.entries(originals).map(([k,b]) => { if (!text(k,128) || b.length > 1024*1024) throw new Error('feedback_evidence_invalid'); return [k,{sha256: this.blob(b),bytes:b.length}]; }));
      const entry = { ...record, judgmentId, originalCandidate: original.data.candidate, blobs, permissionsChanged: false };
      if (existing) { if (canonical(existing.data) !== canonical(entry)) throw new Error('feedback_id_changed'); return { ...existing.data, duplicate: true }; }
      if (record.kind === 'assessment' && !record.references.some((ref: string) => history.some(e => e.data.id === ref && e.data.kind === 'responsible_response'))) throw new Error('responsible_response_required_before_assessment');
      if (record.references.some((ref: string) => !history.some(e => e.data.id === ref))) throw new Error('feedback_reference_missing');
      this.event('judgment_feedback', object, entry); return { ...entry, duplicate: false };
    });
  }
  sample(id: string, judgmentIds: string[], reason: string, source: string) {
    return this.transaction(() => {
      this.requireMode(); if (!text(id,128) || !text(reason) || !text(source) || !judgmentIds.length || judgmentIds.length > 100 || new Set(judgmentIds).size !== judgmentIds.length) throw new Error('sample_request_invalid');
      const selections = judgmentIds.map(j => { const e = this.events(`judgment:${j}`, 'judgment_registered')[0]; if (!e) throw new Error('sample_judgment_missing'); return { judgmentId:j, registrationSha256:hash(canonical(e.data)), verdict:e.data.verdict, taskClass:e.data.classification.taskClass, riskClass:e.data.classification.riskClass, candidate:e.data.candidate }; });
      const entry = { id, reason, source, selections, normalSamples:selections.filter(s => s.verdict === 'ACCEPT_WITHIN_SCOPE').length, abnormalSamples:selections.filter(s => s.verdict !== 'ACCEPT_WITHIN_SCOPE').length, noAccuracyInference:true, modelDispatched:false };
      const old = this.events(`sample:${id}`, 'judgment_sample_selected')[0]; if (old) { if (canonical(old.data)!==canonical(entry)) throw new Error('sample_selection_changed'); return {...old.data,duplicate:true}; }
      this.event('judgment_sample_selected', `sample:${id}`, entry); return {...entry,duplicate:false};
    });
  }
  private overallKey(plan:Buffer){
    const semantic=canonical(JSON.parse(plan.toString()));
    const existing=(this.db.prepare("SELECT data FROM events WHERE kind='overall_review_reserved' ORDER BY id").all() as Row[]).map(e=>JSON.parse(e.data)).filter(e=>canonical(JSON.parse(this.bytes(e.planSha256).toString()))===semantic);
    if(existing.length>1)throw new Error('legacy_duplicate_overall_requests_require_inspection');
    return existing[0]?.id??hash(semantic);
  }
  overallIdentity(plan:Buffer){return this.transaction(()=>{this.requireMode(true);return this.overallKey(plan);});}
  overallOriginal(plan:Buffer){return this.transaction(()=>{this.requireMode(true);const key=this.overallKey(plan),events=this.events(`overall:${key}`),registered=events.find(e=>e.kind==='overall_review_reserved');if(!registered)return null;const result=events.find(e=>e.kind==='overall_review_result');return {...registered.data,originalPlan:this.bytes(registered.data.planSha256),originalInput:this.bytes(registered.data.inputSha256),...(result?{originalResult:JSON.parse(this.bytes(result.data.blobs.result.sha256).toString())}:{}),events};});}
  overall(id: string, plan: Buffer, input: Buffer, phase: 'reserve' | 'dispatch' | 'result', originals: Record<string,Buffer> = {}) {
    return this.transaction(() => {
      this.requireMode(phase==='reserve'); const key=this.overallKey(plan), object=`overall:${key}`, events=this.events(object), registered=events.find(e=>e.kind==='overall_review_reserved');
      const source=this.source(id,phase==='dispatch'||!registered);
      const p=JSON.parse(plan.toString());
      if(p.operation!==id || p.bindingHash!==source.receiver.bindingHash || p.judgmentId!==source.receiver.judgmentId || canonical(p.context)!==canonical(source.context)) throw new Error('overall_source_binding_mismatch');
      if(registered && (registered.data.inputSha256!==hash(input)||registered.data.operation!==id)) throw new Error('overall_fixed_material_changed');
      if(phase==='reserve') {
        if(registered)return {...registered.data,originalPlan:this.bytes(registered.data.planSha256),duplicate:true,events};
        this.requireMode();
        if(p.recoveryOf){const old=this.events(`overall:${p.recoveryOf}`),registration=old.find(e=>e.kind==='overall_review_reserved'),dispatch=old.findLast(e=>e.kind==='overall_review_dispatched');const {recoveryOf:_recovery,...withoutRecovery}=p;if(!registration||!dispatch||old.some(e=>e.kind==='overall_review_result')||!old.some(e=>e.kind==='overall_review_closed_unstarted'&&e.data.dispatchEvent===dispatch.id)||canonical(withoutRecovery)!==canonical(JSON.parse(this.bytes(registration.data.planSha256).toString())))throw new Error('overall_recovery_source_not_confirmed_unstarted');}
        if((this.db.prepare("SELECT COUNT(*) AS n FROM events a WHERE a.kind='overall_review_dispatched' AND json_extract(a.data,'$.operation')=? AND NOT EXISTS(SELECT 1 FROM events b WHERE b.object=a.object AND b.id>a.id AND b.kind IN ('overall_review_result','overall_review_closed_unstarted'))").get(id) as Row).n) throw new Error('overall_original_pending_or_unknown');
        const entry={operation:id,id:key,planSha256:this.blob(plan),inputSha256:this.blob(input),judgmentId:source.receiver.judgmentId,modelDispatched:false};
        this.event('overall_review_reserved',object,entry);return {...entry,originalPlan:plan,duplicate:false,events:[]};
      }
      if(!registered)throw new Error('overall_intent_required');
      if(phase==='dispatch') {
        const attempts=events.filter(e=>e.kind==='overall_review_dispatched'),latest=attempts.at(-1);
        if(latest&&!events.some(e=>e.kind==='overall_review_closed_unstarted'&&e.data.dispatchEvent===latest.id))throw new Error('overall_original_already_dispatched');
        if(attempts.length>=3)throw new Error('overall_unstarted_retry_limit');
        if((this.db.prepare("SELECT COUNT(*) AS n FROM events a WHERE a.kind='overall_review_dispatched' AND a.object!=? AND json_extract(a.data,'$.operation')=? AND NOT EXISTS(SELECT 1 FROM events b WHERE b.object=a.object AND b.id>a.id AND b.kind IN ('overall_review_result','overall_review_closed_unstarted'))").get(object,id) as Row).n)throw new Error('overall_original_pending_or_unknown');
        if((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(source.context.scope.id) as Row)?.stopped)throw new Error('new_investment_stopped');
        if(this.db.prepare('SELECT 1 FROM claims WHERE operation=?').get(id))throw new Error('original_task_execution_active_or_unknown');
      }
      const blobs=Object.fromEntries(Object.entries(originals).map(([k,v])=>[k,{sha256:this.blob(v),bytes:v.length}]));
      const entry={operation:id,id:key,inputSha256:hash(input),blobs,...(phase==='dispatch'?{attempt:events.filter(e=>e.kind==='overall_review_dispatched').length+1}:{})};
      const previous=phase==='result'?events.find(e=>e.kind==='overall_review_result'):undefined;
      if(previous){if(canonical(previous.data)!==canonical(entry))throw new Error('overall_result_changed');return {...entry,duplicate:true};}
      this.event('overall_review_'+(phase==='dispatch'?'dispatched':'result'),object,entry);return {...entry,duplicate:false};
    });
  }
  closeOverallUnstarted(id:string,plan:Buffer,source:string,proof:Buffer){
    return this.transaction(()=>{
      this.requireMode(true);const key=this.overallKey(plan),object=`overall:${key}`,events=this.events(object),dispatch=events.findLast(e=>e.kind==='overall_review_dispatched');
      if(!dispatch||dispatch.data.operation!==id||!text(source)||JSON.parse(proof.toString()).nativeLaunchRegistered!==false)throw new Error('overall_unstarted_proof_missing');
      if(events.some(e=>e.kind==='overall_review_result'))throw new Error('overall_already_completed');
      const old=events.find(e=>e.kind==='overall_review_closed_unstarted'&&e.data.dispatchEvent===dispatch.id);if(old)return {...old.data,duplicate:true};
      const entry={operation:id,id:key,dispatchEvent:dispatch.id,attempt:dispatch.data.attempt??1,source,proofSha256:this.blob(proof),modelDispatched:false,originalPreserved:true};
      this.event('overall_review_closed_unstarted',object,entry);return {...entry,duplicate:false};
    });
  }
  status() { return this.transaction(() => { this.requireMode(true); return { events:(this.db.prepare("SELECT * FROM events WHERE kind LIKE 'judgment_%' OR kind LIKE 'simplification_%' OR kind LIKE 'overall_review_%' OR kind='repair_batch_published' ORDER BY id").all() as Row[]).map(e=>({id:e.id,kind:e.kind,object:e.object,observedAt:e.observed_at,data:JSON.parse(e.data)})), rankingAvailable:false, accuracyFromSilence:false, productionActionAllowed:false }; }); }
}
