import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { hash, privateDirectory } from './snapshot.js';
import {selectExternalExecutable,assertExternalExecutable,type ExternalExecutable} from './external-executable.js';
import {cliVersion,probeCliCapabilities,type CliRequirement} from './cli-capabilities.js';

export const save = (path: string, value: unknown) => {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, path);
};
export async function executable(path: string, requirement: CliRequirement, executionKind:'fixture'|'native_capture'='native_capture') {
  if (!isAbsolute(path)) throw new Error('executable_must_be_absolute');
  const selected=selectExternalExecutable(path),actual=selected.realpath,info=await stat(actual);
  if (!info.isFile() || !(info.mode & 0o111)) throw new Error('invalid_executable');
  const version = await new Promise<string>((resolve, reject) => {
    const p = spawn(actual, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }); let text = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('version_timeout')); }, 10_000);
    p.stdout.on('data', b => { text += b; }); p.stderr.resume(); p.once('error', reject);
    p.once('close', code => { clearTimeout(timer); code === 0 ? resolve(text.trim()) : reject(new Error('version_failed')); });
  });
  const sha256=hash(await readFile(actual));
  cliVersion(version,requirement.tool);
  const capabilities=await probeCliCapabilities(actual,requirement,executionKind);
  if('initialization'in capabilities&&capabilities.initialization.reportedVersion!==cliVersion(version,'claude'))throw new Error('executor_changed_during_capability_check');
  assertExternalExecutable(selected);
  return {path,realpath:actual,version,sha256,externalSelection:selected,selection:'configured-current-v1' as const,capabilities};
}

