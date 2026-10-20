import { mkdir, writeFile, chmod, readdir, realpath, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, privateDirectory } from './snapshot.js';
import { save } from './live-process.js';
import { git, mutateGit, regular, exists, tree, treeHash, localCandidate, processState, projectTestNamespace, type Grant, type Tree } from './repair-workspace.js';
import { parsePlan, fingerprint } from './verification.js';
import { validateDependencies, dependencyDigest } from './sandbox.js';
import { DockerRuntime, reconcileDocker } from './docker-sandbox.js';
import { samples } from './comparison.js';
import type { Candidate } from './live-codex.js';
import type { RepairConfig, RepairPlan } from './repair.js';

const digest = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/;
const relative = (p: unknown): p is string => typeof p === 'string' && p.length <= 512 && /^[A-Za-z0-9_.\/-]+$/.test(p) && p.split('/').every(x => x && x !== '.' && x !== '..' && !['.git', 'node_modules'].includes(x));
const paths = (p: unknown, max: number): p is string[] => Array.isArray(p) && p.length > 0 && p.length <= max && p.every(relative) && new Set(p).size === p.length;
export type ProjectContract = {
  sourceCandidate: Candidate; materialPaths: string[]; protectedPaths: string[]; contract: string;
  testPlan: string; testPlanSha256: string; dependencyHash: string | null; generatedDirectories: string[];
};
export type ProjectRequest = {
  schemaVersion: 1; kind: 'tongxu-project-repair-request'; executionRoot: string; objects: string; candidate: Candidate;
  allowedPaths: string[]; materialPaths: string[]; protectedPaths: string[]; contract: string;
  testPlan: string; testPlanSha256: string; findings: Array<{ id: string; description: string }>;
  authorization: { source: string; allowRepair: boolean; allowReconcileEnded: boolean; maxRepairRounds: number };
  demonstrationFixture: boolean; generatedDirectories: string[];
};
export function validateProjectContract(p: ProjectContract, grant: Grant) {
  const c = p?.sourceCandidate;
  if (!c || !/^[\w.-]+\/[\w.-]+$/.test(c.repository) || !commit.test(c.H) || !commit.test(c.B) || typeof c.target !== 'string' || !c.target || /[\x00-\x20]/.test(c.target) || !(c.kind === 'local-git' ? c.repository.startsWith('local/') && c.pr === null : (c.kind == null || c.kind === 'github-pr') && Number.isSafeInteger(c.pr) && c.pr! > 0)) throw new Error('invalid_project_source_candidate');
  if (!paths(p.materialPaths, 64) || !paths(p.protectedPaths, 128) || !paths(grant.allowedPaths, 32) || grant.profile !== 'project-v1' || JSON.stringify(grant.materialPaths) !== JSON.stringify(p.materialPaths) || grant.allowedPaths.some(x => !p.materialPaths.includes(x) || p.protectedPaths.includes(x)) || typeof p.contract !== 'string' || !p.contract.trim() || p.contract.length > 16000 || !digest.test(p.testPlanSha256) || p.dependencyHash !== null && !digest.test(p.dependencyHash)) throw new Error('invalid_project_repair_scope');
  if (!Array.isArray(p.generatedDirectories) || p.generatedDirectories.length > 16 || p.generatedDirectories.some(x => !relative(x) || p.generatedDirectories.some(y => y !== x && (x.startsWith(y + '/') || y.startsWith(x + '/')))) || new Set(p.generatedDirectories).size !== p.generatedDirectories.length) throw new Error('invalid_project_output_directories');
}
export async function projectTestPlan(p: ProjectContract) {
  const bytes = await regular(p.testPlan);
  if (hash(bytes) !== p.testPlanSha256) throw new Error('project_test_plan_changed');
  const plan = parsePlan(JSON.parse(bytes.toString()));
  if (plan.schemaVersion !== 2 || !plan.executor) throw new Error('project_test_requires_registered_docker');
  for (const tool of plan.tools) {
    const writable = (tool as any).writableOutputs ?? [];
    if (!Array.isArray(writable) || new Set(writable).size !== writable.length || writable.some(x => !p.generatedDirectories.includes(x))) throw new Error('unregistered_project_output_write');
  }
  if ((plan.tools.at(-1) as any).writableOutputs?.length) throw new Error('project_verifier_requires_frozen_inputs');
  const dependencies = await validateDependencies(plan.dependencyDirectory);
  if (await dependencyDigest(dependencies) !== p.dependencyHash) throw new Error('project_dependencies_changed');
  return { plan, bytes, dependencies };
}
export function projectMaterial(source: Tree, p: ProjectContract): Tree {
  const selected: Tree = Object.create(null);
  for (const path of p.materialPaths) { if (!source[path]) throw new Error('project_material_missing'); selected[path] = source[path]!; }
  if (Buffer.byteLength(JSON.stringify(selected)) > 768 * 1024) throw new Error('project_model_material_limit');
  return selected;
}
async function generatedEvidence(mounts: Array<{ path: string; source: string }>) {
  const files: Array<{ path: string; sha256: string; bytes: number }> = []; let total = 0, valid = true;
  const walk = async (source: string, prefix: string) => {
    for (const name of (await readdir(source)).sort()) {
      const path = join(source, name), logical = prefix + '/' + name, stat = await lstat(path);
      if (stat.isSymbolicLink() || ['node_modules', '.git'].includes(name)) { valid = false; continue; }
      if (stat.isDirectory()) await walk(path, logical);
      else if (!stat.isFile() || stat.nlink !== 1 || files.length >= 20000 || (total += stat.size) > 64 * 1024 * 1024) throw new Error('project_generated_artifact_limit');
      else files.push({ path: logical, sha256: hash(await readFile(path)), bytes: stat.size });
    }
  };
  for (const m of mounts) await walk(m.source, m.path);
  return { valid, files, sha256: hash(JSON.stringify(files)) };
}
/** Arbitrary test stdout and sample prose can contain unselected source bytes.
 * Preserve them privately, but expose only controller-derived facts to models. */
