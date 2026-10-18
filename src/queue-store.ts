import { DatabaseSync } from 'node:sqlite';
import { lstat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, privateDirectory } from './snapshot.js';
import { repoPattern, now } from './contract.js';
import { candidateKey, targetKey } from './queue-evidence.js';
import type { Packet, QueueContext } from './queue-evidence.js';
import type { Candidate } from './contract.js';

type Row = Record<string, any>;
const parse = (row: Row | undefined, key: string): any => row ? JSON.parse(row[key]) : undefined;
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
      if (version.user_version !== 3 || (db.prepare("SELECT value FROM meta WHERE key='mode'").get() as Row)?.value !== 'shadow') throw new Error('unsupported_queue_schema_or_mode');
      return new QueueStore(directory, db);
    } catch (e) { db.close(); throw e; }
  }
  close(): void { this.db.close(); }
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
  private packetEvidence(packet: Row): { context: QueueContext; manifest: any; report: any } {
    const context = parseQueueContextBlob(this.blob(packet.context_hash)), manifest = JSON.parse(this.blob(packet.manifest_hash).toString()), report = JSON.parse(this.blob(packet.report_hash).toString());
    const references = [report.plan, ...report.inputs.map((i: any) => i.manifest), ...manifest.artifacts];
    if (report.failureOutput) references.push(report.failureOutput.stdout, report.failureOutput.stderr);
    for (const stage of report.stages) {
      if (stage.mergeOutput) references.push(stage.mergeOutput);
      for (const tool of stage.tools) for (const key of ['stdout', 'stderr', 'result']) if (tool[key]) references.push(tool[key]);
    }
    for (const ref of references) this.blob(ref.sha256);
    return { context, manifest, report };
  }
  import(packet: Packet): Row {
    return this.transaction(() => {
      if ((this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value !== packet.candidate.repository.toLowerCase()) throw new Error('queue_repository_mismatch');
      const id = candidateKey(packet.candidate, packet.context);
      for (const [digest, bytes] of packet.blobs) { if (hash(bytes) !== digest) throw new Error('invalid_import_blob'); this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(digest, bytes); this.blob(digest); }
      this.db.prepare('INSERT OR IGNORE INTO items(id,candidate,context,created_at) VALUES(?,?,?,?)').run(id, JSON.stringify(packet.candidate), JSON.stringify(packet.context), now());
      const item = this.item(id), previous = item.current_packet ? this.packet(item.current_packet) : undefined;
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
        : order.includes(null) || (order.includes(-1) && order.includes(1)) || (order.every(n => n === 0) && previous.fingerprint !== packet.fingerprint)));
      const older = Boolean(previous && !conflict && order.includes(-1));
      const effectiveConflict = conflict;
      const maximum = incoming.map((value, i) => value && (!watermark[i] || value > watermark[i]) ? value : watermark[i] ?? null);
      this.db.prepare('UPDATE items SET latest_observation=?,latest_source_observation=?,observation_conflict=? WHERE id=?').run(maximum[0], maximum[1], effectiveConflict ? 1 : 0, id);
      // Deduplication is relative to the current state, not every fingerprint in history.
      if (previous?.fingerprint === packet.fingerprint && !item.observation_conflict && !conflict) {
        this.event(older ? 'older_duplicate_archived' : 'duplicate_observation_recorded', id, { packet: previous.id, observation: packet.summary.observation, sourceObservation: packet.summary.sourceObservation });
        return { item: id, packet: previous.id, duplicate: true, archived: older, currentPacket: item.current_packet, mode: 'shadow' };
      }
      const inserted = this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(id, packet.fingerprint, packet.manifestHash, packet.reportHash, packet.contextHash, JSON.stringify(packet.summary), now());
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
      if (existing) return { operation: existing.id, status: existing.status, duplicate: true, next: existing.status === 'running' ? 'evaluate_original_operation' : 'read_saved_result', mode: 'shadow' };
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
      if (op.status === 'complete') return { operation: id, duplicate: true, ...parse(op, 'result') };
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
      const result = { mode: 'shadow', repository: (this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value, productionActionAllowed: false, publisher: 'pending_publish', independentReceiver: 'unavailable', items: (this.db.prepare('SELECT * FROM items ORDER BY created_at,id').all() as Row[]).map(i => this.itemStatus(i)), controls: this.db.prepare('SELECT * FROM controls ORDER BY scope,kind').all(), claims: this.db.prepare('SELECT * FROM claims').all(), operations: (this.db.prepare('SELECT * FROM operations ORDER BY started_at,id').all() as Row[]).map(o => ({ ...o, result: parse(o, 'result') ?? null, recovery: o.status === 'running' ? 'result_unknown_evaluate_original_operation' : null })), events: this.db.prepare('SELECT * FROM events ORDER BY id').all() };
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

function parseQueueContextBlob(bytes: Buffer): QueueContext { return JSON.parse(bytes.toString()) as QueueContext; }
