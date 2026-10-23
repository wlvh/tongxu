#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { importResult, prepareHandoff } from './codex-results.js';

try {
  const args = process.argv.slice(2), command = args.shift();
  const keys: Record<string, string[]> = { import: ['--binding', '--input', '--output'], append: ['--packet', '--input', '--output'], replay: ['--packet', '--output'], handoff: ['--packet', '--output'] };
  if (!command || !keys[command]) throw new Error('invalid_codex_result_command');
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !keys[command]!.includes(key) || options[key] || !value || !isAbsolute(value) || resolve(value) !== value) throw new Error('invalid_codex_result_option');
    options[key] = value;
  }
  if (keys[command]!.some(k => !options[k])) throw new Error('missing_codex_result_option');
  if (command === 'handoff') {
    const input = await prepareHandoff(options['--packet']!, options['--output']!);
    process.stdout.write(JSON.stringify({ kind: input.kind, role: input.role, sourceKind: input.sourceKind, delivery: input.delivery, realModelExecutionVerified: false }) + '\n');
  } else {
    const result = await importResult({ binding: options['--binding'], input: options['--input'], previous: options['--packet'], replay: command === 'replay', output: options['--output']! });
    process.stdout.write(JSON.stringify({ captureId: result.captureId, status: result.status, sourceKind: result.binding.sourceKind, handoffReady: result.handoffReady, gaps: result.gaps, realModelExecutionVerified: false }) + '\n');
    process.exitCode = result.status === 'final_observed' ? 0 : 2;
  }
} catch (e) {
  const error = e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'codex_result_input_or_storage_error';
  process.stderr.write(JSON.stringify({ error }) + '\n'); process.exitCode = 1;
}