export function projectModelTestResult(result: any) {
  return {
    kind: result.kind, passed: result.passed, executionHealthy: result.executionHealthy,
    candidateTreeSha256: result.candidateTreeSha256, H: result.H, T: result.T,
    testPlanSha256: result.testPlanSha256, businessCorrectness: result.businessCorrectness,
    tools: result.tools.map((t: any) => ({ id: t.id, status: t.status, successfulExit: t.exitCode === 0,
      inputUnchanged: t.inputUnchanged, dependenciesUnchanged: t.dependenciesUnchanged,
      stdoutSha256: t.stdoutSha256, stderrSha256: t.stderrSha256, dockerRecordSha256: t.dockerRecordSha256,
      ...(t.sampleSet ? { coverage: { complete: t.sampleSet.complete, samples: t.registeredSampleIds.map((id: string) => ({ id, status: t.sampleSet.samples.find((s: any) => s.id === id)?.status ?? 'missing' })) } } : {}) })),
    originalLogs: 'retained_in_private_test_evidence_not_model_input'
  };
}
export async function prepareProjectRepair(configPath: string, requestPath: string, root: string) {
  const configBytes = await regular(configPath), config = JSON.parse(configBytes.toString()) as RepairConfig;
  const requestBytes = await regular(requestPath), r = JSON.parse(requestBytes.toString()) as ProjectRequest;
  if (r.executionRoot !== root || resolve(root) !== root) throw new Error('project_execution_root_changed');
  if (await exists(root)) {
    await privateDirectory(root, false);
    if (hash(await regular(join(root, 'config.json'))) !== hash(configBytes) || hash(await regular(join(root, 'request.json'))) !== hash(requestBytes)) throw new Error('project_preparation_input_changed');
    const plan = JSON.parse((await regular(join(root, 'plan.json'))).toString()) as RepairPlan;
    if (plan.test !== 'registered-project-tests-v1' || plan.workspace !== join(root, 'workspace') || plan.grant !== join(root, 'grant.json')) throw new Error('project_preparation_incomplete');
    return { plan: join(root, 'plan.json'), operation: join(root, 'operation'), candidate: plan.candidate, sourceCandidate: plan.project!.sourceCandidate };
  }
  if (r.schemaVersion !== 1 || r.kind !== 'tongxu-project-repair-request' || !r.candidate || typeof r.objects !== 'string' || resolve(r.objects) !== r.objects || await realpath(r.objects) !== r.objects || typeof r.demonstrationFixture !== 'boolean' || !Array.isArray(r.findings) || r.findings.length > 10 || r.findings.some(x => typeof x.id !== 'string' || !x.id || typeof x.description !== 'string' || !x.description.trim())) throw new Error('invalid_project_repair_request');
  const a = r.authorization;
  if (!a || typeof a.source !== 'string' || !a.source.trim() || typeof a.allowRepair !== 'boolean' || typeof a.allowReconcileEnded !== 'boolean' || !Number.isInteger(a.maxRepairRounds) || a.maxRepairRounds < 1 || a.maxRepairRounds > 3) throw new Error('project_authorization_required');
  const testBytes = await regular(r.testPlan); if (hash(testBytes) !== r.testPlanSha256) throw new Error('project_test_plan_changed');
  const test = parsePlan(JSON.parse(testBytes.toString()));
  if (test.schemaVersion !== 2 || !test.executor) throw new Error('project_test_requires_registered_docker');
  const dependencyHash = await dependencyDigest(await validateDependencies(test.dependencyDirectory));
  const workspace = join(root, 'workspace');
  const grant: Grant = { id: randomUUID(), source: a.source, workspace, H: r.candidate.H, treeSha256: '', allowedPaths: r.allowedPaths, allowRepair: a.allowRepair, allowReconcileEnded: a.allowReconcileEnded, maxRepairRounds: a.maxRepairRounds, profile: 'project-v1', materialPaths: r.materialPaths };
  const project: ProjectContract = { sourceCandidate: r.candidate, materialPaths: r.materialPaths, protectedPaths: r.protectedPaths, contract: r.contract, testPlan: join(root, 'test-plan.json'), testPlanSha256: hash(testBytes), dependencyHash, generatedDirectories: r.generatedDirectories };
  validateProjectContract(project, grant);
  for (const h of [r.candidate.H, r.candidate.B]) if (await git(r.objects, ['rev-parse', h + '^{commit}']) !== h) throw new Error('project_source_object_changed');
  await privateDirectory(root, true); await mkdir(workspace, { mode: 0o700 });
  await writeFile(join(root, 'config.json'), configBytes, { flag: 'wx', mode: 0o600 }); await writeFile(join(root, 'request.json'), requestBytes, { flag: 'wx', mode: 0o600 }); await writeFile(project.testPlan, testBytes, { flag: 'wx', mode: 0o600 });
  // Fetch only fixed objects from the explicit local repository. No credential,
  // hook, config, uncommitted file or remote publishing setup is copied.
  await git(workspace, ['init', '--template=', '--initial-branch=project-base']);
  await git(workspace, ['fetch', '--no-tags', '--no-recurse-submodules', r.objects, r.candidate.H]);
  await git(workspace, ['checkout', '-B', 'project-base', r.candidate.H]); await git(workspace, ['switch', '-c', 'repair-project']);
  if ((await git(workspace, ['ls-files', '--stage'])).split('\n').some(line => line.startsWith('160000 '))) throw new Error('project_submodule_material_unavailable');
  const initial = await tree(workspace, true); projectMaterial(initial, project);
  if (Object.keys(initial).some(path => project.generatedDirectories.some(d => path === d || path.startsWith(d + '/')))) throw new Error('project_output_overlaps_source');
  await projectTestPlan(project);
  for (const path of [...r.allowedPaths, ...r.protectedPaths]) if (!initial[path]) throw new Error('project_scope_path_missing');
  grant.treeSha256 = treeHash(initial); save(join(root, 'grant.json'), grant);
  save(join(workspace, '.git', 'tongxu-managed.json'), { kind: 'owned-project-workspace', executionRoot: root, initialH: grant.H, initialTreeSha256: grant.treeSha256, sourceCandidate: r.candidate, requestSha256: hash(requestBytes), preparer: 'tongxu-fixed-project-preparer', preparerSourceWritesFinished: true });
  const candidate = await localCandidate(workspace, grant.H, true);
  const plan: RepairPlan = { ...config, schemaVersion: 1, kind: 'tongxu-controlled-repair', workspace, candidate, grant: join(root, 'grant.json'), findings: r.findings, test: 'registered-project-tests-v1', demonstrationFixture: r.demonstrationFixture, project };
  save(join(root, 'plan.json'), plan); return { plan: join(root, 'plan.json'), operation: join(root, 'operation'), candidate, sourceCandidate: r.candidate };
}

