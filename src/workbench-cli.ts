#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { startWorkbench } from './workbench.js';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = process.argv.slice(2); if (a.length !== 2 || a[0] !== '--plan' || !a[1]) throw new Error('invalid_workbench_command');
    const app = await startWorkbench(a[1]);
    process.stdout.write(JSON.stringify({ status: 'listening', mode: 'read_only', url: app.url, pid: process.pid, modelCalls: 0 }) + '\n');
    const stop = () => { void app.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (e) { process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : 'workbench_failed' }) + '\n'); process.exitCode = 1; }
}
