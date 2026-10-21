import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {safeEnv} from './repair-workspace.js';
import {parseDevelopmentTask,type DevelopmentTask} from './task-contract.js';
import {observeTaskWorkspace,requireTaskObservation,type TaskObservation} from './task-source.js';
const exec=promisify(execFile),issued=new WeakMap<object,string>();
type Entry={path:string;mode:string;object:string;stage?:number};
export type TaskLinkSource={schemaVersion:1;kind:'tongxu-task-candidate-source';observation:TaskObservation;headEntries:Entry[];indexEntries:Entry[];workModes:Array<{path:string;executable:boolean|null}>;selectedFilesOnly:true;wholeWorkspaceClean:false;observedAt:string;commands:Array<{argv:string[];stdout:string}>};

/** Compare the selected paths with HEAD and the actual index without asking
 * Git to examine worktree content or run its clean/process filters. */
export async function observeTaskLinkSource(input:DevelopmentTask):Promise<TaskLinkSource>{
  const p=parseDevelopmentTask(Buffer.from(canonical(input))),observation=await observeTaskWorkspace(p),commands:TaskLinkSource['commands']=[];
  const git=async(args:string[])=>{const argv=['--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',p.workspace,...args],r=await exec('/usr/bin/git',argv,{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},encoding:'buffer',timeout:15000,maxBuffer:1024*1024}),stdout=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(r.stdout);commands.push({argv,stdout});return stdout;};
  const headEntries:Entry[]=[],indexEntries:Entry[]=[];
  const indexArgs=['ls-files','--stage','-z','--',...p.paths],index=await git(indexArgs);
  for(const line of index.split('\0').filter(Boolean)){const m=/^([0-7]{6}) ([a-f0-9]{40}) ([0-3])\t(.+)$/.exec(line);if(!m||!p.paths.includes(m[4]!))throw new Error('task_link_index_not_exact');indexEntries.push({path:m[4]!,mode:m[1]!,object:m[2]!,stage:Number(m[3])});}
  for(const path of p.paths){const listing=await git(['ls-tree','-z',observation.head,'--',path]);if(!listing)continue;const m=/^([0-7]{6}) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listing);if(!m||m[3]!==path||!['100644','100755'].includes(m[1]!))throw new Error('task_link_head_not_regular');headEntries.push({path,mode:m[1]!,object:m[2]!});}
  const modes=async()=>{const values:TaskLinkSource['workModes']=[];for(const path of p.paths){try{const st=await lstat(join(p.workspace,path));if(!st.isFile()||st.isSymbolicLink())throw new Error('task_link_work_file_changed');values.push({path,executable:!!(st.mode&0o111)});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;values.push({path,executable:null});}}return values;};
  const workModes=await modes(),again=await observeTaskWorkspace(p);
  if(again.materialSha256!==observation.materialSha256||await git(indexArgs)!==index||canonical(await modes())!==canonical(workModes))throw new Error('task_link_source_changed_during_observation');
  const value:TaskLinkSource={schemaVersion:1,kind:'tongxu-task-candidate-source',observation:again,headEntries,indexEntries,workModes,selectedFilesOnly:true,wholeWorkspaceClean:false,observedAt:new Date().toISOString(),commands};issued.set(value,hash(canonical(value)));return value;
}
export function requireTaskLinkSource(v:TaskLinkSource,p:DevelopmentTask){
  if(issued.get(v)!==hash(canonical(v)))throw new Error('actual_task_candidate_source_required');requireTaskObservation(v.observation,p);return v;
}
export function taskLinkSourceMatches(v:TaskLinkSource){
  if(v.observation.schemaVersion!==2||v.observation.indexObserved!==false||!v.observation.headFiles)throw new Error('task_link_raw_observation_required');
  const current=v.observation.files,heads=v.observation.headFiles;
  if(current.some((f,i)=>canonical(f)!==canonical(heads[i])))throw new Error('task_link_uncommitted_selected_content');
  const sort=(v:Entry[])=>[...v].sort((a,b)=>a.path.localeCompare(b.path));
  if(v.indexEntries.some(e=>e.stage!==0)||canonical(sort(v.indexEntries.map(({stage,...e})=>e)))!==canonical(sort(v.headEntries)))throw new Error('task_link_staged_selected_changes');
  for(const file of current){const entry=v.headEntries.find(e=>e.path===file.path),mode=v.workModes.find(e=>e.path===file.path);if(!mode)throw new Error('task_link_selected_mode_changed');if(file.missing?entry!==undefined||mode.executable!==null:!entry||mode.executable!==(entry.mode==='100755'))throw new Error('task_link_selected_mode_changed');}
  return true;
}
export const taskLinkSourceIdentity=(s:TaskLinkSource)=>hash(canonical({material:s.observation.materialSha256,head:s.headEntries,index:s.indexEntries,modes:s.workModes}));
