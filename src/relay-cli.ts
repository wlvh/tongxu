#!/usr/bin/env node
import { runRelay } from './relay.js';
try {
  const a = process.argv.slice(2);
  if (a.length !== 5 || a[0] !== 'run' || a[1] !== '--plan' || a[3] !== '--output') throw new Error('usage_run_plan_output');
  const r = await runRelay(a[2]!, a[4]!);
  process.stdout.write(JSON.stringify({ status: r.status, candidate: r.candidate, manualReportCopyRequired: r.manualReportCopyRequired, productionActionAllowed: false }) + '\n');
} catch (e) { process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : 'relay_error' }) + '\n'); process.exitCode = 1; }
