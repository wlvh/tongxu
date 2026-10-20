import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash } from '../../src/snapshot.js';
import { prepareRepairFixture, runRepair, revokeRepair, type RepairConfig } from '../../src/repair.js';
import { git, tree, treeHash, acquireWorkspace, releaseWorkspace, RepairTools, testClamp, safeEnv } from '../../src/repair-workspace.js';
import { fixture } from './repair-fixture.js';
import { checkConfig, disabledFeatures } from '../../src/live-codex.js';

const exec = promisify(execFile);
const modelInputs = (text: string) => text.split('\n').filter(x => x.includes('"kind":"model-input"')).length;

test('one controlled entry performs tool writes, actual tests, a new commit and a fresh review', async t => {
  const f = await fixture(t), before = await git(f.workspace, ['rev-parse', 'HEAD']), result = await runRepair(f.plan, f.operation);
  assert.equal(result.status, 'completed'); assert.equal(result.actualRepairPerformed, true); assert.notEqual(result.after.H, before); assert.equal(result.after.kind, 'local-git'); assert.equal(result.after.pr, null);
  assert.equal(result.manualRepairRequired, false); assert.equal(result.manualReportCopyRequired, false);
  const trace = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(trace), 5); assert.equal(trace.split('\n').filter(x => x.includes('"kind":"tool-request"')).length, 5);
  assert.deepEqual((result.data as any).changed, ['clamp.mjs']); assert.equal((result.data as any).tests.passed, true);
  const again = await runRepair(f.plan, f.operation); assert.deepEqual(again, result); assert.equal(await readFile(f.trace, 'utf8'), trace);
  await writeFile(join(f.operation, 'result.json'), JSON.stringify({ status: 'forged', automaticRepairImplemented: true }));
  assert.deepEqual(await runRepair(f.plan, f.operation), result); assert.equal(await readFile(f.trace, 'utf8'), trace);
});

test('no grant, changed candidate, active writer and unknown writer prevent any model dispatch', async t => {
  for (const mode of ['no-grant', 'changed', 'active', 'unknown']) {
    const f = await fixture(t);
    if (mode === 'no-grant') { const g = JSON.parse(await readFile(f.grantPath, 'utf8')); g.allowRepair = false; await writeFile(f.grantPath, JSON.stringify(g)); }
    if (mode === 'changed') await writeFile(join(f.workspace, 'clamp.mjs'), 'export const changed=true;');
    if (mode === 'active' || mode === 'unknown') await writeFile(join(f.workspace, '.git/tongxu-writer.json'), JSON.stringify({ operation: f.operation, controllerPid: mode === 'active' ? process.pid : 0, generation: 'existing', status: 'held' }));
    await assert.rejects(runRepair(f.plan, f.operation, true), /repair_not_authorized|candidate_or_uncommitted_state_changed|writer_active_or_unknown/);
    assert.equal(modelInputs(await readFile(f.trace, 'utf8')), 0);
  }
});

test('an out-of-scope dynamic write is rejected without modifying the file or starting review', async t => {
  const f = await fixture(t, 'outside'), before = await tree(f.workspace);
  await assert.rejects(runRepair(f.plan, f.operation), /write_outside_grant_or_stale_input/);
  assert.equal(treeHash(await tree(f.workspace)), treeHash(before)); assert.equal(modelInputs(await readFile(f.trace, 'utf8')), 4);
  await assert.rejects(runRepair(f.plan, f.operation), /writer_active_or_unknown/);
});

