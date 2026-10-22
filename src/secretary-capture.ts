import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { regular } from './repair-workspace.js';
import { checkConfig, disabledFeatures } from './live-codex.js';
import { secretaryDeveloperInstructions,coordinatingSecretaryDeveloperInstructions, secretarySchema } from './repair-native.js';
import {selectedSecretaryTools} from './secretary-tools.js';
import type { SecretaryPlan } from './secretary.js';
import { hash } from './snapshot.js';

/** Reconstruct policy from the trusted plan, never from expected-requests.json.
 * Hashes preserve bytes; this separately checks the meaning and RPC references. */
export async function verifySecretaryCapture(directory: string, p: SecretaryPlan, frozen: any, binding: any, question: string, observations: any[]) {
  const json = async (name: string) => JSON.parse((await regular(join(directory, name), 16 * 1024 * 1024)).toString());
  const lines = async (name: string) => (await regular(join(directory, name), 16 * 1024 * 1024)).toString().trim().split('\n').map(s => JSON.parse(s));
  const sent = await lines('stdin.ndjson'), received = await lines('stdout.ndjson'), cwd = join(directory, 'workspace');
  const inputs = [{ input: question, subjectCandidate: p.candidate, schema: secretarySchema }];
  if (binding.protocol !== 'codex-app-server/0.163.0-alpha.10.2' || binding.sourceKind !== p.executionKind || binding.scopeSource !== p.scopeSource || binding.arrangementSource !== p.arrangementSource || binding.promptSha256 !== hash(JSON.stringify({ system: frozen.system, inputs })) || !equal(await json('inputs.json'), inputs)) throw new Error('secretary_input_binding_changed');
  let id = 0; const request = (method: string, params: any) => ({ id: ++id, method, params });
  const prefix = [
    request('initialize', { clientInfo: { name: p.taskControls?'tongxu-task-secretary':'tongxu-readonly-secretary', version: '0.1.0' }, capabilities: { experimentalApi: true } }),
    { method: 'initialized', params: {} },
    request('account/read', { refreshToken: false }), request('config/read', { includeLayers: false, cwd }), request('account/rateLimits/read', {}),
    request('thread/start', { cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: frozen.system, developerInstructions: p.taskControls?coordinatingSecretaryDeveloperInstructions:secretaryDeveloperInstructions, dynamicTools: selectedSecretaryTools(!!p.taskControls,p.deliveryOutcomes===true,p.deliveryReports===true,!!p.workbench,p.scopeFollowupReports===true), environments: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [cwd] }),
    request('account/rateLimits/read', {}), request('turn/start', { threadId: binding.threadId, input: [{ type: 'text', text: question }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, effort: 'high', outputSchema: secretarySchema })
  ];
  const replies = new Map<number, any>(), expectedToolReplies: any[] = [];
  for (const m of received) {
    if (!Object.hasOwn(m, 'id')) continue;
    if (!m.method) {
      if (!Number.isSafeInteger(m.id) || m.id < 1 || m.id > id || !Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error') || replies.has(m.id) && !equal(replies.get(m.id), m.result)) throw new Error('secretary_rpc_reply_mismatch');
      replies.set(m.id, m.result); continue;
    }
    const args = m.params, record = observations.find(o => o.request.callId === args?.callId);
    if (m.method !== 'item/tool/call' || !record || args.threadId !== binding.threadId || args.turnId !== binding.turnIds[0] || args.namespace != null || !equal(record.request, { tool: args.tool, arguments: args.arguments, callId: args.callId })) throw new Error('secretary_server_request_mismatch');
    expectedToolReplies.push({ id: m.id, result: record.response });
  }
  if (!equal(sent, [...prefix, ...expectedToolReplies]) || replies.size !== id || binding.workspace !== cwd) throw new Error('secretary_submitted_protocol_changed');
  if (replies.get(2)?.account?.type !== 'chatgpt' || replies.get(4)?.ordinaryUsageAllowed !== true || replies.get(6)?.ordinaryUsageAllowed !== true) throw new Error('secretary_subscription_reply_mismatch');
  checkConfig(replies.get(3)?.config, true);
  const thread = replies.get(5), t = thread?.thread;
  if (!t || t.id !== binding.threadId || t.sessionId !== binding.sessionId || t.cwd !== cwd || t.cliVersion !== '0.163.0-alpha.10.2' || t.parentThreadId != null || t.forkedFromId != null || thread.cwd !== cwd || thread.approvalPolicy !== 'never' || thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess !== false || thread.modelProvider !== 'openai' || replies.get(7)?.turn?.id !== binding.turnIds[0]) throw new Error('secretary_native_acceptance_mismatch');
  if ((thread.instructionSources ?? []).some((path: string) => !p.allowedInstructionSources.some(ref => ref.path === path)) || !equal(await json('thread.json'), thread) || !equal(await json('effective-config.json'), replies.get(3))) throw new Error('secretary_metadata_reply_mismatch');
  const args = disabledFeatures.flatMap(name => ['-c', `features.${name}=${name === 'code_mode_host'}`]);
  for (const name of p.disabledMcpServers) args.push('-c', `mcp_servers.${name}.enabled=false`);
  args.push('-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'model_provider="openai"', '-c', 'service_tier="default"', 'app-server', '--listen', 'stdio://');
  const launch = await json('launch.json'), executable = await json('executable.json');
  if (launch.command !== p.codexExecutable || launch.cwd !== cwd || !equal(launch.args, args) || executable.path !== p.codexExecutable || executable.realpath !== p.codexExecutable || executable.sha256 !== p.codexSha256 || executable.version !== 'codex-cli 0.163.0-alpha.10.2') throw new Error('secretary_launch_boundary_mismatch');
}
