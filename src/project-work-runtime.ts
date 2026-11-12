import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular,exists,git,mutateGit,safeEnv} from './repair-workspace.js';
import {parseAuthorityProfile,ownerDecisionText,type AuthorityProfile,type OwnerProposal} from './authority-contract.js';
import {readOwnerSource} from './authority-source.js';
import {QueueStore} from './queue-store.js';
import {selectGhExecutable,assertGhExecutableUnchanged} from './gh-executable.js';
import {fixedGit,type FixedRepository} from './project-work-preparation.js';
import type {ProjectChatScope} from './project-chat.js';
const exec=promisify(execFile);
export async function writeFixed(path:string,bytes:string){
  if(await exists(path)){if(!(await regular(path,2*1024*1024)).equals(Buffer.from(bytes)))throw new Error('project_work_fixed_input_changed');}
  else await writeFile(path,bytes,{flag:'wx',mode:0o600});
}
export async function verifyRepositoryPath(scope:ProjectChatScope,path:string){
  if(!path.startsWith('/'))throw new Error('project_work_repository_path_invalid');
  let selected:string,remote:string;try{selected=await realpath(resolve(path));if(!(await lstat(selected)).isDirectory()||await git(selected,['rev-parse','--show-toplevel'])!==selected)throw new Error();remote=await git(selected,['config','--get','remote.origin.url']);}catch{throw new Error('project_work_repository_path_invalid');}
  const match=/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote);
  if(!match||match[1]!.toLowerCase()!==scope.repository.fullName.toLowerCase())throw new Error('project_work_repository_identity_mismatch');return selected;
}
/** Acquire only the selected immutable commit when absent. No checkout,
 * branch, index, FETCH_HEAD or remote configuration is changed. */
export async function ensureWorkCommit(source:FixedRepository,profile:AuthorityProfile){
  const present=async()=>{try{return (await fixedGit(source,['rev-parse','--verify',source.H+'^{commit}'])).toString().trim()===source.H;}catch{return false;}};
  if(await present())return;
  if(!/^[\w.-]+\/[\w.-]+$/.test(source.repository)||!/^[a-f0-9]{40}$/.test(source.H))throw new Error('project_work_repository_commit_required');
  const binary=await selectGhExecutable(profile.ghExecutable,profile.ghSha256);assertGhExecutableUnchanged(binary);
  const quoted="'"+binary.realpath.replaceAll("'","'\\''")+"'";
  try{await exec('/usr/bin/git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.helper=!'+quoted+' auth git-credential','-C',source.path,'fetch','--no-write-fetch-head','--no-tags','--no-recurse-submodules','https://github.com/'+source.repository+'.git',source.H],{env:{...safeEnv,GIT_TERMINAL_PROMPT:'0'},timeout:120000,maxBuffer:65536});}catch{throw new Error('project_work_source_fetch_failed');}
  if(!await present())throw new Error('project_work_repository_commit_required');
}
/** Publish one exact Owner decision after an explicit page action. A durable
 * intent with a lost response can only look up its original comment. */
export async function applyWorkOwnerProposal(store:string,profile:AuthorityProfile,proposal:OwnerProposal,id:string,directory:string){
  await mkdir(directory,{recursive:true,mode:0o700});let prepared:any;
  const q=await QueueStore.open(store);try{prepared=q.authority().prepare(id,Buffer.from(canonical(proposal)));}finally{q.close();}
  const sha=prepared.proposalSha256 as string,body=ownerDecisionText(sha),intent=join(directory,sha+'-send-intent.json'),sent=join(directory,sha+'-sent.json');
  const binary=await selectGhExecutable(profile.ghExecutable,profile.ghSha256);
  const gh=async(args:string[])=>{assertGhExecutableUnchanged(binary);const r=await exec(binary.realpath,args,{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});return JSON.parse(r.stdout);};
  let comment:number|null=null;
  if(await exists(sent))comment=JSON.parse((await regular(sent)).toString()).id;
  else{
    for(let page=1;page<=10;page++){
      const rows=await gh(['api','--hostname','github.com','--method','GET',`repos/${profile.repository}/issues/${profile.issue}/comments?per_page=100&page=${page}`]);
      if(!Array.isArray(rows))throw new Error('project_work_owner_comments_invalid');
      for(const row of rows)if(row.body?.trim()===body.trim()&&row.user?.id===profile.ownerId){if(comment!==null&&comment!==row.id)throw new Error('project_work_owner_source_ambiguous');comment=row.id;}
      if(rows.length<100)break;if(page===10)throw new Error('project_work_owner_comments_incomplete');
    }
    if(comment===null){
      if(await exists(intent))throw new Error('project_work_owner_source_unknown');
      const viewer=await gh(['api','--hostname','github.com','user']);
      if(viewer.id!==profile.ownerId||viewer.id!==profile.executorId||!profile.sharedAccountApproval)throw new Error('project_work_owner_identity_not_configured');
      await writeFixed(join(directory,sha+'-body.json'),canonical({body}));
      await writeFixed(intent,canonical({at:new Date().toISOString(),proposalSha256:sha,repository:profile.repository,issue:profile.issue,bodySha256:hash(body),automaticResend:false}));
      const row=await gh(['api','--hostname','github.com','--method','POST',`repos/${profile.repository}/issues/${profile.issue}/comments`,'--input',join(directory,sha+'-body.json')]);
      if(!Number.isSafeInteger(row.id)||row.body?.trim()!==body.trim())throw new Error('project_work_owner_source_unknown');comment=row.id;
    }
    await writeFixed(sent,canonical({id:comment,proposalSha256:sha}));
  }
  const observation=await readOwnerSource(profile,sha,comment!,join(directory,'observation-'+sha+'-'+Date.now()));
  const result=await QueueStore.open(store);try{result.authority().apply(sha,observation);}finally{result.close();}
  return sha;
}
/** Import a complete committed result; never copy edited files into the user's
 * checkout. Both the repository ref and the separate result checkout are read
 * back, including when the previous call lost its final receipt. */
