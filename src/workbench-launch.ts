import {readdir,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
// The trusted launch bootstrap uses only Node built-ins. Importing application
// helpers here would execute their module bodies before checking their bytes.
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const exactKeys=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const isAuthorityDigest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const safeRelativePath=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<512&&!/[\\\x00-\x1f]/.test(v)&&v.split('/').every(x=>x&&x!=='.'&&x!=='..');
const canonical=(v:any):string=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));
// Keep this check in the trusted bootstrap: it uses only Node built-ins and
// cannot import an unchecked application helper before checking its bytes.
export const minimumNodeVersion='24.0.0';
export function supportedNodeVersion(version:unknown){
  if(typeof version!=='string'||version.length>128)return false;
  const match=/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9._-]+)?$/.exec(version);
  return !!match&&match.slice(1,4).every(n=>Number.isSafeInteger(Number(n)))&&Number(match[1])>=24;
}
export async function requireNodeRuntime(){
  if(!supportedNodeVersion(process.version))throw new Error('node_minimum_version_24_0_0_required');
  let db:import('node:sqlite').DatabaseSync|undefined;
  try{
    const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runtime_probe(value INTEGER NOT NULL) STRICT; BEGIN IMMEDIATE; INSERT INTO runtime_probe VALUES (1)');
    if(db.isTransaction!==true||db.prepare('SELECT value FROM runtime_probe').get()?.value!==1)throw new Error('capability');
    db.exec('ROLLBACK');if(Boolean(db.isTransaction)||db.prepare('SELECT count(*) AS n FROM runtime_probe').get()?.n!==0)throw new Error('capability');
  }catch{throw new Error('node_sqlite_capability_unavailable');}finally{db?.close();}
  return {nodeVersion:process.version,nodeExecutable:process.execPath,minimumNodeVersion};
}
async function regular(path:string,limit:number){
  if(await realpath(path)!==path)throw new Error('workbench_runtime_link_not_supported');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.size>limit)throw new Error('workbench_runtime_file_invalid');const bytes=await file.readFile(),after=await file.stat();if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('workbench_runtime_file_changed_during_read');return bytes;}finally{await file.close();}
}
const exec=promisify(execFile);
export type WorkbenchRuntime={schemaVersion:1;kind:'tongxu-current-workbench';sourceDirectory:string;sourceHead:string;nodeVersion:string;plan:{path:string;sha256:string};files:Array<{path:string;sha256:string}>};
export type WorkbenchRuntimeIdentity={sourceHead:string;nodeVersion:string;nodeExecutable:string;minimumNodeVersion:string;buildNodeVersion:string;planSha256:string;runtimeFilesSha256:string;verifiedAt:string};
async function runtimeFiles(root:string){
  const result:string[]=[];async function visit(relative:string){for(const entry of await readdir(join(root,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;if(entry.isSymbolicLink())throw new Error('workbench_runtime_link_not_supported');if(entry.isDirectory())await visit(name);else if(entry.isFile()&&name.endsWith('.js'))result.push(name);}}
  await visit('dist/src');result.push('package.json','web/workbench/index.html','web/workbench/app.js','web/workbench/app.css','web/workbench/favicon.svg');return result.sort();
}
/** One explicit local composition, not an updater or a parallel store. */
export async function inspectWorkbenchRuntime(raw:Buffer){
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw)) as WorkbenchRuntime;
  if(raw.length>256*1024||!exactKeys(p,['schemaVersion','kind','sourceDirectory','sourceHead','nodeVersion','plan','files'])||p.schemaVersion!==1||p.kind!=='tongxu-current-workbench'||typeof p.sourceDirectory!=='string'||!isAbsolute(p.sourceDirectory)||resolve(p.sourceDirectory)!==p.sourceDirectory||!(/^[a-f0-9]{40}$/).test(p.sourceHead)||typeof p.nodeVersion!=='string'||!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(p.nodeVersion)||!exactKeys(p.plan,['path','sha256'])||typeof p.plan.path!=='string'||!isAbsolute(p.plan.path)||resolve(p.plan.path)!==p.plan.path||!isAuthorityDigest(p.plan.sha256)||!Array.isArray(p.files)||p.files.length>1024||p.files.some(f=>!exactKeys(f,['path','sha256'])||!safeRelativePath(f.path)||!isAuthorityDigest(f.sha256)))throw new Error('workbench_runtime_manifest_invalid');
  const node=await requireNodeRuntime();
  if(await realpath(p.sourceDirectory)!==p.sourceDirectory)throw new Error('workbench_runtime_directory_changed');
  const files=await runtimeFiles(p.sourceDirectory);if(canonical(p.files.map(f=>f.path).sort())!==canonical(files))throw new Error('workbench_runtime_file_set_changed');
  for(const f of p.files)if(hash(await regular(join(p.sourceDirectory,f.path),4*1024*1024))!==f.sha256)throw new Error('workbench_runtime_build_changed');
  const plan=await regular(p.plan.path,256*1024);if(hash(plan)!==p.plan.sha256)throw new Error('workbench_runtime_plan_changed');
  const options={timeout:5000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}};
  const head=await exec('/usr/bin/git',['-C',p.sourceDirectory,'rev-parse','--verify','HEAD'],options),status=await exec('/usr/bin/git',['-C',p.sourceDirectory,'status','--porcelain','--untracked-files=normal','--','src','web','package.json','package-lock.json','tsconfig.json'],options);
  if(head.stdout.trim()!==p.sourceHead||status.stdout.trim())throw new Error('workbench_runtime_source_changed');
  const identity:WorkbenchRuntimeIdentity={sourceHead:p.sourceHead,...node,buildNodeVersion:p.nodeVersion,planSha256:p.plan.sha256,runtimeFilesSha256:hash(canonical(p.files.slice().sort((a,b)=>a.path.localeCompare(b.path)))),verifiedAt:new Date().toISOString()};return {manifest:p,identity};
}
/** Installation helper: freeze one already built and tested composition. This
 * does not build, approve or activate it, and writes no files itself. */
