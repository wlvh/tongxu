import fsSync from 'node:fs';
import fsPromises from 'node:fs/promises';
import {LiveProcess} from '../../src/live-process.js';
import {readEndedReadonlyImplementationFailure} from '../../src/implementation-readonly-failure.js';
import {projectSupplementReviewMessages} from '../../src/project-supplement-review.js';
import {ProjectWork} from '../../src/project-work.js';
import {IssueImplementations} from '../../src/issue-implementation-store.js';
import {assertWorkCurrent} from '../../src/project-work-current.js';
import {runValidationCorrection} from '../../src/issue-implementation.js';
import {retainedProjectAdditions} from '../../src/implementation-edits.js';
import {observeValidationFailure,checkValidationWorkspace,readLatestProjectToolValidation} from '../../src/implementation-validation.js';
import {AuthorityRecords} from '../../src/authority-store.js';
import {fixtureOwnerObservation} from '../../src/authority-source.js';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {messageFixture} from '../w6/message-fixture.js';
import {additionalFixture} from '../w7/additional-cli-fixture.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {fixture as ledgerFixture} from '../resources/provider-fixture.js';
import {startWorkbench} from '../../src/workbench.js';
import {ProjectChat,type SupplementTarget} from '../../src/project-chat.js';
import type {GitHubReaderFactory} from '../../src/github-projects.js';
import {canonical} from '../../src/comparison.js';
import {projectSecretarySchema,BoundedCodexSession,findingSchema} from '../../src/repair-native.js';
import {workPreparationInstructionsV3,preparationToolSpecs} from '../../src/project-work-contract.js';
import {workValidationInvocation,workPreparationBudgets} from '../../src/work-validation-invocation.js';
import {ProjectWorkStore} from '../../src/project-work-store.js';
import {DatabaseSync,backup} from 'node:sqlite';
import nodeTest, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, chmod, readdir, rm, cp, symlink, rename } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { fixture } from '../w5/repair-fixture.js';
import { type ProjectRequest,prepareProjectRepair, testProject, projectModelTestResult, reconcileProjectTests, bindProjectTestToCandidate, needsProjectReviewBindingSupplement } from '../../src/project-repair.js';
import { runRepair } from '../../src/repair.js';
import {prepareIssueImplementation,runIssueImplementation,type ImplementationRequest} from '../../src/issue-implementation.js';
import {prepareTaskOwner} from '../../src/tasks.js';
import {runMessages} from '../../src/messages.js';
import {TaskControls} from '../../src/task-controls.js';
import {IssueImplementationControls} from '../../src/issue-implementation-controls.js';
import {QueueStore} from '../../src/queue-store.js';
import {TaskRecords} from '../../src/task-store.js';
import { git, tree, treeHash, exists, acquireWorkspace, releaseWorkspace, RepairTools, commitScopedCandidate, projectFileMovesVersion, type Grant } from '../../src/repair-workspace.js';
import { hash } from '../../src/snapshot.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import {prepareWorkEnvironment,readWorkEnvironment,assertWorkEnvironmentEnded} from '../../src/project-work-environment.js';
import { parseDockerConfig } from '../../src/docker-sandbox.js';
import { dependencyDigest } from '../../src/sandbox.js';
import {parseDevelopmentTask} from '../../src/task-contract.js';
import {observeTaskWorkspace} from '../../src/task-source.js';
import {runTaskContactChoice,observeTaskContactChoice,cancelTaskChoiceOwnerContact,type TaskContactChoice} from '../../src/task-contact-choice.js';
const configPath = process.env.TONGXU_TEST_DOCKER_CONFIG;
if (!configPath) throw new Error('TONGXU_TEST_DOCKER_CONFIG is required for the real project test suite');
const docker = parseDockerConfig(JSON.parse(await readFile(configPath, 'utf8')));
const fixtureRoots = new WeakMap<TestContext, string[]>();
function test(name: string, body: (t: TestContext) => Promise<void>) {
  return nodeTest(name, async t => {
    const roots: string[] = []; fixtureRoots.set(t, roots); let completed = false;
    t.after(async () => {
      if (completed) { for (const root of roots) await rm(root, { recursive: true, force: true }); return; }
      const evidence = resolve(process.env.TONGXU_TEST_FAILURE_DIRECTORY ?? '.test-failures'); await mkdir(evidence, { recursive: true, mode: 0o700 });
      for (const root of roots) {
        const retained = join(evidence, basename(root)); await cp(root, retained, { recursive: true, errorOnExist: true, force: false });
        await writeFile(join(retained, 'failure-retention.json'), JSON.stringify({ test: name, originalRoot: root, originalPreserved: true, copyIsDiagnostic: true, containerState: 'must_reconcile_original_records_before_cleanup' }, null, 2));
        t.diagnostic('Failure evidence retained: ' + retained + '; original execution paths preserved: ' + root);
      }
    });
    await body(t); completed = true;
  });
}

// Every model message is generated by the explicit local fake. Only the
// registered project tests use the existing real Docker executor.
async function project(t: TestContext, green = false, argv?: string[], expectedSampleIds?: string[], mode = 'project', options: { secret?: string; testSecret?:string; large?: boolean; editor?: boolean; obsoleteDirectory?:boolean; generated?: string[] } = {}) {
  const f = await fixture(t, mode, false); fixtureRoots.get(t)!.push(f.root); await writeFile(f.configPath, JSON.stringify({ ...f.config, timeoutMs: 30000 })); const objects = join(f.root, 'project-source'); await mkdir(objects, { mode: 0o700 });
  await mkdir(join(objects, 'src')); await mkdir(join(objects, 'test'));
  await writeFile(join(objects, 'src/normalize.mjs'), (options.secret ? "import fs from 'node:fs';console.log(fs.readFileSync(new URL('../internal-not-material.txt',import.meta.url),'utf8'));\n" : '') + (mode==='project-implementation'?"export function normalizeLabel(value){return value.trim() || 'Untitled';}\n":"export function normalizeLabel(value){return value.trim();}\n"));
  if (options.secret||options.testSecret) await writeFile(join(objects, 'internal-not-material.txt'), (options.secret??options.testSecret)!);
  if (options.editor) { await mkdir(join(objects, '.vscode')); await writeFile(join(objects, '.vscode/launch.json'), '{\"configurations\":[]}'); }
  if(options.obsoleteDirectory){await mkdir(join(objects,'obsolete'));await writeFile(join(objects,'obsolete/helper.mjs'),'export const label = 1;\n');}
  if (options.large) { await mkdir(join(objects, 'large')); for(let i=0;i<15;i++) await writeFile(join(objects, 'large', String(i)+'.txt'), 'large unchanged material '.repeat(8000)); }
  await writeFile(join(objects, 'src/index.mjs'), "export {normalizeLabel} from './normalize.mjs';\n");
  await writeFile(join(objects, 'README.md'), 'Explicit multi-file project fixture. Empty labels must become Untitled.\n');
  await writeFile(join(objects, 'test/normalize.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import {normalizeLabel} from '../src/index.mjs';test('preserve a nonempty label',()=>assert.equal(normalizeLabel('  Alpha  '),'Alpha'));" + (green ? '' : "test('empty labels need the fixed fallback',()=>assert.equal(normalizeLabel('  '),'Untitled'));") + (mode==='project-implementation'?"test('optional fallback',()=>assert.equal(normalizeLabel(' ','Draft'),'Draft'));":''));
  if(options.testSecret)await writeFile(join(objects,'test/normalize.test.mjs'),(await readFile(join(objects,'test/normalize.test.mjs'),'utf8'))+"\nconsole.log((await import('node:fs')).readFileSync('internal-not-material.txt','utf8'));\n");
  await git(objects, ['init', '--template=', '--initial-branch=main']); await git(objects, ['add', '.']); await git(objects, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'explicit project fixture']);
  const H = await git(objects, ['rev-parse', 'HEAD']), testPlan = join(f.root, 'project-tests.json');
  await writeFile(testPlan, JSON.stringify({ schemaVersion: 2, executor: docker, tools: [{ id: 'existing-node-tests', argv: argv ?? [docker.node, '--test', 'test/normalize.test.mjs'], timeoutMs: 10000, ...(expectedSampleIds ? { expectedSampleIds } : {}) }] }));
  const request:ProjectRequest = { schemaVersion: 1, kind: 'tongxu-project-repair-request', executionRoot: join(f.root, 'managed-project'), generatedDirectories: options.generated ?? [], objects, candidate: { kind: 'local-git', repository: 'local/project-fixture-source', pr: null, H, B: H, target: 'main' }, allowedPaths: ['src/normalize.mjs'], materialPaths: ['src/normalize.mjs', 'src/index.mjs', 'test/normalize.test.mjs', 'README.md'], protectedPaths: ['test/normalize.test.mjs'], contract: 'Trim labels; an empty trimmed label must become Untitled. Preserve the module exports and existing nonempty labels.', testPlan, testPlanSha256: hash(await readFile(testPlan)), findings: mode==='project-implementation'?[]:[{ id: 'FIXTURE-EMPTY-LABEL', description: 'The explicit fixture does not supply the required fallback for empty labels.' }], authorization: { source: 'fixture:bounded-project-copy', allowRepair: true, allowReconcileEnded: true, maxRepairRounds: 3 }, demonstrationFixture: true };
  const requestPath = join(f.root, 'project-request.json'); await writeFile(requestPath, JSON.stringify(request));
  const prepared = await prepareProjectRepair(f.configPath, requestPath, join(f.root, 'managed-project'));
  const plan = JSON.parse(await readFile(prepared.plan, 'utf8'));
  return { ...f, ...prepared, projectPlan: plan, request, requestPath, objects, workspace: plan.workspace, originalTree: await tree(objects, true) };
}
test('fixed project input is repaired and tested in isolated copies, then independently reviewed, with no author changes or duplicate dispatch', async t => {
  const f = await project(t), result = await runRepair(f.plan, f.operation);
  assert.equal(result.status, 'completed'); assert.equal(result.actualRepairPerformed, true); assert.equal(result.projectRepair, true); assert.equal(result.after.repository, 'local/project-repair');
  assert.deepEqual(result.sourceCandidate, f.request.candidate); assert.notEqual(result.after.H, f.request.candidate.H); assert.equal((result.data as any).tests.passed, true);
  assert.deepEqual(await tree(f.objects, true), f.originalTree); assert.equal(await git(f.objects, ['rev-parse', 'HEAD']), f.request.candidate.H);
  const trace = await readFile(f.trace), again = await prepareProjectRepair(f.configPath, f.requestPath, join(f.root, 'managed-project'));
  assert.equal(again.plan, f.plan); assert.equal(again.operation, f.operation);
  assert.deepEqual(await runRepair(again.plan, again.operation), result); assert.deepEqual(await readFile(f.trace), trace);
  const binding = (result.data as any).testCandidateBinding, tests = (result.data as any).tests;
  assert.equal(binding.candidate.H, result.after.H); assert.equal(binding.candidateTree, await git(f.workspace, ['rev-parse', result.after.H + '^{tree}']));
  assert.equal(binding.testedTree, binding.candidateTree); assert.notEqual(binding.testedCommit, result.after.H); assert.equal(binding.commitMetadataEquivalent, false);
  const reviewInput = JSON.parse(await readFile(join(f.operation, 'attempt-1/review-1/inputs.json'), 'utf8'))[0].input;
  assert.deepEqual(JSON.parse(reviewInput.slice(reviewInput.lastIndexOf('\n') + 1)).testCandidateBinding, binding);
  const oldPacket = 'Explicit legacy test packet\n' + JSON.stringify({ candidate: result.after, tests });
  assert.equal(needsProjectReviewBindingSupplement(oldPacket, result.after), true);
  assert.equal(needsProjectReviewBindingSupplement(reviewInput, result.after), false);
  assert.throws(() => needsProjectReviewBindingSupplement(oldPacket, result.before), /previous_review_candidate_mismatch/);
  assert.throws(() => needsProjectReviewBindingSupplement(JSON.stringify({ candidate: result.after, testCandidateBinding: true }), result.after), /previous_review_test_binding_invalid/);
  await assert.rejects(bindProjectTestToCandidate(f.workspace, result.after, { ...tests, T: '0'.repeat(40) }), /project_candidate_test_tree_mismatch/);
  await assert.rejects(bindProjectTestToCandidate(f.workspace, result.before, tests), /project_candidate_test_tree_mismatch/);
  await writeFile(join(f.workspace, 'src/normalize.mjs'), 'changed after completed tests');
  await assert.rejects(bindProjectTestToCandidate(f.workspace, result.after, tests), /project_candidate_test_tree_mismatch/);
});
test('registered validation tests a new nested executable source through an existing caller and binds the candidate tree', async t => {
  const f=await project(t);
  const added='src/fallbacks/default-label.mjs';
  const addedPath=join(f.workspace,added);
  await mkdir(dirname(addedPath));
  await writeFile(addedPath,"export const defaultLabel = 'Untitled';\n");
  await chmod(addedPath,0o755);
  await writeFile(join(f.workspace,'src/index.mjs'),"import {defaultLabel} from './fallbacks/default-label.mjs';\nexport function normalizeLabel(value){return value.trim() || defaultLabel;}\n");
  const tests=await testProject(f.workspace,join(f.root,'test-nested-addition'),f.projectPlan.project);
  assert.equal(tests.executionHealthy,true);
  assert.equal(tests.passed,true);
  const work=join(f.root,'test-nested-addition','work');
  assert.match(await git(work,['ls-tree',tests.H,'--',added]),/^100755 blob [0-9a-f]+\t/);
  await git(f.workspace,['add','--',added,'src/index.mjs']);
  await git(f.workspace,['-c','user.name=fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m','include new candidate source']);
  const H=await git(f.workspace,['rev-parse','HEAD']);
  assert.equal((await bindProjectTestToCandidate(f.workspace,{...f.request.candidate,H},tests)).candidateTree,tests.T);
  assert.deepEqual(await tree(f.objects,true),f.originalTree);
});
test('registered validation refuses a source file missing from the actual candidate Git tree', async t => {
  const f=await project(t,true);
  await writeFile(join(f.workspace,'.gitignore'),'local-only.mjs\n');
  await writeFile(join(f.workspace,'local-only.mjs'),'export const localOnly = true;\n');
  const directory=join(f.root,'test-untracked-input');
  await assert.rejects(testProject(f.workspace,directory,f.projectPlan.project),/project_test_worktree_file_missing_from_candidate/);
  assert.equal(await exists(join(directory,'runtime')),false);
});
test('registered validation rejects Git newline transformations before Docker', async t => {
  const f=await project(t,true);
  const added='src/nested/line.mjs';
  await mkdir(join(f.workspace,'src/nested'));
  for(const [eol,ending,error] of [
    ['lf','\r\n','project_test_candidate_blob_or_mode_mismatch'],
    ['crlf','\n','project_test_candidate_checkout_mismatch'],
  ]){
    await writeFile(join(f.workspace,'.gitattributes'),added+' text eol='+eol+'\n');
    await writeFile(join(f.workspace,added),'export const value = 1;'+ending);
    const directory=join(f.root,'test-newline-'+eol);
    await assert.rejects(testProject(f.workspace,directory,f.projectPlan.project),{message:error+':'+added});
    assert.equal(await exists(join(directory,'runtime')),false);
  }
});
test('registered sparse validation preserves BOM bytes through Docker and candidate binding', async t => {
  const path='src/normalize.mjs';
  const f=await project(t,true,[docker.node,'-e',
    "const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync('src/normalize.mjs').subarray(0,3).toString('hex'),'efbbbf');assert.equal(fs.existsSync('.git'),false)"]);
  const file=join(f.workspace,path);
  const bytes=Buffer.concat([Buffer.from('efbbbf','hex'),await readFile(file)]);
  await writeFile(file,bytes);
  await git(f.workspace,['add','--',path]);
  await git(f.workspace,['-c','user.name=fixture','-c','user.email=fixture@localhost','-c','commit.gpgSign=false','commit','-m','include BOM']);
  const H=await git(f.workspace,['rev-parse','HEAD']);
  const directory=join(f.root,'test-sparse-bom');
  const tests=await testProject(f.workspace,directory,{...f.projectPlan.project,materialView:'selected_files'});
  assert.equal(tests.passed,true);
  assert.deepEqual(await readFile(join(directory,'work',path)),bytes);
  assert.deepEqual(await readFile(join(directory,'material-work',path)),bytes);
  assert.equal((await bindProjectTestToCandidate(f.workspace,{...f.request.candidate,H},tests)).candidateTree,tests.T);
});
test('the project file gate reads another caller, creates one new file and commits the exact tested project tree', async t => {
  const f=await project(t);
  await mkdir(f.operation,{mode:0o700});
  await mkdir(join(f.operation,'attempt-1'),{mode:0o700});
  const existing=JSON.parse(await readFile(f.projectPlan.grant,'utf8')) as Grant;
  const grant:Grant={...existing,allowedPaths:[],materialPaths:['src/normalize.mjs'],projectFiles:{protectedPaths:['test/normalize.test.mjs']}};
  const lease=await acquireWorkspace(f.workspace,f.operation,false,grant);
  let stopped=false;
  const candidate=f.projectPlan.candidate;
  const gate=new RepairTools(f.workspace,f.operation,grant,lease,docker.node,await tree(f.workspace,true),candidate.H,
    directory=>testProject(f.workspace,directory,f.projectPlan.project),effect=>{if(stopped)throw new Error('fixture_stopped');effect?.();});
  await gate.handoff('fixture-engineer','new_implementer_context');
  const invoke=(tool:string,args:object,callId:string)=>gate.call({tool,arguments:args,callId});
  const caller=JSON.parse((await invoke('tongxu_read_file',{path:'src/index.mjs'},'caller')).contentItems[0]!.text);
  const added={path:'src/fallbacks/default-label.mjs',text:"export const label='Untitled';\n",mode:'100755'};
  await assert.rejects(invoke('tongxu_create_file',{...added,path:'../escape.mjs'},'escape'),/create_denied/);
  await assert.rejects(invoke('tongxu_create_file',{...added,path:'test/normalize.test.mjs'},'protected'),/create_denied/);
  await invoke('tongxu_create_file',added,'new-source');
  await assert.rejects(invoke('tongxu_create_file',added,'existing'),/create_denied/);
  await invoke('tongxu_replace_file',{path:'src/index.mjs',expectedSha256:caller.sha256,text:"import {label} from './fallbacks/default-label.mjs';\nexport function normalizeLabel(value){return value.trim() || label;}\n"},'replace-caller');
  const tests=JSON.parse((await invoke('tongxu_run_tests',{},'test-candidate')).contentItems[0]!.text);
  assert.equal(tests.passed,true);
  const result=await commitScopedCandidate(f.workspace,f.operation,'attempt-1',1,candidate,await gate.check(),grant,gate,'include project addition');
  assert.match(result.diff,/new file mode 100755/);assert.match(result.diff,/src\/fallbacks\/default-label.mjs/);
  assert.equal((await bindProjectTestToCandidate(f.workspace,result.candidate,tests)).candidateTree,tests.T);
  stopped=true;
  await assert.rejects(invoke('tongxu_create_file',{...added,path:'never-created.mjs'},'stopped'),/fixture_stopped/);
  assert.equal(await exists(join(f.workspace,'never-created.mjs')),false);
  await releaseWorkspace(f.workspace,lease,'completed');
  assert.deepEqual(await tree(f.objects,true),f.originalTree);
});
test('project-scoped delete and rename preserve the validated Git candidate and reject stale or protected paths',async t=>{
  const f=await project(t,false,[docker.node,'--input-type=module','--eval',"import fs from 'node:fs'; import assert from 'node:assert/strict'; import {normalizeLabel} from './src/index.mjs'; assert.equal(fs.existsSync('obsolete'),false); assert.equal(fs.existsSync('.git'),false); assert.equal(normalizeLabel(' '),'Untitled');"],undefined,'project',{obsoleteDirectory:true});
  await mkdir(f.operation,{mode:0o700});
  await mkdir(join(f.operation,'attempt-1'),{mode:0o700});
  const registered=JSON.parse(await readFile(f.projectPlan.grant,'utf8')) as Grant;
  const grant:Grant={...registered,allowedPaths:[],projectFiles:{protectedPaths:['test/normalize.test.mjs']}};
  const lease=await acquireWorkspace(f.workspace,f.operation,false,grant);
  const initial=await tree(f.workspace,true),candidate=f.projectPlan.candidate;
  await writeFile(join(f.operation,'initial-tree.json'),JSON.stringify(initial));
  const gate=new RepairTools(f.workspace,f.operation,grant,lease,docker.node,initial,candidate.H,
    directory=>testProject(f.workspace,directory,{...f.projectPlan.project,projectFiles:true}));
  await gate.handoff('fixture-engineer','new_implementer_context');
  const invoke=(tool:string,args:object,callId:string)=>gate.call({tool,arguments:args,callId});
  const source='src/normalize.mjs',destination='src/shared/normalize.mjs',expectedSha256=initial[source]!.sha256;
  await assert.rejects(invoke('tongxu_rename_file',{path:source,destination:'src/index.mjs',expectedSha256},'collision'),/change_denied/);
  await assert.rejects(invoke('tongxu_rename_file',{path:source,destination,expectedSha256:'f'.repeat(64)},'stale'),/change_denied/);
  await assert.rejects(invoke('tongxu_delete_file',{path:'test/normalize.test.mjs',expectedSha256:initial['test/normalize.test.mjs']!.sha256},'protected'),/change_denied/);
  await invoke('tongxu_rename_file',{path:source,destination,expectedSha256},'rename');
  await invoke('tongxu_delete_file',{path:'README.md',expectedSha256:initial['README.md']!.sha256},'delete');
  const intermediate='src/shared/intermediate.mjs',helper='src/shared/helper.mjs';
  await invoke('tongxu_rename_file',{path:'obsolete/helper.mjs',destination:intermediate,expectedSha256:initial['obsolete/helper.mjs']!.sha256},'rename-helper');
  const helperContent='export const label = 2;\n';
  await invoke('tongxu_replace_file',{path:intermediate,expectedSha256:initial['obsolete/helper.mjs']!.sha256,text:helperContent},'edit-helper');
  await invoke('tongxu_rename_file',{path:intermediate,destination:helper,expectedSha256:hash(helperContent)},'rename-helper-again');
  const scope=grant.projectFiles!;
  assert.deepEqual((await retainedProjectAdditions(f.workspace,f.operation,candidate.H,scope)).additions,[helper,destination]);
  const checkpoint=join(f.operation,'calls','edit-helper.json'),receipt=await readFile(checkpoint);
  try{
    await writeFile(checkpoint,JSON.stringify({...JSON.parse(receipt.toString()),afterTreeSha256:'0'.repeat(64)}));
    await assert.rejects(retainedProjectAdditions(f.workspace,f.operation,candidate.H,scope),/implementation_edit_receipt_changed/);
  }finally{await writeFile(checkpoint,receipt);}

  await invoke('tongxu_replace_file',{path:'src/index.mjs',expectedSha256:initial['src/index.mjs']!.sha256,text:"import {normalizeLabel as trim} from './shared/normalize.mjs';\nexport function normalizeLabel(value){return trim(value) || 'Untitled';}\n"},'caller');
  const tests=JSON.parse((await invoke('tongxu_run_tests',{},'test-candidate')).contentItems[0]!.text);
  assert.equal(tests.passed,true);
  const result=await commitScopedCandidate(f.workspace,f.operation,'attempt-1',1,candidate,await gate.check(),grant,gate,'apply project file changes');
  assert.match(result.diff,/rename from src\/normalize\.mjs/);assert.match(result.diff,/deleted file mode 100644/);
  assert.match(await git(f.workspace,['diff','--name-status',candidate.H,result.candidate.H]),/R100\s+src\/normalize\.mjs\s+src\/shared\/normalize\.mjs/);
  assert.deepEqual(await readFile(join(f.workspace,destination)),await readFile(join(f.objects,source)));
  assert.equal((await bindProjectTestToCandidate(f.workspace,result.candidate,tests)).candidateTree,tests.T);
  const tested=join(f.operation,'tests','tool-test-candidate'),mounted=join(tested,'candidate-checkout');
  assert.equal(await exists(join(tested,'work','obsolete')),true);
  assert.equal(await exists(join(mounted,'obsolete')),false);
  assert.equal(JSON.parse(await readFile(join(tested,'tool-0','execution.json'),'utf8')).paths.work,mounted);
  assert.equal(await exists(join(mounted,source)),false);
  assert.equal(await exists(join(mounted,'README.md')),false);
  await releaseWorkspace(f.workspace,lease,'completed');
  assert.deepEqual(await tree(f.objects,true),f.originalTree);
});
test('two real validations of the same project tree keep the later failure when the old success is replayed',async t=>{
  const f=await project(t);
  const original=JSON.parse(await readFile(f.projectPlan.grant,'utf8')) as Grant;
  const grant={...original,allowedPaths:[],projectFiles:{protectedPaths:f.projectPlan.project.protectedPaths}};
  const {candidate}=f.projectPlan,initial=await tree(f.workspace,true);
  await mkdir(f.operation,{mode:0o700});
  const lease=await acquireWorkspace(f.workspace,f.operation,false,grant);
  const deadline=Date.now()+15000;
  const testPlan=join(f.root,'same-tree-clock-test.json');
  const bytes=canonical({schemaVersion:2,executor:docker,tools:[{
    id:'retention-clock',argv:[docker.node,'--input-type=module','--eval','if (Date.now() >= '+deadline+') process.exitCode=1;'],timeoutMs:10000
  }]});
  await writeFile(testPlan,bytes);
  const p={...f.projectPlan.project,projectFiles:true as const,testPlan,testPlanSha256:hash(bytes)};
  const plan={...f.projectPlan,project:p};
  let realRuns=0;
  const gate=new RepairTools(f.workspace,f.operation,grant,lease,docker.node,initial,candidate.H,
    async directory=>{realRuns++;return projectModelTestResult(await testProject(f.workspace,directory,p));});
  try{
    await gate.handoff('fixture-same-tree-clock','new_implementer_context');
    const a={tool:'tongxu_run_tests',callId:'clock-pass',arguments:{}},b={...a,callId:'clock-fail'};
    const passed=await gate.call(a);
    assert.equal(JSON.parse(passed.contentItems[0]!.text).passed,true);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now()+25)));
    const failed=await gate.call(b);
    assert.equal(JSON.parse(failed.contentItems[0]!.text).passed,false);
    assert.deepEqual(await gate.call(a),passed);
    assert.equal(realRuns,2);
    const originals=await readdir(join(f.operation,'tests'));
    assert.deepEqual(originals.sort(),['tool-clock-fail','tool-clock-pass']);
    const pass=JSON.parse((await readFile(join(f.operation,'tests/tool-clock-pass/result.json'))).toString());
    const fail=JSON.parse((await readFile(join(f.operation,'tests/tool-clock-fail/result.json'))).toString());
    assert.equal(pass.T,fail.T);
    assert.equal(pass.candidateTreeSha256,fail.candidateTreeSha256);
    const capture=join(f.operation,'test-transport-replay');
    await mkdir(capture);
    const frame=(id:string,params:object,result:object)=>({request:{id,params},response:{result}});
    await writeFile(join(capture,'reconciled-tools.json'),canonical([frame('first',a,passed),frame('second',b,failed),frame('replayed',a,passed)]));
    const latest=await readLatestProjectToolValidation(f.operation,capture,plan);
    assert.equal(latest.callId,'clock-fail');
    assert.equal(latest.result.passed,false);
    t.diagnostic(JSON.stringify({tree:pass.T,actualDockerExecutions:realRuns,replayCall:a.callId,selectedCall:latest.callId,passed:latest.result.passed}));
  }finally{await releaseWorkspace(f.workspace,lease,'completed');}
});
test('green existing tests cannot automatically refute a finding outside their coverage', async t => {
  const f = await project(t, true), result = await runRepair(f.plan, f.operation);
  assert.equal(result.status, 'completed'); assert.equal(result.actualRepairPerformed, true);
  assert.match(await readFile(join(f.workspace, 'src/normalize.mjs'), 'utf8'), /Untitled/);
});
test('a candidate-controlled test cannot change the trusted input and pretend exit zero is a pass', async t => {
  const f = await project(t, false, [docker.node, '-e', "require('node:fs').writeFileSync('test/normalize.test.mjs','forged');"]);
  const result = await testProject(f.workspace, join(f.root, 'tamper-check'), f.projectPlan.project);
  assert.equal(result.passed, false); assert.equal(result.executionHealthy, true); assert.equal(result.tools[0]!.inputUnchanged, true); assert.match(result.tools[0]!.stderr, /EROFS|EACCES/);
  assert.deepEqual(await tree(f.objects, true), f.originalTree); assert.equal(treeHash(await tree(f.workspace, true)), treeHash(f.originalTree));
});
test('declared structured coverage is never accepted from an empty successful command', async t => {
  const f = await project(t, false, [docker.node, '-e', 'process.exit(0)'], ['required-case']);
  const result = await testProject(f.workspace, join(f.root, 'missing-coverage'), f.projectPlan.project);
  assert.equal(result.passed, false); assert.equal(result.tools[0]!.exitCode, 0); assert.equal(result.tools[0]!.sampleSet!.complete, false);
});
test('changed test plans and overlapping protected paths are rejected before native dispatch', async t => {
  const f = await project(t), trace = await readFile(f.trace);
  await writeFile(f.projectPlan.project.testPlan, '{}'); await assert.rejects(runRepair(f.plan, f.operation), /project_test_plan_changed/); assert.deepEqual(await readFile(f.trace), trace);
  await writeFile(f.requestPath, JSON.stringify({ ...f.request, executionRoot: join(f.root, 'rejected'), allowedPaths: ['test/normalize.test.mjs'] }));
  await assert.rejects(prepareProjectRepair(f.configPath, f.requestPath, join(f.root, 'rejected')), /invalid_project_repair_scope/); assert.deepEqual(await readFile(f.trace), trace);
});

test('an ended interrupted project writer recovers the exact modification after checking original Docker operations', async t => {
  const f = await project(t, false, undefined, undefined, 'project-interrupt');
  const code = `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)})}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code]), /executor_closed_before_result/);
  const before = await readFile(f.trace, 'utf8'), beforeWrites = before.split('"name":"tongxu_replace_file"').length - 1;
  await chmod(join(f.workspace, 'src/index.mjs'), 0o755);
  await assert.rejects(runRepair(f.plan, f.operation, true), /out_of_scope_workspace_change/);
  await chmod(join(f.workspace, 'src/index.mjs'), 0o644);
  const result = await runRepair(f.plan, f.operation, true);
  assert.equal(result.status, 'completed_recovered_candidate'); assert.equal((result.data as any).writerTerminal, 'unknown_or_interrupted');
  assert.equal((await readFile(f.trace, 'utf8')).split('"name":"tongxu_replace_file"').length - 1, beforeWrites);
  assert.deepEqual(await tree(f.objects, true), f.originalTree);
});

test('a missing registered Docker capture keeps recovery unknown instead of assuming the old test ended', async t => {
  const f = await project(t), dir = join(f.root, 'lost-test-record'); await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, 'test-intent.json'), JSON.stringify({kind:'registered-project-tests-v1',directory:dir,generatedDirectories:[],controllerPid:0,testPlanSha256:f.projectPlan.project.testPlanSha256}));
  await writeFile(join(dir, 'test-progress.json'), JSON.stringify({phase:'tool_requested',toolIndex:0}));
  await assert.rejects(reconcileProjectTests(dir, f.projectPlan.project), /project_test_capture_missing/);
});
test('unavailable submodule material is rejected before any native task, without modifying the source checkout', async t => {
  const f = await project(t), trace = await readFile(f.trace);
  await git(f.objects, ['update-index', '--add', '--cacheinfo', '160000,' + f.request.candidate.H + ',vendor']);
  await git(f.objects, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'explicit missing submodule fixture']);
  const H = await git(f.objects, ['rev-parse', 'HEAD']);
  await writeFile(f.requestPath, JSON.stringify({ ...f.request, executionRoot: join(f.root, 'submodule-rejected'), candidate: { ...f.request.candidate, H } }));
  await assert.rejects(prepareProjectRepair(f.configPath, f.requestPath, join(f.root, 'submodule-rejected')), /project_submodule_material_unavailable/);
  assert.equal(await git(f.objects, ['rev-parse', 'HEAD']), H); assert.deepEqual(await readFile(f.trace), trace);
});
test('a fixed request cannot be moved to a new root to start another native task', async t => {
  const f = await project(t), before = await readFile(f.trace);
  await assert.rejects(prepareProjectRepair(f.configPath, f.requestPath, join(f.root, 'replacement-root')), /project_execution_root_changed/);
  await assert.rejects(runRepair(f.plan, join(f.root, 'replacement-operation')), /project_operation_changed/);
  assert.deepEqual(await readFile(f.trace), before);
});
test('a refuted project finding cannot be redispatched by changing the operation directory', async t => {
  const f = await project(t, true,undefined,undefined,'project-refuted');
  const result = await runRepair(f.plan, f.operation); assert.equal(result.status, 'skipped_refuted');
  const trace = await readFile(f.trace);
  await assert.rejects(runRepair(f.plan, join(f.root, 'replacement-operation')), /project_operation_changed/);
  assert.deepEqual(await runRepair(f.plan, f.operation), result); assert.deepEqual(await readFile(f.trace), trace);
});
test('unselected source printed by tests remains private and never enters fact or impact model inputs', async t => {
  const secret = 'EXPLICIT_FAKE_UNSELECTED_SOURCE_SENTINEL', f = await project(t, false, undefined, undefined, 'project', { secret });
  const result = await runRepair(f.plan, f.operation); assert.equal(result.status, 'completed');
  assert.match(await readFile(join(f.operation, 'attempt-1/baseline/tool-0/stdout'), 'utf8'), new RegExp(secret));
  for (const stage of [...result.codexStages, ...result.claudeStages]) assert.ok(!(await readFile(join(f.operation, stage, 'stdin.ndjson'), 'utf8')).includes(secret), stage);
});
test('large project snapshots and ordinary editor launch files survive committed-review interruption', async t => {
  const f = await project(t, false, undefined, undefined, 'project-review-interrupt', { large: true, editor: true });
  const code = `import {runRepair} from ${JSON.stringify(new URL('../../src/repair.js', import.meta.url).href)};try{await runRepair(${JSON.stringify(f.plan)},${JSON.stringify(f.operation)})}catch(e){console.error(e.message);process.exitCode=1}`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code]), /executor_closed_before_result/);
  const candidate = await readFile(join(f.operation, 'attempt-1/candidate-1.json')); assert.ok(candidate.length > 2 * 1024 * 1024);
  const H = await git(f.workspace, ['rev-parse', 'HEAD']), trace = await readFile(f.trace, 'utf8');
  const result = await runRepair(f.plan, f.operation, true); assert.equal(result.status, 'completed_recovered_candidate'); assert.equal(result.after.H, H);
  assert.equal((await readFile(f.trace, 'utf8')).split('"name":"tongxu_replace_file"').length, trace.split('"name":"tongxu_replace_file"').length);
  await runRepair(f.plan, f.operation); // large originals remain re-readable after sealing
});
test('new dependency shadows and transient protected-file edits are refused by runtime readonly mounts', async t => {
  for (const attack of ["const fs=require('node:fs');fs.mkdirSync('test/node_modules/checker',{recursive:true});fs.writeFileSync('test/node_modules/checker/index.js','module.exports=()=>true')", "const fs=require('node:fs'),p='test/normalize.test.mjs',b=fs.readFileSync(p);fs.writeFileSync(p,'');fs.writeFileSync(p,b)"]) {
    const f = await project(t, false, [docker.node, '-e', attack]), result = await testProject(f.workspace, join(f.root, 'runtime-readonly'), f.projectPlan.project);
    assert.equal(result.passed, false); assert.equal(result.tools[0]!.inputUnchanged, true);
    // Docker Desktop's recursive mkdir can report ENOENT for a nested readonly
    // destination; the original parent and the inspected readonly mount exist.
    assert.ok((await readFile(join(f.root, 'runtime-readonly/work/test/normalize.test.mjs'))).length > 0);
    assert.match(result.tools[0]!.stderr, /EROFS|EACCES|ENOENT/);
    const record = JSON.parse(await readFile(join(f.root, 'runtime-readonly/tool-0/execution.json'), 'utf8'));
    assert.equal(record.after.Mounts.find((m: any) => m.Destination === '/work').RW, false);
  }
});
test('registered build outputs are writable only during their producer and frozen for the final verification', async t => {
  const f = await project(t, false, undefined, undefined, 'project', { generated: ['dist'] });
  const plan = JSON.parse(await readFile(f.projectPlan.project.testPlan, 'utf8'));
  plan.tools = [
    { id: 'fixed-build', argv: [docker.node, '-e', "require('node:fs').writeFileSync('dist/output.txt','compiled')"], timeoutMs: 10000, writableOutputs: ['dist'] },
    { id: 'fixed-verify', argv: [docker.node, '-e', "const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync('dist/output.txt','utf8'),'compiled');assert.throws(()=>fs.writeFileSync('dist/output.txt','forged'),/EROFS|EACCES/);"], timeoutMs: 10000 }
  ];
  await writeFile(f.projectPlan.project.testPlan, JSON.stringify(plan)); f.projectPlan.project.testPlanSha256 = hash(await readFile(f.projectPlan.project.testPlan));
  const result = await testProject(f.workspace, join(f.root, 'registered-output'), f.projectPlan.project);
  assert.equal(result.passed, true); assert.equal(result.tools.length, 2);
  for (const [index, writable] of [true, false].entries()) {
    const record = JSON.parse(await readFile(join(f.root, 'registered-output/tool-' + index + '/execution.json'), 'utf8'));
    assert.equal(record.after.Mounts.find((m: any) => m.Destination === '/work/dist').RW, writable);
  }
  plan.tools[0].argv = [docker.node, '-e', "const fs=require('node:fs');fs.mkdirSync('dist/node_modules/checker',{recursive:true});fs.writeFileSync('dist/node_modules/checker/index.js','fake')"];
  await writeFile(f.projectPlan.project.testPlan, JSON.stringify(plan)); f.projectPlan.project.testPlanSha256 = hash(await readFile(f.projectPlan.project.testPlan));
  const attack = await testProject(f.workspace, join(f.root, 'forbidden-generated-dependency'), f.projectPlan.project);
  assert.equal(attack.passed, false); assert.equal(attack.tools.length, 1); assert.equal(attack.tools[0]!.generatedArtifacts.valid, false);
});
test('readonly project inputs have a prepared readonly dependency mount without shadowing tracked source', async t => {
  const f = await project(t), dependencies = join(f.root, 'node_modules');
  await mkdir(dependencies); await writeFile(join(dependencies, 'sentinel.json'), '{"fixed":true}');
  const plan = JSON.parse(await readFile(f.projectPlan.project.testPlan, 'utf8'));
  plan.dependencyDirectory = dependencies;
  plan.tools[0].argv = [docker.node, '-e', "const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(require('/work/node_modules/sentinel.json').fixed,true);assert.throws(()=>fs.writeFileSync('/work/node_modules/sentinel.json','forged'),/EROFS|EACCES/)"];
  await writeFile(f.projectPlan.project.testPlan, JSON.stringify(plan)); f.projectPlan.project.testPlanSha256 = hash(await readFile(f.projectPlan.project.testPlan)); f.projectPlan.project.dependencyHash = await dependencyDigest(dependencies);
  const result = await testProject(f.workspace, join(f.root, 'readonly-dependency'), f.projectPlan.project);
  assert.equal(result.passed, true); assert.equal(result.tools[0]!.dependenciesUnchanged, true);
  await mkdir(join(f.workspace, 'node_modules')); await writeFile(join(f.workspace, 'node_modules/tracked.json'), '{}');
  await assert.rejects(testProject(f.workspace, join(f.root, 'dependency-overlap'), f.projectPlan.project), /project_dependency_overlaps_source/);
});


async function implementationProject(t:TestContext,testSecret?:string){
 const f=await project(t,false,undefined,undefined,'project-implementation',{testSecret});
 let script=await readFile(f.config.codexExecutable,'utf8');
 script=script.replace("repairing=text.startsWith('The host has now explicitly')",'repairing=true')
  .replace("decision:repairing?'repaired':","decision:repairing?'implemented':")
  .replace('export function normalizeLabel(value){return value.trim() || "Untitled";}', 'export function normalizeLabel(value,fallback="Untitled"){return value.trim() || fallback;}')
  .replace('else{let thread,turn=0','else{let implementationWrites=0,implementationToolSerial=0;let thread,turn=0')
  .replace('stage=name;log','stage=name;const serial=++implementationToolSerial;log')
  .replace("id:'tool-'+current+'-'+name", "id:'tool-'+current+'-'+name+'-'+serial")
  .replace("callId:'call-'+process.pid+'-'+turn+'-'+name", "callId:'call-'+process.pid+'-'+turn+'-'+name+'-'+serial")
  .replace("else if(stage==='tongxu_replace_file'){", "else if(stage==='tongxu_replace_file'){if(++implementationWrites===1){tool('tongxu_replace_file',{path:'src/normalize.mjs',expectedSha256:v.afterSha256,text:'export function normalizeLabel(value,fallback=\"Untitled\"){return value.trim() || fallback;}\\n// second registered write\\n'});return;}");
 await writeFile(f.config.codexExecutable,script);
 await writeFile(f.configPath,JSON.stringify({...f.config,timeoutMs:120000}));return f;
}

test('selected material implementation preserves full Git history and unselected large/binary blobs in real Docker test binding',async t=>{
 const f=await implementationProject(t);await writeFile(join(f.objects,'unselected-large.txt'),'UNSELECTED-LARGE-SENTINEL'.repeat(20000));await writeFile(join(f.objects,'unselected.bin'),Buffer.from([255,0,254]));await writeFile(join(f.root,'outside-fixture-data'),'UNSELECTED_LINK_TARGET_SENTINEL');await symlink(join(f.root,'outside-fixture-data'),join(f.objects,'omitted-link'));await git(f.objects,['add','.']);await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','unselected full repository']);
 const H=await git(f.objects,['rev-parse','HEAD']),body='Preserve trim and Untitled, support the explicit optional fallback.',scope={goals:[body],nonGoals:[],preserve:[],acceptance:['actual tests'],constraints:['selected existing files']},request:ImplementationRequest={schemaVersion:1,kind:'tongxu-issue-implementation',id:'selected-work',task:'a'.repeat(64),adoptedScope:{adoption:'b'.repeat(64),body:scope,bodySha256:hash(canonical(scope)),source:'fixture'},issue:{number:201,body,bodySha256:hash(body),adjudication:'explicit protocol fixture'},workspaceRequest:{...f.request,executionRoot:join(f.root,'selected-execution'),candidate:{...f.request.candidate,H,B:H},materialView:'selected_files'}};
 const prepared=await prepareIssueImplementation(f.configPath,request,request.workspaceRequest.executionRoot),plan=JSON.parse(await readFile(prepared.plan,'utf8'));
 assert.equal(await exists(join(plan.workspace,'unselected-large.txt')),false);assert.equal(await exists(join(plan.workspace,'unselected.bin')),false);assert.equal((await git(plan.workspace,['ls-files'])).split('\n').length,(await git(f.objects,['ls-files'])).split('\n').length);
 const result=await runIssueImplementation(prepared.plan,hash(await readFile(prepared.plan)),request,prepared.operation,{refresh:async()=>{},unsent:()=>{},check:effect=>effect?.(),dispatch:()=>{}});assert.equal(result.status,'completed');if(result.status!=='completed')return;
 assert.equal(result.testCandidateBinding.candidateTree,await git(plan.workspace,['rev-parse',result.H1+'^{tree}']));assert.equal(result.tests.T,result.testCandidateBinding.candidateTree);
 for(const path of ['unselected-large.txt','unselected.bin','omitted-link'])assert.equal(await git(plan.workspace,['rev-parse',H+':'+path]),await git(plan.workspace,['rev-parse',result.H1+':'+path]));
 assert.deepEqual((await git(plan.workspace,['diff','--name-only',H,result.H1])).split('\n'),['src/normalize.mjs']);assert.equal(await git(f.objects,['rev-parse','HEAD']),H);
 assert.equal((await readFile(join(prepared.operation,'implementer','stdin.ndjson'),'utf8')).includes('UNSELECTED-LARGE-SENTINEL'),false);assert.equal((await readFile(join(prepared.operation,'implementer','stdin.ndjson'),'utf8')).includes('UNSELECTED_LINK_TARGET_SENTINEL'),false);
});

async function firstUseProjectWork(t:TestContext,fault?:string){
 const f=await implementationProject(t);if(fault==='literal-large'){const path=join(f.objects,'src/normalize.mjs'),text=await readFile(path,'utf8');await writeFile(path,text+'\n// padding\n// '+'合成UTF8不可变原文'.repeat(8500));await git(f.objects,['add','.']);await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','synthetic large UTF8 source']);}if(fault==='validation-large'){for(const [path,bytes] of [['src/normalize.mjs',190000],['src/index.mjs',195000]] as Array<[string,number]>){const text=await readFile(join(f.objects,path),'utf8');await writeFile(join(f.objects,path),text+'\n// '+ 'x'.repeat(bytes-Buffer.byteLength(text)-4));}await git(f.objects,['add','.']);await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','large editable fixture']);}await git(f.objects,['remote','add','origin','https://github.com/fixture/reception.git']);await writeFile(join(f.objects,'unselected-large.txt'),'private unused text '.repeat(fault?.startsWith('project-development')?5:20000));await git(f.objects,['add','.']);await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','real repository shape']);for(const name of ['policy-a.md','policy-b.md','policy-c.md'])await writeFile(join(f.objects,name),'Supporting fixed policy. '.repeat(fault==='validation-large'?1500:6000));await git(f.objects,['add','.']);await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','bounded read-only policy materials']);
 const proposal={goal:'Preserve trim/default and implement the optional fallback',acceptance:['Blank with Draft returns Draft','Default remains Untitled'],allowedPaths:['validation-large','literal-large'].includes(fault!)?['src/normalize.mjs','src/index.mjs','README.md']:['src/normalize.mjs'],materialPaths:['src/normalize.mjs','src/index.mjs','test/normalize.test.mjs','README.md','policy-a.md','policy-b.md','policy-c.md'],protectedPaths:['test/normalize.test.mjs','policy-a.md','policy-b.md','policy-c.md'],validation:{description:'Actual normalized optional fallback',script:"import assert from 'node:assert/strict';import fs from 'node:fs';import{normalizeLabel}from './src/index.mjs';assert.equal(fs.existsSync('.git'),false);assert.equal(normalizeLabel('  Alpha  '),'Alpha');assert.equal(normalizeLabel(' '),'Untitled');assert.equal(normalizeLabel(' ','Draft'),'Draft');"},questions:[],report:'Protocol preparation read actual source; this is not real model acceptance.'};
 if(fault==='validation-legacy'){
  const editorPath='.vscode/launch.json';
  await mkdir(join(f.objects,'.vscode'));
  await writeFile(join(f.objects,editorPath),'{"configurations":[]}');
  await git(f.objects,['add','--',editorPath]);
  await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','ordinary editor configuration']);
  proposal.materialPaths.push(editorPath);
  proposal.protectedPaths.push(editorPath);
 }
 if(fault==='project-development'){
  await writeFile(join(f.objects,'src/AGENTS.md'),'Preserve the exact download boundary. This rule applies to this folder.\n');
  await writeFile(join(f.objects,'AGENTS.md'),'Explicit project fixture. Keep original reports and registered tests.\n');
  await writeFile(join(f.objects,'SOP.md'),'Verify behavior through the actual source.\n');
  await writeFile(join(f.objects,'sample.js'),'export const value=1;\n');
  await writeFile(join(f.objects,'test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {value} from './sample.js';test('formal repair contract',()=>assert.equal(value,4));\n");
  await writeFile(join(f.objects,'src/caller.mjs'),"import {normalizeLabel} from './normalize.mjs';\nexport const caller = label => normalizeLabel(label);\n");
  await git(f.objects,['add','--','src/AGENTS.md','AGENTS.md','SOP.md','sample.js','test.mjs','src/caller.mjs']);
  await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','add scoped original rules']);
  proposal.materialPaths.push('AGENTS.md','src/AGENTS.md');
  proposal.protectedPaths.push('AGENTS.md','src/AGENTS.md');
 }
 const H=await git(f.objects,['rev-parse','HEAD']);
 const readonlyFault=fault?.startsWith('readonly-')===true,validationFault=fault?.startsWith('validation-')===true,futureValidation=fault==='validation-future'||fault==='validation-large';
 const prepareOwner=AuthorityRecords.prototype.prepare;
 if(validationFault&&!futureValidation){
  // Model an authentic old product scope before it was prepared/applied; do
  // not edit an accepted proposal, event, capture or frozen plan.
  AuthorityRecords.prototype.prepare=function(id,raw){const p=JSON.parse(raw.toString());if(p.kind==='adopt_scope')p.body.constraints=p.body.constraints.filter((x:string)=>!x.startsWith('Implementer may read this frozen validation definition;'));return prepareOwner.call(this,id,Buffer.from(canonical(p)));};t.after(()=>{AuthorityRecords.prototype.prepare=prepareOwner;});
 }
 let code=await readFile(f.config.codexExecutable,'utf8');if(fault==='implementation-ai')code=code.replace("{model:'fixture-astra',supportedReasoningEfforts:[{reasoningEffort:'max'}]}","{model:'fixture-astra',supportedReasoningEfforts:[{reasoningEffort:'max'}]},{model:'fixture-second',supportedReasoningEfforts:[{reasoningEffort:'max'}]},{model:'fixture-owner',supportedReasoningEfforts:[{reasoningEffort:'max'}]}");
 const rejectedLegacyReport=String.raw`{"validation":{"script":"const re=/\d/;"}}`;
 if(fault==='preparation-typed-retry')code=code.replace("if(stage==='tongxu_read_file'){",`if(stage==='tongxu_repository_file'&&context.preparationVersion===3){finish({candidateH:context.source.H,decision:'confirmed',report:${JSON.stringify(rejectedLegacyReport)}});return;}if(stage==='tongxu_read_file'){`);
 code=code.replace("if(stage==='tongxu_read_file'){",`if(stage==='tongxu_repository_file'){const rejected=${fault==='preparation-questions'}&&!fs.existsSync(trace+'.preparation-question'),needsOwner=${fault==='preparation-typed-retry'}&&context.previousPreparation?.omitted==='project_work_previous_already_prepared';if(rejected){fs.writeFileSync(trace+'.preparation-question','1');emit({method:'item/completed',params:{threadId:thread.id,turnId:current,completedAtMs:99,item:{id:current+'-question',type:'agentMessage',phase:'final_answer',delivery:'async',questions:[{title:'Synthetic project test premise changed; propose a bounded adjustment.',options:null}],text:'Synthetic unaccepted question.'}}});}finish({candidateH:context.source.H,decision:rejected||needsOwner?'needs_owner':'confirmed',...(context.preparationVersion>=4?{proposal:{...${JSON.stringify(proposal)},questions:rejected||needsOwner?['Synthetic project test premise changed; propose a bounded adjustment.']:[]}}:{report:JSON.stringify({...${JSON.stringify(proposal)},questions:rejected||needsOwner?['Synthetic project test premise changed; propose a bounded adjustment.']:[]})})});return;}if(stage==='tongxu_read_file'){`);
 code=code.replace("if(mode==='host-unavailable'&&turn===1)","if(context.kind==='project_work_engineering_preparation'){if(![2,3,4,5].includes(context.preparationVersion)||context.validationEnvironment?.sourceMounted!==false||context.validationEnvironment?.networkAccess!==false)throw Error('fixture_environment_facts_required');tool('tongxu_repository_file',{path:'src/normalize.mjs'});return;}if(mode==='host-unavailable'&&turn===1)");
 if(fault==='project-development'){
   const nativeSuppl={...proposal,goal:'Retain downloads for strictly less than 24 hours',acceptance:['No download at the exact boundary'],validation:{description:'Retention boundary',script:"import assert from 'node:assert/strict';import {downloadAvailableAt} from './src/normalize.mjs';assert.equal(downloadAvailableAt(0,86399999),true);assert.equal(downloadAvailableAt(0,86400000),false);"}};
   const preciseMarker={...proposal,goal:'Expose whether a download is corrected',acceptance:['The corrected marker is true'],validation:{
     description:'Corrected download marker',script:"import assert from 'node:assert/strict';import{correctedDownload}from'./src/normalize.mjs';assert.equal(correctedDownload,true);"}};
   const stage="if(stage==='tongxu_repository_file'&&context.issue.number===203&&context.userGoal==='Also add a retention deadline for the download.')";
   const late="if(stage==='tongxu_repository_file'&&context.issue.number===203&&context.userGoal==='Also mark corrected downloads.')";
   code=code.replace("if(stage==='tongxu_repository_file'){const rejected=",stage+'{finish({candidateH:context.source.H,decision:"confirmed",proposal:'+JSON.stringify(nativeSuppl)+'});return;}'+
     late+'{finish({candidateH:context.source.H,decision:"confirmed",proposal:'+JSON.stringify(preciseMarker)+'});return;}'+"if(stage==='tongxu_repository_file'){const rejected=");
 }
 if(fault==='validation-failed')code=code.replace("decision:repairing?'implemented':","decision:context.originalReport?'no_change':repairing?'implemented':");
 if(fault==='validation-interrupt')code=code.replace("if(stage==='tongxu_replace_file'){","if(stage==='tongxu_replace_file'){if(context.originalReport)process.exit(7);");
 if(fault==='validation-large')code=code.replace('stage=name;const serial=',"if(name==='tongxu_replace_file')args.text+='\\n// '+ 'g'.repeat(202000);stage=name;const serial=");
 if(validationFault)code=code.replace('stage=name;const serial=',`if(context.originalReport&&!context.validationDefinition?.readOnly)throw Error('fixture_readable_definition_required');if(name==='tongxu_replace_file'&&!context.request?.continuation&&((!context.originalReport&&context.request?.workspaceRequest?.authorization?.maxRepairRounds!==0)||${JSON.stringify(fault==='validation-failed'||fault==='validation-restart-failed')}))args.text=${JSON.stringify("export function normalizeLabel(value){return value.trim() || 'Untitled';}\n// retained failed registered edit\n")};stage=name;const serial=`);
 if(fault==='validation-large')code=code.replace('stage=name;const serial=',"if(name==='tongxu_replace_file'&&args.text.length<200000)args.text+='\\n// '+ 'g'.repeat(202000);stage=name;const serial=");
 code=code.replace('stage=name;const serial=',"if(name==='tongxu_replace_file'&&context.request?.continuation)args.text+='\\n// clarification from original supplement\\n';stage=name;const serial=");
 if(fault==='project-development-failure'){
   code=code.replace("if(stage==='tongxu_read_file'){readHash",`if(stage==='tongxu_create_file'&&globalThis.keepSource){tool('tongxu_replace_file',{path:'src/normalize.mjs',expectedSha256:globalThis.keepSource,text:'initial registered write'});return;}if(stage==='tongxu_read_file'&&!context.originalReport){globalThis.keepSource=v.sha256;tool('tongxu_create_file',{path:'src/retained-marker.mjs',text:'export const retained = true;\\n',mode:'100644'});return;}if(stage==='tongxu_read_file'){if(context.kind!=='project_implementation_correction'||!context.validationDefinition?.readOnly||!context.retainedChanges.paths.includes('src/retained-marker.mjs'))throw Error('fixture_correction_input_required');readHash`);
   code=code.replace('stage=name;const serial=',"if(name==='tongxu_replace_file'&&!context.originalReport)args.text='export function normalizeLabel(value){return value.trim() || \"Wrong\";}\\n';stage=name;const serial=");
 }
 if(fault==='project-development')code=code.replace("if(mode==='host-unavailable'&&turn===1)","if(context.technicalEvidence&&context.work){finish({candidateH:context.candidate.H,report:'Explicit fixture Tech Lead explanation: tested download retention, with review and publication still unobserved.'});return;}if(mode==='host-unavailable'&&turn===1)");
 if(fault==='project-development')code=code.replace("if(mode==='host-unavailable'&&turn===1)","if(context.material?.issue&&context.reviewedInputSha256){const lookup=context.material.integration&&context.peer===null;finish({candidateH:context.material.head,reviewedInputSha256:context.reviewedInputSha256,verdict:lookup?'REWORK_REQUIRED':'PASS',report:'Explicit fixture review of the exact acceptance material.',findings:[],coverageGaps:lookup?['source:src/caller.mjs']:[],ownerQuestions:[]});return;}if(m.params.outputSchema.properties.title){finish({candidateH:context.head,title:'Add download expiry',report:'Track the specified availability deadline for completed downloads.'});return;}if(context.draft&&context.issue){finish({candidateH:context.draft.head,report:'From Downloads, open a result before the deadline, at the deadline and afterward. Check that expired results are refused.'});return;}if(mode==='host-unavailable'&&turn===1)");
 if(fault==='project-development')code=code.replace('stage=name;const serial=',"if(name==='tongxu_replace_file'&&context.request?.continuation?.amendment){if(!context.validationDefinition?.supplement)throw Error('fixture_original_supplement_required');const amend=context.request.continuation.supplement.text,second=amend==='Also mark corrected downloads.';if(!second&&amend!=='Also add a retention deadline for the download.')throw Error('fixture_original_supplement_required');args.text+='\\nexport function downloadAvailableAt(createdAt,now){return now>=createdAt && now-createdAt'+(second||context.request.issue.number!==202||context.originalReport?'<':'<=')+'86400000;}\\n';if(second)args.text+='export const correctedDownload=true;\\n';}stage=name;const serial=");
 if(fault==='project-development')code=code.replace("if(stage==='tongxu_read_file'){", "const initialB=context.request?.issue?.number===202&&context.request.continuation?.supplement.text==='Also add a retention deadline for the download.'&&!context.originalReport;if(initialB&&stage==='tongxu_read_file'){tool('tongxu_run_tests',{});return;}if(initialB&&stage==='tongxu_run_tests'){finish({candidateH:context.candidate.H,decision:'no_change',report:'The unchanged candidate failed the new download requirement.'});return;}if(stage==='tongxu_read_file'){");
 if(fault==='literal-large'||fault==='validation-literal'){code=code.replace("if(stage==='tongxu_read_file'){","if(stage==='tongxu_read_file'){globalThis.literalBefore=v.text;");code=code.replace('stage=name;const serial=',"if(name==='tongxu_replace_file'){args.edits=[{oldText:globalThis.literalBefore.split('\\n// padding\\n')[0],newText:args.text.trimEnd()}];globalThis.literalBefore=args.text.trimEnd()+globalThis.literalBefore.slice(args.edits[0].oldText.length);delete args.text;}stage=name;const serial=");}
 if(readonlyFault){
  code=code.replace("import fs from 'node:fs';", "import fs from 'node:fs';import{createHash}from'node:crypto';import{dirname}from'node:path';");
  const toolStart=code.indexOf('const tool=(name,args)=>'),toolEnd=code.indexOf("\nrl.on('line'",toolStart);assert.ok(toolStart>=0&&toolEnd>toolStart);
  const replacement=`let fixtureDynamic=null;const tool=(name,args)=>{if(name==='tongxu_replace_file'&&context.request?.continuation)args.text+='\\n// scoped supplement after original result\\n';stage=name;const serial=++implementationToolSerial,callId='call-'+process.pid+'-'+turn+'-'+name+'-'+serial,id='tool-'+current+'-'+name+'-'+serial,time=Date.now();fixtureDynamic={id:callId,type:'dynamicToolCall',tool:name,namespace:null,arguments:args,status:'inProgress',contentItems:null,success:null,startedAtMs:time,completedAtMs:null};const started={method:'item/started',params:{threadId:thread.id,turnId:current,startedAtMs:time,item:fixtureDynamic}},request={id,method:'item/tool/call',params:{threadId:thread.id,turnId:current,callId,tool:name,namespace:null,arguments:args}};emit(started);const directory=dirname(process.cwd()),file=directory+'/native-tool-transports.json',rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[],sha=x=>createHash('sha256').update(x).digest('hex');rows.push({requestSha256:sha(JSON.stringify(request)),startSha256:sha(JSON.stringify(started)),callId,threadId:thread.id,turnId:current,transport:'owned-app-server-dynamic-rpc',appServerPid:process.pid,appServerExecutableSha256:sha(fs.readFileSync(process.argv[1])),observedHelperPids:[],helperObservation:'no_helper_observed_not_required_for_direct_rpc'});fs.writeFileSync(file,JSON.stringify(rows),{mode:0o600});log({kind:'tool-request',name});emit(request)};`;
  code=code.slice(0,toolStart)+replacement+code.slice(toolEnd);
  code=code.replace("if(m.error)return;const v=JSON.parse", `if(m.error)return;if(fixtureDynamic){const time=Date.now();emit({method:'item/completed',params:{threadId:thread.id,turnId:current,completedAtMs:time,item:{...fixtureDynamic,status:'completed',contentItems:m.result.contentItems,success:m.result.success,completedAtMs:time}}});fixtureDynamic=null;}if(!context.request?.continuation&&(context.request?.workspaceRequest?.authorization?.maxRepairRounds===1||${JSON.stringify(fault==='readonly-zero-failed')})){if(stage==='tongxu_read_file'){${fault==='readonly-nonread'?"tool('tongxu_replace_file',{path:'src/normalize.mjs',expectedSha256:JSON.parse(m.result.contentItems[0].text).sha256,text:JSON.parse(m.result.contentItems[0].text).text});":''}return;}if(stage==='tongxu_replace_file')return;}const v=JSON.parse`);
  const wait=LiveProcess.prototype.waitFor;t.mock.method(LiveProcess.prototype,'waitFor',function(this:LiveProcess,predicate:any,budget:number){if(this.directory.startsWith(f.root+'/project-work/')&&(this.directory.includes('/version-1/')||fault==='readonly-zero-failed')&&this.directory.endsWith('/implementer'))return wait.call(this,predicate,1200);return wait.call(this,predicate,budget);});
 }
 await writeFile(f.config.codexExecutable,code);
 const originals=join(f.root,'work-owner-comments.json'),gh=join(f.root,'work-owner.mjs');await writeFile(originals,'[]');
 const ghCode=`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2),file=${JSON.stringify(originals)},rows=JSON.parse(fs.readFileSync(file,'utf8')),out=x=>console.log(JSON.stringify(x));const fault=fs.existsSync(file+'.fault')?JSON.parse(fs.readFileSync(file+'.fault','utf8')):null,p=a.find(x=>x.startsWith('repos/')),point=a.at(-1)==='user'?'adopt-user':p?.includes('/comments?')?(rows.length?'delegate-comments':'adopt-comments'):null;if(fault?.hold===point&&fs.existsSync(file+'.hold')){fs.writeFileSync(file+'.waiting','1');while(fs.existsSync(file+'.hold'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}if(a.includes('graphql')){const id=a.find(x=>x.startsWith('id=')).slice(3);out(rows.find(x=>x.comment.node_id===id).graph);}else if(a.at(-1)==='user')out({id:101});else{const p=a.find(x=>x.startsWith('repos/'));if(p.includes('/issues/comments/'))out(rows.find(x=>String(x.comment.id)===p.split('/').at(-1)).comment);else if(a.includes('POST')){const n=Number(p.split('/')[4]),id=7000000001+rows.length,node='IC_'+id,time=new Date().toISOString(),body=JSON.parse(fs.readFileSync(a[a.indexOf('--input')+1],'utf8')).body,url='https://github.com/fixture/reception/issues/'+n+'#issuecomment-'+id,comment={id,node_id:node,body,user:{id:101,type:'User'},created_at:time,updated_at:time,issue_url:'https://api.github.com/repos/fixture/reception/issues/'+n,html_url:url},graph={data:{viewer:{databaseId:101},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body,createdAt:time,updatedAt:time,url,issue:{number:n,repository:{nameWithOwner:'fixture/reception'}}}}};if(fault?.unknown){process.exit(17);}rows.push({comment,graph});fs.writeFileSync(file,JSON.stringify(rows));if(rows.length===fault?.lose){fs.unlinkSync(file+'.fault');process.exit(17);}out(comment);}else out(rows.filter(x=>x.comment.issue_url.endsWith('/'+Number(p.split('/')[4]))).map(x=>x.comment));}`;
 await writeFile(gh,ghCode,{mode:0o700});
 const config={...(fault==='validation-future'?{preparationTimeoutMs:900000}:{}),root:join(f.root,'project-work'),executor:{path:f.configPath,sha256:hash(await readFile(f.configPath))},verification:docker,owner:{ownerId:101,executorId:101,ghExecutable:gh,ghSha256:hash(ghCode),executionKind:'fixture',maxObservationAgeMs:300000,maxGrantDurationMs:86400000,sharedAccountApproval:{decisionReference:{kind:'recorded_user_decision',sha256:'d'.repeat(64)}}}},configPath=join(f.root,'project-work-config.json');await writeFile(configPath,canonical(config));
 const issuePeer=fault==='project-development'?await additionalFixture(t,'kimi'):null;
 if(issuePeer){
   const source=await readFile(issuePeer.binary,'utf8');
   const modified=source.replace("if(responseKind==='message')output={messageId:envelope.messageId,consumed:envelope.replyReferences,report:'Explicit '+tool+' fixture complete material report '+turn};","if(responseKind==='message')output={candidateH:envelope.material.head,reviewedInputSha256:envelope.reviewedInputSha256,verdict:'PASS',report:'Explicit fixture independent minimum Issue review.',findings:[],coverageGaps:[],ownerQuestions:[]};");
   assert.notEqual(source,modified);await writeFile(issuePeer.binary,modified);
 }
 let publishedIssueBody:string|undefined;
 const repository={id:1,nodeId:'R_FIRST',full_name:'fixture/reception',description:'explicit first-use protocol fixture',private:false,archived:false,defaultBranchRef:{name:'main',target:{oid:H}},updated_at:new Date().toISOString()},account={id:101,login:'fixture'};
 const github:GitHubReaderFactory=async()=>({query:async(op,args)=>{const issue={id:1000+(args.number??201),number:args.number??201,title:'Real task shape '+(args.number??201),body:args.number===204&&publishedIssueBody?publishedIssueBody:'Preserve trim/default; add optional fallback.',state:'OPEN',updated_at:new Date().toISOString(),author:{login:'fixture'},labels:{nodes:[]},comments:{totalCount:0}};return {status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repository],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository:{...repository,...(op==='issue'?{item:issue}:op==='issues'||op==='pulls'?{items:{nodes:op==='issues'?[issue]:[],pageInfo:{hasNextPage:false,endCursor:null}}}:{})}}})};}});
 const planPath=join(f.root,'first-use-plan.json');await writeFile(planPath,canonical({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'First use',goal:'Protocol end to end, not real user acceptance',sources:[],githubProjects:true,...(fault==='implementation-ai'||fault==='workflow-default'||issuePeer?{aiSettings:{root:join(f.root,'ai-settings'),configured:issuePeer?[{tool:'kimi',path:issuePeer.binary}]:[{tool:'codex',path:f.config.codexExecutable}],disabledMcpServers:[]}}:{}),projectWork:{path:configPath,sha256:hash(await readFile(configPath))},projectSecretary:{root:join(f.root,'conversations'),codexExecutable:f.config.codexExecutable,disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:120000,billing:'existing_subscription_only',executionKind:'fixture'}}));
 const ownerURLs:string[]=[];const dependencies={githubReader:github,...(fault==='implementation-ai'?{aiProbe:async(tool:any,path:string,directory:string)=>({id:path===f.config.codexExecutable?'fixture-program':hash(path).slice(0,20),tool,path,version:'Explicit fixture',available:path===f.config.codexExecutable,reason:null,authentication:'subscription' as const,models:['fixture-astra','fixture-second','fixture-owner'].map(id=>({id,resolvedId:null,name:id,description:'Explicit model fixture',efforts:['max'],defaultEffort:'max',isDefault:id==='fixture-astra'})),observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:tool==='codex',ownedControl:true},evidence:directory})}:{}),...(issuePeer?{aiProbe:async(tool:any,path:string,directory:string)=>({
   id:hash(path),tool,path,version:'Explicit fixture',available:path===issuePeer.binary,reason:null,authentication:'subscription' as const,
   models:[{id:'fixture/model-next',resolvedId:null,name:'Kimi fixture',description:'Explicit protocol sample',efforts:['future-depth'],defaultEffort:'future-depth',isDefault:true}],
   observedAt:new Date().toISOString(),capabilities:{readonlyMessages:true,scopedTools:false,ownedControl:false,impactReports:tool==='kimi'},evidence:directory
 })}:{}),ownerWindowOpen:async(value:string)=>{ownerURLs.push(value);}};
 let app=await startWorkbench(planPath,undefined,dependencies);t.after(()=>app.close());let url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'x-tongxu-account':'101','x-tongxu-project':'1'};
 const get=async(path:string)=>{const r=await fetch(url.origin+path,{headers});return {status:r.status,value:await r.json() as any};},post=async(path:string,body:unknown)=>{const r=await fetch(url.origin+path,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:canonical(body)});return {status:r.status,value:await r.json() as any};};await get('/api/github/projects');
 const chooseImplementer=async(model:string)=>{const settings=(await get('/api/ai-settings')).value;const changed=await post('/api/ai-settings/role',{revision:settings.revision,role:'implementer',choice:{providerId:'fixture-program',model,effort:'max'}});assert.equal(changed.status,200,JSON.stringify(changed.value));};if(fault==='implementation-ai'){assert.equal((await post('/api/ai-settings/scan',{})).status,200);const state=(await get('/api/ai-settings')).value;assert.equal((await post('/api/ai-settings/role',{revision:state.revision,role:'issue_owner',choice:{providerId:'fixture-program',model:'fixture-owner',effort:'max'}})).status,200);}
 const wait=async(id:string,stage:string)=>{const deadline=Date.now()+120000;for(let i=0;i<5000&&Date.now()<deadline;i++){const all=await get('/api/project-work'),work=all.value.works.find((w:any)=>w.id===id);if(work?.stage===stage&&!work.active)return work;if(work?.problem&&work.stage!=='preparing'&&!work.active&&stage!=='needs_input'&&stage!=='authorizing')throw new Error(JSON.stringify(work));await new Promise(r=>setTimeout(r,25));}throw new Error('first_use_fixture_timeout');};
 const first={requestId:randomUUID(),conversationId:randomUUID(),issueNumber:201,goal:'Please implement the original Issue',newWork:false};const empty={...first,goal:''};let created=await post('/api/project-work/create',empty);assert.equal(created.status,200);assert.equal((await post('/api/project-work/create',empty)).value.id,first.requestId);
 const cross=await post('/api/project-work/create',{...first,requestId:randomUUID(),conversationId:randomUUID()});assert.equal(cross.value.id,first.requestId);
 await post('/api/project-work/'+first.requestId+'/prepare',{goal:first.goal});await wait(first.requestId,'needs_input');assert.equal((await get('/api/project-work/'+first.requestId)).value.draft.problem,'project_work_repository_location_required');assert.equal((await get('/api/project-work/'+first.requestId)).value.draft.goal,first.goal);assert.equal((await readFile(f.trace,'utf8')).includes('model-input'),false);
 await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');assert.equal((await get('/api/project-work/'+first.requestId)).value.draft.goal,first.goal);
 assert.equal((await post('/api/project-work/settings',{repositoryPath:f.objects})).status,200);
 if(fault==='workflow-default'){
   const {AISettings}=await import('../../src/ai-settings.js');
   const {firstCodingWorkflowRevision}=await import('../../src/coding-workflow-source.js');
   let active=false;
   t.mock.method(AISettings.prototype,'workflowRevision',()=>active?firstCodingWorkflowRevision:'legacy');
   const old=first.requestId,detail=async(id:string)=>(await get('/api/project-work/'+id)).value.draft;
   assert.equal((await post('/api/project-work/'+old+'/prepare',{goal:first.goal})).status,202);
   await wait(old,'prepared');
   const before=await detail(old),oldBytes=await readFile(join(before.preparation.directory,'input.json'));
   assert.equal(JSON.parse(oldBytes.toString()).preparationVersion,4);
   assert.equal(before.preparation.workflowActive,undefined);
   active=true;
   const next={...first,requestId:randomUUID(),conversationId:randomUUID(),issueNumber:202};
   assert.equal((await post('/api/project-work/create',next)).status,200);
   assert.equal((await post('/api/project-work/'+next.requestId+'/prepare',{goal:next.goal})).status,202);
   await wait(next.requestId,'prepared');
   const fresh=await detail(next.requestId),payload=JSON.parse(await readFile(join(fresh.preparation.directory,'input.json'),'utf8'));
   assert.equal(payload.preparationVersion,5);
   assert.equal(fresh.preparation.workflowActive,true);
   assert.equal(fresh.preparation.workflowPrompt.revision,firstCodingWorkflowRevision);
   assert.deepEqual(await readFile(join((await detail(old)).preparation.directory,'input.json')),oldBytes);
   return;
 }
 if(fault==='project-development-failure'){
   const id=first.requestId,detail=async()=>(await get('/api/project-work/'+id)).value;
   const until=async<T>(read:()=>Promise<T>,done:(value:T)=>boolean)=>{
     for(let i=0;i<1800;i++){const value=await read();if(done(value))return value;await new Promise(r=>setTimeout(r,20));}
     const {draft,execution}=await detail();assert.fail(JSON.stringify([draft.problem,execution?.requests]));
   };
   assert.equal((await post('/api/project-work/'+id+'/prepare',{goal:first.goal})).status,202);
   await wait(id,'prepared');
   const prepared=(await detail()).draft;
   assert.equal((await post('/api/project-work/'+id+'/start',{version:prepared.version,proposalSha256:prepared.preparation.proposalDigest,projectDevelopment:true})).value.waitingForOwner,true);
   const ownerHeaders={Authorization:'Owner '+new URL(ownerURLs[0]!).hash.slice(1),Origin:url.origin,'Content-Type':'application/json'};
   assert.equal((await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:ownerHeaders,body:'{}'})).status,202);
   const failed=await until(detail,d=>d.validationFailure?.eligible===true);
   assert.equal(failed.validationFailure.tests.passed,false);
   assert.equal(failed.draft.delivery,null);
   assert.ok(failed.validationFailure.changed.includes('src/retained-marker.mjs'));
   const entry=JSON.parse(await readFile(failed.draft.catalog.path,'utf8')).entries[0],q=await QueueStore.open(entry.store);
   const prior=q.issueImplementations().state(entry.id,failed.draft.requestId);q.close();
   const originalCapture=await readFile(join(prior.validationFailure.nativeDirectory,'stdin.ndjson'));
   assert.equal(await git(prior.plan.workspace,['rev-parse','HEAD']),H);
   assert.equal(await exists(join(prior.plan.workspace,'src/retained-marker.mjs')),true);

   await app.close();app=await startWorkbench(planPath,undefined,dependencies);
   url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};
   await get('/api/github/projects');
   assert.equal((await detail()).validationFailure.eligible,true);
   const startSession=BoundedCodexSession.start;
   let failBootstrap=true;
   t.mock.method(BoundedCodexSession,'start',async(o:Parameters<typeof startSession>[0])=>{
     if(failBootstrap&&o.directory===join(prior.plan.operationRoot,'validation-correction/native')){
       failBootstrap=false;throw new Error('version_failed');
     }
     return startSession.call(BoundedCodexSession,o);
   });
   const oldLease=await readFile(join(prior.plan.workspace,'.git/tongxu-writer.json')),oldTrace=await readFile(f.trace);
   const correct=()=>post('/api/project-work/'+id+'/correct-validation',{requestId:failed.draft.requestId});
   assert.equal((await correct()).status,202);
   await until(detail,d=>d.execution.requests[0].reason==='version_failed'&&!d.execution.requests[0].controllerActive);
   assert.deepEqual(await readFile(join(prior.plan.workspace,'.git/tongxu-writer.json')),oldLease);
   assert.deepEqual(await readFile(f.trace),oldTrace);
   const bootstrap=join(prior.plan.operationRoot,'validation-correction/native-bootstrap-failure.json'),failureBytes=await readFile(bootstrap);
   const complete=IssueImplementations.prototype.complete;
   let loseReceipt=true;
   t.mock.method(IssueImplementations.prototype,'complete',function(this:IssueImplementations,...args:Parameters<IssueImplementations['complete']>){
     if(loseReceipt&&args[1]===failed.draft.requestId&&args[2].validationCorrection){loseReceipt=false;throw Error('fixture_controller_lost_after_writer_release');}
     return complete.apply(this,args);
   });
   const continueResponse=await correct();
   assert.equal(continueResponse.status,202,JSON.stringify(continueResponse));
   const pending=await until(detail,d=>!loseReceipt&&d.validationRecovery);
   assert.equal(pending.draft.delivery,null);
   assert.equal(pending.validationRecovery.requestId,failed.draft.requestId);
   const beforeReadback=await readFile(f.trace);
   await app.close();app=await startWorkbench(planPath,undefined,dependencies);
   url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');
   assert.deepEqual((await detail()).validationRecovery,pending.validationRecovery);
   const reconcile='/api/project-work/'+id+'/reconcile-validation';
   assert.equal((await post(reconcile,{requestId:randomUUID()})).status,503);
   assert.equal((await post(reconcile,{requestId:failed.draft.requestId})).value.newModelInputs,0);
   assert.equal((await post(reconcile,{requestId:failed.draft.requestId})).value.newModelInputs,0);
   assert.deepEqual(await readFile(f.trace),beforeReadback);
   const receipt=(await detail()).resultStatus.receipt;
   assert.equal(receipt.H,pending.validationRecovery.H);
   assert.equal((await post('/api/project-work/'+id+'/receive',receipt)).status,200);
   const completed=await until(detail,d=>d.draft.delivery?.status==='received');
   assert.deepEqual(await readFile(bootstrap),failureBytes);
   assert.equal(completed.draft.requestId,failed.draft.requestId);
   assert.equal(completed.draft.version,failed.draft.version);
   const result=completed.execution.reports[0];
   assert.equal(result.tests.passed,true);
   assert.equal(result.originalValidationFailure.tests.passed,false);
   assert.equal(result.H1,completed.draft.delivery.H);
   assert.equal(await git(prior.plan.workspace,['rev-parse','HEAD^']),H);
   assert.equal(await git(prior.plan.workspace,['show',result.H1+':src/retained-marker.mjs']),'export const retained = true;');
   assert.deepEqual(await readFile(join(prior.validationFailure.nativeDirectory,'stdin.ndjson')),originalCapture);
   assert.equal(ownerURLs.length,1);
   assert.equal(JSON.parse(await readFile(originals,'utf8')).length,2);
   const store=await QueueStore.open(entry.store);
   const current=store.issueImplementations().state(entry.id,failed.draft.requestId);store.close();
   assert.equal(current.plan.workspace,prior.plan.workspace);
   assert.equal(current.operation,prior.operation);
   assert.notEqual(current.result.sessionId,prior.validationFailure.sessionId);
   t.diagnostic(JSON.stringify({work:id,request:failed.draft.requestId,operation:current.operation,H0:H,H1:result.H1,
     failedSession:prior.validationFailure.sessionId,correctionSession:current.result.sessionId,retainedPath:'src/retained-marker.mjs'}));
   return;
 }
 if(fault==='project-development'){
   const a=first.requestId,b=randomUUID(),c=randomUUID();
   assert.equal((await post('/api/project-work/create',{...first,requestId:b,issueNumber:202})).status,200);
   assert.equal((await post('/api/project-work/create',{...first,requestId:c,issueNumber:203})).status,200);
   for(const id of [a,b,c]){
     assert.equal((await post('/api/project-work/'+id+'/prepare',{goal:first.goal})).status,202);
     await wait(id,'prepared');
   }
   const detail=async(id:string)=>(await get('/api/project-work/'+id)).value;
   const start=async(id:string)=>{const {draft}=await detail(id);return post('/api/project-work/'+id+'/start',{version:draft.version,proposalSha256:draft.preparation.proposalDigest,projectDevelopment:true});};
   const reached=new Map<string,string>();
   const release=new Map<string,()=>void>();
   const gates=new Map([a,b,c].map(id=>[id,new Promise<void>(resolve=>release.set(id,resolve))]));
   let releaseSupplement=()=>{};
   const waitForSupplement=new Promise<void>(resolve=>{releaseSupplement=resolve;});
   const call=RepairTools.prototype.call;
   t.mock.method(RepairTools.prototype,'call',async function(this:RepairTools,...args:Parameters<RepairTools['call']>){
     const result=await call.apply(this,args);
     const id=[a,b,c].find(id=>this.workspace.includes('/works/'+id+'/'));
     if(id&&args[0].tool==='tongxu_run_tests'){
       if(this.workspace.includes('/executions/supplement-'))await waitForSupplement;
       else{reached.set(id,this.workspace);await gates.get(id);}
     }
     return result;
   });
   const until=async<T>(read:()=>Promise<T>,done:(value:T)=>boolean)=>{
     for(let i=0;i<1800;i++){const value=await read();if(done(value))return value;await new Promise(r=>setTimeout(r,20));}
     const describe=async(id:string)=>{const {draft,execution}=await detail(id);return {stage:draft.stage,problem:draft.problem,requests:execution?.requests.map((r:any)=>({phase:r.phase,reason:r.reason}))};};
     assert.fail(JSON.stringify({a:await describe(a),b:await describe(b),c:await describe(c)}));
   };
   try{
     const approval=await start(a);assert.equal(approval.status,202);assert.equal(approval.value.waitingForOwner,true);
     const ownerHeaders={Authorization:'Owner '+new URL(ownerURLs[0]!).hash.slice(1),Origin:url.origin,'Content-Type':'application/json'};
     const preview=await fetch(url.origin+'/api/project-owner',{headers:ownerHeaders}).then(r=>r.json()) as any;
     assert.equal(preview.preview.projectDevelopment,true);
     assert.equal((await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:ownerHeaders,body:'{}'})).status,202);
     await until(()=>get('/api/project-work'),r=>!!r.value.development);
     const next=await start(b);assert.equal(next.status,202,JSON.stringify(next.value));assert.equal(next.value.active,true);
     assert.equal((await start(c)).status,202);
     await until(async()=>reached.size,n=>n===3);
     assert.equal(ownerURLs.length,1);
     assert.equal(JSON.parse(await readFile(originals,'utf8')).length,2);
     assert.notEqual(reached.get(a),reached.get(b));
     for(const workspace of reached.values())assert.match(await git(workspace,['diff','HEAD','--','src/normalize.mjs']),/fallback/);
     const ca=JSON.parse(await readFile((await detail(a)).draft.catalog.path,'utf8')).entries[0];
     const cb=JSON.parse(await readFile((await detail(b)).draft.catalog.path,'utf8')).entries[0];
     assert.equal(ca.store,cb.store);
     assert.deepEqual(ca.workflowPrompt,(await detail(a)).draft.preparation.workflowPrompt);
     assert.deepEqual(cb.workflowPrompt,(await detail(b)).draft.preparation.workflowPrompt);
     assert.deepEqual(ca.authorization,cb.authorization);
     assert.notEqual(ca.target,cb.target);
     assert.deepEqual(ca.allowedPaths,[]);
     assert.equal(ca.projectFiles&&cb.projectFiles,true);
     const targets=(await get('/api/project-secretary')).value.supplementTargets as Array<Record<string,any>>;
     const {title,...target}=targets.find(t=>t.source===cb.id)!;
     const {title:titleA,...targetA}=targets.find(t=>t.source===ca.id)!;
     const shared={conversationId:randomUUID(),requestId:randomUUID(),targets:[targetA,target],text:'大报表改为后台生成后下载'};
     const sharedReceipt=await post('/api/project-secretary/supplement',shared);
     assert.equal(sharedReceipt.status,202,JSON.stringify(sharedReceipt.value));
     assert.equal(sharedReceipt.value.newModelInputs,0);
     const repost=await post('/api/project-secretary/supplement',{...shared,targets:[target,targetA]});
     assert.equal(repost.value.duplicate,true);
     assert.equal((await post('/api/project-secretary/supplement',{...shared,text:'同编号替换原话'})).status,503);
     const linked=(await get('/api/project-secretary/conversations/'+shared.conversationId)).value.supplements;
     assert.equal(linked.length,2);
     assert.deepEqual(new Set(linked.map((row:any)=>row.target.source)),new Set([ca.id,cb.id]));
     for(const row of linked)assert.deepEqual([row.originalRequestId,row.text,row.compiledRequest],[shared.requestId,shared.text,null]);
     assert.equal((await post('/api/project-work/'+a+'/stop',{})).value.stopRequested,true);
     release.get(a)!();release.get(c)!();
     const unrelated=await until(()=>detail(c),r=>r.draft.delivery?.status==='received');
     assert.equal(unrelated.execution.reports[0].tests.passed,true);
     assert.equal((await detail(b)).draft.stopRequested,false);
     for(const row of linked)assert.equal((await post('/api/project-secretary/cancel-supplement',{requestId:row.id})).status,200);
     const conversationId=(await detail(b)).draft.conversationId,requestId=randomUUID();
     const supplement=await post('/api/project-secretary/supplement',{conversationId,requestId,target,text:'Also add a retention deadline for the download.'});
     assert.equal(supplement.status,202,JSON.stringify(supplement.value));
     assert.equal(supplement.value.newModelInputs,0);
     const received=(await get('/api/project-secretary/conversations/'+conversationId)).value.supplements[0];
     assert.deepEqual([received.id,received.target.source,received.compiledRequest,received.receivedIsNotDelivered],[requestId,cb.id,null,true]);
     assert.match(title,/Issue #202/);
     assert.equal((await detail(b)).draft.stopRequested,false);
     const receive=ProjectWork.prototype.receive;
     let loseFirstReceipt=true;
     t.mock.method(ProjectWork.prototype,'receive',async function(this:ProjectWork,...args:Parameters<ProjectWork['receive']>){
       if(args[1]===b&&!args[2]&&loseFirstReceipt){loseFirstReceipt=false;throw Error('github_connection_unavailable');}
       return receive.apply(this,args);
     });
     release.get(b)!();
     const awaitingReceipt=await until(()=>detail(b),r=>!loseFirstReceipt&&r.resultStatus.receipt);
     assert.equal(awaitingReceipt.draft.stage,'execution');
     assert.equal(awaitingReceipt.draft.delivery,null);
     assert.equal((await post('/api/project-work/'+b+'/receive',{...awaitingReceipt.resultStatus.receipt,H:'0'.repeat(40)})).status,503);
     assert.equal((await post('/api/project-work/'+b+'/receive',awaitingReceipt.resultStatus.receipt)).status,200);
     const finished=await until(()=>detail(b),r=>r.draft.delivery?.status==='received');
     assert.equal(finished.execution.reports.at(-1).tests.passed,true);
     assert.equal(await git(f.objects,['rev-parse','HEAD']),H);
     assert.equal((await detail(a)).draft.stopRequested,true);
     const pending=(await get('/api/project-secretary/conversations/'+conversationId)).value.supplements[0];
     assert.equal(pending.receivedIsNotDelivered,true);
     assert.equal(pending.compiledRequest,null);
     assert.equal(pending.original.reason,'project_supplement_review_required');
     assert.equal(pending.original.H1,finished.draft.delivery.H);
     assert.deepEqual([pending.original.issue,pending.original.delivered,pending.original.adopted,pending.original.coveringCandidate],[202,false,false,null]);
     assert.equal((await post('/api/project-secretary/continue-supplements',{target})).status,202);
     assert.equal((await get('/api/project-secretary/conversations/'+conversationId)).value.supplements[0].compiledRequest,null);
     await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};
     await get('/api/github/projects');
     const cold=await get('/api/project-secretary/conversations/'+conversationId);
     assert.equal(cold.status,200);
     assert.deepEqual(cold.value.supplements[0],pending);
     const sharedCold=(await get('/api/project-secretary/conversations/'+shared.conversationId)).value.supplements;
     assert.deepEqual(sharedCold.map((row:any)=>[row.id,row.originalRequestId,row.cancelled]),linked.map((row:any)=>[row.id,shared.requestId,true]));
     const queue=await QueueStore.open(cb.store);
     const resultState=queue.issueImplementations().state(cb.id,finished.draft.requestId);queue.close();
     const tested=join(resultState.plan.operationRoot,'tests','tool-'+resultState.result.projectValidationCallId);
     for(const file of ['runtime/probe/execution.json','tool-0/execution.json','tool-0/stdout','tool-0/stderr']){
       const path=join(tested,file),original=await readFile(path);
       try{
         await rm(path);
         const uncertain=await detail(b);
         assert.equal(uncertain.draft.delivery.H,finished.draft.delivery.H,file);
         assert.equal(uncertain.execution.reports.length,0,file);
         assert.deepEqual(uncertain.execution.reportGaps,[{requestId:finished.draft.requestId,H1:finished.draft.delivery.H,reason:'implementation_validation_capture_changed'}],file);
       }finally{await writeFile(path,original);}
     }

     const originalWire=await readFile(join(resultState.plan.operationRoot,'implementer','stdin.ndjson'),'utf8');
     const reviews=await additionalFixture(t,'kimi');
     const compiled='supplement-'+requestId,material='project-supplement-requirement.json';
     const text='Also add a retention deadline for the download.';
     const validation={description:'Downloads expire at exactly 24 hours',script:"import assert from 'node:assert/strict';import {downloadAvailableAt} from './src/normalize.mjs';assert.equal(downloadAvailableAt(0,86399999),true);assert.equal(downloadAvailableAt(0,86400000),false);assert.equal(downloadAvailableAt(0,86400001),false);"};
     const amendment=canonical({kind:'tongxu-project-supplement-requirement-v1',input:{repository:'fixture/reception',target,H1:finished.draft.delivery.H,requestId:compiled,text},requirement:'Permit downloads for 24 hours from creation, with the deadline exclusive.',acceptance:['The file is available immediately before 24 hours and unavailable at and after the deadline.'],validation});
     const materialPath=join(f.root,material);
     await writeFile(materialPath,amendment);
     const verdict=canonical({candidateH:finished.draft.delivery.H,reviewedInputSha256:hash(amendment),verdict:'PASS',report:'Explicit protocol fixture reviewer; 24-hour boundary is fixed for this test.',findings:[],coverageGaps:[],ownerQuestions:[]});
     const codex=await readFile(reviews.codex,'utf8'),kimi=await readFile(reviews.binary,'utf8');
     const completionProgram=codex.replace(/report:'明确标记的进程夹具[^\n]+\+x.messageId/, 'report:'+JSON.stringify(verdict));
     const minimalityProgram=kimi.replace("report:'Explicit '+tool+' fixture complete material report '+turn",'report:'+JSON.stringify(verdict));
     assert.notEqual(codex,completionProgram);assert.notEqual(kimi,minimalityProgram);
     await writeFile(reviews.codex,completionProgram);
     await writeFile(reviews.binary,minimalityProgram);
     const [reviewer]=reviews.plan.participants;
     const {aiModel:_,...reviewerDefaults}=reviewer!;
     const completion={...reviewerDefaults,id:'review-completion',role:'reviewer' as const,tool:'codex' as const,executable:reviews.codex,executableSha256:hash(completionProgram)};
     const minimality={...reviewer!,id:'review-minimality',role:'verifier_impact' as const,executableSha256:hash(minimalityProgram)};
     const completedReview={...reviews.plan,participants:[completion,minimality],messages:await projectSupplementReviewMessages(completion.id,minimality.id),material:[{name:material,path:materialPath,sha256:hash(amendment)}],consumeMaterial:[material]};
     const reviewPath=join(f.root,'supplement-message-plan.json');
     await writeFile(reviewPath,canonical(completedReview));
     const reviewed=await runMessages(reviews.store,reviewPath);
     assert.equal(reviewed.completed,true,JSON.stringify(reviewed.problems));
     await mkdir(join(config.root,'supplement-reviews'),{mode:0o700});
     const reference={store:reviews.store,path:reviewPath,sha256:hash(await readFile(reviewPath))};
     const locator=join(config.root,'supplement-reviews',compiled+'.json');
     await writeFile(locator,canonical({...reference,sha256:'0'.repeat(64)}));
     const rejected=await get('/api/project-secretary/conversations/'+conversationId);
     assert.equal(rejected.value.supplements[0].original.reason,'project_supplement_review_binding_changed');
     assert.equal(rejected.value.supplements[0].compiledRequest,null);
     await writeFile(locator,canonical(reference));
     const approvedReceipt=(await get('/api/project-secretary/conversations/'+conversationId)).value.supplements[0];
     assert.equal(approvedReceipt.original.ready,true,JSON.stringify(approvedReceipt.original));
     const priorInputs=(await readFile(f.trace,'utf8')).split('model-input').length-1;
     const processSupplements=ProjectChat.prototype.processSupplements;
     let failedKick=false;
     let retryError:unknown;
     t.mock.method(ProjectChat.prototype,'processSupplements',async function(this:ProjectChat,...args:Parameters<ProjectChat['processSupplements']>){
       if(args[1]?.source===target.source&&!failedKick){failedKick=true;throw new Error('fixture_supplement_temporarily_unavailable');}
       try{return await processSupplements.apply(this,args);}
       catch(error){if(args[1]?.source===target.source)retryError=error;throw error;}
     });
     const retry=()=>post('/api/project-secretary/supplement',{conversationId,requestId,target,text});
     assert.equal((await retry()).value.duplicate,true);
     await until(async()=>failedKick,Boolean);
     assert.equal((await retry()).value.duplicate,true);
     const activeSupplement=await until(
       async()=>{
         if(retryError)throw retryError;
         const receipt=(await get('/api/project-secretary/conversations/'+conversationId)).value.supplements[0];
         if(!receipt.compiledRequest&&receipt.original.reason)throw new Error(receipt.original.reason);
         return receipt;
       },
       row=>row.original.dispatchRecorded
     );
     assert.equal(activeSupplement.id,requestId);
     assert.equal(activeSupplement.original.adopted,true);
     assert.equal(activeSupplement.original.coveringCandidate,null);
     const underway=await detail(b);
     assert.equal(underway.draft.delivery.H,finished.draft.delivery.H);
     assert.equal(underway.resultStatus.current,false);
     assert.equal((await post('/api/project-work/'+b+'/explain',{H:finished.draft.delivery.H})).status,503);
     releaseSupplement();
     const failedSupplement=await until(()=>detail(b),r=>r.validationFailure?.eligible);
     assert.equal(failedSupplement.validationFailure.requestId,compiled);
     assert.equal(failedSupplement.validationFailure.tests.passed,false);
     assert.equal(failedSupplement.validationFailure.report.decision,'no_change');
     assert.equal(failedSupplement.resultStatus.current,false);
     assert.equal(failedSupplement.draft.delivery.H,finished.draft.delivery.H);
     assert.equal((await post('/api/project-work/'+b+'/correct-validation',{requestId:finished.draft.requestId})).status,503);
     assert.equal((await post('/api/project-work/'+b+'/correct-validation',{requestId:compiled})).status,202);
     const updated=await until(()=>detail(b),r=>r.draft.delivery?.status==='received'&&r.draft.delivery.H!==finished.draft.delivery.H);
     const delivered=(await get('/api/project-secretary/conversations/'+conversationId)).value.supplements[0];
     assert.equal(delivered.id,requestId);
     assert.equal(delivered.compiledRequest,compiled);
     assert.equal(delivered.original.delivered,true);
     assert.equal(delivered.original.adopted,true);
     assert.equal(delivered.original.recipient.work,cb.id);
     assert.equal(delivered.original.coveringCandidate,updated.draft.delivery.H);
     assert.equal(delivered.original.requirementSha256,hash(amendment));
     assert.equal(delivered.original.H0,finished.draft.delivery.H);
     const result=updated.execution.reports.find((report:any)=>report.id===compiled);
     assert.equal(result.tests.passed,true);
     assert.equal(result.originalValidationFailure.tests.passed,false);
     assert.deepEqual(result.tests.tools.map((tool:any)=>[tool.id,tool.exitCode]),[['work-acceptance',0],['supplement-'+hash(amendment).slice(0,20),0]]);
     const q=await QueueStore.open(cb.store);
     let successor;
     try{successor=q.issueImplementations().state(cb.id,compiled);}finally{q.close();}
     const successorWire=(await readFile(join(successor.plan.operationRoot,'implementer','stdin.ndjson'),'utf8')).trim().split('\n').map((line:string)=>JSON.parse(line));
     const input=JSON.parse(successorWire.find((message:any)=>message.method==='turn/start').params.input[0].text);
     assert.equal(input.request.continuation.supplement.text,text);
     assert.equal(input.request.continuation.logicalOwner,target.task);
     assert.deepEqual(successor.plan.authorization,resultState.plan.authorization);
     assert.equal(input.request.workflowPrompt,undefined);
     assert.equal(successor.plan.request.workflowPrompt.sha256,resultState.plan.request.workflowPrompt.sha256);
     assert.equal(delivered.original.recipient.sessionId,result.sessionId);
     assert.notEqual(result.sessionId,resultState.result.sessionId);
     assert.equal(await git(successor.plan.workspace,['rev-parse','HEAD^']),finished.draft.delivery.H);
     const before=await readFile(f.trace);
     assert.equal(before.toString().split('model-input').length-1,priorInputs+2);
     assert.equal((await post('/api/project-secretary/continue-supplements',{target})).status,202);
     assert.deepEqual(await readFile(f.trace),before);
     const laterId=randomUUID(),laterCompiled='supplement-'+laterId,laterText='Also mark corrected downloads.';
     const supplementReview=ProjectWork.prototype.supplementReview,begin=IssueImplementationControls.prototype.begin;
     t.mock.method(ProjectWork.prototype,'supplementReview',async function(this:ProjectWork,...args:Parameters<ProjectWork['supplementReview']>){
       if(args[0].requestId!==laterCompiled)return supplementReview.apply(this,args);
       assert.deepEqual([args[0].H1,args[0].text,args[0].target],[result.H1,laterText,target]);
       return {inputSha256:hash(laterText),reviewRun:reviewed.run,requirement:laterText,acceptance:['The marker is exported.'],
         validation:{description:'Check the marker',script:"import assert from 'node:assert/strict';import {correctedDownload} from './src/normalize.mjs';assert.equal(correctedDownload,true);"},replies:[]};
     });
     let pause=true;
     t.mock.method(IssueImplementationControls.prototype,'begin',async function(this:IssueImplementationControls,...args:Parameters<IssueImplementationControls['begin']>){
       if(args[1]===laterCompiled&&pause){pause=false;throw new Error('fixture_stopped_before_supplement_dispatch');}
       return begin.apply(this,args);
     });
     assert.equal((await post('/api/project-secretary/supplement',{conversationId,requestId:laterId,target,text:laterText})).status,202);
     await until(()=>detail(b),r=>!pause&&r.execution.requests.some((request:any)=>request.id===laterCompiled&&request.phase==='prepared'));
     assert.deepEqual(await readFile(f.trace),before);
     await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};
     await get('/api/github/projects');
     const saved=(await get('/api/project-secretary/conversations/'+conversationId)).value.supplements;
     assert.equal(saved.find((row:any)=>row.id===requestId).original.successful,true);
     assert.equal(saved.find((row:any)=>row.id===laterId).original.resumable,true);
     assert.equal((await post('/api/project-secretary/continue-supplements',{target})).status,202);
     const latest=await until(()=>detail(b),r=>r.resultStatus.current&&r.execution.reports.some((report:any)=>report.id===laterCompiled&&report.status==='completed'&&report.H1===r.draft.delivery?.H));
     const latestReport=latest.execution.reports.find((report:any)=>report.id===laterCompiled);
     assert.equal(latestReport.H0,result.H1);
     assert.equal((await readFile(f.trace,'utf8')).split('model-input').length-1,priorInputs+3);
     assert.equal(JSON.parse(await readFile(originals,'utf8')).length,2);
     assert.equal(await readFile(join(resultState.plan.operationRoot,'implementer','stdin.ndjson'),'utf8'),originalWire);
     assert.equal((await post('/api/project-work/'+b+'/explain',{H:finished.draft.delivery.H})).status,503);
     const explanation=await post('/api/project-work/'+b+'/explain',{H:latestReport.H1});assert.equal(explanation.status,202,JSON.stringify(explanation.value));
     const described=await until(()=>detail(b),value=>value.explanation?.state==='returned');
     assert.match(described.explanation.report,/tested download retention/);
     assert.equal(described.explanation.H,latestReport.H1);
     assert.equal(described.explanation.workflowRevision,successor.plan.request.workflowPrompt.revision);
     const afterExplanation=await readFile(f.trace);
     assert.equal((await post('/api/project-work/'+b+'/explain',{H:latestReport.H1})).value.sessionId,described.explanation.sessionId);
     assert.deepEqual(await readFile(f.trace),afterExplanation);
     const proposalRequest={requestId:randomUUID(),goal:'Show users when retained downloads expire.'};
     assert.equal((await post('/api/project-work/draft-issue',proposalRequest)).status,202);
     const proposed=await until(async()=>(await get('/api/project-work')).value.issueProposal,v=>v?.state==='ready');
     assert.match(proposed.body,/用户视角验收计划/);
     assert.match(proposed.body,/at the deadline and afterward/);
     assert.notEqual(proposed.authorSession,proposed.plannerSession);
     const afterProposal=await readFile(f.trace);
     assert.equal((await post('/api/project-work/draft-issue',proposalRequest)).value.bodySha256,proposed.bodySha256);
     assert.equal((await post('/api/project-work/draft-issue',{...proposalRequest,goal:'A changed goal.'})).status,503);
     assert.deepEqual(await readFile(f.trace),afterProposal);
     publishedIssueBody=proposed.body;
     const authored=await post('/api/project-work/create',{...first,requestId:randomUUID(),conversationId:randomUUID(),issueNumber:204});
     const authoredWork=authored.value.id,reviewRoute='/api/project-work/'+authoredWork+'/review-issue';
     assert.equal(authored.value.issueReviewRequired,true);
     assert.equal((await post('/api/project-work/'+authoredWork+'/prepare',{goal:proposalRequest.goal})).status,202);
     await wait(authoredWork,'prepared');
     assert.equal((await start(authoredWork)).value.error,'project_issue_review_approval_pending');
     const published={issueBodySha256:proposed.bodySha256};
     assert.equal((await post(reviewRoute,published)).value.error,'project_issue_review_second_company_required');
     assert.equal((await post('/api/ai-settings/scan',{})).status,200);
     assert.equal((await post('/api/ai-settings/role',{revision:0,role:'verifier_impact',choice:{providerId:hash(issuePeer!.binary),model:'fixture/model-next',effort:'future-depth'}})).status,200);
     assert.equal((await post(reviewRoute,{issueBodySha256:'0'.repeat(64)})).status,503);
     assert.equal((await post(reviewRoute,published)).status,202);
     const accepted=await until(()=>detail(authoredWork),value=>value.issueReview?.state==='returned');
     assert.equal(accepted.issueReview.approved,true);
     assert.equal(accepted.issueReview.issueBodySha256,proposed.bodySha256);
     assert.notEqual(accepted.issueReview.correctness.sessionId,accepted.issueReview.minimality.sessionId);
     const afterIssueReview=await readFile(f.trace);
     assert.equal((await post(reviewRoute,published)).value.approved,true);
     assert.deepEqual(await readFile(f.trace),afterIssueReview);
     assert.equal((await start(authoredWork)).status,202);
     const firstDelivery=await until(()=>detail(authoredWork),value=>value.draft.delivery?.status==='received');
     assert.equal(firstDelivery.execution.reports[0].tests.passed,true);
     assert.equal(ownerURLs.length,1);
     const workC=(await detail(c)).draft;
     const {title:titleC,...targetC}=((await get('/api/project-secretary')).value.supplementTargets as Array<Record<string,any>>).find(item=>item.source===workC.source)!;
     assert.match(titleC,/Issue #203/);
     const nativeSupplement={requestId:randomUUID(),conversationId:workC.conversationId,target:targetC,text};
     assert.equal((await post('/api/project-secretary/supplement',nativeSupplement)).status,202);
     const laterSupplement={...nativeSupplement,requestId:randomUUID(),conversationId:randomUUID(),text:'A later change to the same task.'};
     assert.equal((await post('/api/project-secretary/supplement',laterSupplement)).status,202);
     const outOfOrder=await post('/api/project-secretary/review-supplement',{requestId:laterSupplement.requestId});
     assert.equal(outOfOrder.value.error,'project_supplement_earlier_request_pending');
     assert.equal((await post('/api/project-secretary/cancel-supplement',{requestId:laterSupplement.requestId})).status,200);
     const planning=join(config.root,'supplement-planning','supplement-'+nativeSupplement.requestId),startNative=BoundedCodexSession.start;
     let stopBeforePlanningInput=true;
     t.mock.method(BoundedCodexSession,'start',async(options:Parameters<typeof startNative>[0])=>{
       if(stopBeforePlanningInput&&options.directory===join(planning,'preparation','native')){stopBeforePlanningInput=false;throw Error('fixture_prepare_failed_before_model');}
       return startNative.call(BoundedCodexSession,options);
     });
     const reviewNative=()=>post('/api/project-secretary/review-supplement',{requestId:nativeSupplement.requestId});
     const beforePreparation=await readFile(f.trace);
     assert.equal((await reviewNative()).status,202);
     const readNativeSupplement=async()=>(await get('/api/project-secretary/conversations/'+nativeSupplement.conversationId)).value.supplements.find((receipt:any)=>receipt.id===nativeSupplement.requestId);
     const retryable=await until(readNativeSupplement,value=>value.original.planning?.state==='ready_to_retry');
     assert.equal(retryable.original.canRequestReview,true);
     assert.equal(await exists(join(planning,'preparation','native','stdin.ndjson')),false);
     assert.deepEqual(await readFile(f.trace),beforePreparation);
     const firstPreparation=await readFile(join(planning,'preparation','input.json'));
     await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};
     await get('/api/github/projects');
     assert.equal((await readNativeSupplement()).original.planning.state,'ready_to_retry');
     assert.equal((await reviewNative()).status,202);
     const reviewedInWorkbench=await until(readNativeSupplement,value=>value.original.ready===true);
     assert.equal(reviewedInWorkbench.id,nativeSupplement.requestId);
     assert.deepEqual([reviewedInWorkbench.original.planning.openai.verdict,reviewedInWorkbench.original.planning.moonshot.verdict],['PASS','PASS']);
     const preparation=join(planning,'preparation-2');
     assert.deepEqual(await readFile(join(planning,'preparation','input.json')),firstPreparation);
     const frozenPreparation=JSON.parse(await readFile(join(preparation,'input.json'),'utf8'));
     assert.equal(frozenPreparation.preparationVersion,5);
     assert.equal(frozenPreparation.workflowPrompt.revision,successor.plan.request.workflowPrompt.revision);
     const preparationWire=(await readFile(join(preparation,'native','stdin.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
     assert.ok(preparationWire.find(message=>message.method==='thread/start').params.baseInstructions.startsWith(frozenPreparation.workflowPrompt.system+'\n\n'));
     assert.equal((await post('/api/project-secretary/continue-supplements',{target:targetC})).status,202);
     const covered=await until(readNativeSupplement,value=>!!value.original.coveringCandidate);
     assert.equal(covered.original.delivered,true);
     assert.equal(covered.original.adopted,true);
     assert.equal(covered.original.recipient.work,workC.source);
     assert.deepEqual(covered.original.planning,reviewedInWorkbench.original.planning);
     assert.notEqual(covered.original.coveringCandidate,unrelated.draft.delivery.H);
     const receiptC=await until(()=>detail(c),value=>value.draft.delivery?.H===covered.original.coveringCandidate&&value.execution.requests.every((r:any)=>!r.controllerActive));
     assert.equal(receiptC.execution.reports.at(-1).tests.passed,true);
     assert.equal(ownerURLs.length,1);
     const beforePreview=await readFile(f.trace);
     const advanceBase=async(path:string,text:string)=>{
       await writeFile(join(f.objects,path),text);
       await git(f.objects,['add','--',path]);
       await git(f.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','Advance the default branch in the fixture']);
       const base=await git(f.objects,['rev-parse','HEAD']);repository.defaultBranchRef.target.oid=base;
       await get('/api/github/projects');return base;
     };
     const previewRoute='/api/project-work/'+b+'/integration-preview';
     const nextBase=await advanceBase('upstream.md','Unrelated upstream change.\n'),withNewBase=await detail(b);
     assert.deepEqual([withNewBase.integrationSource.H0,withNewBase.integrationSource.H,withNewBase.integrationSource.B],[H,latestReport.H1,nextBase]);
     assert.equal((await post(previewRoute,{H:latestReport.H1,B:H})).status,503);
     const clean=await post(previewRoute,{H:latestReport.H1,B:nextBase});
     assert.equal(clean.value.state,'clean',JSON.stringify(clean.value));
     assert.match(clean.value.tree,/^[a-f0-9]{40}$/);
     assert.deepEqual((await detail(b)).integrationPreview,clean.value);
     const testRoute='/api/project-work/'+b+'/integration-verify';
     const combined=await post(testRoute,{H:latestReport.H1,B:nextBase});
     assert.equal(combined.value.state,'tested',JSON.stringify(combined.value));
     assert.notEqual(combined.value.H,latestReport.H1);
     assert.equal(combined.value.T,clean.value.tree);
     assert.deepEqual(combined.value.tests.tools.map((tool:any)=>tool.id),latestReport.tests.tools.map((tool:any)=>tool.id));
     assert.equal(combined.value.formalReview,'not_run');
     assert.deepEqual((await detail(b)).integrationValidation,combined.value);
     assert.equal((await detail(b)).explanationHead,combined.value.H);
     assert.equal((await post('/api/project-work/'+b+'/explain',{H:combined.value.H})).status,202);
     const combinedExplanation=await until(()=>detail(b),value=>value.explanation?.state==='returned');
     assert.equal(combinedExplanation.explanation.H,combined.value.H);
     const combinedInput=JSON.parse(await readFile(join(config.root,'works',b,'version-1','explanation-'+combined.value.H,'request.json'),'utf8')).material;
     assert.equal(combinedInput.candidate.B,nextBase);
     assert.equal(combinedInput.technicalEvidence.combination.implementation,latestReport.H1);
     assert.deepEqual(combinedInput.technicalEvidence.tested.tools,combined.value.tests.tools);
     const reviewCombination='/api/project-work/'+b+'/integration-review';
     assert.equal((await post(reviewCombination,{H:latestReport.H1,B:nextBase})).status,503);
     assert.equal((await post(reviewCombination,{H:combined.value.H,B:nextBase})).status,202);
     const combinedReview=await until(()=>detail(b),value=>value.integrationReview?.state!=='running'&&!!value.integrationReview);
     assert.equal(combinedReview.integrationReview.state,'returned',JSON.stringify(combinedReview.integrationReview));
     assert.equal(combinedReview.integrationReview.approved,true);
     assert.equal(combinedReview.integrationReview.correctness.exchanged.candidateH,combined.value.H);
     assert.equal(combinedReview.integrationReview.minimality.exchanged.candidateH,combined.value.H);
     const reviewDirectory=join(config.root,'works',b,'version-1','integration-preview-'+hash(canonical(combinedReview.integrationSource)).slice(0,32),'dual-review');
     const reviewInput=JSON.parse(await readFile(join(reviewDirectory,'request.json'),'utf8')).material;
     assert.match(reviewInput.integration.baseChanges,/Unrelated upstream change/);
     assert.equal(reviewInput.integration.originalBase,H);
     assert.equal(reviewInput.integration.base,nextBase);
     assert.match(reviewInput.integration.projectRules.find((rule:any)=>rule.path==='src/AGENTS.md').text,/Preserve the exact download boundary/);
     assert.ok(reviewInput.integration.affectedFiles.some((file:any)=>file.path==='src/normalize.mjs'));
     assert.equal(reviewInput.integration.affectedFiles.some((file:any)=>file.path==='src/caller.mjs'),false);
     assert.deepEqual(combinedReview.integrationReview.correctness.initial.coverageGaps,['source:src/caller.mjs']);
     const sourceRecord=join(reviewDirectory,'integration-sources.json'),readMore=JSON.parse(await readFile(sourceRecord,'utf8'));
     assert.deepEqual(readMore.map((file:any)=>[file.path,file.H]),[['src/caller.mjs',combined.value.H]]);
     await rename(sourceRecord,sourceRecord+'.missing');
     try{assert.equal((await detail(b)).integrationReview.state,'pending_or_unknown');}
     finally{await rename(sourceRecord+'.missing',sourceRecord);}
     const openInputs=await readFile(f.trace);
     assert.equal((await post(reviewCombination,{H:combined.value.H,B:nextBase})).value.state,'returned');
     assert.deepEqual(await readFile(f.trace),openInputs);
     const badBase=await advanceBase('src/index.mjs','export function normalizeLabel(){ return "changed by upstream"; }\n');
     assert.equal((await post(previewRoute,{H:latestReport.H1,B:badBase})).value.state,'clean');
     const failedCombination=await post(testRoute,{H:latestReport.H1,B:badBase});
     assert.equal(failedCombination.value.state,'failed',JSON.stringify(failedCombination.value));
     assert.equal(failedCombination.value.tests.executionHealthy,true);
     assert.notEqual(failedCombination.value.H,combined.value.H);
     assert.equal((await detail(b)).integrationValidation.state,'failed');
     const conflictingBase=await advanceBase('src/normalize.mjs','export function normalizeLabel(){return "upstream conflict";}\n');
     const conflict=await post(previewRoute,{H:latestReport.H1,B:conflictingBase});
     assert.equal(conflict.value.state,'conflicts',JSON.stringify(conflict.value));
     assert.ok(conflict.value.paths.includes('src/normalize.mjs'));
     assert.deepEqual((await detail(b)).integrationPreview,conflict.value);
     assert.equal(await git(f.objects,['rev-parse','HEAD']),conflictingBase);
     assert.equal(await git(f.objects,['rev-parse',updated.draft.delivery.branch]),latestReport.H1);
     assert.equal((await readFile(f.trace,'utf8')).split('model-input').length,beforePreview.toString().split('model-input').length+3);
     t.diagnostic(JSON.stringify({integrationTested:combined.value.H,base:nextBase,tree:combined.value.T,
       testTools:combined.value.tests.tools.map((tool:any)=>tool.id),integrationFailed:failedCombination.value.H,failedBase:badBase}));
     const cCatalog=receiptC.draft.catalog,entryC=JSON.parse(await readFile(cCatalog.path,'utf8')).entries[0],cQueue=await QueueStore.open(entryC.store);
     let currentC;
     try{currentC=cQueue.issueImplementations().requests(entryC.id).find(row=>row.result?.H1===receiptC.draft.delivery.H);}
     finally{cQueue.close();}
     assert.ok(currentC?.plan);
     const beforeC=receiptC.draft.delivery.H;
     const lateTarget={source:targetC.source,requestId:targetC.requestId,task:targetC.task,operation:targetC.operation};
     const lateText='Also mark corrected downloads.';
     const {formalFixture}=await import('../w5/formal-round-fixture.js');
     const {QueueFormalRoundHost}=await import('../../src/formal-review-host.js');
     const {sourceFixture}=await import('../events/source-fixture.js');
     const {sourceTick}=await import('../../src/event-tick.js');
     const {readEventSource}=await import('../../src/event-source.js');
     const formal=await formalFixture(t,'confirmed',false,false,{workspace:currentC.plan.workspace,H:beforeC,B:H,issue:receiptC.draft.issue});
     const formalProgram=await readFile(formal.n.config.codexExecutable,'utf8');
     const twoRepairs=formalProgram.replace('context.candidate??=context.material.candidate;',
       "context.candidate??=context.material.candidate;repairing||=context.stage==='authorized-repair';")
       .replace("f.text.includes('value=4')","f.text.includes('reviewedTwice=true')")
       .replace("text:'// repaired by synthetic agent fixture\\nexport const value=4;\\n'",
         "text:v.text.includes('value=4')?v.text+'export const reviewedTwice=true;\\n':'export const value=4;\\n'");
     assert.ok(twoRepairs.includes("v.text.includes('value=4')"));
     await writeFile(formal.n.config.codexExecutable,twoRepairs);
     const oldPeer=await readFile(issuePeer!.binary,'utf8');
     const dualSubject="if(responseKind==='message')output={candidateH:envelope.material.head,reviewedInputSha256:envelope.reviewedInputSha256,verdict:'PASS',report:'Explicit fixture independent minimum Issue review.',findings:[],coverageGaps:[],ownerQuestions:[]};";
     const dualPeer="if(responseKind==='message')output=envelope.batch?{candidateH:envelope.material.candidate.H,batchSha256:envelope.batch.sha256,report:'Explicit independent impact evidence',assessments:envelope.batch.findings.map(f=>({id:f.id,decision:'confirmed',report:'Fixture retained the registered evidence',evidence:['test.mjs']}))}:{candidateH:envelope.material.head??envelope.material.candidate.H,reviewedInputSha256:envelope.reviewedInputSha256??envelope.material.sha256,verdict:'PASS',report:'Explicit independent review fixture',findings:[],coverageGaps:[],ownerQuestions:[]};";
     assert.ok(oldPeer.includes(dualSubject));
     await writeFile(issuePeer!.binary,oldPeer.replace(dualSubject,dualPeer));
     const formalConfig=JSON.parse(await readFile(formal.catalog,'utf8'));
     formalConfig.entries[0].workflowContract='coding-loop-v2';
     await writeFile(formal.catalog,canonical(formalConfig));
     const combinedPlan=JSON.parse(await readFile(planPath,'utf8'));
     combinedPlan.sources=formal.sources.map(source=>({...source,title:'Ordinary work at its actual PR candidate'}));
     combinedPlan.formalReview={path:formal.catalog,sha256:hash(await readFile(formal.catalog))};
     await app.close();
     await writeFile(planPath,canonical(combinedPlan));
     app=await startWorkbench(planPath,undefined,{...dependencies,formalSourceReader:async()=>formal.live});
     url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};
     await get('/api/github/projects');
     const currentCWork=await detail(c);
     assert.equal(currentCWork.resultStatus.current,true);
     assert.equal(currentCWork.draft.delivery.H,beforeC);
     const formalRoute='/api/formal-review/'+formal.entry.id;
     const started=await post(formalRoute+'/prepare',{requestId:'ordinary-project-joined-review',projectWorkId:c,expectedCandidate:formal.live.candidate});
     assert.equal(started.status,200,JSON.stringify(started.value));
     const repairOperation=started.value.operation;
     const formalReport=(operation:string)=>get('/api/formal-review-report/'+formal.entry.id+'/'+operation);
     const joined={conversationId:currentCWork.draft.conversationId,requestId:randomUUID(),target:lateTarget,text:lateText};
     const joinedRow=async(id=joined.requestId)=>{
       const conversation=(await get('/api/project-secretary/conversations/'+joined.conversationId)).value;
       return conversation.supplements.find((row:any)=>row.id===id);
     };
     let enterFix=()=>{},resumeFix=()=>{};
     const enteredFix=new Promise<void>(resolve=>{enterFix=resolve;});
     const holdFix=new Promise<void>(resolve=>{resumeFix=resolve;});
     const available=QueueFormalRoundHost.prototype.fixAvailable;
     const pauseFirstFix=t.mock.method(QueueFormalRoundHost.prototype,'fixAvailable',async function(this:InstanceType<typeof QueueFormalRoundHost>){
       const result=await available.call(this);
       if(result.available){enterFix();await holdFix;}
       return result;
     });
     assert.equal((await post(formalRoute+'/start',{operation:repairOperation})).status,202);
     try{
       await Promise.race([enteredFix,until(()=>formalReport(repairOperation),r=>!r.value.controllerActive).then(()=>assert.fail('formal repair did not reach its original inbox'))]);
       assert.equal((await post('/api/project-secretary/supplement',joined)).status,202);
       assert.equal((await joinedRow()).original.delivered,false);
     }finally{resumeFix();pauseFirstFix.mock.restore();}
     const firstRepair=(await until(()=>formalReport(repairOperation),r=>!r.value.controllerActive&&r.value.phase==='awaiting_publication')).value.result.fix;
     assert.equal(firstRepair.H0,beforeC);assert.notEqual(firstRepair.H1,beforeC);assert.equal(firstRepair.tested.passed,true);
     const firstFormalDelivery=await joinedRow();
     assert.equal(firstFormalDelivery.original.recipient.sessionId,firstRepair.sessionId);
     assert.deepEqual([firstFormalDelivery.original.delivered,firstFormalDelivery.original.adopted,firstFormalDelivery.original.coveringCandidate],[true,false,null]);
     const remote=await sourceFixture(t,'fixture/reception');
     formal.q.events().configure(Buffer.from(canonical(remote.profile)));
     const publishRepair=async(fix:any)=>{
       await remote.change({H:fix.H1,B:H,target:formal.live.candidate.target,body:fix.proposedPRBody});
       await git(formal.entry.objects,['fetch','--no-tags',fix.workspace,fix.H1]);
       await formal.packet({H:fix.H1,B:H,sourceAt:new Date().toISOString(),executionAt:new Date().toISOString()});
       await sourceTick(formal.store);
       formal.live.candidate.H=fix.H1;
       formal.live.observation=await readEventSource(remote.profile,formal.live.candidate.pr,join(remote.root,'ordinary-joined-'+fix.H1));
       const check=await post(formalRoute+'/check',{});
       assert.equal(check.status,200,JSON.stringify(check.value));
     };
     const formalSuccessor=async(operation:string)=>(await get('/api/formal-review')).value.entries[0]?.requests.find((review:any)=>review.previousOperation===operation);
     await publishRepair(firstRepair);
     const intermediate=await until(()=>formalSuccessor(repairOperation),review=>review?.phase==='awaiting_publication'&&!review.controllerActive);
     const repair=(await formalReport(intermediate.operation)).value.result.fix;
     assert.equal(repair.H0,firstRepair.H1);assert.notEqual(repair.H1,firstRepair.H1);assert.equal(repair.tested.passed,true);
     assert.notEqual(firstRepair.sessionId,repair.sessionId);
     await publishRepair(repair);
     await until(()=>formalSuccessor(intermediate.operation),review=>review?.phase==='pass'&&!review.controllerActive);
     const fresh={...joined,requestId:randomUUID(),text:'Fresh supplement after both repairs.'};
     assert.equal((await post('/api/project-secretary/supplement',fresh)).status,202);
     const freshState=await joinedRow(fresh.requestId);
     assert.equal(freshState.original.continuationBase,repair.H1);
     assert.equal(freshState.original.delivered,false);
     assert.equal((await post('/api/project-secretary/cancel-supplement',{requestId:fresh.requestId})).status,200);
     const needsReview=await joinedRow();
     assert.equal(needsReview.original.continuationBase,repair.H1);
     assert.equal(needsReview.original.recipient.sessionId,firstRepair.sessionId);
     const beforeEvidence=join(formal.q.formalReviews().state(repairOperation).request.directory,'round-1-correctness-initial','stdout.ndjson');
     await rename(beforeEvidence,beforeEvidence+'.missing');
     try{
       const blocked=await joinedRow();
       assert.equal(blocked.original.reason,'formal_repair_supplement_lineage_pending',JSON.stringify(blocked));
       assert.equal(blocked.original.ready,false);
       assert.equal((await post('/api/project-secretary/review-supplement',{requestId:joined.requestId})).status,503);
       assert.equal((await post('/api/project-secretary/continue-supplements',{target:lateTarget})).status,202);
       assert.equal((await joinedRow()).compiledRequest,null);
     }finally{await rename(beforeEvidence+'.missing',beforeEvidence);}
     assert.equal((await post('/api/project-secretary/review-supplement',{requestId:joined.requestId})).status,202);
     const readyJoined=await until(()=>joinedRow(),row=>row?.original?.ready===true);
     assert.equal(readyJoined.original.adopted,false);
     assert.equal((await post('/api/project-secretary/continue-supplements',{target:lateTarget})).status,202);
     const finishedJoined=await until(()=>joinedRow(),row=>!!row?.original?.coveringCandidate);
     const cFinal=await until(()=>detail(c),value=>value.resultStatus.current&&value.draft.delivery.H===finishedJoined.original.coveringCandidate);
     const joinedReport=cFinal.execution.reports.find((row:any)=>row.H1===cFinal.draft.delivery.H);
     assert.equal(joinedReport.H0,repair.H1);
     assert.equal(joinedReport.tests.tools.some((tool:any)=>tool.id==='fixture-node-tests'),true);
     assert.equal(finishedJoined.original.originalFormalDelivery.recipient.sessionId,firstRepair.sessionId);
     assert.match(await git(repair.workspace,['show',repair.H1+':sample.js']),/reviewedTwice=true/);
     t.diagnostic(JSON.stringify({formalHistory:[beforeC,firstRepair.H1,repair.H1],repairSessions:[firstRepair.sessionId,repair.sessionId],request:joined.requestId,
       recipient:finishedJoined.original.recipient,adopted:finishedJoined.original.requirementSha256,covered:cFinal.draft.delivery.H}));
     t.diagnostic(JSON.stringify({approvedOnce:ownerURLs.length,A:{work:a,issue:201,stopped:true},B:{work:b,issue:202,originalH1:finished.draft.delivery.H,revisedH1:result.H1,requestId,recipient:delivered.original.recipient,adoptedRequirement:hash(amendment),reviewRun:reviewed.run},C:{work:c,issue:203,H1:unrelated.draft.delivery.H},shared:{requestId:shared.requestId,savedTargets:linked.map((row:any)=>row.target.source)},bothRegisteredTests:result.tests.tools.map((tool:any)=>tool.id),integration:{original:H,candidate:latestReport.H1,cleanBase:nextBase,tree:clean.value.tree,conflictingBase,conflictPaths:conflict.value.paths}}));
   }finally{for(const open of release.values())open();releaseSupplement();}
   return;
 }
 if(fault==='preparation-typed-retry'){
   const scope={account,repository:{id:1,nodeId:'R_FIRST',fullName:'fixture/reception',defaultHead:H},generation:1} as any,store=await ProjectWorkStore.open(config.root),draft=store.get(scope,first.requestId),directory=join(config.root,'works',first.requestId,'version-1','preparation');await mkdir(directory,{recursive:true});
   const source={path:f.objects,H,repository:'fixture/reception'},T=await git(f.objects,['rev-parse',H+'^{tree}']),validationEnvironment=await prepareWorkEnvironment(docker,join(directory,'environment'),H,T,{start:effect=>effect()}),input={kind:'project_work_engineering_preparation',preparationVersion:3,source,issue:draft.issue,userGoal:first.goal,files:[],validationEnvironment,validationInvocation:workValidationInvocation(docker.node),materialBudgets:workPreparationBudgets},bytes=canonical(input);await writeFile(join(directory,'input.json'),bytes);
   const candidate={kind:'local-git' as const,repository:'local/project-work-preparation',pr:null,H,B:H,target:'preparation'},session=await BoundedCodexSession.start({executable:f.config.codexExecutable,directory:join(directory,'native'),operation:directory,candidate,role:'verifier_fact',projectPreparation:true,system:workPreparationInstructionsV3,inputManifestSha256:hash(bytes),scopeSource:'Synthetic old preparation',arrangementSource:'Read-only historical tuple fixture',disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:10000,executionKind:'fixture',beforeTurn:async()=>{},gate:{check:async()=>{},call:async()=>({success:true,contentItems:[{type:'inputText',text:'{}'}]})}});try{await session.turn(bytes,candidate,findingSchema);}finally{await session.close();}
   store.save(scope,{...draft,version:1,stage:'needs_input',problem:'project_work_proposal_json_invalid',preparation:{directory,H,repositoryPath:f.objects,inputSha256:hash(bytes),verification:docker,pid:process.pid}},draft.revision);assert.throws(()=>store.get({...scope,account:{...account,id:999}},draft.id),/outside_project/);store.close();
   const before=await readFile(join(directory,'native/completed.json'));await get('/api/project-work/'+draft.id);assert.equal((await post('/api/project-work/'+draft.id+'/prepare',{goal:first.goal})).status,202);await wait(draft.id,'prepared');const next=(await get('/api/project-work/'+draft.id)).value,input2=JSON.parse(await readFile(join(next.draft.preparation.directory,'input.json'),'utf8'));
   assert.equal(next.draft.version,2);assert.equal(input2.preparationVersion,4);assert.equal(input2.previousPreparation.report,rejectedLegacyReport);assert.equal(input2.previousPreparation.reportSha256,hash(rejectedLegacyReport));assert.equal(input2.previousPreparation.captureSha256,hash(before));assert.equal(next.draft.catalog==null,true);assert.equal(ownerURLs.length,0);assert.equal(JSON.parse(await readFile(originals,'utf8')).length,0);assert.deepEqual(await readFile(join(directory,'native/completed.json')),before);
   const trace=await readFile(f.trace);await get('/api/project-work/'+draft.id);await get('/api/project-work/'+draft.id);assert.deepEqual(await readFile(f.trace),trace);
   // The immediately preceding ready V4 cannot be skipped to reuse old V3.
   assert.equal((await post('/api/project-work/'+draft.id+'/prepare',{goal:first.goal})).status,202);await wait(draft.id,'needs_input');const newest=(await get('/api/project-work/'+draft.id)).value,input3=JSON.parse(await readFile(join(newest.draft.preparation.directory,'input.json'),'utf8'));assert.equal(newest.draft.version,3);assert.equal(input3.previousPreparation.omitted,'project_work_previous_already_prepared');assert.equal(input3.previousPreparation.report,undefined);assert.equal(ownerURLs.length,0);assert.equal(newest.draft.catalog==null,true);assert.equal((await post('/api/project-work/'+draft.id+'/prepare',{goal:first.goal})).status,202);await wait(draft.id,'prepared');const final=(await get('/api/project-work/'+draft.id)).value,input4=JSON.parse(await readFile(join(final.draft.preparation.directory,'input.json'),'utf8'));assert.equal(final.draft.version,4);assert.equal(input4.previousPreparation.report,newest.draft.preparation.proposal.report);assert.equal(input4.previousPreparation.report.includes(newest.draft.preparation.proposal.validation.script),false);assert.notEqual(input4.previousPreparation.report,rejectedLegacyReport);assert.equal(ownerURLs.length,0);assert.equal(final.draft.catalog==null,true);return;
 }
 let secondWorkId='';
 for(const n of [201,202]){
   if(fault==='implementation-ai'&&n===202)await chooseImplementer('fixture-astra');
   let id=first.requestId;if(n===202){const second=await post('/api/project-work/create',{...first,requestId:randomUUID(),issueNumber:n});assert.equal(second.status,200);id=second.value.id;secondWorkId=id;}
   assert.equal((await post('/api/project-work/'+id+'/prepare',{goal:first.goal})).status,202);
   if(fault==='preparation-questions'){
     await wait(id,'needs_input');const rejected=(await get('/api/project-work/'+id)).value,originalDirectory=rejected.draft.preparation.directory,original=await readFile(join(originalDirectory,'native/stdout.ndjson')),trace=await readFile(f.trace);
     assert.equal(rejected.draft.problem,'controlled_result_not_final:non_terminal_agent_message');assert.equal(rejected.draft.preparation.proposal==null,true);assert.equal(rejected.draft.catalog==null,true);assert.equal(await exists(join(originalDirectory,'native/completed.json')),false);assert.equal(rejected.preparationDiagnostic.accepted,false);assert.equal(rejected.preparationDiagnostic.questions.length,1);
     await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');
     assert.deepEqual((await get('/api/project-work/'+id)).value.preparationDiagnostic,rejected.preparationDiagnostic);assert.deepEqual(await readFile(f.trace),trace);
     assert.equal((await post('/api/project-work/'+id+'/prepare',{goal:'Explicit answer for the same work next version.'})).status,202);await wait(id,'prepared');const next=(await get('/api/project-work/'+id)).value;assert.equal(next.draft.version,2);assert.equal(next.history[0].version,1);assert.deepEqual(next.history[0].preparationDiagnostic,rejected.preparationDiagnostic);assert.deepEqual(await readFile(join(originalDirectory,'native/stdout.ndjson')),original);assert.equal(JSON.parse(await readFile(originals,'utf8')).length,0);assert.equal((await readFile(f.trace,'utf8')).split('model-input').length-1,2);return;
   }
   await wait(id,'prepared');let detail=(await get('/api/project-work/'+id)).value;
   if(fault==='validation-restart-current'){await post('/api/project-work/'+id+'/recheck',{});await wait(id,'prepared');detail=(await get('/api/project-work/'+id)).value;assert.ok(detail.draft.currentCheck);}
   if(fault==='expiry-a'){
     const scoped={account,repository:{id:1,nodeId:'R_FIRST',fullName:'fixture/reception',defaultHead:H},generation:1} as any,store=await ProjectWorkStore.open(config.root),d=store.get(scoped,id),oldAt=new Date(Date.now()-2*86400000).toISOString();store.save(scoped,{...d,preparation:{...d.preparation!,observedAt:oldAt}},d.revision);store.close();
     const before=(await readFile(f.trace,'utf8')).split('model-input').length-1,original=await readFile(join(d.preparation!.directory,'native/completed.json'));
     assert.equal((await post('/api/project-work/'+id+'/start',{version:d.version,proposalSha256:detail.draft.preparation.proposalDigest})).value.error,'project_work_preparation_expired_recheck');
     await post('/api/project-work/'+id+'/recheck',{});await wait(id,'prepared');detail=(await get('/api/project-work/'+id)).value;assert.ok(detail.draft.currentCheck);assert.equal(detail.draft.preparation.observedAt,oldAt);assert.deepEqual(await readFile(join(d.preparation!.directory,'native/completed.json')),original);assert.equal((await readFile(f.trace,'utf8')).split('model-input').length-1,before);
     const check=JSON.parse(await readFile(detail.draft.currentCheck.path,'utf8')),methods=(await readFile(join(check.binding.metadataDirectory,'stdin.ndjson'),'utf8')).trim().split('\n').map(x=>JSON.parse(x).method);assert.deepEqual(methods,['initialize','initialized','account/read','config/read','account/rateLimits/read']);const savedNow=Date.now;try{Date.now=()=>Date.parse(check.expiresAt)+1;assert.throws(()=>assertWorkCurrent(detail.draft.currentCheck),/expired/);Date.now=()=>Date.parse(check.observedAt)-60001;assert.throws(()=>assertWorkCurrent(detail.draft.currentCheck),/expired/);}finally{Date.now=savedNow;}const sealed=await readFile(detail.draft.currentCheck.path);await writeFile(detail.draft.currentCheck.path,'{}');assert.equal((await post('/api/project-work/'+id+'/start',{version:detail.draft.version,proposalSha256:detail.draft.preparation.proposalDigest})).status,503);await writeFile(detail.draft.currentCheck.path,sealed);
   }
   assert.deepEqual(detail.draft.preparation.proposal.allowedPaths,proposal.allowedPaths);const confirm={version:detail.draft.version,proposalSha256:detail.draft.preparation.proposalDigest};
   if(fault==='expiry-a'){
     const preview=ProjectWork.prototype.confirmation,start=ProjectWork.prototype.start;let starts=0;
     // An active snapshot may arrive after the observed job has finished.
     ProjectWork.prototype.confirmation=async()=>({active:true,alreadyAuthorized:undefined,currentCheckSha256:undefined});ProjectWork.prototype.start=async function(...args){starts++;return start.apply(this,args);};
     try{const active=await post('/api/project-work/'+id+'/start',confirm);assert.equal(active.status,202);assert.equal(active.value.active,true);assert.equal(starts,0);assert.equal(ownerURLs.length,0);assert.equal(JSON.parse(await readFile(originals,'utf8')).length,0);assert.equal((await readFile(f.trace,'utf8')).split('model-input').length-1,1);}finally{ProjectWork.prototype.confirmation=preview;ProjectWork.prototype.start=start;}
   }
   const start=await post('/api/project-work/'+id+'/start',confirm);assert.equal(start.status,202);assert.equal(start.value.waitingForOwner,true);const ownerURL=new URL(ownerURLs.at(-1)!),capability=ownerURL.hash.slice(1);assert.equal(JSON.stringify(start.value).includes(capability),false);
   assert.equal((await get('/api/project-owner')).status,401);const ownerHeaders={Authorization:'Owner '+capability,Origin:url.origin,'Content-Type':'application/json'};const rejected=await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:{...ownerHeaders,Origin:'https://untrusted.invalid'},body:'{}'});assert.equal(rejected.status,403);
   if(fault&&fault!=='receipt-pending'&&!validationFault&&!readonlyFault&&fault!=='implementation-ai'&&fault!=='literal-large'){const hold=fault.startsWith('stop-')?fault.slice(5):fault==='drain'?'adopt-comments':null;await writeFile(originals+'.fault',JSON.stringify(hold?{hold}:fault==='unknown-adopt'?{unknown:true}:{lose:fault==='lost-delegate'?2:1}));if(hold)await writeFile(originals+'.hold','1');}
   const spawn=childProcess.spawn;let receiptFailures=0;
   const resultDirectory=join(config.root,'works',id,'version-1'),resultWorkspace=join(resultDirectory,'result');
   if(fault==='receipt-pending'){
     childProcess.spawn=((command:any,args:any,options:any)=>{if(command==='/usr/bin/git'&&args.includes(resultWorkspace)&&args.includes('checkout')){receiptFailures++;throw Error('fixture_receipt_checkout_interruption');}return spawn(command,args,options);}) as typeof spawn;syncBuiltinESMExports();
     t.after(()=>{childProcess.spawn=spawn;syncBuiltinESMExports();});
   }
   const restartAndAssert=async(failed:any,old:any,q:QueueStore,store:string)=>{
       const originalGrant=await readFile(join(old.plan.request.workspaceRequest.executionRoot,'grant.json')),originalPlan=await readFile(old.plan.path),originalWip=await tree(old.plan.workspace,true),originalRequest=old.requestSha256;
       if(fault==='validation-restart'){
         const beforeRefusal=await readFile(f.trace),idle=async()=>{for(let i=0;i<1000;i++){const w=(await get('/api/project-work')).value.works.find((w:any)=>w.id===id);if(!w.active&&w.problem)return;await new Promise(r=>setTimeout(r,10));}throw Error('restart_refusal_timeout');};
         const corrupt=[join(old.plan.workspace,'src/normalize.mjs'),join(old.plan.workspace,'test/normalize.test.mjs'),join(old.validationFailure.nativeDirectory,'completed.json'),join(old.plan.operationRoot,'attempt-1/post-repair-1/result.json'),old.plan.path];
         for(const path of corrupt){const bytes=await readFile(path);await writeFile(path,path.endsWith('.mjs')?Buffer.concat([bytes,Buffer.from('\n// foreign edit\n')]):Buffer.from('{}'));await post('/api/project-work/'+id+'/restart-failure',{});await idle();assert.equal((await get('/api/project-work/'+id)).value.draft.version,1);assert.equal(q.issueImplementations().state(old.source,old.id).result,null);assert.equal(await exists(join(old.plan.workspace,'.git/tongxu-writer.json')),true);assert.deepEqual(await readFile(f.trace),beforeRefusal);await writeFile(path,bytes);}
         const proof=await observeValidationFailure(q.issueImplementations().state(old.source,old.id));await checkValidationWorkspace(proof,true);const path=join(old.plan.workspace,'src/normalize.mjs'),bytes=await readFile(path);await writeFile(path,Buffer.concat([bytes,Buffer.from('\n// changed after asynchronous proof\n')]));assert.throws(()=>q.issueImplementations().closeValidationFailure(old.source,old.id,proof),/tree_changed/);await writeFile(path,bytes);assert.equal(q.issueImplementations().state(old.source,old.id).result,null);
         const indexPath=join(old.plan.workspace,'.git/index'),index=await readFile(indexPath);await git(old.plan.workspace,['update-index','--force-remove','README.md']);await post('/api/project-work/'+id+'/restart-failure',{});await idle();await writeFile(indexPath,index);
         const db=new DatabaseSync(join(store,'queue.sqlite'));try{db.prepare('INSERT INTO meta VALUES(?,?)').run('resource-ledger:restart-probe','{}');await post('/api/project-work/'+id+'/restart-failure',{});await idle();assert.equal(q.issueImplementations().state(old.source,old.id).result,null);db.prepare('DELETE FROM meta WHERE key=?').run('resource-ledger:restart-probe');}finally{db.close();}assert.deepEqual(await readFile(f.trace),beforeRefusal);
       }
       const saveDraft=ProjectWorkStore.prototype.save,closeFailure=IssueImplementations.prototype.closeValidationFailure,closeReadonly=IssueImplementations.prototype.closeReadonlyFailure,crashFault=fault?.replace(/^readonly-/, 'validation-restart-');let crash=false;
       if(fault==='readonly-terminal')IssueImplementations.prototype.closeReadonlyFailure=function(...args){const result=closeReadonly.apply(this,args);if(!crash){crash=true;throw Error('fixture_after_readonly_terminal');}return result;};
       if(fault==='validation-restart-terminal')IssueImplementations.prototype.closeValidationFailure=function(...args){const result=closeFailure.apply(this,args);if(!crash){crash=true;throw Error('fixture_after_terminal');}return result;};
       if(['validation-restart-intent','validation-restart-release','validation-restart-version','validation-restart-check'].includes(crashFault!))ProjectWorkStore.prototype.save=function(...args){const kind=args[1].events.at(-1)?.kind,hit=kind===({'validation-restart-intent':'failure_restart_requested','validation-restart-release':'failed_work_successor_prepared','validation-restart-version':'failed_work_successor_prepared','validation-restart-check':'current_check_completed'} as Record<string,string>)[crashFault!];if(hit&&!crash&&crashFault==='validation-restart-release'){crash=true;throw Error('fixture_before_successor');}const result=saveDraft.apply(this,args);if(hit&&!crash){crash=true;throw Error('fixture_after_saved_boundary');}return result;};
       t.after(()=>{ProjectWorkStore.prototype.save=saveDraft;IssueImplementations.prototype.closeValidationFailure=closeFailure;IssueImplementations.prototype.closeReadonlyFailure=closeReadonly;});
       const restart=await post('/api/project-work/'+id+'/restart-failure',{});assert.equal(restart.status,202,JSON.stringify(restart));
       if(['validation-restart-intent','validation-restart-terminal','validation-restart-release','validation-restart-version','validation-restart-check'].includes(crashFault!)){
         for(let i=0;i<1000;i++){const v=(await get('/api/project-work')).value.works.find((w:any)=>w.id===id);if(!v.active&&v.problem)break;await new Promise(r=>setTimeout(r,20));}assert.equal(crash,true);ProjectWorkStore.prototype.save=saveDraft;IssueImplementations.prototype.closeValidationFailure=closeFailure;IssueImplementations.prototype.closeReadonlyFailure=closeReadonly;
         const pending=(await get('/api/project-work/'+id)).value,identity=pending.draft.restart;assert.ok(identity);await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');await post('/api/project-work/'+id+'/restart-failure',{});await wait(id,'prepared');assert.deepEqual((await get('/api/project-work/'+id)).value.draft.restart,identity);
       }
       await wait(id,'prepared');const next=(await get('/api/project-work/'+id)).value;
       assert.equal(next.draft.version,2);assert.ok(next.draft.currentCheck);assert.equal(next.history[0].execution.reports[0].status,'failed');assert.equal(next.history[0].execution.reports[0].H1,null);assert.equal((await readFile(f.trace,'utf8')).split('model-input').length-1,2);
       const ended=q.issueImplementations().state(old.source,old.id);assert.equal(ended.result.status,'failed');assert.equal(ended.requestSha256,originalRequest);assert.deepEqual(await readFile(old.plan.path),originalPlan);assert.deepEqual(await readFile(join(old.plan.request.workspaceRequest.executionRoot,'grant.json')),originalGrant);assert.deepEqual(await tree(old.plan.workspace,true),originalWip);assert.equal(await exists(join(old.plan.workspace,'.git/tongxu-writer.json')),false);
       const beforeNext=await readFile(f.trace);await post('/api/project-work/'+id+'/restart-failure',{});await wait(id,'prepared');assert.equal((await get('/api/project-work/'+id)).value.draft.version,2);assert.deepEqual(await readFile(f.trace),beforeNext);
       const nextStart=await post('/api/project-work/'+id+'/start',{version:2,proposalSha256:next.draft.preparation.proposalDigest});assert.equal(nextStart.value.waitingForOwner,true);const token=new URL(ownerURLs.at(-1)!).hash.slice(1);assert.equal((await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:{Authorization:'Owner '+token,Origin:url.origin,'Content-Type':'application/json'},body:'{}'})).status,202);
       let done:any,zeroClosing=false;for(let i=0;i<3000;i++){const v=(await get('/api/project-work/'+id)).value;if(fault==='readonly-zero-failed'&&!zeroClosing&&v.execution?.requests[0]?.reason==='executor_wait_timeout'&&!v.execution.requests[0].controllerActive){zeroClosing=true;await post('/api/project-work/'+id+'/restart-failure',{});}if(v.execution?.requests[0]?.phase==='returned'&&!v.execution.requests[0].controllerActive&&(['validation-restart-failed','readonly-zero-failed'].includes(fault!)||v.draft.delivery?.status==='received')){done=v;break;}if(fault!=='readonly-zero-failed'&&v.execution?.requests[0]?.reason&&!v.execution.requests[0].controllerActive&&v.execution.requests[0].phase!=='returned')throw Error(v.execution.requests[0].reason);await new Promise(r=>setTimeout(r,25));}assert.ok(done,'new zero-round initial must settle');
       const catalog=JSON.parse(await readFile(done.draft.catalog.path,'utf8')),entry=catalog.entries[0],nextQueue=await QueueStore.open(entry.store);try{const state=nextQueue.issueImplementations().state(entry.id,done.draft.requestId),grant=JSON.parse(await readFile(join(state.plan.request.workspaceRequest.executionRoot,'grant.json'),'utf8'));assert.equal(state.plan.request.workspaceRequest.authorization.maxRepairRounds,0);assert.equal(grant.maxRepairRounds,0);const rejectedRoot=join(f.root,'general-zero'),rejectedRequest=join(f.root,'general-zero.json');await writeFile(rejectedRequest,canonical({...state.plan.request.workspaceRequest,executionRoot:rejectedRoot}));await assert.rejects(prepareProjectRepair(entry.config.path,rejectedRequest,rejectedRoot),/project_authorization_required/);assert.throws(()=>nextQueue.issueImplementations().requireValidationBudget(entry.id,state.id),/empty_budget/);assert.equal(state.result.status,['validation-restart-failed','readonly-zero-failed'].includes(fault!)?'failed':'completed');if(fault==='readonly-zero-failed'){assert.equal(state.result.H1,null);assert.equal(state.result.failureKind,'ended_readonly_timeout');assert.equal(state.result.hostEvidenceComplete,true);assert.equal(await exists(join(state.plan.workspace,'.git/tongxu-writer.json')),false);}if(fault==='validation-restart-failed'){assert.equal(state.result.H1,null);assert.equal(await exists(join(state.plan.workspace,'.git/tongxu-writer.json')),false);const p=await observeValidationFailure(state),input='no dispatch';await assert.rejects(runValidationCorrection(p,state.plan.request,{failureSha256:hash(canonical(p.record)),inputSha256:hash(input),nativeDirectory:join(state.plan.operationRoot,'validation-correction/native')},input,state.firstInputContinuation,{refresh:async()=>{},unsent:()=>{},check:()=>{},dispatch:()=>{throw Error('must_not_dispatch');}}),/implementation_validation_binding_changed/);}}
       finally{nextQueue.close();}
       if(fault==='validation-restart'){
         const target=(await get('/api/project-secretary')).value.supplementTargets.find((x:any)=>x.source===done.draft.source&&x.requestId===done.draft.requestId);assert.ok(target);const {title,...identity}=target;
         assert.equal((await post('/api/project-secretary/supplement',{conversationId:first.conversationId,requestId:randomUUID(),target:identity,text:'Explain the preserved fallback with one scoped comment after the zero-round initial.'})).status,202);
         let supplemented=false;for(let i=0;i<1000;i++){const v=(await get('/api/project-work/'+id)).value;if(v.execution.requests.length===2&&v.execution.requests.every((r:any)=>r.phase==='returned'&&!r.controllerActive)&&v.draft.delivery?.H===v.execution.reports[1]?.H1){supplemented=true;break;}if(v.execution.requests.at(-1)?.reason&&!v.execution.requests.at(-1)?.controllerActive)throw Error(v.execution.requests.at(-1).reason);await new Promise(r=>setTimeout(r,25));}assert.equal(supplemented,true);
         const q2=await QueueStore.open(entry.store);try{const extra=q2.issueImplementations().requests(entry.id).at(-1);assert.ok(extra);assert.equal(extra.plan.request.workspaceRequest.authorization.maxRepairRounds,1);}finally{q2.close();}
       }
       const inputs=await readFile(f.trace);await post('/api/project-work/'+id+'/prepare',{goal:first.goal});await post('/api/project-work/'+id+'/correct-validation',{});await get('/api/project-work/'+id);assert.equal((await get('/api/project-work/'+id)).value.draft.version,2);assert.deepEqual(await readFile(f.trace),inputs);const fresh=await post('/api/project-work/create',{...first,requestId:randomUUID(),conversationId:randomUUID(),newWork:true});assert.equal(fresh.status,200);assert.notEqual(fresh.value.id,id);return;
   };
   const approval=await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:ownerHeaders,body:'{}'});assert.equal(approval.status,202);
   if(readonlyFault){
     let ended:any;for(let i=0;i<2000;i++){const v=(await get('/api/project-work/'+id)).value;if(v.execution?.requests[0]?.reason==='executor_wait_timeout'&&!v.execution.requests[0].controllerActive){ended=v;break;}await new Promise(r=>setTimeout(r,20));}assert.ok(ended);assert.equal(ended.execution.requests[0].completeCapture,false);assert.equal(ended.execution.requests[0].phase,'active_or_unknown');
     const versionRoot=join(config.root,'works',id,'version-1'),store=join(versionRoot,'queue'),q=await QueueStore.open(store);t.after(()=>q.close());const old=q.issueImplementations().state(ended.draft.source,ended.draft.requestId),audit=()=>{const db=new DatabaseSync(join(store,'queue.sqlite'),{readOnly:true});try{return (db.prepare("SELECT * FROM events WHERE kind LIKE 'issue_implementation_readonly_%' ORDER BY id").all() as any[]).map(e=>({...e,data:JSON.parse(e.data).value}));}finally{db.close();}};
     const idle=async()=>{for(let i=0;i<1000;i++){const w=(await get('/api/project-work')).value.works.find((w:any)=>w.id===id);if(!w.active&&w.problem)return;await new Promise(r=>setTimeout(r,10));}throw Error('readonly_refusal_timeout');};
     if(['readonly-flags','readonly-wire','readonly-nonread'].includes(fault!)){
       const trace=await readFile(f.trace),wire=join(old.plan.operationRoot,'implementer/stdout.ndjson'),original=await readFile(wire);
       if(fault==='readonly-flags')await git(old.plan.workspace,['update-index','--assume-unchanged','src/normalize.mjs']);if(fault==='readonly-wire')await writeFile(wire,Buffer.concat([original,Buffer.from('{"method":"unknown/notification","params":{}}\n')]));
       await post('/api/project-work/'+id+'/restart-failure',{});await idle();const refused=q.issueImplementations().state(old.source,old.id);assert.equal(refused.result,null);assert.equal((await get('/api/project-work/'+id)).value.draft.version,1);assert.equal(await exists(join(old.plan.workspace,'.git/tongxu-writer.json')),true);assert.equal(audit().filter((e:any)=>e.kind==='issue_implementation_readonly_check_rejected').at(-1).data.permanent,true);
       if(fault==='readonly-flags')await git(old.plan.workspace,['update-index','--no-assume-unchanged','src/normalize.mjs']);if(fault==='readonly-wire')await writeFile(wire,original);
       const checks=audit().filter((e:any)=>e.kind==='issue_implementation_readonly_check_started').length;await post('/api/project-work/'+id+'/restart-failure',{});await idle();assert.equal(audit().filter((e:any)=>e.kind==='issue_implementation_readonly_check_started').length,checks);assert.deepEqual(await readFile(f.trace),trace);return;
     }
     if(fault==='readonly-index'){
       const path=join(old.plan.workspace,'src/normalize.mjs'),st=await fsPromises.stat(path);await fsPromises.utimes(path,st.atime,new Date(st.mtimeMs-2000));const raw=fsPromises.readFile,index=join(old.plan.workspace,'.git/index');let changed=false;
       fsPromises.readFile=(async(...args:any[])=>{const bytes=await (raw as any)(...args);if(args[0]===index&&!changed){changed=true;await git(old.plan.workspace,['update-index','--refresh']);assert.notEqual(hash(bytes),hash(await raw(index)));}return bytes;}) as typeof raw;syncBuiltinESMExports();
       try{await post('/api/project-work/'+id+'/restart-failure',{});await idle();}finally{fsPromises.readFile=raw;syncBuiltinESMExports();}
       assert.equal(changed,true);const refused=q.issueImplementations().state(old.source,old.id),reject=audit().filter((e:any)=>e.kind==='issue_implementation_readonly_check_rejected').at(-1);assert.equal(reject.data.permanent,false);assert.equal(refused.readonlyFailure,null);const checks=audit().filter((e:any)=>e.kind==='issue_implementation_readonly_check_started').length;await get('/api/project-work/'+id);await get('/api/project-work/'+id);assert.equal(audit().filter((e:any)=>e.kind==='issue_implementation_readonly_check_started').length,checks);
     }
     await restartAndAssert(ended,old,q,store);const result=q.issueImplementations().state(old.source,old.id);assert.equal(result.result.failureKind,'ended_readonly_timeout');assert.equal(result.result.hostEvidenceComplete,true);assert.equal(result.result.completeCapture,false);assert.equal(result.result.report,null);assert.equal(result.validationFailure,null);return;
   }
   if(validationFault){
     let failed:any;for(let i=0;i<1000;i++){const v=(await get('/api/project-work/'+id)).value;if(v.execution?.requests[0]?.reason&&!v.execution.requests[0].controllerActive&&!v.validationFailure)throw Error(v.execution.requests[0].reason);if(v.validationFailure?.eligible&&!v.execution.requests[0].controllerActive){failed=v;break;}await new Promise(r=>setTimeout(r,20));}assert.ok(failed,'complete healthy failure must have a bounded continuation');AuthorityRecords.prototype.prepare=prepareOwner;
     if(fault==='validation-future'){const input=JSON.parse(await readFile(join(failed.draft.preparation.directory,'input.json'),'utf8'));assert.equal(input.preparationVersion,4);assert.equal(input.validationInvocation.cwd,'/work');assert.equal(input.validationInvocation.timeoutMs,30000);assert.deepEqual(input.validationInvocation.scriptArguments,[]);assert.equal(input.timeLimitMs,900000);assert.equal(JSON.parse(await readFile(f.configPath,'utf8')).timeoutMs,120000);}
     assert.equal(failed.execution.requests[0].phase,'validation_failed');assert.equal(failed.execution.reports[0].report.decision,'implemented');assert.equal(failed.validationFailure.tests.passed,false);const versionRoot=join(config.root,'works',id,'version-1'),store=join(versionRoot,'queue'),q=await QueueStore.open(store);t.after(()=>q.close());const old=q.issueImplementations().state(failed.draft.source,failed.draft.requestId),originalManifest=await readFile(join(old.plan.operationRoot,'input-manifest.json')),script=await readFile(join(versionRoot,'tests.json')),oldReport=failed.execution.reports[0].report;
     const before=await readFile(f.trace);await get('/api/project-work/'+id);await get('/api/project-work/'+id);assert.deepEqual(await readFile(f.trace),before);
     if(fault?.startsWith('validation-restart')){await restartAndAssert(failed,old,q,store);return;}
     if(fault==='validation-legacy'){
       for(const [relative,transform] of [['workspace/src/normalize.mjs',(b:Buffer)=>Buffer.concat([b,Buffer.from('// foreign edit\n')])],['workspace/test/normalize.test.mjs',(b:Buffer)=>Buffer.concat([b,Buffer.from('// foreign protected change\n')])],['operation/implementer/completed.json',()=>Buffer.from('{}')],['operation/attempt-1/post-repair-1/result.json',()=>Buffer.from('{}')],['plan.json',()=>Buffer.from('{}')]] as Array<[string,(b:Buffer)=>Buffer]>){const path=join(old.plan.request.workspaceRequest.executionRoot,relative),b=await readFile(path);await writeFile(path,transform(b));assert.equal((await post('/api/project-work/'+id+'/correct-validation',{})).status,503);assert.deepEqual(await readFile(f.trace),before);await writeFile(path,b);}
       const checkout=join(old.plan.operationRoot,'attempt-1','post-repair-1','candidate-checkout');
       assert.equal(await readFile(join(checkout,'.vscode','launch.json'),'utf8'),'{"configurations":[]}');
       const unbound=join(old.plan.operationRoot,'attempt-1','unregistered','candidate-checkout');
       await mkdir(unbound,{recursive:true});await writeFile(join(unbound,'launch.json'),'{}');
       const unknownChild=await post('/api/project-work/'+id+'/correct-validation',{});
       assert.equal(unknownChild.status,503);assert.match(unknownChild.value.error,/child_active_or_unknown/);
       await rm(dirname(unbound),{recursive:true});
       const child=join(old.plan.operationRoot,'implementer','tool-host-'+process.pid);await mkdir(child);await writeFile(join(child,'launch.json'),'{}');await writeFile(join(child,'process.json'),canonical({pid:process.pid}));const activeChild=await post('/api/project-work/'+id+'/correct-validation',{});assert.equal(activeChild.status,503);assert.match(activeChild.value.error,/child_active_or_unknown/);await rm(child,{recursive:true});
       const indexPath=join(old.plan.workspace,'.git/index'),index=await readFile(indexPath);await git(old.plan.workspace,['update-index','--force-remove','README.md']);assert.equal((await post('/api/project-work/'+id+'/correct-validation',{})).status,503);await writeFile(indexPath,index);
       const definitionBytes=await readFile(join(versionRoot,'tests.json'));await writeFile(join(versionRoot,'tests.json'),canonical({schemaVersion:2,executor:docker,tools:[]}));assert.equal((await post('/api/project-work/'+id+'/correct-validation',{})).status,503);await writeFile(join(versionRoot,'tests.json'),definitionBytes);
       const db=new DatabaseSync(join(store,'queue.sqlite'));try{db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('resource-ledger:synthetic-not-covered','{}');assert.equal((await post('/api/project-work/'+id+'/correct-validation',{})).status,503);db.prepare('DELETE FROM meta WHERE key=?').run('resource-ledger:synthetic-not-covered');}finally{db.close();}assert.deepEqual(await readFile(f.trace),before);
     }
     if(fault==='validation-stopped'){await post('/api/project-work/'+id+'/stop',{});assert.equal((await post('/api/project-work/'+id+'/correct-validation',{})).status,503);assert.deepEqual(await readFile(f.trace),before);return;}
     if(fault==='validation-authority'){const rows=JSON.parse(await readFile(originals,'utf8'));rows[1].comment.body='changed original authority';rows[1].graph.data.node.body=rows[1].comment.body;await writeFile(originals,JSON.stringify(rows));}
     const correction=await post('/api/project-work/'+id+'/correct-validation',{});assert.equal(correction.status,202,JSON.stringify(correction));
     if(!futureValidation){assert.equal(correction.value.waitingForOwner,true);const owner=new URL(ownerURLs.at(-1)!),token=owner.hash.slice(1),h={Authorization:'Owner '+token,Origin:url.origin,'Content-Type':'application/json'},preview=await(await fetch(url.origin+'/api/project-owner',{headers:h})).json() as any;assert.equal(preview.preview.materialOnly,true);assert.equal(preview.preview.readableDefinition.script,proposal.validation.script);assert.equal(JSON.parse(await readFile(originals,'utf8')).length,2);const approved=await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:h,body:'{}'}),approvedBody=await approved.json();assert.equal(approved.status,202,JSON.stringify(approvedBody));}
     if(fault==='validation-legacy'){const repeated=await post('/api/project-work/'+id+'/correct-validation',{});assert.ok([202,503].includes(repeated.status));const other=await post('/api/project-work/create',{...first,requestId:randomUUID(),conversationId:randomUUID(),issueNumber:202,newWork:true});assert.equal(other.status,200);assert.equal((await post('/api/project-work/'+other.value.id+'/prepare',{goal:'Independent read-only preparation while the original correction is active.'})).status,202);await wait(other.value.id,'prepared');}
     if(fault==='validation-authority'){let refused=false;for(let i=0;i<200;i++){const v=(await get('/api/project-work/'+id)).value,r=v.execution.requests[0];if(!r.controllerActive&&r.reason){refused=true;break;}await new Promise(r=>setTimeout(r,20));}assert.equal(refused,true);const state=q.issueImplementations().state(failed.draft.source,failed.draft.requestId);assert.equal(state.validationCorrection,null);assert.equal(state.result,null);assert.deepEqual(await readFile(f.trace),before);assert.equal(await exists(join(state.plan.operationRoot,'validation-correction')),false);return;}
     if(fault==='validation-interrupt'){
       let interrupted:any;for(let i=0;i<1000;i++){const v=(await get('/api/project-work/'+id)).value,r=v.execution.requests[0];if(!r.controllerActive&&r.reason){interrupted=v;break;}await new Promise(r=>setTimeout(r,20));}assert.ok(interrupted);assert.equal(interrupted.execution.requests[0].phase,'active_or_unknown');assert.equal(interrupted.draft.delivery==null,true);const state=q.issueImplementations().state(failed.draft.source,failed.draft.requestId);assert.ok(state.validationCorrection);assert.equal(state.result,null);assert.equal(await exists(join(state.plan.workspace,'.git/tongxu-writer.json')),true);const trace=await readFile(f.trace);await post('/api/project-work/'+id+'/correct-validation',{});await get('/api/project-work/'+id);assert.deepEqual(await readFile(f.trace),trace);await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');await get('/api/project-work/'+id);await post('/api/project-work/'+id+'/correct-validation',{});assert.deepEqual(await readFile(f.trace),trace);return;
     }
     let corrected:any;for(let i=0;i<1000;i++){const v=(await get('/api/project-work/'+id)).value;if(v.execution.requests[0].reason&&!v.execution.requests[0].controllerActive&&v.execution.requests[0].phase!=='returned')throw Error(v.execution.requests[0].reason);if(v.execution.requests[0].phase==='returned'&&!v.execution.requests[0].controllerActive){corrected=v;break;}await new Promise(r=>setTimeout(r,20));}assert.ok(corrected,'explicit correction must return a known outcome');const state=q.issueImplementations().state(failed.draft.source,failed.draft.requestId);assert.equal(state.operation,old.operation);if(fault==='validation-large'){const d=q.tasks().definition(state.task),current=await tree(state.plan.workspace,true);assert.equal(d.paths.length,1);assert.ok(d.paths.every(p=>state.plan.request.workspaceRequest.materialPaths.includes(p)));assert.equal(state.plan.request.workspaceRequest.allowedPaths.length,3);assert.ok(state.plan.request.workspaceRequest.allowedPaths.reduce((n:string|number,p:string)=>Number(n)+current[p]!.bytes,0)>384*1024);}assert.equal(state.requestSha256,old.requestSha256);assert.equal(state.validationCorrection.inputSha256,hash(JSON.parse(await readFile(join(state.validationCorrection.nativeDirectory,'inputs.json'),'utf8'))[0].input));assert.deepEqual(await readFile(join(state.plan.operationRoot,'input-manifest.json')),originalManifest);assert.deepEqual(await readFile(join(versionRoot,'tests.json')),script);assert.deepEqual(corrected.execution.reports[0].originalValidationFailure.report,oldReport);assert.equal(await exists(join(state.plan.workspace,'.git/tongxu-writer.json')),false);const checkDb=new DatabaseSync(join(store,'queue.sqlite'),{readOnly:true});try{assert.equal((checkDb.prepare('SELECT count(*) n FROM claims WHERE operation=?').get(old.operation) as any).n,0);}finally{checkDb.close();}
     if(fault==='validation-failed'){assert.equal(state.result.status,'failed');assert.equal(state.result.H1,null);assert.equal(corrected.draft.delivery==null,true);}else{assert.equal(state.result.status,'completed');assert.ok(state.result.H1);const controls=await IssueImplementationControls.load(failed.draft.catalog.path,failed.draft.catalog.sha256,'fixture/reception',async n=>({number:n,title:'Real task shape '+n,body:'Preserve trim/default; add optional fallback.',url:'https://github.com/fixture/reception/issues/'+n}),async()=>{});const proof=await controls.ownerFeedbackProof(store,{source:state.source,requestId:state.id,task:state.task,operation:state.operation,requestSha256:state.requestSha256});assert.ok(proof.files.some(x=>x.path.includes('validation-correction/native')));assert.ok(proof.files.some(x=>x.path.includes('/implementer/')));if(fault==='validation-large'){const d=q.tasks().definition(state.task),path=state.plan.request.workspaceRequest.allowedPaths.find((p:string)=>!d.paths.includes(p));assert.ok(path);const file=join(state.plan.workspace,path),bytes=await readFile(file);await writeFile(file,Buffer.concat([bytes,Buffer.from('\n// unobserved foreign edit\n')]));const {assertImplementationOwnerSourceSync}=await import('../../src/implementation-owner-feedback.js');assert.throws(()=>assertImplementationOwnerSourceSync(proof),/source_no_longer_current/);await assert.rejects(controls.readSupplement({source:state.source,requestId:state.id,task:state.task,operation:state.operation},null,'must not ignore an unobserved allowed path'));await writeFile(file,bytes);}assert.equal((await controls.readSupplement({source:state.source,requestId:state.id,task:state.task,operation:state.operation},null,'same-scope next result')).ready,true);await controls.drain();
       if(fault==='validation-legacy'){const target=(await get('/api/project-secretary')).value.supplementTargets.find((x:any)=>x.source===state.source&&x.requestId===state.id),{title,...identity}=target;assert.equal((await post('/api/project-secretary/supplement',{conversationId:first.conversationId,requestId:randomUUID(),target:identity,text:'Explain the preserved fallback with one original-scope comment.'})).status,202);let supplemented=false;for(let i=0;i<1000;i++){const v=(await get('/api/project-work/'+id)).value;if(v.execution.requests.length===2&&v.execution.requests.every((r:any)=>r.phase==='returned'&&!r.controllerActive)&&v.draft.delivery?.H===v.execution.reports[1]?.H1){supplemented=true;break;}await new Promise(r=>setTimeout(r,20));}assert.equal(supplemented,true);}
}
     const trace=await readFile(f.trace),comments=JSON.parse(await readFile(originals,'utf8')).length;assert.equal(comments,futureValidation?2:3);await post('/api/project-work/'+id+'/correct-validation',{});await new Promise(r=>setTimeout(r,50));assert.deepEqual(await readFile(f.trace),trace);assert.equal(trace.toString().split('model-input').length-1,fault==='validation-legacy'?5:3);
     await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');assert.equal((await get('/api/project-work/'+id)).value.execution.reports[0].report.decision,fault==='validation-failed'?'no_change':'implemented');assert.deepEqual(await readFile(f.trace),trace);return;
   }
   if(fault&&fault!=='receipt-pending'&&!validationFault&&!readonlyFault&&fault!=='implementation-ai'&&fault!=='literal-large'){
     if(fault.startsWith('stop-')||fault==='drain'){
       for(let i=0;i<500&&!await exists(originals+'.waiting');i++)await new Promise(r=>setTimeout(r,10));assert.equal(await exists(originals+'.waiting'),true);
       const expected=fault==='stop-delegate-comments'?1:0;assert.equal(JSON.parse(await readFile(originals,'utf8')).length,expected);
       if(fault==='drain'){const closing=app.close();await new Promise(r=>setTimeout(r,25));await rm(originals+'.hold');await closing;app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');}
       else{assert.equal((await post('/api/project-work/'+id+'/stop',{})).value.stopRequested,true);await rm(originals+'.hold');}
       await wait(id,'authorizing');assert.equal(JSON.parse(await readFile(originals,'utf8')).length,expected);assert.equal((await readFile(f.trace,'utf8')).split('model-input').length-1,1);return;
     }
     await wait(id,'authorizing');const failed=(await get('/api/project-work/'+id)).value,before=await readFile(f.trace),comments=JSON.parse(await readFile(originals,'utf8'));
     assert.equal(failed.draft.version,1);assert.equal(failed.draft.catalog==null,true);assert.equal(comments.length,fault==='unknown-adopt'?0:fault==='lost-delegate'?2:1);
     // Cold reopen must still offer the same authorizing version, without input.
     await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');const cold=(await get('/api/project-work/'+id)).value;assert.equal(cold.draft.stage,'authorizing');assert.equal(cold.draft.version,1);assert.deepEqual(await readFile(f.trace),before);
     const {page}=await import('../w7/github-projects-ui-fixture.js');const ui=await page();ui.run(await readFile(new URL('../../../web/workbench/implementation.js',import.meta.url),'utf8'));ui.run(await readFile(new URL('../../../web/workbench/project-work.js',import.meta.url),'utf8'));
     ui.run("entryInfo={githubProjects:true,projectWork:true};gh.selected={id:1,nodeId:'R_FIRST',fullName:'fixture/reception'};state={tasks:[],project:{repository:gh.selected}};let d=projectWorkData();d.ready=true;d.selected="+JSON.stringify(id)+";d.detail="+JSON.stringify(cold)+";d.works=["+JSON.stringify((await get('/api/project-work')).value.works.find((x:any)=>x.id===id))+"];view='project-work';renderProjectWork();");
     const buttons:string[]=[];const visit=(n:any)=>{if(n.tag==='button')buttons.push(n.textContent);for(const c of n.children??[])visit(c);};visit(ui.nodes.get('content'));assert.ok(buttons.includes('核对原批准并继续原工作'));
     const retry=await post('/api/project-work/'+id+'/start',confirm);assert.equal(retry.value.waitingForOwner,true);const token=new URL(ownerURLs.at(-1)!).hash.slice(1);await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:{Authorization:'Owner '+token,Origin:url.origin,'Content-Type':'application/json'},body:'{}'});
     if(fault==='unknown-adopt'){const waiting=await wait(id,'authorizing');assert.equal(waiting.problem,'project_work_owner_source_unknown');assert.equal(JSON.parse(await readFile(originals,'utf8')).length,0);assert.deepEqual(await readFile(f.trace),before);return;}
     await wait(id,'delivered');const recovered=(await get('/api/project-work/'+id)).value;assert.equal(recovered.draft.version,1);assert.equal(recovered.draft.requestId,detail.draft.requestId);assert.equal(recovered.execution.reports.length,1);assert.equal(JSON.parse(await readFile(originals,'utf8')).length,2);assert.equal((await readFile(f.trace,'utf8')).split('model-input').length-1,2);assert.equal(await git(f.objects,['rev-parse',recovered.draft.delivery.branch]),recovered.execution.reports[0].H1);return;
   }
   if(fault==='receipt-pending'){
     const pending=async()=>{for(let i=0;i<1000;i++){const v=(await get('/api/project-work/'+id)).value;if(v.draft.delivery?.problem==='fixture_receipt_checkout_interruption')return v;await new Promise(r=>setTimeout(r,25));}throw Error('pending_receipt_timeout');};
     const original=await pending(),h1=original.execution.reports[0].H1,receipt1=join(resultDirectory,'receipt-'+h1),intent1=join(receipt1,'receipt-'+h1+'.json'),intentBytes=await readFile(intent1),oldEvidence=await readdir(receipt1);
     const target=(await get('/api/project-secretary')).value.supplementTargets.find((x:any)=>x.source===original.draft.source&&x.requestId===original.draft.requestId);assert.ok(target);const {title,...identity}=target;
     assert.equal((await post('/api/project-secretary/supplement',{conversationId:first.conversationId,requestId:randomUUID(),target:identity,text:'Add the original-scope comment while the original receipt is interrupted.'})).status,202);
     let supplemented:any;for(let i=0;i<1000;i++){const v=(await get('/api/project-work/'+id)).value;if(v.execution.reports.length===2&&v.execution.requests.every((r:any)=>!r.controllerActive)&&receiptFailures>=2){supplemented=v;break;}await new Promise(r=>setTimeout(r,25));}assert.ok(supplemented,'normal supplement must finish and attempt its callback');
     // Keep the original fault through the automatic H2 callback, then let one
     // normal receive request recover H1 and advance H2 without another model.
     assert.equal((await post('/api/project-work/'+id+'/receive',{})).status,503);
     const blocked=(await get('/api/project-work/'+id)).value,h2=supplemented.execution.reports[1].H1;assert.notEqual(h2,h1);assert.equal(blocked.draft.delivery.H,h1);assert.equal(blocked.draft.delivery.status,'pending');assert.equal(await exists(join(resultDirectory,'receipt-'+h2)),false);
     const trace=await readFile(f.trace);childProcess.spawn=spawn;syncBuiltinESMExports();
     const received=await post('/api/project-work/'+id+'/receive',{});assert.equal(received.status,200,JSON.stringify(received));assert.equal(received.value.H,h2);
     const done=(await get('/api/project-work/'+id)).value;assert.equal(done.draft.stage,'delivered');assert.equal(done.draft.delivery.status,'received');assert.equal(done.draft.delivery.H,h2);assert.equal(done.draft.delivery.previous,h1);assert.equal(await git(f.objects,['rev-parse',done.draft.delivery.branch]),h2);assert.equal(await git(resultWorkspace,['rev-parse','HEAD']),h2);
     assert.deepEqual(done.execution.reports, supplemented.execution.reports);assert.deepEqual(await readFile(intent1),intentBytes);for(const name of oldEvidence)assert.ok((await readdir(receipt1)).includes(name));assert.deepEqual(done.draft.events.filter((e:any)=>e.kind==='result_received').map((e:any)=>e.detail.split(' ')[0]),[h1,h2]);
     const h2Intent=JSON.parse(await readFile(join(resultDirectory,'receipt-'+h2,'receipt-'+h2+'.json'),'utf8'));assert.equal(h2Intent.previous,h1);assert.equal((await post('/api/project-work/'+id+'/receive',{})).status,200);assert.deepEqual(await readFile(f.trace),trace);
     await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');assert.equal((await post('/api/project-work/'+id+'/receive',{})).status,200);assert.equal((await get('/api/project-work/'+id)).value.draft.delivery.H,h2);assert.deepEqual(await readFile(f.trace),trace);assert.equal(trace.toString().split('model-input').length-1,3);return;
   }
   await wait(id,'delivered');const afterApproval=await readFile(f.trace);const duplicateApproval=await fetch(url.origin+'/api/project-owner/approve',{method:'POST',headers:ownerHeaders,body:'{}'});assert.equal((await duplicateApproval.json() as any).duplicate,true);assert.deepEqual(await readFile(f.trace),afterApproval);
   const done=(await get('/api/project-work/'+id)).value;
   if(fault==='literal-large'){const c=JSON.parse(await readFile(done.draft.catalog.path,'utf8')),q=await QueueStore.open(c.entries[0].store);try{const state=q.issueImplementations().state(done.draft.source,done.draft.requestId),p=JSON.parse(await readFile(state.plan.path,'utf8')),manifest=JSON.parse(await readFile(join(state.plan.operationRoot,'input-manifest.json'),'utf8')),source=await readFile(join(state.plan.workspace,'src/normalize.mjs'),'utf8'),before=await readFile(join(f.objects,'src/normalize.mjs'),'utf8');assert.equal(state.plan.request.editProfile,'literal-edits-v1');assert.equal(p.editProfile,'literal-edits-v1');assert.equal(manifest.editProfile,'literal-edits-v1');assert.ok(Buffer.byteLength(source)>180000);assert.equal(source.split('\n// padding\n')[1],before.split('\n// padding\n')[1]);const calls=await readdir(join(state.plan.operationRoot,'calls'));for(const name of calls){const call=JSON.parse(await readFile(join(state.plan.operationRoot,'calls',name),'utf8'));if(call.request.tool==='tongxu_replace_file'){assert.ok(call.request.arguments.edits);assert.equal(call.request.arguments.text,undefined);assert.ok(Buffer.byteLength(JSON.stringify(call.request))<1500);assert.equal(call.beforeExecutable,call.afterExecutable);}}}finally{q.close();}}
   if(fault==='implementation-ai'){const catalog=JSON.parse(await readFile(done.draft.catalog.path,'utf8')),queue=await QueueStore.open(catalog.entries[0].store);try{const state=queue.issueImplementations().state(done.draft.source,done.draft.requestId),plan=JSON.parse(await readFile(state.plan.path,'utf8')),manifest=JSON.parse(await readFile(join(state.plan.operationRoot,'input-manifest.json'),'utf8'));if(n===201){assert.equal(state.plan.request.implementationAI,undefined);assert.equal(plan.implementationAI,undefined);assert.equal(await exists(join(state.plan.operationRoot,'implementer/model-choice.json')),false);}else{assert.equal(state.plan.request.implementationAI.roles.implementer.model,'fixture-astra');assert.deepEqual(plan.implementationAI,state.plan.request.implementationAI);assert.deepEqual(manifest.implementationAI,state.plan.request.implementationAI);const actual=JSON.parse(await readFile(join(state.plan.operationRoot,'implementer/model-choice.json'),'utf8'));assert.equal(actual.actualModel,'fixture-astra');assert.equal(actual.actualEffort,'max');await chooseImplementer('fixture-second');}}finally{queue.close();}}
   assert.equal(done.execution.reports.length,1);assert.equal(done.execution.reports[0].tests.passed,true);assert.equal(await git(f.objects,['rev-parse',done.draft.delivery.branch]),done.execution.reports[0].H1);assert.equal(await git(f.objects,['rev-parse','HEAD']),H);
   const trace=await readFile(f.trace);await post('/api/project-work/'+id+'/start',confirm);for(let i=0;i<100&&((await get('/api/project-work')).value.works.find((w:any)=>w.id===id).active);i++)await new Promise(r=>setTimeout(r,20));assert.deepEqual(await readFile(f.trace),trace);
 }
 const original=(await get('/api/project-work/'+(fault==='implementation-ai'?secondWorkId:first.requestId))).value,secretary=(await get('/api/project-secretary')).value,target=secretary.supplementTargets.find((x:any)=>x.source===original.draft.source&&x.requestId===original.draft.requestId);assert.ok(target);const {title,...identity}=target,supplementId=randomUUID();
 const supplemented=await post('/api/project-secretary/supplement',{conversationId:first.conversationId,requestId:supplementId,target:identity,text:'Add a short source comment explaining the preserved fallback without changing the accepted behavior.'});assert.equal(supplemented.status,202);
 let supplementedResult:any;for(let i=0;i<1000;i++){const detail=(await get('/api/project-work/'+original.draft.id)).value;if(detail.execution.reports.length===2&&detail.draft.delivery?.status==='received'&&detail.draft.stage==='delivered'&&detail.draft.delivery?.H===detail.execution.reports[1].H1){supplementedResult=detail;break;}await new Promise(r=>setTimeout(r,25));}assert.ok(supplementedResult);assert.notEqual(supplementedResult.execution.reports[0].H1,supplementedResult.execution.reports[1].H1);assert.equal(await git(f.objects,['rev-parse',supplementedResult.draft.delivery.branch]),supplementedResult.execution.reports[1].H1);
 if(fault==='implementation-ai'){const c=JSON.parse(await readFile(original.draft.catalog.path,'utf8')),q=await QueueStore.open(c.entries[0].store);try{const last=q.issueImplementations().requests(original.draft.source).at(-1)!;assert.equal(last.plan.request.implementationAI.roles.implementer.model,'fixture-astra');assert.equal(JSON.parse(await readFile(join(last.plan.operationRoot,'implementer/model-choice.json'),'utf8')).actualModel,'fixture-astra');}finally{q.close();}}
 const supplementTrace=await readFile(f.trace);assert.equal((await post('/api/project-secretary/supplement',{conversationId:first.conversationId,requestId:supplementId,target:identity,text:'Add a short source comment explaining the preserved fallback without changing the accepted behavior.'})).status,202);await new Promise(r=>setTimeout(r,100));assert.deepEqual(await readFile(f.trace),supplementTrace);
 const before=await readFile(f.trace);await app.close();app=await startWorkbench(planPath,undefined,dependencies);url=new URL(app.url);headers={...headers,Authorization:'Bearer '+url.hash.slice(1)};await get('/api/github/projects');const final=await get('/api/project-work');assert.equal(final.value.works.length,2);assert.equal(final.value.settings.repositoryPath,f.objects);for(const w of final.value.works)assert.equal((await get('/api/project-work/'+w.id)).value.execution.reports.length,w.id===original.draft.id?2:1);assert.deepEqual(await readFile(f.trace),before);
 assert.equal(JSON.parse(await readFile(originals,'utf8')).length,4);assert.equal((await readFile(f.trace,'utf8')).trim().split('\n').map(s=>JSON.parse(s)).filter(x=>x.kind==='model-input').length,5);
}

test('first use literal edits preserve large UTF8 source through H1, cold read and supplement',t=>firstUseProjectWork(t,'literal-large'));
test('first use literal edits preserve the frozen profile across validation correction',t=>firstUseProjectWork(t,'validation-literal'));
test('first use explicit implementer settings freeze new plans while owner and later settings cannot rebind them',t=>firstUseProjectWork(t,'implementation-ai'));
for(const mode of ['readonly-restart','readonly-index','readonly-flags','readonly-wire','readonly-nonread','readonly-terminal','readonly-release','readonly-check','readonly-zero-failed'])test('first use ended readonly timeout strict host evidence '+mode,t=>firstUseProjectWork(t,mode));
for(const mode of ['validation-restart','validation-restart-failed','validation-restart-current','validation-restart-intent','validation-restart-terminal','validation-restart-release','validation-restart-version','validation-restart-check'])test('first use expired failure same-work zero-round restart '+mode,t=>firstUseProjectWork(t,mode));
test('first use expired complete preparation host recheck without model',t=>firstUseProjectWork(t,'expiry-a'));

for(const mode of ['validation-legacy','validation-future','validation-failed','validation-interrupt','validation-stopped','validation-authority','validation-large'])test('first use bounded known validation correction '+mode,t=>firstUseProjectWork(t,mode));

test('first use normal HTTP rejected preparation questions cold read and explicit same-work next version',t=>firstUseProjectWork(t,'preparation-questions'));
test('first use normal HTTP explicit V4 preparation reuses only the immediately previous complete unaccepted report without implementation',t=>firstUseProjectWork(t,'preparation-typed-retry'));

test('first use normal HTTP receives the pending original result before its completed supplement',t=>firstUseProjectWork(t,'receipt-pending'));

test('first use normal HTTP prepares two unconfigured works, preserves a missing-location draft, returns real branches and cold reads without duplicate inputs',t=>firstUseProjectWork(t));
test('ordinary project work cold-corrects an actual failure in the same checkout without discarding its edits',t=>firstUseProjectWork(t,'project-development-failure'));
test('ordinary project work reuses one Owner grant across independent A and B, stops only A, and implements a reviewed supplement after reopening',t=>firstUseProjectWork(t,'project-development'));
test('normal preparation freezes a switched workflow for new work and retains previously prepared inputs',t=>firstUseProjectWork(t,'workflow-default'));
for(const fault of ['stop-adopt-comments','stop-adopt-user','stop-delegate-comments','drain','lost-adopt','lost-delegate','unknown-adopt'])test('first use normal HTTP original authorization fault: '+fault,t=>firstUseProjectWork(t,fault));

for(const secret of [undefined,'EXPLICIT_IMPLEMENTATION_UNSELECTED_SOURCE_SENTINEL'])test(`new implementation consumer uses no finding, writes twice, tests the actual tree and commits H1 without touching its fixed source${secret?' and keeps unselected test output private':''}`,async t=>{
 const f=await implementationProject(t,secret),sourceBefore=await tree(f.objects,true),body='Preserve trim and Untitled; add an optional fallback name, so blank with Draft returns Draft.';
 const implementationRoot=join(f.root,'implementation');
 const request:ImplementationRequest={schemaVersion:1,kind:'tongxu-issue-implementation',id:'new-request',task:'a'.repeat(64),adoptedScope:{adoption:'b'.repeat(64),body:{goals:[body],nonGoals:[],preserve:[],acceptance:['Registered tests'],constraints:['Only allowed files']},bodySha256:hash(canonical({goals:[body],nonGoals:[],preserve:[],acceptance:['Registered tests'],constraints:['Only allowed files']})),source:'explicit fixture scope'},issue:{number:74,body,bodySha256:hash(body),adjudication:'explicit fixture adopted requirement; no real user acceptance'},workspaceRequest:{...f.request,executionRoot:implementationRoot}};
 const prepared=await prepareIssueImplementation(f.configPath,request,implementationRoot),workspace=JSON.parse(await readFile(prepared.plan,'utf8')).workspace,planSha256=hash(await readFile(prepared.plan));let dispatches=0,checks=0;
 const result=await runIssueImplementation(prepared.plan,planSha256,request,prepared.operation,{refresh:async()=>{},unsent:()=>{},check:effect=>{checks++;effect?.();},dispatch:()=>{dispatches++;}});
 if(result.status!=='completed')assert.fail(JSON.stringify(result));assert.equal(dispatches,1);assert.ok(checks>2);assert.notEqual(result.H1,result.H0);assert.equal(result.tests.passed,true);assert.equal(result.testCandidateBinding.testedTree,await git(workspace,['rev-parse',result.H1+'^{tree}']));
 assert.equal((await readdir(join(prepared.operation,'calls'))).filter(x=>x.endsWith('.json')).length,4);
 const capture=JSON.parse(await readFile(join(prepared.operation,'implementer','binding.json'),'utf8'));assert.equal(capture.role,'implementer');assert.equal(capture.turnIds.length,1);
 const sent=(await readFile(join(prepared.operation,'implementer','stdin.ndjson'),'utf8')).trim().split('\n').map(s=>JSON.parse(s)),turn=sent.find(m=>m.method==='turn/start');assert.deepEqual(turn.params.outputSchema.properties.candidateH.enum,[result.H0]);assert.equal(result.report.candidateH,result.H0);assert.notEqual(result.report.candidateH,result.H1);
 assert.deepEqual(await tree(f.objects,true),sourceBefore);assert.equal(await git(f.objects,['rev-parse','HEAD']),f.request.candidate.H);assert.equal(result.formalReview,false);assert.equal(result.published,false);
 if(secret){
  const directories=await readdir(join(prepared.operation,'tests')),testDirectory=directories.find(name=>name.startsWith('tool-'))!;
  assert.match(await readFile(join(prepared.operation,'tests',testDirectory,'tool-0','stdout'),'utf8'),new RegExp(secret));
  for(const path of request.workspaceRequest.materialPaths)assert.equal((await readFile(join(f.objects,path),'utf8')).includes(secret),false);
  assert.equal((await readFile(join(prepared.operation,'implementer','stdin.ndjson'),'utf8')).includes(secret),false);
  assert.equal((await readFile(join(prepared.operation,'implementer','reconciled-tools.json'),'utf8')).includes(secret),false);
  assert.equal(JSON.stringify(result.modelTests).includes(secret),false);assert.equal(JSON.stringify(result.tests).includes(secret),true);
 }
 const trace=await readFile(f.trace);await assert.rejects(runIssueImplementation(prepared.plan,planSha256,request,prepared.operation,{refresh:async()=>{},unsent:()=>{throw Error('implementation_sent_or_unknown_never_resend');},check:()=>{},dispatch:()=>{throw Error('must not dispatch');}}),/sent_or_unknown_never_resend/);assert.deepEqual(await readFile(f.trace),trace);
});


async function implementationEntry(t:TestContext,resources:boolean,resourceMode:string,selectedLink:boolean,projectFiles:boolean,moveTarget?:string,projectFailure=false){
 const project=await implementationProject(t);
 if(projectFailure){
   const plan=JSON.parse(await readFile(project.request.testPlan,'utf8'));
   plan.tools.push({...plan.tools[0],id:'after-failure'});
   plan.tools[0].argv=[docker.node,'--input-type=module','-e',String.raw`import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
writeFileSync(1,'project test progress '.repeat(900)+'\n');
writeFileSync(2,'project test diagnostics '.repeat(900)+'\n'+'stderr original tail\n');
const child=spawnSync(process.execPath,['--test','test/normalize.test.mjs'],{stdio:'inherit'});
if(child.error)throw child.error;
process.exitCode=child.status??2;`];
   const bytes=JSON.stringify(plan);await writeFile(project.request.testPlan,bytes);project.request.testPlanSha256=hash(bytes);
 }
 if(projectFiles){
   const script=await readFile(project.config.codexExecutable,'utf8');
   const needle="const v=JSON.parse(m.result.contentItems[0].text);if(stage==='tongxu_read_file'){";
   assert.ok(script.includes(needle));
   const fixture="const v=JSON.parse(m.result.contentItems[0].text);if(context.request?.workspaceRequest?.projectFiles){if(stage==='tongxu_read_file'){globalThis.callerDigest=v.sha256;tool('tongxu_create_file',{path:'src/fallbacks/default-label.mjs',mode:'100755',text:"+JSON.stringify("export const defaultLabel='Untitled';\n")+"});}else if(stage==='tongxu_create_file'){tool('tongxu_replace_file',{path:'src/index.mjs',expectedSha256:globalThis.callerDigest,text:"+JSON.stringify("import {defaultLabel} from './fallbacks/default-label.mjs';\nexport function normalizeLabel(value,fallback=defaultLabel){return value.trim() || fallback;}\n")+"});}else if(stage==='tongxu_replace_file'){tool('tongxu_run_tests',{});}else finish({candidateH:context.candidate.H,decision:'implemented',report:'Applied project-wide tools in the original bounded implementation context.'});return;}if(stage==='tongxu_read_file'){";
   const importPath=moveTarget==='__proto__'?'../__proto__':'./shared/normalize.mjs';
   const fallback=projectFailure?'Wrong':'Untitled';
   const movedCaller=`import {normalizeLabel as trimWithDefault} from '${importPath}';\nexport function normalizeLabel(value,fallback='${fallback}'){return value.trim()?trimWithDefault(value):fallback;}\n`;
   const moves="const v=JSON.parse(m.result.contentItems[0].text);if(context.request?.workspaceRequest?.projectFiles){if(stage==='tongxu_read_file'&&!globalThis.callerDigest){globalThis.callerDigest=v.sha256;tool('tongxu_read_file',{path:'src/normalize.mjs'});}else if(stage==='tongxu_read_file'&&!globalThis.movedSource){globalThis.movedSource=true;tool('tongxu_rename_file',{path:'src/normalize.mjs',destination:"+JSON.stringify(moveTarget)+",expectedSha256:v.sha256});}else if(stage==='tongxu_rename_file'){tool('tongxu_read_file',{path:'README.md'});}else if(stage==='tongxu_read_file'){tool('tongxu_delete_file',{path:'README.md',expectedSha256:v.sha256});}else if(stage==='tongxu_delete_file'){tool('tongxu_replace_file',{path:'src/index.mjs',expectedSha256:globalThis.callerDigest,text:"+JSON.stringify(movedCaller)+"});}else if(stage==='tongxu_replace_file'){tool('tongxu_run_tests',{});}else finish({candidateH:context.candidate.H,decision:'implemented',report:'Applied project-scoped move and delete; original pending work preserved.'});return;}if(stage==='tongxu_read_file'){";
   const replayFailedValidation=projectFailure?fixture.replace("if(stage==='tongxu_read_file'){",[
     "if(stage==='tongxu_run_tests'&&!globalThis.checkedBaseline){",
     "if(!v.passed)throw Error('fixture_first_validation_must_pass');",
     "globalThis.checkedBaseline=true;tool('tongxu_read_file',{path:'src/fallbacks/default-label.mjs'});return;}",
     "if(stage==='tongxu_read_file'&&globalThis.checkedBaseline){",
     "tool('tongxu_replace_file',{path:'src/fallbacks/default-label.mjs',expectedSha256:v.sha256,text:",
     JSON.stringify("export const defaultLabel='Wrong';\n"),"});return;}if(stage==='tongxu_read_file'){"
   ].join('')):fixture;
   await writeFile(project.config.codexExecutable,script.replace("tool('tongxu_read_file',{path:'src/normalize.mjs'})","tool('tongxu_read_file',{path:'src/index.mjs'})").replace(needle,moveTarget?moves:replayFailedValidation));
 }
 if(selectedLink){await symlink('unselected-synthetic-target',join(project.objects,'omitted-link'));await git(project.objects,['add','omitted-link']);await git(project.objects,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','synthetic unselected link']);const H=await git(project.objects,['rev-parse','HEAD']);project.request.candidate.H=H;project.request.candidate.B=H;}const messages=await messageFixture(t),owner=await messageAuthority(messages);messages.q.enableTasks();
 const context=messages.q.status().items.find((item:any)=>item.id===messages.item).context;
 const scope=await owner.adopt({kind:'adopt_scope',scopeId:context.scope.id,scopeVersion:'implementation-scope',body:{goals:['Implement optional label fallback'],nonGoals:['No publication or merge'],preserve:['Untitled and all original evidence'],acceptance:['Registered tests and committed exact tree'],constraints:[projectFiles?'Protected verification sources; one private project checkout':'Only explicit existing source file']},previousAdoption:owner.scope.sha});
 const ledger=resources?await ledgerFixture(t,resourceMode):null;if(ledger)messages.q.resources().configure(Buffer.from(canonical(ledger.profile)));
 const grant=await owner.adopt({kind:'delegate',adoption:scope.sha,roles:['implementer'],targets:projectFiles?[]:['main'],actions:['implement','test'],paths:projectFiles?[]:project.request.materialPaths,...(projectFiles?{projectFiles:true as const}:{}),resourceRefs:ledger?[ledger.profile.resources[0]!.ref]:[],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const body='Trim labels and keep Untitled by default. An explicit optional fallback Draft must be returned for a blank label.',issue={id:174,number:74,title:'Optional label fallback',body,state:'OPEN',updated_at:new Date().toISOString(),author:{login:'fixture'},labels:{nodes:[]},comments:{totalCount:0}},repository={id:1,nodeId:'R_1',full_name:'fixture/reception',description:'Explicit implementation fixture',private:true,archived:false,defaultBranchRef:{name:'main',target:{oid:project.request.candidate.H}},updated_at:new Date().toISOString()},account={id:7,login:'fixture'};
 let sourceBody=body;
 const github:GitHubReaderFactory=async()=>({query:async op=>({status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:op==='projects'?{account:{...account,projects:{nodes:[repository],pageInfo:{hasNextPage:false,endCursor:null}}}}:{account,repository:{...repository,...(op==='issue'?{item:{...issue,body:sourceBody}}:op==='issues'||op==='pulls'?{items:{nodes:op==='issues'?[{...issue,body:sourceBody}]:[],pageInfo:{hasNextPage:false,endCursor:null}}}:{})}}})})});
 const resource=ledger?.profile.resources[0],entry={...(selectedLink?{materialView:'selected_files' as const}:{}),id:'implementation',repository:'fixture/reception',store:messages.store,root:join(project.root,'normal-entry'),objects:project.objects,H0:project.request.candidate.H,base:project.request.candidate.B,target:'main',context:{...context,scope:{...context.scope,version:'implementation-scope',source:'explicit fixture adoption'}},config:{path:project.configPath,sha256:hash(await readFile(project.configPath))},allowedPaths:projectFiles?[]:project.request.allowedPaths,materialPaths:projectFiles?['README.md']:project.request.materialPaths,...(projectFiles?{projectFiles:true as const}:{}),protectedPaths:project.request.protectedPaths,testPlan:project.request.testPlan,testPlanSha256:project.request.testPlanSha256,approvedIssues:[{number:74,bodySha256:hash(body),adjudication:'Explicit fixture pre-coding adoption, no real user acceptance',goal:body,acceptance:['Preserve defaults','Support optional fallback']}],authorization:{implement:grant.sha,test:grant.sha},budgets:ledger?[{action:'implement',ledgerId:ledger.profile.ledgerId,resourceRef:resource!.ref,unit:resource!.unit,quantity:1}]:[],executionKind:'fixture',demonstrationFixture:true};
 const catalogPath=join(project.root,'implementation-catalog.json');await writeFile(catalogPath,JSON.stringify({schemaVersion:1,kind:'tongxu-issue-implementation-catalog',entries:[entry]}));
 return {project,messages,owner,scope,grant,body,ledger,entry,catalogPath,github,readIssue:async()=>({...issue,body:sourceBody,url:'https://github.com/fixture/reception/issues/74'}),changeIssue:(value:string)=>{sourceBody=value;}};
}
async function implementationPage(t:TestContext,resources=true,resourceMode='normal',withSecretary=false,decorateGitHub?:(original:GitHubReaderFactory)=>GitHubReaderFactory,selectedLink=false,projectFiles=false,moveTarget?:string,projectFailure=false){
 const input=await implementationEntry(t,resources,resourceMode,selectedLink,projectFiles,moveTarget,projectFailure);
 const {project,catalogPath,github}=input;
 const planPath=join(project.root,'implementation-workbench.json');await writeFile(planPath,JSON.stringify({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Implementation fixture',goal:'Run one adopted Issue through normal entry',sources:[],githubProjects:true,issueImplementation:{path:catalogPath,sha256:hash(await readFile(catalogPath))},...(withSecretary?{projectSecretary:{root:join(project.root,'project-chats'),codexExecutable:project.config.codexExecutable,disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:120000,billing:'existing_subscription_only',executionKind:'fixture'}}:{})}));
 const app=await startWorkbench(planPath,undefined,{githubReader:decorateGitHub?decorateGitHub(github):github});const originalClose=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await originalClose();}};t.after(()=>app.close());const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'X-Tongxu-Account':'7','X-Tongxu-Project':'1'},get=async(path='/api/implementation')=>{const result=await fetch(url.origin+path,{headers});return {status:result.status,value:await result.json() as any};},post=async(action:string,data:unknown,extra:Record<string,string>={})=>{const result=await fetch(url.origin+'/api/implementation/implementation/'+action,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});return {status:result.status,value:await result.json() as any};};
 await fetch(url.origin+'/api/github/projects',{headers});
 const settled=async(id:string)=>{for(let i=0;i<1000;i++){const state=(await get()).value.entries[0].requests.find((r:any)=>r.id===id);if(state&&!state.controllerActive&&(state.status||state.reason||state.stopped||state.phase==='active_or_unknown'))return state;await new Promise(r=>setTimeout(r,20));}throw new Error('implementation_fixture_timeout');};
 return {...input,planPath,app,url,headers,get,post,settled};
}

for(const legacy of [false,true])test('normal registered workbench starts one project-scoped Issue and returns the tested new-file candidate'+(legacy?' (legacy protocol and cold readback)':''),async t=>{
 const f=await implementationPage(t,false,'normal',false,undefined,false,true),id='project-files-original';
 const prepared=await f.post('prepare',{requestId:id,issueNumber:74});
 assert.equal(prepared.status,200,JSON.stringify(prepared.value));
 const fixed=f.messages.q.issueImplementations().state('implementation',id).plan;
 const manifestPath=join(fixed.operationRoot,'input-manifest.json');
 let legacyManifest:string|undefined;
 if(legacy){
   // The exact unversioned preparation format written by 3614c373. Freeze it
   // before sending so the original capture also uses its four-tool protocol.
   const request=fixed.request,original={request,planSha256:fixed.sha256,prompt:request.workflowPrompt,...(request.implementationAI?{implementationAI:request.implementationAI}:{}),...(request.editProfile?{editProfile:request.editProfile}:{})};
   legacyManifest=JSON.stringify({...original,inputManifestSha256:hash(canonical(original))});
   await mkdir(fixed.operationRoot,{mode:0o700});
   await mkdir(join(fixed.operationRoot,'attempt-1'),{mode:0o700});
   await writeFile(manifestPath,legacyManifest,{mode:0o600});
   await writeFile(join(fixed.operationRoot,'initial-tree.json'),JSON.stringify(await tree(fixed.workspace,true)),{mode:0o600});
 }
 assert.equal((await f.post('start',{requestId:id})).status,202);
 const done=await f.settled(id);
 assert.equal(done.status,'completed',JSON.stringify(done));
 const report=await f.get('/api/implementation-report/implementation/'+id);
 assert.equal(report.status,200,JSON.stringify(report.value));
 assert.equal(report.value.tests.passed,true);
 assert.deepEqual(report.value.changed,['src/fallbacks/default-label.mjs','src/index.mjs']);
 assert.match(report.value.diff,/new file mode 100755/);
 const state=f.messages.q.issueImplementations().state('implementation',id);
 assert.deepEqual(await readdir(join(state.plan.operationRoot,'tests')),['tool-'+report.value.projectValidationCallId]);
 assert.equal(await exists(join(state.plan.operationRoot,'attempt-1/post-repair-1')),false);
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 assert.equal(manifest.projectFileToolsVersion,legacy?undefined:projectFileMovesVersion);
 assert.equal(manifest.request.workflowPrompt.use,'engineering_owner');
 assert.equal(manifest.request.workflowPrompt.revision,'11cf57b34698e6f7b38ee73468e84103cde8f963');
 assert.deepEqual(prepared.value.workflow,{revision:manifest.request.workflowPrompt.revision,executionContract:manifest.request.workflowPrompt.executionContract,promptSha256:manifest.request.workflowPrompt.sha256});
 assert.deepEqual(done.workflow,prepared.value.workflow);
 assert.ok(Date.parse(prepared.value.lastRecordedAt)<=Date.parse(done.lastRecordedAt));
 assert.deepEqual(manifest.request.workspaceRequest.allowedPaths,[]);
 assert.deepEqual(manifest.request.workspaceRequest.materialPaths,['README.md']);
 assert.equal(await git(f.project.objects,['rev-parse','HEAD']),state.H0);
 const oldGrant=await f.owner.adopt({kind:'delegate',adoption:f.scope.sha,roles:['implementer'],targets:['main'],actions:['implement','test'],paths:['README.md'],resourceRefs:[],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const source=f.owner.records[f.scope.id],profile=f.owner.a.configuration().profile;
 const freshScope=fixtureOwnerObservation(profile,f.scope.sha,f.scope.id,Buffer.from(JSON.stringify(source.graph)),Buffer.from(JSON.stringify(source.comment)),new Date().toISOString());
 assert.throws(()=>f.owner.a.checkAction(state.plan.actions.implement,'implementer',oldGrant.sha,[freshScope,oldGrant.observation]),/owner_delegation_boundary_mismatch/);
 assert.equal((await f.post('start',{requestId:id})).status,202);
 assert.equal((await f.get('/api/implementation-report/implementation/'+id)).value.H1,report.value.H1);
 if(!legacy){
   const testDirectory=join(state.plan.operationRoot,'tests','tool-'+report.value.projectValidationCallId);
   for(const file of ['execution.json','stdout','stderr']){
     const path=join(testDirectory,'tool-0',file),original=await readFile(path);
     await rm(path);
     try{
       const incomplete=await f.get('/api/implementation-report/implementation/'+id);
       assert.equal(incomplete.status,503);
       assert.equal(incomplete.value.error,'implementation_validation_capture_changed');
       assert.equal(incomplete.value.tests,undefined);
     }finally{await writeFile(path,original,{mode:0o600});}
   }
   assert.deepEqual(await f.get('/api/implementation-report/implementation/'+id),report);
 }
 if(legacy){
   const wirePath=join(fixed.operationRoot,'implementer/stdin.ndjson'),wire=await readFile(wirePath);
   const start=wire.toString().trim().split('\n').map(line=>JSON.parse(line)).find(frame=>frame.method==='thread/start');
   assert.equal(hash(canonical(start.params.dynamicTools)),'30d2e7a5e87a305d3ba3d464d97b193af6ae093e2db70b0c004f370146f85e3f');
   await f.app.close();
   const reopened=await startWorkbench(f.planPath,undefined,{githubReader:f.github});
   t.after(()=>reopened.close());
   const url=new URL(reopened.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)};
   await fetch(url.origin+'/api/github/projects',{headers});
   const response=await fetch(url.origin+'/api/implementation-report/implementation/'+id,{headers});
   assert.equal(response.status,200);assert.deepEqual(await response.json(),report.value);
   const catalog=join(f.project.root,'implementation-catalog.json');
   const controls=await IssueImplementationControls.load(catalog,hash(await readFile(catalog)),f.entry.repository,async number=>({number,title:'Original Issue',body:f.body,url:'https://github.com/fixture/reception/issues/'+number}),async()=>{});
   t.after(()=>controls.drain());
   const proof=await controls.ownerFeedbackProof(f.messages.store,{source:'implementation',requestId:id,task:state.task,operation:state.operation,requestSha256:state.requestSha256});
   assert.equal(proof.H,report.value.H1);
   assert.equal(await readFile(manifestPath,'utf8'),legacyManifest);
   assert.deepEqual(await readFile(wirePath),wire);
 }
});

for(const destination of ['src/shared/normalize.mjs','__proto__'])test('normal project file implementation reports the exact deletion and rename on original result readback'+(destination==='__proto__'?' (__proto__)':''),async t=>{
 const f=await implementationPage(t,false,'normal',false,undefined,false,true,destination),id='project-file-moves';
 const prepared=await f.post('prepare',{requestId:id,issueNumber:74});assert.equal(prepared.status,200,JSON.stringify(prepared.value));
 assert.equal((await f.post('start',{requestId:id})).status,202);
 const done=await f.settled(id);assert.equal(done.status,'completed',JSON.stringify(done));
 const reportPath='/api/implementation-report/implementation/'+id,result=await f.get(reportPath);
 assert.equal(result.status,200,JSON.stringify(result.value));
 assert.equal(result.value.tests.passed,true);
 assert.match(result.value.diff,/rename from src\/normalize\.mjs/);
 assert.match(result.value.diff,/deleted file mode 100644/);
 assert.ok(result.value.diff.includes('rename to '+destination));
 assert.deepEqual(result.value.changed,['README.md','src/index.mjs','src/normalize.mjs',destination].sort());
 const state=f.messages.q.issueImplementations().state('implementation',id),{workspace,operationRoot}=state.plan;
 const before=await git(workspace,['ls-tree',state.H0,'src/normalize.mjs']);
 assert.equal(await git(workspace,['ls-tree',result.value.H1,destination]),before.replace(/\tsrc\/normalize\.mjs$/,'\t'+destination));
 assert.equal(await git(workspace,['rev-parse',result.value.H1+'^{tree}']),result.value.testCandidateBinding.candidateTree);
 const wirePath=join(operationRoot,'implementer/stdin.ndjson'),wire=await readFile(wirePath),index=await readFile(join(workspace,'.git/index'));
 await f.app.close();
 const reopened=await startWorkbench(f.planPath,undefined,{githubReader:f.github});
 t.after(()=>reopened.close());
 const url=new URL(reopened.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)};
 await fetch(url.origin+'/api/github/projects',{headers});
 const get=()=>fetch(url.origin+reportPath,{headers});
 const cold=await get();assert.equal(cold.status,200);assert.deepEqual(await cold.json(),result.value);
 if(destination==='__proto__'){
   const calls=join(operationRoot,'calls'),names=await readdir(calls);
   for(const tool of ['tongxu_delete_file','tongxu_rename_file']){
     const name=names.find(name=>name.includes('-'+tool+'-'));assert.ok(name);
     const path=join(calls,name),original=await readFile(path),receipt=JSON.parse(original.toString());
     for(const damage of [{beforeFile:{...receipt.beforeFile,sha256:'a'.repeat(64)}},{afterTreeSha256:'a'.repeat(64)}]){
       await writeFile(path,JSON.stringify({...receipt,...damage}));
       const rejected=await get();assert.equal(rejected.status,503);assert.equal((await rejected.json() as any).error,'implementation_edit_receipt_changed');
       await writeFile(path,original);
     }
   }
   assert.deepEqual(await (await get()).json(),result.value);
   assert.deepEqual(await readdir(calls),names);
 }
 assert.deepEqual(await readFile(wirePath),wire);
 assert.deepEqual(await readFile(join(workspace,'.git/index')),index);
 assert.equal(await git(workspace,['rev-parse','HEAD']),result.value.H1);
 assert.equal(treeHash(await tree(workspace,true)),result.value.treeSha256);
});

for(const outcome of ['stop','failed','stop-after-move','failed-after-move'] as const)test('project file workbench reads back '+outcome+' without another execution',async t=>{
 const moved=outcome.endsWith('-after-move'),failed=outcome.startsWith('failed'),path=moved?'__proto__':'src/fallbacks/default-label.mjs';
 const f=await implementationPage(t,false,'normal',false,undefined,false,true,moved?path:undefined,failed);
 const id='project-files-'+outcome;
 let resume=()=>{};
 if(!failed){
   const original=RepairTools.prototype.call,paused=new Promise<void>(resolve=>{resume=resolve;});
   t.mock.method(RepairTools.prototype,'call',async function(this:RepairTools,...args:Parameters<RepairTools['call']>){
     const response=await original.apply(this,args);
     if(moved&&args[0].tool==='tongxu_delete_file'){
       const mid='src/intermediate/normalize.mjs',originalBytes=await readFile(join(this.workspace,path));
       const edited=originalBytes.toString()+'\n// retained after successive moves\n';
       await original.call(this,{tool:'tongxu_rename_file',callId:'retained-first-move',arguments:{path,destination:mid,expectedSha256:hash(originalBytes)}});
       await original.call(this,{tool:'tongxu_replace_file',callId:'retained-edit',arguments:{path:mid,text:edited,expectedSha256:hash(originalBytes)}});
       await original.call(this,{tool:'tongxu_rename_file',callId:'retained-final-move',arguments:{path:mid,destination:path,expectedSha256:hash(edited)}});
       await paused;
     }else if(!moved&&args[0].tool==='tongxu_create_file')await paused;
     return response;
   });
 }
 assert.equal((await f.post('prepare',{requestId:id,issueNumber:74})).status,200);
 const state=f.messages.q.issueImplementations().state('implementation',id),workspace=state.plan.workspace,operation=state.plan.operationRoot;
 try{
   assert.equal((await f.post('start',{requestId:id})).status,202);
   if(!failed){
     for(let i=0;i<500&&!await exists(join(workspace,path));i++)await new Promise(r=>setTimeout(r,10));
     assert.equal(await exists(join(workspace,path)),true);
     if(moved){
       for(let i=0;i<500&&await exists(join(workspace,'README.md'));i++)await new Promise(r=>setTimeout(r,10));
       assert.equal(await exists(join(workspace,'README.md')),false);
       const receipt=join(operation,'calls','retained-final-move.json');
       for(let i=0;i<500&&!await exists(receipt);i++)await new Promise(r=>setTimeout(r,10));
       assert.equal(JSON.parse(await readFile(receipt,'utf8')).status,'applied');
     }
     assert.equal((await f.post('stop',{requestId:id})).value.stopped,true);
   }
 }finally{resume();}
 await f.settled(id);
 assert.equal(await git(workspace,['diff','--cached','--name-only']),'');
 const index=await readFile(join(workspace,'.git/index'));
 const reportPath='/api/implementation-report/implementation/'+id;
 const result=await f.get(reportPath);
 assert.equal(result.status,200,JSON.stringify(result.value));
 assert.equal(result.value.H1,null);
 assert.match(result.value.diff,moved?/new file mode 100644/:/new file mode 100755/);
 assert.ok(result.value.diff.includes(path));
 if(moved){
   assert.match(result.value.diff,/deleted file mode 100644/);
   assert.match(result.value.diff,/--- a\/README\.md/);
   assert.match(result.value.diff,/--- a\/src\/normalize\.mjs/);
   assert.match(result.value.diff,/\+\+\+ b\/__proto__/);
 }
 assert.equal(await git(workspace,['rev-parse','HEAD']),state.H0);
 assert.deepEqual(await readFile(join(workspace,'.git/index')),index);
 if(!failed){
   assert.equal(result.value.status,'partial_or_unknown');
   assert.equal(result.value.completeCapture,false);
   if(moved){
     assert.deepEqual(result.value.retainedAdditions,[path]);
     assert.match(result.value.diff,/\+\/\/ retained after successive moves/);
   }
   else assert.match(result.value.diff,/\+export const defaultLabel='Untitled';/);
 }else{
   assert.equal(result.value.status,'validation_failed',JSON.stringify(result.value));
   assert.equal(result.value.report.decision,'implemented');
   assert.equal(result.value.tests.executionHealthy,true);
   assert.equal(result.value.tests.passed,false);
   assert.deepEqual(result.value.changed,(moved?[path,'README.md','src/index.mjs','src/normalize.mjs']:[path,'src/index.mjs']).sort());
   const tool=result.value.tests.tools[0];
   assert.equal(tool.exitCode,1);
   assert.match(tool.stdout,/project test progress/);
   assert.doesNotMatch(tool.stdout,/empty labels need the fixed fallback/);
   assert.doesNotMatch(tool.stderr,/stderr original tail/);
   assert.equal(tool.stdoutOriginal.previewTruncated,true);
   assert.equal(tool.stderrOriginal.previewTruncated,true);
   assert.deepEqual(result.value.tests.unexecutedTools,['after-failure']);
   assert.equal(await exists(join(operation,'attempt-1/post-repair-1')),false);
   const pairs=JSON.parse(await readFile(join(operation,'implementer/reconciled-tools.json'),'utf8'));
   const toolReply=pairs.findLast((pair:any)=>pair.request.params.tool==='tongxu_run_tests').response.result;
   const modelTool=JSON.parse(toolReply.contentItems[0].text).tools[0];
   for(const field of ['stdout','stderr','stdoutOriginal','stderrOriginal'])assert.equal(modelTool[field],undefined);
 }
 const sent=join(operation,'implementer/stdin.ndjson'),before=await readFile(sent);
 assert.deepEqual(await f.get(reportPath),result);
 await f.app.close();
 const reopened=await startWorkbench(f.planPath,undefined,{githubReader:f.github});
 try{
   const url=new URL(reopened.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)};
   await fetch(url.origin+'/api/github/projects',{headers});
   const response=await fetch(url.origin+reportPath,{headers});
   assert.equal(response.status,200);assert.deepEqual(await response.json(),result.value);
   if(failed){
     const actualTests=await readdir(join(operation,'tests'));
     assert.equal(actualTests.length, moved ? 1 : 2);
     const failure=JSON.parse(await readFile(join(operation,'failure.json'),'utf8'));
     const selected='tool-'+failure.projectValidationCallId;
     const earlier=actualTests.find(entry=>entry!==selected);
     assert.ok(actualTests.includes(selected));
     if(!moved){
       assert.ok(earlier);
       assert.equal(JSON.parse(await readFile(join(operation,'tests',earlier,'result.json'),'utf8')).passed,true);
       const wire=JSON.parse(await readFile(join(operation,'implementer/reconciled-tools.json'),'utf8'));
       const old=wire.find((p:any)=>'tool-'+p.request.params.callId===earlier);
       assert.ok(old);
       const replayDirectory=join(f.project.root,'duplicate-transport-receipt');
       await mkdir(replayDirectory);
       // Isolate selection from transport's capture-integrity check. The two
       // actual test originals still come from the normal HTTP execution.
       await writeFile(join(replayDirectory,'reconciled-tools.json'),JSON.stringify([...wire,{...old,request:{...old.request,id:'retried-old-pass'}}]));
       const plan=JSON.parse(await readFile(state.plan.path,'utf8'));
       const last=await readLatestProjectToolValidation(operation,replayDirectory,plan);
       assert.equal('tool-'+last.callId,selected);
       assert.equal(last.result.passed,false);
     }
     assert.equal(JSON.parse(await readFile(join(operation,'tests',selected,'result.json'),'utf8')).passed,false);
     assert.equal(await exists(join(operation,'tests',selected,'tool-1')),false);
     const tool=result.value.tests.tools[0],toolPath=url.origin+reportPath+'/logs/'+tool.id;
     const logs=join(operation,'tests',selected,'tool-0');
     for(const stream of ['stdout','stderr'] as const){
       const original=await readFile(join(logs,stream));
       const download=await fetch(toolPath+'/'+stream,{headers});
       assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/octet-stream');
       const bytes=Buffer.from(await download.arrayBuffer());
       assert.deepEqual(bytes,original);
       assert.equal(bytes.length,tool[stream+'Original'].bytes);assert.equal(hash(bytes),tool[stream+'Original'].sha256);
       if(stream==='stdout'){assert.match(bytes.toString(),/empty labels need the fixed fallback/);assert.match(bytes.toString(),/'Wrong'/);}
       else assert.match(bytes.toString(),/stderr original tail/);
     }
     assert.equal((await fetch(toolPath+'/stdout')).status,401);
     assert.equal((await fetch(url.origin+reportPath+'/logs/after-failure/stdout',{headers})).status,404);
     const stdoutPath=join(logs,'stdout'),stdout=await readFile(stdoutPath);
     await writeFile(stdoutPath,'incomplete original');
     const fallback=await fetch(url.origin+reportPath,{headers});
     assert.equal(fallback.status,200);
     const unknown=await fallback.json() as any;
     assert.equal(unknown.status,'partial_or_unknown');
     assert.equal(unknown.tests,undefined);
     assert.equal(unknown.H1,null);
     assert.ok(unknown.diff.includes(path));
     assert.equal((await fetch(toolPath+'/stdout',{headers})).status,503);
     await writeFile(stdoutPath,stdout);
     const initialPath=join(operation,'initial-tree.json'),initial=await readFile(initialPath);
     try{
       await rm(initialPath);
       for(const damaged of [null,'{','{}']){
         if(damaged!==null)await writeFile(initialPath,damaged);
         const observed=await fetch(url.origin+reportPath,{headers});
         assert.equal(observed.status,200);
         const retained=await observed.json() as any;
         assert.equal(retained.status,'partial_or_unknown');assert.equal(retained.H1,null);
         assert.equal(retained.evidenceGap,'retained_additions_unverified');assert.equal(retained.retainedAdditions,undefined);
         assert.equal(retained.tests,undefined);
         assert.match(retained.diff,/^diff --git a\/src\/index\.mjs b\/src\/index\.mjs/m);
         assert.equal(retained.diff.split('\n').some((line:string)=>line.startsWith('diff --git ')&&line.endsWith(' b/'+path)),false);
       }
     }finally{await writeFile(initialPath,initial);}
   }
 }finally{await reopened.close();}
 assert.deepEqual(await readFile(sent),before);
 assert.deepEqual(await readFile(join(workspace,'.git/index')),index);
});

async function supplementPost(f:Awaited<ReturnType<typeof implementationPage>>,action:string,body:unknown){
 const r=await fetch(f.url.origin+'/api/project-secretary/'+action,{method:'POST',headers:{...f.headers,Origin:f.url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};
}

async function originalOwnerContact(t:TestContext,resources=true,outcome='implemented',holdQuestion=false){
 const f=await implementationPage(t,resources),id='original-feedback-writer';
 // Explicit fixture capacities, configured before any original request/claim.
 for(const [path,sql] of [[join(f.messages.store,'queue.sqlite'),"UPDATE meta SET value='2' WHERE key='seats'"],...(f.ledger?[[join(f.ledger.root,'original-fixture.sqlite'),'UPDATE capacity SET n=4']]:[])]){const d=new DatabaseSync(path!);d.exec(sql!);d.close();}
 const questionHeld=join(f.project.root,'feedback-question-held'),questionRelease=join(f.project.root,'feedback-question-release');
 const held=join(f.project.root,'feedback-held'),release=join(f.project.root,'feedback-release'),writer=await readFile(f.project.config.codexExecutable,'utf8'),needle="else if(stage==='tongxu_replace_file'){";
 assert.ok(writer.includes(needle));await writeFile(f.project.config.codexExecutable,outcome==='no_change'?writer.replace("if(stage==='tongxu_read_file'){","if(stage==='tongxu_read_file'){"+`fs.writeFileSync(${JSON.stringify(held)},JSON.stringify({pid:process.pid,noChange:true}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);finish({candidateH:context.candidate.H,decision:'no_change',report:'Actual no-change protocol fixture, no tool write or new commit.'});}},20);return;`):writer.replace(needle,needle+`if(!fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(held)},JSON.stringify({pid:process.pid,write:v}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);tool('tongxu_run_tests',{});}},20);return;}`));
 const prepared=await f.post('prepare',{requestId:id,issueNumber:74});assert.equal(prepared.status,200,JSON.stringify(prepared));const a=f.messages.q.issueImplementations().state('implementation',id),workspace=join(f.project.root,'feedback-b-source');await cp(f.project.objects,workspace,{recursive:true});
 const definition=parseDevelopmentTask(Buffer.from(canonical({schemaVersion:1,kind:'tongxu-development-task',id:'independent-feedback-b',repository:f.entry.repository,title:'Independent B asks exact A',goal:'Investigate independently and obtain current original-owner feedback before dependent work',acceptance:['Full actual reply and current contract; no writing permission'],source:'Explicit F11 bounded fixture',issue:null,context:f.entry.context,workspace,base:f.entry.base,target:'main',paths:['src/normalize.mjs']}))),b=f.messages.q.tasks().observe(definition,await observeTaskWorkspace(definition));
 const model=await readFile(f.messages.codex,'utf8'),old="'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId",replacement=`(()=>{const c=JSON.parse(x.material.find(m=>m.name==='task-owner-context.json').text);if(x.messageId==='feedback-ask'){${holdQuestion?`fs.writeFileSync(${JSON.stringify(questionHeld)},'actual B input held');while(!fs.existsSync(${JSON.stringify(questionRelease)})){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}`:''}const p=x.body.match(/"planSha256":"([a-f0-9]{64})"/);return JSON.stringify({kind:'tongxu-task-contact-request',planSha256:p[1],contactId:'original-a',report:'B needs the exact current normalize contract from original A.'});}const sender=c.sender&&c.historyProjection.materials[c.sender.reply.historyRef].value.report;if(x.messageId==='feedback-answer')return 'Actual readonly A received '+JSON.parse(sender).report+' Current head '+c.ownerFeedback.effectiveHead+'; original task '+c.ownerFeedback.logicalOwner;return 'B consumed actual A reply: '+sender+'; current head '+c.ownerFeedback.effectiveHead;})()`;assert.ok(model.includes(old));const changed=model.replace(old,replacement);await writeFile(f.messages.codex,changed);
 const adoption=f.messages.q.authority().forScope(f.entry.context.scope.id,{item:b.item,target:'main'}).currentAdoption,authorization=await f.owner.adopt({kind:'delegate',adoption,roles:['coordinator'],targets:['main'],actions:['coordinate'],paths:[],resourceRefs:f.ledger?[f.ledger.profile.resources[0]!.ref]:[],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const participant=(task:string,actor:string)=>({id:actor,item:task,tool:'codex' as const,role:'issue_owner' as const,parent:null,executable:f.messages.codex,executableSha256:hash(changed),disabledMcpServers:[],allowedInstructionSources:[]}),request=(task:string,name:string,actor:string,question:string)=>({schemaVersion:1 as const,kind:'tongxu-task-owner-request' as const,id:name,task,source:'Explicit F11 current owner contact',question,from:null,participant:participant(task,actor),executionKind:'fixture' as const,authorityIntent:'intent-'+name,...(f.ledger?{resourceBudget:[{ledgerId:f.ledger.profile.ledgerId,resourceRef:f.ledger.profile.resources[0]!.ref,unit:f.ledger.profile.resources[0]!.unit,quantity:1}]}:{}),billing:f.messages.plan.billing,timeoutMs:holdQuestion?60000:10000});
 const target={source:'implementation',requestId:id,task:a.task,operation:a.operation,requestSha256:a.requestSha256},plan:TaskContactChoice={schemaVersion:2,kind:'tongxu-task-owner-choice',authorization:{coordinate:authorization.sha},initial:request(b.item,'feedback-ask','B','Investigate your fixed independent source and ask original A if current shared behavior is unknown.'),contacts:[{id:'original-a',title:'Original writing responsibility A',originalImplementation:target,request:request(a.task,'feedback-answer','A','Answer the exact B question using the original implementation and current committed source.'),followup:request(b.item,'feedback-continue','B','Consume the actual current A response and continue with exact evidence; no writing permission.')} ]};
 let feedbackBody=f.body;
 const path=join(f.project.root,'implementation-catalog.json'),controls=await IssueImplementationControls.load(path,hash(await readFile(path)),f.entry.repository,async number=>({number,title:'Original adopted issue',body:feedbackBody,url:'https://github.com/fixture/reception/issues/'+number}),async()=>{});t.after(()=>controls.drain());
 const host={target:(store:string,target:typeof plan.contacts[number]['originalImplementation'])=>controls.ownerFeedbackTarget(store,target!),proof:(store:string,target:typeof plan.contacts[number]['originalImplementation'])=>controls.ownerFeedbackProof(store,target!)};
 const start=async()=>{await f.post('start',{requestId:id});for(let n=0;n<3000;n++){try{const v=JSON.parse(await readFile(held,'utf8'));process.kill(v.pid,0);return v;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}throw new Error('original_feedback_fixture_not_held');};
 t.after(async()=>{try{if(holdQuestion)await writeFile(questionRelease,'release B on cleanup');await writeFile(release,'release original fixture on cleanup');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}});return {...f,writerId:id,target,plan,b,definition,controls,host,start,held,questionHeld,changeContactIssue:(body:string)=>{feedbackBody=body;},releaseQuestion:()=>writeFile(questionRelease,'release actual B question'),release:()=>writeFile(release,'release original fixture'),raw:()=>Buffer.from(canonical(plan))};
}

test('original owner contact waits for actual writer H1, uses distinct governed readonly messages and returns current feedback to B',async t=>{
 const f=await originalOwnerContact(t),q=f.messages.q;await f.start();try{const before=q.tasks().current(f.b.item);
 const waiting=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(waiting.completed,false);assert.equal(waiting.newModelRequests,1);assert.match(waiting.waiting!,/owner_feedback_original_pending_or_unknown/);
 assert.equal(q.taskInbox().status(f.target.task).length,0);assert.equal(f.ledger!.state().claims.length,2);const view=await observeTaskContactChoice(f.messages.store,f.raw());assert.equal(view.complete,false);assert.equal(view.steps.at(-1).deliveryRegistered,false);
 await f.release();const implementation=await f.settled(f.writerId);assert.equal(implementation.status,'completed');const done=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(done.completed,true,done.waiting??'');assert.equal(done.newModelRequests,2);assert.equal(q.tasks().current(f.b.item).fingerprint,before.fingerprint);
 const full=await observeTaskContactChoice(f.messages.store,f.raw(),true);assert.equal(full.complete,true,full.waiting??'');assert.ok('ownerFeedback' in full&&full.ownerFeedback);assert.equal(full.ownerFeedback.current,true);assert.equal(full.ownerFeedback.source.effectiveHead,implementation.H1);assert.ok(full.steps.at(-1).report.reportText.includes(implementation.H1));
 const original=q.issueImplementations().state('implementation',f.writerId);assert.equal(original.result.H1,implementation.H1);assert.equal(f.ledger!.state().claims.length,4);assert.equal(f.ledger!.state().settlements.length,4);const trace=await readFile(f.messages.trace);
 const replay=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(replay.newModelRequests,0);assert.equal(replay.completed,true);assert.deepEqual(await readFile(f.messages.trace),trace);
 const later={...f.plan.initial,id:'feedback-later',authorityIntent:'intent-feedback-later'};q.taskInbox().enqueue(Buffer.from(canonical(later)));const prepared=await prepareTaskOwner(f.messages.store,f.b.item,later.id),context=JSON.parse(await readFile(join(dirname(prepared.plan),'context.json'),'utf8')),reports=Object.values(context.historyProjection.materials).filter((m:any)=>m.source.name==='original-implementation-report') as any[];assert.equal(context.previousExecutions.length,2);assert.equal(reports.length,1);assert.equal(reports[0].source.task,f.target.task);assert.equal(reports[0].source.operation,f.target.operation);assert.deepEqual(reports[0].value,original.result.report);assert.deepEqual(await readFile(f.messages.trace),trace);
 }finally{await f.release();}
});

async function originalOwnerPage(t:TestContext,outcome='implemented',holdQuestion=false){
 const f=await originalOwnerContact(t,true,outcome,holdQuestion);await f.app.close();
 const request=join(f.project.root,'feedback-choice.json');await writeFile(request,f.raw());
 const catalogPath=join(f.project.root,'feedback-controls.json'),current=f.messages.q.tasks().current(f.b.item),catalog={schemaVersion:1,kind:'tongxu-task-controls',contacts:[{id:'owner-feedback',title:'Ask current original owner',source:'independent-b',packet:current.packet,sourceSha256:current.fingerprint,request:{path:request,sha256:hash(await readFile(request))}}]};await writeFile(catalogPath,canonical(catalog));
 const plan=JSON.parse(await readFile(f.planPath,'utf8'));plan.sources=[{id:'independent-b',title:'Independent B',store:f.messages.store,item:f.b.item}];plan.controls={path:catalogPath,sha256:hash(await readFile(catalogPath))};assert.equal(plan.projectSecretary,undefined);await writeFile(f.planPath,canonical(plan));
 const open=async()=>{const app=await startWorkbench(f.planPath,undefined,{githubReader:f.github}),close=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await close();}};t.after(()=>app.close());const url=new URL(app.url),headers={Authorization:'Bearer '+url.hash.slice(1),'X-Tongxu-Account':'7','X-Tongxu-Project':'1'},get=async(path='/api/state')=>{const r=await fetch(url.origin+path,{headers});return {status:r.status,value:await r.json() as any};},post=async(path:string,body:unknown={})=>{const r=await fetch(url.origin+path,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};await get('/api/github/projects');return {app,url,get,post};};
 const app=await open(),wait=async(predicate:(v:any)=>boolean,read=app.get)=>{const until=Date.now()+50000;while(Date.now()<until){const v=await read();assert.equal(v.status,200,JSON.stringify(v));if(predicate(v.value))return v.value;await new Promise(r=>setTimeout(r,20));}throw new Error('original_feedback_page_timeout');};
 const start=async()=>{assert.equal((await app.post('/api/implementation/implementation/start',{requestId:f.writerId})).status,202);for(let n=0;n<1500;n++){try{return JSON.parse(await readFile(f.held,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}throw new Error('original_feedback_writer_timeout');};
 const startExternal=async()=>{await f.controls.begin('implementation',f.writerId);for(let n=0;n<1500;n++){try{return JSON.parse(await readFile(f.held,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}throw new Error('original_feedback_writer_timeout');};
 return {...f,page:app,open,wait,start,startExternal};
}

test('normal owner feedback page automatically returns actual H1 answer to B without secretary or extra dispatch',async t=>{
 const f=await originalOwnerPage(t);await f.start();try{
 const before=await f.page.get();assert.equal(before.status,200,JSON.stringify(before));assert.equal(before.value.taskControls.length,1);assert.equal(before.value.tasks.length,2);assert.equal(before.value.secretaries,undefined);
 assert.equal((await f.page.post('/api/task-control/owner-feedback/start')).status,202);
 const waiting=await f.wait(v=>v.taskControls[0].contactChoice?.ownerFeedback&&!v.taskControls[0].controllerActive);assert.equal(waiting.taskControls[0].phase,'waiting');assert.equal(waiting.taskControls[0].currentMaterial,true);assert.equal(f.messages.q.taskInbox().status(f.target.task).length,0);assert.equal(f.ledger!.state().claims.length,2);
 await f.release();const done=await f.wait(v=>v.taskControls[0].contactChoice?.complete&&!v.taskControls[0].controllerActive);assert.equal(done.taskControls[0].phase,'returned');const h1=done.issueImplementations[0].requests[0].H1;assert.ok(h1);const report=await f.page.get('/api/task-control-report/owner-feedback');assert.equal(report.status,200,JSON.stringify(report));assert.equal(report.value.complete,true);assert.match(report.value.steps.at(-1).report.reportText,/B consumed actual A reply/);assert.ok(report.value.steps.at(-1).report.reportText.includes(h1));assert.equal(report.value.ownerFeedback.source.newReadonlyContext,true);assert.equal(report.value.ownerFeedback.source.nativeSessionResumed,false);assert.equal(f.ledger!.state().claims.length,4);assert.equal(f.ledger!.state().settlements.length,4);
 const trace=await readFile(f.messages.trace);assert.equal((await f.page.post('/api/task-control/owner-feedback/start')).status,202);await f.wait(v=>!v.taskControls[0].controllerActive);assert.deepEqual(await readFile(f.messages.trace),trace);
 }finally{await f.release();}
});

test('original owner feedback waiting cancellation is durable and never dispatches A after writer success or cold replay',async t=>{
 const f=await originalOwnerPage(t);await f.start();try{
 assert.equal((await f.page.post('/api/task-control/owner-feedback/start')).status,202);await f.wait(v=>v.taskControls[0].contactChoice?.ownerFeedback&&!v.taskControls[0].controllerActive);
 const cancelled=await f.page.post('/api/task-control/owner-feedback/cancel');assert.equal(cancelled.status,200,JSON.stringify(cancelled));assert.equal(cancelled.value.result.cancelled,true);assert.equal(f.messages.q.taskInbox().status(f.target.task).length,0);
 await f.release();await f.wait(v=>v.issueImplementations[0].requests[0].phase==='returned'&&!v.issueImplementations[0].requests[0].controllerActive);assert.equal(f.ledger!.state().claims.length,2);const trace=await readFile(f.messages.trace);await f.page.app.close();const cold=await f.open();const view=await cold.get();assert.equal(view.status,200);assert.equal(view.value.taskControls[0].phase,'cancelled');assert.equal((await cold.post('/api/task-control/owner-feedback/start')).status,202);await f.wait(v=>!v.taskControls[0].controllerActive,cold.get);assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.ledger!.state().claims.length,2);
 }finally{await f.release();}
});

test('original owner feedback cold read starts no input and explicit continue returns the same captured B question',async t=>{
 const f=await originalOwnerPage(t);await f.startExternal();try{
 await f.page.post('/api/task-control/owner-feedback/start');await f.wait(v=>v.taskControls[0].contactChoice?.ownerFeedback&&!v.taskControls[0].controllerActive);
 await f.page.app.close();await f.release();for(let n=0;n<1000;n++){if(f.messages.q.issueImplementations().state('implementation',f.writerId).result)break;await new Promise(r=>setTimeout(r,20));}assert.equal(f.messages.q.issueImplementations().state('implementation',f.writerId).result.status,'completed');const trace=await readFile(f.messages.trace),cold=await f.open();for(let n=0;n<2;n++){const view=await cold.get();assert.equal(view.status,200);assert.equal(view.value.taskControls[0].phase,'waiting');assert.equal(view.value.taskControls[0].currentMaterial,true);}assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.ledger!.state().claims.length,2);
 const begun=await cold.post('/api/task-control/owner-feedback/start');assert.equal(begun.status,202,JSON.stringify(begun));const done=await f.wait(v=>v.taskControls[0].phase==='returned'&&!v.taskControls[0].controllerActive,cold.get);assert.equal(done.taskControls[0].contactChoice.steps.length,3);assert.equal(f.ledger!.state().claims.length,4);assert.equal(f.ledger!.state().settlements.length,4);
 }finally{await f.release();}
});

// Wait on the actual original implementation/ledger, including when the page
// fixture has already closed its first HTTP server.
async function finishOriginalOwner(f:Awaited<ReturnType<typeof originalOwnerContact>>){
 const waiting=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(waiting.newModelRequests,1);assert.equal(waiting.waiting,'owner_feedback_original_pending_or_unknown');await f.release();
 for(let n=0;n<1500;n++){const s=f.messages.q.issueImplementations().state('implementation',f.writerId);if(s.result&&(s.plan.resourceRequests??[]).every((id:string)=>f.messages.q.resources().settledOutcome(id)))break;await new Promise(r=>setTimeout(r,20));}
 const s=f.messages.q.issueImplementations().state('implementation',f.writerId);assert.equal(s.result.status,'completed');assert.notEqual(s.result.H1,s.result.H0);assert.equal(s.result.completeCapture,true);return s;
}
for(const changed of [false,true])test(`original owner feedback bound billing wait cold HTTP ${changed?'rejects changed Issue':'retains unchanged source'}`,async t=>{
 const f=await originalOwnerPage(t);await f.startExternal();try{
 await finishOriginalOwner(f);const stale={...f.messages.plan.billing,observedAt:new Date(Date.now()-3600000).toISOString()},paused=await runTaskContactChoice(f.messages.store,f.raw(),stale,{originalImplementation:f.host});assert.equal(paused.newModelRequests,0);assert.equal(paused.completed,false);
 const before=await observeTaskContactChoice(f.messages.store,f.raw(),true);assert.ok('ownerFeedback' in before&&before.ownerFeedback&&before.ownerFeedback.bound);assert.equal(before.steps[1].complete,false);const binding=f.messages.q.taskInbox().ownerContact(f.b.item,before.ownerFeedback.key),calls=await readFile(f.messages.trace),claims=f.ledger!.state().claims.length;
 await f.page.app.close();if(changed)f.changeIssue(f.body+' changed after original owner binding');const cold=await f.open();await cold.get();assert.deepEqual(await readFile(f.messages.trace),calls);assert.equal((await cold.post('/api/task-control/owner-feedback/start')).status,202);
 const done=await f.wait(v=>!v.taskControls[0].controllerActive&&v.taskControls[0].lastControllerReturn?.stage==='execution',cold.get),c=done.taskControls[0];assert.equal(c.lastControllerReturn.newModelRequests,changed?0:2);assert.equal(c.lastControllerReturn.reason,changed?'owner_feedback_adopted_requirement_changed':null);assert.equal(f.ledger!.state().claims.length,claims+(changed?0:2));assert.equal(f.ledger!.state().settlements.length,claims+(changed?0:2));assert.deepEqual(f.messages.q.taskInbox().ownerContact(f.b.item,before.ownerFeedback.key),binding);
 if(changed){assert.deepEqual(await readFile(f.messages.trace),calls);assert.notEqual(c.contactChoice.steps.at(-1).phase,'returned');assert.equal((await cold.post('/api/task-control/owner-feedback/start')).status,202);await f.wait(v=>!v.taskControls[0].controllerActive&&v.taskControls[0].lastControllerReturn?.newModelRequests===0,cold.get);assert.deepEqual(await readFile(f.messages.trace),calls);assert.equal(f.ledger!.state().claims.length,claims);}else{assert.equal(c.contactChoice.complete,true);assert.match((await cold.get('/api/task-control-report/owner-feedback')).value.steps.at(-1).report.reportText,/B consumed actual A reply/);}
 }finally{await f.release();}
});
for(const segment of ['A','B'])for(const changed of [false,true])test(`original owner feedback shared consumers require current proof for queued ${segment} with ${changed?'changed':'unchanged'} Issue`,async t=>{
 const f=await originalOwnerPage(t);await f.startExternal();try{
 await finishOriginalOwner(f);const currentBilling={...f.messages.plan.billing};let steps=0;
 // Let billing genuinely expire before this segment, after the preceding
 // segment has completed. No message/inbox/claim is rewritten to pause it.
 if(segment==='A')currentBilling.observedAt=new Date(Date.now()-3600000).toISOString();
 const paused=await runTaskContactChoice(f.messages.store,f.raw(),currentBilling,{originalImplementation:f.host,beforeStep:()=>{if(segment==='B'&&++steps===7)currentBilling.observedAt=new Date(Date.now()-3600000).toISOString();}});
 assert.equal(paused.completed,false);assert.equal(paused.newModelRequests,segment==='A'?0:1);
 const before=await observeTaskContactChoice(f.messages.store,f.raw(),true),index=segment==='A'?1:2,selected=before.steps[index].run,task=segment==='A'?f.target.task:f.b.item,id=segment==='A'?'feedback-answer':'feedback-continue';
 assert.ok(selected);assert.ok('ownerFeedback' in before&&before.ownerFeedback);const binding=f.messages.q.taskInbox().ownerContact(f.b.item,before.ownerFeedback.key),trace=await readFile(f.messages.trace),ledger=f.ledger!.state(),proof=await f.host.proof(f.messages.store,f.target);
 if(changed){const body=f.body+' changed after '+segment+' was enqueued';f.changeIssue(body);f.changeContactIssue(body);await assert.rejects(f.host.proof(f.messages.store,f.target),/owner_feedback_adopted_requirement_changed/);}
 const p=await prepareTaskOwner(f.messages.store,task,id);assert.equal(p.run,selected);
 const taskArgs=[resolve('dist/src/task-cli.js'),'work','--store',f.messages.store,'--task',task,'--limit','1'];
 for(let repeat=0;repeat<2;repeat++){
  const worker=JSON.parse((await exec(process.execPath,taskArgs)).stdout);assert.equal(worker.newModelRequests,0);assert.equal(worker.runs[0].run,selected);assert.equal(worker.runs[0].dispatchBlockedReason,'owner_contact_current_source_checker_required');
  const message=JSON.parse((await exec(process.execPath,[resolve('dist/src/message-cli.js'),'run','--store',f.messages.store,'--plan',p.plan])).stdout);assert.equal(message.newModelRequests,0);assert.equal(message.dispatchBlockedReason,'owner_contact_current_source_checker_required');
 }
 const noOp=await runMessages(f.messages.store,p.plan,false,p.run,undefined,undefined,async()=>{});assert.equal(noOp.newModelRequests,0);assert.ok('dispatchBlockedReason' in noOp);assert.equal(noOp.dispatchBlockedReason,'owner_contact_current_source_checker_required');
 const forged=await runMessages(f.messages.store,p.plan,false,p.run,undefined,undefined,async()=>({...proof,target:{...proof.target,requestId:'unrelated-original'}}));assert.equal(forged.newModelRequests,0);assert.ok('dispatchBlockedReason' in forged);assert.equal(forged.dispatchBlockedReason,'owner_feedback_actual_source_proof_required');
 assert.deepEqual(await readFile(f.messages.trace),trace);assert.deepEqual(f.ledger!.state().claims,ledger.claims);assert.deepEqual(f.ledger!.state().settlements,ledger.settlements);assert.deepEqual(f.messages.q.taskInbox().ownerContact(f.b.item,before.ownerFeedback.key),binding);
 const cold=await f.open();await cold.get();assert.deepEqual(await readFile(f.messages.trace),trace);
 if(changed){const blocked=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(blocked.newModelRequests,0);assert.equal(blocked.waiting,'owner_feedback_adopted_requirement_changed');}
 else{
  // The generic worker can contend for this same run, but has no source
  // capability. It cannot acquire resources/input even if it wins the lock.
  const racing=await Promise.all([runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host}),exec(process.execPath,taskArgs).catch(e=>{assert.match(e.stderr,/message_controller_active/);return null;})]);
  const done=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(done.completed,true,done.waiting??'');assert.equal(racing[0].newModelRequests+done.newModelRequests,segment==='A'?2:1);
  assert.equal(f.ledger!.state().claims.length-ledger.claims.length,segment==='A'?2:1);assert.equal(f.ledger!.state().settlements.length-ledger.settlements.length,segment==='A'?2:1);
  const view=await observeTaskContactChoice(f.messages.store,f.raw(),true);assert.equal(view.complete,true);assert.match(view.steps[2].report.reportText,/B consumed actual A reply/);
  const completedTrace=await readFile(f.messages.trace),replay=JSON.parse((await exec(process.execPath,taskArgs)).stdout);assert.equal(replay.newModelRequests,0);assert.deepEqual(await readFile(f.messages.trace),completedTrace);
 }
 if(segment==='B'){
  const answer=await prepareTaskOwner(f.messages.store,f.target.task,'feedback-answer'),replay=await runMessages(f.messages.store,answer.plan,false,answer.run);assert.equal(replay.completed,true);assert.equal(replay.resourcesSettled,true);assert.equal(replay.newModelRequests,0);
 }
 }finally{await f.release();}
});
for(const boundary of ['before-claim','before-send'])test('original owner feedback rechecks Issue '+boundary+' without losing existing claims',async t=>{
 const f=await originalOwnerPage(t);await f.startExternal();try{
 await finishOriginalOwner(f);let proofs=0;const host={...f.host,proof:async(store:string,target:typeof f.target)=>{if(++proofs===(boundary==='before-claim'?3:4))f.changeContactIssue(f.body+' changed at '+boundary);return f.host.proof(store,target);}};
 const blocked=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:host});assert.equal(proofs,boundary==='before-claim'?3:4);assert.equal(blocked.waiting,'owner_feedback_adopted_requirement_changed');assert.equal(blocked.newModelRequests,0);assert.equal((await f.messages.calls()).filter(x=>x.kind==='input').length,1);assert.equal(f.ledger!.state().claims.length,boundary==='before-claim'?2:3);assert.equal(f.ledger!.state().settlements.length,2);
 if(boundary==='before-send'){const view=await observeTaskContactChoice(f.messages.store,f.raw(),true),run=view.steps[1].run!,state=f.messages.q.messages().status(run);assert.equal(state.messages[0]!.sent,null);assert.equal(state.runtimes[0]!.ended.proof.knownUnstarted,true);assert.equal((await cancelTaskChoiceOwnerContact(f.messages.store,f.raw(),'cancel exact proven unstarted owner input after source changed'))!.cancelled,true);assert.equal(f.ledger!.state().claims.length,3);assert.equal(f.ledger!.state().settlements.length,3);}
 if(boundary==='before-claim'){
  const q=f.messages.q,view=await observeTaskContactChoice(f.messages.store,f.raw(),true);assert.ok('ownerFeedback' in view&&view.ownerFeedback);
  const run=view.steps[1].run!,binding=q.messageResources().state(run),id=binding.resourceRequests[0],original=q.resources().status(id),trace=await readFile(f.messages.trace),ledger=f.ledger!.state(),implementation=q.issueImplementations().state('implementation',f.writerId).result;
  assert.equal(original.state,'prepared_not_sent');assert.equal(original.claimAttempts,0);assert.equal(original.claim,null);assert.equal(original.outcome,null);
  for(let n=0;n<2;n++){const cancelled=await f.page.post('/api/task-control/owner-feedback/cancel');assert.equal(cancelled.status,200,JSON.stringify(cancelled));assert.equal(cancelled.value.result.cancelled,true);}
  await f.page.app.close();const cold=await f.open();assert.equal((await cold.post('/api/task-control/owner-feedback/cancel')).value.result.cancelled,true);
  assert.equal(q.taskInbox().ownerContact(f.b.item,view.ownerFeedback.key)!.cancelled,true);assert.equal(q.taskInbox().status(f.target.task).find(x=>x.id==='feedback-answer')!.phase,'cancelled');assert.equal(q.taskInbox().messageClosedUnstarted(run),true);
  assert.equal(q.messageResources().state(run).phase,'cancelled_unstarted');assert.equal(q.messageResources().state(run).operationStatus,'complete');assert.equal(q.messageResources().settled(run),true);assert.deepEqual(q.resources().status(id),original);assert.equal(q.resources().settledOutcome(id),false);
  assert.equal((await cold.post('/api/task-control/owner-feedback/start')).status,202);await f.wait(v=>!v.taskControls[0].controllerActive,cold.get);
  assert.deepEqual(await readFile(f.messages.trace),trace);assert.deepEqual(f.ledger!.state(),ledger);assert.deepEqual(q.issueImplementations().state('implementation',f.writerId).result,implementation);
  const next={...f.plan.contacts[0]!.request,id:'after-cancelled-feedback',authorityIntent:'intent-after-cancelled-feedback'};q.taskInbox().enqueue(Buffer.from(canonical(next)));const prepared=await prepareTaskOwner(f.messages.store,f.target.task,next.id);assert.ok(prepared.run);assert.notEqual(prepared.run,run);assert.deepEqual(await readFile(f.messages.trace),trace);
 }
 }finally{await f.release();}
});
test('original owner feedback replays sent A after Issue change and never repeats its input',async t=>{
 const f=await originalOwnerContact(t);await f.start();try{
 await finishOriginalOwner(f);let calls=0;const paused=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host,beforeStep:()=>{if(++calls===7)throw Error('fixture_pause_before_b_return');}});assert.equal(paused.newModelRequests,1);const before=await observeTaskContactChoice(f.messages.store,f.raw(),true),trace=await readFile(f.messages.trace),run=before.steps[1].run;assert.equal(before.steps[1].report.completeCapture,true);assert.equal(f.ledger!.state().claims.length,3);
 f.changeContactIssue(f.body+' changed after actual A send');for(let n=0;n<2;n++){const replay=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(replay.waiting,'owner_feedback_adopted_requirement_changed');assert.equal(replay.newModelRequests,0);assert.equal(replay.steps[1]!.completed,true);assert.equal(replay.steps[1]!.resourcesSettled,true);assert.equal(replay.steps[1]!.run,run);}
 const after=await observeTaskContactChoice(f.messages.store,f.raw(),true);assert.deepEqual(after.steps[1].report,before.steps[1].report);assert.equal(after.steps[2].phase,'not_registered');assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.ledger!.state().claims.length,3);assert.equal(f.ledger!.state().settlements.length,3);
 }finally{await f.release();}
});

test('original owner feedback rejects changed raw tree, cached index, writer lease and native capture without additional input',async t=>{
 const f=await originalOwnerContact(t);await f.start();try{
 await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});await f.release();await f.settled(f.writerId);const s=f.messages.q.issueImplementations().state('implementation',f.writerId),workspace=s.plan.workspace,path=join(workspace,'src/normalize.mjs'),bytes=await readFile(path),trace=await readFile(f.messages.trace);await f.host.proof(f.messages.store,f.target);
 const blocked=async()=>{const result=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(result.completed,false);assert.equal(result.newModelRequests,0);assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.messages.q.taskInbox().status(f.target.task).length,0);};
 await writeFile(path,Buffer.concat([bytes,Buffer.from('// changed outside original result\n')]));await blocked();await git(workspace,['add','src/normalize.mjs']);await writeFile(path,bytes);await blocked();await git(workspace,['reset','--','src/normalize.mjs']);
 const lease=join(workspace,'.git','tongxu-writer.json');await writeFile(lease,'{"fixture":"unknown writer"}');await blocked();await rm(lease);
 const capture=join(s.plan.operationRoot,'implementer','stderr.txt'),old=await readFile(capture);await writeFile(capture,Buffer.concat([old,Buffer.from('changed original capture')]));await blocked();await writeFile(capture,old);
 const proof=await f.host.proof(f.messages.store,f.target);assert.equal(proof.H,s.result.H1);const done=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(done.completed,true,done.waiting??'');assert.equal(done.newModelRequests,2);
 }finally{await f.release();}
});

test('normal original owner feedback accepts proven no-change H0 without inventing a commit',async t=>{
 const f=await originalOwnerPage(t,'no_change');await f.start();try{
 await f.page.post('/api/task-control/owner-feedback/start');await f.wait(v=>v.taskControls[0].contactChoice?.ownerFeedback&&!v.taskControls[0].controllerActive);await f.release();const done=await f.wait(v=>v.taskControls[0].phase==='returned'&&!v.taskControls[0].controllerActive),original=done.issueImplementations[0].requests[0];assert.equal(original.status,'no_change');assert.equal(original.H1,null);const report=(await f.page.get('/api/task-control-report/owner-feedback')).value;assert.equal(report.ownerFeedback.source.effectiveHead,original.H0);assert.equal(report.ownerFeedback.source.H1,null);assert.ok(report.steps.at(-1).report.reportText.includes(original.H0));const database=new DatabaseSync(join(f.messages.store,'queue.sqlite'));try{const before=database.prepare('SELECT result FROM operations WHERE id=?').get(f.target.operation) as any;assert.equal(JSON.parse(before.result).implementation.resultSha256,hash(canonical(f.messages.q.issueImplementations().state('implementation',f.writerId).result)));assert.throws(()=>database.prepare("UPDATE operations SET result='{}',status='complete' WHERE id=?").run(f.target.operation),/original_issue_implementation_consumer_required/);assert.equal((database.prepare('SELECT result FROM operations WHERE id=?').get(f.target.operation) as any).result,before.result);}finally{database.close();}assert.equal(f.ledger!.state().claims.length,4);assert.equal(f.ledger!.state().settlements.length,4);
 }finally{await f.release();}
});

for(const state of ['stopped','issue-changed'])test('original owner feedback '+state+' after H1 cannot submit a readonly owner answer',async t=>{
 const f=await originalOwnerContact(t);await f.start();try{
 await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});await f.release();await f.settled(f.writerId);const trace=await readFile(f.messages.trace);
 let host=f.host;if(state==='stopped')f.messages.q.control(f.entry.context.scope.id,'investment','stopped','explicit fixture stop before owner answer');else{const path=join(f.project.root,'implementation-catalog.json'),controls=await IssueImplementationControls.load(path,hash(await readFile(path)),f.entry.repository,async number=>({number,title:'Changed Issue',body:f.body+' changed original requirement',url:'https://github.com/fixture/reception/issues/'+number}),async()=>{});t.after(()=>controls.drain());host={target:(store,target)=>controls.ownerFeedbackTarget(store,target!),proof:(store,target)=>controls.ownerFeedbackProof(store,target!)};}
 const blocked=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:host});assert.equal(blocked.completed,false);assert.equal(blocked.newModelRequests,0);assert.match(blocked.waiting!,state==='stopped'?/stopped/:/requirement_changed/);assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.ledger!.state().claims.length,2);assert.equal(f.ledger!.state().settlements.length,2);
 }finally{await f.release();}
});

test('original owner completion while B is still answering waits once and cannot lose or duplicate the original contact',async t=>{
 const f=await originalOwnerPage(t,'implemented',true);await f.start();try{
 await f.page.post('/api/task-control/owner-feedback/start');for(let n=0;n<500;n++){if(await exists(f.questionHeld))break;await new Promise(r=>setTimeout(r,20));}assert.equal(await exists(f.questionHeld),true);await f.release();const during=await f.wait(v=>v.issueImplementations[0].requests[0].phase==='returned');assert.equal(during.taskControls[0].controllerActive,true);assert.equal(f.messages.q.taskInbox().status(f.target.task).length,0);await f.releaseQuestion();const done=await f.wait(v=>v.taskControls[0].phase==='returned'&&!v.taskControls[0].controllerActive&&!v.issueImplementations[0].requests[0].controllerActive);assert.equal(done.taskControls[0].contactChoice.steps.length,3);assert.equal(f.ledger!.state().claims.length,4);assert.equal(f.ledger!.state().settlements.length,4);assert.equal(f.messages.q.taskInbox().status(f.target.task).length,1);
 }finally{await f.releaseQuestion();await f.release();}
});

for(const cut of ['before-a','before-b-return'])test('original owner feedback cancellation '+cut+' retains earlier captures and cancels only the next unsent segment',async t=>{
 const f=await originalOwnerContact(t);await f.start();try{
 await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});await f.release();await f.settled(f.writerId);let count=0;const stopped=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host,beforeStep:()=>{if(++count===(cut==='before-a'?4:7))throw new Error('explicit_fixture_pause_before_next_input');}});assert.equal(stopped.completed,false);assert.equal(stopped.waiting,'explicit_fixture_pause_before_next_input');assert.equal(stopped.newModelRequests,cut==='before-a'?0:1);const claims=f.ledger!.state().claims.length,trace=await readFile(f.messages.trace);
 const cancellation=await cancelTaskChoiceOwnerContact(f.messages.store,f.raw(),'explicit fixture cancel original next unsent');assert.ok(cancellation);assert.equal(cancellation.cancelled,true);const replay=await runTaskContactChoice(f.messages.store,f.raw(),undefined,{originalImplementation:f.host});assert.equal(replay.completed,false);assert.equal(replay.waiting,'owner_contact_cancelled');assert.equal(replay.newModelRequests,0);assert.deepEqual(await readFile(f.messages.trace),trace);assert.equal(f.ledger!.state().claims.length,claims);assert.equal(f.ledger!.state().settlements.length,claims);const view=await observeTaskContactChoice(f.messages.store,f.raw(),true);assert.equal(view.steps[0].report.completeCapture,true);assert.ok('ownerFeedback' in view&&view.ownerFeedback?.cancelled);
 }finally{await f.release();}
});

test('dynamic original implementation recipients require the exact owner mode before any model dispatch',async t=>{
 const f=await originalOwnerContact(t),raw=f.raw(),current=f.messages.q.tasks().current(f.b.item),path=join(f.project.root,'recipient-mode-request.json'),catalogPath=join(f.project.root,'recipient-mode-catalog.json'),sources=[{id:'independent-b',store:f.messages.store,item:f.b.item}],recipientSources=[...sources,{id:'managed-a',store:f.messages.store,item:f.target.task}];
 const check=async(plan:TaskContactChoice)=>{await writeFile(path,canonical(plan));await writeFile(catalogPath,canonical({schemaVersion:1,kind:'tongxu-task-controls',contacts:[{id:'bounded-contact',title:'Exact dynamic target',source:sources[0]!.id,packet:current.packet,sourceSha256:current.fingerprint,request:{path,sha256:hash(await readFile(path))}}]}));return TaskControls.load(catalogPath,hash(await readFile(catalogPath)),sources,new Set(recipientSources.map(s=>s.id)),{recipientSources,originalImplementation:f.host});};
 const legacy=JSON.parse(raw.toString());legacy.schemaVersion=1;delete legacy.authorization;delete legacy.contacts[0].originalImplementation;await assert.rejects(check(legacy),/task_choice_recipient_not_selected/);assert.equal((await f.messages.calls()).filter((x:any)=>x.kind==='input').length,0);const exact=await check(f.plan);t.after(()=>exact.drain());assert.equal(exact.manifest().contacts.length,1);assert.equal((await f.messages.calls()).filter((x:any)=>x.kind==='input').length,0);
});

async function secretaryWorkPage(t:TestContext,mode='coordinate',beforeIssue?:()=>Promise<void>,outcome?:'no_change'|'needs_owner'|'incomplete'){
 const decorate:((original:GitHubReaderFactory)=>GitHubReaderFactory)|undefined=beforeIssue?original=>async signal=>{const reader=await original(signal);return {query:async(op,variables,querySignal)=>{if(op==='issue')await beforeIssue();return reader.query(op,variables,querySignal);}};}:undefined;
 const f=await implementationPage(t,true,'normal',true,decorate),path=f.project.config.codexExecutable;let script=await readFile(path,'utf8');
 const reply="const v=JSON.parse(m.result.contentItems[0].text);if(stage==='tongxu_read_file'){",replacement="const v=JSON.parse(m.result.contentItems[0].text);if(stage==='tongxu_coordinate_selected_work'||stage==='tongxu_project_info'){finish({candidateH:context.candidate.H,report:'Explicit secretary fixture read the actual coordination observation, not an implementation completion claim.',observationIds:[v.observationId]});return;}if(stage==='tongxu_read_file'){";assert.ok(script.includes(reply));script=script.replace(reply,replacement);
 const turn="if(m.method==='turn/start'){",special=`if(m.method==='turn/start'&&m.params.outputSchema.properties.observationIds){current='secretary-turn-'+(++turn);context=JSON.parse(m.params.input[0].text);log({kind:'model-input',role:'secretary',schema:m.params.outputSchema,context});emit({id:m.id,result:{turn:{id:current}}});emit({method:'turn/started',params:{threadId:thread.id,turn:{id:current,status:'inProgress',items:[],rootTurnId:current}}});if(${JSON.stringify(mode)}==='no-coordinate'){finish({candidateH:context.candidate.H,report:'Explicit fixture saved work intent; coordinator not called yet.',observationIds:[context.initialObservation.observationId]});return;}tool(context.workTarget||${JSON.stringify(mode)}==='malicious-query'?'tongxu_coordinate_selected_work':'tongxu_project_info',${JSON.stringify(mode)}==='extra-arguments'?{source:'not-selected'}:{});return;}`;assert.ok(script.includes(turn));script=script.replace(turn,special+turn);
 script=script.replace("if(m.method==='thread/start'){", "if(m.method==='thread/start'){log({kind:'registered-project-tools',tools:m.params.dynamicTools.map(t=>t.name),instructions:m.params.developerInstructions});");
 if(outcome){script=script.replace("if(stage==='tongxu_read_file'){", "if(stage==='tongxu_read_file'){finish({candidateH:context.candidate.H,decision:"+JSON.stringify(outcome==='needs_owner'?'needs_owner':'no_change')+",report:'Explicit implementation outcome fixture; complete origin received, no new write.'});return;");if(outcome==='incomplete')script=script.replace("phase:'final_answer'", "phase:context?.kind==='project_secretary_question'?'final_answer':'commentary'");}await writeFile(path,script);
 const wait=async(conversation:string,predicate:(v:any)=>boolean)=>{const deadline=Date.now()+45000;while(Date.now()<deadline){const state=await f.get('/api/project-secretary/conversations/'+conversation);assert.equal(state.status,200,JSON.stringify(state));if(predicate(state.value))return state.value;await new Promise(r=>setTimeout(r,25));}throw new Error('secretary_work_fixture_timeout');};
 const workBody=(text='Implement exactly the selected approved Issue and preserve this entire original message: 完整原话。')=>({conversationId:randomUUID(),requestId:randomUUID(),parent:null,question:text,workTarget:{source:'implementation',issueNumber:74}}),trace=async()=>((await readFile(f.project.trace,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)));
 return {...f,wait,workBody,trace};
}

test('project secretary actually coordinates selected approved work, passes full origin to original implementer and reads the same H1/report without duplicates',async t=>{
 const f=await secretaryWorkPage(t),body=f.workBody();const options=await f.get('/api/project-secretary');assert.equal(options.status,200);assert.equal(options.value.work.options.length,1);assert.equal((await supplementPost(f,'ask',body)).status,202);
 const done=await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed'&&v.workRequests[0]?.original?.status==='completed'&&v.workRequests[0].original.resourcesSettled&&!v.workRequests[0].original.controllerActive),work=done.workRequests[0];assert.equal(work.originalRequestId,body.requestId);assert.equal(work.linkedExisting,false);assert.equal(work.original.originIncludedInCompleteCapture,true);assert.equal(work.original.report.completeCapture,true);const original=f.messages.q.issueImplementations().original('implementation',body.requestId);assert.deepEqual(original.origin,{kind:'project_secretary_work_request',conversationId:body.conversationId,requestId:body.requestId,text:body.question});assert.equal(original.workspaceRequest.contract,f.entry.approvedIssues[0]!.goal);assert.equal(original.issue.bodySha256,hash(f.body));
 const manifest=JSON.parse(await readFile(join(f.messages.q.issueImplementations().state('implementation',body.requestId).plan.operationRoot,'input-manifest.json'),'utf8'));assert.deepEqual(manifest.request.origin,original.origin);const direct=await f.get('/api/implementation-report/implementation/'+body.requestId);assert.equal(direct.value.H1,work.original.H1);assert.deepEqual(direct.value.report,work.original.report.report);assert.equal((await f.get('/api/state')).value.tasks.length,1);
 const before=await f.trace();
 assert.deepEqual(before.find((x:any)=>x.kind==='model-input'&&x.role==='secretary').schema,projectSecretarySchema);
 assert.deepEqual(before.find((x:any)=>x.kind==='model-input'&&x.role==='secretary').context.initialObservation.timeBudget,{limitMs:120000,elapsedMs:null,remainingMs:null});
 const secretaryObservations=JSON.parse(await readFile(join(f.project.root,'project-chats',body.requestId,'observations.json'),'utf8')),budget=secretaryObservations.at(-1).observation.timeBudget;
 assert.equal(budget.limitMs,120000);assert.ok(Number.isSafeInteger(budget.elapsedMs)&&budget.elapsedMs>=0);assert.equal(budget.remainingMs,Math.max(0,120000-budget.elapsedMs));
 assert.match(before.find((x:any)=>x.kind==='registered-project-tools'&&x.tools.includes('tongxu_coordinate_selected_work')).instructions,/Select 1 to 8/);
 assert.equal(before.filter((x:any)=>x.kind==='model-input').length,2);assert.equal(before.filter((x:any)=>x.kind==='registered-project-tools'&&x.tools.includes('tongxu_coordinate_selected_work')).length,1);assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);assert.equal((await supplementPost(f,'ask',body)).value.duplicate,true);await f.get('/api/project-secretary/conversations/'+body.conversationId);assert.deepEqual(await f.trace(),before);
 const second={...f.workBody('Please execute this same approved Issue; do not create a competing task.')};assert.equal((await supplementPost(f,'ask',second)).status,202);const linked=await f.wait(second.conversationId,v=>v.messages[0]?.status==='completed'&&v.workRequests[0]?.original?.status==='completed');assert.equal(linked.workRequests[0].linkedExisting,true);assert.equal(linked.workRequests[0].originalRequestId,body.requestId);assert.equal(linked.workRequests[0].newTextDeliveredToExisting,false);assert.equal(f.messages.q.issueImplementations().requests('implementation').length,1);assert.equal((await f.trace()).filter((x:any)=>x.kind==='model-input').length,3);assert.equal(f.ledger!.state().claims.length,1);
});

for(const mode of ['query','malicious-query','extra-arguments'])test('secretary selected work keeps '+mode+' outside implementation authority',async t=>{
 const f=await secretaryWorkPage(t,mode),body:any=f.workBody();if(mode!=='extra-arguments')delete body.workTarget;assert.equal((await supplementPost(f,'ask',body)).status,202);const done=await f.wait(body.conversationId,v=>v.messages[0]&&!['registered','running','unknown'].includes(v.messages[0].status));assert.equal(done.messages[0].status==='completed',mode==='query');assert.equal(f.messages.q.issueImplementations().requests('implementation').length,0);assert.equal(f.ledger!.state().claims.length,0);const calls=await f.trace(),tools=calls.find((x:any)=>x.kind==='registered-project-tools').tools;assert.equal(tools.includes('tongxu_coordinate_selected_work'),mode==='extra-arguments');assert.equal(calls.filter((x:any)=>x.kind==='model-input').length,1);
});

test('secretary work rejects unsupported target and same-ID mode or target replacement before implementation',async t=>{
 const f=await secretaryWorkPage(t,'no-coordinate'),body=f.workBody();for(const target of [{source:'wrong',issueNumber:74},{source:'implementation',issueNumber:75},{source:'implementation',issueNumber:74,permissions:'implement'}]){const denied=await supplementPost(f,'ask',{...body,workTarget:target});assert.equal(denied.status,503);assert.equal((await f.trace()).filter((x:any)=>x.kind==='model-input').length,0);}assert.equal((await supplementPost(f,'ask',body)).status,202);await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed');const ordinary:any={...body};delete ordinary.workTarget;assert.equal((await supplementPost(f,'ask',ordinary)).status,503);assert.equal((await supplementPost(f,'ask',{...body,question:'replace fixed original'})).status,503);assert.equal(f.messages.q.issueImplementations().requests('implementation').length,0);
});

test('secretary work cancellation before coordination persists without creating an orphan after explicit continue',async t=>{
 const f=await secretaryWorkPage(t,'no-coordinate'),body=f.workBody();await supplementPost(f,'ask',body);await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed');const before=await f.trace(),cancel=await supplementPost(f,'cancel-work',{requestId:body.requestId});assert.equal(cancel.status,200,JSON.stringify(cancel));assert.equal(cancel.value.cancelled,true);assert.equal((await supplementPost(f,'continue-work',{requestId:body.requestId})).status,503);assert.equal((await supplementPost(f,'cancel-work',{requestId:body.requestId})).status,200);const view=(await f.get('/api/project-secretary/conversations/'+body.conversationId)).value;assert.equal(view.workRequests[0].cancelRequested,true);assert.equal(view.workRequests[0].original,null);assert.equal(f.messages.q.issueImplementations().requests('implementation').length,0);assert.deepEqual(await f.trace(),before);assert.equal(f.ledger!.state().claims.length,0);
});

test('secretary work keeps a busy-seat original registration and cancellation prevents later task-page dispatch',async t=>{
 const f=await secretaryWorkPage(t,'no-coordinate'),body=f.workBody();await supplementPost(f,'ask',body);await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed');const held=f.messages.q.begin(f.messages.item,'explicit seat holder before secretary work');assert.ok(held.operation);try{const pending=await supplementPost(f,'continue-work',{requestId:body.requestId});assert.equal(pending.status,503,JSON.stringify(pending));const state=f.messages.q.issueImplementations().state('implementation',body.requestId);assert.equal(state.phase,'registered');assert.equal(f.ledger!.state().claims.length,0);const cancelled=await supplementPost(f,'cancel-work',{requestId:body.requestId});assert.equal(cancelled.status,200,JSON.stringify(cancelled));assert.equal(cancelled.value.original.status,'cancelled_unstarted');}finally{f.messages.q.evaluate(held.operation);}const before=await f.trace();assert.equal((await f.post('start',{requestId:body.requestId})).status,202);await f.settled(body.requestId);assert.deepEqual(await f.trace(),before);assert.equal(f.ledger!.state().claims.length,0);
});

test('two saved secretary work requests concurrently continuing resolve one exact original implementation',async t=>{
 const f=await secretaryWorkPage(t,'no-coordinate'),a=f.workBody('First exact user request'),b=f.workBody('Second request for the same approved Issue');for(const body of [a,b]){assert.equal((await supplementPost(f,'ask',body)).status,202);await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed');}const calls=await Promise.all([supplementPost(f,'continue-work',{requestId:a.requestId}),supplementPost(f,'continue-work',{requestId:b.requestId})]);assert.ok(calls.every(v=>v.status===200),JSON.stringify(calls));const done=await f.wait(a.conversationId,v=>v.workRequests[0]?.original?.status==='completed'&&v.workRequests[0].original.resourcesSettled&&!v.workRequests[0].original.controllerActive),other=(await f.get('/api/project-secretary/conversations/'+b.conversationId)).value;assert.equal(done.workRequests[0].originalRequestId,other.workRequests[0].originalRequestId);assert.equal(f.messages.q.issueImplementations().requests('implementation').length,1);assert.equal((await f.trace()).filter((x:any)=>x.kind==='model-input').length,3);assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);
});

test('secretary work refuses changed approved Issue before original implementation registration',async t=>{
 const f=await secretaryWorkPage(t),body=f.workBody();f.changeIssue(f.body+' changed source before coordination');assert.equal((await supplementPost(f,'ask',body)).status,202);const done=await f.wait(body.conversationId,v=>v.messages[0]&&!['registered','running','unknown'].includes(v.messages[0].status));assert.equal(f.messages.q.issueImplementations().requests('implementation').length,0);assert.equal(f.ledger!.state().claims.length,0);assert.equal(done.workRequests[0].problem,'implementation_issue_source_changed');assert.equal(done.workRequests[0].original,null);assert.equal((await f.trace()).filter((x:any)=>x.kind==='model-input').length,1);
});

test('secretary work cold read preserves exact original reports and explicit repeat starts no implementation or secretary model',async t=>{
 const f=await secretaryWorkPage(t),body=f.workBody();await supplementPost(f,'ask',body);const done=await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed'&&v.workRequests[0]?.original?.status==='completed'&&v.workRequests[0].original.resourcesSettled&&!v.workRequests[0].original.controllerActive),before=await f.trace();await f.app.close();const cold=await startWorkbench(f.planPath,undefined,{githubReader:f.github});t.after(()=>cold.close());const u=new URL(cold.url),headers={Authorization:'Bearer '+u.hash.slice(1),'X-Tongxu-Account':'7','X-Tongxu-Project':'1'};await fetch(u.origin+'/api/github/projects',{headers});for(let n=0;n<2;n++){const r=await fetch(u.origin+'/api/project-secretary/conversations/'+body.conversationId,{headers});assert.equal(r.status,200);const v=await r.json() as any;assert.deepEqual(v.workRequests[0].original.report,done.workRequests[0].original.report);}assert.deepEqual(await f.trace(),before);const repeated=await fetch(u.origin+'/api/project-secretary/continue-work',{method:'POST',headers:{...headers,Origin:u.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:body.requestId})});assert.equal(repeated.status,200,await repeated.clone().text());assert.deepEqual(await f.trace(),before);assert.equal(f.ledger!.state().claims.length,1);
});

test('secretary work cancellation during real asynchronous Issue read fences the final registration and leaves no orphan task',async t=>{
 let signal!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>signal=resolve),blocked=new Promise<void>(resolve=>release=resolve),f=await secretaryWorkPage(t,'coordinate',async()=>{signal();await blocked;}),body=f.workBody();try{assert.equal((await supplementPost(f,'ask',body)).status,202);let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([reached,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('fixture_issue_read_not_reached')),10000);})]);}finally{if(timeout)clearTimeout(timeout);}const cancel=await supplementPost(f,'cancel-work',{requestId:body.requestId});assert.equal(cancel.status,200,JSON.stringify(cancel));assert.equal(cancel.value.cancelled,true);release();await f.wait(body.conversationId,v=>v.messages[0]&&!['registered','running','unknown'].includes(v.messages[0].status));assert.equal(f.messages.q.issueImplementations().requests('implementation').length,0);assert.equal((await f.get('/api/state')).value.tasks.length,0);assert.equal(f.ledger!.state().claims.length,0);assert.equal((await supplementPost(f,'continue-work',{requestId:body.requestId})).status,503);assert.equal((await f.trace()).filter((x:any)=>x.kind==='model-input').length,1);}finally{release();}
});

for(const outcome of ['no_change','needs_owner','incomplete'] as const)test('secretary work reports original '+outcome+' without replacing it with secretary completion',async t=>{
 const f=await secretaryWorkPage(t,'coordinate',undefined,outcome),body=f.workBody();assert.equal((await supplementPost(f,'ask',body)).status,202);const done=await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed'&&v.workRequests[0]?.original&&!v.workRequests[0].original.controllerActive),original=done.workRequests[0].original;assert.equal(original.H1,null);if(outcome==='incomplete'){assert.equal(original.phase,'active_or_unknown');assert.equal(original.status,null);assert.equal(original.report,null);assert.equal(original.completeCapture,false);assert.equal(original.resourcesSettled,false);}else{assert.equal(original.status,outcome==='needs_owner'?'owner_decision_required':'no_change');assert.equal(original.report.completeCapture,true);assert.equal(original.resourcesSettled,true);assert.equal(original.originIncludedInCompleteCapture,true);}const trace=await f.trace();assert.equal(trace.filter((x:any)=>x.kind==='model-input').length,2);assert.equal((await supplementPost(f,'continue-work',{requestId:body.requestId})).status,200);assert.deepEqual(await f.trace(),trace);assert.equal(f.messages.q.issueImplementations().requests('implementation').length,1);
});

test('secretary-created work remains the original responsibility for an existing supplement and returns its full new result',async t=>{
 const f=await secretaryWorkPage(t),body=f.workBody(),db=new DatabaseSync(join(f.ledger!.root,'original-fixture.sqlite'));db.exec('UPDATE capacity SET n=2');db.close();const binary=f.project.config.codexExecutable,script=await readFile(binary,'utf8');await writeFile(binary,script.replaceAll("text:'export function normalizeLabel(value,fallback=", "text:(context.request?.continuation?'// explicit supplemental change\\n':'')+'export function normalizeLabel(value,fallback="));await supplementPost(f,'ask',body);const done=await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed'&&v.workRequests[0]?.original?.status==='completed'&&v.workRequests[0].original.resourcesSettled&&!v.workRequests[0].original.controllerActive),root=done.workRequests[0].original,options=(await f.get('/api/project-secretary')).value,target=options.supplementTargets.find((t:any)=>t.requestId===body.requestId),{title,...identity}=target,supplement={conversationId:body.conversationId,requestId:randomUUID(),target:identity,text:'Preserve the current contract and add one explicit source comment after checking the original result.'};assert.equal((await supplementPost(f,'supplement',supplement)).status,202);const next='supplement-'+supplement.requestId,result=await f.settled(next);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.H0,root.H1);assert.notEqual(result.H1,root.H1);const request=f.messages.q.issueImplementations().original('implementation',next);assert.equal(request.continuation!.logicalOwner,root.task);assert.equal(request.continuation!.originalTarget.requestId,body.requestId);const returned=(await f.get('/api/project-secretary/conversations/'+body.conversationId)).value;assert.equal(returned.supplements[0].original.completeCapture,true);assert.equal(returned.supplements[0].original.report.report,(await f.get('/api/implementation-report/implementation/'+next)).value.report.report);assert.equal(returned.workRequests[0].originalRequestId,body.requestId);assert.equal(f.ledger!.state().claims.length,2);assert.equal(f.ledger!.state().settlements.length,2);
});

test('normal project entry creates an adopted Issue task, checks original authority/resources and reads H1/full result without a second dispatch',async t=>{
 const f=await implementationPage(t),before=await tree(f.project.objects,true),body={requestId:'normal-first',issueNumber:74};
 assert.equal((await f.get('/api/state')).value.tasks.length,0);const options=await f.get();assert.equal(options.status,200);assert.equal(options.value.options[0].issues[0].number,74);
 const prepared=await f.post('prepare',body);assert.equal(prepared.status,200,JSON.stringify(prepared));assert.equal(prepared.value.phase,'prepared');assert.equal(JSON.stringify(prepared.value).includes(f.project.root),false);
 const duplicate=await f.post('prepare',body);assert.equal(duplicate.value.task,prepared.value.task);
 assert.equal((await f.post('prepare',{...body,issueNumber:75})).status,503);
 const db=new DatabaseSync(join(f.messages.store,'queue.sqlite'));try{const op=f.messages.q.issueImplementations().state('implementation',body.requestId).operation;assert.throws(()=>db.prepare("UPDATE operations SET status='complete' WHERE id=?").run(op),/original_issue_implementation_consumer_required/);assert.throws(()=>f.messages.q.evaluate(op),/original_issue_implementation_consumer_required/);}finally{db.close();}
 assert.equal((await f.post('start',{requestId:body.requestId})).status,202);
 const done=await f.settled(body.requestId);assert.equal(done.status,'completed',JSON.stringify(done));assert.notEqual(done.H1,done.H0);assert.equal(done.completeCapture,true);const taskState=await f.get('/api/state');assert.equal(taskState.status,200,JSON.stringify(taskState));assert.equal(taskState.value.tasks.length,1);assert.equal(taskState.value.tasks[0].candidate.H,done.H1);assert.equal(taskState.value.issueImplementations[0].requests[0].task,done.task);
 const report=await f.get('/api/implementation-report/implementation/'+body.requestId);assert.equal(report.status,200);assert.equal(report.value.tests.passed,true);assert.equal(report.value.report.decision,'implemented');assert.equal(report.value.H1,done.H1);
 assert.deepEqual(await tree(f.project.objects,true),before);assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);
 const trace=await readFile(f.project.trace);await f.post('start',{requestId:body.requestId});await f.settled(body.requestId);assert.deepEqual(await readFile(f.project.trace),trace);
 const reopened=await startWorkbench(f.planPath,undefined,{githubReader:f.github});t.after(()=>reopened.close());const other=new URL(reopened.url),headers={...f.headers,Authorization:'Bearer '+other.hash.slice(1)};await fetch(other.origin+'/api/github/projects',{headers});
 const saved=await(await fetch(other.origin+'/api/implementation-report/implementation/'+body.requestId,{headers})).json() as any;assert.equal(saved.H1,done.H1);assert.deepEqual(await readFile(f.project.trace),trace);
});


test('normal implementation rejects changed requests, source and authority; cancellation and stop do not send',async t=>{
 const f=await implementationPage(t,false),calls=()=>readFile(f.project.trace),before=await calls();
 assert.equal((await f.post('prepare',{requestId:'forbidden',issueNumber:74,allowedPaths:['README.md']})).status,503);
 assert.equal((await f.post('prepare',{requestId:'origin',issueNumber:74},{Origin:'https://outside.example'})).status,403);
 assert.equal((await f.post('prepare',{requestId:'project',issueNumber:74},{'X-Tongxu-Project':'99'})).status,503);
 const first={requestId:'not-sent',issueNumber:74};assert.equal((await f.post('prepare',first)).status,200);
 assert.equal((await f.post('prepare',{requestId:'competing',issueNumber:74})).status,503);assert.deepEqual(await calls(),before);
 assert.equal((await f.post('cancel',{requestId:first.requestId})).status,200);await f.post('start',{requestId:first.requestId});assert.equal((await f.settled(first.requestId)).status,'cancelled_unstarted');assert.deepEqual(await calls(),before);
 const changed={requestId:'changed',issueNumber:74};await f.post('prepare',changed);f.changeIssue(f.body+' Changed after adoption.');await f.post('start',{requestId:changed.requestId});const stale=await f.settled(changed.requestId);assert.equal(stale.reason,'implementation_issue_source_changed');assert.equal(stale.phase,'prepared');assert.deepEqual(await calls(),before);
 await f.post('cancel',{requestId:changed.requestId});f.changeIssue(f.body);
 const stopped={requestId:'stopped',issueNumber:74};await f.post('prepare',stopped);await f.post('stop',{requestId:stopped.requestId});await f.post('start',{requestId:stopped.requestId});assert.equal((await f.settled(stopped.requestId)).stopped,true);assert.deepEqual(await calls(),before);await f.post('cancel',{requestId:stopped.requestId});
 const revoked={requestId:'revoked',issueNumber:74};await f.post('prepare',revoked);await f.owner.adopt({kind:'revoke',decision:f.grant.sha});await f.post('start',{requestId:revoked.requestId});assert.equal((await f.settled(revoked.requestId)).reason,'owner_decision_revoked');assert.deepEqual(await calls(),before);
});

test('an implementation interrupted after its first registered write retains the diff and original unknown, without a second model request',async t=>{
 const f=await implementationPage(t,false),exe=f.project.config.codexExecutable,script=await readFile(exe,'utf8');
 await writeFile(exe,script.replace("if(++implementationWrites===1){tool", "if(++implementationWrites===1){process.exit(7);tool"));
 await f.post('prepare',{requestId:'unknown',issueNumber:74});await f.post('start',{requestId:'unknown'});const unknown=await f.settled('unknown');assert.equal(unknown.phase,'active_or_unknown');assert.ok(unknown.reason);assert.equal(unknown.completeCapture,false);
 const partial=await f.get('/api/implementation-report/implementation/unknown');assert.equal(partial.status,200);assert.equal(partial.value.observationOnly,true);assert.match(partial.value.diff,/fallback/);assert.equal(partial.value.H1,null);
 const trace=await readFile(f.project.trace);await f.post('start',{requestId:'unknown'});await f.settled('unknown');assert.deepEqual(await readFile(f.project.trace),trace);assert.equal((await f.post('cancel',{requestId:'unknown'})).status,503);assert.equal((await f.post('prepare',{requestId:'replacement',issueNumber:74})).status,503);assert.deepEqual(await readFile(f.project.trace),trace);
});

// Reuse the normal entry, original queue/authority/provider and real Docker
// fixtures for the two never-dispatched waiting boundaries.
for(const supplement of [false,true])for(const cold of [false,true])test(`registered ${supplement?'supplement':'implementation'} completes the same preparation after a busy seat clears (${cold?'cold':'warm'})`,async t=>{
 const f=await implementationPage(t,true,'normal',supplement);let body={requestId:'busy-original',issueNumber:74},parent:any,target:SupplementTarget|undefined;
 const conversationId='88888888-8888-4888-8888-888888888888',requestId='77777777-7777-4777-8777-777777777777',text='Verify the committed fallback and add the bounded supplemental source comment.';
 if(supplement){
  const db=new DatabaseSync(join(f.ledger!.root,'original-fixture.sqlite'));try{db.exec('UPDATE capacity SET n=2');}finally{db.close();}
  const binary=f.project.config.codexExecutable,script=await readFile(binary,'utf8');await writeFile(binary,script.replace("text:'export function normalizeLabel(value,fallback=", "text:(context.request?.continuation?'// confirmed supplemental edit\\n':'')+'export function normalizeLabel(value,fallback="));
  assert.equal((await f.post('prepare',body)).status,200);await f.post('start',{requestId:body.requestId});parent=await f.settled(body.requestId);assert.equal(parent.status,'completed');
  const {title,...identity}=(await f.get('/api/project-secretary')).value.supplementTargets[0];target=identity;
 }
 const blocker=f.messages.q.begin(f.messages.item,'ordinary-seat');assert.equal(blocker.status,'running');
 if(supplement){
  body={requestId:'supplement-'+requestId,issueNumber:74};assert.equal((await supplementPost(f,'supplement',{requestId,conversationId,target,text})).status,202);
  for(let n=0;n<1000;n++){if(f.messages.q.issueImplementations().requests('implementation').some(r=>r.id===body.requestId))break;await new Promise(r=>setTimeout(r,20));}
 }else assert.equal((await f.post('prepare',body)).value.error,'reception_seats_full');
 const original=f.messages.q.issueImplementations().state('implementation',body.requestId),root=join(f.entry.root,body.requestId),paths=['request.json','plan.json','grant.json','test-plan.json'],bytes=await Promise.all(paths.map(p=>readFile(join(root,p))));
 assert.equal(original.phase,'registered');assert.equal(original.operation,null);assert.equal(original.supplement,supplement);const request=f.messages.q.issueImplementations().original('implementation',body.requestId);
 if(supplement){assert.equal(original.H0,parent.H1);assert.equal(original.logicalOwner,parent.task);assert.equal(request.continuation!.supplement.text,text);}else assert.equal(original.reason,'reception_seats_full');
 f.messages.q.evaluate(blocker.operation);
 let post=f.post,settled=f.settled,get=f.get;
 if(cold){
  await f.app.close();const app=await startWorkbench(f.planPath,undefined,{githubReader:f.github}),close=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await close();}};t.after(()=>app.close());const url=new URL(app.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)};
  await fetch(url.origin+'/api/github/projects',{headers});
  post=async(action,data,extra={})=>{const r=await fetch(url.origin+'/api/implementation/implementation/'+action,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});return {status:r.status,value:await r.json() as any};};
  get=async(path='/api/implementation')=>{const r=await fetch(url.origin+path,{headers});return {status:r.status,value:await r.json() as any};};
  settled=async id=>{for(let n=0;n<1000;n++){const s=(await get()).value.entries[0].requests.find((r:any)=>r.id===id);if(!s.controllerActive)return s;await new Promise(r=>setTimeout(r,20));}throw Error('fixture_timeout');};
 }
 const prepared=await post('prepare',body);assert.equal(prepared.value.phase,'prepared',JSON.stringify(prepared));await post('start',{requestId:body.requestId});
 const done=await settled(body.requestId),fixed=f.messages.q.issueImplementations().state('implementation',body.requestId);
 assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.task,original.task);assert.equal(fixed.requestSha256,original.requestSha256);assert.deepEqual(f.messages.q.issueImplementations().original('implementation',body.requestId),request);
 for(let i=0;i<paths.length;i++)assert.deepEqual(await readFile(join(root,paths[i]!)),bytes[i]);
 assert.equal(f.ledger!.state().claims.length,supplement?2:1);assert.equal(f.ledger!.state().settlements.length,supplement?2:1);
 const report=await get('/api/implementation-report/implementation/'+body.requestId);assert.equal(report.value.H1,done.H1);assert.equal(report.value.completeCapture,true);
 if(supplement){
  assert.equal(done.H0,parent.H1);assert.notEqual(done.H1,parent.H1);assert.equal(done.logicalOwner,parent.task);
  const input=await readFile(join(fixed.plan.operationRoot,'implementer','inputs.json'),'utf8');assert.ok(input.includes(text));assert.ok(input.includes(parent.H1));
  const view=(await get('/api/project-secretary/conversations/'+conversationId)).value;assert.equal(view.supplements[0].original.report.report,fixed.result.report.report);
  const catalog=join(f.project.root,'implementation-catalog.json'),controls=await IssueImplementationControls.load(catalog,hash(await readFile(catalog)),f.entry.repository,async number=>({number,title:'Original issue',body:f.body,url:'https://github.com/fixture/reception/issues/'+number}),async()=>{});t.after(()=>controls.drain());
  for(const changed of [{...target!,task:'f'.repeat(64)},{...target!,operation:'different-operation'}]){
   await assert.rejects(controls.workSupplement(changed,body.requestId,text,()=>{}),/compiled_target_changed/);await assert.rejects(controls.cancelSupplement(changed,body.requestId,text),/compiled_target_changed/);await assert.rejects(controls.readSupplement(changed,body.requestId,text),/compiled_target_changed/);
  }
  await assert.rejects(controls.workSupplement(target!,body.requestId,text+' changed',()=>{}),/compiled_target_changed/);await assert.rejects(controls.cancelSupplement(target!,body.requestId,text+' changed'),/compiled_target_changed/);await assert.rejects(controls.readSupplement(target!,body.requestId,text+' changed'),/compiled_target_changed/);
  assert.equal((await controls.readSupplement(target!,body.requestId,text)).completeCapture,true);await controls.workSupplement(target!,body.requestId,text,()=>{});await controls.drain();
 }
 const trace=await readFile(f.project.trace,'utf8');assert.equal((trace.match(/"kind":"model-input"/g)??[]).length,supplement?2:1);
 await post('start',{requestId:body.requestId});await settled(body.requestId);assert.equal(await readFile(f.project.trace,'utf8'),trace);
});


for(const cold of [false,true])test(`cancelled implementation before resource registration permits the next work through H1 (${cold?'cold':'warm'})`,async t=>{
 const f=await implementationPage(t),id='cancel-before-start',body={requestId:'after-cancel',issueNumber:74};
 assert.equal((await f.post('prepare',{requestId:id,issueNumber:74})).value.phase,'prepared');
 const original=f.messages.q.issueImplementations().state('implementation',id);assert.equal(original.plan.resourceRequests.length,1);
 const countResources=()=>{const db=new DatabaseSync(join(f.messages.store,'queue.sqlite'));try{return db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='resource_request_prepared'").get()!.n;}finally{db.close();}};
 assert.equal(countResources(),0);assert.equal((await f.post('cancel',{requestId:id})).status,200);
 const cancelled=f.messages.q.issueImplementations().state('implementation',id);assert.equal(cancelled.result.status,'cancelled_unstarted');assert.equal(cancelled.reason,null);assert.equal(countResources(),0);
 assert.equal(await readFile(f.project.trace,'utf8'),'');assert.equal(f.ledger!.state().claims.length,0);assert.equal(f.ledger!.state().settlements.length,0);
 let post=f.post,settled=f.settled;
 if(cold){
  const app=await startWorkbench(f.planPath,undefined,{githubReader:f.github}),close=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await close();}};t.after(()=>app.close());const url=new URL(app.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)};
  await fetch(url.origin+'/api/github/projects',{headers});
  post=async(action,data,extra={})=>{const r=await fetch(url.origin+'/api/implementation/implementation/'+action,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});return {status:r.status,value:await r.json() as any};};
  settled=async request=>{for(let n=0;n<1000;n++){const state=(await(await fetch(url.origin+'/api/implementation',{headers})).json() as any).entries[0].requests.find((r:any)=>r.id===request);if(!state.controllerActive)return state;await new Promise(r=>setTimeout(r,20));}throw Error('fixture_timeout');};
 }
 const next=await post('prepare',body);assert.equal(next.status,200,JSON.stringify(next));assert.notEqual(next.value.task,original.task);await post('start',{requestId:body.requestId});
 const done=await settled(body.requestId);assert.equal(done.status,'completed',JSON.stringify(done));assert.notEqual(done.H1,done.H0);assert.equal(done.completeCapture,true);
 const after=f.messages.q.issueImplementations().state('implementation',id);assert.deepEqual(after.result,cancelled.result);assert.equal(after.operation,original.operation);assert.equal(after.requestSha256,original.requestSha256);
 assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);
 const trace=await readFile(f.project.trace,'utf8');assert.equal((trace.match(/"kind":"model-input"/g)??[]).length,1);
 await post('start',{requestId:body.requestId});await settled(body.requestId);assert.equal(await readFile(f.project.trace,'utf8'),trace);
});

test('cancelled implementation with an unknown original resource still blocks new work',async t=>{
 const f=await implementationPage(t,true,'lost-after-claim'),id='unknown-resource';
 await f.post('prepare',{requestId:id,issueNumber:74});await f.post('start',{requestId:id});await f.settled(id);
 const original=f.messages.q.issueImplementations().state('implementation',id),resource=original.plan.resourceRequests[0];
 assert.equal(f.messages.q.resources().status(resource).state,'claim_unknown');assert.equal(f.ledger!.state().claims.length,1);assert.equal(await readFile(f.project.trace,'utf8'),'');
 const cancelled=await f.post('cancel',{requestId:id});assert.equal(cancelled.value.status,'cancelled_unstarted');
 const next=await f.post('prepare',{requestId:'after-unknown-resource',issueNumber:74});assert.equal(next.status,503);assert.equal(next.value.error,'implementation_original_resources_unresolved');
 assert.equal(f.messages.q.resources().status(resource).state,'claim_unknown');assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,0);assert.equal(await readFile(f.project.trace,'utf8'),'');
 // Missing preparation amid retained resource originals is corruption, not a
 // future request that was never registered. Inject only in this private fixture.
 const db=new DatabaseSync(join(f.messages.store,'queue.sqlite'));try{db.prepare("DELETE FROM events WHERE object=? AND kind='resource_request_prepared'").run('resource:'+resource);}finally{db.close();}
 assert.throws(()=>f.messages.q.resources().status(resource),/resource_original_missing_or_changed/);
 const damaged=await f.post('prepare',{requestId:'after-damaged-resource',issueNumber:74});assert.equal(damaged.status,503);assert.equal(damaged.value.error,'resource_original_missing_or_changed');
 assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,0);assert.equal(await readFile(f.project.trace,'utf8'),'');
});

async function unsentImplementation(t:TestContext,selectedLink=false){
 const f=await implementationPage(t,true,'normal',false,undefined,selectedLink),id='presend-original',catalog=join(f.project.root,'implementation-catalog.json'),operation=join(f.entry.root,id,'operation');let failed=false;
 if(selectedLink){const executable=f.project.config.codexExecutable,code=await readFile(executable,'utf8');await writeFile(executable,code.replace("if(m.method==='account/read')result={account:{type:'chatgpt'}};","if(m.method==='account/read'){emit({method:'remoteControl/status/changed',params:{status:'disabled',serverName:'synthetic-host',installationId:'synthetic-installation',environmentId:null}});emit({method:'account/updated',params:{authMode:'chatgpt',planType:'synthetic-plan'}});result={account:{type:'chatgpt',planType:'synthetic-plan'}};}"));}
 const load=(verify=async()=>{if(!failed&&await exists(join(operation,'input-manifest.json'))){failed=true;throw Error('fixture_source_temporarily_unavailable');}})=>IssueImplementationControls.load(catalog,hashBytes,f.entry.repository,async number=>({number,title:'Optional label fallback',body:f.body,url:'https://github.com/fixture/reception/issues/'+number}),verify);
 const hashBytes=hash(await readFile(catalog));let controls=await load();t.after(()=>controls.drain());
 const settled=async()=>{for(let n=0;n<1000;n++){const s=(await controls.state())[0]!.requests.find(r=>r.id===id);if(s&&!s.controllerActive)return s;await new Promise(r=>setTimeout(r,20));}throw Error('fixture_timeout');};
 await controls.prepare('implementation',{requestId:id,issueNumber:74});await controls.begin('implementation',id);assert.equal((await settled()).reason,'fixture_source_temporarily_unavailable');
 const original=f.messages.q.issueImplementations().state('implementation',id);assert.equal(original.phase,'prepared');assert.equal(await readFile(f.project.trace,'utf8'),'');
 assert.equal(await exists(join(original.plan.workspace,'.git','tongxu-writer.json')),false);
 return {...f,id,operation,original,load,settled,control:()=>controls,reopen:async(verify?:()=>Promise<void>)=>{await controls.drain();controls=await load(verify);return controls;}};
}
for(const cold of [false,true])test(`unsent implementation consumes its original prepared input after final source recovery (${cold?'cold':'warm'})`,async t=>{
 const f=await unsentImplementation(t),manifest=await readFile(join(f.operation,'input-manifest.json')),initial=await readFile(join(f.operation,'initial-tree.json')),claim=f.ledger!.state().claims[0] as any;
 assert.deepEqual((await readdir(f.operation)).sort(),['attempt-1','initial-tree.json','input-manifest.json']);assert.equal(JSON.parse(claim.result).claim.state,'held');
 if(cold)await f.reopen();await f.control().begin('implementation',f.id);await f.control().begin('implementation',f.id);
 const done=await f.settled(),state=f.messages.q.issueImplementations().state('implementation',f.id);assert.equal(done.status,'completed');assert.equal(done.task,f.original.task);assert.equal(state.operation,f.original.operation);assert.equal(state.requestSha256,f.original.requestSha256);
 assert.deepEqual(await readFile(join(f.operation,'input-manifest.json')),manifest);assert.deepEqual(await readFile(join(f.operation,'initial-tree.json')),initial);
 const ledger=f.ledger!.state();assert.equal(ledger.claims.length,1);assert.equal(ledger.claims[0]!.id,claim.id);assert.equal(ledger.settlements.length,1);assert.equal(JSON.parse((ledger.claims[0] as any).result).claim.state,'consumed');
 const report=await f.control().report('implementation',f.id),capture=JSON.parse(await readFile(join(f.operation,'implementer','binding.json'),'utf8'));assert.equal(report.H1,done.H1);assert.equal(report.completeCapture,true);assert.equal(capture.role,'implementer');assert.equal(capture.turnIds.length,1);
 const trace=await readFile(f.project.trace,'utf8');assert.equal((trace.match(/"kind":"model-input"/g)??[]).length,1);await f.control().begin('implementation',f.id);await f.settled();assert.equal(await readFile(f.project.trace,'utf8'),trace);
});

test('registered implementation retains fixed plans and rechecks cancellation or stop before bind',async t=>{
 for(const action of ['cancel','stop','changed-plan'] as const){
  const f=await implementationPage(t,false),id='registered-'+action,blocker=f.messages.q.begin(f.messages.item,'busy');await f.post('prepare',{requestId:id,issueNumber:74});f.messages.q.evaluate(blocker.operation);
  const original=f.messages.q.issueImplementations().state('implementation',id),catalog=join(f.project.root,'implementation-catalog.json');
  if(action==='changed-plan'){const path=join(f.entry.root,id,'plan.json'),p=JSON.parse(await readFile(path,'utf8'));p.timeoutMs++;await writeFile(path,JSON.stringify(p));}
  const controls=await IssueImplementationControls.load(catalog,hash(await readFile(catalog)),f.entry.repository,async number=>{
   if(action==='cancel')await controls.cancel('implementation',id);
   if(action==='stop')await controls.stop('implementation',id);
   return {number,title:'Updated title must not replace the original task',body:f.body,url:'https://github.com/fixture/reception/issues/'+number};
  },async()=>{});t.after(()=>controls.drain());
  await assert.rejects(controls.prepare('implementation',{requestId:id,issueNumber:74}),action==='cancel'?/request_ended/:action==='stop'?/implementation_stopped/:/original_plan_changed/);
  const after=f.messages.q.issueImplementations().state('implementation',id);assert.equal(after.task,original.task);assert.equal(after.requestSha256,original.requestSha256);assert.equal(after.operation,null);assert.equal(await readFile(f.project.trace,'utf8'),'');
  if(action==='cancel')assert.equal(after.result.status,'cancelled_unstarted');if(action==='stop')assert.equal(after.stopped,true);
 }
});

test('input-only implementation refuses changed material, native evidence, competing writers and cancelled or stopped requests',async t=>{
 for(const problem of ['manifest','workspace','during-refresh','index','native','lease','cancel','stop'] as const){
  const f=await unsentImplementation(t),workspace=f.original.plan.workspace,manifestPath=join(f.operation,'input-manifest.json'),originalManifest=await readFile(manifestPath),sourcePath=join(workspace,'src/normalize.mjs'),source=await readFile(sourcePath);
  if(problem==='manifest'){const value=JSON.parse(originalManifest.toString());value.prompt.system+=' changed';await writeFile(manifestPath,JSON.stringify(value));}
  if(problem==='workspace'||problem==='index'){await writeFile(sourcePath,'export const unrelated = 1;\n');if(problem==='index'){await git(workspace,['add','src/normalize.mjs']);await writeFile(sourcePath,source);}}
  if(problem==='native')await writeFile(join(f.operation,'launch.json'),JSON.stringify({status:'launch_registered',pid:null}));
  if(problem==='lease')await writeFile(join(workspace,'.git','tongxu-writer.json'),JSON.stringify({operation:'another-original',controllerPid:process.pid,generation:'retained',status:'held'}));
  // Inject after execute has selected the old prepared record: the consumer
  // must consult the transaction's current terminal/stop fact, not that copy.
  let verifications=0;
  await f.reopen(async()=>{if(problem==='cancel')await f.control().cancel('implementation',f.id);if(problem==='stop')await f.control().stop('implementation',f.id);if(problem==='during-refresh'&&++verifications===3)await writeFile(sourcePath,'export const unrelated = 1;\n');});
  await f.control().begin('implementation',f.id);const state=await f.settled();assert.equal(await readFile(f.project.trace,'utf8'),'');assert.equal(state.completeCapture,false);
  if(problem==='cancel')assert.equal(state.status,'cancelled_unstarted');else{assert.equal(state.phase,'prepared');assert.ok(state.reason);}
  const current=f.messages.q.issueImplementations().state('implementation',f.id);assert.equal(current.operation,f.original.operation);assert.equal(current.requestSha256,f.original.requestSha256);
  const db=new DatabaseSync(join(f.messages.store,'queue.sqlite'));try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='issue_implementation_dispatched'").get()!.n,0);}finally{db.close();}
  if(problem!=='manifest')assert.deepEqual(await readFile(manifestPath),originalManifest);
  if(problem==='native')assert.equal(await exists(join(f.operation,'launch.json')),true);if(problem==='lease')assert.equal(JSON.parse(await readFile(join(workspace,'.git','tongxu-writer.json'),'utf8')).operation,'another-original');
  const ledger=f.ledger!.state();assert.equal(ledger.claims.length,1);assert.equal(ledger.settlements.length,problem==='cancel'?1:0);
  if(problem==='cancel')assert.equal(JSON.parse((ledger.settlements[0] as any).body).state,'cancelled');
  if(problem==='cancel'){const next=await f.control().prepare('implementation',{requestId:'after-held-cancel',issueNumber:74});assert.equal(next.phase,'prepared');assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);assert.equal(await readFile(f.project.trace,'utf8'),'');}
 }
});


for(const resources of [false,true])test('project secretary saves a busy writer supplement and only after real H1 returns the same responsibility full report in a new context: '+resources,async t=>{
 const f=await implementationPage(t,resources,'normal',true),first='original-implementation';
 if(f.ledger){const db=new DatabaseSync(join(f.ledger.root,'original-fixture.sqlite'));try{db.exec('UPDATE capacity SET n=2');}finally{db.close();}}
 const binary=f.project.config.codexExecutable,script=await readFile(binary,'utf8');
 // Preserve the existing first implementation, then make a distinct, harmless
 // registered source edit when this fixture receives a continuation request.
 await writeFile(binary,script.replace("text:'export function normalizeLabel(value,fallback=", "text:(context.request?.continuation?'// confirmed supplemental edit\\n':'')+'export function normalizeLabel(value,fallback=").replace("tool('tongxu_read_file',{path:'src/normalize.mjs'});","setTimeout(()=>tool('tongxu_read_file',{path:'src/normalize.mjs'}),700);"));
 assert.equal((await f.post('prepare',{requestId:first,issueNumber:74})).status,200);
 const targets=await f.get('/api/project-secretary'),target=targets.value.supplementTargets[0];assert.ok(target);const {title,...identity}=target;
 const conversationId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',body={conversationId,requestId,target:identity,text:'请核对刚完成的可选fallback，并保留默认Untitled；补充一条受控源码说明。'};
 const chatPost=async(action:string,value:unknown)=>{const response=await fetch(f.url.origin+'/api/project-secretary/'+action,{method:'POST',headers:{...f.headers,Origin:f.url.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});return {status:response.status,value:await response.json() as any};};
 await f.post('start',{requestId:first});for(let n=0;n<100;n++){if((await readFile(f.project.trace,'utf8')).includes('model-input'))break;await new Promise(r=>setTimeout(r,20));}
 assert.equal((await f.get()).value.entries[0].requests.find((r:any)=>r.id===first).controllerActive,true);
 // A is in its real bounded native fixture turn; receiving does not compete.
 assert.equal((await chatPost('supplement',body)).status,202);assert.equal((await chatPost('supplement',body)).value.duplicate,true);const saved=await f.get('/api/project-secretary/conversations/'+conversationId);assert.equal(saved.value.supplements.length,1);assert.equal(saved.value.supplements[0].compiledRequest,null);
 const changed=await chatPost('supplement',{...body,text:'cannot replace original'});assert.equal(changed.status,503);
 const original=await f.settled(first);assert.equal(original.status,'completed',JSON.stringify(original));assert.ok(original.H1);
 const next='supplement-'+requestId;const result=await f.settled(next);assert.equal(result.status,'completed',JSON.stringify(result));assert.notEqual(result.H1,original.H1);assert.equal(result.H0,original.H1);
 const rows=f.messages.q.issueImplementations().requests('implementation'),old=rows.find(r=>r.id===first)!,child=rows.find(r=>r.id===next)!,request=f.messages.q.issueImplementations().original('implementation',next);assert.equal(request.continuation!.logicalOwner,old.task);assert.equal(request.continuation!.originalTarget.operation,old.operation);assert.equal(request.continuation!.predecessor.H1,original.H1);assert.equal(request.continuation!.history[0]!.report.report,(await f.get('/api/implementation-report/implementation/'+first)).value.report.report);
 const input=await readFile(join(child.plan.operationRoot,'implementer','inputs.json'),'utf8');assert.ok(input.includes(body.text));assert.ok(input.includes(original.H1));assert.notEqual(child.result.sessionId,old.result.sessionId);
 const returned=await f.get('/api/project-secretary/conversations/'+conversationId);assert.equal(returned.value.supplements[0].original.report.report,child.result.report.report);assert.equal(returned.value.supplements[0].original.completeCapture,true);if(f.ledger){assert.equal(f.ledger.state().claims.length,2);assert.equal(f.ledger.state().settlements.length,2);assert.notDeepEqual(old.plan.resourceRequests,child.plan.resourceRequests);}
 const traceBefore=await readFile(f.project.trace);
 await writeFile(join(child.plan.workspace,'src/normalize.mjs'),(await readFile(join(child.plan.workspace,'src/normalize.mjs'),'utf8'))+'// later external change; never a new adopted output\n');
 const stale=await f.get('/api/project-secretary/conversations/'+conversationId);assert.equal(stale.value.supplements[0].original.report.report,child.result.report.report);assert.equal(stale.value.supplements[0].original.reason,'project_supplement_committed_result_changed');
 await f.app.close();const reopened=await startWorkbench(f.planPath,undefined,{githubReader:f.github});t.after(()=>reopened.close());const u=new URL(reopened.url),headers={...f.headers,Authorization:'Bearer '+u.hash.slice(1)};await fetch(u.origin+'/api/github/projects',{headers});const recovered=await(await fetch(u.origin+'/api/project-secretary/conversations/'+conversationId,{headers})).json() as any;assert.equal(recovered.supplements[0].original.report.report,child.result.report.report);assert.equal(recovered.supplements[0].original.operation,child.operation);assert.deepEqual(await readFile(f.project.trace),traceBefore);
});

for(const action of ['stop','cancel'])test('saved supplement cannot continue an original '+action+' and unsent cancellation preserves the received original',async t=>{
 const f=await implementationPage(t,false,'normal',true),id='original-before-'+action;await f.post('prepare',{requestId:id,issueNumber:74});
 const target=(await f.get('/api/project-secretary')).value.supplementTargets[0],{title,...identity}=target,conversationId='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444',body={conversationId,requestId,target:identity,text:'保留并等待准确原任务。'};
 const send=async(name:string,value:unknown,project='1')=>{const r=await fetch(f.url.origin+'/api/project-secretary/'+name,{method:'POST',headers:{...f.headers,'X-Tongxu-Project':project,Origin:f.url.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});return {status:r.status,value:await r.json() as any};};
 assert.equal((await send('supplement',body,'2')).status,503);assert.equal((await send('supplement',body)).status,202);await f.post(action,{requestId:id});
 assert.equal((await send('continue-supplements',{target:identity})).status,202);let view=(await f.get('/api/project-secretary/conversations/'+conversationId)).value;assert.equal(view.supplements[0].compiledRequest,null);assert.equal(view.supplements[0].original.ready,false);assert.equal(f.messages.q.issueImplementations().requests('implementation').length,1);
 assert.equal((await send('cancel-supplement',{requestId})).status,200);assert.equal((await send('cancel-supplement',{requestId})).value.duplicate,true);view=(await f.get('/api/project-secretary/conversations/'+conversationId)).value;assert.equal(view.supplements[0].text,body.text);assert.equal(view.supplements[0].cancelled,true);assert.equal((await readFile(f.project.trace,'utf8')).includes('model-input'),false);
});

test('cancelled received intent cannot race its compilation into a new dispatch',async t=>{
 const f=await implementationPage(t,false,'normal',true),id='prior-success';await f.post('prepare',{requestId:id,issueNumber:74});await f.post('start',{requestId:id});assert.equal((await f.settled(id)).status,'completed');
 const target=(await f.get('/api/project-secretary')).value.supplementTargets[0],{title,...identity}=target,requestId='55555555-5555-4555-8555-555555555555',conversationId='66666666-6666-4666-8666-666666666666';
 let entered!:()=>void,release!:()=>void,work!:Promise<string>;const entering=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),original=IssueImplementationControls.prototype.workSupplement;
 IssueImplementationControls.prototype.workSupplement=function(...args){work=(async()=>{entered();await gate;return original.apply(this,args);})();return work;};t.after(()=>{release();IssueImplementationControls.prototype.workSupplement=original;});
 const send=async(name:string,body:unknown)=>{const r=await fetch(f.url.origin+'/api/project-secretary/'+name,{method:'POST',headers:{...f.headers,Origin:f.url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};
 const before=await readFile(f.project.trace);assert.equal((await send('supplement',{requestId,conversationId,target:identity,text:'该收件在编译前撤回。'})).status,202);await entering;
 assert.equal((await send('cancel-supplement',{requestId})).status,200);release();await assert.rejects(work,/project_supplement_cancelled_or_changed/);assert.deepEqual(await readFile(f.project.trace),before);assert.equal(f.messages.q.issueImplementations().requests('implementation').length,1);assert.equal((await f.get('/api/project-secretary/conversations/'+conversationId)).value.supplements[0].cancelled,true);
});


test('a supplement ID collision cannot start or cancel an unrelated ordinary preparation',async t=>{
 const f=await implementationPage(t,false,'normal',true),id='collision-original';await f.post('prepare',{requestId:id,issueNumber:74});await f.post('start',{requestId:id});assert.equal((await f.settled(id)).status,'completed');
 const {title,...target}=(await f.get('/api/project-secretary')).value.supplementTargets[0],requestId='99999999-9999-4999-8999-999999999999',conversationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',child='supplement-'+requestId;
 assert.equal((await f.post('prepare',{requestId:child,issueNumber:74})).status,200);const records=f.messages.q.issueImplementations(),before=records.state('implementation',child),request=records.original('implementation',child),trace=await readFile(f.project.trace);assert.equal(request.continuation,undefined);
 let entered!:()=>void,release!:()=>void,work!:Promise<string>;const entering=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),original=IssueImplementationControls.prototype.workSupplement;
 IssueImplementationControls.prototype.workSupplement=function(...args){work=(async()=>{entered();await gate;return original.apply(this,args);})();return work;};t.after(()=>{release();IssueImplementationControls.prototype.workSupplement=original;});
 const body={requestId,conversationId,target,text:'This supplement belongs to A, never to the unrelated same-ID request.'};assert.equal((await supplementPost(f,'supplement',body)).status,202);await entering;
 const cancel=await supplementPost(f,'cancel-supplement',{requestId});assert.equal(cancel.status,503);assert.equal(cancel.value.error,'project_supplement_compiled_target_changed');
 release();await assert.rejects(work,/project_supplement_compiled_target_changed/);const view=(await f.get('/api/project-secretary/conversations/'+conversationId)).value;
 assert.equal(view.supplements[0].cancelled,false);assert.equal(view.supplements[0].original.reason,'project_supplement_compiled_target_changed');assert.equal((await supplementPost(f,'supplement',body)).value.duplicate,true);assert.equal((await supplementPost(f,'continue-supplements',{target})).status,503);
 assert.deepEqual(records.state('implementation',child),before);assert.deepEqual(records.original('implementation',child),request);assert.deepEqual(await readFile(f.project.trace),trace);
});

test('an accurately bound registered supplement can be cancelled after the predecessor workspace changes',async t=>{
 const f=await implementationPage(t,false,'normal',true),id='cancel-stale-predecessor';await f.post('prepare',{requestId:id,issueNumber:74});await f.post('start',{requestId:id});assert.equal((await f.settled(id)).status,'completed');
 const {title,...target}=(await f.get('/api/project-secretary')).value.supplementTargets[0],requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',conversationId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',child='supplement-'+requestId,records=f.messages.q.issueImplementations(),blocker=f.messages.q.begin(f.messages.item,'cancel-seat');assert.equal(blocker.status,'running');
 await supplementPost(f,'supplement',{requestId,conversationId,target,text:'Cancel this accurate unsent supplement without changing the original.'});
 for(let n=0;n<1000;n++){if(records.requests('implementation').some(r=>r.id===child))break;await new Promise(r=>setTimeout(r,20));}
 const original=records.state('implementation',child),trace=await readFile(f.project.trace);assert.equal(original.phase,'registered');
 const path=join(records.state('implementation',id).plan.workspace,'src/normalize.mjs');await writeFile(path,(await readFile(path,'utf8'))+'// external later edit retained\n');
 assert.equal((await f.post('prepare',{requestId:child,issueNumber:74})).value.error,'project_supplement_committed_result_changed');
 assert.equal((await supplementPost(f,'cancel-supplement',{requestId})).status,200);assert.equal(records.state('implementation',child).result.status,'cancelled_unstarted');assert.equal(records.state('implementation',child).requestSha256,original.requestSha256);assert.deepEqual(await readFile(f.project.trace),trace);assert.match(await readFile(path,'utf8'),/external later edit retained/);
 f.messages.q.evaluate(blocker.operation);
});


test('secretary work keeps its cancelled original after a replacement finishes, including cold repeat',async t=>{
 const f=await secretaryWorkPage(t,'no-coordinate'),a=f.workBody('First exact saved work'),b=f.workBody('New work after the cancelled first request');
 await supplementPost(f,'ask',a);await f.wait(a.conversationId,v=>v.messages[0]?.status==='completed');
 const held=f.messages.q.begin(f.messages.item,'hold first registration');assert.ok(held.operation);
 try{assert.equal((await supplementPost(f,'continue-work',{requestId:a.requestId})).status,503);assert.equal(f.messages.q.issueImplementations().state('implementation',a.requestId).phase,'registered');assert.equal((await f.post('cancel',{requestId:a.requestId})).status,200);}finally{f.messages.q.evaluate(held.operation);}
 await supplementPost(f,'ask',b);await f.wait(b.conversationId,v=>v.messages[0]?.status==='completed');assert.equal((await supplementPost(f,'continue-work',{requestId:b.requestId})).status,200);
 const done=await f.wait(b.conversationId,v=>v.workRequests[0]?.original?.status==='completed'&&v.workRequests[0].original.resourcesSettled&&!v.workRequests[0].original.controllerActive),records=f.messages.q.issueImplementations(),originals=[records.original('implementation',a.requestId),records.original('implementation',b.requestId)],trace=await f.trace();
 assert.equal((await supplementPost(f,'continue-work',{requestId:a.requestId})).status,200);
 await f.app.close();const cold=await startWorkbench(f.planPath,undefined,{githubReader:f.github});t.after(()=>cold.close());const url=new URL(cold.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)};await fetch(url.origin+'/api/github/projects',{headers});
 const repeated=await fetch(url.origin+'/api/project-secretary/continue-work',{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:a.requestId})});assert.equal(repeated.status,200);
 const old=await(await fetch(url.origin+'/api/project-secretary/conversations/'+a.conversationId,{headers})).json() as any;assert.equal(old.workRequests[0].originalRequestId,a.requestId);assert.equal(old.workRequests[0].original.status,'cancelled_unstarted');assert.equal(old.workRequests[0].original.H1,null);assert.equal(old.workRequests[0].original.report,null);
 const other=await(await fetch(url.origin+'/api/project-secretary/conversations/'+b.conversationId,{headers})).json() as any;assert.deepEqual(other.workRequests[0].original.report,done.workRequests[0].original.report);assert.deepEqual([records.original('implementation',a.requestId),records.original('implementation',b.requestId)],originals);assert.deepEqual(await f.trace(),trace);assert.equal(records.requests('implementation').length,2);assert.equal(f.ledger!.state().claims.length,1);assert.equal(f.ledger!.state().settlements.length,1);
});

for(const sameIssue of [false,true])test('secretary work refuses unrelated same-ID read, continue, stop and cancel: same Issue '+sameIssue,async t=>{
 const f=await secretaryWorkPage(t,'no-coordinate');await f.app.close();const plan=JSON.parse(await readFile(f.planPath,'utf8')),catalog=JSON.parse(await readFile(plan.issueImplementation.path,'utf8'));catalog.entries[0].approvedIssues.push({...catalog.entries[0].approvedIssues[0],number:75});await writeFile(plan.issueImplementation.path,JSON.stringify(catalog));plan.issueImplementation.sha256=hash(await readFile(plan.issueImplementation.path));await writeFile(f.planPath,JSON.stringify(plan));
 const app=await startWorkbench(f.planPath,undefined,{githubReader:f.github});t.after(()=>app.close());const url=new URL(app.url),headers={...f.headers,Authorization:'Bearer '+url.hash.slice(1)},get=async(path:string)=>{const r=await fetch(url.origin+path,{headers});return await r.json() as any;},post=async(path:string,body:unknown)=>{const r=await fetch(url.origin+path,{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any};};await get('/api/github/projects');
 const held=f.messages.q.begin(f.messages.item,'hold unrelated direct registration');assert.ok(held.operation);const body={...f.workBody('Only the selected saved work; never control an unrelated same-ID original.'),workTarget:{source:'implementation',issueNumber:sameIssue?74:75}},records=f.messages.q.issueImplementations();
 try{
  assert.equal((await post('/api/implementation/implementation/prepare',{requestId:body.requestId,issueNumber:74})).status,503);const before=records.state('implementation',body.requestId),original=records.original('implementation',body.requestId);assert.equal(original.origin,undefined);
  assert.equal((await post('/api/project-secretary/ask',body)).status,202);for(let n=0;n<400;n++){if((await get('/api/project-secretary/conversations/'+body.conversationId)).messages[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,25));}
  const trace=await f.trace();assert.equal((await post('/api/project-secretary/continue-work',{requestId:body.requestId})).value.error,'project_work_original_mismatch');
  let view=await get('/api/project-secretary/conversations/'+body.conversationId);assert.equal(view.workRequests[0].original,null);assert.equal(view.workRequests[0].coordinated,false);assert.equal(view.workRequests[0].originalRequestId,null);
  // Recreate the saved provisional checkpoint produced by the previous version.
  const db=new DatabaseSync(join(f.project.root,'project-chats','conversations.sqlite'));try{db.prepare('UPDATE task_work_requests SET original_request=?,linked=0,coordinated=1 WHERE id=?').run(body.requestId,body.requestId);}finally{db.close();}
  assert.equal((await post('/api/project-secretary/stop-work',{requestId:body.requestId})).value.error,'project_work_original_mismatch');assert.equal((await post('/api/project-secretary/cancel-work',{requestId:body.requestId})).value.error,'project_work_original_mismatch');
  view=await get('/api/project-secretary/conversations/'+body.conversationId);assert.equal(view.workRequests[0].original,null);assert.equal(view.workRequests[0].originalRequestId,null);assert.equal(view.workRequests[0].cancelRequested,true);assert.deepEqual(records.state('implementation',body.requestId),before);assert.deepEqual(records.original('implementation',body.requestId),original);assert.deepEqual(await f.trace(),trace);assert.equal(f.ledger!.state().claims.length,0);
 }finally{f.messages.q.evaluate(held.operation);}
 assert.equal((await post('/api/implementation/implementation/prepare',{requestId:body.requestId,issueNumber:74})).status,200);assert.equal((await post('/api/implementation/implementation/start',{requestId:body.requestId})).status,202);let finished:any;for(let n=0;n<1000;n++){finished=(await get('/api/implementation')).entries[0].requests.find((r:any)=>r.id===body.requestId);if(!finished.controllerActive)break;await new Promise(r=>setTimeout(r,20));}assert.equal(finished.status,'completed',JSON.stringify(finished));
 if(sameIssue){const linked=f.workBody('Link the exact existing ordinary responsibility without changing its origin');assert.equal((await post('/api/project-secretary/ask',linked)).status,202);for(let n=0;n<400;n++){if((await get('/api/project-secretary/conversations/'+linked.conversationId)).messages[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,25));}const before=await f.trace();assert.equal((await post('/api/project-secretary/continue-work',{requestId:linked.requestId})).status,200);const view=await get('/api/project-secretary/conversations/'+linked.conversationId);assert.equal(view.workRequests[0].originalRequestId,body.requestId);assert.equal(view.workRequests[0].linkedExisting,true);assert.equal(view.workRequests[0].original.status,'completed');assert.equal(records.original('implementation',body.requestId).origin,undefined);assert.deepEqual(await f.trace(),before);assert.equal(records.requests('implementation').length,1);}
});

test('secretary work cancel checks its original queue after registration commits before a chat link can be saved',async t=>{
 const f=await secretaryWorkPage(t,'no-coordinate'),body=f.workBody();await supplementPost(f,'ask',body);await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed');
 const register=QueueStore.prototype.registerIssueImplementation;QueueStore.prototype.registerIssueImplementation=function(...args){const result=register.apply(this,args);throw new Error('fixture_after_registration_commit');};
 try{const continued=await supplementPost(f,'continue-work',{requestId:body.requestId});assert.equal(continued.value.error,'fixture_after_registration_commit');}finally{QueueStore.prototype.registerIssueImplementation=register;}
 const db=new DatabaseSync(join(f.project.root,'project-chats','conversations.sqlite'));try{assert.equal(db.prepare('SELECT original_request FROM task_work_requests WHERE id=?').get(body.requestId)!.original_request,null);}finally{db.close();}
 const records=f.messages.q.issueImplementations(),original=records.original('implementation',body.requestId),trace=await f.trace();assert.equal(original.origin!.text,body.question);assert.equal(records.state('implementation',body.requestId).phase,'registered');
 const stopped=await supplementPost(f,'stop-work',{requestId:body.requestId});assert.equal(stopped.status,200);assert.equal(stopped.value.stopped,true);
 const cancelled=await supplementPost(f,'cancel-work',{requestId:body.requestId});assert.equal(cancelled.status,200);assert.equal(cancelled.value.originalRegistered,true);assert.equal(cancelled.value.original.status,'cancelled_unstarted');const view=(await f.get('/api/project-secretary/conversations/'+body.conversationId)).value;assert.equal(view.workRequests[0].originalRequestId,body.requestId);assert.equal(view.workRequests[0].original.status,'cancelled_unstarted');assert.equal((await supplementPost(f,'continue-work',{requestId:body.requestId})).status,503);assert.deepEqual(records.original('implementation',body.requestId),original);assert.deepEqual(await f.trace(),trace);assert.equal(f.ledger!.state().claims.length,0);
});

test('secretary work rejected late cancel preserves observation until the same original complete result returns',async t=>{
 let f:Awaited<ReturnType<typeof secretaryWorkPage>>|undefined,release!:()=>void,signal!:()=>void;const reached=new Promise<void>(r=>signal=r),blocked=new Promise<void>(r=>release=r);f=await secretaryWorkPage(t,'coordinate',async()=>{if(f?.messages.q.issueImplementations().requests('implementation').some(s=>s.phase==='active_or_unknown')){signal();await blocked;}},'no_change');
 try{const body=f.workBody();await supplementPost(f,'ask',body);let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([reached,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('fixture_dispatch_not_reached')),10000))]);}finally{clearTimeout(timeout);}await f.wait(body.conversationId,v=>v.messages[0]?.status==='completed');const cancelled=await supplementPost(f,'cancel-work',{requestId:body.requestId}),during=(await f.get('/api/project-secretary/conversations/'+body.conversationId)).value;assert.equal(cancelled.status,503);assert.equal(cancelled.value.error,'implementation_sent_or_unknown_cannot_cancel');assert.equal(during.workRequests[0].cancelRequested,true);assert.equal(during.workRequests[0].original.controllerActive,true);assert.equal(during.workRequests[0].originalRequestId,body.requestId);release();const done=await f.wait(body.conversationId,v=>v.workRequests[0]?.original?.status==='no_change'&&v.workRequests[0].original.resourcesSettled&&!v.workRequests[0].original.controllerActive);assert.equal(done.workRequests[0].cancelRequested,true);assert.equal(done.workRequests[0].original.report.completeCapture,true);assert.equal(done.workRequests[0].original.H1,null);assert.equal((await f.trace()).filter((r:any)=>r.kind==='model-input').length,2);
 }finally{release();}
});


test('completed secretary work and supplement remain readable after their execution source is removed', async t => {
  const f = await secretaryWorkPage(t);
  const capacity = new DatabaseSync(join(f.ledger!.root, 'original-fixture.sqlite'));
  capacity.exec('UPDATE capacity SET n=2');
  capacity.close();
  const binary = f.project.config.codexExecutable;
  const script = await readFile(binary, 'utf8');
  const readStage = "if(stage==='tongxu_read_file'){";
  assert.ok(script.includes(readStage));
  await writeFile(binary, script.replace(readStage,
    "if(stage==='tongxu_read_file'&&context.request?.continuation){finish({candidateH:context.candidate.H,decision:'no_change',report:'The historical supplement checked the original committed result.'});return;}" + readStage));
  const body = f.workBody();
  assert.equal((await supplementPost(f, 'ask', body)).status, 202);
  await f.wait(body.conversationId, value => value.workRequests[0]?.original?.status === 'completed'
    && value.workRequests[0].original.resourcesSettled && !value.workRequests[0].original.controllerActive);
  const {title, ...target} = (await f.get('/api/project-secretary')).value.supplementTargets[0];
  const supplement = {conversationId: body.conversationId, requestId: randomUUID(), target,
    text: 'Read the completed original result and preserve the full reply in this conversation.'};
  assert.equal((await supplementPost(f, 'supplement', supplement)).status, 202);
  const compiled = 'supplement-' + supplement.requestId;
  assert.equal((await f.settled(compiled)).status, 'no_change');
  const before = (await f.get('/api/project-secretary/conversations/' + body.conversationId)).value;
  const trace = await f.trace();
  const eventCount = () => {
    const db = new DatabaseSync(join(f.messages.store, 'queue.sqlite'), {readOnly: true});
    try { return db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n; }
    finally { db.close(); }
  };
  const events = eventCount();
  await f.app.close();
  const catalogPath = join(f.project.root, 'implementation-catalog.json');
  const currentEntry = {...f.entry, id: 'current-source'};
  await writeFile(catalogPath, JSON.stringify({schemaVersion: 1, kind: 'tongxu-issue-implementation-catalog', entries: [currentEntry]}));
  const plan = JSON.parse(await readFile(f.planPath, 'utf8'));
  plan.issueImplementation.sha256 = hash(await readFile(catalogPath));
  await writeFile(f.planPath, JSON.stringify(plan));
  const app = await startWorkbench(f.planPath, undefined, {githubReader: f.github});
  let appOpen = true;
  t.after(async () => { if (appOpen) await app.close(); });
  const url = new URL(app.url);
  const headers = {...f.headers, Authorization: 'Bearer ' + url.hash.slice(1)};
  await fetch(url.origin + '/api/github/projects', {headers});
  const get = async (path: string) => (await fetch(url.origin + path, {headers})).json() as Promise<any>;
  for (let n = 0; n < 2; n++) {
    const recovered = await get('/api/project-secretary/conversations/' + body.conversationId);
    assert.equal(recovered.workRequests[0].original?.historical, true, JSON.stringify(recovered.workRequests[0]));
    assert.deepEqual(recovered.workRequests[0].original.report, before.workRequests[0].original.report);
    assert.equal(recovered.workRequests[0].original.permissionsGranted, false);
    assert.equal(recovered.supplements[0].original.historical, true);
    assert.equal(recovered.supplements[0].original.ready, false);
    assert.equal(recovered.supplements[0].original.successful, false);
    assert.deepEqual(recovered.supplements[0].original.report, before.supplements[0].original.report);
    assert.equal(recovered.supplements[0].original.operation, before.supplements[0].original.operation);
  }
  assert.deepEqual((await get('/api/project-secretary')).supplementTargets, []);
  assert.deepEqual((await get('/api/state')).tasks, []);
  const post = async (action: string, value: unknown) => fetch(url.origin + '/api/project-secretary/' + action,
    {method: 'POST', headers: {...headers, Origin: url.origin, 'Content-Type': 'application/json'}, body: JSON.stringify(value)});
  for (const action of ['continue-work', 'stop-work', 'cancel-work']) {
    assert.equal((await post(action, {requestId: body.requestId})).status, 503);
  }
  assert.equal((await post('supplement', {...supplement, requestId: randomUUID()})).status, 503);
  await post('continue-supplements', {target});
  assert.deepEqual(await f.trace(), trace);
  assert.equal(eventCount(), events);

  const resourceClaimsBeforeHistory = f.ledger!.state().claims;
  const resourceSettlementsBeforeHistory = f.ledger!.state().settlements;
  appOpen = false;
  await app.close();
  await writeFile(catalogPath, JSON.stringify({schemaVersion: 1, kind: 'tongxu-issue-implementation-catalog', entries: []}));
  plan.issueImplementation.sha256 = hash(await readFile(catalogPath));
  const retainedSource = {id: 'retained-history', title: 'Original completed task', store: f.messages.store, item: target.task};
  plan.sources = [retainedSource];
  await writeFile(f.planPath, JSON.stringify(plan));
  for (let cold = 0; cold < 2; cold++) {
    const historyApp = await startWorkbench(f.planPath, undefined, {githubReader: f.github});
    try {
      const historyUrl = new URL(historyApp.url), historyHeaders = {...f.headers, Authorization: 'Bearer ' + historyUrl.hash.slice(1)};
      const read = async (path: string) => (await fetch(historyUrl.origin + path, {headers: historyHeaders})).json() as Promise<any>;
      const action = async (path: string, value: unknown) => fetch(historyUrl.origin + '/api/project-secretary/' + path,
        {method: 'POST', headers: {...historyHeaders, Origin: historyUrl.origin, 'Content-Type': 'application/json'}, body: JSON.stringify(value)});
      await read('/api/github/projects');
      const state = await read('/api/state');
      assert.equal(state.tasks.length, 1);assert.equal(state.tasks[0].available, true);assert.equal(state.project.unresolvedSourceCount, 0);
      for (let repeat = 0; repeat < 2; repeat++) {
        const recovered = await read('/api/project-secretary/conversations/' + body.conversationId);
        assert.equal(recovered.workRequests[0].original?.historical, true);
        assert.deepEqual(recovered.workRequests[0].original.report, before.workRequests[0].original.report);
        assert.equal(recovered.workRequests[0].original.permissionsGranted, false);
        assert.equal(recovered.supplements[0].original.historical, true);
        assert.equal(recovered.supplements[0].original.ready, false);assert.equal(recovered.supplements[0].original.successful, false);
        assert.deepEqual(recovered.supplements[0].original.report, before.supplements[0].original.report);
      }
      const choices = await read('/api/project-secretary');
      assert.deepEqual(choices.supplementTargets, []);assert.deepEqual(choices.work.options, []);
      const wrongAccount = await fetch(historyUrl.origin + '/api/project-secretary/conversations/' + body.conversationId,
        {headers: {...historyHeaders, 'X-Tongxu-Account': '8'}});
      assert.notEqual(wrongAccount.status, 200);
      for (const name of ['continue-work', 'stop-work', 'cancel-work']) assert.equal((await action(name, {requestId: body.requestId})).status, 503);
      assert.equal((await action('supplement', {...supplement, requestId: randomUUID()})).status, 503);
      await action('continue-supplements', {target});
      assert.deepEqual(await f.trace(), trace);assert.equal(eventCount(), events);assert.deepEqual(f.ledger!.state().claims, resourceClaimsBeforeHistory);assert.deepEqual(f.ledger!.state().settlements, resourceSettlementsBeforeHistory);
    } finally { await historyApp.close(); }
  }

  const historicalControls = async (entries: typeof currentEntry[], sources: Array<{store:string;item:string}> = [], repository = entries[0]?.repository ?? f.entry.repository) => {
    const path = join(f.project.root, 'history-catalog-' + randomUUID() + '.json');
    await writeFile(path, JSON.stringify({schemaVersion: 1, kind: 'tongxu-issue-implementation-catalog', entries}));
    return IssueImplementationControls.load(path, hash(await readFile(path)), repository,
      async () => { throw new Error('history_must_not_refresh_the_adopted_issue'); }, async () => {}, async () => sources);
  };
  const controls = await historicalControls([currentEntry]);
  const origin = f.messages.q.issueImplementations().original('implementation', body.requestId).origin!;
  const work = {origin, original: {requestId: body.requestId, linked: false}};
  const readOnlyControls = await historicalControls([], [retainedSource]);
  assert.deepEqual((await readOnlyControls.readProjectWork('implementation', 74, work))!.report, before.workRequests[0].original.report);
  assert.deepEqual((await readOnlyControls.readSupplement(target, compiled, supplement.text)).report, before.supplements[0].original.report);
  await assert.rejects(readOnlyControls.readProjectWork('implementation', 74, {...work, origin: {...origin, text: origin.text + ' replaced'}}), /project_work_original_mismatch/);
  await assert.rejects(readOnlyControls.readProjectWork('implementation', 74, {...work, original: {...work.original, requestId: compiled}}), /implementation_history_not_configured/);
  await assert.rejects(readOnlyControls.readProjectWork('implementation', 75, work), /project_work_original_mismatch/);
  await assert.rejects(readOnlyControls.readSupplement(target, compiled, supplement.text + ' changed'), /compiled_target_changed/);
  for (const changed of [
    {...work, origin: {...origin, text: origin.text + ' replaced'}},
    {...work, original: {...work.original, linked: true}},
    {...work, original: {...work.original, requestId: compiled}},
  ]) await assert.rejects(controls.readProjectWork('implementation', 74, changed), /project_work_original_mismatch/);
  await assert.rejects(controls.readProjectWork('implementation', 75, work), /project_work_original_mismatch/);
  for (const changed of [{...target, task: 'f'.repeat(64)}, {...target, operation: 'wrong-operation'}]) {
    await assert.rejects(controls.readSupplement(changed, compiled, supplement.text), /compiled_target_changed/);
  }
  await assert.rejects(controls.readSupplement(target, compiled, supplement.text + ' changed'), /compiled_target_changed/);
  await assert.rejects(controls.readSupplement(target, body.requestId, supplement.text), /compiled_target_changed/);
  const definition=TaskRecords.prototype.definition;
  const childTask=f.messages.q.issueImplementations().state('implementation',compiled).task;
  for(const changed of [{repository:'fixture/other'},{target:'other-target'}]){
    TaskRecords.prototype.definition=function(this:TaskRecords,id:string){
      const original=definition.call(this,id);
      return id===childTask?{...original,...changed}:original;
    };
    try{await assert.rejects(controls.readSupplement(target,compiled,supplement.text),/implementation_history_project_mismatch/);}
    finally{TaskRecords.prototype.definition=definition;}
  }
  const unavailable = await historicalControls([]);
  await assert.rejects(unavailable.readProjectWork('implementation', 74, work), /implementation_history_not_configured/);
  await assert.rejects(unavailable.readSupplement(target, compiled, supplement.text), /implementation_history_not_configured/);
  const wrongTask = await historicalControls([], [{store: f.messages.store, item: f.messages.item}]);
  await assert.rejects(wrongTask.readProjectWork('implementation', 74, work), /implementation_history_not_configured/);
  await assert.rejects(wrongTask.readSupplement(target, compiled, supplement.text), /implementation_history_not_configured/);
  const wrongProject = await historicalControls([], [retainedSource], 'fixture/other');
  await assert.rejects(wrongProject.readProjectWork('implementation', 74, work), /implementation_history_project_mismatch/);
  await assert.rejects(wrongProject.readSupplement(target, compiled, supplement.text), /implementation_history_project_mismatch/);
  const otherProject = await historicalControls([{...currentEntry, repository: 'fixture/other'}]);
  await assert.rejects(otherProject.readProjectWork('implementation', 74, work), /implementation_history_project_mismatch/);
  await assert.rejects(otherProject.readSupplement(target, compiled, supplement.text), /implementation_history_project_mismatch/);
  for (const id of [body.requestId, compiled]) {
    const state = f.messages.q.issueImplementations().state('implementation', id);
    const path = join(state.plan.operationRoot, 'implementer', 'completed.json');
    const original = await readFile(path);
    try {
      await writeFile(path, '{}');
      if (id === body.requestId) await assert.rejects(controls.readProjectWork('implementation', 74, work));
      await assert.rejects(controls.readSupplement(target, compiled, supplement.text));
    } finally { await writeFile(path, original); }
  }
  const copiedStore = join(f.project.root, 'copied-queue');
  await cp(f.messages.store, copiedStore, {recursive: true});
  for (const name of ['queue.sqlite', 'queue.sqlite-wal', 'queue.sqlite-shm']) await rm(join(copiedStore, name), {force: true});
  const db = new DatabaseSync(join(f.messages.store, 'queue.sqlite'), {readOnly: true});
  try { await backup(db, join(copiedStore, 'queue.sqlite')); }
  finally { db.close(); }
  await chmod(join(copiedStore, 'queue.sqlite'), 0o600);
  const ambiguous = await historicalControls([], [retainedSource, {...retainedSource, store: copiedStore}]);
  await assert.rejects(ambiguous.readProjectWork('implementation', 74, work), /implementation_history_ambiguous/);
  await assert.rejects(ambiguous.readSupplement(target, compiled, supplement.text), /implementation_history_ambiguous/);
  const broken = new DatabaseSync(join(copiedStore, 'queue.sqlite'));
  try { broken.prepare("DELETE FROM events WHERE kind='issue_implementation_registered' AND json_extract(data,'$.value.id')=?").run(body.requestId); }
  finally { broken.close(); }
  const damaged = await historicalControls([{...currentEntry, id: 'broken-source', store: copiedStore}, currentEntry]);
  await assert.rejects(damaged.readProjectWork('implementation', 74, work), /implementation_request_not_registered/);
  await assert.rejects(damaged.readSupplement(target, compiled, supplement.text), /implementation_request_not_registered/);
  assert.equal((await controls.readProjectWork('implementation', 74, work))!.historical, true);
  assert.equal((await controls.readSupplement(target, compiled, supplement.text)).historical, true);
  await assert.rejects(controls.begin('implementation', body.requestId), /implementation_project_not_selected/);
  await assert.rejects(controls.stop('implementation', body.requestId), /implementation_project_not_selected/);
  await assert.rejects(controls.cancelSupplement(target, compiled, supplement.text), /implementation_project_not_selected/);
  assert.deepEqual(await f.trace(), trace);
  assert.equal(eventCount(), events);
});


for (const outcome of ['no_change', 'incomplete'] as const) test('historical secretary work preserves ' + outcome + ' without enabling execution', async t => {
  const f = await secretaryWorkPage(t, 'coordinate', undefined, outcome);
  const body = f.workBody();
  assert.equal((await supplementPost(f, 'ask', body)).status, 202);
  const before = await f.wait(body.conversationId, value => value.workRequests[0]?.original
    && !value.workRequests[0].original.controllerActive && value.messages[0]?.status === 'completed');
  const trace = await f.trace();
  await f.app.close();
  const path = join(f.project.root, 'implementation-catalog.json');
  await writeFile(path, JSON.stringify({schemaVersion: 1, kind: 'tongxu-issue-implementation-catalog', entries: [{...f.entry, id: 'current-source'}]}));
  const plan = JSON.parse(await readFile(f.planPath, 'utf8'));
  plan.issueImplementation.sha256 = hash(await readFile(path));
  await writeFile(f.planPath, JSON.stringify(plan));
  const app = await startWorkbench(f.planPath, undefined, {githubReader: f.github});
  t.after(() => app.close());
  const url = new URL(app.url), headers = {...f.headers, Authorization: 'Bearer ' + url.hash.slice(1)};
  await fetch(url.origin + '/api/github/projects', {headers});
  const recovered = await (await fetch(url.origin + '/api/project-secretary/conversations/' + body.conversationId, {headers})).json() as any;
  if (outcome === 'no_change') {
    assert.equal(recovered.workRequests[0].original.historical, true);
    assert.equal(recovered.workRequests[0].original.H1, null);
    assert.deepEqual(recovered.workRequests[0].original.report, before.workRequests[0].original.report);
  } else {
    assert.equal(recovered.workRequests[0].original, null);
    assert.equal(recovered.workRequests[0].problem, 'implementation_history_incomplete');
  }
  assert.deepEqual(await f.trace(), trace);
});


test('fixed preparation environment uses no source mounts, binds original evidence and preserves stop/unknown',async t=>{
 const f=await fixture(t);fixtureRoots.get(t)!.push(f.root);const H='a'.repeat(40),T='b'.repeat(40),directory=join(f.root,'work-environment');
 const observed=await prepareWorkEnvironment(docker,directory,H,T,{refresh:async()=>{},start:effect=>effect()});assert.equal(observed.sourceMounted,false);assert.equal(observed.networkAccess,false);assert.equal(observed.observed.workPresent,false);assert.equal(typeof observed.observed.childProcess,'boolean');assert.deepEqual(await readWorkEnvironment(directory,H,T),observed);
 const recordPath=join(directory,'capability/execution.json'),bytes=await readFile(recordPath),record=JSON.parse(bytes.toString());assert.deepEqual(record.paths,{});assert.ok(record.createArgs.includes('--network=none'));assert.equal(record.createArgs.includes('--mount'),false);assert.equal(record.binding.head,H);assert.equal(record.binding.tree,T);
 const proofPath=join(directory,'observation.json'),proofBytes=await readFile(proofPath),proof=JSON.parse(proofBytes.toString());
 for(const change of [{imageId:'sha256:'+'c'.repeat(64)},{configuration:{...proof.configuration,image:'sha256:'+'d'.repeat(64)}}]){await writeFile(proofPath,canonical({...proof,...change}));await assert.rejects(readWorkEnvironment(directory,H,T),/binding_changed/);}await writeFile(proofPath,proofBytes);
 await assert.rejects(readWorkEnvironment(directory,'c'.repeat(40),T),/binding_changed/);
 const out=join(directory,'capability/stdout'),original=await readFile(out);await writeFile(out,'{}');await assert.rejects(readWorkEnvironment(directory,H,T),/evidence_changed/);await writeFile(out,original);
 await writeFile(recordPath,canonical({...record,phase:'unknown'}));await assert.rejects(assertWorkEnvironmentEnded(directory,docker),/original_unknown/);await writeFile(recordPath,bytes);await assertWorkEnvironmentEnded(directory,docker);
 const stopped=join(f.root,'stopped-work-environment');await assert.rejects(prepareWorkEnvironment(docker,stopped,H,T,{start:()=>{throw Error('synthetic_stopped_before_probe');}}));assert.equal(await exists(join(stopped,'capability')),false);await assertWorkEnvironmentEnded(stopped,docker);
});


// Reproduce the historic early registration and pre-handoff rejection only in
// a public synthetic fixture. The child controller genuinely exits; no PID or
// source proof is fabricated, and no real model is invoked.
async function metadataFirstInputFixture(t:TestContext,legacyProfile=true){
 const register=IssueImplementations.prototype.register,bind=IssueImplementations.prototype.bind;let f:Awaited<ReturnType<typeof unsentImplementation>>;
 // Explicit historic fixture before registration, never mutate accepted bytes.
 if(legacyProfile){IssueImplementations.prototype.register=function(source,request,...args){
   // Construct the old tuple before this request or plan is accepted. No model
   // input or queue plan binding has been persisted at this boundary.
   delete request.editProfile;const root=request.workspaceRequest.executionRoot;
   for(const path of [join(root,'plan.json'),join(root,'config.json'),root+'-implementation-config.json']){const value=JSON.parse(fsSync.readFileSync(path,'utf8'));delete value.editProfile;fsSync.writeFileSync(path,canonical(value));}
   const path=join(root,'preparation-intent.json'),intent=JSON.parse(fsSync.readFileSync(path,'utf8'));intent.configSha256=hash(fsSync.readFileSync(join(root,'config.json')));fsSync.writeFileSync(path,canonical(intent));return register.call(this,source,request,...args);
  };IssueImplementations.prototype.bind=function(source,id,value){return bind.call(this,source,id,{...value,sha256:hash(fsSync.readFileSync(value.path))});};}
 try{f=await unsentImplementation(t,true);}finally{IssueImplementations.prototype.register=register;IssueImplementations.prototype.bind=bind;}
 const fixed=f.original.plan,{readOwnerSource}=await import('../../src/authority-source.js'),profile=f.messages.q.authority().configuration().profile,refs=new Map<string,any>();
 for(const authorization of Object.values(fixed.authorization) as string[])for(const r of f.messages.q.authority().sourceRequests(authorization))refs.set(r.proposalSha256,r);
 const observations=[];for(const ref of refs.values())observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(f.project.root,'legacy-observation-'+ref.proposalSha256)));
 f.messages.q.issueImplementations().dispatch('implementation',f.id,observations);
 const script=`import{readFile}from'node:fs/promises';import{runIssueImplementation}from ${JSON.stringify(new URL('../../src/issue-implementation.js',import.meta.url).href)};import{RepairTools,checkRepairIndex,tree}from ${JSON.stringify(new URL('../../src/repair-workspace.js',import.meta.url).href)};RepairTools.prototype.check=async function(){const current=await tree(this.workspace,true);await checkRepairIndex(this.workspace,this.operation,this.grant.allowedPaths,current);return current;};try{await runIssueImplementation(${JSON.stringify(fixed.path)},${JSON.stringify(fixed.sha256)},${JSON.stringify(fixed.request)},${JSON.stringify(fixed.operationRoot)},{refresh:async()=>{},unsent:()=>{},check:effect=>effect?.(),dispatch:()=>{throw Error('fixture_unexpected_task_input')}});}catch(e){if(e.message!=='repair_index_file_type_unsupported')throw e;console.log(e.message);}`;
 const child=await exec(process.execPath,['--input-type=module','--eval',script],{timeout:60000,maxBuffer:1024*1024});assert.match(child.stdout,/repair_index_file_type_unsupported/);
 const native=join(f.operation,'implementer'),stdin=await readFile(join(native,'stdin.ndjson'));assert.equal(stdin.toString().includes('turn/start'),false);assert.equal((await readFile(f.project.trace,'utf8')).includes('model-input'),false);
 const pageSettled=async()=>{for(let i=0;i<1000;i++){const s=(await f.get()).value.entries[0].requests.find((x:any)=>x.id===f.id);if(!s.controllerActive&&(s.status||s.reason))return s;await new Promise(r=>setTimeout(r,20));}throw Error('first_input_fixture_timeout');};return {...f,fixed,native,pageSettled};
}
for(const legacyProfile of [true,false])test('first input explicit continuation preserves '+(legacyProfile?'legacy':'literal-edits-v1')+' metadata, baseline, claim and complete capture association',async t=>{
 const f=await metadataFirstInputFixture(t,legacyProfile),{readFirstSendProof}=await import('../../src/implementation-first-send.js'),candidate=f.messages.q.issueImplementations().firstSendCandidate('implementation',f.id),proof=await readFirstSendProof(candidate.plan,candidate.dispatchEvent),claims=f.ledger!.state().claims.length;
 const oldFiles=proof.record.files;assert.equal((await f.control().firstInputContinuation('implementation',f.id)).eligible,true);await f.control().begin('implementation',f.id);await f.control().drain();assert.equal((await readFile(f.project.trace,'utf8')).includes('model-input'),false);
 // The normal HTTP action is explicit; a repeated click shares the active run.
 assert.equal((await f.post('continue-first-input',{requestId:f.id})).status,202);await f.post('continue-first-input',{requestId:f.id});const done=await f.pageSettled();assert.equal(done.status,'completed',JSON.stringify(done));
 const state=f.messages.q.issueImplementations().state('implementation',f.id);assert.equal(state.operation,f.original.operation);assert.equal(state.requestSha256,f.original.requestSha256);assert.equal(f.ledger!.state().claims.length,claims);assert.equal(f.ledger!.state().settlements.length,1);
 const report=await f.control().report('implementation',f.id);assert.equal(report.completeCapture,true);assert.equal(report.firstInputContinuation.firstInputSha256,proof.record.firstInputSha256);assert.equal(report.H1,done.H1);const ownerProof=await f.control().ownerFeedbackProof(f.messages.store,{source:'implementation',requestId:f.id,task:state.task,operation:state.operation,requestSha256:state.requestSha256});assert.ok(ownerProof.files.some(x=>x.path.startsWith(report.firstInputContinuation.nativeDirectory)));
 for(const [name,sha] of Object.entries(oldFiles))assert.equal(hash(await readFile(join(f.fixed.request.workspaceRequest.executionRoot,name))),sha);
 assert.equal(await git(f.fixed.workspace,['rev-parse',done.H0+':omitted-link']),await git(f.fixed.workspace,['rev-parse',done.H1+':omitted-link']));
 const inputs=JSON.parse(await readFile(join(report.firstInputContinuation.nativeDirectory,'inputs.json'),'utf8'));assert.equal(hash(inputs[0].input),proof.record.firstInputSha256);const trace=await readFile(f.project.trace);assert.equal(trace.toString().split('model-input').length-1,1);
 await f.post('start',{requestId:f.id});await f.post('continue-first-input',{requestId:f.id});await f.pageSettled();assert.deepEqual(await readFile(f.project.trace),trace);
 const {assertImplementationOwnerSourceSync,readImplementationResult}=await import('../../src/implementation-owner-feedback.js'),inputPath=join(report.firstInputContinuation.nativeDirectory,'inputs.json'),originalInput=await readFile(inputPath);await writeFile(inputPath,'[]');assert.throws(()=>assertImplementationOwnerSourceSync(ownerProof),/original_capture_changed/);await assert.rejects(f.control().report('implementation',f.id));await writeFile(inputPath,originalInput);
 const oldStderr=join(f.native,'stderr.txt'),oldBytes=await readFile(oldStderr);await writeFile(oldStderr,'changed old metadata');await assert.rejects(f.control().report('implementation',f.id),/original_changed/);await writeFile(oldStderr,oldBytes);
 const foreign=structuredClone(state);foreign.result.firstInputContinuation.nativeDirectory=f.native;await assert.rejects(readImplementationResult(foreign),/capture_changed/);await f.reopen();assert.equal((await f.control().report('implementation',f.id)).H1,done.H1);assert.deepEqual(await readFile(f.project.trace),trace);
 const db=new DatabaseSync(join(f.messages.store,'queue.sqlite'));try{assert.equal((db.prepare("SELECT count(*) n FROM events WHERE kind='issue_implementation_dispatched'").get() as any).n,1);}finally{db.close();}
});
test('first input metadata proof rejects live controllers, intents, damaged or ambiguous baseline before a new capture',async t=>{
 const f=await metadataFirstInputFixture(t),{readFirstSendProof}=await import('../../src/implementation-first-send.js'),candidate=f.messages.q.issueImplementations().firstSendCandidate('implementation',f.id),leasePath=join(f.fixed.workspace,'.git/tongxu-writer.json'),lease=await readFile(leasePath),native=f.native,trace=await readFile(f.project.trace);
 for(const change of ['controller','native','intent','inputs','tool','partial','capture','remote','account','unknown-notification','source','baseline','ambiguous','handoff','index'] as const){
  const restores:Array<()=>Promise<any>>=[];
  if(change==='controller'){await writeFile(leasePath,canonical({...JSON.parse(lease.toString()),controllerPid:process.pid}));restores.push(()=>writeFile(leasePath,lease));}
  if(change==='native'){const p=join(native,'process.json'),b=await readFile(p);await writeFile(p,canonical({pid:process.pid}));restores.push(()=>writeFile(p,b));}
  if(change==='intent'){const p=join(native,'turn-1-intent.json');await writeFile(p,'{}');restores.push(()=>rm(p));}
  if(change==='inputs'||change==='tool'){const p=join(native,change==='inputs'?'inputs.json':'native-tool-transports.json');await writeFile(p,'[]');restores.push(()=>rm(p));}
  if(change==='partial'||change==='capture'){const p=join(native,change==='partial'?'stdin.ndjson':'stdout.ndjson'),b=await readFile(p);await writeFile(p,change==='partial'?b.subarray(0,b.length-1):Buffer.concat([b,Buffer.from('{}\n')]));restores.push(()=>writeFile(p,b));}
  if(change==='remote'||change==='account'||change==='unknown-notification'){const p=join(native,'stdout.ndjson'),b=await readFile(p),statusPath=join(native,'capture-status.json'),status=await readFile(statusPath),rows=b.toString().trim().split('\n').map(x=>JSON.parse(x));if(change==='unknown-notification')rows.push({method:'unrecognized/notification',params:{}});else if(change==='remote')rows.find(x=>x.method==='remoteControl/status/changed').params.status='enabled';else rows.find(x=>x.method==='account/updated').params.planType='foreign-plan';const changed=Buffer.from(rows.map(x=>JSON.stringify(x)).join('\n')+'\n'),record=JSON.parse(status.toString());record.files['stdout.ndjson']=hash(changed);await writeFile(p,changed);await writeFile(statusPath,JSON.stringify(record));restores.push(()=>writeFile(p,b),()=>writeFile(statusPath,status));}
  if(change==='source'){const p=join(f.fixed.workspace,f.fixed.request.workspaceRequest.allowedPaths[0]),b=await readFile(p);await writeFile(p,Buffer.concat([b,Buffer.from('// external change\n')]));restores.push(()=>writeFile(p,b));}
  if(change==='baseline'){const dirs=(await readdir(f.fixed.request.workspaceRequest.executionRoot)).filter(n=>n.startsWith('preflight-tests-')),p=join(f.fixed.request.workspaceRequest.executionRoot,dirs[0]!,'result.json'),b=await readFile(p);await writeFile(p,canonical({...JSON.parse(b.toString()),passed:true}));restores.push(()=>writeFile(p,b));}
  if(change==='ambiguous'){const p=join(f.fixed.request.workspaceRequest.executionRoot,'preflight-tests-ambiguous');await mkdir(p);restores.push(()=>rm(p,{recursive:true}));}
  if(change==='handoff'){const p=join(f.operation,'handoff-unknown.json');await writeFile(p,'{}');restores.push(()=>rm(p));}
  if(change==='index'){const p=join(f.fixed.workspace,'.git/index'),b=await readFile(p);await git(f.fixed.workspace,['update-index','--force-remove','omitted-link']);restores.push(()=>writeFile(p,b));}
  try{await assert.rejects(readFirstSendProof(candidate.plan,candidate.dispatchEvent));assert.equal(await exists(join(f.operation,'first-input')),false);assert.deepEqual(await readFile(f.project.trace),trace);}finally{for(const restore of restores)await restore();}
 }
 await f.control().stop('implementation',f.id);assert.equal((await f.control().firstInputContinuation('implementation',f.id)).eligible,false);await f.post('continue-first-input',{requestId:f.id});await f.pageSettled();assert.equal(await exists(join(f.operation,'first-input')),false);assert.deepEqual(await readFile(f.project.trace),trace);
});

for(const projectFiles of [true,false])test('first dispatch intent with zero wire input recovers the same '+(projectFiles?'projectFiles':'selected_files')+' request',async t=>{
 const f=await implementationEntry(t,false,'normal',!projectFiles,projectFiles);
 const open=async()=>IssueImplementationControls.load(f.catalogPath,hash(await readFile(f.catalogPath)),f.entry.repository,f.readIssue,async()=>{});
 let controls=await open();t.after(()=>controls.drain());
 const id='registered-intent-without-wire',operation=join(f.entry.root,id,'operation'),native=join(operation,'implementer');
 const settled=async()=>{
  const until=Date.now()+60000;
  let latest;
  while(Date.now()<until){
   const row=(await controls.state())[0]!.requests.find(r=>r.id===id);
   if(row&&!row.controllerActive&&(row.reason||row.status||row.phase==='active_or_unknown'))return row;
   latest=row;
   await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.fail('first_dispatch_fixture_timeout '+JSON.stringify(latest));
 };
 const originalRequest=LiveProcess.prototype.request;
 let reads=0;
 function closeAfterUsage(this:LiveProcess,...args:Parameters<LiveProcess['request']>){
  const reply=originalRequest.apply(this,args);
  if(this.directory!==native||args[0]!=='account/rateLimits/read'||++reads!==2)return reply;
  // Drain this actual fixture subprocess after the last rate-limit reply.
  // The real runner persists the intent and dispatch, then rejects before sending.
  return reply.then(async value=>{await this.close();return value;});
 }
 const script=await readFile(f.project.config.codexExecutable,'utf8'),needle="const v=JSON.parse(m.result.contentItems[0].text);";
 assert.ok(script.includes(needle));
 await writeFile(f.project.config.codexExecutable,script.replace(needle,needle+
   "if(stage==='tongxu_read_file'){finish({candidateH:context.candidate.H,decision:'no_change',report:'Explicit fixture only reads after first-input recovery.'});return;}"));
 await controls.prepare('implementation',{requestId:id,issueNumber:74});
 if(projectFiles){
  // Use a separate original controller so recovery also sees an ended lease PID.
  const childScript=`
import {LiveProcess} from ${JSON.stringify(new URL('../../src/live-process.js',import.meta.url).href)};
import {IssueImplementationControls} from ${JSON.stringify(new URL('../../src/issue-implementation-controls.js',import.meta.url).href)};
const native=${JSON.stringify(native)},originalRequest=LiveProcess.prototype.request;
let reads=0;
LiveProcess.prototype.request=${closeAfterUsage.toString()};
const controls=await IssueImplementationControls.load(${JSON.stringify(f.catalogPath)},${JSON.stringify(hash(await readFile(f.catalogPath)))},
 ${JSON.stringify(f.entry.repository)},async()=>(${JSON.stringify(await f.readIssue())}),async()=>{});
await controls.begin('implementation',${JSON.stringify(id)});
for(let attempt=0;attempt<500;attempt++){
 const row=(await controls.state())[0].requests[0];
 if(!row.controllerActive&&row.reason)break;
 await new Promise(r=>setTimeout(r,20));
}
await controls.drain();
`;
  await exec(process.execPath,['--input-type=module','--eval',childScript],{timeout:90000});
 }else{
  t.mock.method(LiveProcess.prototype,'request',closeAfterUsage);
  await controls.begin('implementation',id);
 }
 const waiting=await settled();assert.equal(waiting.phase,'active_or_unknown',JSON.stringify(waiting));
 assert.equal(waiting.reason,'executor_closed');
 const records=f.messages.q.issueImplementations(),before=records.state('implementation',id),candidate=records.firstSendCandidate('implementation',id);
 const {readFirstSendProof}=await import('../../src/implementation-first-send.js');
 const wirePath=join(native,'stdin.ndjson'),wire=await readFile(wirePath),originalIntent=await readFile(join(native,'turn-1-intent.json'));
 const capturePath=join(native,'capture-status.json'),capture=await readFile(capturePath);
 assert.ok(!wire.toString().includes('turn/start'));assert.ok(!(await readFile(f.project.trace,'utf8')).includes('model-input'));
 if(!projectFiles)await assert.rejects(readFirstSendProof(candidate.plan,candidate.dispatchEvent),/controller_active_or_unknown/);
 const proof=await readFirstSendProof(candidate.plan,candidate.dispatchEvent,!projectFiles);
 assert.equal(proof.record.dispatchIntentSha256,hash(originalIntent));
 assert.equal(proof.baseline===null,projectFiles);
 const attempted=JSON.parse(await readFile(join(native,'expected-requests.json'),'utf8')).at(-1);
 assert.equal(attempted.method,'turn/start');
 const withTurn=Buffer.concat([wire,Buffer.from(JSON.stringify(attempted)+'\n')]);
 await writeFile(wirePath,withTurn);
 const status=JSON.parse(capture.toString());status.files['stdin.ndjson']=hash(withTurn);await writeFile(capturePath,canonical(status));
 await assert.rejects(readFirstSendProof(candidate.plan,candidate.dispatchEvent,true),/metadata_unknown/);
 await writeFile(wirePath,wire);await writeFile(capturePath,capture);
 await rm(capturePath);
 await assert.rejects(readFirstSendProof(candidate.plan,candidate.dispatchEvent,true),/capture_incomplete/);
 await writeFile(capturePath,capture);
 await mkdir(join(operation,'calls'));
 await assert.rejects(readFirstSendProof(candidate.plan,candidate.dispatchEvent,true),/not_metadata/);
 await rm(join(operation,'calls'),{recursive:true});
 const source=join(before.plan.workspace,'src/normalize.mjs'),sourceBytes=await readFile(source);
 await writeFile(source,'changed after the ended original');
 await assert.rejects(readFirstSendProof(candidate.plan,candidate.dispatchEvent,true),/source_changed/);
 await writeFile(source,sourceBytes);
 await controls.drain();controls=await open();
 assert.deepEqual(await controls.firstInputContinuation('implementation',id),{eligible:true});
 f.changeIssue('Changed Issue during recovery');
 await controls.continueFirstInput('implementation',id);
 assert.equal((await settled()).reason,'implementation_issue_source_changed');
 assert.equal(records.state('implementation',id).firstInputContinuation,null);
 assert.ok(!(await readFile(f.project.trace,'utf8')).includes('model-input'));
 f.changeIssue(f.body);
 const prototype=Object.getPrototypeOf(records) as typeof records,firstInput=prototype.firstInput;
 let interruptCheckpoint=true;
 t.mock.method(prototype,'firstInput',function(this:typeof records,...args:Parameters<typeof firstInput>){
   const saved=firstInput.apply(this,args);
   if(interruptCheckpoint){interruptCheckpoint=false;throw new Error('fixture_after_first_input_checkpoint');}
   return saved;
 });
 await controls.continueFirstInput('implementation',id);
 assert.equal((await settled()).reason,'fixture_after_first_input_checkpoint');
 assert.ok(records.state('implementation',id).firstInputContinuation);
 assert.ok(!(await readFile(f.project.trace,'utf8')).includes('model-input'));
 if(!projectFiles){
   const {releaseWorkspace}=await import('../../src/repair-workspace.js');
   await releaseWorkspace(before.plan.workspace,proof.lease,'verified_unstarted_dispatch',true);
   await mkdir(join(operation,'first-input'),{mode:0o700});
   const lock=join(operation,'ownership-history',proof.lease.generation+'-lock.json'),owned=await readFile(lock);
   await writeFile(lock,canonical({...proof.lease,controllerPid:1}));
   assert.equal((await controls.firstInputContinuation('implementation',id)).eligible,false);
   await writeFile(lock,owned);
   const program=`
import {readFile} from 'node:fs/promises';
import {acquireWorkspace} from ${JSON.stringify(new URL('../../src/repair-workspace.js',import.meta.url).href)};
const plan=JSON.parse(await readFile(${JSON.stringify(before.plan.path)},'utf8'));
await acquireWorkspace(plan.workspace,${JSON.stringify(operation)},false,JSON.parse(await readFile(plan.grant,'utf8')));
`;
   await exec(process.execPath,['--input-type=module','--eval',program],{timeout:30000});
   assert.equal(await exists(join(operation,'first-input','native')),false);
 }
 await controls.drain();controls=await open();
 assert.deepEqual(await controls.firstInputContinuation('implementation',id),{eligible:true});
 await controls.continueFirstInput('implementation',id);
 const done=await settled();assert.equal(done.status,'no_change',JSON.stringify(done));
 const result=records.state('implementation',id);
 assert.equal(result.operation,before.operation);assert.equal(result.requestSha256,before.requestSha256);
 assert.equal(result.firstInputContinuation.proof.dispatchEvent,candidate.dispatchEvent);
 assert.equal(result.firstInputContinuation.replacementDispatchGuard,'v1');
 assert.deepEqual(await readFile(wirePath),wire);
 assert.deepEqual(await readFile(join(native,'turn-1-intent.json')),originalIntent);
 const trace=await readFile(f.project.trace,'utf8');assert.equal(trace.split('model-input').length-1,1);
 await controls.continueFirstInput('implementation',id);await settled();
 assert.equal(await readFile(f.project.trace,'utf8'),trace);
});

test('first input explicit continuation fresh checks original Issue, authority and held resource without a new stage or claim',async t=>{
 for(const fault of ['issue','authority','resource'] as const){
  const f=await metadataFirstInputFixture(t),before=await readFile(f.project.trace),claims=f.ledger!.state().claims.length;
  if(fault==='issue')f.changeIssue(f.body+' changed after the original metadata ended.');
  if(fault==='authority')await f.owner.adopt({kind:'revoke',decision:f.grant.sha});
  if(fault==='resource'){const db=new DatabaseSync(join(f.ledger!.root,'original-fixture.sqlite'));try{const row=db.prepare('SELECT id,result FROM requests').get() as any,result=JSON.parse(row.result);result.claim.state='consumed';result.claim.outcomeSha256='a'.repeat(64);db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(result),row.id);}finally{db.close();}}
  await f.post('continue-first-input',{requestId:f.id});const ended=await f.pageSettled();assert.ok(ended.reason);assert.equal(ended.completeCapture,false);assert.equal(await exists(join(f.operation,'first-input')),false);assert.deepEqual(await readFile(f.project.trace),before);assert.equal(f.ledger!.state().claims.length,claims);assert.equal(f.ledger!.state().settlements.length,0);assert.equal(f.messages.q.issueImplementations().state('implementation',f.id).firstInputContinuation,null);
 }
});
