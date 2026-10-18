import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Snapshot, hash } from '../../src/snapshot.js';
import { verify, parseVerifyArgs, parsePlan } from '../../src/verification.js';
import { samples, compare } from '../../src/comparison.js';
const exec = promisify(execFile);

async function fixture(t: test.TestContext, condition = 'data.unit === consumer.unit') {
  const root = await mkdtemp(join(tmpdir(), 'tongxu-w2-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await writeFile(join(repo, 'data.json'), '{"unit":1}\n'); await writeFile(join(repo, 'consumer.json'), '{"unit":1}\n');
  await writeFile(join(repo, 'check.cjs'), `const fs=require('node:fs'),cp=require('node:child_process');const data=JSON.parse(fs.readFileSync('data.json')),consumer=JSON.parse(fs.readFileSync('consumer.json'));const ok=${condition};const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const tree=cp.execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();console.log(JSON.stringify({head,tree}));fs.writeFileSync(process.env.TONGXU_RESULT_FILE,JSON.stringify({samples:[{id:'business',status:ok?'ok':'fail',content:{data,consumer},identity:'fixture',source:'fixture:units',sideEffects:[]}]}));\n`);
  await git('add', '.'); await git('commit', '-m', 'base'); const B = await git('rev-parse', 'HEAD');
  let n = 0;
  const bundle = async (H: string, base = B) => {
    const path = join(root, `bundle-${++n}`); const s = await Snapshot.create(path, 'example/project', n, [], []);
    s.manifest.candidate = { repository: 'example/project', pr: n, H, B: base, targetRef: 'main', mergeBase: base, observedAt: 'fixture' };
    s.manifest.rounds.push({ number: 1, startedAt: 'fixture', finishedAt: 'fixture', coverage: {}, sources: [], notes: [], gaps: [], limitations: ['fixture'], current: true });
    await s.save(); await s.close(); return path;
  };
  const branch = async (name: string, file: string, content: string, from = B) => {
    await git('switch', '-c', name, from); await writeFile(join(repo, file), content); await git('add', '.'); await git('commit', '-m', name); return git('rev-parse', 'HEAD');
  };
  const planPath = join(root, 'plan.json');
  const tools = [{ id: 'check', argv: [process.execPath, 'check.cjs'], timeoutMs: 5000, expectedSampleIds: ['business'] }];
  await writeFile(planPath, JSON.stringify({ schemaVersion: 1, tools }));
  return { root, repo, git, B, bundle, branch, planPath, tools };
}

test('seven comparison classes preserve status/content/identity/source/side effects and unknown', () => {
  const row = { id: 'one', status: 'ok', content: { a: 1, b: 2 }, identity: 'USD', source: 'v1', sideEffects: [] };
  const set = (r: any) => samples({ samples: [r] }, ['one'], true);
  assert.equal(compare(set(row), set({ ...row, content: { b: 2, a: 1 } }), ['one'])[0]?.result, 'SAME_OK');
  for (const [field, value] of [['content', 2], ['identity', 'CNY'], ['source', 'v2'], ['sideEffects', ['write']]]) assert.equal(compare(set(row), set({ ...row, [field as string]: value }), ['one'])[0]?.result, 'CHANGED_OK');
  const fail = { ...row, status: 'fail' };
  assert.equal(compare(set(fail), set(row), ['one'])[0]?.result, 'FAIL_TO_OK');
  assert.equal(compare(set(row), set(fail), ['one'])[0]?.result, 'OK_TO_FAIL');
  assert.equal(compare(set(fail), set(fail), ['one'])[0]?.result, 'SAME_FAIL');
  assert.equal(compare(set(fail), set({ ...fail, content: 'new rejection' }), ['one'])[0]?.result, 'CHANGED_FAIL');
  for (const input of [{ samples: [] }, { samples: [row, row] }, { samples: [{ ...row, source: '' }] }, { samples: [{ ...row, id: 'unexpected' }] }]) assert.equal(compare(set(row), samples(input, ['one'], true), ['one'])[0]?.result, 'NOT_COMPARED');
  assert.equal(compare(set(row), samples({ samples: [row] }, ['one'], false), ['one'])[0]?.result, 'NOT_COMPARED');
});

test('real verify creates matching T/HEAD in a private checkout and preserves dirty author state', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const H = await f.branch('change', 'new.txt', 'feature\n'); const input = await f.bundle(H);
  await writeFile(join(f.repo, 'data.json'), 'author dirty content\n');
  const index = hash(await readFile(join(f.repo, '.git/index'))); const head = await f.git('rev-parse', 'HEAD');
  const r = await verify({ snapshots: [input], objects: f.repo, plan: f.planPath, output: join(f.root, 'result') });
  assert.equal(r.exit, 0); assert.equal(r.report.stages.length, 2); assert.equal(r.report.executionComplete, true); assert.equal(r.report.comparisonComplete, true); assert.equal(r.report.businessCorrectness, 'unverified');
  for (const stage of r.report.stages) {
    const actual = JSON.parse(await readFile(join(f.root, 'result', stage.tools[0]!.stdout!.path), 'utf8'));
    assert.equal(actual.head, stage.head); assert.equal(actual.tree, stage.tree);
    assert.ok(stage.tools[0]?.pid); assert.equal(stage.tools[0]?.inputUnchanged, true);
  }
  assert.equal(hash(await readFile(join(f.repo, '.git/index'))), index); assert.equal(await f.git('rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(f.repo, 'data.json'), 'utf8'), 'author dirty content\n');
  await assert.rejects(() => verify({ snapshots: [input], objects: f.repo, plan: f.planPath, output: join(f.root, 'result') }), { code: 'EEXIST' });
});

test('disjoint locally passing changes expose a semantic failure only in combination', { timeout: 40_000 }, async t => {
  const f = await fixture(t, 'data.unit * consumer.unit <= 2');
  const A = await f.branch('A', 'data.json', '{"unit":2}\n');
  const B = await f.branch('B', 'consumer.json', '{"unit":2}\n');
  const a = await f.bundle(A), b = await f.bundle(B);
  assert.equal((await verify({ snapshots: [a], objects: f.repo, plan: f.planPath, output: join(f.root, 'only-a') })).exit, 0);
  assert.equal((await verify({ snapshots: [b], objects: f.repo, plan: f.planPath, output: join(f.root, 'only-b') })).exit, 0);
  const combined = await verify({ snapshots: [a, b], objects: f.repo, plan: f.planPath, output: join(f.root, 'combined') });
  assert.equal(combined.exit, 2); assert.equal(combined.report.stages.length, 3); assert.equal(combined.report.observedSampleFailures, 1);
  assert.equal(combined.report.comparisonComplete, true); assert.equal(combined.report.stages[2]!.comparisons[0]!.results[0]!.result, 'OK_TO_FAIL');
});

test('minimum combination preserves failing intermediate evidence even when final samples recover', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const A = await f.branch('A', 'data.json', '{"unit":2}\n'); const B = await f.branch('B', 'consumer.json', '{"unit":2}\n');
  const r = await verify({ snapshots: [await f.bundle(A), await f.bundle(B)], objects: f.repo, plan: f.planPath, output: join(f.root, 'combined') });
  assert.equal(r.exit, 2); assert.equal(r.report.stages[1]!.tools[0]!.sampleSet!.samples[0]!.status, 'fail');
  assert.equal(r.report.stages[2]!.comparisons[0]!.results[0]!.result, 'FAIL_TO_OK'); assert.equal(r.report.stages[2]!.tools[0]!.sampleSet!.samples[0]!.status, 'ok');
});

test('text conflict records evidence and never invents a tested tree', { timeout: 25_000 }, async t => {
  const f = await fixture(t); const A = await f.branch('A', 'data.json', '{"unit":2}\n'); const B = await f.branch('B', 'data.json', '{"unit":3}\n');
  const r = await verify({ snapshots: [await f.bundle(A), await f.bundle(B)], objects: f.repo, plan: f.planPath, output: join(f.root, 'conflict') });
  assert.equal(r.exit, 2); assert.equal(r.report.stages[2]!.status, 'blocked'); assert.equal(r.report.stages[2]!.tree, null); assert.ok(r.report.stages[2]!.mergeOutput); assert.equal(r.report.stages[2]!.tools.length, 0);
});

test('one tool changing tracked input prevents later green tools from claiming the original T', { timeout: 25_000 }, async t => {
  const f = await fixture(t); const H = await f.branch('A', 'new.txt', 'feature\n');
  await writeFile(f.planPath, JSON.stringify({ schemaVersion: 1, tools: [{ id: 'mutate', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('data.json','changed')"], timeoutMs: 2000 }, ...f.tools] }));
  const r = await verify({ snapshots: [await f.bundle(H)], objects: f.repo, plan: f.planPath, output: join(f.root, 'mutated') });
  assert.equal(r.exit, 2);
  for (const s of r.report.stages) { assert.equal(s.tools.length, 1); assert.equal(s.tools[0]!.inputUnchanged, false); assert.ok(s.gaps.includes('remaining_tools_not_run')); }
});

test('preexisting complete JSON is not a result from a no-op current tool', { timeout: 25_000 }, async t => {
  const f = await fixture(t); const H = await f.branch('old-result', 'result.json', JSON.stringify({ samples: [{ id: 'business', status: 'ok', content: 1, identity: 'fixture', source: 'old', sideEffects: [] }] }));
  await writeFile(f.planPath, JSON.stringify({ schemaVersion: 1, tools: [{ id: 'noop', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 2000, expectedSampleIds: ['business'] }] }));
  const r = await verify({ snapshots: [await f.bundle(H)], objects: f.repo, plan: f.planPath, output: join(f.root, 'stale') });
  assert.equal(r.exit, 2); assert.equal(r.report.comparisonComplete, false);
  assert.ok(r.report.stages[1]!.tools[0]!.gaps.includes('missing_or_invalid_fresh_result')); assert.equal(r.report.stages[1]!.comparisons[0]!.results[0]!.result, 'NOT_COMPARED');
});

test('snapshot corruption and invalid command plans fail before creating execution output', async t => {
  const f = await fixture(t); const H = await f.branch('A', 'new.txt', 'feature\n'); const bundle = await f.bundle(H);
  const m = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')); m.candidate.H = 'moving-branch'; await writeFile(join(bundle, 'manifest.json'), JSON.stringify(m));
  await assert.rejects(() => verify({ snapshots: [bundle], objects: f.repo, plan: f.planPath, output: join(f.root, 'bad') }), /invalid_source_candidate/);
  assert.throws(() => parseVerifyArgs(['--snapshot', '/tmp/a', '--objects', '/tmp/b', '--plan', '/tmp/c', '--output', '/tmp/out', '--shell', 'echo']), /invalid/);
  assert.throws(() => parsePlan({ schemaVersion: 1, tools: [{ id: 'x', argv: ['/bin/sh', '-c', 'echo'], timeoutMs: 1000 }] }), /invalid_registered_tool/);
  assert.throws(() => parsePlan({ schemaVersion: 1, tools: [] }), /invalid_test_plan/);
});

test('A1 then dependent B1 then A2 keeps all fixed prefixes and declared bases', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 'data.unit * consumer.unit <= 4');
  const A1 = await f.branch('A1', 'data.json', '{"unit":2}\n');
  const B1 = await f.branch('B1', 'consumer.json', '{"unit":2}\n', A1);
  const A2 = await f.branch('A2', 'entry.txt', 'consumer ready\n', A1);
  const r = await verify({ snapshots: [await f.bundle(A1), await f.bundle(B1, A1), await f.bundle(A2, A1)], objects: f.repo, plan: f.planPath, output: join(f.root, 'sequence') });
  assert.equal(r.exit, 0); assert.equal(r.report.stages.length, 4);
  assert.deepEqual(r.report.stages.map(s => s.inputHead), [f.B, A1, B1, A2]);
  for (let i = 1; i < r.report.stages.length; i++) assert.equal(r.report.stages[i]!.parent, r.report.stages[i - 1]!.head);
  assert.equal(await readFile(join(f.root, 'sequence/stage-3/data.json'), 'utf8'), '{"unit":2}\n');
  assert.equal(await readFile(join(f.root, 'sequence/stage-3/consumer.json'), 'utf8'), '{"unit":2}\n');
});

test('missing fixed Git objects preserve original failure output without running tools', async t => {
  const f = await fixture(t);
  const r = await verify({ snapshots: [await f.bundle('a'.repeat(40))], objects: f.repo, plan: f.planPath, output: join(f.root, 'missing') });
  assert.equal(r.exit, 2); assert.equal(r.report.executionComplete, false); assert.equal(r.report.stages.length, 0);
  assert.ok(r.report.failureOutput?.stderr.bytes); assert.equal(r.report.inputs[0]!.candidate.H, 'a'.repeat(40));
});

test('killed production verify retains running state and operation reference without overwriting on rerun', { timeout: 20_000 }, async t => {
  const f = await fixture(t); const H = await f.branch('A', 'new.txt', 'feature\n'); const bundle = await f.bundle(H);
  await writeFile(f.planPath, JSON.stringify({ schemaVersion: 1, tools: [{ id: 'wait', argv: [process.execPath, '-e', 'setInterval(()=>{},100)'], timeoutMs: 10000 }] }));
  const output = join(f.root, 'interrupted');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/cli.js', import.meta.url)), 'verify', '--snapshot', bundle, '--objects', f.repo, '--plan', f.planPath, '--output', output], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  let running: any;
  for (let i = 0; i < 400; i++) {
    try { running = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')); } catch { /* initial write */ }
    if (running?.stages[0]?.tools[0]?.pid) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(running?.stages[0]?.tools[0]?.pid); const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  const bytes = await readFile(join(output, 'verification.json'));
  const saved = JSON.parse(bytes.toString()); assert.equal(saved.status, 'running'); assert.equal(saved.finishedAt, undefined);
  assert.equal(saved.stages[0].tools[0].status, 'running'); assert.equal(saved.executionComplete, false);
  await assert.rejects(() => verify({ snapshots: [bundle], objects: f.repo, plan: f.planPath, output }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(output, 'verification.json')), bytes);
});