export async function receiveWorkResult(o:{repositoryPath:string;executionWorkspace:string;H:string;previous:string|null;branch:string;workspace:string;evidence:string}){
  await mkdir(o.evidence,{recursive:true,mode:0o700});let index=0;
  const mutate=(directory:string,args:string[])=>mutateGit(directory,args,join(o.evidence,'git-'+Date.now()+'-'+(++index)));
  const ref='refs/heads/'+o.branch,trees=await git(o.repositoryPath,['worktree','list','--porcelain']);
  if(trees.split('\n').some(line=>line==='branch '+ref))throw new Error('project_work_result_branch_in_use');
  const refs=await git(o.repositoryPath,['for-each-ref','--format=%(objectname)',ref]);
  if(refs&&refs!==o.H&&refs!==o.previous)throw new Error('project_work_result_branch_changed');
  if(await exists(o.workspace)){
    if(await realpath(o.workspace)!==o.workspace||!(await lstat(join(o.workspace,'.git'))).isDirectory())throw new Error('project_work_result_workspace_changed');
    const H=await git(o.workspace,['rev-parse','HEAD']);
    if(H!==o.H&&H!==o.previous||await git(o.workspace,['status','--porcelain','--untracked-files=all','--ignored']))throw new Error('project_work_result_workspace_changed');
    if(refs===o.H&&H===o.H){
      const tree=await git(o.executionWorkspace,['rev-parse',o.H+'^{tree}']);if(await git(o.workspace,['rev-parse','HEAD^{tree}'])!==tree)throw new Error('project_work_result_readback_failed');
      return {H:o.H,branch:o.branch,workspace:o.workspace,tree,received:true,alreadyReceived:true};
    }
  }
  await mutate(o.repositoryPath,['fetch','--no-write-fetch-head','--no-tags','--no-recurse-submodules',o.executionWorkspace,o.H]);
  if(!refs||refs!==o.H)await mutate(o.repositoryPath,['update-ref',ref,o.H,refs||'0'.repeat(40)]);
  if(!await exists(o.workspace)){
    await mkdir(o.workspace,{mode:0o700});await mutate(o.workspace,['init','--template=']);
    await mutate(o.workspace,['fetch','--no-tags','--no-recurse-submodules',o.executionWorkspace,o.H]);
    await mutate(o.workspace,['checkout','-b',o.branch,'FETCH_HEAD']);
  }else if(await git(o.workspace,['rev-parse','HEAD'])!==o.H){
    await mutate(o.workspace,['fetch','--no-tags','--no-recurse-submodules',o.executionWorkspace,o.H]);
    await mutate(o.workspace,['merge','--ff-only',o.H]);
  }
  const tree=await git(o.executionWorkspace,['rev-parse',o.H+'^{tree}']);
  if(await git(o.repositoryPath,['rev-parse',ref])!==o.H||await git(o.workspace,['rev-parse','HEAD'])!==o.H||await git(o.workspace,['rev-parse','HEAD^{tree}'])!==tree||await git(o.workspace,['status','--porcelain','--untracked-files=all','--ignored']))throw new Error('project_work_result_readback_failed');
  return {H:o.H,branch:o.branch,workspace:o.workspace,tree,received:true};
}
export function workAuthorityProfile(template:Omit<AuthorityProfile,'repository'|'issue'|'kind'|'schemaVersion'>,scope:ProjectChatScope,issue:number){
  return parseAuthorityProfile(Buffer.from(canonical({...template,schemaVersion:1,kind:'tongxu-owner-source-profile',repository:scope.repository.fullName,issue})));
}
