import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID,createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, realpath, mkdir, rename } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { hash, privateDirectory } from './snapshot.js';
import { save } from './live-process.js';
import type { Candidate } from './live-codex.js';
import {parse} from 'acorn';

const exec = promisify(execFile);
export const safeEnv = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' };
export const git = async (cwd: string, args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env: safeEnv, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
export async function mutateGit(cwd: string, args: string[], directory: string) {
  await privateDirectory(directory, true);
  const argv = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args];
  save(join(directory, 'launch.json'), { command: '/usr/bin/git', args: argv, cwd, status: 'launch_registered' });
  const child = spawn('/usr/bin/git', argv, { env: safeEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  save(join(directory, 'process.json'), { pid: child.pid });
  let out = '', err = '', limited = false;
  const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  const timer = setTimeout(() => { limited = true; kill(); }, 30000);
  child.stdout.on('data', b => { if (out.length < 2 * 1024 * 1024) out += b; else { limited = true; kill(); } });
  child.stderr.on('data', b => { if (err.length < 2 * 1024 * 1024) err += b; else { limited = true; kill(); } });
  child.on('error', () => { limited = true; });
  const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); save(join(directory, 'exit.json'), exit); await writeFile(join(directory, 'stdout.txt'), out, { mode: 0o600 }); await writeFile(join(directory, 'stderr.txt'), err, { mode: 0o600 });
  if (limited || exit.code !== 0 || exit.signal != null) throw new Error('git_mutation_incomplete'); return out.trim();
}
export async function exists(path: string) { try { await lstat(path); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
export async function regular(path: string, limit = 1024 * 1024) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('noncanonical_repair_path');
  const st = await lstat(path); if (!st.isFile() || st.nlink !== 1 || st.size > limit) throw new Error('invalid_repair_file');
  const bytes = await readFile(path); if (bytes.length !== st.size) throw new Error('repair_file_changed_during_read'); return bytes;
}
export type Tree = Record<string, { sha256: string; bytes: number; text: string; executable?: number }>;
export async function tree(workspace: string, project = false): Promise<Tree> {
  if (await realpath(workspace) !== workspace) throw new Error('noncanonical_workspace');
  const result: Tree = Object.create(null);
  const walk = async (sub: string) => {
    for (const name of (await readdir(join(workspace, sub))).sort()) {
      if (!sub && name === '.git') continue;
      const path = sub ? sub + '/' + name : name, full = join(workspace, path), st = await lstat(full);
      if (st.isSymbolicLink() || !/^[A-Za-z0-9_.\/-]+$/.test(path)) throw new Error('unsafe_workspace_entry');
      if (st.isDirectory()) await walk(path);
      else { const b = await regular(full, 256 * 1024); result[path] = { sha256: hash(b), bytes: b.length, text: new TextDecoder('utf8', { fatal: true }).decode(b), ...(project ? { executable: st.mode & 0o111 } : {}) }; }
      if (Object.keys(result).length > (project ? 2048 : 30)) throw new Error('repair_workspace_limit');
    }
  };
  await walk(''); if (Buffer.byteLength(JSON.stringify(result)) > (project ? 16 : 1) * 1024 * 1024) throw new Error('repair_workspace_limit'); return result;
}
export const treeHash = (t: Tree) => hash(JSON.stringify(t));
export function scopeChanges(before: Tree, after: Tree, allowed: string[]) {
  if (Object.keys(before).join('\0') !== Object.keys(after).join('\0')) throw new Error('workspace_file_set_changed');
  const changed = Object.keys(before).filter(p => before[p]!.sha256 !== after[p]!.sha256 || before[p]!.executable !== after[p]!.executable);
  if (changed.some(p => !allowed.includes(p))) throw new Error('out_of_scope_workspace_change'); return changed;
}
export function processState(pid: unknown): 'alive' | 'ended' | 'unknown' {
  if (!Number.isSafeInteger(pid) || Number(pid) < 2) return 'unknown';
  try { process.kill(Number(pid), 0); return 'alive'; } catch (e: any) { return e.code === 'ESRCH' ? 'ended' : 'unknown'; }
}
/** A resumed writer must not silently overwrite a different staged version
 * or commit unrelated staged paths. Preserve the exact index and staged
 * blobs before refusing; matching staged bytes from registered repair tools
 * remain recoverable under the original allowed paths. No filters run. */
export async function checkRepairIndex(workspace:string,operation:string,allowedPaths:string[],current:Tree){
  const directory=join(workspace,'.git');if(await exists(join(directory,'index.lock')))throw new Error('git_write_active_or_unknown');
  const index=await regular(join(directory,'index'),8*1024*1024),capture=async(args:string[])=>{
    const r=await exec('/usr/bin/git',['--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',workspace,...args],{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'},encoding:'buffer',maxBuffer:8*1024*1024,timeout:15000});return r.stdout;
  };
  const H=(await capture(['rev-parse','HEAD'])).toString().trim(),headRaw=await capture(['ls-tree','-r','-z',H]),indexRaw=await capture(['ls-files','--stage','-z']);
  const head=new Map<string,{mode:string;object:string}>(),staged=new Map<string,Array<{mode:string;object:string;stage:number}>>();
  for(const row of headRaw.toString().split('\0').filter(Boolean)){const x=/^(100644|100755) blob ([a-f0-9]{40})\t([A-Za-z0-9_.\/-]+)$/.exec(row);if(!x)throw new Error('repair_index_file_type_unsupported');head.set(x[3]!,{mode:x[1]!,object:x[2]!});}
  for(const row of indexRaw.toString().split('\0').filter(Boolean)){const x=/^(100644|100755) ([a-f0-9]{40}) ([0-3])\t([A-Za-z0-9_.\/-]+)$/.exec(row);if(!x)throw new Error('repair_index_file_type_unsupported');const list=staged.get(x[4]!)??[];list.push({mode:x[1]!,object:x[2]!,stage:Number(x[3])});staged.set(x[4]!,list);}
  const changed=[...new Set([...head.keys(),...staged.keys()])].filter(path=>{const h=head.get(path),v=staged.get(path);return !h||v?.length!==1||v[0]!.stage!==0||v[0]!.mode!==h.mode||v[0]!.object!==h.object;});
  const blobs:Record<string,string>={},changes=[];let matched=true,total=0;
  for(const path of changed){const v=staged.get(path)??[],file=current[path];let same=false;
    if(file){const b=await regular(join(workspace,path),256*1024);if(hash(b)!==file.sha256)throw new Error('repair_index_working_source_changed');const object=createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');same=v.length===1&&v[0]!.stage===0&&v[0]!.object===object&&(v[0]!.mode==='100755')===Boolean(file.executable?file.executable&0o100:false);}
    for(const e of v){if(blobs[e.object])continue;const b=await capture(['cat-file','blob',e.object]);if(b.length>256*1024||(total+=b.length)>16*1024*1024)throw new Error('repair_index_evidence_limit');blobs[e.object]=b.toString('base64');}
    const accepted=same&&allowedPaths.includes(path);matched&&=accepted;changes.push({path,head:head.get(path)??null,index:v,working:file??null,accepted});
  }
  if(await exists(join(directory,'index.lock'))||!index.equals(await regular(join(directory,'index'),8*1024*1024))||!(await capture(['ls-files','--stage','-z'])).equals(indexRaw)||(await capture(['rev-parse','HEAD'])).toString().trim()!==H)throw new Error('repair_index_changed_during_observation');
  if(changed.length){const b=Buffer.from(JSON.stringify({H,indexBase64:index.toString('base64'),headRaw:headRaw.toString(),indexRaw:indexRaw.toString(),blobs,changes,matched,policy:'preserve_original_index; only registered allowed-path bytes may be committed'})),folder=join(operation,'index-observations'),path=join(folder,hash(b)+'.json');await mkdir(folder,{recursive:true,mode:0o700});try{await writeFile(path,b,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST'||!(await regular(path,32*1024*1024)).equals(b))throw e;}}
  if(!matched)throw new Error('repair_preserved_index_requires_explicit_reconciliation');
}
export type Grant = { id: string; source: string; workspace: string; H: string; treeSha256: string; allowedPaths: string[]; allowRepair: boolean; allowReconcileEnded: boolean; maxRepairRounds: number; profile?: 'project-v1'; materialPaths?: string[] };
export type Lease = { operation: string; controllerPid: number; generation: string; status: 'held' };
export function projectTestNamespace(operation: string, directory: string) {
  return directory.startsWith(operation + '/') && /^(?:attempt-[1-3]\/(?:baseline|post-repair-[1-3])|tests\/tool-[A-Za-z0-9_-]{1,128})$/.test(directory.slice(operation.length + 1));
}

export async function acquireWorkspace(workspace: string, operation: string, reconcileEnded: boolean, grant: Grant, beforeReconcile?: () => Promise<void>) {
  if (await realpath(join(workspace, '.git')) !== join(workspace, '.git') || !(await lstat(join(workspace, '.git'))).isDirectory()) throw new Error('unsafe_managed_git_directory');
  if (await exists(join(workspace, '.git', 'index.lock'))) throw new Error('git_write_active_or_unknown');
  const lock = join(workspace, '.git', 'tongxu-writer.json');
  if (await exists(lock)) {
    const prior = JSON.parse((await regular(lock)).toString()) as Lease;
    if (prior.operation !== operation || !reconcileEnded || !grant.allowReconcileEnded || processState(prior.controllerPid) !== 'ended') throw new Error('writer_active_or_unknown');
    // Every registered process must be known ended; absence of a PID after a
    // launch intent is unknown, not permission to create a replacement.
    const walk = async (dir: string) => {
      const projectTest = grant.profile === 'project-v1' && projectTestNamespace(operation, dir);
      const testDataDirectories = new Set<string>();
      if (projectTest) {
        const intent = JSON.parse((await regular(join(dir, 'test-intent.json'))).toString());
        if (intent.directory !== dir || intent.workspace !== workspace || intent.kind !== 'registered-project-tests-v1' || !Array.isArray(intent.generatedDirectories) || intent.generatedDirectories.length > 16) throw new Error('project_test_intent_unverified');
        testDataDirectories.add('work'); testDataDirectories.add('output');
        intent.generatedDirectories.forEach((_: unknown, i: number) => testDataDirectories.add('generated-' + i));
      }
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) throw new Error('unsafe_operation_entry');
        if (e.isDirectory() && e.name !== 'workspace' && !testDataDirectories.has(e.name)) await walk(join(dir, e.name));
        else if (e.isFile() && e.name === 'launch.json') {
          const p = join(dir, 'process.json');
          if (!await exists(p) || processState(JSON.parse((await regular(p)).toString()).pid) !== 'ended') throw new Error('child_active_or_unknown');
        }
      }
    };
    await walk(operation);
    await beforeReconcile?.();
    const observed = await tree(workspace, grant.profile === 'project-v1');
    const frozen = JSON.parse((await regular(join(operation, 'initial-tree.json'), grant.profile ? 20 * 1024 * 1024 : undefined)).toString()) as Tree;
    scopeChanges(frozen, observed, grant.allowedPaths);
    await mkdir(join(operation, 'ownership-history'), { recursive: true, mode: 0o700 });
    save(join(operation, 'ownership-history', prior.generation + '-reconciled.json'), { prior, controllerEnded: true, registeredChildrenEnded: true, observedTree: observed, observedTreeSha256: treeHash(observed), authorization: grant.id });
    await rename(lock, join(operation, 'ownership-history', prior.generation + '-lock.json'));
  }
  const lease: Lease = { operation, controllerPid: process.pid, generation: randomUUID(), status: 'held' };
  await writeFile(lock, JSON.stringify(lease), { flag: 'wx', mode: 0o600 }); return lease;
}
export async function releaseWorkspace(workspace: string, lease: Lease, outcome: string) {
  const lock = join(workspace, '.git', 'tongxu-writer.json'), actual = JSON.parse((await regular(lock)).toString());
  if (JSON.stringify(actual) !== JSON.stringify(lease)) throw new Error('writer_lease_changed');
  await mkdir(join(lease.operation, 'ownership-history'), { recursive: true, mode: 0o700 });
  save(join(lease.operation, 'ownership-history', lease.generation + '-released.json'), { lease, outcome, at: new Date().toISOString() });
  await rename(lock, join(lease.operation, 'ownership-history', lease.generation + '-lock.json'));
}

export function validateClampExpression(source: string) {
  if (Buffer.byteLength(source) > 16 * 1024) throw new Error('expression_source_limit');
  // The compiler is a build tool; runtime validation uses the ESTree parser
  // contract. New syntax is rejected unless this explicit allowlist handles it.
  let file:any;
  try{file=parse(source,{ecmaVersion:'latest',sourceType:'module',preserveParens:true});}
  catch{throw new Error('pure_expression_module_required');}
  if(file?.type!=='Program'||file.body?.length!==1)throw new Error('pure_expression_module_required');
  const exported=file.body[0],fn=exported.declaration;
  if(exported.type!=='ExportNamedDeclaration'||exported.source||exported.specifiers?.length||fn?.type!=='FunctionDeclaration'||fn.id?.name!=='clamp'||fn.async||fn.generator||fn.params?.length!==3||fn.params.some((p:any)=>p.type!=='Identifier')||fn.body?.type!=='BlockStatement'||fn.body.body?.length!==1)throw new Error('pure_clamp_signature_required');
  const parameters=new Set(fn.params.map((p:any)=>p.name));
  if(parameters.size!==3||parameters.has('Math'))throw new Error('invalid_clamp_parameters');
  const statement=fn.body.body[0];
  if(statement.type!=='ReturnStatement'||!statement.argument)throw new Error('single_return_required');
  const operators=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==','&&','||']);
  let nodes=0;
  const expression=(n:any,depth=0):boolean=>{
    if(!n||++nodes>500||depth>40)return false;
    if(n.type==='Literal')return typeof n.value==='number'&&Number.isFinite(n.value);
    if(n.type==='Identifier')return parameters.has(n.name);
    if(n.type==='ParenthesizedExpression')return expression(n.expression,depth+1);
    if(n.type==='UnaryExpression')return n.prefix===true&&['+','-','!'].includes(n.operator)&&expression(n.argument,depth+1);
    if(n.type==='BinaryExpression'||n.type==='LogicalExpression')return operators.has(n.operator)&&expression(n.left,depth+1)&&expression(n.right,depth+1);
    if(n.type==='ConditionalExpression')return expression(n.test,depth+1)&&expression(n.consequent,depth+1)&&expression(n.alternate,depth+1);
    if(n.type==='CallExpression')return !n.optional&&n.callee?.type==='MemberExpression'&&!n.callee.computed&&!n.callee.optional&&n.callee.object?.type==='Identifier'&&n.callee.object.name==='Math'&&n.callee.property?.type==='Identifier'&&['min','max'].includes(n.callee.property.name)&&Array.isArray(n.arguments)&&n.arguments.length>0&&n.arguments.length<=16&&n.arguments.every((a:any)=>expression(a,depth+1));
    return false;
  };
  if(!expression(statement.argument))throw new Error('expression_capability_not_allowed');
  return { kind: 'clamp-expression-v1', accepted: true, sourceSha256: hash(source), nodes };
}

/** Runs only the adopted pure-function contract. Candidate code cannot write,
 * spawn, network or change the parent-side expected values/checker. */
export async function testClamp(workspace: string, directory: string, node: string) {
  if (process.platform !== 'darwin') throw new Error('repair_test_requires_macos_seatbelt');
  await privateDirectory(directory, true);
  const source = (await regular(join(workspace, 'clamp.mjs'))).toString();
  try { save(join(directory, 'source-validation.json'), validateClampExpression(source)); }
  catch (e) {
    const failure = e instanceof Error ? e.message : 'invalid_expression_source';
    save(join(directory, 'source-validation.json'), { accepted: false, failure, sourceSha256: hash(source) });
    const result = { kind: 'fixed-clamp-contract-v1', passed: false, failure, exit: { code: null, signal: null }, candidateExecuted: false, candidateTreeSha256: treeHash(await tree(workspace)) };
    save(join(directory, 'result.json'), result); return result;
  }
  node = await realpath(node);
  if (!/^[A-Za-z0-9_./ -]+$/.test(node + workspace)) throw new Error('unsupported_sandbox_path');
  const quote = JSON.stringify;
  const profile = `(version 1)(allow default)(deny file-write*)(deny network*)(deny signal)(deny process-fork)(deny process-exec (require-not (literal ${quote(node)})))\n(deny file-read-data (require-all (subpath "/Users") (require-not (subpath ${quote(workspace)})) (require-not (subpath ${quote(dirname(dirname(node)))}))))`;
  await writeFile(join(directory, 'sandbox.sb'), profile, { mode: 0o600 });
  const cases = [[5, 0, 10], [-4, 0, 10], [14, 0, 10], [0, 0, 10], [10, 0, 10], [0.25, 0, 1], [-3, -5, -1], [-9, -5, -1], [4, 2, 2], [7, -10, 20], [3.5, 3, 4], [1e6, -100, 100]];
  const code = `import {clamp} from './clamp.mjs';const cases=${JSON.stringify(cases)};process.stdout.write(JSON.stringify({values:cases.map(x=>clamp(...x))})+'\\n');`;
  const args = ['-f', join(directory, 'sandbox.sb'), node, '--permission', '--allow-fs-read=' + workspace, '--input-type=module', '-e', code];
  save(join(directory, 'launch.json'), { command: '/usr/bin/sandbox-exec', args, cwd: workspace, kind: 'fixed-clamp-contract-v1', status: 'launch_registered' });
  const child = spawn('/usr/bin/sandbox-exec', args, { cwd: workspace, env: safeEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  save(join(directory, 'process.json'), { pid: child.pid });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure: string | null = null;
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already ended */ } } };
  const timer = setTimeout(() => { failure = 'test_timeout'; kill(); }, 5000);
  child.stdout.on('data', b => { stdout = Buffer.concat([stdout, b]); if (stdout.length > 1024 * 1024) { failure = 'test_output_limit'; kill(); } });
  child.stderr.on('data', b => { stderr = Buffer.concat([stderr, b]); if (stderr.length > 1024 * 1024) { failure = 'test_output_limit'; kill(); } });
  child.on('error', () => { failure = 'test_spawn_error'; });
  const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); save(join(directory, 'exit.json'), exit);
  await writeFile(join(directory, 'stdout.txt'), stdout, { mode: 0o600 }); await writeFile(join(directory, 'stderr.txt'), stderr, { mode: 0o600 });
  let observed: unknown; try { observed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(stdout)); } catch { failure ??= 'test_result_not_json'; }
  const expected = { values: cases.map(([x, low, high]) => Math.min(high!, Math.max(low!, x!))) };
  const passed = failure === null && exit.code === 0 && exit.signal === null && JSON.stringify(observed) === JSON.stringify(expected);
  const result = { kind: 'fixed-clamp-contract-v1', passed, cases, expected, observed, failure, exit, stdoutSha256: hash(stdout), stderrSha256: hash(stderr), candidateTreeSha256: treeHash(await tree(workspace)) };
  save(join(directory, 'result.json'), result); return result;
}

export class RepairTools {
  phase: 'read' | 'write' | 'closed' = 'read';
  private serial = 0;
  private handoffSerial = 0;
  private expectedHead: string;
  constructor(readonly workspace: string, readonly operation: string, readonly grant: Grant, readonly lease: Lease, readonly node: string, private expected: Tree, initialHead = grant.H, private projectTest?: (directory: string) => Promise<unknown>, private externalGate?: (effect?: () => void) => void,private refreshExternal?:()=>Promise<void>) { this.expectedHead = initialHead; }
  adoptCommittedHead(head: string) { this.expectedHead = head; }
  async check() {
    await this.refreshExternal?.();
    this.externalGate?.();
    if (this.phase === 'closed' || await exists(join(this.operation, 'revoked.json'))) throw new Error('repair_revoked_or_closed');
    if (JSON.stringify(JSON.parse((await regular(join(this.workspace, '.git', 'tongxu-writer.json'))).toString())) !== JSON.stringify(this.lease)) throw new Error('writer_lease_changed');
    if (await git(this.workspace, ['rev-parse', 'HEAD']) !== this.expectedHead) throw new Error('candidate_changed_during_operation');
    const project = this.grant.profile === 'project-v1';
    if (await git(this.workspace, ['rev-parse', project ? 'refs/heads/project-base' : 'refs/heads/fixture-base']) !== this.grant.H || await git(this.workspace, ['branch', '--show-current']) !== (project ? 'repair-project' : 'repair-fixture')) throw new Error('candidate_base_or_branch_changed');
    const current = await tree(this.workspace, project);
    if (treeHash(current) !== treeHash(this.expected)) throw new Error('workspace_changed_outside_registered_tool');
    await checkRepairIndex(this.workspace,this.operation,this.grant.allowedPaths,current);return current;
  }
  async handoff(sessionId: string) {
    await this.check(); if (!this.grant.allowRepair) throw new Error('repair_not_authorized');
    await writeFile(join(this.operation, 'handoff-' + this.lease.generation + '-' + (++this.handoffSerial) + '.json'), JSON.stringify({ from: 'trusted-preparer', to: sessionId, sessionContinuity: 'same_fact_verifier_session', grant: this.grant, lease: this.lease, verifiedTreeSha256: treeHash(this.expected), backgroundCommands: 'none-active-in-managed-workspace' }), { flag: 'wx', mode: 0o600 }); this.phase = 'write';
  }
  async call(p: { tool: string; arguments: any; callId: string }) {
    const current = await this.check();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(p.callId)) throw new Error('invalid_tool_call_id');
    const calls = join(this.operation, 'calls'); await mkdir(calls, { recursive: true, mode: 0o700 });
    const path = join(calls, p.callId + '.json');
    if (await exists(path)) {
      const prior = JSON.parse((await regular(path)).toString());
      if (JSON.stringify(prior.request) !== JSON.stringify(p) || !prior.response || prior.afterTreeSha256 !== treeHash(current)) throw new Error('duplicate_tool_call_not_reconciled'); return prior.response;
    }
    if (++this.serial > 30) throw new Error('tool_call_budget_exceeded');
    const a = p.arguments;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('invalid_tool_arguments');
    let output: unknown;
    if (p.tool === 'tongxu_read_file') {
      if (Object.keys(a).join() !== 'path' || !Object.hasOwn(current, a.path) || this.grant.profile && !this.grant.materialPaths?.includes(a.path)) throw new Error('read_path_outside_material'); output = current[a.path];
    } else if (p.tool === 'tongxu_replace_file') {
      if (this.phase !== 'write' || !this.grant.allowRepair || Object.keys(a).sort().join() !== 'expectedSha256,path,text' || !this.grant.allowedPaths.includes(a.path) || typeof a.text !== 'string' || Buffer.byteLength(a.text) > 256 * 1024 || a.expectedSha256 !== current[a.path]?.sha256) throw new Error('write_outside_grant_or_stale_input');
      const target = join(this.workspace, a.path), after = Buffer.from(a.text), before = readFileSync(target), temporary = join(calls, p.callId + '.pending');
      const receipt = { request: p, beforeSha256: hash(before), afterSha256: hash(after), beforeText: before.toString(), afterText: a.text, ...(current[a.path]!.executable !== undefined ? { beforeExecutable: current[a.path]!.executable, afterExecutable: current[a.path]!.executable } : {}), status: 'write_registered' };
      save(path, receipt); writeFileSync(temporary, after, { flag: 'wx', mode: lstatSync(target).mode & 0o777 });
      // No await between the last revocation/identity check and atomic replace.
      if (readFileSync(join(this.workspace, '.git', 'tongxu-writer.json'), 'utf8') !== JSON.stringify(this.lease) || lstatSync(target).nlink !== 1 || hash(readFileSync(target)) !== receipt.beforeSha256) throw new Error('write_boundary_changed');
      try { readFileSync(join(this.operation, 'revoked.json')); throw new Error('repair_revoked'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      // The queue extension serializes a stop control with this single atomic
      // replace in the original database transaction, not a check-then-await.
      if (this.externalGate) this.externalGate(() => renameSync(temporary, target)); else renameSync(temporary, target);
      this.expected[a.path] = { ...current[a.path], sha256: hash(after), bytes: after.length, text: a.text }; output = { path: a.path, beforeSha256: receipt.beforeSha256, afterSha256: hash(after) };
      const response = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] };
      save(path, { ...receipt, status: 'applied', response, afterTreeSha256: treeHash(this.expected) }); return response;
    } else if (p.tool === 'tongxu_run_tests') {
      if (Object.keys(a).length) throw new Error('test_arguments_not_allowed');
      await mkdir(join(this.operation, 'tests'), { recursive: true, mode: 0o700 });
      const directory = join(this.operation, 'tests', 'tool-' + p.callId);
      output = this.grant.profile === 'project-v1' ? await this.projectTest!(directory) : await testClamp(this.workspace, directory, this.node);
    } else throw new Error('unregistered_repair_tool');
    const response = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] };
    save(path, { request: p, response, afterTreeSha256: treeHash(this.expected) }); return response;
  }
}

export const repairToolSpecs = [
  { type: 'function', name: 'tongxu_read_file', description: 'Read a supplied source file and its current hash in the managed task workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { type: 'function', name: 'tongxu_replace_file', description: 'Replace exactly one authorized source file after handoff, with optimistic hash checking. No other path or permission is available.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, expectedSha256: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'expectedSha256', 'text'], additionalProperties: false } },
  { type: 'function', name: 'tongxu_run_tests', description: 'Run the fixed trusted pure-function contract outside the writable source; no command argument is accepted.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];
export async function localCandidate(workspace: string, base: string, project = false): Promise<Candidate> { return { kind: 'local-git', repository: project ? 'local/project-repair' : 'local/clamp-fixture', pr: null, H: await git(workspace, ['rev-parse', 'HEAD']), B: base, target: project ? 'project-base' : 'fixture-base' }; }

export const projectRepairToolSpecs = repairToolSpecs.map(t => t.name === 'tongxu_run_tests' ? { ...t, description: 'Run the registered project tests in a separate isolated candidate copy. No command argument is accepted.' } : t);
