import { readFile, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, privateDirectory } from './snapshot.js';
import { loadBundle, parsePlan } from './verification.js';
import { canonical, samples, compare } from './comparison.js';
import { shaPattern } from './contract.js';
import type { Candidate, Manifest } from './contract.js';
import { dockerEvidenceMatches } from './docker-sandbox.js';

type Reference = { id: string; version: string; source: string };
export type Requirement = { item: string; type: 'development' | 'merge' | 'enablement' | 'parent'; version: string; blocks: 'shadow_review' | 'merge' | 'enablement'; source: string; canContinue: string };
export type QueueContext = { schemaVersion: 1; scope: Reference; arrangement: Reference; decisionKind: string; requires: Requirement[] };
export type Packet = { candidate: Candidate; context: QueueContext; fingerprint: string; manifestHash: string; reportHash: string; contextHash: string; blobs: Map<string, Buffer>; summary: { gaps: string[]; evidenceComplete: boolean; tree: string | null; reportId: string; observation: string | null; sourceObservation: string | null; originalOperations: { id: string; stage: number; tool: string; status: string; pid?: number }[]; limitations: string[] } };
const digest = /^[a-f0-9]{64}$/;
const text = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
export function parseQueueContext(v: unknown): QueueContext {
  const c = v as QueueContext;
  if (!c || c.schemaVersion !== 1 || !['owner_adoption_report', 'team_agreement', 'delegated_action', 'proposal', 'fact', 'unknown'].includes(c.decisionKind) || !Array.isArray(c.requires) || c.requires.length > 32) throw new Error('invalid_queue_context');
  for (const r of [c.scope, c.arrangement]) if (!r || !text(r.id, 128) || !text(r.version, 128) || !text(r.source)) throw new Error('missing_scope_or_arrangement_source');
  for (const r of c.requires) if (!r || !digest.test(r.item) || !['development', 'merge', 'enablement', 'parent'].includes(r.type) || !shaPattern.test(r.version) || !['shadow_review', 'merge', 'enablement'].includes(r.blocks) || !text(r.source) || !text(r.canContinue)) throw new Error('invalid_exact_requirement');
  const reference = (r: Reference): Reference => ({ id: r.id, version: r.version, source: r.source });
  return { schemaVersion: 1, scope: reference(c.scope), arrangement: reference(c.arrangement), decisionKind: c.decisionKind, requires: c.requires.map(r => ({ item: r.item, type: r.type, version: r.version, blocks: r.blocks, source: r.source, canContinue: r.canContinue })) };
}
export function candidateKey(candidate: Candidate, context: QueueContext): string {
  return hash(canonical([candidate.repository.toLowerCase(), candidate.pr, candidate.H, candidate.B, candidate.targetRef, context.scope.id, context.scope.version, context.arrangement.id, context.arrangement.version]));
}
export function targetKey(candidate: Candidate): string { return canonical([candidate.repository.toLowerCase(), `refs/heads/${candidate.targetRef}`]); }
async function regular(path: string, max: number): Promise<Buffer> {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > max || await realpath(path) !== path) throw new Error('invalid_queue_evidence_file');
  return readFile(path);
}
const date = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export async function readPacket(snapshot: string, verification: string, contextPath: string): Promise<Packet> {
  const bundle = await loadBundle(snapshot), manifest = JSON.parse(bundle.bytes.toString()) as Manifest;
  const contextBytes = await regular(contextPath, 1024 * 1024), context = parseQueueContext(JSON.parse(contextBytes.toString()));
  await privateDirectory(verification, false); await privateDirectory(join(verification, 'raw'), false);
  const reportBytes = await regular(join(verification, 'verification.json'), 64 * 1024 * 1024), r = JSON.parse(reportBytes.toString());
  if (![1, 2].includes(r?.schemaVersion) || r.kind !== 'tongxu-verification' || !text(r.id, 128) || !Array.isArray(r.inputs) || r.inputs.length < 1 || r.inputs.length > 8 || !Array.isArray(r.stages) || r.stages.length > 9 || !Array.isArray(r.gaps)) throw new Error('invalid_verification_report');
  const blobs = new Map<string, Buffer>(); let total = 0;
  const remember = (bytes: Buffer) => { const h = hash(bytes); if (!blobs.has(h)) { total += bytes.length; if (total > 128 * 1024 * 1024) throw new Error('queue_evidence_limit'); blobs.set(h, bytes); } return h; };
  const manifestHash = remember(bundle.bytes), reportHash = remember(reportBytes), contextHash = remember(contextBytes);
  const references: any[] = [r.plan, ...r.inputs.map((i: any) => i.manifest)];
  if (r.failureOutput) references.push(r.failureOutput.stdout, r.failureOutput.stderr);
  for (const s of r.stages) {
    if (!s || !Array.isArray(s.tools) || s.tools.length > 16 || !Array.isArray(s.gaps)) throw new Error('invalid_verification_stage');
    if (s.mergeOutput) references.push(s.mergeOutput);
    for (const t of s.tools) { if (!t || !text(t.id, 64) || !Array.isArray(t.gaps)) throw new Error('invalid_verification_tool'); for (const name of ['stdout', 'stderr', 'result', 'sandbox']) if (t[name]) references.push(t[name]); }
  }
  for (const [root, refs, pattern] of [[snapshot, manifest.artifacts, /^(raw\/[0-9a-f]{64}\.json|git\/[0-9a-f]{64}\.(patch|json))$/], [verification, references, /^raw\/[0-9a-f]{64}\.bin$/]] as const) {
    for (const ref of refs) {
      if (!ref || !pattern.test(ref.path) || !digest.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > 64 * 1024 * 1024) throw new Error('invalid_evidence_reference');
      const bytes = await regular(join(root, ref.path), 64 * 1024 * 1024);
      if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw new Error('queue_evidence_hash_mismatch'); remember(bytes);
    }
  }
  const c = bundle.candidate, gaps: string[] = [...bundle.sourceGaps.map(g => `source:${g}`)];
  if (!date(r.startedAt) || !date(c.observedAt)) gaps.push('observation_time_unavailable');
  const input = r.inputs.find((i: any) => i.manifestHash === manifestHash);
  const same = (v: any) => v && ['repository', 'pr', 'H', 'B', 'targetRef'].every(k => v[k] === (c as any)[k]);
  if (!input || !same(input.candidate) || input.manifest?.sha256 !== manifestHash || r.repository !== c.repository || r.targetRef !== c.targetRef) gaps.push('candidate_or_manifest_mismatch');
  if (r.planHash !== r.plan?.sha256) gaps.push('plan_hash_mismatch');
  if (r.inputs.length !== 1) gaps.push('additional_members_require_independent_reception');
  if (r.businessCorrectness !== 'unverified') gaps.push('unsupported_business_correctness_claim');
  if (r.status !== 'complete' || r.executionComplete !== true || r.gaps.length || r.stages.length !== r.inputs.length + 1) gaps.push('execution_evidence_incomplete');
  if (r.observedSampleFailures !== 0 || r.comparisonComplete === false) gaps.push('sample_failure_or_incomplete_comparison');
  const final = r.stages.at(-1);
  if (r.stages[0]?.inputHead !== c.B || final?.inputHead !== c.H || !shaPattern.test(final?.tree ?? '') || !shaPattern.test(final?.head ?? '')) gaps.push('tested_stage_mismatch');
  if (r.stages.some((s: any) => s.status !== 'complete' || !s.tools.length || s.gaps.length || s.tools.some((t: any) => t.status !== 'completed' || t.exitCode !== 0 || t.inputUnchanged !== true || t.dependenciesUnchanged !== true || t.gaps.length))) gaps.push('stage_or_tool_evidence_incomplete');
  // Validate the report against its original plan and outputs, not its success flags alone.
  let plan: ReturnType<typeof parsePlan> | undefined;
  try { plan = parsePlan(JSON.parse(blobs.get(r.plan.sha256)!.toString())); } catch { gaps.push('invalid_verification_plan'); }
  if (plan) {
    if (plan.schemaVersion !== r.schemaVersion) gaps.push('executor_report_version_mismatch');
    const structured = plan.tools.filter(t => t.expectedSampleIds), observedSets: any[][] = [];
    for (const [index, stage] of r.stages.entries()) {
      const parent = index === 0 ? c.B : r.stages[index - 1]?.head, inputHead = index === 0 ? c.B : r.inputs[index - 1]?.candidate?.H;
      if (stage.index !== index || stage.parent !== parent || stage.inputHead !== inputHead || !shaPattern.test(stage.head ?? '') || !shaPattern.test(stage.tree ?? '') || (index === 0 ? stage.head !== c.B : stage.head === parent)) gaps.push('stage_identity_chain_mismatch');
      if (index > 0 && (!stage.mergeOutput || blobs.get(stage.mergeOutput.sha256)?.toString().split('\n')[0]?.trim() !== stage.tree)) gaps.push('merge_tree_evidence_mismatch');
      if (stage.tools.length !== plan.tools.length || stage.tools.some((t: any, i: number) => t.id !== plan!.tools[i]?.id || canonical(t.argv) !== canonical(plan!.tools[i]?.argv))) gaps.push('planned_tool_coverage_mismatch');
      const sets: any[] = []; observedSets.push(sets);
      for (const tool of stage.tools) {
        if (!tool.stdout || !tool.stderr) gaps.push('original_tool_output_missing');
        if (plan.executor && (!/^docker-tool-[0-9]+-[a-zA-Z0-9_-]+-[0-9a-f-]{36}$/.test(tool.dockerExecutionDirectory ?? '') || !tool.sandbox || !dockerEvidenceMatches(blobs.get(tool.sandbox.sha256)!, plan.executor, { run: r.id, stage: index, tool: tool.id, head: stage.head, tree: stage.tree, planHash: r.planHash }, tool))) gaps.push('docker_execution_evidence_mismatch');
        if (!plan.executor && tool.sandbox) gaps.push('unplanned_docker_execution');
        const expected = plan.tools.find(t => t.id === tool.id)?.expectedSampleIds;
        if (expected) {
          let raw: unknown; try { raw = JSON.parse(blobs.get(tool.result?.sha256)!.toString()); } catch { gaps.push('original_sample_result_missing_or_invalid'); }
          // W2 appends sample-derived gaps after computing sampleSet. Replaying
          // those same gaps as an execution failure would invent a mismatch.
          const dataGaps = samples(raw, expected, true).gaps;
          const set = samples(raw, expected, tool.status === 'completed' && tool.exitCode === 0 && tool.inputUnchanged === true && tool.dependenciesUnchanged === true && tool.gaps.every((gap: string) => dataGaps.includes(gap)));
          sets.push({ id: tool.id, set });
          if (!set.complete) gaps.push('sample_result_incomplete');
          if (canonical(set) !== canonical(tool.sampleSet)) gaps.push('sample_result_evidence_mismatch');
        } else if (tool.sampleSet || tool.result) gaps.push('unplanned_structured_result');
      }
      const comparisons = structured.map(t => ({ tool: t.id, results: compare(observedSets[index - 1]?.find(s => s.id === t.id)?.set, sets.find(s => s.id === t.id)?.set, t.expectedSampleIds!) }));
      if (canonical(stage.comparisons) !== canonical(comparisons)) gaps.push('comparison_evidence_mismatch');
    }
    const failures = observedSets.flat().flatMap(s => s.set.samples).filter(s => s.status === 'fail').length;
    const comparisonComplete = structured.length ? r.stages.length === r.inputs.length + 1 && observedSets.every(sets => structured.every(t => sets.find(s => s.id === t.id)?.set.complete)) : null;
    if (r.observedSampleFailures !== failures || r.comparisonComplete !== comparisonComplete) gaps.push('sample_summary_evidence_mismatch');
  }
  const originalOperations = r.stages.flatMap((s: any) => s.tools.filter((t: any) => ['running', 'unknown'].includes(t.status)).map((t: any) => ({ id: r.id, stage: s.index, tool: t.id, status: t.status, ...(Number.isInteger(t.pid) ? { pid: t.pid } : {}) })));
  const semantic = { candidate: [c.repository, c.pr, c.H, c.B, c.targetRef], context, source: [...new Set(manifest.artifacts.map(a => canonical([a.kind, a.status ?? null, a.sha256])))].sort(), gaps, plan: r.planHash, dependency: r.dependencyHash, toolVersions: r.toolVersions, judgmentRefs: r.judgmentRefs, status: r.status, executionComplete: r.executionComplete, comparisonComplete: r.comparisonComplete, observedSampleFailures: r.observedSampleFailures, businessCorrectness: r.businessCorrectness, originalOperations: originalOperations.map(({ pid: _pid, ...operation }: any) => operation), stages: r.stages.map((s: any) => ({ index: s.index, inputHead: s.inputHead, parent: s.parent, tree: s.tree, status: s.status, comparisons: s.comparisons, gaps: s.gaps, tools: s.tools.map((t: any) => ({ id: t.id, argv: t.argv, status: t.status, exit: t.exitCode, signal: t.signal, inputUnchanged: t.inputUnchanged, dependenciesUnchanged: t.dependenciesUnchanged, dependencyHash: t.dependencyHash, sampleSet: t.sampleSet, gaps: t.gaps })) })) };
  return { candidate: c, context, fingerprint: hash(canonical(semantic)), manifestHash, reportHash, contextHash, blobs, summary: { gaps: [...new Set(gaps)], evidenceComplete: gaps.length === 0, tree: final?.tree ?? null, reportId: r.id, observation: date(r.startedAt), sourceObservation: date(c.observedAt), originalOperations, limitations: ['reported_evidence_is_not_independent_acceptance', 'source_binding_is_not_owner_authorization', 'no_live_remote_refresh', 'deduplication_uses_declared_results_not_arbitrary_log_semantics', ...(r.comparisonComplete === null ? ['ordinary_test_output_has_no_structured_sample_coverage'] : [])] } };
}
