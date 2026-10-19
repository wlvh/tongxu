import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Snapshot, hash } from '../../src/snapshot.js';
import { QueueStore } from '../../src/queue-store.js';
import { readPacket } from '../../src/queue-evidence.js';
import { runReception, reconcileReception, type ReceiverPlan } from '../../src/receiver.js';

async function setup(t: test.TestContext, mode = 'complete') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-receiver-fixture-')); t.after(() => rm(root, { recursive: true, force: true }));
  const objects = join(root, 'objects'); await mkdir(objects); const git = (args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: objects, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--initial-branch=fixture']); await writeFile(join(objects, 'sample.js'), '// explicit test fixture; no real model\nexport const value=1;\n'); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture']);
  const B = git(['rev-parse', 'HEAD']), baseTree = git(['rev-parse', 'HEAD^{tree}']);
  await writeFile(join(objects, 'sample.js'), '// explicit test fixture; no real model\nexport const value=2;\n'); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture candidate']);
  const H = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  const store = join(root, 'queue'), q = await QueueStore.create(store, 'fixture/reception', 1); if (mode !== 'no-enable') q.enableReceiver(); t.after(() => q.close()); let index = 0;
  async function packet(options: { incomplete?: boolean; target?: string; pr?: number; requires?: any[] } = {}) {
    const at = new Date(Date.parse('2026-10-19T00:00:00Z') + ++index * 2000).toISOString(), pr = options.pr ?? 1;
    const candidate = { repository: 'fixture/reception', pr, H, B, mergeBase: B, targetRef: options.target ?? 'fixture', observedAt: at };
    const snapshot = join(root, 'snapshot-' + index), s = await Snapshot.create(snapshot, candidate.repository, pr, [], []); s.manifest.candidate = candidate;
    await s.artifact(JSON.stringify({ fixture: true, index }), { kind: 'pr', round: 1, retrievedAt: at, provenance: 'local_fixture', status: 200 }); s.manifest.rounds.push({ number: 1, startedAt: at, finishedAt: at, coverage: {}, sources: [], notes: [], gaps: [], limitations: ['fixture'], current: true }); await s.save(); await s.close();
    const manifest = await readFile(join(snapshot, 'manifest.json')), verification = join(root, 'verification-' + index); await mkdir(verification, { mode: 0o700 }); await mkdir(join(verification, 'raw'), { mode: 0o700 });
    const blob = async (b: Buffer) => { const sha256 = hash(b), path = `raw/${sha256}.bin`; await writeFile(join(verification, path), b, { mode: 0o600 }); return { sha256, path, bytes: b.length }; };
    const argv = ['/fixture/runner'], output = await blob(Buffer.from('explicit fixture output')), plan = await blob(Buffer.from(JSON.stringify({ schemaVersion: 1, tools: [{ id: 'fixture', argv, timeoutMs: 1000 }] })));
    const stages = await Promise.all([0, 1].map(async i => ({ index: i, inputHead: i ? H : B, parent: B, head: i ? H : B, tree: i ? tree : baseTree, status: 'complete', gaps: [], comparisons: [], ...(i ? { mergeOutput: await blob(Buffer.from(tree + '\n')) } : {}), tools: [{ id: 'fixture', argv, status: 'completed', exitCode: 0, inputUnchanged: true, dependenciesUnchanged: true, gaps: [], stdout: output, stderr: output }] })));
    const report = { schemaVersion: 1, kind: 'tongxu-verification', id: `fixture-${index}`, repository: candidate.repository, targetRef: candidate.targetRef, startedAt: at, finishedAt: at, status: options.incomplete ? 'partial' : 'complete', executionComplete: !options.incomplete, comparisonComplete: null, observedSampleFailures: 0, businessCorrectness: 'unverified', dependencyHash: null, plan, planHash: plan.sha256, judgmentRefs: [], inputs: [{ candidate, manifestHash: hash(manifest), manifest: await blob(manifest), sourceGaps: [] }], stages, gaps: options.incomplete ? ['fixture_missing_evidence'] : [] };
    await writeFile(join(verification, 'verification.json'), JSON.stringify(report), { mode: 0o600 });
    const context = join(root, `context-${index}.json`); await writeFile(context, JSON.stringify({ schemaVersion: 1, scope: { id: 'scope', version: 'S1', source: 'fixture:scope' }, arrangement: { id: 'team', version: 'r1', source: 'fixture:arrangement' }, decisionKind: 'fact', requires: options.requires ?? [] }), { mode: 0o600 });
    const loaded = await readPacket(snapshot, verification, context);
    if (!options.incomplete) assert.equal(loaded.summary.evidenceComplete, true, JSON.stringify(loaded.summary));
    return q.import(loaded);
  }
  const item = await packet(), trace = join(root, 'trace.txt'), executable = join(root, 'claude-fixture.mjs'); await writeFile(trace, '');
  const code = `#!${process.execPath}
import fs from 'node:fs';
const trace=${JSON.stringify(trace)},mode=${JSON.stringify(mode)},emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(process.argv.includes('--version')){console.log('2.1.233 (Claude Code)');process.exit(0)}
if(process.argv.includes('auth')){setTimeout(()=>console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'})),mode==='auth-delay'?700:0)}
else{let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{const x=JSON.parse(text);fs.appendFileSync(trace,'model-dispatch\\n');
emit({type:'system',subtype:'init',session_id:'fixture-receiver',model:'fixture',claude_code_version:'2.1.233',permissionMode:'dontAsk',apiKeySource:'none',tools:[],mcp_servers:[]});
const j={schemaVersion:1,operation:x.binding.operation,judgmentId:x.binding.judgmentId,bindingHash:mode==='bad-binding'?'0'.repeat(64):x.bindingHash,verdict:'ACCEPT_WITHIN_SCOPE',report:'明确标注的模拟接收判断；没有真实模型或业务批准。',findings:[]};
setTimeout(()=>emit({type:'result',session_id:'fixture-receiver',subtype:'success',is_error:false,terminal_reason:mode==='aborted'?'aborted_streaming':'completed',stop_reason:'end_turn',result:JSON.stringify(j),usage:{},total_cost_usd:0}),mode==='delay'?900:0);
});}
`;
  await writeFile(executable, code, { mode: 0o700 }); const billing = join(root, 'billing.txt'); await writeFile(billing, 'Explicit test fixture billing; no actual authentication or model');
  const plan: ReceiverPlan = { schemaVersion: 1, kind: 'tongxu-queue-receiver', store, item: item.item, objects, sourcePaths: ['sample.js'], material: [], claudeExecutable: executable, billing: { mode: 'existing_subscription_only', evidence: billing, evidenceSha256: hash(await readFile(billing)), observedAt: new Date().toISOString(), usageCreditsEnabled: false }, timeoutMs: 3000, executionKind: 'fixture' };
  const path = join(root, 'plan.json'); await writeFile(path, JSON.stringify(plan), { mode: 0o600 });
  const count = async () => (await readFile(trace, 'utf8')).split('\n').filter(Boolean).length;
  return { root, q, store, item: item.item, plan, path, packet, trace, count };
}
async function waitPhase(q: QueueStore, phase: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const op = q.status().operations.find((o: any) => o.result?.receiver?.phase === phase); if (op) return op; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('fixture_phase_not_observed');
}

