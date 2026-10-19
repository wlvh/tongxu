import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from './snapshot.js';
import { executable, LiveProcess, newStage, save, checkCapture } from './live-process.js';

const exec = promisify(execFile);
function finalResult(events: any[]) {
  const inits = events.filter(e => e.type === 'system' && e.subtype === 'init'), results = events.filter(e => e.type === 'result');
  const result = results[0], init = inits[0];
  if (inits.length !== 1 || results.length !== 1 || !init.session_id || init.claude_code_version !== '2.1.233' || result.session_id !== init.session_id || !Array.isArray(init.tools) || init.tools.length !== 0 || !Array.isArray(init.mcp_servers) || init.mcp_servers.length !== 0 || init.permissionMode !== 'dontAsk' || init.apiKeySource !== 'none' || result.subtype !== 'success' || result.is_error !== false || result.terminal_reason !== 'completed' || result.stop_reason !== 'end_turn' || result.api_error_status != null || typeof result.result !== 'string' || !result.result.trim() || events.some(e => e.parent_tool_use_id != null || e.aborted === true || (e.type === 'assistant' && e.session_id !== init.session_id) || e.message?.content?.some((x: any) => x.type === 'tool_use'))) throw new Error('stage_raw_result_not_final');
  return { init, result };
}
export function claudeArgs(system: string): string[] {
  return ['-p', '--safe-mode', '--setting-sources', '', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'stream-json', '--verbose', '--system-prompt', system];
}
export async function runClaude(o: { executable: string; directory: string; system: string; input: string; timeoutMs: number; beforeDispatch?: () => void }) {
  await newStage(o.directory);
  const identity = await executable(o.executable, '2.1.233 (Claude Code)'); save(join(o.directory, 'executable.json'), identity);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) if (process.env[key]) throw new Error('api_billing_override_present');
  const authRaw = await exec(o.executable, ['auth', 'status', '--json'], { timeout: 15_000 });
  const auth = JSON.parse(authRaw.stdout);
  if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty' || auth.subscriptionType !== 'max') throw new Error('included_subscription_not_confirmed');
  save(join(o.directory, 'auth-route.json'), { loggedIn: auth.loggedIn, authMethod: auth.authMethod, apiProvider: auth.apiProvider, subscriptionType: auth.subscriptionType });
  // All curated source and prior results are delivered as data in stdin. This
  // role needs no filesystem, shell, web, MCP, or subagent tool at runtime.
  const args = claudeArgs(o.system);
  // Last synchronous queue gate, after preflight and immediately before spawn.
  o.beforeDispatch?.();
  const child = new LiveProcess(o.directory, o.executable, args, o.directory, { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  try {
    child.writeText(o.input);
    const init = await child.waitFor(m => m.type === 'system' && m.subtype === 'init', 30_000);
    save(join(o.directory, 'init.json'), init);
    if (!init.session_id || init.claude_code_version !== '2.1.233' || init.permissionMode !== 'dontAsk' || init.apiKeySource !== 'none' || !Array.isArray(init.tools) || init.tools.length || !Array.isArray(init.mcp_servers) || init.mcp_servers.length) throw new Error('claude_role_boundary_not_applied');
    await child.waitFor(m => m.type === 'result' && m.session_id === init.session_id, o.timeoutMs);
    await Promise.race([child.closed, new Promise<void>((_, reject) => { const t = setTimeout(() => reject(new Error('claude_exit_timeout')), 30_000); child.closed.then(() => clearTimeout(t)); })]);
  } finally { await child.close(); }
  if (child.failure || child.exit?.code !== 0) throw new Error('claude_final_result_unavailable');
  const { init, result } = finalResult(child.events);
  const receipt = { kind: 'claude-execution-receipt', executable: identity, sessionId: result.session_id, model: init.model, inputSha256: hash(o.input), systemPromptSha256: hash(o.system), rawSha256: hash(await readFile(join(o.directory, 'stdout.ndjson'))), processExit: child.exit, nativeBoundary: { tools: init.tools, mcpServers: init.mcp_servers, permissionMode: init.permissionMode, safeMode: true }, finalText: result.result, reportedUsage: result.usage, clientCostEstimateUsd: result.total_cost_usd, costEstimateIsNotBillingProof: true };
  save(join(o.directory, 'completed.json'), receipt); return receipt;
}

export async function readClaudeExecution(directory: string) {
  await checkCapture(directory);
  const raw = await readFile(join(directory, 'stdout.ndjson'));
  if (!raw.length || raw[raw.length - 1] !== 10) throw new Error('stage_raw_result_not_final');
  const events = new TextDecoder('utf8', { fatal: true }).decode(raw).trim().split('\n').map(x => JSON.parse(x));
  const exit = JSON.parse(await readFile(join(directory, 'exit.json'), 'utf8'));
  if (exit.code !== 0 || exit.signal != null) throw new Error('stage_exit_not_successful');
  const { init, result } = finalResult(events);
  const launch = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'));
  const system = launch.args[launch.args.indexOf('--system-prompt') + 1];
  if (launch.args.indexOf('--system-prompt') < 0 || typeof system !== 'string' || !launch.args.includes('--safe-mode')) throw new Error('stage_launch_boundary_missing');
  return { kind: 'claude-execution-receipt', sessionId: init.session_id, model: init.model, finalText: result.result, inputSha256: hash(await readFile(join(directory, 'stdin.ndjson'))), systemPromptSha256: hash(system), rawSha256: hash(raw), processExit: exit, recoveredFromOriginalBytes: true };
}
