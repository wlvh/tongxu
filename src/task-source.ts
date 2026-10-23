import {execFile,execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {promisify} from 'node:util';
import {lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular,safeEnv} from './repair-workspace.js';
import {developmentTaskId,parseDevelopmentTask,type DevelopmentTask} from './task-contract.js';
import {shaPattern} from './contract.js';

const exec=promisify(execFile),issued=new WeakMap<object,string>();
type FileRecord={path:string;sha256:string|null;bytes:number;missing:boolean;text:string|null};
export type TaskObservation={schemaVersion:1|2;kind:'tongxu-task-workspace-observation';taskId:string;definitionSha256:string;workspace:string;head:string;branch:string;base:string;target:string;mergeBase:string;tree:string;observedAt:string;files:FileRecord[];gitStatus?:string;diff?:string;headFiles?:FileRecord[];indexObserved?:false;materialSha256:string;selectedPathsOnly:true;unobservedWorkspaceState:true;testsExecuted:false;businessCorrectness:'unverified';commands:Array<{argv:string[];stdout:string;exitCode:0}>};
const identity=(v:TaskObservation)=>hash(canonical({taskId:v.taskId,definitionSha256:v.definitionSha256,head:v.head,branch:v.branch,base:v.base,target:v.target,mergeBase:v.mergeBase,tree:v.tree,files:v.files,...(v.schemaVersion===1?{gitStatus:v.gitStatus,diff:v.diff}:{headFiles:v.headFiles,indexObserved:v.indexObserved})}));
async function files(p:DevelopmentTask){const rows:FileRecord[]=[];let total=0;for(const path of p.paths){const absolute=join(p.workspace,path);try{let selected=p.workspace;for(const part of path.split('/')){selected=join(selected,part);if((await lstat(selected)).isSymbolicLink())throw new Error('task_selected_symlink');}const b=await regular(absolute,256*1024);total+=b.length;if(total>384*1024)throw new Error('task_selected_material_limit');rows.push({path,sha256:hash(b),bytes:b.length,missing:false,text:new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(b)});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;rows.push({path,sha256:null,bytes:0,missing:true,text:null});}}return rows;}
/** Read only the registered workspace and paths. Raw Git observations are
 * retained; no checkout, hook, filter, network fetch or test is executed. */
export async function observeTaskWorkspace(p:DevelopmentTask):Promise<TaskObservation>{
  p=parseDevelopmentTask(Buffer.from(canonical(p)));
  if(await realpath(p.workspace)!==p.workspace||!(await lstat(p.workspace)).isDirectory())throw new Error('task_workspace_not_canonical');
  const commands:TaskObservation['commands']=[];
  const git=async(args:string[])=>{const argv=['--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-C',p.workspace,...args],r=await exec('/usr/bin/git',argv,{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},timeout:15000,maxBuffer:2*1024*1024,encoding:'buffer'});const stdout=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(r.stdout);commands.push({argv,stdout,exitCode:0});return stdout;};
  const root=(await git(['rev-parse','--show-toplevel'])).trim();if(root!==p.workspace)throw new Error('task_workspace_root_changed');
  const head=(await git(['rev-parse','--verify','HEAD^{commit}'])).trim(),base=(await git(['rev-parse','--verify',p.base+'^{commit}'])).trim();if(!shaPattern.test(head)||base!==p.base)throw new Error('task_git_object_missing');
  const branch=(await git(['rev-parse','--abbrev-ref','HEAD'])).trim();
  const mergeBase=(await git(['merge-base',base,head])).trim(),tree=(await git(['rev-parse',head+'^{tree}'])).trim();if(!shaPattern.test(mergeBase)||!shaPattern.test(tree))throw new Error('task_git_binding_invalid');
  // Git status/diff may run filter.*.clean/process from repository config.
  // Read immutable Git objects and raw regular files instead. The index is
  // explicitly not observed; equality here means raw bytes versus HEAD.
  const headFiles:FileRecord[]=[];
  for(const path of p.paths){
    const listing=await git(['ls-tree','-z',head,'--',path]);
    if(!listing){headFiles.push({path,sha256:null,bytes:0,missing:true,text:null});continue;}
    const match=/^([0-7]{6}) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listing);
    if(!match||!['100644','100755'].includes(match[1]!)||match[3]!==path)throw new Error('task_head_path_not_regular_file');
    const text=await git(['cat-file','blob',match[2]!]),bytes=Buffer.byteLength(text);if(bytes>256*1024)throw new Error('task_head_file_limit');headFiles.push({path,sha256:hash(text),bytes,missing:false,text});
  }
  const material=await files(p),again=await files(p);
  if((await git(['rev-parse','--abbrev-ref','HEAD'])).trim()!==branch||(await git(['rev-parse','--verify','HEAD^{commit}'])).trim()!==head||canonical(material)!==canonical(again))throw new Error('task_workspace_changed_during_observation');
  const value:TaskObservation={schemaVersion:2,kind:'tongxu-task-workspace-observation',taskId:developmentTaskId(p),definitionSha256:hash(canonical(p)),workspace:p.workspace,head,branch,base,target:p.target,mergeBase,tree,observedAt:new Date().toISOString(),files:material,headFiles,indexObserved:false,materialSha256:'',selectedPathsOnly:true,unobservedWorkspaceState:true,testsExecuted:false,businessCorrectness:'unverified',commands};
  value.materialSha256=identity(value);if(Buffer.byteLength(canonical(value))>512*1024)throw new Error('task_observation_size_limit');issued.set(value,hash(canonical(value)));return value;
}
export function inspectTaskObservation(v:TaskObservation,p:DevelopmentTask){
  if(v.kind!=='tongxu-task-workspace-observation'||![1,2].includes(v.schemaVersion)||v.taskId!==developmentTaskId(p)||v.definitionSha256!==hash(canonical(p))||v.workspace!==p.workspace||v.base!==p.base||v.target!==p.target||typeof v.branch!=='string'||!v.branch||v.branch.length>256||!shaPattern.test(v.head)||!shaPattern.test(v.tree)||!shaPattern.test(v.mergeBase)||v.materialSha256!==identity(v)||v.testsExecuted!==false||v.selectedPathsOnly!==true||v.unobservedWorkspaceState!==true||v.businessCorrectness!=='unverified'||canonical(v.files.map(x=>x.path))!==canonical(p.paths)||!Number.isFinite(Date.parse(v.observedAt)))throw new Error('task_original_observation_changed');
  if(v.schemaVersion===2&&(v.indexObserved!==false||v.gitStatus!==undefined||v.diff!==undefined||!Array.isArray(v.headFiles)||canonical(v.headFiles.map(x=>x.path))!==canonical(p.paths)))throw new Error('task_raw_source_comparison_changed');
  for(const f of [...v.files,...(v.headFiles??[])])if(f.missing?f.sha256!==null||f.bytes!==0||f.text!==null:typeof f.text!=='string'||hash(f.text)!==f.sha256||Buffer.byteLength(f.text)!==f.bytes)throw new Error('task_original_file_changed');
  return v;
}
export function requireTaskObservation(v:TaskObservation,p:DevelopmentTask){if(issued.get(v)!==hash(canonical(v)))throw new Error('actual_task_workspace_observation_required');return inspectTaskObservation(v,p);}

