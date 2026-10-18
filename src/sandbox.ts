import { spawn } from 'node:child_process';
import { realpath, lstat, readdir, readlink, readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export type Execution = { status: 'completed' | 'failed' | 'timeout' | 'output_limit' | 'unavailable'; exitCode: number | null; signal: string | null; stdout: Buffer; stderr: Buffer; durationMs: number };
export type SandboxOptions = { work: string; resultDirectory: string; dependencies?: string; timeoutMs: number; maxBytes: number; argv: string[]; onSpawn?: (pid: number) => Promise<void> };
export async function sandboxArguments(o: SandboxOptions): Promise<string[]> {
  const runtime = dirname(dirname(await realpath(process.execPath)));
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib'];
  try { await lstat('/lib64'); args.push('--ro-bind', '/lib64', '/lib64'); } catch { /* distribution without /lib64 */ }
  if (runtime !== '/usr') args.push('--ro-bind', runtime, runtime);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/tongxu', '--bind', o.work, '/work', '--bind', o.resultDirectory, '/result');
  if (o.dependencies) args.push('--ro-bind', o.dependencies, '/work/node_modules');
  args.push('--chdir', '/work', '--clearenv', '--setenv', 'HOME', '/home/tongxu', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', `${join(runtime, 'bin')}:/usr/bin:/bin`, '--setenv', 'GIT_CONFIG_NOSYSTEM', '1', '--setenv', 'GIT_CONFIG_GLOBAL', '/dev/null', '--setenv', 'GIT_TERMINAL_PROMPT', '0', '--setenv', 'NPM_CONFIG_USERCONFIG', '/dev/null', '--setenv', 'TONGXU_RESULT_FILE', '/result/result.json', ...o.argv);
  return args;
}
export async function runSandbox(o: SandboxOptions): Promise<Execution> {
  if (process.platform !== 'linux') return { status: 'unavailable', exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), durationMs: 0 };
  const args = await sandboxArguments(o);
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn('bwrap', args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let status: Execution['status'] = 'completed';
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } };
    const recorded = Promise.resolve(child.pid ? o.onSpawn?.(child.pid) : undefined).catch(() => { status = 'unavailable'; stop(); });
    const timer = setTimeout(() => { status = 'timeout'; stop(); }, o.timeoutMs);
    const receive = (chunks: Buffer[], chunk: Buffer) => {
      const left = Math.max(0, o.maxBytes - bytes);
      if (left) chunks.push(chunk.subarray(0, left));
      bytes += chunk.length;
      if (bytes > o.maxBytes) { status = 'output_limit'; stop(); }
    };
    child.stdout.on('data', chunk => receive(stdout, chunk));
    child.stderr.on('data', chunk => receive(stderr, chunk));
    const finish = (exitCode: number | null, signal: string | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (status === 'completed' && exitCode !== 0) status = 'failed';
      void recorded.then(() => resolve({ status, exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), durationMs: Date.now() - started }));
    };
    child.on('error', () => { status = 'unavailable'; finish(null, null); });
    child.on('close', finish);
  });
}

export async function validateDependencies(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  if (!isAbsolute(path) || !path.endsWith('/node_modules') || await realpath(path) !== path) throw new Error('invalid_dependency_directory');
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_dependency_directory');
  // The only extra host directory is an explicit read-only Node dependency tree.
  // Candidate symlinks outside it resolve within the sandbox, never into host HOME.
  return path;
}

export async function dependencyDigest(root: string | undefined): Promise<string | null> {
  if (!root) return null;
  let bytes = 0, files = 0; const digest = createHash('sha256');
  async function walk(path: string, relative: string): Promise<void> {
    const stat = await lstat(path); digest.update(JSON.stringify([relative, stat.mode & 0o111]));
    if (stat.isSymbolicLink()) { digest.update('link:' + await readlink(path)); return; }
    if (stat.isDirectory()) { for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`); return; }
    if (!stat.isFile() || ++files > 20_000 || (bytes += stat.size) > 512 * 1024 * 1024) throw new Error('dependency_snapshot_limit');
    digest.update(createHash('sha256').update(await readFile(path)).digest());
  }
  await walk(root, 'node_modules'); return digest.digest('hex');
}
