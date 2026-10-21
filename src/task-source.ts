import {execFile} from 'node:child_process';
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
export type TaskObservation={schemaVersion:1;kind:'tongxu-task-workspace-observation';taskId:string;definitionSha256:string;workspace:string;head:string;branch:string;base:string;target:string;mergeBase:string;tree:string;observedAt:string;files:FileRecord[];gitStatus:string;diff:string;materialSha256:string;selectedPathsOnly:true;unobservedWorkspaceState:true;testsExecuted:false;businessCorrectness:'unverified';commands:Array<{argv:string[];stdout:string;exitCode:0}>};
const identity=(v:TaskObservation)=>hash(canonical({taskId:v.taskId,definitionSha256:v.definitionSha256,head:v.head,branch:v.branch,base:v.base,target:v.target,mergeBase:v.mergeBase,tree:v.tree,files:v.files,gitStatus:v.gitStatus,diff:v.diff}));
async function files(p:DevelopmentTask){const rows:FileRecord[]=[];let total=0;for(const path of p.paths){const absolute=join(p.workspace,path);try{const b=await regular(absolute,256*1024);total+=b.length;if(total>384*1024)throw new Error('task_selected_material_limit');rows.push({path,sha256:hash(b),bytes:b.length,missing:false,text:new TextDecoder('utf8',{fatal:true}).decode(b)});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;rows.push({path,sha256:null,bytes:0,missing:true,text:null});}}return rows;}
/** Read only the registered workspace and paths. Raw Git observations are
 * retained; no checkout, hook, filter, network fetch or test is executed. */
export async function observeTaskWorkspace(p:DevelopmentTask):Promise<TaskObservation>{
  p=parseDevelopmentTask(Buffer.from(canonical(p)));
  if(await realpath(p.workspace)!==p.workspace||!(await lstat(p.workspace)).isDirectory())throw new Error('task_workspace_not_canonical');
  const commands:TaskObservation['commands']=[];
  const git=async(args:string[])=>{const argv=['--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-C',p.workspace,...args],r=await exec('/usr/bin/git',argv,{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1'},timeout:15000,maxBuffer:2*1024*1024});commands.push({argv,stdout:r.stdout,exitCode:0});return r.stdout;};
  const root=(await git(['rev-parse','--show-toplevel'])).trim();if(root!==p.workspace)throw new Error('task_workspace_root_changed');
  const head=(await git(['rev-parse','--verify','HEAD^{commit}'])).trim(),base=(await git(['rev-parse','--verify',p.base+'^{commit}'])).trim();if(!shaPattern.test(head)||base!==p.base)throw new Error('task_git_object_missing');
  const branch=(await git(['rev-parse','--abbrev-ref','HEAD'])).trim();
  const mergeBase=(await git(['merge-base',base,head])).trim(),tree=(await git(['rev-parse',head+'^{tree}'])).trim();if(!shaPattern.test(mergeBase)||!shaPattern.test(tree))throw new Error('task_git_binding_invalid');
  const statusArgs=['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all','--',...p.paths],diffArgs=['diff','--binary','--no-ext-diff','--no-textconv','--ignore-submodules=all','HEAD','--',...p.paths];
  const gitStatus=await git(statusArgs),diff=await git(diffArgs),material=await files(p),again=await files(p);
  if((await git(['rev-parse','--abbrev-ref','HEAD'])).trim()!==branch||(await git(['rev-parse','--verify','HEAD^{commit}'])).trim()!==head||await git(statusArgs)!==gitStatus||await git(diffArgs)!==diff||canonical(material)!==canonical(again))throw new Error('task_workspace_changed_during_observation');
  const value:TaskObservation={schemaVersion:1,kind:'tongxu-task-workspace-observation',taskId:developmentTaskId(p),definitionSha256:hash(canonical(p)),workspace:p.workspace,head,branch,base,target:p.target,mergeBase,tree,observedAt:new Date().toISOString(),files:material,gitStatus,diff,materialSha256:'',selectedPathsOnly:true,unobservedWorkspaceState:true,testsExecuted:false,businessCorrectness:'unverified',commands};
  value.materialSha256=identity(value);if(Buffer.byteLength(canonical(value))>512*1024)throw new Error('task_observation_size_limit');issued.set(value,hash(canonical(value)));return value;
}
export function inspectTaskObservation(v:TaskObservation,p:DevelopmentTask){
  if(v.kind!=='tongxu-task-workspace-observation'||v.schemaVersion!==1||v.taskId!==developmentTaskId(p)||v.definitionSha256!==hash(canonical(p))||v.workspace!==p.workspace||v.base!==p.base||v.target!==p.target||typeof v.branch!=='string'||!v.branch||v.branch.length>256||!shaPattern.test(v.head)||!shaPattern.test(v.tree)||!shaPattern.test(v.mergeBase)||v.materialSha256!==identity(v)||v.testsExecuted!==false||v.selectedPathsOnly!==true||v.unobservedWorkspaceState!==true||v.businessCorrectness!=='unverified'||canonical(v.files.map(x=>x.path))!==canonical(p.paths)||!Number.isFinite(Date.parse(v.observedAt)))throw new Error('task_original_observation_changed');
  for(const f of v.files)if(f.missing?f.sha256!==null||f.bytes!==0||f.text!==null:typeof f.text!=='string'||hash(f.text)!==f.sha256||Buffer.byteLength(f.text)!==f.bytes)throw new Error('task_original_file_changed');
  return v;
}
export function requireTaskObservation(v:TaskObservation,p:DevelopmentTask){if(issued.get(v)!==hash(canonical(v)))throw new Error('actual_task_workspace_observation_required');return inspectTaskObservation(v,p);}
