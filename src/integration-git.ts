import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {canonical} from './comparison.js';

export const integrationGitEnv={PATH:'/usr/bin:/bin',LANG:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ATTR_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'',GIT_OPTIONAL_LOCKS:'0'};
export type GitStep={cwd:string;args:string[];stdin:Buffer;maxBytes?:number;artifacts?:string[];objectDirectory?:string};
const argv=(step:GitStep)=>['--no-replace-objects','--no-lazy-fetch','-c','core.alternateRefsCommand=/usr/bin/true','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-c','maintenance.auto=false','-c','gc.auto=0','-C',step.cwd,...step.args];
const plan=(step:GitStep)=>({command:'/usr/bin/git',args:argv(step),cwd:step.cwd,stdinSha256:hash(step.stdin),maxBytes:step.maxBytes??64*1024*1024,timeoutMs:30000,environment:{...integrationGitEnv,...(step.objectDirectory?{GIT_OBJECT_DIRECTORY:step.objectDirectory}:{})},artifacts:step.artifacts??[]});
const file=async(path:string,value:unknown)=>writeFile(path,canonical(value),{flag:'wx',mode:0o600});

/** A bounded fixed Git command with raw binary captures. Only the trusted
 * producer constructs args. No model or source report supplies a command. */
export async function captureIntegrationGit(directory:string,step:GitStep,gate:<T>(effect:()=>T)=>T,prepare?:()=>Promise<void>){
  if(step.stdin.length>64*1024*1024)throw new Error('integration_git_input_limit');await privateDirectory(directory,true);const launch=plan(step);await writeFile(join(directory,'stdin.bin'),step.stdin,{flag:'wx',mode:0o600});await file(join(directory,'launch.json'),launch);
  let spawned:ReturnType<typeof spawn>|undefined,gateError:string|null=null;try{await prepare?.();gate(()=>{spawned=spawn('/usr/bin/git',launch.args,{env:launch.environment,detached:true,stdio:['pipe','pipe','pipe']});return spawned;});}catch(e){if(!spawned){await file(join(directory,'not-started.json'),{reason:e instanceof Error?e.message:'integration_gate_refused',spawnInvoked:false});throw e;}gateError=e instanceof Error?e.message:'integration_gate_commit_failed';}if(!spawned)throw new Error('integration_git_not_started');const child=spawned;
  const out:Buffer[]=[],err:Buffer[]=[];let bytes=0,limited=false,spawnError:string|null=null;
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const collect=(list:Buffer[]) =>(b:Buffer)=>{bytes+=b.length;if(bytes>launch.maxBytes){limited=true;kill();return;}list.push(Buffer.from(b));};
  child.stdout!.on('data',collect(out));child.stderr!.on('data',collect(err));child.on('error',e=>{spawnError=e.message;});child.stdin!.on('error',()=>{});
  const returned=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  const processRecord=Buffer.from(canonical({pid:child.pid??null,processGroup:child.pid??null,observedAt:new Date().toISOString()}));
  try{writeFileSync(join(directory,'process.json'),processRecord,{flag:'wx',mode:0o600});}catch(e){kill();await returned;throw e;}
  const timer=setTimeout(()=>{limited=true;kill();},launch.timeoutMs);if(gateError)kill();else child.stdin!.end(step.stdin);const exit=await returned;clearTimeout(timer);
  const stdout=Buffer.concat(out),stderr=Buffer.concat(err);await writeFile(join(directory,'stdout.bin'),stdout,{flag:'wx',mode:0o600});await writeFile(join(directory,'stderr.bin'),stderr,{flag:'wx',mode:0o600});
  const artifacts=[];if(exit.code===0&&!limited&&!spawnError&&!gateError)for(const [i,path] of (step.artifacts??[]).entries()){const bytes=await regular(path,64*1024*1024);await writeFile(join(directory,'artifact-'+i+'.bin'),bytes,{flag:'wx',mode:0o600});artifacts.push({path,sha256:hash(bytes),bytes:bytes.length});}
  await file(join(directory,'exit.json'),{...exit,limited,spawnError,gateError,launchSha256:hash(canonical(launch)),processSha256:hash(processRecord),stdoutSha256:hash(stdout),stderrSha256:hash(stderr),artifacts,knownEnded:true,observedAt:new Date().toISOString()});return readIntegrationGit(directory,step);
}
export async function readIntegrationGit(directory:string,step:GitStep){
  const launch=await regular(join(directory,'launch.json')),input=await regular(join(directory,'stdin.bin'),64*1024*1024),process=await regular(join(directory,'process.json')),exitBytes=await regular(join(directory,'exit.json')),exit=JSON.parse(exitBytes.toString()),stdout=await regular(join(directory,'stdout.bin'),64*1024*1024),stderr=await regular(join(directory,'stderr.bin'),64*1024*1024);
  let processRecord:any;try{processRecord=JSON.parse(process.toString());}catch{throw new Error('integration_git_process_capture_changed');}
  if(!processRecord||Object.keys(processRecord).sort().join()!=='observedAt,pid,processGroup'||exit.processSha256!==hash(process)||!(processRecord.pid===null?processRecord.processGroup===null&&typeof exit.spawnError==='string'&&exit.spawnError.length>0:Number.isSafeInteger(processRecord.pid)&&processRecord.pid>0&&processRecord.processGroup===processRecord.pid)||typeof processRecord.observedAt!=='string'||!Number.isFinite(Date.parse(processRecord.observedAt))||typeof exit.observedAt!=='string'||!Number.isFinite(Date.parse(exit.observedAt))||Date.parse(processRecord.observedAt)>Date.parse(exit.observedAt))throw new Error('integration_git_process_capture_changed');
  if(canonical(JSON.parse(launch.toString()))!==canonical(plan(step))||!input.equals(step.stdin)||exit.launchSha256!==hash(launch)||exit.stdoutSha256!==hash(stdout)||exit.stderrSha256!==hash(stderr)||exit.knownEnded!==true||!(exit.code===null||Number.isInteger(exit.code))||!(exit.signal===null||typeof exit.signal==='string')||typeof exit.limited!=='boolean'||stdout.length+stderr.length>(step.maxBytes??64*1024*1024))throw new Error('integration_git_capture_changed');
  const successful=exit.code===0&&exit.signal===null&&!exit.limited&&!exit.spawnError&&!exit.gateError,originals:Record<string,Buffer>={ 'launch.json':launch,'stdin.bin':input,'process.json':process,'exit.json':exitBytes,'stdout.bin':stdout,'stderr.bin':stderr},artifacts:Buffer[]=[];
  if(successful){if(!Array.isArray(exit.artifacts)||exit.artifacts.length!==(step.artifacts??[]).length)throw new Error('integration_git_artifact_changed');for(const [i,path] of (step.artifacts??[]).entries()){const b=await regular(join(directory,'artifact-'+i+'.bin'),64*1024*1024),ref=exit.artifacts[i];if(ref.path!==path||ref.sha256!==hash(b)||ref.bytes!==b.length)throw new Error('integration_git_artifact_changed');originals['artifact-'+i+'.bin']=b;artifacts.push(b);}}
  return {exit,stdout,stderr,artifacts,originals,successful};
}
export async function readIntegrationGitRefusal(directory:string,step:GitStep){
  const launch=await regular(join(directory,'launch.json')),input=await regular(join(directory,'stdin.bin'),64*1024*1024),raw=await regular(join(directory,'not-started.json')),refusal=JSON.parse(raw.toString());
  if(canonical(JSON.parse(launch.toString()))!==canonical(plan(step))||!input.equals(step.stdin)||refusal.spawnInvoked!==false||typeof refusal.reason!=='string'||await exists(join(directory,'process.json'))||await exists(join(directory,'exit.json')))throw new Error('integration_git_refusal_unverified');
  return {reason:refusal.reason,originals:{'launch.json':launch,'stdin.bin':input,'not-started.json':raw}};
}
