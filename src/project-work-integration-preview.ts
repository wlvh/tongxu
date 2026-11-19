import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {captureIntegrationGit,readIntegrationGit,integrationGitCaptureSha,type GitStep} from './integration-git.js';
import {inspectObjectSource} from './integration-objects.js';
import {exists,regular} from './repair-workspace.js';
import {privateDirectory} from './snapshot.js';

export type WorkIntegrationPreviewInput={repository:string;target:string;H0:string;H:string;B:string};

const mergeStep=(directory:string,source:WorkIntegrationPreviewInput):GitStep=>({cwd:join(directory,'objects.git'),
  args:['merge-tree','--write-tree','--name-only','-z',source.B,source.H],stdin:Buffer.alloc(0),maxBytes:1024*1024});

export async function readWorkIntegrationPreview(directory:string,source:WorkIntegrationPreviewInput){
  if(!await exists(directory))return null;
  try{
    if((await regular(join(directory,'request.json'))).toString()!==canonical(source))throw new Error('project_work_integration_preview_changed');
    const git=await readIntegrationGit(join(directory,'merge'),mergeStep(directory,source));
    const captureSha256=integrationGitCaptureSha(git),[tree,...rest]=git.stdout.toString().split('\0');
    if(/^[a-f0-9]{40}$/.test(tree??'')&&git.successful)return {state:'clean' as const,...source,tree,captureSha256};
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
