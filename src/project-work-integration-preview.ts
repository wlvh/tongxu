import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from './comparison.js';
import {captureIntegrationGit,readIntegrationGit,integrationGitCaptureSha,type GitStep} from './integration-git.js';
import {inspectObjectSource} from './integration-objects.js';
import {exists,regular,gitReadOnly} from './repair-workspace.js';
import {hash,privateDirectory} from './snapshot.js';
import {readFailedValidationTests} from './implementation-validation.js';
import {projectModelTestResult,testProject,type ProjectContract} from './project-repair.js';
import type {DockerStartGate} from './docker-sandbox.js';

export type WorkIntegrationPreviewInput={repository:string;target:string;H0:string;H:string;B:string};
type IntegrationPlan={workspace:string;candidate:ProjectContract['sourceCandidate'];project:ProjectContract};

const candidateStep=(directory:string,input:WorkIntegrationPreviewInput,tree:string):GitStep=>({
  cwd:join(directory,'objects.git'),args:['hash-object','-t','commit','-w','--stdin'],
  stdin:Buffer.from('tree '+tree+'\nparent '+input.B+'\nparent '+input.H+
    '\nauthor Tongxu integration <integration@example.invalid> 0 +0000\ncommitter Tongxu integration <integration@example.invalid> 0 +0000\n\nTongxu checked project integration\n')
});
const commitIdentity=(bytes:Buffer)=>createHash('sha1').update(Buffer.from('commit '+bytes.length+'\0')).update(bytes).digest('hex');

export async function readWorkIntegrationValidation(directory:string,input:WorkIntegrationPreviewInput){
  const verification=join(directory,'validation');
  if(!await exists(verification))return null;
  try{
    const preview=await readWorkIntegrationPreview(directory,input);
    if(preview?.state!=='clean')throw new Error('project_work_integration_preview_changed');
    const step=candidateStep(directory,input,preview.tree),H=commitIdentity(step.stdin);
    const produced=await readIntegrationGit(join(verification,'candidate'),step);
    if(!produced.successful||produced.stdout.toString().trim()!==H)throw new Error('project_work_integration_commit_unverified');
    const plan=JSON.parse((await regular(join(verification,'plan.json'))).toString()) as IntegrationPlan;
    if(plan.workspace!==join(verification,'worktree')||plan.candidate.H!==H||plan.candidate.B!==input.B||
       canonical(plan.candidate)!==canonical(plan.project.sourceCandidate)||
       await gitReadOnly(plan.workspace,['rev-parse','HEAD'])!==H||
       await gitReadOnly(plan.workspace,['rev-parse','HEAD^{tree}'])!==preview.tree)
      throw new Error('project_work_integration_commit_unverified');
    const original=await readFailedValidationTests(join(verification,'tests'),plan,false);
    if(original.result.T!==preview.tree)throw new Error('project_work_integration_test_candidate_changed');
    const receipt=JSON.parse((await regular(join(verification,'receipt.json'))).toString());
    if(canonical(receipt)!==canonical({input,H,T:preview.tree,planSha256:hash(canonical(plan)),resultSha256:hash(canonical(original.result))}))
      throw new Error('project_work_integration_test_candidate_changed');
    return {state:original.result.passed?'tested' as const:'failed' as const,H,B:input.B,T:preview.tree,
      tests:projectModelTestResult(original.result),formalReview:'not_run',published:false};
  }catch{return {state:'pending_or_unknown' as const,B:input.B};}
}