test('one entry sends fixed queued materials to a separate fixture process and records the same operation; repeat does not resend', async t => {
  const f = await setup(t); const result = await runReception(f.path);
  assert.equal(result.independentReception, 'fixture_judgment_recorded'); assert.equal(result.productionActionAllowed, false); assert.equal(result.receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE');
  assert.equal(await f.count(), 1); assert.equal(f.q.status().operations.length, 1); assert.equal(f.q.status().claims.length, 0);
  const packet = JSON.parse(await readFile(join(result.receiver.directory, 'binding-input.json'), 'utf8')); assert.equal(packet.binding.operation, result.operation); assert.ok(packet.data.sources[0].text.includes('explicit test fixture'));
  const before = await readFile(join(result.receiver.directory, 'claude/stdout.ndjson')); const again = await runReception(f.path); assert.equal(again.operation, result.operation); assert.equal(again.duplicate, true); assert.equal(await f.count(), 1); assert.deepEqual(await readFile(join(result.receiver.directory, 'claude/stdout.ndjson')), before);
});
test('existing shadow stores require explicit format enablement and cannot change format during an active operation', async t => {
  const f = await setup(t, 'no-enable'); await assert.rejects(runReception(f.path), /receiver_mode_not_enabled/); assert.equal(f.q.status().operations.length, 0);
  const op = f.q.begin(f.item, 'original-shadow'); assert.throws(() => f.q.enableReceiver(), /queue_has_active_or_unknown_operation/); f.q.evaluate(op.operation);
  assert.equal(f.q.enableReceiver().receiverEnabled, true); assert.equal(f.q.enableReceiver().duplicate, true); assert.equal((await runReception(f.path)).operation, op.operation); assert.equal(await f.count(), 1);
});
test('stopped investment, incomplete evidence and explicit missing dependencies do not launch a model', async t => {
  const f = await setup(t); f.q.control('scope', 'investment', 'stopped', 'fixture:stop'); assert.ok((await runReception(f.path)).blocked.includes('new_investment_stopped')); assert.equal(await f.count(), 0);
  f.q.control('scope', 'investment', 'open', 'fixture:resume'); await f.packet({ incomplete: true }); await assert.rejects(runReception(f.path), /receiver_current_material_unverified/); assert.equal(await f.count(), 0);
  const child = await f.packet({ pr: 2, requires: [{ item: 'a'.repeat(64), type: 'development', version: 'a'.repeat(40), blocks: 'shadow_review', source: 'fixture:dependency', canContinue: 'read only' }] });
  await writeFile(f.path, JSON.stringify({ ...f.plan, item: child.item })); assert.ok((await runReception(f.path)).blocked.some((x: string) => x.startsWith('missing_dependency:'))); assert.equal(await f.count(), 0);
});
test('final gate after auth preflight observes a newly stopped scope, retains the original and can close ended without retry', async t => {
  const f = await setup(t, 'auth-delay'), running = runReception(f.path), op = await waitPhase(f.q, 'reserved'); f.q.control('scope', 'investment', 'stopped', 'fixture:stop-during-preflight');
  const result = await running; assert.equal(result.status, 'receiver_unknown'); assert.equal(result.newTaskSent, false); assert.equal(await f.count(), 0); assert.equal(f.q.status().claims.length, 1);
  const closed = await reconcileReception(f.store, op.id, 'fixture:explicit-close-known-ended'); assert.equal(closed.independentReception, 'closed_without_judgment'); assert.equal(f.q.status().claims.length, 0);
  f.q.control('scope', 'investment', 'open', 'fixture:resume'); assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 0);
});
test('active receiver owns the target; duplicate, old evaluate and new competing target operation cannot take its claim', async t => {
  const f = await setup(t, 'delay'), running = runReception(f.path), op = await waitPhase(f.q, 'dispatch_registered');
  await assert.rejects(runReception(f.path), /receiver_controller_active/); assert.throws(() => f.q.evaluate(op.id), /original_receiver_pending/);
  const other = await f.packet({ pr: 2 }); assert.deepEqual(f.q.begin(other.item, 'fixture-competing').blocked, ['target_occupied_or_unknown']);
  await assert.rejects(reconcileReception(f.store, op.id, 'fixture:cannot-takeover'), /receiver_controller_active/);
  const done = await running; assert.equal(done.receiver.judgment.verdict, 'ACCEPT_WITHIN_SCOPE'); assert.equal(await f.count(), 1);
});
test('new material while receiver runs is not silently covered by its old candidate judgment', async t => {
  const f = await setup(t, 'delay'), running = runReception(f.path); await waitPhase(f.q, 'dispatch_registered'); await f.packet();
  const done = await running; assert.equal(done.receiver.currentMaterialMatches, false); assert.ok(done.gaps.includes('newer_material_requires_own_reception')); assert.equal(done.productionActionAllowed, false); assert.equal(await f.count(), 1);
});
test('SIGKILL after complete capture releases only the controller mutex; recovery consumes the original without another dispatch', { timeout: 10000 }, async t => {
  const f = await setup(t), script = join(f.root, 'interrupted-controller.mjs');
  await writeFile(script, `import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js', import.meta.url).href)};import {runReception} from ${JSON.stringify(new URL('../../src/receiver.js', import.meta.url).href)};QueueStore.prototype.finishReceiver=function(){process.kill(process.pid,'SIGSTOP');throw Error('fixture-stop-before-recording')};await runReception(${JSON.stringify(f.path)});`);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' }); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const op = await waitPhase(f.q, 'dispatch_registered'), dir = op.result.receiver.directory; let captured = false;
  for (let i = 0; i < 400; i++) { try { captured = JSON.parse(await readFile(join(dir, 'claude/capture-status.json'), 'utf8')).status === 'complete'; } catch {} if (captured) break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(captured, true); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(f.q.status().claims.length, 1); const trace = await readFile(f.trace);
  const recovered = await reconcileReception(f.store, op.id); assert.equal(recovered.independentReception, 'fixture_judgment_recorded'); assert.deepEqual(await readFile(f.trace), trace); assert.equal(f.q.status().claims.length, 0);
});
test('SIGKILL during capture cannot release an active original CLI or promote its partial result', { timeout: 10000 }, async t => {
  const f = await setup(t, 'delay'), cli = fileURLToPath(new URL('../../src/receiver-cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'run', '--plan', f.path], { stdio: 'ignore' }); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const op = await waitPhase(f.q, 'dispatch_registered'), stage = join(op.result.receiver.directory, 'claude');
  for (let i = 0; i < 200 && await f.count() === 0; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(await f.count(), 1);
  const pid = JSON.parse(await readFile(join(stage, 'process.json'), 'utf8')).pid; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await assert.rejects(reconcileReception(f.store, op.id, 'fixture:active-not-released'), /receiver_original_cli_active_or_unknown/);
  let ended = false; for (let i = 0; i < 300; i++) { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { ended = true; break; } } await new Promise(r => setTimeout(r, 10)); }
  assert.equal(ended, true); const raw = await readFile(join(stage, 'stdout.ndjson')); assert.equal((await reconcileReception(f.store, op.id)).status, 'receiver_unknown');
  assert.equal((await reconcileReception(f.store, op.id, 'fixture:close-confirmed-ended')).independentReception, 'closed_without_judgment'); assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 1); assert.deepEqual(await readFile(join(stage, 'stdout.ndjson')), raw);
});
for (const mode of ['bad-binding', 'aborted']) test(`fixture ${mode} cannot become a judgment or trigger a replacement`, async t => {
  const f = await setup(t, mode), r = await runReception(f.path); assert.equal(r.status, 'receiver_unknown'); assert.equal(await f.count(), 1);
  const restored = await reconcileReception(f.store, r.operation); assert.equal(restored.status, 'receiver_unknown'); assert.equal(await f.count(), 1);
  const closed = await reconcileReception(f.store, r.operation, 'fixture:close-ended-unresolved'); assert.equal(closed.independentReception, 'closed_without_judgment'); assert.equal(closed.receiver.judgment, null); assert.equal((await runReception(f.path)).duplicate, true); assert.equal(await f.count(), 1);
});
test('recovery binds full original stdin and tool policy even when stream hashes are rewritten; changed plan never resends', async t => {
  const f = await setup(t), r = await runReception(f.path), stage = join(r.receiver.directory, 'claude'), input = await readFile(join(stage, 'stdin.ndjson'));
  await writeFile(join(stage, 'stdin.ndjson'), Buffer.concat([input, Buffer.from('unregistered extra material')])); const capture = JSON.parse(await readFile(join(stage, 'capture-status.json'), 'utf8')); capture.files['stdin.ndjson'] = hash(await readFile(join(stage, 'stdin.ndjson'))); await writeFile(join(stage, 'capture-status.json'), JSON.stringify(capture));
  await assert.rejects(runReception(f.path), /receiver_original_input_or_tool_policy_changed/); assert.equal(await f.count(), 1);
  await writeFile(f.path, JSON.stringify({ ...f.plan, timeoutMs: 4000 })); await assert.rejects(runReception(f.path), /receiver_plan_changed/); assert.equal(await f.count(), 1);
});
