import type test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Snapshot, hash } from '../../src/snapshot.js';
import { QueueStore } from '../../src/queue-store.js';
import { readPacket } from '../../src/queue-evidence.js';
import type { ReceiverPlan } from '../../src/receiver.js';

export async function setup(t: test.TestContext, mode = 'complete', seats = 1, cleanup = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'tongxu-receiver-fixture-')); if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  const objects = join(root, 'objects'); await mkdir(objects); const git = (args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: objects, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--initial-branch=fixture']); await writeFile(join(objects, 'sample.js'), '// explicit test fixture; no real model\nexport const value=1;\n'); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture']);
  const B = git(['rev-parse', 'HEAD']), baseTree = git(['rev-parse', 'HEAD^{tree}']);
  await writeFile(join(objects, 'sample.js'), '// explicit test fixture; no real model\nexport const value=2;\n'); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture candidate']);
  const H = git(['rev-parse', 'HEAD']);
  const store = join(root, 'queue'), q = await QueueStore.create(store, 'fixture/reception', seats); if (mode !== 'no-enable') q.enableReceiver(); t.after(() => q.close()); let index = 0;
  async function packet(options: { incomplete?: boolean; target?: string; pr?: number; requires?: any[]; H?: string; sourceAt?: string; executionAt?: string; scopeId?: string; scopeVersion?: string; arrangementVersion?: string; artifactIndex?: number } = {}) {
    ++index;
    const at = options.executionAt ?? new Date(Date.parse('2026-10-19T00:00:00Z') + index * 2000).toISOString(), pr = options.pr ?? 1;
    const selectedH = options.H ?? H, selectedTree = git(['rev-parse', `${selectedH}^{tree}`]);
    const candidate = { repository: 'fixture/reception', pr, H: selectedH, B, mergeBase: B, targetRef: options.target ?? 'fixture', observedAt: options.sourceAt ?? at };
    const snapshot = join(root, 'snapshot-' + index), s = await Snapshot.create(snapshot, candidate.repository, pr, [], []); s.manifest.candidate = candidate;
    await s.artifact(JSON.stringify({ fixture: true, index: options.artifactIndex ?? index }), { kind: 'pr', round: 1, retrievedAt: at, provenance: 'local_fixture', status: 200 }); s.manifest.rounds.push({ number: 1, startedAt: at, finishedAt: at, coverage: {}, sources: [], notes: [], gaps: [], limitations: ['fixture'], current: true }); await s.save(); await s.close();
    const manifest = await readFile(join(snapshot, 'manifest.json')), verification = join(root, 'verification-' + index); await mkdir(verification, { mode: 0o700 }); await mkdir(join(verification, 'raw'), { mode: 0o700 });
    const blob = async (b: Buffer) => { const sha256 = hash(b), path = `raw/${sha256}.bin`; await writeFile(join(verification, path), b, { mode: 0o600 }); return { sha256, path, bytes: b.length }; };
    const argv = ['/fixture/runner'], output = await blob(Buffer.from('explicit fixture output')), plan = await blob(Buffer.from(JSON.stringify({ schemaVersion: 1, tools: [{ id: 'fixture', argv, timeoutMs: 1000 }] })));
    const stages = await Promise.all([0, 1].map(async i => ({ index: i, inputHead: i ? selectedH : B, parent: B, head: i ? selectedH : B, tree: i ? selectedTree : baseTree, status: 'complete', gaps: [], comparisons: [], ...(i ? { mergeOutput: await blob(Buffer.from(selectedTree + '\n')) } : {}), tools: [{ id: 'fixture', argv, status: 'completed', exitCode: 0, inputUnchanged: true, dependenciesUnchanged: true, gaps: [], stdout: output, stderr: output }] })));
    const report = { schemaVersion: 1, kind: 'tongxu-verification', id: `fixture-${index}`, repository: candidate.repository, targetRef: candidate.targetRef, startedAt: at, finishedAt: at, status: options.incomplete ? 'partial' : 'complete', executionComplete: !options.incomplete, comparisonComplete: null, observedSampleFailures: 0, businessCorrectness: 'unverified', dependencyHash: null, plan, planHash: plan.sha256, judgmentRefs: [], inputs: [{ candidate, manifestHash: hash(manifest), manifest: await blob(manifest), sourceGaps: [] }], stages, gaps: options.incomplete ? ['fixture_missing_evidence'] : [] };
    await writeFile(join(verification, 'verification.json'), JSON.stringify(report), { mode: 0o600 });
    const context = join(root, `context-${index}.json`); await writeFile(context, JSON.stringify({ schemaVersion: 1, scope: { id: options.scopeId ?? 'scope', version: options.scopeVersion ?? 'S1', source: 'fixture:scope' }, arrangement: { id: 'team', version: options.arrangementVersion ?? 'r1', source: 'fixture:arrangement' }, decisionKind: 'fact', requires: options.requires ?? [] }), { mode: 0o600 });
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
const missing=mode==='budget-then-invalid'&&(x.data.evidence.supplements?.length??0)<2||mode==='always-insufficient'||mode==='insufficient'&&!x.data.evidence.supplements?.length;
const contradict=mode==='budget-then-invalid'&&x.data.evidence.supplements?.length===2||mode==='always-contradictory'||['contradictory','correction-delay'].includes(mode)&&!x.data.evidence.correction;
const j={schemaVersion:x.responseShape.schemaVersion,...(x.binding.memberRefutationSha256&&mode!=='ignore-refutation'?{consumedMemberRefutation:x.binding.memberRefutationSha256}:{}),...(x.binding.integrationSha256?{consumedIntegration:x.binding.integrationSha256}:{}),...(x.binding.subjectSha256?{reviewedSubjectSha256:x.binding.subjectSha256}:{}),...(x.data.evidence.prerequisite?{consumedPrerequisite:x.data.evidence.prerequisite.receiptSha256}:{}),operation:x.binding.operation,judgmentId:x.binding.judgmentId,bindingHash:mode==='bad-binding'?'0'.repeat(64):x.bindingHash,verdict:missing?'INSUFFICIENT_EVIDENCE':mode==='return'?'RETURN_FOR_WORK':'ACCEPT_WITHIN_SCOPE',report:'明确标注的模拟接收判断；没有真实模型或业务批准。',findings:contradict?[{priority:1,description:'Explicit fixture contradiction: unresolved concern while accepting; never execute this report.'}]:missing?[{priority:1,description:'fixture missing raw evidence'}]:mode==='return'?[{priority:1,description:'Explicit fixture: empty normalized labels require Untitled fallback.'}]:[]};
const fence=String.fromCharCode(96).repeat(3),fenced=fence+'json\\n'+JSON.stringify(j)+'\\n'+fence,formatted=mode==='fenced'?fenced:mode==='fenced-prose'?'note\\n'+fenced:mode==='fenced-double'?fenced+'\\n'+fenced:JSON.stringify(j);
setTimeout(()=>emit({type:'result',session_id:'fixture-receiver',subtype:'success',is_error:false,terminal_reason:mode==='aborted'?'aborted_streaming':'completed',stop_reason:'end_turn',result:formatted,usage:{},total_cost_usd:0}),mode==='correction-delay'&&x.data.evidence.correction?900:(mode==='delay'?900:0));
});}
`;
  await writeFile(executable, code, { mode: 0o700 }); const billing = join(root, 'billing.txt'); await writeFile(billing, 'Explicit test fixture billing; no actual authentication or model');
  const plan: ReceiverPlan = { schemaVersion: 1, kind: 'tongxu-queue-receiver', store, item: item.item, objects, sourcePaths: ['sample.js'], material: [], claudeExecutable: executable, billing: { mode: 'existing_subscription_only', evidence: billing, evidenceSha256: hash(await readFile(billing)), observedAt: new Date().toISOString(), usageCreditsEnabled: false }, timeoutMs: 3000, executionKind: 'fixture' };
  const path = join(root, 'plan.json'); await writeFile(path, JSON.stringify(plan), { mode: 0o600 });
  const count = async () => (await readFile(trace, 'utf8')).split('\n').filter(Boolean).length;
  const newHead = async () => { await writeFile(join(objects, 'sample.js'), '// explicit new candidate fixture\nexport const value=3;\n'); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'new candidate']); return git(['rev-parse', 'HEAD']); };
  return { root, q, store, item: item.item, plan, path, packet, trace, count, newHead, H };
}
export async function waitPhase(q: QueueStore, phase: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const op = q.status().operations.find((o: any) => o.result?.receiver?.phase === phase); if (op) return op; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('fixture_phase_not_observed');
}

