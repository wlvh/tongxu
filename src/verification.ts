import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat, readlink, link, unlink, rename, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { now, repoPattern, shaPattern } from './contract.js';
import type { Candidate, Manifest } from './contract.js';
import { hash, privateDirectory } from './snapshot.js';
import { canonical, compare, samples } from './comparison.js';
import type { SampleSet, Comparison } from './comparison.js';
import { runSandbox, validateDependencies, dependencyDigest } from './sandbox.js';

const exec = promisify(execFile);
type Tool = { id: string; argv: string[]; timeoutMs: number; expectedSampleIds?: string[] };
type Plan = { schemaVersion: 1; tools: Tool[]; dependencyDirectory?: string; judgmentRefs?: string[] };
type Blob = { path: string; sha256: string; bytes: number };
type Input = { candidate: Candidate; manifestHash: string; sourceGaps: string[]; manifest: Blob };
type ToolResult = { id: string; argv: string[]; status: string; startedAt: string; finishedAt?: string; pid?: number; processGroup?: number; exitCode?: number | null; signal?: string | null; durationMs?: number; stdout?: Blob; stderr?: Blob; inputUnchanged?: boolean; dependencyHash?: string | null; dependenciesUnchanged?: boolean; sampleSet?: SampleSet; result?: Blob; gaps: string[] };
type Stage = { index: number; inputHead: string; parent: string; tree: string | null; head: string | null; status: string; tools: ToolResult[]; comparisons: { tool: string; results: Comparison[] }[]; gaps: string[]; mergeOutput?: Blob; preInputHash?: string };
type Report = { schemaVersion: 1; kind: 'tongxu-verification'; id: string; startedAt: string; finishedAt?: string; status: string; repository: string; targetRef: string; inputs: Input[]; plan: Blob; planHash: string; judgmentRefs: string[]; toolVersions: Record<string, string>; stages: Stage[]; gaps: string[]; limitations: string[]; executionComplete: boolean; comparisonComplete: boolean | null; businessCorrectness: 'unverified'; observedSampleFailures: number; failureOutput?: { stdout: Blob; stderr: Blob }; dependencyHash: string | null };
const safeCode = (e: unknown) => e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'local_or_tool_error';
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
async function git(directory: string, ...args: string[]): Promise<Buffer> {
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=always', '-c', 'user.name=Tongxu isolated verification', '-c', 'user.email=tongxu@example.invalid', '-C', directory, ...args], { env: gitEnv(), encoding: 'buffer', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
}
class Store {
  constructor(readonly directory: string) {}
  async atomic(name: string, bytes: string): Promise<void> {
    const temp = join(this.directory, `.tmp-${randomUUID()}`);
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temp, join(this.directory, name));
  }
  async blob(bytes: string | Buffer): Promise<Blob> {
    await privateDirectory(join(this.directory, 'raw'), false);
    const data = Buffer.from(bytes), digest = hash(data), path = `raw/${digest}.bin`;
    const temp = join(this.directory, `.tmp-${randomUUID()}`);
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    try { await link(temp, join(this.directory, path)); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const st = await lstat(join(this.directory, path));
      if (!st.isFile() || st.isSymbolicLink() || hash(await readFile(join(this.directory, path))) !== digest) throw new Error('evidence_integrity_failed');
    } finally { await unlink(temp); }
    return { path, sha256: digest, bytes: data.length };
  }
}
export function parsePlan(value: unknown): Plan {
  const p = value as Plan;
  if (!p || p.schemaVersion !== 1 || !Array.isArray(p.tools) || !p.tools.length || p.tools.length > 16 || new Set(p.tools.map(t => t.id)).size !== p.tools.length) throw new Error('invalid_test_plan');
  for (const t of p.tools) {
    if (typeof t.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.id) || !Array.isArray(t.argv) || !t.argv.length || t.argv.length > 100 || t.argv.some(a => typeof a !== 'string' || a.includes('\0')) || !isAbsolute(t.argv[0]!) || /\/(?:sh|bash|zsh|dash|fish|cmd|powershell)$/.test(t.argv[0]!) || !Number.isInteger(t.timeoutMs) || t.timeoutMs < 100 || t.timeoutMs > 300_000) throw new Error('invalid_registered_tool');
    if (t.expectedSampleIds && (!Array.isArray(t.expectedSampleIds) || !t.expectedSampleIds.length || t.expectedSampleIds.some(x => typeof x !== 'string' || !x) || new Set(t.expectedSampleIds).size !== t.expectedSampleIds.length)) throw new Error('invalid_expected_samples');
  }
  if (p.judgmentRefs && (!Array.isArray(p.judgmentRefs) || p.judgmentRefs.some(r => typeof r !== 'string'))) throw new Error('invalid_judgment_refs');
  return p;
}
export type VerifyOptions = { snapshots: string[]; objects: string; plan: string; output: string };
export function parseVerifyArgs(args: string[]): VerifyOptions {
  const values = new Map<string, string>(); const additional: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--snapshot', '--objects', '--plan', '--output', '--with'].includes(key) || !value || !isAbsolute(value) || resolve(value) !== value) throw new Error('invalid_verify_option');
    if (key === '--with') additional.push(value);
    else { if (values.has(key)) throw new Error('duplicate_verify_option'); values.set(key, value); }
  }
  if (['--snapshot', '--objects', '--plan', '--output'].some(k => !values.has(k)) || additional.length > 7) throw new Error('missing_verify_scope');
  return { snapshots: [values.get('--snapshot')!, ...additional], objects: values.get('--objects')!, plan: values.get('--plan')!, output: values.get('--output')! };
}
async function loadBundle(path: string): Promise<{ candidate: Candidate; bytes: Buffer; sourceGaps: string[] }> {
  await privateDirectory(path, false);
  try { await lstat(join(path, 'lock.json')); throw new Error('source_writer_active_or_unknown'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await privateDirectory(join(path, 'raw'), false); await privateDirectory(join(path, 'git'), false);
  const st = await lstat(join(path, 'manifest.json'));
  if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024) throw new Error('invalid_source_manifest');
  const bytes = await readFile(join(path, 'manifest.json'));
  const m = JSON.parse(bytes.toString()) as Manifest;
  const c = m.candidate;
  if (m.schemaVersion !== 1 || !c || !repoPattern.test(c.repository) || !shaPattern.test(c.H) || !shaPattern.test(c.B) || !Number.isSafeInteger(c.pr) || c.pr < 1 || c.repository !== m.repository || c.pr !== m.pr || typeof c.targetRef !== 'string' || !c.targetRef || /[\x00-\x20\x7f]/.test(c.targetRef) || !Array.isArray(m.artifacts) || !Array.isArray(m.rounds)) throw new Error('invalid_source_candidate');
  for (const a of m.artifacts) {
    if (!/^(raw\/[0-9a-f]{64}\.json|git\/[0-9a-f]{64}\.(patch|json))$/.test(a.path)) throw new Error('invalid_source_artifact');
    const file = join(path, a.path), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== a.bytes || hash(await readFile(file)) !== a.sha256) throw new Error('source_integrity_failed');
  }
  if (hash(await readFile(join(path, 'manifest.json'))) !== hash(bytes)) throw new Error('source_changed_during_read');
  return { candidate: c, bytes, sourceGaps: m.rounds.at(-1)?.gaps ?? ['source_observation_unavailable'] };
}