export async function prepareWorkbenchRuntime(sourceDirectory:string,planPath:string):Promise<WorkbenchRuntime>{
  const head=await exec('/usr/bin/git',['-C',sourceDirectory,'rev-parse','--verify','HEAD'],{timeout:5000});
  const files=await Promise.all((await runtimeFiles(sourceDirectory)).map(async path=>({path,sha256:hash(await regular(join(sourceDirectory,path),4*1024*1024))})));
  const p:WorkbenchRuntime={schemaVersion:1,kind:'tongxu-current-workbench',sourceDirectory,sourceHead:head.stdout.trim(),nodeVersion:process.version,plan:{path:planPath,sha256:hash(await regular(planPath,256*1024))},files};
  await inspectWorkbenchRuntime(Buffer.from(canonical(p)));return p;
}
/** Install a normal Mac entry without freezing a dependency executable. The
 * source bootstrap and manifest remain fixed application artifacts. */
export async function renderWorkbenchLauncher(runtimePath:string){
  const raw=await regular(runtimePath,256*1024),{manifest}=await inspectWorkbenchRuntime(raw);
  const entry=join(manifest.sourceDirectory,'dist/src/workbench-launch.js'),entryHash=hash(await regular(entry,4*1024*1024));
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
  // Check and load the application in ONE Node process. No second exec of a
  // possibly retargeted entry is needed and no Node fingerprint is pinned.
  // Keep the outer syntax readable by older Node so it can reject with 78.
  const bootstrap=`var major=parseInt(process.versions.node,10);if(!(major>=24))process.exit(78);try{var Sqlite=require('node:sqlite').DatabaseSync;var db=new Sqlite(':memory:');db.exec('CREATE TABLE probe(value INTEGER) STRICT; BEGIN IMMEDIATE; INSERT INTO probe VALUES (1)');if(db.isTransaction!==true||db.prepare('SELECT value FROM probe').get().value!==1)throw Error('sqlite');db.exec('ROLLBACK');if(db.isTransaction!==false)throw Error('sqlite');db.close();}catch(error){process.exit(78);}require('node:fs').writeFileSync(process.env.TONGXU_LAUNCH_MARKER,'application_may_load',{flag:'wx',mode:384});delete process.env.TONGXU_LAUNCH_MARKER;var entry=process.argv[1];if(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(entry)).digest('hex')!==${JSON.stringify(entryHash)}){console.error('workbench_bootstrap_changed');process.exit(1);}Function('url','return import(url)')(require('node:url').pathToFileURL(entry).href).catch(function(error){console.error(error.message);process.exitCode=1;});`;
  return `#!/bin/zsh
set -eu
if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != "--no-open" ]]; }; then
  print -u2 -- "用法：双击打开同序；--no-open 仅用于本机诊断。"
  exit 2
fi
tx_check_file() {
  local tx_actual
  tx_actual="$(/usr/bin/shasum -a 256 -- "$1")"
  if [[ "\${tx_actual%% *}" != "$2" ]]; then
    print -u2 -- "同序未启动：应用文件或配置已改变。原队列保留，请核对当前运行记录。"
    return 1
  fi
}
tx_entry=${quote(entry)}
tx_runtime=${quote(runtimePath)}
tx_check_file "$tx_entry" ${quote(entryHash)}
tx_check_file "$tx_runtime" ${quote(hash(raw))}
typeset -aU tx_candidates
tx_candidates=()
if [[ -n "\${TONGXU_NODE:-}" ]]; then
  tx_candidates=("$TONGXU_NODE")
else
  for tx_directory in "\${path[@]}"; do
    tx_candidates+=("\${tx_directory:-.}/node")
  done
  tx_candidates+=(/opt/homebrew/bin/node /usr/local/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")
fi
tx_args=(--runtime "$tx_runtime")
if (( $# == 0 )); then tx_args+=(--open); fi
tx_launch_state="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/tongxu-launch.XXXXXXXX")"
trap '/bin/rm -f -- "$tx_launch_state/entered"; /bin/rmdir -- "$tx_launch_state" 2>/dev/null || true' EXIT
for tx_candidate in "\${tx_candidates[@]}"; do
  if [[ -n "$tx_candidate" && -x "$tx_candidate" ]]; then
    if TONGXU_LAUNCH_MARKER="$tx_launch_state/entered" "$tx_candidate" -e ${quote(bootstrap)} "$tx_entry" "\${tx_args[@]}"; then
      tx_status=0
    else
      tx_status=$?
    fi
    # A broken shim can exit without running our bootstrap. Once the bootstrap
    # may load application code, any outcome stops; it cannot try another Node.
    if [[ -e "$tx_launch_state/entered" ]]; then exit "$tx_status"; fi
  fi
done
print -u2 -- "同序需要 Node.js ${minimumNodeVersion} 或更新版本，并具备 node:sqlite 事务能力。请安装到 PATH，或用 TONGXU_NODE 指定现有程序。"
exit 1
`;
}
export async function launchWorkbench(runtimePath:string,openBrowser=false){
  const {manifest,identity}=await inspectWorkbenchRuntime(await regular(runtimePath,256*1024));
  if(manifest.sourceDirectory!==fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,''))throw new Error('workbench_runtime_wrong_launcher');
  // Each cold launch imports this exact composition. The plan is checked again
  // against the frozen digest before any task controls are loaded.
  const {startWorkbench}=await import(pathToFileURL(join(manifest.sourceDirectory,'dist/src/workbench.js')).href),app=await startWorkbench(manifest.plan.path,identity);
  try{if(openBrowser){if(process.platform!=='darwin')throw new Error('workbench_browser_open_platform_not_supported');await exec('/usr/bin/open',[app.url],{timeout:5000});}return {...app,identity};}catch(e){await app.close();throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const args=process.argv.slice(2);if(args[0]!=='--runtime'||!args[1]||args.length!==2&&!(args.length===3&&args[2]==='--open'))throw new Error('workbench_launch_command_invalid');
    const app=await launchWorkbench(args[1],args[2]==='--open');process.stdout.write(JSON.stringify({status:'listening',mode:app.mode,url:app.url,pid:process.pid,runtime:app.identity,modelCallsAtStart:0})+'\n');
    let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void app.close().then(()=>process.exit(0));};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'workbench_launch_failed',modelStartedByLaunch:false})+'\n');process.exitCode=1;}
}
