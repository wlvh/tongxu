import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {readFileSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists,processState} from './repair-workspace.js';
import {executable,LiveProcess,checkCapture} from './live-process.js';
import {codexDiscoveryArgs} from './ai-catalog.js';
import {checkConfig} from './live-codex.js';
import {assertExternalExecutable,capturedExternalExecutable} from './external-executable.js';
import {assertWorkEnvironmentEnded} from './project-work-environment.js';
import type {DockerConfig} from './docker-sandbox.js';
import {DatabaseSync} from 'node:sqlite';
import type {RepairConfig} from './repair.js';
export type CurrentCheckRef={path:string;sha256:string};
type Row=Record<string,any>;
const read=(path:string)=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>32*1024*1024||realpathSync(path)!==path)throw new Error('project_work_current_check_changed');return readFileSync(path);};
const frames=(path:string)=>read(path).toString().trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
function predecessor(value:Row){
 const p=value.binding.predecessor;if(!p)return;const q=new DatabaseSync(join(p.store,'queue.sqlite'),{readOnly:true});
 try{
  const key='issue-implementation:'+hash(canonical([p.source,p.requestId])),events=q.prepare('SELECT kind,data FROM events WHERE object=? ORDER BY id').all(key).map((x:any)=>({kind:x.kind,data:JSON.parse(x.data).value}));
  const registered=events.find(x=>x.kind==='issue_implementation_registered')?.data,fixed=events.find(x=>x.kind==='issue_implementation_prepared')?.data,terminal=events.find(x=>x.kind==='issue_implementation_terminal')?.data;
  const blob=(sha:string)=>{const r=q.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('project_work_restart_predecessor_changed');return JSON.parse(b.toString());};
  if(registered?.requestSha256!==p.requestSha256||fixed?.plan.sha256!==p.planSha256||fixed?.operation!==p.operation||!terminal||events.some(x=>['issue_implementation_stopped','issue_implementation_validation_correction'].includes(x.kind)))throw new Error('project_work_restart_predecessor_changed');
  const request=blob(registered.requestSha256),result=blob(terminal.resultSha256),auth=[...Object.values(fixed.plan.authorization),request.adoptedScope.adoption];
  if(request.workspaceRequest.authorization.maxRepairRounds!==1||result.status!=='failed'||result.H1!==null||result.failureClosure?.failureSha256!==p.failureSha256||fixed.plan.resourceRequests.length||q.prepare('SELECT 1 FROM claims WHERE operation=?').get(p.operation)||q.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get()||q.prepare("SELECT 1 FROM controls WHERE scope=? AND kind IN ('implementation','investment') AND stopped=1").get(blob(request.adoptedScope.adoption).proposal.scopeId))throw new Error('project_work_restart_predecessor_changed');
  for(const row of q.prepare("SELECT data FROM events WHERE kind='authority_revoked'").all() as Row[])if(auth.includes(JSON.parse(row.data).decision))throw new Error('owner_decision_revoked');
 }finally{q.close();}
}
function metadata(directory:string,live=true){
 const sent=frames(join(directory,'stdin.ndjson')),received=frames(join(directory,'stdout.ndjson')),methods=['initialize','initialized','account/read','config/read','account/rateLimits/read'];
 if(canonical(sent.map(x=>x.method))!==canonical(methods))throw new Error('project_work_billing_metadata_invalid');
 const replies=sent.filter(x=>x.id!==undefined).map(s=>{const r=received.filter(x=>x.id===s.id&&!x.method);if(r.length!==1||r[0].error||!r[0].result)throw new Error('project_work_billing_metadata_invalid');return r[0].result;});
 if(received.some(x=>x.method&& !['account/updated','account/rateLimits/updated','remoteControl/status/changed'].includes(x.method)))throw new Error('project_work_billing_metadata_invalid');
 if(replies[1]?.account?.type!=='chatgpt'||replies[3]?.ordinaryUsageAllowed!==true)throw new Error('ordinary_usage_unavailable');checkConfig(replies[2]?.config);
 const status=JSON.parse(read(join(directory,'capture-status.json')).toString()),exit=JSON.parse(read(join(directory,'exit.json')).toString()),launch=JSON.parse(read(join(directory,'launch.json')).toString());
 if(status.status!=='complete'||status.failure!==null||exit.code!==0||exit.signal!==null||!Number.isFinite(Date.parse(exit.at))||Date.parse(exit.at)<Date.parse(launch.startedAt))throw new Error('project_work_billing_metadata_invalid');
 for(const name of ['stdin.ndjson','stdout.ndjson','stderr.txt'])if(hash(read(join(directory,name)))!==status.files?.[name])throw new Error('project_work_current_check_changed');
 const identity=JSON.parse(read(join(directory,'executable.json')).toString());if(!capturedExternalExecutable(identity.externalSelection,identity.path))throw new Error('project_work_billing_metadata_invalid');if(live)assertExternalExecutable(identity.externalSelection);
 return {observedAt:exit.at as string,identity};
}
/** Explicit recheck may replace only a positively ended read-only attempt. */
export async function assertCurrentAttemptEnded(directory:string,verification:DockerConfig){
 const native=join(directory,'billing');if(await exists(join(native,'launch.json'))){
  if(!await exists(join(native,'process.json'))||processState(JSON.parse((await regular(join(native,'process.json'))).toString()).pid)!=='ended')throw new Error('project_work_current_check_incomplete');
  const methods=frames(join(native,'stdin.ndjson')).map(x=>x.method);if(methods.some(x=>!['initialize','initialized','account/read','config/read','account/rateLimits/read'].includes(x)))throw new Error('project_work_current_check_incomplete');
 }
 if(await exists(join(directory,'environment')))await assertWorkEnvironmentEnded(join(directory,'environment'),verification);
}
/** Official metadata only. No thread, prompt, turn or project execution. */
export async function captureWorkBilling(config:RepairConfig,directory:string,check:()=>void){
 for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])if(process.env[key])throw new Error('api_billing_override_present');
 if(await exists(directory)){const prior=metadata(directory);if(prior.identity.path!==config.codexExecutable)throw new Error('project_work_billing_metadata_invalid');check();return prior;}
 await privateDirectory(directory,true);const identity=await executable(config.codexExecutable,{tool:'codex',methods:['initialize','account/read','config/read','account/rateLimits/read']},config.executionKind??'native_capture');
 await writeFile(join(directory,'executable.json'),canonical(identity),{flag:'wx',mode:0o600});const cwd=join(directory,'workspace');await mkdir(cwd,{mode:0o700});check();
 const rpc=new LiveProcess(directory,config.codexExecutable,codexDiscoveryArgs(config.disabledMcpServers),cwd,process.env,undefined,identity.externalSelection);
 try{await rpc.request('initialize',{clientInfo:{name:'tongxu-project-work-current-billing',version:'0.1.0'},capabilities:{experimentalApi:true}});rpc.send({method:'initialized',params:{}});
  await rpc.request('account/read',{refreshToken:false});await rpc.request('config/read',{includeLayers:false,cwd});await rpc.request('account/rateLimits/read',{});
 }finally{await rpc.close();}
 await checkCapture(directory);check();return metadata(directory);
}
/** Seal current observations, keeping every historical source untouched. */
export async function sealWorkCurrent(path:string,binding:Row,observedAt:string,duration:number,directories:string[],extraFiles:string[]=[]){
 const files:Record<string,string>={};let bytes=0;
 const seal=async(path:string)=>{if(files[path])return;const b=await regular(path,32*1024*1024);if((bytes+=b.length)>256*1024*1024||Object.keys(files).length>=4096)throw new Error('project_work_current_check_limit');files[path]=hash(b);};
 const walk=async(directory:string)=>{for(const e of await readdir(directory,{withFileTypes:true})){const p=join(directory,e.name);if(e.isSymbolicLink())throw new Error('project_work_current_check_changed');if(e.isDirectory())await walk(p);else await seal(p);}};
 for(const directory of directories)await walk(directory);
 for(const path of extraFiles)await seal(path);
 const value={schemaVersion:1,kind:'tongxu-project-work-current-check',binding,observedAt,expiresAt:new Date(Date.parse(observedAt)+duration).toISOString(),duration,files};
 const raw=canonical(value);await writeFile(path,raw,{flag:'wx',mode:0o600});const ref={path,sha256:hash(raw)};assertWorkCurrent(ref,binding);return ref;
}
/** Synchronous last-effect guard; freshness never slides on reentry. */
export function assertWorkCurrent(ref:CurrentCheckRef,binding?:Row,historical=false){
 const raw=read(ref.path);if(hash(raw)!==ref.sha256)throw new Error('project_work_current_check_changed');const value=JSON.parse(raw.toString());
 if(value.schemaVersion!==1||value.kind!=='tongxu-project-work-current-check'||binding&&canonical(value.binding)!==canonical(binding)||!Number.isSafeInteger(value.duration)||value.duration<1000||value.duration>86400000||!Number.isFinite(Date.parse(value.observedAt))||Date.parse(value.observedAt)>Date.now()+60000||Date.parse(value.expiresAt)!==Date.parse(value.observedAt)+value.duration||!historical&&Date.parse(value.expiresAt)<=Date.now())throw new Error('project_work_current_check_expired');
 for(const [path,sha] of Object.entries(value.files) as Array<[string,string]>)if(hash(read(path))!==sha)throw new Error('project_work_current_check_changed');
 if(value.binding.queueDirectory&&existsSync(join(value.binding.queueDirectory,'queue.sqlite'))){const q=new DatabaseSync(join(value.binding.queueDirectory,'queue.sqlite'),{readOnly:true});try{if(q.prepare("SELECT 1 FROM meta WHERE key LIKE 'resource-ledger:%'").get())throw new Error('implementation_validation_empty_budget_required');}finally{q.close();}}
 predecessor(value);
 const observed=metadata(value.binding.metadataDirectory,!historical);if(observed.observedAt!==value.observedAt)throw new Error('project_work_billing_metadata_invalid');
 return value as Row;
}