// No Git process touches a candidate-controlled checkout after tests. Inspect only safe local bytes.
async function safeFile(root: string, path: string): Promise<string> {
  const parts = path.split('/');
  if (!path || isAbsolute(path) || parts.some(p => p === '..' || p === '.' || !p)) throw new Error('unsafe_tracked_path');
  let cursor = root;
  for (const [i, p] of parts.entries()) {
    cursor = join(cursor, p); const st = await lstat(cursor);
    if (i < parts.length - 1) { if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('input_parent_replaced'); }
    else {
      if (st.isSymbolicLink()) return `link:${await readlink(cursor)}`;
      if (!st.isFile() || st.size > 64 * 1024 * 1024) throw new Error('unsupported_or_large_input');
      return `${st.mode & 0o111}:${hash(await readFile(cursor))}`;
    }
  }
  throw new Error('unsafe_tracked_path');
}
async function fingerprint(directory: string, paths: string[]): Promise<string> {
  const items = [];
  for (const p of paths) items.push([p, await safeFile(directory, p)]);
  return hash(canonical(items));
}
async function checkout(cache: string, destination: string, head: string): Promise<string[]> {
  await mkdir(destination, { mode: 0o700 });
  await git(destination, 'init', '--template=');
  await git(destination, 'fetch', '--no-tags', '--no-write-fetch-head', cache, head);
  await git(destination, 'checkout', '--detach', head);
  if ((await git(destination, 'rev-parse', 'HEAD')).toString().trim() !== head) throw new Error('checkout_identity_mismatch');
  return [...(await git(destination, 'ls-files', '-z')).toString().split('\0').filter(Boolean), '.git/HEAD', '.git/index', '.git/config'];
}

