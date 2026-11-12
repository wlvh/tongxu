import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdir,realpath,lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular,exists,git,mutateGit,safeEnv,processState} from './repair-workspace.js';
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
  try{await exec('/usr/bin/git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.helper=!'+quoted+' auth git-credential','-C',source.path,'fetch','--no-write-fetch-head','--no-tags','--no-recurse-submodules','https://github.com/'+source.repository+'.git',source.H],{env:{...safeEnv,HOME:homedir(),...(process.env.GH_CONFIG_DIR?{GH_CONFIG_DIR:process.env.GH_CONFIG_DIR}:{}),GIT_TERMINAL_PROMPT:'0'},timeout:120000,maxBuffer:65536});}catch{throw new Error('project_work_source_fetch_failed');}
  if(!await present())throw new Error('project_work_repository_commit_required');
}
/** Publish one exact Owner decision after an explicit page action. A durable
 * intent with a lost response can only look up its original comment. */
export async function applyWorkOwnerProposal(store:string,profile:AuthorityProfile,proposal:OwnerProposal,id:string,directory:string,beforePost:()=>void){
  await mkdir(directory,{recursive:true,mode:0o700});let prepared:any;
  const q=await QueueStore.open(store);try{prepared=q.authority().prepare(id,Buffer.from(canonical(proposal)));}finally{q.close();}
  const sha=prepared.proposalSha256 as string,body=ownerDecisionText(sha),intent=join(directory,sha+'-send-intent.json'),sent=join(directory,sha+'-sent.json');
  const binary=await selectGhExecutable(profile.ghExecutable,profile.ghSha256);
  const gh=async(args:string[])=>{assertGhExecutableUnchanged(binary);if(args.includes('POST'))beforePost();const r=await exec(binary.realpath,args,{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});return JSON.parse(r.stdout);};
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
  const intent=canonical(o),intentPath=join(o.evidence,'receipt-'+o.H+'.json');
  await writeFixed(intentPath,intent);
  const mutate=(directory:string,args:string[])=>mutateGit(directory,args,join(o.evidence,'git-'+Date.now()+'-'+(++index)));
  const ref='refs/heads/'+o.branch,trees=await git(o.repositoryPath,['worktree','list','--porcelain']);
  if(trees.split('\n').some(line=>line==='branch '+ref))throw new Error('project_work_result_branch_in_use');
  const refs=await git(o.repositoryPath,['for-each-ref','--format=%(objectname)',ref]);
  if(refs&&refs!==o.H&&refs!==o.previous)throw new Error('project_work_result_branch_changed');
  const ownership=join(o.evidence,'workspace-created.json'),initialGit=join(o.evidence,'workspace-initial-git.json');
  // Only this receipt's empty, self-created directory may have an unborn HEAD.
  // An unknown child or any external file/index/ref keeps the original refusal.
  const checkIncomplete=async(hasGit:boolean)=>{
    if((await regular(intentPath)).toString()!==intent)throw new Error('project_work_result_workspace_changed');
    if(!await exists(ownership))throw new Error('project_work_result_workspace_changed');
    const owner=JSON.parse((await regular(ownership)).toString()),st=await lstat(o.workspace);
    if(owner.workspace!==o.workspace||owner.dev!==st.dev||owner.ino!==st.ino)throw new Error('project_work_result_workspace_changed');
    for(const name of await readdir(o.evidence)){
      if(!/^git-/.test(name))continue;const directory=join(o.evidence,name),launchPath=join(directory,'launch.json');
      if(!await exists(launchPath)){if((await readdir(directory)).length)throw new Error('project_work_result_git_unknown');continue;}
      const launch=JSON.parse((await regular(launchPath)).toString());
      const allowed=launch.cwd===o.repositoryPath?[
        ['fetch','--no-write-fetch-head','--no-tags','--no-recurse-submodules',o.executionWorkspace,o.H],
        ['update-ref',ref,o.H,o.previous??'0'.repeat(40)]
      ]:launch.cwd===o.workspace?[
        ['init','--template=','--initial-branch='+o.branch],['fetch','--no-tags','--no-recurse-submodules',o.executionWorkspace,o.H],['checkout','-b',o.branch,o.H],['merge','--ff-only',o.H]
      ]:[];
      if(launch.command!=='/usr/bin/git'||launch.status!=='launch_registered'||!allowed.some(args=>canonical(launch.args)===canonical(['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',launch.cwd,...args])))throw new Error('project_work_result_git_unknown');
      if(await exists(join(directory,'exit.json'))){const exit=JSON.parse((await regular(join(directory,'exit.json'))).toString());if(!Number.isInteger(exit.code)&&typeof exit.signal!=='string')throw new Error('project_work_result_git_unknown');}
      else if(await exists(join(directory,'blocked-before-spawn.json'))){if(JSON.parse((await regular(join(directory,'blocked-before-spawn.json'))).toString()).newProcessStarted!==false)throw new Error('project_work_result_git_unknown');}
      else if(!await exists(join(directory,'process.json'))||processState(JSON.parse((await regular(join(directory,'process.json'))).toString()).pid)!=='ended')throw new Error('project_work_result_git_unknown');
    }
    const names=await readdir(o.workspace);
    if(names.length!==(hasGit?1:0)||hasGit&&names[0]!=='.git')throw new Error('project_work_result_workspace_changed');
    if(hasGit){
      if(!await exists(initialGit))throw new Error('project_work_result_workspace_changed');
      const original=JSON.parse((await regular(initialGit)).toString()),st=await lstat(join(o.workspace,'.git'));
      if(original.dev!==st.dev||original.ino!==st.ino||original.configSha256!==hash(await regular(join(o.workspace,'.git','config'))))throw new Error('project_work_result_workspace_changed');
      if((await readdir(join(o.workspace,'.git'))).some(n=>n.endsWith('.lock'))||await git(o.workspace,['symbolic-ref','HEAD'])!==ref||await git(o.workspace,['for-each-ref'])||await git(o.workspace,['ls-files','--stage'])||await git(o.workspace,['rev-parse','--show-toplevel'])!==o.workspace)throw new Error('project_work_result_workspace_changed');
    }
  };
  let incomplete=false,initialize=false;
  if(await exists(o.workspace)){
    if(await realpath(o.workspace)!==o.workspace||!(await lstat(o.workspace)).isDirectory())throw new Error('project_work_result_workspace_changed');
    if(!await exists(join(o.workspace,'.git'))){await checkIncomplete(false);incomplete=initialize=true;}
    else{
      if(await realpath(join(o.workspace,'.git'))!==join(o.workspace,'.git')||!(await lstat(join(o.workspace,'.git'))).isDirectory())throw new Error('project_work_result_workspace_changed');
      let H:string|null=null;try{H=await git(o.workspace,['rev-parse','--verify','HEAD']);}catch{}
      if(H===null){await checkIncomplete(true);incomplete=true;}
      else{
        if(H!==o.H&&H!==o.previous||await git(o.workspace,['status','--porcelain','--untracked-files=all','--ignored']))throw new Error('project_work_result_workspace_changed');
        if(refs===o.H&&H===o.H){
          const tree=await git(o.executionWorkspace,['rev-parse',o.H+'^{tree}']);if(await git(o.workspace,['rev-parse','HEAD^{tree}'])!==tree)throw new Error('project_work_result_readback_failed');
          return {H:o.H,branch:o.branch,workspace:o.workspace,tree,received:true,alreadyReceived:true};
        }
      }
    }
  }
  await mutate(o.repositoryPath,['fetch','--no-write-fetch-head','--no-tags','--no-recurse-submodules',o.executionWorkspace,o.H]);
  if(!refs||refs!==o.H)await mutate(o.repositoryPath,['update-ref',ref,o.H,refs||'0'.repeat(40)]);
  if(!await exists(o.workspace)){
    await mkdir(o.workspace,{mode:0o700});const st=await lstat(o.workspace);
    await writeFixed(ownership,canonical({workspace:o.workspace,dev:st.dev,ino:st.ino}));incomplete=initialize=true;
  }
  if(initialize){
    await mutate(o.workspace,['init','--template=','--initial-branch='+o.branch]);
    const st=await lstat(join(o.workspace,'.git'));await writeFixed(initialGit,canonical({dev:st.dev,ino:st.ino,configSha256:hash(await regular(join(o.workspace,'.git','config')))}));
  }
  if(incomplete){
    await checkIncomplete(true);
    await mutate(o.workspace,['fetch','--no-tags','--no-recurse-submodules',o.executionWorkspace,o.H]);
    await mutate(o.workspace,['checkout','-b',o.branch,o.H]);
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
