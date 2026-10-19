import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, appendFile, lstat, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hash, privateDirectory } from './snapshot.js';
import { canonical } from './comparison.js';
import type { Execution } from './sandbox.js';

const exec = promisify(execFile), imagePattern = /^sha256:[0-9a-f]{64}$/, idPattern = /^[0-9a-f]{64}$/;
const cleanPath = (p: unknown): p is string => typeof p === 'string' && isAbsolute(p) && resolve(p) === p && !/[\0\r\n,:]/.test(p);
const now = () => new Date().toISOString();
export type DockerConfig = { kind: 'docker'; client: string; endpoint: string; image: string; node: string };
export function parseDockerConfig(value: unknown): DockerConfig {
  const c = value as DockerConfig;
  if (!c || c.kind !== 'docker' || Object.keys(c).some(k => !['kind', 'client', 'endpoint', 'image', 'node'].includes(k)) || !cleanPath(c.client) || !cleanPath(c.node) || !imagePattern.test(c.image) || typeof c.endpoint !== 'string' || !c.endpoint.startsWith('unix://') || !cleanPath(c.endpoint.slice(7))) throw new Error('invalid_docker_executor');
  return { kind: 'docker', client: c.client, endpoint: c.endpoint, image: c.image, node: c.node };
}
type Binding = { run: string; stage: number; tool: string; head: string; tree: string; planHash: string };
type Options = { directory: string; work?: string; resultDirectory?: string; dependencies?: string; argv: string[]; timeoutMs: number; maxBytes: number; binding?: Binding; onSpawn?: (pid: number) => Promise<void> };
type Connection = { config: DockerConfig; clientSha256: string; engineId: string; serverVersion: string; imageEnv: string[]; uid: number; gid: number };
type RecordData = {
  schemaVersion: 1; kind: 'tongxu-docker-execution'; id: string; name: string; directory: string;
  controllerPid: number; startedAt: string; connection: Connection; binding?: Binding;
  argv: string[]; timeoutMs: number; maxBytes: number; paths: { work?: string; resultDirectory?: string; dependencies?: string };
  createArgs: string[]; phase: string; containerId?: string; clientPid?: number; clientExit?: number | null;
  before?: any; after?: any; status?: Execution['status']; exitCode?: number | null; reason?: string;
  capture?: { complete: boolean; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number };
  cleanup?: 'removed' | 'unknown'; finishedAt?: string;
};
async function atomic(root: string, name: string, value: unknown) {
  const temp = join(root, `.tmp-${randomUUID()}`); await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, join(root, name));
}
async function regular(path: string): Promise<Buffer> {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 16 * 1024 * 1024 || await realpath(path) !== path) throw new Error('invalid_docker_evidence');
  return readFile(path);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
