import { DatabaseSync } from 'node:sqlite';
import { lstat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, privateDirectory } from './snapshot.js';
import { repoPattern, now } from './contract.js';
import { candidateKey, targetKey } from './queue-evidence.js';
import type { Packet, QueueContext } from './queue-evidence.js';
import type { Candidate } from './contract.js';
import { canonical } from './comparison.js';

type Row = Record<string, any>;
const parse = (row: Row | undefined, key: string): any => row ? JSON.parse(row[key]) : undefined;
const supplementGuard = `CREATE TRIGGER receiver_packet_material_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND EXISTS(SELECT 1 FROM packets WHERE id=NEW.packet AND fingerprint IS NOT json_extract(NEW.result,'$.receiver.packetFingerprint'))
BEGIN SELECT RAISE(ABORT,'receiver_packet_material_binding_required'); END`;
export function materialIdentity(bytes: Buffer): string {
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  try { return hash('json:' + canonical(JSON.parse(text))); } catch { return hash('text:' + text); }
}
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
    await privateDirectory(directory, false);
    for (const name of ['queue.sqlite', 'queue.sqlite-wal', 'queue.sqlite-shm']) {
      try { const st = await lstat(join(directory, name)); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077)) throw new Error('invalid_queue_storage'); }
      catch (e) { if (name === 'queue.sqlite' || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const db = new DatabaseSync(join(directory, 'queue.sqlite'));
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      const version = db.prepare('PRAGMA user_version').get() as Row;
      if (![3, 4, 5].includes(version.user_version) || (db.prepare("SELECT value FROM meta WHERE key='mode'").get() as Row)?.value !== 'shadow') throw new Error('unsupported_queue_schema_or_mode');
      return new QueueStore(directory, db);
    } catch (e) { db.close(); throw e; }
  }
  close(): void { this.db.close(); }
  enableReceiver(): Row {
    return this.transaction(() => {
      const version = (this.db.prepare('PRAGMA user_version').get() as Row).user_version;
      if ([4, 5].includes(version) && this.receiverGuardsInstalled()) return { receiverEnabled: true, duplicate: true, productionActionAllowed: false };
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
PRAGMA user_version=4;`);
      this.event('receiver_format_enabled', this.directory, { from: version, to: 4, guardsInstalled: true });
      return { receiverEnabled: true, schemaVersion: 4, productionActionAllowed: false };
    });
  }
  enableSupplements(): Row {
    return this.transaction(() => {
      const version = (this.db.prepare('PRAGMA user_version').get() as Row).user_version;
      if (version === 5 && this.supplementGuardInstalled()) return { supplementsEnabled: true, duplicate: true, productionActionAllowed: false };
      if (![4, 5].includes(version) || !this.receiverGuardsInstalled()) throw new Error('enable_receiver_before_supplements');
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n || (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status!='complete'").get() as Row).n) throw new Error('queue_has_active_or_unknown_operation');
      this.db.exec(`DROP TRIGGER IF EXISTS receiver_packet_material_guard; ${supplementGuard}; PRAGMA user_version=5;`);
      this.event('receiver_supplements_enabled', this.directory, { from: version, to: 5 });
      return { supplementsEnabled: true, schemaVersion: 5, productionActionAllowed: false };
    });
  }
  requireReceiverMode(): void { if (![4, 5].includes((this.db.prepare('PRAGMA user_version').get() as Row).user_version)) throw new Error('receiver_mode_not_enabled'); }
  private supplementGuardInstalled(): boolean { return (this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='receiver_packet_material_guard'").get() as Row | undefined)?.sql === supplementGuard; }
  private receiverGuardsInstalled(): boolean { return (this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name IN ('receiver_record_guard','receiver_claim_guard')").get() as Row).n === 2; }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private event(kind: string, object: string, data: unknown): void { this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run(kind, object, JSON.stringify(data), now()); }
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
    const references = [report.plan, ...report.inputs.map((i: any) => i.manifest), ...manifest.artifacts];
    if (report.failureOutput) references.push(report.failureOutput.stdout, report.failureOutput.stderr);
    for (const stage of report.stages) {
      if (stage.mergeOutput) references.push(stage.mergeOutput);
      for (const tool of stage.tools) for (const key of ['stdout', 'stderr', 'result', 'sandbox']) if (tool[key]) references.push(tool[key]);
    }
    for (const ref of references) this.blob(ref.sha256);
    for (let s = parse(packet, 'summary').supplement; s; s = s.previous) {
      this.blob(s.priorJudgmentSha256);
      this.blob(s.priorInputSha256);
      for (const m of s.material) if (materialIdentity(this.blob(m.sha256)) !== m.identity) throw new Error('supplement_material_identity_changed');
    }
    return { context, manifest, report };
  }
  /** Explicit new evidence packet, never a retry of the prior native task. */
  supplementReceiver(id: string, fixed: { judgmentId: string; bindingHash: string; source: string; reason: string; material: Array<{ name: string; bytes: Buffer }> }): Row {
    return this.transaction(() => {
      if ((this.db.prepare('PRAGMA user_version').get() as Row).user_version !== 5 || !this.supplementGuardInstalled()) throw new Error('receiver_supplements_not_enabled');
      const { op, receiver } = this.receiverOperation(id), item = this.item(op.item), packet = this.packet(op.packet), summary = parse(packet, 'summary');
      if (op.status !== 'complete' || receiver?.phase !== 'returned' || receiver.judgment?.verdict !== 'INSUFFICIENT_EVIDENCE' || receiver.judgmentId !== fixed.judgmentId || receiver.bindingHash !== fixed.bindingHash || !receiver.controllerReturned) throw new Error('supplement_requires_completed_insufficient_judgment');
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
      const inserted = this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id, fingerprint, packet.manifest_hash, packet.report_hash, packet.context_hash, JSON.stringify({ ...summary, baseFingerprint: this.basePacketFingerprint(packet), supplement }), now());
      const packetId = Number(inserted.lastInsertRowid);
      this.db.prepare('UPDATE items SET current_packet=? WHERE id=?').run(packetId, item.id);
      const result = { item: item.id, packet: packetId, previousPacket: op.packet, previousOperation: id, identity, fingerprint, depth: supplement.depth, mode: 'shadow', productionActionAllowed: false };
      this.event('receiver_supplement_registered', id, result);
      return { ...result, duplicate: false, currentPacket: packetId, modelDispatched: false };
    });
  }
  import(packet: Packet): Row {
    return this.transaction(() => {
      if ((this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value !== packet.candidate.repository.toLowerCase()) throw new Error('queue_repository_mismatch');
      const id = candidateKey(packet.candidate, packet.context);
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
      const supplement = priorSummary?.supplement;
      const fingerprint = supplement ? hash(canonical({ base: packet.fingerprint, supplement })) : packet.fingerprint;
      const summary = supplement ? { ...packet.summary, baseFingerprint: packet.fingerprint, supplement } : packet.summary;
      const inserted = this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(id, fingerprint, packet.manifestHash, packet.reportHash, packet.contextHash, JSON.stringify(summary), now());
      const packetId = Number(inserted.lastInsertRowid);
      if (!older && !conflict) this.db.prepare('UPDATE items SET current_packet=?,candidate=?,context=? WHERE id=?').run(packetId, JSON.stringify(packet.candidate), JSON.stringify(packet.context), id);
      this.event(conflict ? 'conflicting_observation_retained' : older ? 'older_observation_archived' : 'material_changed', id, { packet: packetId, fingerprint: packet.fingerprint });
      return { item: id, packet: packetId, duplicate: false, archived: older, observationConflict: effectiveConflict, currentPacket: this.item(id).current_packet, mode: 'shadow' };
    });
  }
  control(scope: string, kind: string, state: string, source: string): Row {
    if (!scope || scope.length > 128 || !source || source.length > 2048 || !['implementation', 'investment', 'merge'].includes(kind) || !['stopped', 'open'].includes(state)) throw new Error('invalid_shadow_control');
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM controls WHERE scope=? AND kind=?').get(scope, kind) as Row | undefined;
      const revision = (prior?.revision ?? 0) + 1, at = now();
      this.db.prepare('INSERT INTO controls VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,kind) DO UPDATE SET stopped=excluded.stopped,revision=excluded.revision,source=excluded.source,requested_at=excluded.requested_at,effective_at=excluded.effective_at').run(scope, kind, state === 'stopped' ? 1 : 0, revision, source, at, at);
      this.event('shadow_control', scope, { kind, state, revision, source });
      return { scope, kind, state, revision, requestedAt: at, effectiveAt: at, effect: 'local_shadow_only', externalControl: 'unverified' };
    });
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
    return this.transaction(() => {
      const item = this.item(id);
      const existing = this.db.prepare('SELECT * FROM operations WHERE packet=?').get(item.current_packet) as Row | undefined;
      if (item.observation_conflict) return { blocked: ['observation_order_conflict'], originalOperation: existing?.id ?? null, next: existing?.status === 'running' ? 'evaluate_original_operation' : 'import_jointly_current_observation', mode: 'shadow' };
      if (existing) return { operation: existing.id, status: existing.status, duplicate: true, next: existing.status === 'receiving' ? 'reconcile_original_receiver' : existing.status === 'running' ? 'evaluate_original_operation' : 'read_saved_result', mode: 'shadow' };
      const context = parse(item, 'context') as QueueContext;
      if ((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(context.scope.id) as Row | undefined)?.stopped) return { blocked: ['new_investment_stopped'], mode: 'shadow' };
      const blocked = this.prerequisites(item); if (blocked.length) return { blocked, mode: 'shadow' };
      const candidate = parse(item, 'candidate') as Candidate, target = targetKey(candidate);
      if (this.db.prepare('SELECT operation FROM claims WHERE target=?').get(target)) return { blocked: ['target_occupied_or_unknown'], mode: 'shadow' };
      const seats = Number((this.db.prepare("SELECT value FROM meta WHERE key='seats'").get() as Row).value);
      if ((this.db.prepare('SELECT COUNT(*) AS count FROM claims').get() as Row).count >= seats) return { blocked: ['reception_seats_full'], mode: 'shadow' };
      const generation = (this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM operations WHERE target=?').get(target) as Row).n + 1;
      const operation = randomUUID();
      this.db.prepare("INSERT INTO operations(id,item,packet,target,generation,run_ref,status,started_at) VALUES(?,?,?,?,?,?,'running',?)").run(operation, id, item.current_packet, target, generation, run, now());
      this.db.prepare('INSERT INTO claims VALUES(?,?,?)').run(target, operation, generation);
      this.event('shadow_evaluation_started', operation, { item: id, packet: item.current_packet, generation });
      return { operation, generation, status: 'running', mode: 'shadow', next: 'evaluate_original_operation', externalActionSent: false };
    });
  }
  evaluate(id: string): Row {
    return this.transaction(() => {
      const op = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined;
      if (!op) throw new Error('operation_not_found');
      if (op.status === 'receiving') throw new Error('original_receiver_pending');
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
      const outputs = report.stages.flatMap((stage: Row) => stage.tools.map((tool: Row) => ({ stage: stage.index, tool: tool.id,
        originals: Object.fromEntries(['stdout', 'stderr', 'result', 'sandbox'].filter(k => tool[k]).map(k => {
          const bytes = this.blob(tool[k].sha256); let text: string, encoding: string;
          try { text = new TextDecoder('utf8', { fatal: true }).decode(bytes); encoding = 'utf8'; } catch { text = bytes.toString('base64'); encoding = 'base64'; }
          return [k, { ...tool[k], encoding, text }];
        })) })));
      const supplements = [];
      for (let s = parse(packet, 'summary').supplement; s; s = s.previous) supplements.unshift({ ...s, previous: undefined, priorJudgment: JSON.parse(this.blob(s.priorJudgmentSha256).toString()), material: s.material.map((m: Row) => ({ ...m, text: new TextDecoder('utf8', { fatal: true }).decode(this.blob(m.sha256)) })) });
      return { operation: id, packet: op.packet, fingerprint: packet.fingerprint, context, manifest, report, plan: JSON.parse(this.blob(report.plan.sha256).toString()), outputs,
        ...(supplements.length ? { supplements } : {}),
        sourceArtifactScope: 'W1 artifact index included; selected exact-H source and reports supplied separately. Unprovided artifacts are not reviewed.' };
    });
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
        ...(receiver ? { input: this.blob(receiver.inputSha256), system: this.blob(receiver.systemSha256), plan: this.blob(receiver.planSha256) } : {}) };
    });
  }
  private receiverGate(op: Row): void {
    const item = this.item(op.item), packet = this.packet(op.packet), { context } = this.packetEvidence(packet);
    this.basePacketFingerprint(packet);
    if (item.current_packet !== op.packet || item.observation_conflict || !this.effectiveSummary(item, packet).evidenceComplete || !this.receiverCandidateCurrent(item)) throw new Error('receiver_current_material_unverified');
    if (this.prerequisites(item).length) throw new Error('receiver_prerequisites_unmet');
    if ((this.db.prepare("SELECT stopped FROM controls WHERE scope=? AND kind='investment'").get(context.scope.id) as Row | undefined)?.stopped) throw new Error('new_investment_stopped');
    if ((this.db.prepare('PRAGMA user_version').get() as Row).user_version === 5 && this.receiverDispatchCount(item.id) >= 3) throw new Error('receiver_three_batch_limit');
  }
  private receiverDispatchCount(item: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE item=? AND json_extract(result,'$.receiver.dispatchRegisteredAt') IS NOT NULL").get(item) as Row).n;
  }
  /** Later phase of the same operation; no second queue or automatic retries. */
  reserveReceiver(id: string, fixed: { plan: Buffer; input: Buffer; system: Buffer; bindingHash: string; judgmentId: string; fingerprint: string; executionKind: string }): Row {
    this.requireReceiverMode();
    if (!this.receiverGuardsInstalled()) throw new Error('receiver_storage_guards_missing_enable_when_idle');
    if ((this.db.prepare('PRAGMA user_version').get() as Row).user_version === 5 && !this.supplementGuardInstalled()) throw new Error('receiver_supplement_guard_missing_enable_when_idle');
    return this.transaction(() => {
      const { op, result, receiver } = this.receiverOperation(id);
      if (receiver) {
        if (receiver.planSha256 !== hash(fixed.plan)) throw new Error('receiver_plan_changed');
        return { duplicate: true, receiver };
      }
      if (op.status !== 'complete' || result?.status !== 'evaluated' || this.packet(op.packet).fingerprint !== fixed.fingerprint) throw new Error('receiver_shadow_evaluation_required');
      this.receiverGate(op);
      if (this.db.prepare('SELECT operation FROM claims WHERE target=?').get(op.target)) throw new Error('target_occupied_or_unknown');
      const seats = Number((this.db.prepare("SELECT value FROM meta WHERE key='seats'").get() as Row).value);
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM claims').get() as Row).n >= seats) throw new Error('reception_seats_full');
      const generation = (this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM operations WHERE target=?').get(op.target) as Row).n + 1;
      for (const bytes of [fixed.plan, fixed.input, fixed.system]) this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash(bytes), bytes);
      const record = { judgmentId: fixed.judgmentId, bindingHash: fixed.bindingHash, packetFingerprint: fixed.fingerprint, planSha256: hash(fixed.plan), inputSha256: hash(fixed.input), systemSha256: hash(fixed.system),
        executionKind: fixed.executionKind, controllerPid: process.pid, controllerReturned: false, phase: 'reserved', registeredAt: now(), directory: join(this.directory, `receiver-${id}`) };
      this.db.prepare("UPDATE operations SET status='receiving',generation=?,result=?,finished_at=NULL WHERE id=?").run(generation, JSON.stringify({ ...result, generation, shadowEvaluation: result, independentReception: 'running_or_unknown', receiver: record }), id);
      this.db.prepare('INSERT INTO claims VALUES(?,?,?)').run(op.target, id, generation);
      this.event('receiver_reserved', id, { generation, judgmentId: record.judgmentId, bindingHash: record.bindingHash });
      return { duplicate: false, receiver: record };
    });
  }
  receiverDispatch(id: string, bindingHash: string): void {
    this.transaction(() => {
      if (!this.receiverGuardsInstalled()) throw new Error('receiver_storage_guards_missing_enable_when_idle');
      const { op, result, receiver } = this.receiverOperation(id);
      if (op.status !== 'receiving' || receiver?.phase !== 'reserved' || receiver.bindingHash !== bindingHash) throw new Error('receiver_dispatch_already_registered');
      this.receiverGate(op); this.receiverClaim(op); receiver.phase = 'dispatch_registered'; receiver.dispatchRegisteredAt = now();
      result.externalActionSent = receiver.executionKind === 'fixture' ? false : 'unknown'; result.externalActionKind = 'readonly_model_request'; result.externalProductionActionSent = false;
      this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result), id); this.event('receiver_dispatch_registered', id, { bindingHash });
    });
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
  private receiverCandidateCurrent(item: Row): boolean {
    const current = parse(item, 'candidate') as Candidate, context = parse(item, 'context') as QueueContext;
    // H/B/target changes create another item. Compare source observations across
    // the PR, never W2 completion/arrival time: a fresh test of old H is not new H.
    const others = this.db.prepare("SELECT candidate,context,latest_source_observation FROM items WHERE id!=? AND lower(json_extract(candidate,'$.repository'))=? AND json_extract(candidate,'$.pr')=?").all(item.id, current.repository.toLowerCase(), current.pr) as Row[];
    for (const other of others) {
      const candidate = parse(other, 'candidate') as Candidate, otherContext = parse(other, 'context') as QueueContext;
      // A new context version in this same scope can make the selected task
      // ambiguous; it does not adopt another scope or grant any new permission.
      const sameContext = context.scope.id !== otherContext.scope.id || context.scope.version === otherContext.scope.version && context.arrangement.id === otherContext.arrangement.id && context.arrangement.version === otherContext.arrangement.version;
      if (candidate.H === current.H && candidate.B === current.B && candidate.targetRef === current.targetRef && sameContext) continue;
      if (!item.latest_source_observation || !other.latest_source_observation || other.latest_source_observation >= item.latest_source_observation) return false;
    }
    return true;
  }
  private currentReceiverResult(op: Row, result: Row | null): Row | null {
    if (!result?.receiver) return result;
    const item = this.item(op.item), current = item.current_packet === op.packet && !item.observation_conflict && this.receiverCandidateCurrent(item);
    return { ...result, receiver: { ...result.receiver, materialMatchedAtReturn: result.receiver.currentMaterialMatches, currentMaterialMatches: current },
      gaps: [...new Set([...result.gaps, ...(!current ? ['newer_material_requires_own_reception'] : [])])] };
  }
  finishReceiver(id: string, bindingHash: string, judgment: Row | null, originals: Record<string, Buffer>, closeSource?: string): Row {
    return this.transaction(() => {
      const { op, result, receiver } = this.receiverOperation(id);
      if (!receiver || receiver.bindingHash !== bindingHash) throw new Error('receiver_binding_mismatch');
      if (op.status === 'complete') return { operation: id, duplicate: true, ...this.currentReceiverResult(op, result) };
      if (op.status !== 'receiving' || (!judgment && !closeSource)) throw new Error('receiver_completion_unverified');
      this.receiverClaim(op); this.packetEvidence(this.packet(op.packet));
      const blobs: Record<string, Row> = {};
      for (const [name, bytes] of Object.entries(originals)) {
        const sha256 = hash(bytes); this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha256, bytes); blobs[name] = { sha256, bytes: bytes.length };
      }
      const item = this.item(op.item), current = item.current_packet === op.packet && !item.observation_conflict && this.receiverCandidateCurrent(item);
      const r = { ...receiver, phase: judgment ? 'returned' : 'closed_unresolved', finishedAt: now(), judgment, closeSource: closeSource ?? null, blobs,
        currentMaterialMatches: current, newTaskSentOnRecovery: false };
      const completed = { ...result, status: 'receiver_evaluated', receiver: r, independentReception: judgment ? receiver.executionKind === 'fixture' ? 'fixture_judgment_recorded' : 'judgment_recorded' : 'closed_without_judgment',
        productionActionAllowed: false, externalProductionActionSent: false, externalActionKind: 'readonly_model_request',
        externalActionSent: receiver.executionKind === 'fixture' ? false : judgment ? true : receiver.phase === 'dispatch_registered' ? 'unknown' : false,
        modelDispatchStatus: judgment ? 'returned_final' : receiver.phase === 'dispatch_registered' ? 'submitted_or_unknown' : 'not_dispatched', modelRequestRegistered: receiver.phase === 'dispatch_registered',
        controlsAtReturn: this.db.prepare('SELECT kind,stopped,revision FROM controls WHERE scope=? ORDER BY kind').all(parse(item, 'context').scope.id),
        gaps: [...result.gaps.filter((g: string) => g !== 'independent_receiver_unavailable' || !judgment || receiver.executionKind === 'fixture'), ...(!current ? ['newer_material_requires_own_reception'] : []), ...(!judgment ? ['original_receiver_result_unresolved'] : [])],
        next: judgment ? 'read_scoped_judgment_no_automatic_merge' : 'retain_unresolved_original_no_automatic_retry' };
      this.db.prepare("UPDATE operations SET status='complete',finished_at=?,result=? WHERE id=?").run(now(), JSON.stringify(completed), id);
      this.db.prepare('DELETE FROM claims WHERE target=? AND operation=? AND generation=?').run(op.target, id, op.generation);
      this.event(judgment ? 'receiver_judgment_recorded' : 'receiver_closed_unresolved', id, { bindingHash, currentMaterialMatches: current, closeSource: closeSource ?? null });
      return { operation: id, ...completed };
    });
  }
  private effectiveSummary(item: Row, packet: Row): Row {
    const summary = parse(packet, 'summary');
    return { ...summary, evidenceComplete: summary.evidenceComplete && !item.observation_conflict, gaps: [...summary.gaps, ...(item.observation_conflict ? ['observation_order_conflict'] : [])] };
  }
  private itemStatus(item: Row): Row {
    return { id: item.id, candidate: parse(item, 'candidate'), currentPacket: item.current_packet, latestObservation: item.latest_observation, latestSourceObservation: item.latest_source_observation, observationConflict: Boolean(item.observation_conflict), context: parse(item, 'context'), summary: this.effectiveSummary(item, this.packet(item.current_packet)), dependencyGaps: this.prerequisites(item), ...(item.observation_conflict ? { materialHistory: (this.db.prepare('SELECT id,manifest_hash,report_hash,summary FROM packets WHERE item=? ORDER BY id').all(item.id) as Row[]).map(p => ({ packet: p.id, manifestHash: p.manifest_hash, reportHash: p.report_hash, summary: parse(p, 'summary') })) } : {}) };
  }
  status(): Row {
    this.db.exec('BEGIN');
    try {
      const result = { schemaVersion: (this.db.prepare('PRAGMA user_version').get() as Row).user_version, receiverEnabled: [4, 5].includes((this.db.prepare('PRAGMA user_version').get() as Row).user_version), mode: 'shadow', repository: (this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value, productionActionAllowed: false, publisher: 'pending_publish', independentReceiver: 'explicit_cli_requires_preflight', items: (this.db.prepare('SELECT * FROM items ORDER BY created_at,id').all() as Row[]).map(i => this.itemStatus(i)), controls: this.db.prepare('SELECT * FROM controls ORDER BY scope,kind').all(), claims: this.db.prepare('SELECT * FROM claims').all(), operations: (this.db.prepare('SELECT * FROM operations ORDER BY started_at,id').all() as Row[]).map(o => ({ ...o, result: this.currentReceiverResult(o, parse(o, 'result') ?? null), recovery: o.status === 'receiving' ? 'receiver_unknown_reconcile_original_operation' : o.status === 'running' ? 'result_unknown_evaluate_original_operation' : null })), events: this.db.prepare('SELECT * FROM events ORDER BY id').all() };
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

function parseQueueContextBlob(bytes: Buffer): QueueContext { return JSON.parse(bytes.toString()) as QueueContext; }
