#!/usr/bin/env node
import { prepareRepairFixture, runRepair, revokeRepair } from './repair.js';
import { prepareProjectRepair } from './project-repair.js';
try {
  const a = process.argv.slice(2); let r: any;
  if (a.length === 5 && a[0] === 'demo' && a[1] === '--config' && a[3] === '--root') { const p = await prepareRepairFixture(a[2]!, a[4]!); r = await runRepair(p.plan, p.operation); }
  else if (a.length === 7 && a[0] === 'project' && a[1] === '--config' && a[3] === '--request' && a[5] === '--root') { const p = await prepareProjectRepair(a[2]!, a[4]!, a[6]!); r = await runRepair(p.plan, p.operation); }
  else if ((a.length === 5 || a.length === 6 && a[5] === '--reconcile-ended') && a[0] === 'run' && a[1] === '--plan' && a[3] === '--output') r = await runRepair(a[2]!, a[4]!, a[5] === '--reconcile-ended');
  else if (a.length === 5 && a[0] === 'revoke' && a[1] === '--output' && a[3] === '--source') { await revokeRepair(a[2]!, a[4]!); r = { status: 'revoked' }; }
  else throw new Error('usage: demo --config ABS --root NEW_ABS | project --config ABS --request ABS --root NEW_ABS | run --plan ABS --output ABS [--reconcile-ended] | revoke --output ABS --source TEXT');
  process.stdout.write(JSON.stringify({ status: r.status, before: r.before, after: r.after, actualRepairPerformed: r.actualRepairPerformed, manualReportCopyRequired: r.manualReportCopyRequired, manualRepairRequired: r.manualRepairRequired }) + '\n');
} catch (e) { process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : 'repair_error' }) + '\n'); process.exitCode = 1; }
