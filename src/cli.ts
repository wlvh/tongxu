#!/usr/bin/env node
import { readFile, mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoPattern } from './contract.js';
import { Snapshot, parseContext, privateDirectory } from './snapshot.js';
import { GhTransport, RelayTransport } from './transport.js';
import { collect } from './collector.js';
import { renderHandoff } from './handoff.js';

const help = `tongxu inspect --repo OWNER/REPO --pr N [--issue N ...] [--format text|json]
tongxu collect --repo OWNER/REPO --pr N --output ABSOLUTE_NEW_DIR [--issue N ...] [--context JSON_FILE]
tongxu collect --resume ABSOLUTE_EXISTING_DIR
Transport: --transport gh (default), or --transport relay --relay-dir ABSOLUTE_PRIVATE_DIR
Requires Node 24+, Git, and gh for the default transport. Read-only GitHub GET / Git object reads.
Exit 0 = requested facts collected, 2 = saved partial collection, 1 = invalid input/local error.
An exit code never grants approval, merge permission or business PASS. See docs/w1_cli.md.\n`;
type Options = { command: 'inspect' | 'collect'; repo?: string; pr?: number; issues: number[]; output?: string; resume?: string; context?: string; format: string; transport: string; relayDir?: string };
const number = (v: string) => { if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error('invalid_positive_integer'); return Number(v); };
export function parseArgs(args: string[]): Options {
  const command = args[0];
  if (!['inspect', 'collect'].includes(command ?? '')) throw new Error('invalid_command');
  const values = new Map<string, string>();
  const issues: number[] = [];
  const keys = ['repo', 'pr', 'issue', 'output', 'resume', 'context', 'format', 'transport', 'relay-dir'];
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!flag.startsWith('--') || !keys.includes(flag.slice(2)) || !value || value.startsWith('--')) throw new Error('invalid_option');
    const key = flag.slice(2);
    if (key === 'issue') { issues.push(number(value)); continue; }
    if (values.has(key)) throw new Error('duplicate_option');
    values.set(key, value);
  }
  const repo = values.get('repo');
  const pr = values.has('pr') ? number(values.get('pr')!) : undefined;
  const resume = values.get('resume');
  const output = values.get('output');
  const transport = values.get('transport') ?? 'gh';
  const relayDir = values.get('relay-dir');
  const format = values.get('format') ?? 'text';
  if (!['text', 'json'].includes(format) || !['gh', 'relay'].includes(transport) || (transport === 'relay') !== Boolean(relayDir)) throw new Error('invalid_format_or_transport');
  if (resume) {
    if (command !== 'collect' || repo || pr || issues.length || output || values.has('context') || values.has('format')) throw new Error('resume_uses_saved_scope');
  } else if (!repo || !repoPattern.test(repo) || !pr || (command === 'collect' && !output)) throw new Error('missing_or_invalid_scope');
  if (command === 'inspect' && output || command === 'collect' && values.has('format')) throw new Error('option_not_applicable');
  return { command: command as Options['command'], repo, pr, issues: [...new Set(issues)], output, resume, context: values.get('context'), format, transport, relayDir };
}
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(help); return 0; }
  let snapshot: Snapshot | undefined;
  let temporary: string | undefined;
  let relayLock: string | undefined;
  try {
    const options = parseArgs(args);
    const context = options.context ? parseContext(JSON.parse(await readFile(options.context, 'utf8'))) : [];
    if (options.relayDir) {
      await privateDirectory(options.relayDir, false);
      const lock = join(options.relayDir, 'client.lock');
      await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      relayLock = lock;
    }
    const transport = options.transport === 'relay' ? new RelayTransport(options.relayDir!) : new GhTransport();
    if (options.command === 'inspect') temporary = await mkdtemp(join(tmpdir(), 'tongxu-inspect-'));
    snapshot = options.resume ? await Snapshot.resume(options.resume) : await Snapshot.create(options.output ?? join(temporary!, 'snapshot'), options.repo!, options.pr!, options.issues, context);
    const exit = await collect(snapshot, transport);
    if (options.command === 'inspect') process.stdout.write(options.format === 'json' ? JSON.stringify(snapshot.manifest, null, 2) + '\n' : renderHandoff(snapshot.manifest));
    else process.stdout.write(JSON.stringify({ schemaVersion: 1, exit, output: snapshot.directory, rounds: snapshot.manifest.rounds.length, gaps: snapshot.manifest.rounds.at(-1)?.gaps }) + '\n');
    return exit;
  } catch (error) {
    const message = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'invalid_input_or_local_io';
    process.stderr.write(`tongxu: ${message}\n`);
    return 1;
  } finally {
    if (snapshot) await snapshot.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (relayLock) await unlink(relayLock).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