export async function validateWorkIntegration(directory:string,input:WorkIntegrationPreviewInput,
  project:ProjectContract,check:()=>Promise<void>,authorize:(workspace:string,H:string)=>Promise<DockerStartGate>){
  const preview=await readWorkIntegrationPreview(directory,input);
  if(preview?.state!=='clean'||!project.projectFiles)throw new Error('project_work_integration_clean_preview_required');
  const verification=join(directory,'validation');
  await check();
  try{await privateDirectory(verification,true);}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return readWorkIntegrationValidation(directory,input);throw error;}
  const git=async(name:string,step:GitStep)=>{
    const result=await captureIntegrationGit(join(verification,name),step,effect=>effect(),check);
    if(!result.successful)throw new Error('project_work_integration_git_unavailable');
    return result.stdout.toString().trim();
  };
  const step=candidateStep(directory,input,preview.tree),H=commitIdentity(step.stdin);
  if(await git('candidate',step)!==H)throw new Error('project_work_integration_commit_unverified');
  const workspace=join(verification,'worktree');
  await mkdir(workspace,{mode:0o700});
  await git('init',{cwd:workspace,args:['init','--object-format=sha1','--template='],stdin:Buffer.alloc(0)});
  await mkdir(join(workspace,'.git','objects','info'),{recursive:true,mode:0o700});
  await writeFile(join(workspace,'.git','objects','info','alternates'),join(directory,'objects.git','objects')+'\n',{flag:'wx',mode:0o600});
  await git('checkout',{cwd:workspace,args:['checkout','--detach',H],stdin:Buffer.alloc(0)});
  if(await gitReadOnly(workspace,['rev-parse','HEAD^{tree}'])!==preview.tree)throw new Error('project_work_integration_commit_unverified');
  const candidate={...project.sourceCandidate,H,B:input.B,target:input.target},plan={workspace,candidate,project:{...project,sourceCandidate:candidate}};
  await writeFile(join(verification,'plan.json'),canonical(plan),{flag:'wx',mode:0o600});
  const tests=await testProject(workspace,join(verification,'tests'),plan.project,await authorize(workspace,H));
  await check();
  if(tests.T!==preview.tree||!tests.executionHealthy)throw new Error('project_work_integration_test_candidate_changed');
  await writeFile(join(verification,'receipt.json'),canonical({input,H,T:preview.tree,planSha256:hash(canonical(plan)),resultSha256:hash(canonical(tests))}),{flag:'wx',mode:0o600});
  return readWorkIntegrationValidation(directory,input);
}

const mergeStep=(directory:string,source:WorkIntegrationPreviewInput):GitStep=>({cwd:join(directory,'objects.git'),
  args:['merge-tree','--write-tree','--name-only','-z',source.B,source.H],stdin:Buffer.alloc(0),maxBytes:1024*1024});

export async function readWorkIntegrationPreview(directory:string,source:WorkIntegrationPreviewInput){
  if(!await exists(directory))return null;
  try{
    if((await regular(join(directory,'request.json'))).toString()!==canonical(source))throw new Error('project_work_integration_preview_changed');
    const git=await readIntegrationGit(join(directory,'merge'),mergeStep(directory,source));
    const captureSha256=integrationGitCaptureSha(git),[tree,...rest]=git.stdout.toString().split('\0');
    if(tree&&/^[a-f0-9]{40}$/.test(tree)&&git.successful)return {state:'clean' as const,...source,tree,captureSha256};
    if(/^[a-f0-9]{40}$/.test(tree??'')&&git.exit.code===1&&git.exit.signal===null&&!git.exit.limited&&!git.exit.spawnError&&!git.exit.gateError){
      const boundary=rest.indexOf('');
      if(boundary>0)return {state:'conflicts' as const,...source,paths:rest.slice(0,boundary),captureSha256};
    }
    return {state:'git_failed' as const,...source,captureSha256};
  }catch{return {state:'pending_or_unknown' as const,...source};}
}

export async function previewWorkIntegration(directory:string,source:WorkIntegrationPreviewInput,repository:string,check:()=>Promise<void>){
  if(![source.H0,source.H,source.B].every(sha=>/^[a-f0-9]{40}$/.test(sha)))throw new Error('project_work_integration_preview_changed');
  await check();
  try{await privateDirectory(directory,true);}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return readWorkIntegrationPreview(directory,source);throw error;}
  await writeFile(join(directory,'request.json'),canonical(source),{flag:'wx',mode:0o600});
  const gitDirectory=join(directory,'objects.git');await mkdir(gitDirectory,{mode:0o700});
  const init=await captureIntegrationGit(join(directory,'init'),{cwd:gitDirectory,args:['init','--bare','--object-format=sha1','--template='],stdin:Buffer.alloc(0)},effect=>effect(),check);
  if(!init.successful)throw new Error('project_work_integration_git_unavailable');
  const {objectDirectory}=await inspectObjectSource(repository);
  const info=join(gitDirectory,'objects','info');await mkdir(info,{recursive:true,mode:0o700});
  await writeFile(join(info,'alternates'),objectDirectory+'\n',{flag:'wx',mode:0o600});
  await captureIntegrationGit(join(directory,'merge'),mergeStep(directory,source),effect=>effect(),check);
  return readWorkIntegrationPreview(directory,source);
}