test('ended interrupted writer resumes from preserved changes without sending the original repair again', async t => {
  const f = await fixture(t, 'interrupt');
  const code = `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)});}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code]), /executor_closed_before_result/);
  const first = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(first), 4);
  const r = await runRepair(f.plan, f.operation, true);
  assert.equal(r.status, 'completed_recovered_candidate'); assert.equal((r.data as any).writerTerminal, 'unknown_or_interrupted'); assert.equal(r.actualRepairPerformed, true);
  const last = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(last), 5); assert.equal(last.split('\n').filter(x => x.includes('"name":"tongxu_replace_file"')).length, 1);
  await runRepair(f.plan, f.operation); assert.equal(await readFile(f.trace, 'utf8'), last);
});

test('revocation is checked by the actual write gate and preserves already applied source', async t => {
  const f = await fixture(t); await mkdir(f.operation, { mode: 0o700 });
  const g = JSON.parse(await readFile(f.grantPath, 'utf8')), current = await tree(f.workspace), lease = await acquireWorkspace(f.workspace, f.operation, false, g);
  const gate = new RepairTools(f.workspace, f.operation, g, lease, process.execPath, current); await gate.handoff('fixture-fact-session');
  await revokeRepair(f.operation, 'fixture:explicit-user-revocation');
  await assert.rejects(gate.call({ tool: 'tongxu_replace_file', callId: 'fixture-write-after-revoke', arguments: { path: 'clamp.mjs', expectedSha256: current['clamp.mjs']!.sha256, text: 'changed' } }), /revoked/);
  assert.equal(treeHash(await tree(f.workspace)), treeHash(current)); await releaseWorkspace(f.workspace, lease, 'revoked');
});

test('candidate cannot replace checker output and the OS refuses signals to its controller', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, 'clamp.mjs'), 'export function clamp(value,low,high){return 999;}');
  const wrong = await testClamp(f.workspace, join(f.root, 'wrong-value'), process.execPath); assert.equal(wrong.passed, false);
  const spoof = "process.stdout.write = () => true; export function clamp(value,low,high){return 999;}";
  await writeFile(join(f.workspace, 'clamp.mjs'), spoof);
  const refused = await testClamp(f.workspace, join(f.root, 'spoof'), process.execPath); assert.equal(refused.passed, false); assert.equal((refused as any).candidateExecuted, false);
  await writeFile(join(f.workspace, 'clamp.mjs'), 'export function clamp(value,low,high){return Math.min(high,Math.max(low,value));}');
  const valid = await testClamp(f.workspace, join(f.root, 'valid'), process.execPath); assert.equal(valid.passed, true);
  let signals = 0; const handler = () => signals++; process.on('SIGUSR2', handler); t.after(() => process.removeListener('SIGUSR2', handler));
  const probe = "try{process.kill(process.ppid,'SIGUSR2');console.log('allowed')}catch(e){console.log(e.code)}";
  const x = await exec('/usr/bin/sandbox-exec', ['-f', join(f.root, 'valid/sandbox.sb'), process.execPath, '-e', probe], { cwd: f.workspace, env: safeEnv });
  assert.equal(x.stdout.trim(), 'EPERM'); assert.equal(signals, 0);
});

test('a committed candidate survives ended review interruption without another repair or commit', async t => {
  const f = await fixture(t, 'review-interrupt');
  const code = `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)});}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code]), /executor_closed_before_result/);
  const committed = await git(f.workspace, ['rev-parse', 'HEAD']); assert.notEqual(committed, f.candidate.H);
  const first = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(first), 5);
  const r = await runRepair(f.plan, f.operation, true);
  assert.equal(r.status, 'completed_recovered_candidate'); assert.equal(r.after.H, committed); assert.equal((r.data as any).writerTerminal, 'completed');
  const last = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(last), 6); assert.equal(last.split('\n').filter(x => x.includes('"name":"tongxu_replace_file"')).length, 1);
});

test('recovered rework continues and an empty technical report is not made an owner decision', async t => {
  const f = await fixture(t, 'interrupt-rework');
  const code = `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)});}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code]));
  const result = await runRepair(f.plan, f.operation, true); assert.equal(result.status, 'completed');
  assert.ok(modelInputs(await readFile(f.trace, 'utf8')) > 5);
  const empty = await fixture(t, 'empty-review'); await assert.rejects(runRepair(empty.plan, empty.operation), /review_evidence_missing/);
  const status = JSON.parse(await readFile(join(empty.operation, 'status.json'), 'utf8'));
  assert.equal(status.data.reason, 'review_evidence_missing'); assert.notEqual(status.stage, 'owner_decision_required');
  await assert.rejects(readFile(join(empty.operation, 'terminal-record.json')), { code: 'ENOENT' });
});

test('recovery shares the original write-batch limit instead of granting fresh attempts', async t => {
  const f = await fixture(t, 'interrupt-rework');
  const grant = JSON.parse(await readFile(f.grantPath, 'utf8')); grant.maxRepairRounds = 1;
  await writeFile(f.grantPath, JSON.stringify(grant));
  const code = `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)});}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code]));
  const result = await runRepair(f.plan, f.operation, true);
  assert.equal(result.status, 'repair_round_budget_reached');
  assert.equal((result.data as any).usedRepairRounds, 1);
  const trace = await readFile(f.trace, 'utf8');
  assert.equal(modelInputs(trace), 5); // Only the necessary new review; no second writer.
  assert.equal(trace.split('\n').filter(x => x.includes('"name":"tongxu_replace_file"')).length, 1);
});