function command(config: DockerConfig, settings: string, args: string[]): string[] { return ['--host', config.endpoint, '--config', settings, ...args]; }
function clientEnv(settings: string) { return { PATH: '/usr/bin:/bin', HOME: settings, DOCKER_CONFIG: settings }; }
async function call(config: DockerConfig, settings: string, audit: string, args: string[]) {
  const startedAt = now(), argv = command(config, settings, args); let stdout = '', stderr = '', exit = 0;
  try { const r = await exec(config.client, argv, { env: clientEnv(settings), timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }); stdout = r.stdout; stderr = r.stderr; }
  catch (e) { const r = e as { stdout?: string; stderr?: string; code?: number }; stdout = r.stdout ?? ''; stderr = r.stderr ?? ''; exit = typeof r.code === 'number' ? r.code : -1; }
  await atomic(audit, `call-${randomUUID()}.json`, { argv, startedAt, finishedAt: now(), exit, stdout, stderr });
  return { exit, stdout, stderr };
}
async function inspect(c: Connection, settings: string, audit: string, id: string): Promise<any | null> {
  const r = await call(c.config, settings, audit, ['container', 'inspect', id]);
  if (r.exit) { if (/No such (container|object)/i.test(r.stderr)) return null; throw new Error('docker_state_unavailable'); }
  const rows = JSON.parse(r.stdout); if (!Array.isArray(rows) || rows.length !== 1) throw new Error('invalid_docker_inspection'); return rows[0];
}
function envArgs(c: Connection): string[] {
  return ['-i', 'HOME=/home/tongxu', 'TMPDIR=/tmp', `PATH=${dirname(c.config.node)}:/usr/bin:/bin`, 'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_TERMINAL_PROMPT=0', 'GIT_NO_REPLACE_OBJECTS=1', 'NPM_CONFIG_USERCONFIG=/dev/null', 'TONGXU_RESULT_FILE=/result/result.json'];
}
function createArgs(c: Connection, r: RecordData): string[] {
  const args = ['create', '--pull=never', '--name', r.name, '--label', `io.tongxu.execution=${r.id}`, '--label', 'io.tongxu.executor=docker-v1', '--network=none', '--read-only', '--user', `${c.uid}:${c.gid}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin', '--ipc=private', '--cgroupns=private', '--pids-limit=128', '--memory=1g', '--memory-swap=1g', '--cpus=2', '--shm-size=16m', '--restart=no', '--no-healthcheck', '--log-driver=local', '--log-opt=max-size=4m', '--log-opt=max-file=1', '--log-opt=compress=false', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=268435456,mode=1777', '--tmpfs', `/home/tongxu:rw,size=16777216,mode=700,uid=${c.uid},gid=${c.gid}`, '--entrypoint=/usr/bin/env', '--workdir', r.paths.work ? '/work' : '/tmp'];
  for (const [source, target, readonly] of [[r.paths.work, '/work', false], [r.paths.resultDirectory, '/result', false], [r.paths.dependencies, '/work/node_modules', true]] as const) if (source) args.push('--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`);
  return [...args, c.config.image, ...envArgs(c), '/usr/bin/timeout', '--signal=TERM', '--kill-after=1s', `${r.timeoutMs / 1000}s`, ...r.argv];
}
function assertRecord(r: RecordData) {
  const c = r.connection;
  parseDockerConfig(c.config);
  // These constraints come from the executor contract, not from the record's
  // self-reported expectation. A root record cannot validate a root container.
  if (r.schemaVersion !== 1 || r.kind !== 'tongxu-docker-execution' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.id) || r.name !== `tongxu-${r.id}` || !cleanPath(r.directory) || !Number.isSafeInteger(r.controllerPid) || r.controllerPid < 1 || !Number.isSafeInteger(c.uid) || c.uid <= 0 || !Number.isSafeInteger(c.gid) || c.gid < 0 || !/^[0-9a-f]{64}$/.test(c.clientSha256) || !Number.isInteger(r.timeoutMs) || r.timeoutMs < 100 || r.timeoutMs > 300000 || !Number.isInteger(r.maxBytes) || r.maxBytes < 1 || r.maxBytes > 4 * 1024 * 1024 || !Array.isArray(r.argv) || !r.argv.length || r.argv.length > 100 || !cleanPath(r.argv[0]) || r.argv.some(a => typeof a !== 'string' || a.includes('\0')) || r.containerId !== undefined && !idPattern.test(r.containerId) || canonical(r.createArgs) !== canonical(createArgs(c, r))) throw new Error('invalid_docker_execution_record');
}
function assertContainer(r: RecordData, v: any) {
  assertRecord(r);
  const c = r.connection, h = v?.HostConfig, config = v?.Config;
  const expectedMounts = [[r.paths.work, '/work', true], [r.paths.resultDirectory, '/result', true], [r.paths.dependencies, '/work/node_modules', false]].filter(row => row[0]).map(([source, destination, rw]) => ({ source, destination, rw }));
  const mounts = (v?.Mounts ?? []).filter((m: any) => m.Type === 'bind').map((m: any) => ({ source: m.Source, destination: m.Destination, rw: m.RW }));
  const security = [...(h?.SecurityOpt ?? [])].sort();
  const expectedCommand = [...envArgs(c), '/usr/bin/timeout', '--signal=TERM', '--kill-after=1s', `${r.timeoutMs / 1000}s`, ...r.argv];
  if (!idPattern.test(v?.Id ?? '') || r.containerId && v.Id !== r.containerId || v.Name !== '/' + r.name || v.Image !== c.config.image || config?.Labels?.['io.tongxu.execution'] !== r.id || config?.Labels?.['io.tongxu.executor'] !== 'docker-v1' || config.User !== `${c.uid}:${c.gid}` || canonical(config.Entrypoint) !== canonical(['/usr/bin/env']) || canonical(config.Cmd) !== canonical(expectedCommand) || config.Tty || config.OpenStdin || config.WorkingDir !== (r.paths.work ? '/work' : '/tmp') || config.Healthcheck?.Test?.[0] !== 'NONE' || h?.Privileged !== false || h.ReadonlyRootfs !== true || h.NetworkMode !== 'none' || h.PidMode || h.UTSMode || h.IpcMode !== 'private' || h.CgroupnsMode !== 'private' || h.CapAdd?.length || canonical(h.CapDrop) !== canonical(['ALL']) || canonical(security) !== canonical(['no-new-privileges', 'seccomp=builtin'].sort()) || h.Devices?.length || h.DeviceRequests?.length || h.VolumesFrom?.length || h.PortBindings && Object.keys(h.PortBindings).length || h.PublishAllPorts || h.Memory !== 1073741824 || h.MemorySwap !== 1073741824 || h.NanoCpus !== 2000000000 || h.PidsLimit !== 128 || h.RestartPolicy?.Name !== 'no' || h.LogConfig?.Type !== 'local' || h.LogConfig.Config?.['max-size'] !== '4m' || h.LogConfig.Config?.['max-file'] !== '1' || h.LogConfig.Config?.compress !== 'false' || !h.MaskedPaths?.length || !h.ReadonlyPaths?.length || canonical(mounts.sort((a: any,b: any)=>a.destination.localeCompare(b.destination))) !== canonical(expectedMounts.sort((a: any,b: any)=>a.destination.localeCompare(b.destination))) || (v.Mounts ?? []).some((m: any) => !['bind', 'tmpfs'].includes(m.Type))) throw new Error('docker_container_contract_mismatch');
  const expectedTmpfs = { '/tmp': 'rw,exec,nosuid,nodev,size=268435456,mode=1777', '/home/tongxu': `rw,size=16777216,mode=700,uid=${c.uid},gid=${c.gid}` };
  if (canonical(h.Tmpfs) !== canonical(expectedTmpfs) || canonical(config.Env) !== canonical(c.imageEnv)) throw new Error('docker_container_environment_mismatch');
}
async function validateMounts(o: Options) {
  if (Boolean(o.work) !== Boolean(o.resultDirectory)) throw new Error('invalid_docker_mounts');
  for (const p of [o.work, o.resultDirectory, o.dependencies].filter((p): p is string => Boolean(p))) if (!cleanPath(p) || await realpath(p) !== p || !(await lstat(p)).isDirectory()) throw new Error('invalid_docker_mount_path');
  for (const p of [o.work, o.resultDirectory].filter((p): p is string => Boolean(p))) if (o.directory === p || o.directory.startsWith(p + '/')) throw new Error('docker_evidence_inside_candidate');
  if (o.work && o.resultDirectory && (o.work === o.resultDirectory || o.resultDirectory.startsWith(o.work + '/') || o.work.startsWith(o.resultDirectory + '/'))) throw new Error('overlapping_docker_mounts');
  if (o.dependencies) {
    if (!o.work || !o.dependencies.endsWith('/node_modules')) throw new Error('invalid_dependency_directory');
    try { const s = await lstat(join(o.work, 'node_modules')); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('invalid_dependency_mount_target'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}

export class DockerRuntime {
  constructor(readonly connection: Connection, readonly settings: string) {}
  static async prepare(value: unknown, directory: string): Promise<DockerRuntime> {
    const config = parseDockerConfig(value), resolvedClient = await realpath(config.client);
    const client = await lstat(resolvedClient), socket = await lstat(config.endpoint.slice(7));
    if (!client.isFile() || !(client.mode & 0o111) || !socket.isSocket() || await realpath(config.endpoint.slice(7)) !== config.endpoint.slice(7)) throw new Error('invalid_local_docker_connection');
    const uid = process.getuid?.(), gid = process.getgid?.(); if (!uid || gid === undefined) throw new Error('docker_nonroot_controller_required');
    await privateDirectory(directory, true); const settings = join(directory, 'client-config'); await mkdir(settings, { mode: 0o700 });
    const info = await call(config, settings, directory, ['info', '--format', '{{json .}}']), image = await call(config, settings, directory, ['image', 'inspect', config.image]);
    if (info.exit || image.exit) throw new Error('docker_existing_runtime_unavailable');
    const engine = JSON.parse(info.stdout), images = JSON.parse(image.stdout), metadata = images[0];
    if (engine.OSType !== 'linux' || typeof engine.ID !== 'string' || images.length !== 1 || metadata?.Id !== config.image || metadata.Os !== 'linux' || Object.keys(metadata.Config.Volumes ?? {}).length) throw new Error('unsupported_docker_runtime');
    const connection: Connection = { config, clientSha256: hash(await readFile(config.client)), engineId: engine.ID, serverVersion: engine.ServerVersion, imageEnv: metadata.Config.Env ?? [], uid, gid };
    await atomic(directory, 'connection.json', connection);
    const runtime = new DockerRuntime(connection, settings);
    const probe = `const fs=require('node:fs'),cp=require('node:child_process');const lines=new Map(fs.readFileSync('/proc/self/status','utf8').split(String.fromCharCode(10)).map(l=>{const i=l.indexOf(':');return [l.slice(0,i),l.slice(i+1).trim()]}));console.log(JSON.stringify({node:process.version,git:cp.execFileSync('/usr/bin/git',['--version'],{encoding:'utf8'}).trim(),uid:process.getuid(),seccomp:lines.get('Seccomp')==='2',noNewPrivileges:lines.get('NoNewPrivs')==='1',capabilitiesEmpty:/^0+$/.test(lines.get('CapEff'))}));`;
    const r = await runtime.run({ directory: join(directory, 'probe'), argv: [config.node, '-e', probe], timeoutMs: 10_000, maxBytes: 16_384 });
    let observed: any; try { observed = JSON.parse(r.stdout.toString()); } catch { /* fail closed */ }
    if (r.status !== 'completed' || r.exitCode !== 0 || !observed?.seccomp || !observed.noNewPrivileges || !observed.capabilitiesEmpty || observed.uid !== uid || !/^v(?:2[4-9]|[3-9][0-9])\./.test(observed.node)) throw new Error('docker_runtime_probe_failed');
    await atomic(directory, 'probe-result.json', observed); return runtime;
  }
  async run(o: Options): Promise<Execution & { record: Buffer }> {
    await validateMounts(o); await privateDirectory(o.directory, true);
    const id = randomUUID(), r: RecordData = { schemaVersion: 1, kind: 'tongxu-docker-execution', id, name: `tongxu-${id}`, directory: o.directory, controllerPid: process.pid, startedAt: now(), connection: this.connection, binding: o.binding, argv: o.argv, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, paths: { work: o.work, resultDirectory: o.resultDirectory, dependencies: o.dependencies }, createArgs: [], phase: 'create_intent' };
    r.createArgs = createArgs(this.connection, r); assertRecord(r); const save = () => atomic(o.directory, 'execution.json', r); await save();
    const stdoutFile = join(o.directory, 'stdout'), stderrFile = join(o.directory, 'stderr'); for (const p of [stdoutFile, stderrFile]) await writeFile(p, '', { flag: 'wx', mode: 0o600 });
    let status: Execution['status'] = 'completed', total = 0, captureError = false, writes = Promise.resolve(), stopPromise: Promise<void> | undefined;
    const started = Date.now();
    const stop = (reason: Execution['status']) => {
      if (status === 'completed') status = reason;
      return stopPromise ??= (async () => { if (r.containerId) await call(this.connection.config, this.settings, o.directory, ['kill', '--signal=KILL', r.containerId]); })();
    };
    try {
      if (hash(await readFile(this.connection.config.client)) !== this.connection.clientSha256) throw new Error('docker_client_changed');
      const engine = await call(this.connection.config, this.settings, o.directory, ['info', '--format', '{{json .}}']);
      if (engine.exit || JSON.parse(engine.stdout).ID !== this.connection.engineId) throw new Error('docker_engine_changed_or_unavailable');
      const created = await call(this.connection.config, this.settings, o.directory, r.createArgs);
      if (created.exit || !idPattern.test(created.stdout.trim())) throw new Error('docker_create_result_unknown');
      r.containerId = created.stdout.trim(); r.phase = 'created'; await save();
      r.before = await inspect(this.connection, this.settings, o.directory, r.containerId); assertContainer(r, r.before); await save();
      r.phase = 'start_intent'; await save();
      const child = spawn(this.connection.config.client, command(this.connection.config, this.settings, ['start', '--attach', r.containerId]), { env: clientEnv(this.settings), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      r.clientPid = child.pid; r.phase = 'running_or_unknown';
      const receive = (file: string, chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, o.maxBytes - total)); total += chunk.length;
        if (kept.length) writes = writes.then(() => appendFile(file, kept)).catch(() => { captureError = true; void stop('unknown'); });
        if (total > o.maxBytes) void stop('output_limit');
      };
      child.stdout.on('data', b => receive(stdoutFile, b)); child.stderr.on('data', b => receive(stderrFile, b));
      let timer: ReturnType<typeof setTimeout>;
      const closed = new Promise<number | null>(resolve => { child.on('error', () => { captureError = true; }); child.on('close', code => resolve(code)); });
      timer = setTimeout(() => { void stop('timeout').finally(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }); }, o.timeoutMs);
      try { await save(); if (child.pid) await o.onSpawn?.(child.pid); }
      catch { captureError = true; await stop('unknown'); child.kill('SIGKILL'); }
      r.clientExit = await closed; clearTimeout(timer); await stopPromise; await writes;
      r.after = await inspect(this.connection, this.settings, o.directory, r.containerId); assertContainer(r, r.after);
      if (r.after.State.Running) { await stop('unknown'); r.after = await inspect(this.connection, this.settings, o.directory, r.containerId); assertContainer(r, r.after); }
      if (r.after.State.Running || r.after.State.Status !== 'exited') throw new Error('docker_exit_unverified');
      r.exitCode = r.after.State.ExitCode;
      if (captureError || r.clientExit === null || r.clientExit !== 0 && r.clientExit !== r.exitCode) status = 'unknown';
      else if (status === 'completed' && r.exitCode !== 0) status = 'failed';
      const stdout = await regular(stdoutFile), stderr = await regular(stderrFile);
      r.capture = { complete: ['completed', 'failed'].includes(status), stdoutSha256: hash(stdout), stderrSha256: hash(stderr), stdoutBytes: stdout.length, stderrBytes: stderr.length };
      r.status = status; r.phase = 'exited'; await save();
      const removed = await call(this.connection.config, this.settings, o.directory, ['rm', r.containerId]);
      if (removed.exit || await inspect(this.connection, this.settings, o.directory, r.containerId)) throw new Error('docker_cleanup_unverified');
      r.cleanup = 'removed'; r.phase = 'finished'; r.finishedAt = now(); await save();
    } catch (e) {
      r.status = 'unknown'; r.reason = e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'docker_execution_error'; r.phase = 'unknown'; await writes; await save();
    }
    return { status: r.status ?? 'unknown', exitCode: r.exitCode ?? null, signal: null, stdout: await regular(stdoutFile), stderr: await regular(stderrFile), durationMs: Date.now() - started, record: await regular(join(o.directory, 'execution.json')) };
  }
}

export async function reconcileDocker(directory: string, action: 'inspect' | 'stop', trustedConfig: DockerConfig): Promise<any> {
  await privateDirectory(directory, false); const original = await regular(join(directory, 'execution.json')), r = JSON.parse(original.toString()) as RecordData;
  assertRecord(r); if (r.directory !== directory) throw new Error('docker_execution_directory_mismatch');
  // A saved report may identify a run, but cannot supply a new executable or
  // engine authority. The caller explicitly supplies the original trusted plan.
  const config = parseDockerConfig(trustedConfig);
  if (canonical(config) !== canonical(r.connection.config)) throw new Error('docker_recovery_plan_mismatch');
  if (hash(await readFile(config.client)) !== r.connection.clientSha256) throw new Error('docker_client_changed');
  if (action === 'stop' && alive(r.controllerPid)) throw new Error('docker_controller_active_or_unknown');
  // Node's existing SQLite capability gives an OS-released, per-operation
  // recovery mutex. A dead recovery process leaves no permanent lock to delete.
  const mutexPath = join(directory, 'recovery-mutex.sqlite');
  try { await regular(mutexPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const mutex = new DatabaseSync(mutexPath);
  try { mutex.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); } catch { mutex.close(); throw new Error('docker_recovery_in_progress'); }
  try {
    const recovery = join(directory, `recovery-${randomUUID()}`); await mkdir(recovery, { mode: 0o700 }); const settings = join(recovery, 'client-config'); await mkdir(settings, { mode: 0o700 });
    const c = r.connection, info = await call(config, settings, recovery, ['info', '--format', '{{json .}}']);
    if (info.exit || JSON.parse(info.stdout).ID !== c.engineId) throw new Error('docker_engine_changed_or_unavailable');
    let container = await inspect(c, settings, recovery, r.containerId ?? r.name);
    const result: any = { schemaVersion: 1, kind: 'tongxu-docker-reconciliation', originalSha256: hash(original), action, at: now(), executionId: r.id, containerId: r.containerId ?? null, sentNewTask: false, originalCaptureComplete: false, outcome: 'unknown' };
    if (r.capture) { const out = await regular(join(directory, 'stdout')), err = await regular(join(directory, 'stderr')); if (hash(out) !== r.capture.stdoutSha256 || hash(err) !== r.capture.stderrSha256) throw new Error('docker_capture_changed'); result.originalCaptureComplete = r.capture.complete; }
    if (container) {
      assertContainer(r, container); result.containerId = container.Id;
      if (container.State.Running && action === 'stop') { await call(config, settings, recovery, ['kill', '--signal=KILL', container.Id]); container = await inspect(c, settings, recovery, container.Id); if (!container) throw new Error('docker_state_unavailable'); assertContainer(r, container); }
      result.observed = container;
      const logs = await call(config, settings, recovery, ['logs', '--tail', '1000', container.Id]);
      result.recoveredLogTail = { stdoutSha256: hash(logs.stdout), stderrSha256: hash(logs.stderr), complete: false, reason: 'bounded_tail_is_not_original_complete_capture' };
      result.outcome = container.State.Running ? 'running_or_unknown' : container.State.Status === 'created' ? 'not_started' : container.State.Status === 'exited' ? 'ended' : 'unknown';
      await atomic(recovery, 'result.json', result);
      if (!container.State.Running && action === 'stop') { const removed = await call(config, settings, recovery, ['rm', container.Id]); result.cleanup = removed.exit === 0 && !(await inspect(c, settings, recovery, container.Id)) ? 'removed' : 'unknown'; }
    } else if (r.phase === 'finished' && r.cleanup === 'removed' && result.originalCaptureComplete) {
      if (!r.containerId || r.before?.Id !== r.containerId || r.after?.Id !== r.containerId || r.after?.State?.Running !== false || r.after?.State?.Status !== 'exited') throw new Error('docker_original_exit_unverified');
      assertContainer(r, r.before); assertContainer(r, r.after); result.outcome = 'original_completed_record';
    }
    else {
      result.outcome = 'container_absent_original_result_unknown';
      try {
        const reference = JSON.parse((await regular(join(directory, 'last-reconciliation.json'))).toString());
        if (!/^recovery-[0-9a-f-]{36}\/result\.json$/.test(reference.path)) throw new Error('invalid_recovery_reference');
        const bytes = await regular(join(directory, reference.path)); if (hash(bytes) !== reference.sha256) throw new Error('changed_recovery_reference');
        const prior = JSON.parse(bytes.toString());
        if (prior.originalSha256 === hash(original) && prior.cleanup === 'removed' && prior.observed?.State?.Running === false) {
          assertContainer(r, prior.observed); result.outcome = 'ended_from_original_recovery'; result.priorRecovery = reference; result.cleanup = 'removed';
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.priorRecoveryGap = 'prior_recovery_unverified'; }
    }
    await atomic(recovery, 'result.json', result);
    // Keep the last actual stop/observation proof; a repeat lookup must not
    // replace it with an empty observation of an already removed container.
    if (result.cleanup === 'removed' && result.observed) await atomic(directory, 'last-reconciliation.json', { path: `${recovery.slice(directory.length + 1)}/result.json`, sha256: hash(await regular(join(recovery, 'result.json'))) });
    return { ...result, recoveryDirectory: recovery };
  } finally { mutex.exec('ROLLBACK'); mutex.close(); }
}

export function dockerEvidenceState(bytes: Buffer, config: DockerConfig, binding: Binding, tool: any, timeoutMs: number | undefined): 'complete' | 'incomplete' | 'mismatch' {
  try {
    const r = JSON.parse(bytes.toString()) as RecordData;
    assertRecord(r);
    if (!r.directory.endsWith('/' + tool.dockerExecutionDirectory) || canonical(r.connection.config) !== canonical(config) || canonical(r.binding) !== canonical(binding) || canonical(r.argv) !== canonical(tool.argv) || r.timeoutMs !== timeoutMs || r.maxBytes !== 4 * 1024 * 1024 || r.status !== tool.status || (r.exitCode ?? null) !== tool.exitCode) return 'mismatch';
    if (r.before) assertContainer(r, r.before); if (r.after) assertContainer(r, r.after);
    if (r.capture && (r.capture.stdoutSha256 !== tool.stdout?.sha256 || r.capture.stderrSha256 !== tool.stderr?.sha256 || r.capture.stdoutBytes !== tool.stdout?.bytes || r.capture.stderrBytes !== tool.stderr?.bytes || r.capture.stdoutBytes + r.capture.stderrBytes > r.maxBytes)) return 'mismatch';
    if (!r.containerId || !r.before || !r.after || r.phase !== 'finished' || r.cleanup !== 'removed' || r.capture?.complete !== true) return 'incomplete';
    if (r.before.Id !== r.containerId || r.after.Id !== r.containerId || r.after.State.Running !== false || r.after.State.Status !== 'exited' || r.after.State.ExitCode !== tool.exitCode || r.clientExit !== 0 && r.clientExit !== tool.exitCode) return 'mismatch';
    return 'complete';
  } catch { return 'mismatch'; }
}
export function dockerEvidenceMatches(bytes: Buffer, config: DockerConfig, binding: Binding, tool: any, timeoutMs: number): boolean {
  return dockerEvidenceState(bytes, config, binding, tool, timeoutMs) === 'complete';
}
