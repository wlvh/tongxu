import { writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, privateDirectory } from './snapshot.js';
import { canonical } from './comparison.js';
import { save } from './live-process.js';
import { exists, regular } from './repair-workspace.js';
import { BoundedCodexSession, readRepairSession, secretarySchema, secretaryDeveloperInstructions } from './repair-native.js';
import { SecretaryTools, observeTask, secretaryToolSpecs } from './secretary-tools.js';
import type { Candidate } from './live-codex.js';

type FileRef = { path: string; sha256: string };
export type SecretaryPlan = {
  schemaVersion: 1; kind: 'tongxu-readonly-secretary'; store: string; item: string; candidate: Candidate;
  codexExecutable: string; codexSha256: string; prompts: FileRef[]; question: string;
  scopeSource: string; arrangementSource: string; disabledMcpServers: string[]; allowedInstructionSources: FileRef[];
  billing: { mode: 'existing_subscription_only'; evidence: string; evidenceSha256: string; observedAt: string; ordinaryUsageRequired: true };
  timeoutMs: number; executionKind: 'fixture' | 'native_capture';
};
const digest = /^[a-f0-9]{64}$/;
function parse(bytes: Buffer): SecretaryPlan {
  const p = JSON.parse(bytes.toString()), c = p.candidate;
  if (p.schemaVersion !== 1 || p.kind !== 'tongxu-readonly-secretary' || !digest.test(p.item) || !digest.test(p.codexSha256) || !c || !/^[\w.-]+\/[\w.-]+$/.test(c.repository) || !Number.isSafeInteger(c.pr) || c.pr < 1 || !/^[a-f0-9]{40}$/.test(c.H) || !/^[a-f0-9]{40}$/.test(c.B) || typeof c.target !== 'string' || !c.target || !Array.isArray(p.prompts) || p.prompts.length !== 2 || !Array.isArray(p.allowedInstructionSources) || !Array.isArray(p.disabledMcpServers) || p.disabledMcpServers.some((x: any) => typeof x !== 'string' || !/^[\w-]+$/.test(x)) || typeof p.question !== 'string' || !p.question.trim() || p.question.length > 8192 || !Number.isSafeInteger(p.timeoutMs) || p.timeoutMs < 1000 || p.timeoutMs > 900000 || !['fixture', 'native_capture'].includes(p.executionKind)) throw new Error('invalid_secretary_plan');
  if (Object.keys(c).some(k => !['repository', 'pr', 'H', 'B', 'target', 'kind'].includes(k)) || c.kind !== undefined && c.kind !== 'github-pr') throw new Error('invalid_secretary_candidate');
  for (const text of [p.scopeSource, p.arrangementSource]) if (typeof text !== 'string' || !text.trim() || text.length > 2048) throw new Error('secretary_scope_missing');
  for (const ref of [...p.prompts, ...p.allowedInstructionSources]) if (!ref || !digest.test(ref.sha256) || typeof ref.path !== 'string') throw new Error('secretary_prompt_binding_missing');
  for (const path of [p.store, p.codexExecutable, ...p.prompts.map((r: FileRef) => r.path), ...p.allowedInstructionSources.map((r: FileRef) => r.path)]) if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new Error('secretary_noncanonical_path');
  if (p.billing?.mode !== 'existing_subscription_only' || p.billing.ordinaryUsageRequired !== true || !digest.test(p.billing.evidenceSha256) || !Number.isFinite(Date.parse(p.billing.observedAt))) throw new Error('secretary_billing_boundary_missing');
  return p;
}
async function inputs(p: SecretaryPlan) {
  const prompts: string[] = [];
  for (const ref of [...p.prompts, ...p.allowedInstructionSources]) {
    const bytes = await regular(ref.path); if (hash(bytes) !== ref.sha256) throw new Error('secretary_instruction_source_changed');
    if (p.prompts.includes(ref)) prompts.push(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  }
  if (hash(await regular(p.billing.evidence)) !== p.billing.evidenceSha256 || hash(await regular(p.codexExecutable, 128 * 1024 * 1024)) !== p.codexSha256) throw new Error('secretary_runtime_or_billing_changed');
  return { system: prompts.join('\n\n'), promptParts: p.prompts.map((ref, i) => ({ sha256: ref.sha256, text: prompts[i] })), question: p.question, candidate: p.candidate, toolSpecs: secretaryToolSpecs, scopeSource: p.scopeSource, arrangementSource: p.arrangementSource };
}
const questionInput = (p: SecretaryPlan) => 'Answer this progress question by actually using the registered task-state queries. Cite their observationIds. Recorded judgments and publication are distinct from your explanation, current remote truth, approval and product completion.\n' + JSON.stringify({ question: p.question, candidate: p.candidate, item: p.item });
async function lock<T>(output: string, fn: () => Promise<T>) {
  const path = join(output, 'controller.sqlite');
  try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  await regular(path); const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); } catch { db.close(); throw new Error('secretary_controller_active'); }
  try { return await fn(); } finally { db.exec('ROLLBACK'); db.close(); }
}
async function final(output: string, p: SecretaryPlan, inputSha256: string, frozen: any, duplicate: boolean) {
  const native = join(output, 'codex-secretary'), result = await readRepairSession(native);
  if (result.binding.role !== 'secretary' || result.binding.run !== output || result.binding.inputManifestSha256 !== inputSha256 || canonical(result.binding.candidate) !== canonical(p.candidate) || result.binding.turnIds.length !== 1) throw new Error('secretary_capture_binding_mismatch');
  const submitted = JSON.parse((await regular(join(native, 'expected-requests.json'))).toString()), methods = submitted.filter((r: any) => r.method).map((r: any) => r.method);
  if (canonical(methods) !== canonical(['initialize', 'initialized', 'account/read', 'config/read', 'account/rateLimits/read', 'thread/start', 'account/rateLimits/read', 'turn/start'])) throw new Error('secretary_submitted_sequence_changed');
  const threadStart = submitted.find((r: any) => r.method === 'thread/start').params, turn = submitted.find((r: any) => r.method === 'turn/start').params;
  if (threadStart.baseInstructions !== frozen.system || threadStart.developerInstructions !== secretaryDeveloperInstructions || canonical(threadStart.dynamicTools) !== canonical(secretaryToolSpecs) || canonical(turn.input) !== canonical([{ type: 'text', text: questionInput(p) }]) || canonical(turn.outputSchema) !== canonical(secretarySchema) || turn.threadId !== result.binding.threadId || turn.approvalPolicy !== 'never' || canonical(turn.sandboxPolicy) !== canonical({ type: 'readOnly', networkAccess: false })) throw new Error('secretary_submitted_input_changed');
  const tools = new SecretaryTools(p.store, p.item, p.candidate, output), observations = await tools.observations();
  const pairs = JSON.parse((await regular(join(native, 'reconciled-tools.json'))).toString());
  if (!observations.length || observations.length > 8 || observations.length !== pairs.length) throw new Error('secretary_query_not_exercised');
  for (const pair of pairs) {
    const q = observations.find(o => o.request.callId === pair.request.params.callId);
    if (!q || canonical(q.request) !== canonical({ tool: pair.request.params.tool, arguments: pair.request.params.arguments, callId: pair.request.params.callId }) || canonical(q.response) !== canonical(pair.response.result)) throw new Error('secretary_query_capture_mismatch');
  }
  const report = JSON.parse(result.turns[0]!.final!.text);
  if (report.candidateH !== p.candidate.H || typeof report.report !== 'string' || !report.report.trim() || Object.keys(report).sort().join() !== 'candidateH,observationIds,report' || !Array.isArray(report.observationIds) || !report.observationIds.length || report.observationIds.some((id: any) => !observations.some(o => o.observationId === id))) throw new Error('secretary_unobserved_reference');
  return { kind: 'tongxu-readonly-secretary-result', status: 'completed', executionKind: p.executionKind, candidate: p.candidate, item: p.item, sessionId: result.binding.sessionId, threadId: result.binding.threadId, turnId: result.binding.turnIds[0], report: report.report, observationIds: report.observationIds, observations: observations.map(o => ({ id: o.observationId, observedAt: o.observation.observedAt, eventRevision: o.observation.eventRevision, query: o.request.tool })), localLedgerOnly: true, modelExplanationIsNotApproval: true, productionActionAllowed: false, queryCalls: observations.length, duplicate, newModelTasks: duplicate ? 0 : 1 };
}
export async function runSecretary(planPath: string, output: string) {
  const planBytes = await regular(planPath), p = parse(planBytes);
  if (!await exists(output)) await privateDirectory(output, true); else await privateDirectory(output, false);
  return lock(output, async () => {
    const savedPlan = join(output, 'plan.json'), savedInputs = join(output, 'inputs.json'), native = join(output, 'codex-secretary');
    if (await exists(savedPlan)) { if (!planBytes.equals(await regular(savedPlan))) throw new Error('secretary_plan_changed'); }
    else await writeFile(savedPlan, planBytes, { flag: 'wx', mode: 0o600 });
    if (!await exists(savedInputs)) {
      if (await exists(native)) throw new Error('secretary_original_inputs_missing');
      save(savedInputs, await inputs(p));
    }
    const bytes = await regular(savedInputs), frozen = JSON.parse(bytes.toString()), inputSha256 = hash(bytes);
    if (frozen.question !== p.question || canonical(frozen.candidate) !== canonical(p.candidate) || canonical(frozen.toolSpecs) !== canonical(secretaryToolSpecs) || !Array.isArray(frozen.promptParts) || frozen.promptParts.length !== 2 || frozen.promptParts.some((part: any, i: number) => typeof part.text !== 'string' || part.sha256 !== p.prompts[i]!.sha256 || hash(part.text) !== part.sha256) || frozen.system !== frozen.promptParts.map((part: any) => part.text).join('\n\n')) throw new Error('secretary_frozen_inputs_changed');
    const intentPath = join(output, 'operation.json');
    if (await exists(intentPath)) {
      const o = JSON.parse((await regular(intentPath)).toString());
      if (o.planSha256 !== hash(planBytes) || o.inputSha256 !== inputSha256) throw new Error('secretary_operation_binding_changed');
    } else save(intentPath, { kind: 'readonly-secretary-operation', planSha256: hash(planBytes), inputSha256, createdAt: new Date().toISOString() });
    if (await exists(native)) {
      try { const r = await final(output, p, inputSha256, frozen, true); save(join(output, 'result.json'), r); return r; }
      catch (e) { save(join(output, 'recovery.json'), { status: 'original_result_unknown_or_invalid', reason: e instanceof Error ? e.message : 'unknown', automaticResend: false }); throw e; }
    }
    const fresh = await inputs(p); if (canonical(fresh) !== canonical(frozen)) throw new Error('secretary_prepared_inputs_changed');
    const gate = new SecretaryTools(p.store, p.item, p.candidate, output);
    const beforeTurn = async () => {
      await gate.check();
      if (Date.now() - Date.parse(p.billing.observedAt) > 24 * 60 * 60 * 1000 || Date.parse(p.billing.observedAt) > Date.now() + 60000) throw new Error('secretary_billing_boundary_stale');
      const state = await observeTask(p.store, p.item, p.candidate); if (state.controls.some((c: { kind: string; stopped: boolean }) => c.kind === 'investment' && c.stopped)) throw new Error('new_investment_stopped');
    };
    await beforeTurn(); let session: BoundedCodexSession | undefined;
    try {
      session = await BoundedCodexSession.start({ executable: p.codexExecutable, directory: native, operation: output, candidate: p.candidate, role: 'secretary', system: frozen.system, inputManifestSha256: inputSha256, scopeSource: p.scopeSource, arrangementSource: p.arrangementSource, disabledMcpServers: p.disabledMcpServers, allowedInstructionSources: p.allowedInstructionSources, timeoutMs: p.timeoutMs, executionKind: p.executionKind, beforeTurn, gate });
      await beforeTurn();
      await session.turn(questionInput(p), p.candidate, secretarySchema);
      await session.close();
      const r = await final(output, p, inputSha256, frozen, false); save(join(output, 'result.json'), r); return r;
    } catch (e) { save(join(output, 'outcome.json'), { status: 'waiting_failed_or_unknown', reason: e instanceof Error ? e.message : 'unknown', automaticResend: false }); throw e; }
    finally { await session?.close(); }
  });
}
