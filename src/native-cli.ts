#!/usr/bin/env node
import { inspectNative, parseNativeArgs } from './native-inspection.js';

try {
  const { exit, report } = await inspectNative(parseNativeArgs(process.argv.slice(2)));
  // Detailed session IDs, paths and raw native messages remain in the private package.
  process.stdout.write(JSON.stringify({ id: report.id, status: report.status, version: report.version ?? null, executableHash: report.executableHash, capabilities: report.capabilities, gaps: report.gaps, limitations: report.limitations }, null, 2) + '\n');
  process.exitCode = exit;
} catch (e) {
  const message = e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'native_inspection_input_or_storage_error';
  process.stderr.write(JSON.stringify({ error: message }) + '\n'); process.exitCode = 1;
}