export async function verify(o: VerifyOptions): Promise<{ exit: number; report: Report }> {
  const planBytes = await readFile(o.plan); const plan = parsePlan(JSON.parse(planBytes.toString()));
  const dependencies = await validateDependencies(plan.dependencyDirectory);
  const bundles = [];
  for (const path of o.snapshots) bundles.push(await loadBundle(path));
  const first = bundles[0]!;
  if (bundles.some(b => b.candidate.repository !== first.candidate.repository || b.candidate.targetRef !== first.candidate.targetRef) || new Set(bundles.map(b => b.candidate.H)).size !== bundles.length) throw new Error('incompatible_candidate_group');
  if (!isAbsolute(o.objects) || await realpath(o.objects) !== o.objects) throw new Error('invalid_object_source');
  await privateDirectory(o.output, true); await mkdir(join(o.output, 'raw'), { mode: 0o700 });
  const store = new Store(o.output);
  const report: Report = { schemaVersion: 1, kind: 'tongxu-verification', id: randomUUID(), startedAt: now(), status: 'running', repository: first.candidate.repository, targetRef: first.candidate.targetRef, inputs: [], plan: await store.blob(planBytes), planHash: hash(planBytes), judgmentRefs: plan.judgmentRefs ?? [], toolVersions: { node: process.version, platform: process.platform, architecture: process.arch }, stages: [], gaps: [], executionComplete: false, comparisonComplete: null, businessCorrectness: 'unverified', observedSampleFailures: 0, dependencyHash: null, limitations: ['fixed_inputs_do_not_prove_current_remote_candidate', 'execution_success_is_not_business_correctness_or_merge_permission', 'no_independent_sample_count_from_repeated_runs', 'system_runtime_not_fully_hashed'] };
  for (const b of bundles) report.inputs.push({ candidate: b.candidate, manifestHash: hash(b.bytes), sourceGaps: b.sourceGaps, manifest: await store.blob(b.bytes) });
  const save = () => store.atomic('verification.json', JSON.stringify(report, null, 2) + '\n');
  await save();
  try {
    for (const name of ['verification', 'sandbox', 'comparison', 'snapshot', 'contract', 'cli']) report.toolVersions[`runner_${name}_sha256`] = hash(await readFile(new URL(`./${name}.js`, import.meta.url)));
    const runtime = dirname(dirname(await realpath(process.execPath)));
    try { report.toolVersions.npm = JSON.parse(await readFile(join(runtime, 'lib/node_modules/npm/package.json'), 'utf8')).version; } catch { /* not every Node installation includes npm */ }
    report.dependencyHash = await dependencyDigest(dependencies);
    if (dependencies) report.limitations.push('host_dependency_observation_is_not_atomic');
    report.toolVersions.git = (await exec('git', ['--version'], { env: gitEnv() })).stdout.trim();
    try { report.toolVersions.bwrap = (await exec('bwrap', ['--version'], { env: { PATH: '/usr/bin:/bin' } })).stdout.trim(); } catch { throw new Error('isolation_unavailable'); }
    const cache = join(o.output, 'objects'); await mkdir(cache, { mode: 0o700 }); await git(cache, 'init', '--bare', '--template=');
    for (const b of bundles) await git(cache, 'fetch', '--no-tags', '--no-write-fetch-head', o.objects, b.candidate.B, b.candidate.H);
    let previous = first.candidate.B;
    for (let i = 0; i <= bundles.length; i++) {
      const input = i === 0 ? first.candidate.B : bundles[i - 1]!.candidate.H;
      const stage: Stage = { index: i, inputHead: input, parent: previous, tree: null, head: null, status: 'preparing', tools: [], comparisons: [], gaps: [] }; report.stages.push(stage); await save();
      if (i > 0) {
        try { await git(cache, 'merge-base', '--is-ancestor', bundles[i - 1]!.candidate.B, previous); } catch { stage.gaps.push('input_base_not_in_prefix'); stage.status = 'blocked'; break; }
        try {
          const merged = await git(cache, 'merge-tree', '--write-tree', previous, input);
          stage.mergeOutput = await store.blob(merged); stage.tree = merged.toString().split('\n')[0]!.trim();
          if (!shaPattern.test(stage.tree)) throw new Error('invalid_merge_tree');
          stage.head = (await git(cache, 'commit-tree', stage.tree, '-p', previous, '-p', input, '-m', 'tongxu isolated candidate')).toString().trim();
        } catch (e) {
          const output = (e as { stdout?: Buffer }).stdout;
          if (output) stage.mergeOutput = await store.blob(output);
          stage.gaps.push('merge_conflict_or_tree_unavailable'); stage.status = 'blocked'; break;
        }
      } else { stage.head = input; stage.tree = (await git(cache, 'rev-parse', `${input}^{tree}`)).toString().trim(); }
      if (!stage.head || !shaPattern.test(stage.head) || !stage.tree || !shaPattern.test(stage.tree)) throw new Error('invalid_fixed_stage');
      const work = join(o.output, `stage-${i}`); const paths = await checkout(cache, work, stage.head);
      if ((await git(work, 'rev-parse', 'HEAD^{tree}')).toString().trim() !== stage.tree) throw new Error('tested_tree_mismatch');
      const original = await fingerprint(work, paths); stage.preInputHash = original;
      stage.status = 'running'; await save();
      for (const tool of plan.tools) {
        const result: ToolResult = { id: tool.id, argv: tool.argv, status: 'running', startedAt: now(), gaps: [] }; stage.tools.push(result); await save();
        let current = '';
        try { current = await fingerprint(work, paths); } catch { /* a replaced parent is also changed input */ }
        result.dependencyHash = await dependencyDigest(dependencies);
        if (current !== original || result.dependencyHash !== report.dependencyHash) { result.status = 'blocked'; result.gaps.push('input_changed_before_tool'); stage.gaps.push('input_changed'); break; }
        const resultDirectory = join(o.output, `result-${i}-${tool.id}-${randomUUID()}`); await mkdir(resultDirectory, { mode: 0o700 });
        const execution = await runSandbox({ work, resultDirectory, dependencies, argv: tool.argv, timeoutMs: tool.timeoutMs, maxBytes: 4 * 1024 * 1024, onSpawn: async pid => { result.pid = pid; result.processGroup = pid; await save(); } });
        Object.assign(result, { status: execution.status, exitCode: execution.exitCode, signal: execution.signal, durationMs: execution.durationMs, stdout: await store.blob(execution.stdout), stderr: await store.blob(execution.stderr), finishedAt: now() });
        try { result.inputUnchanged = await fingerprint(work, paths) === original; } catch { result.inputUnchanged = false; }
        try { result.dependenciesUnchanged = await dependencyDigest(dependencies) === report.dependencyHash; } catch { result.dependenciesUnchanged = false; }
        if (!result.dependenciesUnchanged) { result.gaps.push('dependencies_changed'); stage.gaps.push('dependencies_changed'); }
        if (!result.inputUnchanged) { result.gaps.push('input_changed'); stage.gaps.push('input_changed'); }
        if (execution.status !== 'completed' || execution.exitCode !== 0) result.gaps.push('tool_execution_incomplete');
        if (tool.expectedSampleIds) {
          let data: unknown;
          try {
            const path = join(resultDirectory, 'result.json'); const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('invalid_result_file');
            const bytes = await readFile(path); result.result = await store.blob(bytes); data = JSON.parse(bytes.toString());
          } catch { result.gaps.push('missing_or_invalid_fresh_result'); }
          result.sampleSet = samples(data, tool.expectedSampleIds, result.gaps.length === 0);
          result.gaps.push(...result.sampleSet.gaps);
        }
        await save();
        if (result.gaps.length) break;
      }
      if (stage.tools.length !== plan.tools.length) stage.gaps.push('remaining_tools_not_run');
      if (stage.tools.some(t => t.gaps.length)) stage.gaps.push('tool_evidence_incomplete');
      stage.status = stage.gaps.length ? 'partial' : 'complete';
      for (const tool of plan.tools.filter(t => t.expectedSampleIds)) stage.comparisons.push({ tool: tool.id, results: compare(report.stages[i - 1]?.tools.find(t => t.id === tool.id)?.sampleSet, stage.tools.find(t => t.id === tool.id)?.sampleSet, tool.expectedSampleIds!) });
      previous = stage.head;
      await save();
    }
  } catch (e) {
    report.gaps.push(safeCode(e));
    const failure = e as { stdout?: Buffer; stderr?: Buffer };
    if (failure.stdout || failure.stderr) report.failureOutput = { stdout: await store.blob(failure.stdout ?? Buffer.alloc(0)), stderr: await store.blob(failure.stderr ?? Buffer.alloc(0)) };
  }
  if (report.stages.length !== bundles.length + 1 || report.stages.some(s => s.status !== 'complete')) report.gaps.push('requested_stages_incomplete');
  report.executionComplete = report.stages.length === bundles.length + 1 && report.stages.every(s => s.tools.length === plan.tools.length && s.tools.every(t => t.status === 'completed' && t.inputUnchanged && t.dependenciesUnchanged));
  const structuredTools = plan.tools.filter(t => t.expectedSampleIds);
  report.comparisonComplete = structuredTools.length ? report.stages.length === bundles.length + 1 && report.stages.every(s => structuredTools.every(t => s.tools.find(r => r.id === t.id)?.sampleSet?.complete)) : null;
  report.observedSampleFailures = report.stages.flatMap(s => s.tools.flatMap(t => t.sampleSet?.samples ?? [])).filter(s => s.status === 'fail').length;
  report.status = report.gaps.length ? 'partial' : 'complete'; report.finishedAt = now(); await save();
  const summary = ['# tongxu isolated verification', '', `Repository: ${report.repository}`, `Target: ${JSON.stringify(report.targetRef).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/`/g, '\\u0060')}`, `Run: ${report.id}`, `Status: ${report.status}`, `Execution complete: ${report.executionComplete}; comparison complete: ${report.comparisonComplete}; observed sample failures: ${report.observedSampleFailures}; business correctness: ${report.businessCorrectness}`, 'Execution and comparison evidence only; no approval, business PASS or merge permission.', '', ...report.stages.map(s => `- Stage ${s.index}: H=${s.inputHead}; T=${s.tree ?? 'unknown'}; tested HEAD=${s.head ?? 'unknown'}; ${s.status}; tools=${s.tools.length}; gaps=${s.gaps.join(',') || 'none'}`), ...report.gaps.map(g => `- Gap: ${g}`), '', ...report.limitations.map(l => `- Limit: ${l}`), '', 'Raw inputs/outputs, argv and detailed verification.json are private. Review this summary before sharing.', ''].join('\n');
  await store.atomic('summary.md', summary);
  return { exit: report.status === 'complete' && !report.observedSampleFailures ? 0 : 2, report };
}
