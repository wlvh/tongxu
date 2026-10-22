import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import {regular,exists,tree,treeHash,safeEnv,type Tree} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {shaPattern,validBranchRef} from './contract.js';

type Entry={path:string;mode:string;object:string;stage:number};
export type ManagedWorkspaceObservation={
  schemaVersion:1;kind:'tongxu-managed-workspace-observation';workspace:string;H:string;branch:string;
  marker:{sha256:string;bytes:Buffer};index:{sha256:string;bytes:Buffer};writerLease:{sha256:string;bytes:Buffer}|null;
  files:Tree;treeSha256:string;fileTextEncoding:'utf8-bom-preserved';headEntries:Entry[];indexEntries:Entry[];gitBlobs:Record<string,{sha256:string;bytes:number;text:string}>;stagedPaths:string[];workingPaths:string[];untrackedPaths:string[];unmergedPaths:string[];
  observedAt:string;commands:Array<{argv:string[];stdout:Buffer}>;writerEndedProven:false;writePermissionGranted:false;
};
const exec=promisify(execFile),issued=new WeakMap<object,string>(),blobId=(s:string)=>{const b=Buffer.from(s);return createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');};
const digest=(v:ManagedWorkspaceObservation)=>hash(canonical({...v,marker:{sha256:v.marker.sha256,actual:hash(v.marker.bytes)},index:{sha256:v.index.sha256,actual:hash(v.index.bytes)},writerLease:v.writerLease?{sha256:v.writerLease.sha256,actual:hash(v.writerLease.bytes)}:null,commands:v.commands.map(c=>({argv:c.argv,stdout:hash(c.stdout)}))}));
const unchanged=(a:Buffer|null,b:Buffer|null)=>a===null?b===null:b!==null&&a.equals(b);

/** Read the exact managed checkout and index without status, checkout,
 * filters, hooks, cleanup or writes. This is evidence only: the controller
 * must separately prove original execution ended and obtain new authority. */
export async function observeManagedWorkspace(workspace:string):Promise<ManagedWorkspaceObservation>{
  if(await realpath(workspace)!==workspace)throw new Error('handoff_workspace_not_canonical');
  const gitDir=join(workspace,'.git'),st=await lstat(gitDir);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(gitDir)!==gitDir)throw new Error('handoff_managed_git_directory_required');
  if(await exists(join(gitDir,'index.lock')))throw new Error('handoff_index_writer_active_or_unknown');
  const markerPath=join(gitDir,'tongxu-managed.json'),indexPath=join(gitDir,'index'),leasePath=join(gitDir,'tongxu-writer.json'),marker=await regular(markerPath),m=JSON.parse(marker.toString());
  if(m.kind!=='owned-project-workspace'||m.executionRoot!==dirname(workspace)||m.preparerSourceWritesFinished!==true||!shaPattern.test(m.initialH)||typeof m.initialTreeSha256!=='string'||!/^[a-f0-9]{64}$/.test(m.initialTreeSha256))throw new Error('handoff_original_managed_marker_required');
  const optionalLease=async()=>await exists(leasePath)?regular(leasePath):null,index=await regular(indexPath,8*1024*1024),writerLease=await optionalLease(),commands:ManagedWorkspaceObservation['commands']=[];
  const git=async(args:string[])=>{const argv=['--literal-pathspecs','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',workspace,...args],r=await exec('/usr/bin/git',argv,{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},encoding:'buffer',timeout:15000,maxBuffer:8*1024*1024});commands.push({argv,stdout:r.stdout});return new TextDecoder('utf8',{fatal:true}).decode(r.stdout);};
  const H=(await git(['rev-parse','--verify','HEAD'])).trim(),ref=(await git(['symbolic-ref','--quiet','HEAD'])).trim(),branch=ref.startsWith('refs/heads/')?ref.slice(11):'';
  if(!shaPattern.test(H)||!validBranchRef(branch))throw new Error('handoff_exact_head_branch_required');
  const headRaw=await git(['ls-tree','-r','-z',H]),indexRaw=await git(['ls-files','--stage','-z']),headEntries:Entry[]=[],indexEntries:Entry[]=[];
  for(const row of headRaw.split('\0').filter(Boolean)){const x=/^(100644|100755) blob ([a-f0-9]{40})\t([A-Za-z0-9_.\/-]+)$/.exec(row);if(!x)throw new Error('handoff_head_file_type_unsupported');headEntries.push({mode:x[1]!,object:x[2]!,path:x[3]!,stage:0});}
  for(const row of indexRaw.split('\0').filter(Boolean)){const x=/^(100644|100755) ([a-f0-9]{40}) ([0-3])\t([A-Za-z0-9_.\/-]+)$/.exec(row);if(!x)throw new Error('handoff_index_file_type_unsupported');indexEntries.push({mode:x[1]!,object:x[2]!,stage:Number(x[3]),path:x[4]!});}
  const readFiles=async()=>{const files=await tree(workspace,true);for(const [path,f] of Object.entries(files)){const b=await regular(join(workspace,path),256*1024);if(hash(b)!==f.sha256||b.length!==f.bytes)throw new Error('handoff_file_changed_during_observation');f.text=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(b);}return files;};
  const files=await readFiles(),treeSha256=treeHash(files),headMap=new Map(headEntries.map(e=>[e.path,e])),indexMap=new Map(indexEntries.filter(e=>e.stage===0).map(e=>[e.path,e]));
  const stagedPaths=[...new Set([...headMap.keys(),...indexEntries.map(e=>e.path)])].filter(p=>indexEntries.some(e=>e.path===p&&e.stage!==0)||canonical(headMap.get(p)??null)!==canonical(indexMap.get(p)??null)).sort(),unmergedPaths=[...new Set(indexEntries.filter(e=>e.stage!==0).map(e=>e.path))].sort();
  const workingPaths=[...new Set([...indexMap.keys(),...Object.keys(files)])].filter(p=>{const f=files[p],e=indexMap.get(p);return !f||!e||blobId(f.text)!==e.object||!!(f.executable!&0o100)!==(e.mode==='100755');}).sort(),untrackedPaths=Object.keys(files).filter(p=>!indexEntries.some(e=>e.path===p)).sort();
  // Save the actual staged objects, not just the index's object IDs. The
  // archive remains sufficient even if the original repository is removed.
  // cat-file bypasses working-tree filters, textconv and hooks.
  const gitBlobs:ManagedWorkspaceObservation['gitBlobs']=Object.create(null);let total=0;
  for(const object of new Set([...headEntries,...indexEntries].map(e=>e.object))){
    await git(['cat-file','blob',object]);const bytes=commands.at(-1)!.stdout;
    const text=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes);
    if(bytes.length>256*1024||(total+=bytes.length)>16*1024*1024||blobId(text)!==object)throw new Error('handoff_git_blob_invalid_or_limit');
    gitBlobs[object]={sha256:hash(bytes),bytes:bytes.length,text};
  }
  if(await exists(join(gitDir,'index.lock'))||H!==(await git(['rev-parse','--verify','HEAD'])).trim()||ref!==(await git(['symbolic-ref','--quiet','HEAD'])).trim()||indexRaw!==await git(['ls-files','--stage','-z'])||!marker.equals(await regular(markerPath))||!index.equals(await regular(indexPath,8*1024*1024))||!unchanged(writerLease,await optionalLease())||treeSha256!==treeHash(await readFiles()))throw new Error('handoff_workspace_changed_during_observation');
  const value:ManagedWorkspaceObservation={schemaVersion:1,kind:'tongxu-managed-workspace-observation',workspace,H,branch,marker:{sha256:hash(marker),bytes:marker},index:{sha256:hash(index),bytes:index},writerLease:writerLease?{sha256:hash(writerLease),bytes:writerLease}:null,files,treeSha256,fileTextEncoding:'utf8-bom-preserved',headEntries,indexEntries,gitBlobs,stagedPaths,workingPaths,untrackedPaths,unmergedPaths,commands,observedAt:new Date().toISOString(),writerEndedProven:false,writePermissionGranted:false};issued.set(value,digest(value));return value;
}
export function requireManagedWorkspaceObservation(value:ManagedWorkspaceObservation){const expected=issued.get(value);if(expected)try{if(expected===digest(value))return value;}catch{/* Mutated capture bytes remain untrusted. */}throw new Error('actual_managed_workspace_observation_required');}
export const managedWorkspaceStateSha256=(v:ManagedWorkspaceObservation)=>hash(canonical({workspace:v.workspace,H:v.H,branch:v.branch,marker:v.marker.sha256,index:v.index.sha256,lease:v.writerLease?.sha256??null,files:v.files,fileTextEncoding:v.fileTextEncoding,headEntries:v.headEntries,indexEntries:v.indexEntries}));