export function taskGitReadSync(p:DevelopmentTask,args:string[]){return new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(execFileSync('/usr/bin/git',['--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-C',p.workspace,...args],{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},timeout:3000,maxBuffer:2*1024*1024}));}
/** Last synchronous read before input submission. It checks only the issued
 * observation's declared paths and Git identity, never hooks or filters. A
 * prior observation before a slow resource/Owner request is insufficient. */
export function assertTaskObservationCurrentSync(p:DevelopmentTask,o:TaskObservation){
  requireTaskObservation(o,p);
  if(realpathSync(p.workspace)!==p.workspace||taskGitReadSync(p,['rev-parse','--verify','HEAD^{commit}']).trim()!==o.head||taskGitReadSync(p,['rev-parse','--abbrev-ref','HEAD']).trim()!==o.branch)throw new Error('message_task_source_changed_before_send');
  for(const expected of o.files){let bytes:Buffer|null=null;try{let path=p.workspace;for(const part of expected.path.split('/')){path=join(path,part);if(lstatSync(path).isSymbolicLink())throw new Error('message_task_source_changed_before_send');}const st=lstatSync(path);if(!st.isFile()||st.nlink!==1||st.size>256*1024||realpathSync(path)!==path)throw new Error('message_task_source_changed_before_send');bytes=readFileSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(bytes===null?!expected.missing:expected.missing||bytes.length!==expected.bytes||hash(bytes)!==expected.sha256)throw new Error('message_task_source_changed_before_send');
  }
  if(taskGitReadSync(p,['rev-parse','--verify','HEAD^{commit}']).trim()!==o.head)throw new Error('message_task_source_changed_before_send');
}