/** Run unchanged registered tools against a disposable exact Git input. The
 * writable repair workspace and all trusted controller records stay unmounted. */
export async function testProject(workspace: string, directory: string, p: ProjectContract) {
  const fixed = await projectTestPlan(p), current = await tree(workspace, true), inputHash = treeHash(current);
  await privateDirectory(directory, true); const work = join(directory, 'work'), output = join(directory, 'output');
  save(join(directory, 'test-intent.json'), { kind: 'registered-project-tests-v1', directory, workspace, generatedDirectories: p.generatedDirectories, controllerPid: process.pid, candidateTreeSha256: inputHash, testPlanSha256: p.testPlanSha256 });
  save(join(directory, 'test-progress.json'), { phase: 'preparing_input' });
  await mkdir(work, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  let setupIndex = 0;
  const setupGit = (args: string[]) => mutateGit(work, args, join(directory, 'git-setup-' + setupIndex++));
  await setupGit(['init', '--template=']);
  await setupGit(['fetch', '--no-tags', '--no-recurse-submodules', workspace, await git(workspace, ['rev-parse', 'HEAD'])]);
  await setupGit(['checkout', '--detach', 'FETCH_HEAD']);
  for (const [path, entry] of Object.entries(current)) { const full = join(work, path); await writeFile(full, entry.text, { mode: 0o600 }); await chmod(full, 0o600 | (entry.executable ?? 0)); }
  await setupGit(['add', '--all']); await setupGit(['-c', 'user.name=Tongxu fixed test input', '-c', 'user.email=tests@localhost', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'fixed project test input']);
  const generated = [];
  for (const [index, path] of p.generatedDirectories.entries()) {
    const source = join(directory, 'generated-' + index); await mkdir(source, { mode: 0o700 }); await mkdir(join(work, path), { recursive: true, mode: 0o700 }); generated.push({ path, source });
  }
  const H = await git(work, ['rev-parse', 'HEAD']), T = await git(work, ['rev-parse', 'HEAD^{tree}']), pre = await fingerprint(work, Object.keys(current), entries => save(join(directory, 'input-state.json'), entries));
  save(join(directory, 'input.json'), { candidateTreeSha256: inputHash, H, T, sourceCandidate: p.sourceCandidate, preFingerprint: pre, testPlanSha256: p.testPlanSha256, dependencyHash: p.dependencyHash, protectedPaths: p.protectedPaths });
  save(join(directory, 'test-progress.json'), { phase: 'runtime_requested' });
  const runtime = await DockerRuntime.prepare(fixed.plan.executor, join(directory, 'runtime')), tools = [];
  let executionHealthy = true;
  for (const [index, tool] of fixed.plan.tools.entries()) {
    let observed: unknown[] = [];
    const currentInput = await fingerprint(work, Object.keys(current), entries => { observed = entries; }), currentDependencies = await dependencyDigest(fixed.dependencies);
    if (currentInput !== pre || currentDependencies !== p.dependencyHash) {
      const expected = new Map<string, unknown>(JSON.parse((await regular(join(directory, 'input-state.json'), 16 * 1024 * 1024)).toString()));
      const actual = new Map<string, unknown>(observed as Array<[string, unknown]>);
      const changed = [...new Set([...expected.keys(), ...actual.keys()])].filter(path => JSON.stringify(expected.get(path)) !== JSON.stringify(actual.get(path)));
      save(join(directory, 'input-change-' + index + '.json'), { expectedInput: pre, currentInput, expectedDependencies: p.dependencyHash, currentDependencies, changed, observed });
      throw new Error('project_test_input_changed:' + JSON.stringify({ paths: changed.slice(0, 10), count: changed.length, dependencies: currentDependencies !== p.dependencyHash }));
    }
    const resultDirectory = join(output, String(index)); await mkdir(resultDirectory, { mode: 0o700 });
    save(join(directory, 'test-progress.json'), { phase: 'tool_requested', toolIndex: index });
    const writable: string[] = (tool as any).writableOutputs ?? [];
    const r = await runtime.run({ directory: join(directory, 'tool-' + index), work, readOnlyWork: true, outputMounts: generated.map(m => ({ ...m, writable: writable.includes(m.path) })), resultDirectory, dependencies: fixed.dependencies, argv: tool.argv, timeoutMs: tool.timeoutMs, maxBytes: 4 * 1024 * 1024, binding: { run: inputHash, stage: index, tool: tool.id, head: H, tree: T, planHash: p.testPlanSha256 } });
    // Never invoke Git in a checkout after candidate-controlled commands.
    const artifacts = await generatedEvidence(generated);
    save(join(directory, 'generated-state-' + index + '.json'), artifacts);
    const generatedArtifacts = { valid: artifacts.valid, count: artifacts.files.length, sha256: artifacts.sha256 };
    const inputUnchanged = await fingerprint(work, Object.keys(current)) === pre && generatedArtifacts.valid, dependenciesUnchanged = await dependencyDigest(fixed.dependencies) === p.dependencyHash;
    executionHealthy &&= inputUnchanged && dependenciesUnchanged && ['completed', 'failed'].includes(r.status);
    const resultFiles = await readdir(resultDirectory);
    if (resultFiles.some(name => name !== 'result.json')) executionHealthy = false;
    if (resultFiles.includes('result.json')) try { await regular(join(resultDirectory, 'result.json'), 4 * 1024 * 1024); } catch { executionHealthy = false; }
    let sampleSet;
    if (tool.expectedSampleIds) {
      let value: unknown;
      try { value = JSON.parse((await regular(join(resultDirectory, 'result.json'), 4 * 1024 * 1024)).toString()); } catch { /* missing original coverage stays incomplete */ }
      sampleSet = samples(value, tool.expectedSampleIds, executionHealthy && r.exitCode === 0);
    }
    tools.push({ id: tool.id, argv: tool.argv, status: r.status, exitCode: r.exitCode, inputUnchanged, dependenciesUnchanged, generatedArtifacts, registeredSampleIds: tool.expectedSampleIds ?? [], ...(sampleSet ? { sampleSet } : {}), stdout: r.stdout.toString().slice(0, 16000), stderr: r.stderr.toString().slice(0, 16000), stdoutSha256: hash(r.stdout), stderrSha256: hash(r.stderr), dockerRecordSha256: hash(r.record) });
    if (!executionHealthy || r.exitCode !== 0) break;
  }
  if (treeHash(await tree(workspace, true)) !== inputHash) throw new Error('repair_workspace_changed_during_tests');
  const passed = executionHealthy && tools.length === fixed.plan.tools.length && tools.every(t => t.status === 'completed' && t.exitCode === 0 && (!t.sampleSet || t.sampleSet.complete && t.sampleSet.samples.every(s => s.status === 'ok')));
  const result = { kind: 'registered-project-tests-v1', passed, executionHealthy, candidateTreeSha256: inputHash, H, T, tools, failure: executionHealthy ? null : 'test_execution_or_input_unverified', exit: { code: passed ? 0 : 1, signal: null }, businessCorrectness: 'requires_independent_review', testPlanSha256: p.testPlanSha256 };
  save(join(directory, 'result.json'), result); save(join(directory, 'test-progress.json'), { phase: 'completed', toolsRequested: tools.length }); return result;
}
export async function reconcileProjectTests(operation: string, p: ProjectContract) {
  const { plan } = await projectTestPlan(p);
  const walk = async (directory: string) => {
    const testDataDirectories = new Set<string>();
    if (projectTestNamespace(operation, directory) || directory === operation && await exists(join(directory, 'test-intent.json'))) {
      const intent = JSON.parse((await regular(join(directory, 'test-intent.json'))).toString());
      const progress = JSON.parse((await regular(join(directory, 'test-progress.json'))).toString());
      if (intent.directory !== directory || intent.testPlanSha256 !== p.testPlanSha256 || JSON.stringify(intent.generatedDirectories) !== JSON.stringify(p.generatedDirectories) || !['preparing_input', 'runtime_requested', 'tool_requested', 'completed'].includes(progress.phase)) throw new Error('project_test_intent_unverified');
      testDataDirectories.add('work'); testDataDirectories.add('output');
      p.generatedDirectories.forEach((_, i) => testDataDirectories.add('generated-' + i));
      if (progress.phase !== 'preparing_input' && !await exists(join(directory, 'runtime/probe/execution.json'))) throw new Error('project_test_capture_missing');
      const requested = progress.phase === 'completed' ? progress.toolsRequested : progress.phase === 'tool_requested' ? progress.toolIndex + 1 : 0;
      if (!Number.isSafeInteger(requested) || requested < 0 || requested > plan.tools.length) throw new Error('project_test_intent_unverified');
      for (let i = 0; i < requested; i++) if (!await exists(join(directory, 'tool-' + i, 'execution.json'))) throw new Error('project_test_capture_missing');
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('unsafe_operation_entry');
      if (entry.isDirectory() && !testDataDirectories.has(entry.name) && entry.name !== 'client-config' && !entry.name.startsWith('recovery-')) await walk(join(directory, entry.name));
      else if (entry.name === 'execution.json' && entry.isFile()) {
        const bytes = await regular(join(directory, entry.name)), record = JSON.parse(bytes.toString());
        if (record.kind !== 'tongxu-docker-execution') continue;
        if (record.clientPid && processState(record.clientPid) !== 'ended') throw new Error('project_test_client_active_or_unknown');
        const state = await reconcileDocker(directory, 'inspect', plan.executor!);
        if (!['ended', 'original_completed_record', 'ended_from_original_recovery', 'not_started'].includes(state.outcome)) throw new Error('project_test_container_active_or_unknown');
        if (state.outcome === 'not_started') await reconcileDocker(directory, 'stop', plan.executor!);
      }
    }
  };
  await walk(operation);
}
