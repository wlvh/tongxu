import { mkdir, lstat, readFile, writeFile, rename, unlink, link } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Artifact, ContextNote, Manifest } from './contract.js';
import { now, repoPattern, shaPattern } from './contract.js';

export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const digestPattern = /^[0-9a-f]{64}$/;
const artifactPattern = /^(raw\/[0-9a-f]{64}\.json|git\/[0-9a-f]{64}\.(patch|json))$/;
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function externalPath(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) throw new Error('output_must_be_absolute_normalized_directory');
  let p = path;
  while (true) {
    if (await exists(p)) {
      const stat = await lstat(p);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('output_symlink_or_non_directory');
      if (await exists(join(p, '.git')) || (await exists(join(p, 'HEAD')) && await exists(join(p, 'objects')))) throw new Error('output_inside_git_repository');
    }
    if (p === dirname(p)) break;
    p = dirname(p);
  }
  return path;
}
export async function privateDirectory(path: string, create: boolean): Promise<void> {
  await externalPath(path);
  if (create) await mkdir(path, { mode: 0o700 }); // EEXIST deliberately rejects overwrites.
  const stat = await lstat(path);
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('directory_must_be_private_and_owned');
}
export function parseContext(value: unknown): ContextNote[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('invalid_context');
  const kinds = ['owner_adoption_report', 'team_agreement', 'delegated_action', 'proposal', 'fact', 'unknown'];
  return value.map(n => {
    if (!n || typeof n !== 'object' || ['sourceId', 'sourceBodyHash', 'locator', 'scope', 'note'].some(k => typeof n[k] !== 'string') || !digestPattern.test(n.sourceBodyHash) || !kinds.includes(n.kind)) throw new Error('invalid_context');
    if (n.version !== undefined && n.version !== null && typeof n.version !== 'string') throw new Error('invalid_context_version');
    for (const [key, fields] of [['role', ['account', 'claimedRole', 'taskOwner', 'executor']], ['relation', ['type', 'object', 'version', 'blocks', 'canContinue']], ['action', ['step', 'exitCondition']]] as const) {
      if (n[key] !== undefined && (!n[key] || fields.some(k => typeof n[key][k] !== 'string'))) throw new Error('invalid_context_detail');
    }
    if (n.relation && !['development', 'merge', 'enablement', 'parent'].includes(n.relation.type)) throw new Error('invalid_relation_type');
    return { sourceId: n.sourceId, sourceBodyHash: n.sourceBodyHash, locator: n.locator, kind: n.kind, scope: n.scope, note: n.note, version: n.version ?? null, ...(n.role ? { role: n.role } : {}), ...(n.relation ? { relation: n.relation } : {}), ...(n.action ? { action: n.action } : {}) };
  });
}
export class Snapshot {
  private lockId = randomUUID();
  private locked = false;
  private constructor(readonly directory: string, readonly manifest: Manifest) {}
  static async create(directory: string, repository: string, pr: number, issues: number[], context: ContextNote[]): Promise<Snapshot> {
    await privateDirectory(directory, true);
    await mkdir(join(directory, 'raw'), { mode: 0o700 });
    await mkdir(join(directory, 'git'), { mode: 0o700 });
    const s = new Snapshot(directory, { schemaVersion: 1, repository, pr, issues, context, candidate: null, artifacts: [], rounds: [], gitFiles: [], gitCommits: [], gitComplete: false, createdAt: now() });
    await s.lock();
    await s.save();
    return s;
  }
  static async resume(directory: string): Promise<Snapshot> {
    await privateDirectory(directory, false);
    // Acquire before reading: a writer finishing between read and lock must not lose its last pages.
    const s = new Snapshot(directory, {} as Manifest);
    await s.lock();
    try {
    const stat = await lstat(join(directory, 'manifest.json'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('invalid_manifest');
    const m = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
    if (m.schemaVersion !== 1 || !repoPattern.test(m.repository) || !Number.isSafeInteger(m.pr) || m.pr <= 0 || !Array.isArray(m.issues) || m.issues.some(n => !Number.isSafeInteger(n) || n <= 0) || !Array.isArray(m.artifacts) || !Array.isArray(m.rounds) || !Array.isArray(m.gitFiles) || !Array.isArray(m.gitCommits)) throw new Error('invalid_manifest');
    m.context = parseContext(m.context);
    if (m.candidate && (!shaPattern.test(m.candidate.H) || !shaPattern.test(m.candidate.B) || m.candidate.repository !== m.repository || m.candidate.pr !== m.pr || typeof m.candidate.targetRef !== 'string')) throw new Error('invalid_manifest_candidate');
      Object.assign(s.manifest, m);
      for (const a of m.artifacts) {
        if (!artifactPattern.test(a.path) || !digestPattern.test(a.sha256)) throw new Error('invalid_artifact_path');
        const file = join(directory, a.path);
        const parent = await lstat(dirname(file));
        const st = await lstat(file);
        if (parent.isSymbolicLink() || st.isSymbolicLink() || !st.isFile() || st.size !== a.bytes || hash(await readFile(file)) !== a.sha256) throw new Error('artifact_integrity_failed');
      }
      return s;
    } catch (e) { await s.close(); throw e; }
  }
  private async lock(): Promise<void> {
    const path = join(this.directory, 'lock.json');
    const value = JSON.stringify({ id: this.lockId, pid: process.pid, host: hostname(), startedAt: now() });
    try { await writeFile(path, value, { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const recovery = join(this.directory, 'recovery.lock');
      await writeFile(recovery, this.lockId, { flag: 'wx', mode: 0o600 });
      try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid_lock');
      const old = JSON.parse(await readFile(path, 'utf8'));
      if (old.host !== hostname() || !Number.isInteger(old.pid) || old.pid <= 0) throw new Error('writer_state_unknown');
      let dead = false;
      try { process.kill(old.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead) throw new Error('writer_active_or_unknown');
      // No timeout takeover. Only an absent process on this host permits recovery.
      // link-free rename preserves the prior lock as evidence; concurrent recovery uses wx below.
      await rename(path, join(this.directory, `abandoned-lock-${randomUUID()}.json`));
      await writeFile(path, value, { flag: 'wx', mode: 0o600 });
      } finally { await unlink(recovery); }
    }
    this.locked = true;
  }
  async close(): Promise<void> {
    if (!this.locked) return;
    const path = join(this.directory, 'lock.json');
    const lock = JSON.parse(await readFile(path, 'utf8'));
    if (lock.id === this.lockId) await unlink(path);
    this.locked = false;
  }
  async atomic(name: string, bytes: string | Buffer): Promise<void> {
    const temp = join(this.directory, `.tmp-${randomUUID()}`);
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temp, join(this.directory, name));
  }
  async save(): Promise<void> { await this.atomic('manifest.json', JSON.stringify(this.manifest, null, 2) + '\n'); }
  async artifact(data: string | Buffer, details: Omit<Artifact, 'path' | 'bytes' | 'sha256'>, type: 'raw' | 'patch' | 'git-json' = 'raw'): Promise<Artifact> {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const digest = hash(bytes);
    const path = `${type === 'raw' ? 'raw' : 'git'}/${digest}.${type === 'patch' ? 'patch' : 'json'}`;
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      // Atomic publication without replacing an existing digest. Interrupted writes stay temporary.
      try { await link(temporary, join(this.directory, path)); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const stat = await lstat(join(this.directory, path));
        if (!stat.isFile() || stat.isSymbolicLink() || hash(await readFile(join(this.directory, path))) !== digest) throw new Error('artifact_integrity_failed');
      }
    } finally { await unlink(temporary); }
    const artifact = { ...details, path, bytes: bytes.length, sha256: digest };
    this.manifest.artifacts.push(artifact);
    return artifact;
  }
}
