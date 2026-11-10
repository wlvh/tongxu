import {readFile,writeFile,realpath,lstat} from 'node:fs/promises';
import {dirname,join,resolve,isAbsolute,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {builtinModules} from 'node:module';
import {parse} from 'acorn';
import {hash,privateDirectory} from './snapshot.js';
import {parseGitHubCliPublisherConfig,type GitHubCliPublisherConfig} from './github-cli-publisher.js';
import type {MergeProfile} from './merge-provider.js';

const runtimeFiles=['github-cli-publisher.js','external-executable.js','merge-request.js','merge-contract.js','authority-contract.js','comparison.js','snapshot.js','contract.js'];
function inside(parent:string,path:string){
  const part=relative(parent,path);
  return part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);
}
function checkImports(source:string){
  const tree=parse(source,{ecmaVersion:'latest',sourceType:'module'}) as any;
  for(const node of tree.body){
    const name=node.source?.value;
    if(typeof name!=='string')continue;
    if(name.startsWith('node:')&&builtinModules.includes(name.slice(5)))continue;
    if(name.startsWith('./')&&runtimeFiles.includes(name.slice(2)))continue;
    throw new Error('github_cli_runtime_dependency_unavailable');
  }
}
function bootstrap(root:string,config:GitHubCliPublisherConfig,files:Array<{path:string;sha256:string}>){
  return `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=${JSON.stringify(root)},config=${JSON.stringify(config)},files=${JSON.stringify(files)},configSha256=${JSON.stringify(hash(JSON.stringify(config)))};
try {
  if(Number(process.versions.node.split('.')[0])<24||typeof fetch!=='function')throw Error('runtime');
  if(crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex')!==configSha256)throw Error('config');
  if(fs.realpathSync(root)!==root)throw Error('directory');
  for(const file of files){
    const name=path.join(root,file.path);
    if(fs.realpathSync(name)!==name)throw Error('path');
    const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
      const before=fs.fstatSync(fd);
      if(!before.isFile()||before.nlink!==1||before.size>1024*1024)throw Error('file');
      const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
      if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('bytes');
    } finally { fs.closeSync(fd); }
  }
  Function('url','return import(url)')(require('node:url').pathToFileURL(path.join(root,'github-cli-publisher.js')).href)
    .then(module=>module.githubCliPublisherMain(config))
    .catch(()=>{process.stderr.write('github_cli_publisher_unavailable\\n');process.exitCode=1;});
} catch { process.stderr.write('github_cli_publisher_bootstrap_unavailable\\n');process.exitCode=1; }
`;
}
/** Prepare a public configuration and finite runtime. gh reads its existing
 * credentials only when the installed command is subsequently invoked. */
export async function prepareGitHubCliPublisher(config:unknown,directory:string,nodeExecutable=process.execPath){
  const c=parseGitHubCliPublisherConfig(config);
  if(!isAbsolute(directory)||resolve(directory)!==directory||!isAbsolute(nodeExecutable)||resolve(nodeExecutable)!==nodeExecutable){
    throw new Error('github_cli_deployment_path_invalid');
  }
  const source=dirname(fileURLToPath(import.meta.url)),repository=resolve(source,'../..');
  if(inside(directory,c.ghConfigDir)||inside(repository,c.ghConfigDir))throw new Error('github_cli_config_must_be_outside_code');
  const node=await lstat(await realpath(nodeExecutable));
  if(!node.isFile()||!(node.mode&0o111))throw new Error('github_cli_node_entry_unavailable');
  await privateDirectory(directory,true);
  const files:Array<{path:string;sha256:string}>=[];
  for(const name of runtimeFiles){
    const path=join(source,name),stat=await lstat(path);
    if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024||await realpath(path)!==path)throw new Error('github_cli_runtime_file_invalid');
    const raw=await readFile(path);
    checkImports(raw.toString());
    files.push({path:name,sha256:hash(raw)});
    await writeFile(join(directory,name),raw,{flag:'wx',mode:0o600});
  }
  const packageRaw=Buffer.from('{"type":"module"}\n');
  await writeFile(join(directory,'package.json'),packageRaw,{flag:'wx',mode:0o600});
  files.push({path:'package.json',sha256:hash(packageRaw)});
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
  const entry=join(directory,'publisher.command');
  const program=`#!/bin/sh\nexec ${quote(nodeExecutable)} -e ${quote(bootstrap(directory,c,files))} -- "$@"\n`;
  const profile:MergeProfile={schemaVersion:1,kind:'tongxu-managed-publisher',repository:c.repository,repositoryId:c.repositoryId,targets:c.targets,actorId:c.actorId,executable:entry,executableSha256:hash(program),executionKind:'external',timeoutMs:c.timeoutMs+5000,credentialKind:'oauth_repo_admin',sharedAccountPublisher:{decisionReference:c.decisionReference}};
  await writeFile(join(directory,'publisher-profile.json'),JSON.stringify(profile,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(join(directory,'deployment.json'),JSON.stringify({schemaVersion:1,config:c,files,nodeExecutable,preparedAt:new Date().toISOString(),profile},null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(entry,program,{flag:'wx',mode:0o700});
  return {directory,profile,files:files.length,credentialsRead:false,configurationIsNotLiveIdentity:true};
}
