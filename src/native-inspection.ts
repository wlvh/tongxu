import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { access, chmod, lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { hash, privateDirectory } from './snapshot.js';
import { InspectionRpc } from './native-rpc.js';

const exec = promisify(execFile);
const safeCode = (e: unknown): string => e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'native_inspection_failed';
async function binaryHash(path: string): Promise<string> { const h = createHash('sha256'); for await (const part of createReadStream(path)) h.update(part); return h.digest('hex'); }
export type NativeOptions = { codex: string; output: string };
export function parseNativeArgs(args: string[]): NativeOptions {
  if (args[0] !== 'inspect') throw new Error('invalid_native_command');
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--codex', '--output'].includes(key) || values[key] || !value || !isAbsolute(value) || resolve(value) !== value) throw new Error('invalid_native_option');
    values[key] = value;
  }
  if (!values['--codex'] || !values['--output']) throw new Error('missing_native_scope');
  return { codex: values['--codex'], output: values['--output'] };
}

export async function inspectNative(o: NativeOptions): Promise<{ exit: number; report: Record<string, any> }> {
  if (process.platform !== 'linux') throw new Error('native_inspection_requires_verified_linux_bubblewrap');
  const stat = await lstat(o.codex);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(o.codex) !== o.codex) throw new Error('invalid_native_executable');
  await access(o.codex, constants.X_OK);
  await privateDirectory(o.output, true);
  const report: Record<string, any> = { schemaVersion: 1, kind: 'tongxu-native-inspection', id: randomUUID(), startedAt: new Date().toISOString(), status: 'preparing', executableHash: await binaryHash(o.codex), requests: [], observations: {}, gaps: [], capabilities: { isolatedMetadata: 'not_tested', modelTurns: 'not_tested', authentication: 'not_checked', cost: 'not_checked', secretaryControl: 'disabled', independentReceiver: 'unavailable', productionActionAllowed: false }, limitations: ['no_model_turn_started', 'no_host_credentials_or_existing_session_access', 'read_only_sandbox_does_not_prove_shell_tool_restriction', 'no_claude_runtime_test', 'no_two_turn_or_final_model_result_test', 'only_this_linux_native_version_observed'], artifacts: [] };
  const save = async () => { const path = join(o.output, '.report-new'); await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await rename(path, join(o.output, 'native-inspection.json')); };
  await save();
  // A private passwd supplies the home lookup without changing HOME/CODEX_HOME or
  // exposing the caller's real home/configuration/credentials to the native process.
  const passwd = join(o.output, 'inspection.passwd'); await writeFile(passwd, `inspection:x:${process.getuid!()}:${process.getgid!()}::/native-home:/bin/sh\n`, { flag: 'wx', mode: 0o600 });
  const prefix = ['--die-with-parent', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--clearenv', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', passwd, '/etc/passwd', '--ro-bind', o.codex, '/native/codex', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/native-home', '--dir', '/native-workspace', '--setenv', 'PATH', '/usr/bin:/bin', '--chdir', '/native-workspace', '/native/codex'];
  let rpc: InspectionRpc | undefined;
  const rawNames = ['version.stdout', 'version.stderr', 'native.stdin', 'native.stdout', 'native.stderr', 'native-events.json'];
  try {
    report.status = 'running'; report.phase = 'version'; await save();
    const version = await exec('bwrap', [...prefix, '--version'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'buffer' });
    await writeFile(join(o.output, 'version.stdout'), version.stdout, { flag: 'wx', mode: 0o600 }); await writeFile(join(o.output, 'version.stderr'), version.stderr, { flag: 'wx', mode: 0o600 });
    report.version = version.stdout.toString().trim(); if (!/^codex-cli [0-9][^\r\n]{0,120}$/.test(report.version)) throw new Error('unrecognized_native_version');
    const paths = { stdin: join(o.output, 'native.stdin'), stdout: join(o.output, 'native.stdout'), stderr: join(o.output, 'native.stderr') };
    for (const path of Object.values(paths)) await writeFile(path, '', { flag: 'wx', mode: 0o600 });
    report.phase = 'app_server_registered'; await save();
    const child = spawn('bwrap', [...prefix, 'app-server', '--listen', 'stdio://'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    rpc = new InspectionRpc(child, paths); report.pid = child.pid ?? null; await save();
    const call = async (method: string, params: unknown) => {
      const record: Record<string, any> = { method, status: 'registered', startedAt: new Date().toISOString() }; report.requests.push(record);
      try {
        const response = await rpc!.request(method, params, async id => { record.id = id; record.status = 'sent_or_unknown'; await save(); });
        record.status = 'error' in response ? 'native_error' : 'responded'; record.finishedAt = new Date().toISOString(); await save(); return response;
      } catch (e) { record.status = 'unknown'; record.gap = safeCode(e); await save(); throw e; }
    };
    const init = await call('initialize', { clientInfo: { name: 'tongxu-native-inspection', version: '0.1.0' } });
    if (init.error || typeof init.result?.userAgent !== 'string') throw new Error('native_initialize_incomplete');
    rpc.initialized();
    const started = await call('thread/start', { cwd: '/native-workspace', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
    const result = started.result, thread = result?.thread;
    if (started.error || typeof thread?.id !== 'string' || !thread.id || thread.id.length > 128 || result.cwd !== '/native-workspace' || result.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false || result.approvalPolicy !== 'never' || !Array.isArray(thread.turns) || thread.turns.length) throw new Error('native_session_boundary_unverified');
    report.observations.session = { id: thread.id, workspace: result.cwd, sandbox: result.sandbox, approvalPolicy: result.approvalPolicy, ephemeralRequested: true, modelExecutionObserved: false };
    const read = await call('thread/read', { threadId: thread.id, includeTurns: false });
    if (read.error || read.result?.thread?.id !== thread.id || read.result.thread.cwd !== '/native-workspace') throw new Error('native_session_read_mismatch');
    const steer = await call('turn/steer', { threadId: thread.id, expectedTurnId: 'tongxu-inspection-no-active-turn', input: [{ type: 'text', text: 'No active turn exists; reject this input.' }] });
    if (!steer.error || steer.error.code !== -32600 || steer.error.message !== 'no active turn to steer') throw new Error('native_stale_steer_rejection_unverified');
    const after = await call('thread/read', { threadId: thread.id, includeTurns: false });
    if (after.error || after.result?.thread?.id !== thread.id || after.result.thread.cwd !== '/native-workspace' || after.result.thread.status?.type !== 'idle') throw new Error('native_post_steer_idle_unverified');
    report.observations.staleSteer = 'native_rejected_no_active_turn'; report.observations.postSteerStatus = 'idle'; report.capabilities.isolatedMetadata = 'observed';
  } catch (e) {
    report.gaps.push(safeCode(e));
    const failure = e as { stdout?: Buffer; stderr?: Buffer };
    for (const [name, bytes] of [['version.stdout', failure.stdout], ['version.stderr', failure.stderr]] as const) if (bytes) { try { await writeFile(join(o.output, name), bytes, { flag: 'wx', mode: 0o600 }); } catch { /* original bytes already exist */ } }
  } finally {
    if (rpc) { await rpc.close(); report.processExit = rpc.exit; report.gaps.push(...rpc.gaps); await writeFile(join(o.output, 'native-events.json'), JSON.stringify(rpc.events, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    try { if (await binaryHash(o.codex) !== report.executableHash) report.gaps.push('native_executable_changed'); }
    catch { report.gaps.push('native_executable_recheck_unavailable'); }
    for (const name of rawNames) { try { const bytes = await readFile(join(o.output, name)); report.artifacts.push({ path: name, sha256: hash(bytes), bytes: bytes.length }); await chmod(join(o.output, name), 0o600); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
    report.gaps = [...new Set(report.gaps)]; report.finishedAt = new Date().toISOString(); report.status = report.gaps.length ? 'partial' : 'complete'; await save();
  }
  return { exit: report.status === 'complete' ? 0 : 2, report };
}