/** A new owned process only. Raw bytes are durable before interpretation. Never retries. */
export class LiveProcess {
  readonly events: any[] = [];
  readonly process;
  readonly closed: Promise<void>;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  failure: string | null = null;
  private partial = Buffer.alloc(0);
  private bytes = 0;
  private sequence = 0;
  private serving = Promise.resolve();
  private closing = false;
  private replies = new Map<string, { request: string; response: unknown }>();
  private pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly directory: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly onRequest?: (m: any) => Promise<unknown>, expected?:ExternalExecutable,private readonly protocol:'codex'|'acp'='codex') {
    const selected=expected??selectExternalExecutable(command);
    if(selected.configuredPath!==command)throw new Error('external_executable_selection_mismatch');
    assertExternalExecutable(selected);
    for (const name of ['stdout.ndjson', 'stderr.txt', 'stdin.ndjson']) writeFileSync(join(directory, name), '', { flag: 'wx', mode: 0o600 });
    save(join(directory, 'launch.json'), { command, executableSelection:selected, args, cwd, startedAt: new Date().toISOString(), status: 'launch_registered' });
    this.process = spawn(selected.realpath, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    save(join(directory, 'process.json'), { pid: this.process.pid, status: 'spawn_attempted' });
    this.closed = new Promise(resolve => this.process.once('close', (code, signal) => {
      this.exit = { code, signal }; save(join(directory, 'exit.json'), { code, signal, at: new Date().toISOString() });
      try{assertExternalExecutable(selected);}catch{this.fail('external_executable_changed_during_operation');}
      if (this.partial.toString().trim()) this.fail('incomplete_output_frame');
      save(join(directory, 'capture-status.json'), { status: this.failure ? 'failed' : 'complete', failure: this.failure,
        files: Object.fromEntries(['stdout.ndjson', 'stderr.txt', 'stdin.ndjson'].map(name => [name, hash(readFileSync(join(directory, name)))])) });
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('executor_closed')); } this.pending.clear(); resolve();
    }));
    this.process.on('error', () => this.fail('executor_spawn_error'));
    this.process.stdin.on('error', () => this.fail('executor_input_closed'));
    this.process.stdout.on('data', b => {
      if (!this.capture('stdout.ndjson', b)) return;
      this.partial = Buffer.concat([this.partial, b]);
      let n: number;
      while ((n = this.partial.indexOf(10)) >= 0) {
        const line = this.partial.subarray(0, n); this.partial = this.partial.subarray(n + 1); if (!line.toString().trim()) continue;
        try { this.receive(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line))); } catch { this.fail('invalid_executor_json'); }
      }
    });
    this.process.stderr.on('data', b => this.capture('stderr.txt', b));
  }
  private capture(name: string, bytes: Buffer) {
    this.bytes += bytes.length;
    if (this.bytes > 16 * 1024 * 1024) { this.fail('executor_output_limit'); this.process.kill('SIGTERM'); return false; }
    appendFileSync(join(this.directory, name), bytes); return true;
  }
  private receive(m: any) {
    this.events.push(m);
    if (typeof m?.method === 'string' && 'id' in m) {
      if(this.protocol==='acp'&&m.method==='session/request_permission'){
        this.send({id:m.id,result:{outcome:{outcome:'cancelled'}}});this.fail('external_cli_tool_request_denied');return;
      }
      if (this.onRequest && m.method === 'item/tool/call') {
        this.serving = this.serving.then(async () => {
          if (this.closing || this.failure) throw new Error('executor_not_accepting_tools');
          const key = JSON.stringify(m.id), prior = this.replies.get(key), encoded = JSON.stringify(m);
          if (prior) { if (prior.request !== encoded) throw new Error('conflicting_tool_request_id'); this.send(prior.response); return; }
          const result = await this.onRequest!(m), response = { id: m.id, result };
          this.replies.set(key, { request: encoded, response }); this.send(response);
        }).catch(e => { this.fail(e instanceof Error ? e.message : 'dynamic_tool_failed'); this.send({ id: m.id, error: { code: -32603, message: this.failure } }); });
        return;
      }
      this.send({ id: m.id, error: { code: -32601, message: 'This read-only relay grants no approval or external tool request.' } });
      this.fail('executor_request_denied'); return;
    }
    const p = this.pending.get(m?.id);
    if (p && !('method' in m)) { clearTimeout(p.timer); this.pending.delete(m.id); 'error' in m ? p.reject(new Error('executor_rpc_error')) : p.resolve(m.result); }
  }
  private fail(reason: string) {
    if (!this.failure) { this.failure = reason; save(join(this.directory, 'capture-failure.json'), { reason }); }
  }
  send(message: unknown) {
    const line = JSON.stringify(this.protocol==='acp'?{jsonrpc:'2.0',...(message as object)}:message) + '\n'; appendFileSync(join(this.directory, 'stdin.ndjson'), line); this.process.stdin.write(line);
  }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.failure || this.exit) throw new Error(this.failure ?? 'executor_closed');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('executor_rpc_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  writeText(text: string) { appendFileSync(join(this.directory, 'stdin.ndjson'), text); this.process.stdin.end(text); }
  async waitFor(predicate: (m: any) => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(predicate); if (found) return found;
      if (this.failure || this.exit) throw new Error(this.failure ?? 'executor_closed_before_result');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('executor_wait_timeout');
  }
  async close() {
    this.closing = true;
    await this.serving;
    this.process.stdin.end();
    const wait = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); this.closed.then(() => { clearTimeout(t); resolve(); }); });
    await wait(1000);
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!this.exit && this.process.pid) { try { process.kill(-this.process.pid, signal); } catch { /* owned process already gone */ } }
      await wait(1000);
    }
  }
}

export async function newStage(path: string) { await privateDirectory(path, true); return path; }

/** A recorded transport rejection is not erased by an otherwise valid final.
 * Old completed executions remain readable, but missing legacy completion
 * receipts cannot establish that the old in-memory capture checks succeeded. */
export async function checkCapture(directory: string) {
  const optional = async (name: string) => { try { return JSON.parse(await readFile(join(directory, name), 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; } };
  if (await optional('capture-failure.json')) throw new Error('stage_capture_failed');
  const status = await optional('capture-status.json');
  if (status) {
    if (status.status !== 'complete' || status.failure !== null) throw new Error('stage_capture_failed');
    for (const name of ['stdout.ndjson', 'stderr.txt', 'stdin.ndjson']) if (hash(await readFile(join(directory, name))) !== status.files?.[name]) throw new Error('stage_capture_integrity_failed');
  } else {
    const legacy = await optional('completed.json');
    if (!legacy || hash(await readFile(join(directory, 'stdout.ndjson'))) !== legacy.rawSha256) throw new Error('legacy_capture_completion_unknown');
  }
}
