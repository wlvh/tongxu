import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

// Version output is evidence too: stream it to private files before interpreting it.
// This only owns a newly created isolated process, never an existing native session.
export async function captureVersion(prefix: string[], paths: { stdout: string; stderr: string }, registered: (pid: number | null) => Promise<void>, limits = { maxBytes: 128 * 1024, timeoutMs: 15_000 }) {
  for (const path of Object.values(paths)) await writeFile(path, '', { flag: 'wx', mode: 0o600 });
  const child = spawn('bwrap', [...prefix, '--version'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const gaps: string[] = []; let captured = 0, escalation: NodeJS.Timeout | undefined;
  const signal = (kind: NodeJS.Signals) => { if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, kind); } catch { /* already exited */ } } };
  const stop = (gap: string) => { gaps.push(gap); signal('SIGTERM'); escalation ??= setTimeout(() => signal('SIGKILL'), 1000); };
  const capture = (stream: 'stdout' | 'stderr', bytes: Buffer) => {
    const kept = bytes.subarray(0, Math.max(0, limits.maxBytes - captured)); captured += kept.length;
    try { appendFileSync(paths[stream], kept); } catch { stop('native_version_evidence_write_failed'); }
    if (kept.length !== bytes.length && !gaps.includes('native_version_output_limit')) stop('native_version_output_limit');
  };
  const timer = setTimeout(() => stop('native_version_timeout'), limits.timeoutMs);
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.stdout.on('data', bytes => capture('stdout', Buffer.from(bytes)));
    child.stderr.on('data', bytes => capture('stderr', Buffer.from(bytes)));
    child.on('error', () => stop('native_version_process_error'));
    child.once('close', (code, signal) => { clearTimeout(timer); if (escalation) clearTimeout(escalation); resolve({ code, signal }); });
  });
  try { await registered(child.pid ?? null); } catch { stop('native_version_registration_failed'); }
  const exit = await completed;
  if (exit.code !== 0) gaps.push('native_version_exit_unverified');
  return { exit, gaps: [...new Set(gaps)] };
}
