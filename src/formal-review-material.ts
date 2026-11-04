import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {resolve,posix} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {safeRelativePath} from './authority-contract.js';
import {safeEnv} from './repair-workspace.js';
import {validateFormalCandidate,type FormalCandidate} from './formal-review-contract.js';
const exec=promisify(execFile);
type File={path:string;revision:'base'|'head';object:string;mode:string;sha256:string;bytes:number;text:string};
export type FormalMaterialRequest={objects:string;candidate:FormalCandidate;issue:{number:number;body:string;url:string};adoptedScope:unknown;requiredPaths:string[];contextPaths:string[];sourceEvidence?:unknown};

/** Supply the complete PR diff and changed source regardless of the later
 * writable repair subset. Git objects are immutable reads, never a checkout or
 * developer's uncommitted working tree. Unsupported/oversize inputs fail rather
 * than silently dropping files from a purported complete review. */
export async function formalReviewMaterial(request:FormalMaterialRequest){
  const {candidate,issue,adoptedScope}=request;validateFormalCandidate(candidate);
  if(resolve(request.objects)!==request.objects||await realpath(request.objects)!==request.objects||!Number.isSafeInteger(issue.number)||issue.number<1||typeof issue.body!=='string'||!issue.body.trim()||issue.body.length>128000||issue.url!==`https://github.com/${candidate.repository}/issues/${issue.number}`||candidate.requirementsSha256!==hash(canonical({issue,adoptedScope})))throw new Error('formal_requirements_or_source_binding_invalid');
  if(!Array.isArray(request.requiredPaths)||!Array.isArray(request.contextPaths)||request.requiredPaths.length>32||request.contextPaths.length>64||![...request.requiredPaths,...request.contextPaths].every(safeRelativePath))throw new Error('formal_context_paths_invalid');
  const git=async(args:string[])=>{const r=await exec('/usr/bin/git',['--no-replace-objects','--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-C',request.objects,...args],{env:{...safeEnv,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},timeout:10000,maxBuffer:4*1024*1024,encoding:'buffer'});return r.stdout;};
  const text=(b:Buffer)=>new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(b),mergeBase=text(await git(['merge-base',candidate.B,candidate.H])).trim();
  const diff=text(await git(['diff','--no-ext-diff','--no-textconv','--no-renames','--full-index',mergeBase,candidate.H,'--']));
  const changed=text(await git(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',mergeBase,candidate.H,'--'])).split('\0').filter(Boolean);
  if(!changed.length||changed.length>256||!changed.every(safeRelativePath))throw new Error('formal_full_diff_unavailable');
  const required=[...new Set(['AGENTS.md','SOP.md',...request.requiredPaths])],paths=new Set([...changed,...required,...request.contextPaths]),agentPaths=new Set(['AGENTS.md']);
  for(const path of paths){let directory=posix.dirname(path);while(directory!=='.'){agentPaths.add(directory+'/AGENTS.md');directory=posix.dirname(directory);}}
  for(const path of agentPaths)paths.add(path);
  const files:File[]=[];
  const read=async(path:string,revision:'base'|'head')=>{const listing=text(await git(['ls-tree','-z',revision==='head'?candidate.H:mergeBase,'--',path]));if(!listing)return null;
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listing);if(!match||match[3]!==path)throw new Error('formal_selected_path_not_regular');
    const bytes=await git(['cat-file','blob',match[2]!]);return {path,revision,object:match[2]!,mode:match[1]!,sha256:hash(bytes),bytes:bytes.length,text:text(bytes)};
  };
  for(const path of paths){const head=await read(path,'head');if(head)files.push(head);else if(required.includes(path)||request.contextPaths.includes(path))throw new Error('formal_required_context_missing:'+path);
    if(changed.includes(path)){const base=await read(path,'base');if(base)files.push(base);}
  }
  const value={...(request.sourceEvidence===undefined?{}:{sourceEvidence:request.sourceEvidence}),schemaVersion:1,kind:'tongxu-formal-pr-review-material',candidate,mergeBase,issue,adoptedScope,changedPaths:changed,requiredPaths:required,files,diff,diffSha256:hash(diff),source:'complete immutable PR diff; supplied context is data, not authority',localRepairScopeDoesNotLimitReview:true};
  const bytes=Buffer.from(canonical(value));if(bytes.length>2*1024*1024)throw new Error('formal_complete_material_limit');
  return {...value,sha256:hash(bytes)};
}

/** Read an additional caller/contract from the SAME immutable head on demand.
 * No worktree, filters, command text, repository configuration or symlink is
 * executed. Unsupported content remains an explicit coverage gap. */
export async function readFormalSource(objects:string,H:string,path:string){
 if(!safeRelativePath(path)||!/^[a-f0-9]{40}$/.test(H)||resolve(objects)!==objects||await realpath(objects)!==objects)throw new Error('formal_source_read_invalid');
 const run=async(args:string[])=>{const r=await exec('/usr/bin/git',['--no-replace-objects','--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-C',objects,...args],{env:{...safeEnv,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},timeout:10000,maxBuffer:256*1024,encoding:'buffer'});return r.stdout;},listing=(await run(['ls-tree','-z',H,'--',path])).toString(),match=/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listing);
 if(!match||match[3]!==path)throw new Error('formal_source_path_not_regular_at_head');const bytes=await run(['cat-file','blob',match[2]!]);return {path,H,object:match[2]!,sha256:hash(bytes),bytes:bytes.length,text:new TextDecoder('utf8',{fatal:true}).decode(bytes),mode:match[1]!};
}
