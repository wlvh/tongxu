import { appendFileSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
const allowed = new Set(['initialize', 'thread/start', 'thread/read', 'turn/steer']);

// This client is only for a new, owned, isolated inspection process. It has no
// endpoint/credential configuration and never accepts server tool or approval requests.
export class InspectionRpc {
  readonly events: unknown[] = [];
  readonly gaps: string[] = [];
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private buffer = Buffer.alloc(0);
  private captured = 0;
  private sent = 0;
  private nextId = 1;
  private failure: Error | null = null;
  private closing = false;
  private pending = new Map<number, Pending>();
  private closed: Promise<void>;
  constructor(private child: ChildProcessWithoutNullStreams, private paths: { stdin: string; stdout: string; stderr: string }, private limits = { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 }) {
    this.closed = new Promise(resolve => child.once('close', (code, signal) => { this.exit = { code, signal }; if (!this.closing) this.fail('native_process_closed'); resolve(); }));
    child.on('error', () => this.fail('native_process_error'));
    child.stdin.on('error', () => this.fail('native_input_closed'));
    child.stderr.on('data', chunk => this.capture('stderr', Buffer.from(chunk)));
    child.stdout.on('data', chunk => {
      const bytes = this.capture('stdout', Buffer.from(chunk));
      if (this.failure) return;
      this.buffer = Buffer.concat([this.buffer, bytes]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        if (!line.toString().trim()) continue;
        try { this.receive(JSON.parse(line.toString())); } catch { this.fail('invalid_native_json'); }
        if (this.failure) return;
      }
    });
  }
  private capture(stream: 'stdout' | 'stderr', bytes: Buffer): Buffer {
    const kept = bytes.subarray(0, Math.max(0, this.limits.maxBytes - this.captured)); this.captured += kept.length;
    try { appendFileSync(this.paths[stream], kept); } catch { this.fail('native_evidence_write_failed'); }
    if (kept.length !== bytes.length) this.fail('native_output_limit');
    return kept;
  }
  private send(message: unknown): void {
    const line = JSON.stringify(message) + '\n';
    this.sent += Buffer.byteLength(line);
    if (this.sent > this.limits.maxBytes) { this.fail('native_input_limit'); throw new Error('native_input_limit'); }
    appendFileSync(this.paths.stdin, line); this.events.push({ direction: 'send', message }); this.child.stdin.write(line);
  }
  private receive(message: any): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail('invalid_native_message'); return; }
    this.events.push({ direction: 'receive', message });
    if (typeof message.method === 'string') {
      if ('id' in message) {
        if (typeof message.id !== 'string' && typeof message.id !== 'number') { this.fail('invalid_native_request_id'); return; }
        this.gaps.push('unexpected_native_request_denied');
        this.send({ id: message.id, error: { code: -32601, message: 'No tool or approval handler is registered for this inspection.' } });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) { this.fail('unexpected_native_response_id'); return; }
    if (('result' in message) === ('error' in message) || ('error' in message && (!message.error || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string'))) { this.fail('invalid_native_response'); return; }
    clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message);
  }
  private fail(code: string): void {
    if (this.failure) return;
    this.failure = new Error(code); this.gaps.push(code);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.failure); } this.pending.clear();
  }
  async request(method: string, params: unknown, beforeSend: (id: number) => Promise<void> = async () => {}): Promise<any> {
    if (!allowed.has(method)) throw new Error('native_method_not_registered');
    if (this.failure) throw this.failure;
    const id = this.nextId++; await beforeSend(id);
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('native_request_timeout'), this.limits.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch { this.fail('native_evidence_or_send_failed'); }
    });
  }
  initialized(): void { if (this.failure) throw this.failure; this.send({ method: 'initialized', params: {} }); }
  async close(): Promise<void> {
    this.closing = true;
    if (this.pending.size) this.fail('inspection_closed_with_unknown_request');
    this.child.stdin.end();
    const wait = async (ms: number) => { let timer: NodeJS.Timeout | undefined; await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); if (timer) clearTimeout(timer); };
    const signal = (sig: NodeJS.Signals) => { if (!this.exit && this.child.exitCode === null && this.child.signalCode === null && this.child.pid) { try { process.kill(-this.child.pid, sig); } catch { /* already exited */ } } };
    await wait(1000); signal('SIGTERM'); await wait(1000); signal('SIGKILL'); await wait(1000);
    if (!this.exit) this.gaps.push('inspection_process_exit_unknown');
    if (this.exit?.code !== null && this.exit?.code !== undefined && this.exit.code !== 0) this.gaps.push('native_nonzero_exit');
    if (this.buffer.toString().trim()) this.gaps.push('incomplete_native_frame');
  }
}
