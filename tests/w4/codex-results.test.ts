import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importResult, parseCodexResult, prepareHandoff, validateBinding, RESULT_BYTES, type ResultBinding } from '../../src/codex-results.js';
import { hash } from '../../src/snapshot.js';

// Reuse the complete offline scenarios for each retained exact schema. These are
// synthetic frames, not native model evidence or rewritten native captures.
for (const version of ['0.159.2', '0.163.0-alpha.10.2'] as const) describe(version, () => {
const binding = (): ResultBinding => ({ schemaVersion: 1, protocol: `codex-app-server/${version}`, sourceKind: 'fixture', role: 'reviewer', run: 'fixture-run', sessionId: 'session-root', threadId: 'thread-root', turnIds: ['turn-one', 'turn-two'], workspace: '/fixture', scopeSource: 'fixture:scope', arrangementSource: 'fixture:arrangement', inputManifestSha256: '1'.repeat(64), promptSha256: '2'.repeat(64), candidate: { repository: 'fixture/repo', pr: 16, H: 'a'.repeat(40), B: 'b'.repeat(40), target: 'fixture-base' } });
const notify = (method: string, params: any) => ({ method, params });
const rootFrame = () => notify('thread/started', { thread: { id: 'thread-root', sessionId: 'session-root', cwd: '/fixture', source: 'appServer', cliVersion: version, createdAt: 1, updatedAt: 2, ephemeral: true, modelProvider: 'fixture', preview: '', projectId: null, status: { type: 'idle' }, turns: [] } });
const finalText = '独立结果全文\n结论不由解析器解释。🙂\n';
const finalItem = (id: string) => ({ id: id + '-answer', type: 'agentMessage', text: finalText + id, phase: 'final_answer' });
function turnFrames(id: string): any[] { const item = finalItem(id), origin = version === '0.159.2' ? {} : { rootTurnId: id }; return [notify('turn/started', { threadId: 'thread-root', turn: { id, ...origin, status: 'inProgress', items: [] } }), notify('item/completed', { threadId: 'thread-root', turnId: id, completedAtMs: 1000, item }), notify('turn/completed', { threadId: 'thread-root', turn: { id, ...origin, status: 'completed', items: [structuredClone(item)], itemsView: 'full', error: null } })]; }
const frames = () => [rootFrame(), ...turnFrames('turn-one'), ...turnFrames('turn-two')];
const encode = (x: any[]) => Buffer.from(x.map(v => JSON.stringify(v) + '\n').join(''));
const single = () => ({ ...binding(), turnIds: ['turn-one'] });
const singleFrames = () => [rootFrame(), ...turnFrames('turn-one')];
const exec = promisify(execFile), cli = fileURLToPath(new URL('../../src/codex-result-cli.js', import.meta.url));
async function dir(t: test.TestContext) { const d = await mkdtemp(join(tmpdir(), 'tongxu-codex-results-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }
async function inputs(d: string, raw = encode(frames()), b = binding()) { const input = join(d, 'input.ndjson'), bp = join(d, 'binding.json'); await writeFile(input, raw, { mode: 0o600 }); await writeFile(bp, JSON.stringify(b), { mode: 0o600 }); return { input, binding: bp }; }

// A real CLI success here establishes offline packet preparation only, never real model execution.
test('two explicitly registered ordered turns preserve exact top-level final text and fixture limits', () => {
  const result = parseCodexResult(encode(frames()), binding());
  assert.equal(result.status, 'final_observed'); assert.equal(result.handoffReady, true);
  assert.deepEqual(result.turns.map(t => t.final?.text), [finalText + 'turn-one', finalText + 'turn-two']);
  assert.equal(result.realModelExecutionVerified, false); assert.equal(result.toolRestrictionsVerified, false); assert.equal(result.productionActionAllowed, false);
  assert.equal(result.sourceAuthenticity, 'not_authenticated_by_parser'); assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.turns.map(t => t.rootTurnId), version === '0.159.2' ? [undefined, undefined] : ['turn-one', 'turn-two']);
  for (const source of ['cli', 'vscode', 'exec', 'appServer']) { const f = frames(); f[0].params.thread.source = source; assert.equal(parseCodexResult(encode(f), binding()).status, 'final_observed'); }
});

test('child-thread PASS, commentary, null/absent phase and RPC replies cannot become final', () => {
  for (const phase of ['commentary', 'partial_answer', null, undefined, 'unknown']) {
    const f = singleFrames(); f[2].params.item.phase = phase; f[3].params.turn.items[0].phase = phase;
    f.splice(3, 0, notify('item/completed', { threadId: 'child', turnId: 'turn-one', completedAtMs: 1, item: finalItem('child') }), { id: 99, result: { text: 'PASS' } });
    const result = parseCodexResult(encode(f), single()); assert.equal(result.handoffReady, false); assert.equal(result.turns[0]!.final, null);
  }
});

test('binding/session/source/version/turn order mistakes and extra root turns block handoff', () => {
  const cases: Array<(f: any[]) => void> = [
    f => { f[0].params.thread.sessionId = 'wrong'; }, f => { f[0].params.thread.id = 'wrong'; },
    f => { f[0].params.thread.cwd = '/other'; }, f => { f[0].params.thread.source = { subAgent: 'review' }; },
    f => { f[0].params.thread.source = 'unknown'; }, f => { f[0].params.thread.source = { custom: 'appServer' }; },
    f => { f[0].params.thread.forkedFromId = 'ancestor'; }, f => { f[0].params.thread.parentThreadId = 'parent'; },
    f => { f[0].params.thread.cliVersion = '0.160.0'; }, f => { f.unshift(...f.splice(1, 3)); },
    f => { f.splice(1, 6, ...turnFrames('turn-two'), ...turnFrames('turn-one')); },
    f => { f.push(...turnFrames('unregistered')); }, f => { f[2].params.turnId = 'wrong'; },
    f => { f[3].params.threadId = 'different'; }, f => { f.splice(2, 0, { id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-root' } }); }
  ];
  for (const mutate of cases) { const f = frames(); mutate(f); assert.equal(parseCodexResult(encode(f), binding()).handoffReady, false); }
  const crossed = frames(); crossed[0].params.thread.cliVersion = version === '0.159.2' ? '0.163.0-alpha.10.2' : '0.159.2';
  assert.ok(parseCodexResult(encode(crossed), binding()).gaps.includes('root_session_binding_mismatch'));
});

test('duplicate frames are idempotent; contradictions, missing full final and late errors fail closed', () => {
  const good = singleFrames(); good.splice(3, 0, structuredClone(good[2])); good.push(structuredClone(good.at(-1)));
  assert.equal(parseCodexResult(encode(good), single()).status, 'final_observed');
  const cases: Array<(f: any[]) => void> = [
    f => { const other = structuredClone(f[2]); other.params.item.text = 'different'; f.splice(3, 0, other); },
    f => { const other = structuredClone(f[3]); other.params.turn.status = 'failed'; f.push(other); },
    f => { f[3].params.turn.items[0].phase = 'commentary'; }, f => { f[3].params.turn.items = []; },
    f => { f[3].params.turn.error = 'invalid'; }, f => { f[3].params.turn.itemsView = 'invented'; },
    f => { f.push(notify('error', { threadId: 'thread-root', turnId: 'turn-one', willRetry: false, error: { message: 'late fatal', codexErrorInfo: 'usageLimitExceeded' } })); },
    f => { f[2].params.item.delivery = 'async'; }, f => { f[2].params.item.questions = [{ id: 'wait' }]; },
    f => { const extra = structuredClone(f[2]); extra.params.item.id = 'other-final'; f.splice(3, 0, extra); }
  ];
  for (const mutate of cases) { const f = singleFrames(); mutate(f); assert.equal(parseCodexResult(encode(f), single()).status, 'unknown'); }
});

test('quota/error, interruption and actual waiting are retained without inventing a final result', () => {
  for (const status of ['failed', 'interrupted']) {
    const f = singleFrames(); f.splice(2, 1); f[2].params.turn.status = status; f[2].params.turn.items = []; f[2].params.turn.error = { message: 'quota detail', codexErrorInfo: 'usageLimitExceeded' };
    const r = parseCodexResult(encode(f), single()); assert.equal(r.status, status); assert.equal(r.handoffReady, false); assert.equal(r.turns[0]!.errors[0].codexErrorInfo, 'usageLimitExceeded');
  }
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    const f = singleFrames().slice(0, 2); f.push(notify('thread/status/changed', { threadId: 'thread-root', status: { type: 'active', activeFlags: [flag] } }));
    const r = parseCodexResult(encode(f), single()); assert.equal(r.status, 'waiting'); assert.deepEqual(r.waiting, [flag]); assert.equal(r.handoffReady, false);
  }
  const f = singleFrames(); f.splice(2, 0, notify('error', { threadId: 'thread-root', turnId: 'turn-one', willRetry: true, error: { message: 'transient', codexErrorInfo: 'rateLimitExceeded' } }));
  assert.equal(parseCodexResult(encode(f), single()).status, 'final_observed');
  f[2].params.willRetry = false; assert.equal(parseCodexResult(encode(f), single()).handoffReady, false);
});

test('terminal retyping of the same final ID cannot export the earlier answer', async t => {
  const d = await dir(t);
  for (const type of ['userMessage', 'plan', 'missing_type']) for (const duplicate of [false, true]) {
    const f = singleFrames(), id = f[2].params.item.id;
    const replacement = type === 'userMessage' ? { id, type, content: [] } : { id, type: type === 'missing_type' ? undefined : type, text: 'different semantic item' };
    f[3].params.turn.items = [...(duplicate ? [structuredClone(f[2].params.item)] : []), replacement];
    const io = await inputs(d, encode(f), single()), output = join(d, type + '-' + duplicate), handoff = output + '-handoff';
    await assert.rejects(exec(process.execPath, [cli, 'import', '--binding', io.binding, '--input', io.input, '--output', output]), (e: any) => e.code === 2 && JSON.parse(e.stdout).gaps.includes('terminal_items_disagree_with_final'));
    await assert.rejects(exec(process.execPath, [cli, 'handoff', '--packet', output, '--output', handoff]), (e: any) => e.code === 1 && JSON.parse(e.stderr).error === 'codex_result_not_ready_for_impact_input');
    await assert.rejects(lstat(handoff), { code: 'ENOENT' });
  }
});

test('malformed/truncated/oversized UTF-8 frames and metadata-only probes never pass', () => {
  const good = encode(frames());
  for (const raw of [good.subarray(0, -1), Buffer.concat([good, Buffer.from('bad\n')]), Buffer.concat([good, Buffer.from([0xff, 10])]), Buffer.concat([good, Buffer.from('x'.repeat(1024 * 1024 + 1) + '\n')])]) assert.equal(parseCodexResult(raw, binding()).handoffReady, false);
  assert.throws(() => parseCodexResult(Buffer.alloc(RESULT_BYTES + 1), binding()), /result_input_limit/);
  const probe = parseCodexResult(encode([rootFrame()]), { ...binding(), role: 'protocol_probe', turnIds: [], sourceKind: 'native_capture' });
  assert.equal(probe.status, 'unknown'); assert.ok(probe.gaps.includes('no_model_turn_registered')); assert.equal(probe.realModelExecutionVerified, false);
});

test('binding rejects missing scope, candidate, prompt identity and invalid expected turns', () => {
  for (const patch of [{ protocol: 'codex-app-server/0.164.0' }, { protocol: '__proto__' }, { scopeSource: '' }, { arrangementSource: '' }, { promptSha256: 'missing' }, { turnIds: [] }, { turnIds: ['same', 'same'] }, { workspace: '/foo/../bar' }, { candidate: { ...binding().candidate, H: 'main' } }]) assert.throws(() => validateBinding({ ...binding(), ...patch }));
});

if (version === '0.163.0-alpha.10.2') test('new nullable turn origins and open error values preserve identity without promoting unknown phases', () => {
  for (const origin of [null, undefined, 'originating-turn']) {
    const f = singleFrames(); f[1].params.turn.rootTurnId = origin; f[3].params.turn.rootTurnId = origin;
    const r = parseCodexResult(encode(f), single()); assert.equal(r.status, 'final_observed'); assert.equal(r.turns[0]!.rootTurnId, origin ?? null);
  }
  for (const [start, end, gap] of [[42, 'turn-one', 'invalid_turn_root_id'], ['turn-one', {}, 'invalid_turn_root_id'], ['turn-one', 'other-origin', 'conflicting_turn_root_id']] as const) {
    const f = singleFrames(); f[1].params.turn.rootTurnId = start; f[3].params.turn.rootTurnId = end;
    const r = parseCodexResult(encode(f), single()); assert.equal(r.status, 'unknown'); assert.ok(r.gaps.includes(gap));
  }
  for (const error of ['futureProviderError', { futureProviderError: { reason: 'retained verbatim', retryAfter: 7 } }]) {
    const f = singleFrames().slice(0, 2);
    f.push(notify('error', { threadId: 'thread-root', turnId: 'turn-one', willRetry: false, error: { message: 'original error text', codexErrorInfo: error } }));
    f.push(notify('turn/completed', { threadId: 'thread-root', turn: { id: 'turn-one', rootTurnId: 'turn-one', status: 'failed', items: [], error: { message: 'original error text', codexErrorInfo: error } } }));
    const r = parseCodexResult(encode(f), single()); assert.equal(r.status, 'failed'); assert.equal(r.handoffReady, false); assert.deepEqual(r.turns[0]!.errors[0].codexErrorInfo, error);
  }
});

test('CLI partial import, append, replay and handoff preserve originals and prepare exact input without sending', async t => {
  const d = await dir(t), all = encode(frames()), split = all.indexOf(Buffer.from('独立')) + 1;
  const io = await inputs(d, all.subarray(0, split)), initial = join(d, 'initial');
  await assert.rejects(exec(process.execPath, [cli, 'import', '--binding', io.binding, '--input', io.input, '--output', initial]), (e: any) => e.code === 2 && JSON.parse(e.stdout).status === 'unknown');
  const before = await readFile(join(initial, 'raw.ndjson')), checkpoint = await readFile(join(initial, 'capture.json'));
  await writeFile(io.input, all); const appended = join(d, 'appended');
  const summary = JSON.parse((await exec(process.execPath, [cli, 'append', '--packet', initial, '--input', io.input, '--output', appended])).stdout);
  assert.equal(summary.status, 'final_observed'); assert.equal(summary.sourceKind, 'fixture'); assert.equal(summary.realModelExecutionVerified, false);
  assert.equal(JSON.stringify(summary).includes(finalText), false); assert.equal(JSON.stringify(summary).includes('session-root'), false);
  const c = JSON.parse(await readFile(join(appended, 'capture.json'), 'utf8'));
  assert.equal(c.captureId, JSON.parse(checkpoint.toString()).captureId); assert.equal(c.previousCheckpointSha256, hash(checkpoint));
  await rm(join(appended, 'result.json')); // Simulated loss of derived state; checkpoint + raw remain authoritative.
  const replay = join(d, 'replay'); await exec(process.execPath, [cli, 'replay', '--packet', appended, '--output', replay]);
  const handoff = join(d, 'handoff'); await exec(process.execPath, [cli, 'handoff', '--packet', replay, '--output', handoff]);
  const input = JSON.parse(await readFile(join(handoff, 'input.json'), 'utf8'));
  assert.equal(input.delivery, 'not_sent'); assert.equal(input.role, 'verifier_impact'); assert.equal(input.sourceKind, 'fixture'); assert.deepEqual(input.finalAnswers.map((a: any) => a.text), [finalText + 'turn-one', finalText + 'turn-two']);
  for (const e of input.evidence) assert.equal(hash(await readFile(join(handoff, e.path))), e.sha256);
  assert.deepEqual(await readFile(join(initial, 'raw.ndjson')), before); assert.deepEqual(await readFile(join(initial, 'capture.json')), checkpoint);
  assert.equal((await lstat(handoff)).mode & 0o077, 0); assert.equal((await lstat(join(handoff, 'input.json'))).mode & 0o077, 0);
  await assert.rejects(prepareHandoff(replay, handoff), /EEXIST/);
});

test('altered raw, binding, continuation, derived PASS and source candidate cannot replace an original run', async t => {
  const d = await dir(t), io = await inputs(d, encode(frames().slice(0, 2))), output = join(d, 'partial');
  await importResult({ ...io, output });
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'final_observed', handoffReady: true }));
  await assert.rejects(prepareHandoff(output, join(d, 'forged')), /not_ready/);
  await writeFile(io.input, encode(frames()).subarray(1));
  await assert.rejects(importResult({ previous: output, input: io.input, output: join(d, 'changed-prefix') }), /append_original_bytes/);
  await assert.rejects(importResult({ previous: output, binding: io.binding, input: io.input, output: join(d, 'new-binding') }), /invalid_result_operation/);
  await writeFile(join(output, 'binding.json'), JSON.stringify({ ...binding(), candidate: { ...binding().candidate, H: 'c'.repeat(40) } }));
  await assert.rejects(importResult({ previous: output, replay: true, output: join(d, 'tampered') }), /capture_integrity_failed/);
  const fresh = join(d, 'fresh'); await writeFile(io.input, encode(frames())); await importResult({ ...io, output: fresh });
  await writeFile(join(fresh, 'raw.ndjson'), Buffer.from('changed\n'));
  await assert.rejects(prepareHandoff(fresh, join(d, 'tampered-raw')), /capture_integrity_failed/);
});

test('new candidate creates a separate capture and no existing packet or symlink path is overwritten', async t => {
  const d = await dir(t), io = await inputs(d), output = join(d, 'first'), first = await importResult({ ...io, output });
  await assert.rejects(importResult({ ...io, output }), /EEXIST/);
  await writeFile(io.binding, JSON.stringify({ ...binding(), candidate: { ...binding().candidate, H: 'c'.repeat(40) } }));
  const second = await importResult({ ...io, output: join(d, 'second') }); assert.notEqual(second.captureId, first.captureId);
  assert.equal(JSON.parse(await readFile(join(output, 'binding.json'), 'utf8')).candidate.H, 'a'.repeat(40));
  const linked = join(d, 'link'); await symlink(io.input, linked);
  await assert.rejects(importResult({ ...io, input: linked, output: join(d, 'symlink-input') }), /invalid_result_input_path/);
  const linkedDir = join(d, 'linked-directory'); await symlink(output, linkedDir);
  await assert.rejects(importResult({ previous: linkedDir, replay: true, output: join(d, 'symlink-packet') }), /symlink/);
});

test('SIGKILL after checkpoint publication can replay the same capture without executing any CLI model turn', { timeout: 20_000 }, async t => {
  const d = await dir(t), raw = Buffer.concat([encode(frames()), Buffer.from((JSON.stringify({ method: 'fixture/ignored', params: {} }) + '\n').repeat(150_000))]);
  const io = await inputs(d, raw), output = join(d, 'killed'), child = spawn(process.execPath, [cli, 'import', '--binding', io.binding, '--input', io.input, '--output', output], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume(); const exited = once(child, 'exit');
  try {
    let saved: Buffer | undefined; const deadline = Date.now() + 5000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try { const b = await readFile(join(output, 'capture.json')); JSON.parse(b.toString()); saved = b; break; } catch { await new Promise(resolve => setTimeout(resolve, 1)); }
    }
    assert.ok(saved, 'checkpoint must be observed while parsing is still running'); child.kill('SIGKILL'); const exit = await exited; assert.equal(exit[1], 'SIGKILL');
    const result = await importResult({ previous: output, replay: true, output: join(d, 'recovered') });
    assert.equal(result.captureId, JSON.parse(saved.toString()).captureId); assert.equal(result.status, 'final_observed'); assert.equal(result.realModelExecutionVerified, false);
    assert.deepEqual(await readFile(join(output, 'capture.json')), saved);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
});