test('a recovered commit remains recoverable after its own review is interrupted', async t => {
  const f = await fixture(t, 'interrupt-twice');
  const code = (reconcile: boolean) => `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)},${reconcile});}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code(false)]), /executor_closed_before_result/);
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code(true)]), /executor_closed_before_result/);
  const committed = await git(f.workspace, ['rev-parse', 'HEAD']); assert.notEqual(committed, f.candidate.H);
  const result = await runRepair(f.plan, f.operation, true);
  assert.equal(result.status, 'completed_recovered_candidate'); assert.equal(result.after.H, committed);
  assert.equal((result.data as any).writerTerminal, 'unknown_or_interrupted');
  const trace = await readFile(f.trace, 'utf8'); assert.equal(modelInputs(trace), 6);
  assert.equal(trace.split('\n').filter(x => x.includes('"name":"tongxu_replace_file"')).length, 1);
});

test('a missing native tool host stops before impact or repair, while read-only configuration stays strict', async t => {
  const f = await fixture(t, 'host-unavailable');
  await assert.rejects(runRepair(f.plan, f.operation), /native_tool_host_unavailable/);
  assert.equal(modelInputs(await readFile(f.trace, 'utf8')), 1);
  assert.equal(await git(f.workspace, ['rev-parse', 'HEAD']), f.candidate.H);
  await assert.rejects(readFile(join(f.operation, 'attempt-1/fact-and-repair/completed.json')), { code: 'ENOENT' });
  const config = { web_search: 'disabled', model_provider: 'openai', service_tier: 'default', features: Object.fromEntries(disabledFeatures.map(x => [x, false])), mcp_servers: {} };
  checkConfig(config);
  config.features.code_mode_host = true;
  assert.throws(() => checkConfig(config), /native_feature_boundary_not_applied/);
  checkConfig(config, true);
  config.features.shell_tool = true;
  assert.throws(() => checkConfig(config, true), /native_feature_boundary_not_applied/);
});

test('a rejected structured turn cannot acquire a completion receipt during close', async t => {
  const f = await fixture(t);
  await writeFile(f.config.codexExecutable, (await readFile(f.config.codexExecutable, 'utf8')).replaceAll('candidateH:context.candidate.H', "candidateH:'wrong-candidate'"));
  await assert.rejects(runRepair(f.plan, f.operation), /structured_report_wrong_candidate/);
  const stage = join(f.operation, 'attempt-1/fact-and-repair');
  await assert.rejects(readFile(join(stage, 'completed.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(stage, 'native-boundary-failure.json'), 'utf8')).reason, 'structured_report_wrong_candidate');
  assert.equal(modelInputs(await readFile(f.trace, 'utf8')), 1);
});

test('a tool request buffered after turn completion never reaches the gate or becomes a completed receipt', async t => {
  const f = await fixture(t), source = await readFile(f.config.codexExecutable, 'utf8');
  const terminal = "emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:current,status:'completed',rootTurnId:current,items:[item],itemsView:'full',error:null}}});";
  assert.ok(source.includes(terminal));
  const late = "process.stdout.write([{method:'turn/completed',params:{threadId:thread.id,turn:{id:current,status:'completed',rootTurnId:current,items:[item],itemsView:'full',error:null}}},{id:'late-read',method:'item/tool/call',params:{threadId:thread.id,turnId:current,callId:'late-read',namespace:null,tool:'tongxu_read_file',arguments:{path:'clamp.mjs'}}}].map(x=>JSON.stringify(x)+'\\n').join(''));";
  await writeFile(f.config.codexExecutable, source.replace(terminal, late));
  await assert.rejects(runRepair(f.plan, f.operation), /native_tool_request_after_terminal|controlled_result_not_final|dynamic_tool_identity_or_permission_mismatch/);
  const stage = join(f.operation, 'attempt-1/fact-and-repair');
  const served = JSON.parse(await readFile(join(stage, 'reconciled-tools.json'), 'utf8'));
  assert.equal(served.length, 2); assert.ok(served.every((x: any) => x.request.params.callId !== 'late-read'));
  await assert.rejects(readFile(join(stage, 'completed.json')), { code: 'ENOENT' });
  assert.equal(modelInputs(await readFile(f.trace, 'utf8')), 1);
  assert.equal(await git(f.workspace, ['rev-parse', 'HEAD']), f.candidate.H);
});
