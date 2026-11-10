import {execFile} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import https from 'node:https';
import type {IncomingMessage} from 'node:http';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {canonical} from './comparison.js';
import {repoPattern,validBranchRef} from './contract.js';
import {selectExternalExecutable,assertExternalExecutable} from './external-executable.js';
import {parseMergeCommand,mergeHttpRequest,type MergeCommand} from './merge-request.js';
import type {MergeReply} from './merge-provider.js';
import {hash} from './snapshot.js';

export type GitHubCliPublisherConfig = {
  schemaVersion:1;
  kind:'tongxu-github-cli-publisher';
  repository:string;
  repositoryId:number;
  targets:string[];
  actorId:number;
  ghExecutable:string;
  ghConfigDir:string;
  timeoutMs:number;
  decisionReference:{kind:'recorded_user_decision';sha256:string};
};
export type GitHubCliRequest = {
  method:'GET'|'POST'|'PUT';
  path:string;
  authorization:string;
  body:string|null;
  signal:AbortSignal;
};
type HttpReply = {status:number;body:string;headers:Record<string,string>};
/** An explicit unit runtime may use a local source. Deployed entries always
 * use the fixed production request and account-publisher identity. */
export type GitHubCliPublisherRuntime = {
  request:(request:GitHubCliRequest)=>Promise<HttpReply>;
  identity:'account_publisher'|'fixture';
  report?:(publicCode:string)=>void;
};
const responseLimit=4*1024*1024;
const inputLimit=128*1024;
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const normalized=(value:unknown):value is string=>typeof value==='string'&&isAbsolute(value)&&resolve(value)===value&&!/[\x00-\x1f\x7f]/.test(value);
const fail=(code:string):never=>{throw new Error(code);};
const publicProblems=new Set([
  'github_cli_configuration_invalid','github_cli_config_directory_unavailable',
  'github_cli_credentials_unavailable','github_cli_identity_unavailable',
  'github_cli_scope_unavailable','github_cli_repository_unavailable',
  'github_cli_merge_scope_changed','github_cli_request_invalid',
  'github_cli_redirect_refused','github_cli_response_limit',
  'github_cli_pagination_unavailable','github_cli_command_invalid',
  'github_cli_input_limit','github_cli_entry_arguments_invalid',
  'github_cli_program_changed','github_cli_request_incomplete'
]);
function publicProblem(error:unknown,fallback:string){
  return error instanceof Error&&publicProblems.has(error.message)?error.message:fallback;
}
export function parseGitHubCliPublisherConfig(value:unknown):GitHubCliPublisherConfig{
  const c=value as GitHubCliPublisherConfig;
  if(!exactKeys(c,['schemaVersion','kind','repository','repositoryId','targets','actorId','ghExecutable','ghConfigDir','timeoutMs','decisionReference'])
    ||c.schemaVersion!==1||c.kind!=='tongxu-github-cli-publisher'
    ||typeof c.repository!=='string'||!repoPattern.test(c.repository)
    ||!positive(c.repositoryId)||!positive(c.actorId)
    ||!Array.isArray(c.targets)||!c.targets.length||c.targets.length>8
    ||new Set(c.targets).size!==c.targets.length||!c.targets.every(validBranchRef)
    ||!normalized(c.ghExecutable)||!normalized(c.ghConfigDir)
    ||!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<1000||c.timeoutMs>55000
    ||!exactKeys(c.decisionReference,['kind','sha256'])
    ||c.decisionReference.kind!=='recorded_user_decision'||!isAuthorityDigest(c.decisionReference.sha256)){
    fail('github_cli_configuration_invalid');
  }
  return c;
}
function configurationDirectory(config:GitHubCliPublisherConfig){
  const path=config.ghConfigDir,uid=process.getuid?.();
  try{
    const st=lstatSync(path),fromWorkingDirectory=relative(process.cwd(),path);
    const insideWorkingDirectory=fromWorkingDirectory===''||fromWorkingDirectory!=='..'&&!fromWorkingDirectory.startsWith('..'+sep)&&!isAbsolute(fromWorkingDirectory);
    if(uid===undefined||!st.isDirectory()||st.uid!==uid||(st.mode&0o022)!==0||realpathSync(path)!==path||insideWorkingDirectory){
      fail('github_cli_config_directory_unavailable');
    }
  }catch{fail('github_cli_config_directory_unavailable');}
  return path;
}
/** gh keeps ownership of its login. Its bounded stdout is consumed internally
 * and never forwarded to the provider capture or a model. */
async function existingToken(config:GitHubCliPublisherConfig,signal:AbortSignal){
  const directory=configurationDirectory(config);
  const selected=selectExternalExecutable(config.ghExecutable);
  const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:process.cwd(),GH_HOST:'github.com',GH_CONFIG_DIR:directory,GH_PROMPT_DISABLED:'1',GH_PAGER:'cat',PAGER:'cat'};
  assertExternalExecutable(selected);
  let stdout:Buffer;
  try{
    stdout=await new Promise<Buffer>((resolve,reject)=>{
      let ended=false,result:{error:Error|null;stdout:Buffer}|undefined;
      const finish=()=>{if(ended&&result)result.error?reject(new Error('github_cli_credentials_unavailable')):resolve(result.stdout);};
      const child=execFile(selected.realpath,['auth','token','--hostname','github.com'],{env,cwd:process.cwd(),signal,killSignal:'SIGKILL',timeout:config.timeoutMs,maxBuffer:64*1024,encoding:'buffer'},(error,out)=>{
        result={error,stdout:out};finish();
      });
      child.once('close',()=>{ended=true;finish();});
      child.stdin?.end();
    });
  }catch{fail('github_cli_credentials_unavailable');}
  try{assertExternalExecutable(selected);}catch{stdout!.fill(0);fail('github_cli_program_changed');}
  try{
    const token=new TextDecoder('utf8',{fatal:true}).decode(stdout!).replace(/[\r\n]+$/,'');
    if(!token||token.length>64*1024||/\s|[\x00-\x1f\x7f]/.test(token))fail('github_cli_credentials_unavailable');
    return token;
  }finally{stdout!.fill(0);}
}

export const githubCliProductionRequest:GitHubCliPublisherRuntime['request']=async request=>{
  const url=new URL(request.path,'https://api.github.com');
  if(url.origin!=='https://api.github.com'||!request.path.startsWith('/')||request.path.startsWith('//')||url.username||url.password){
    fail('github_cli_request_invalid');
  }
  // ClientRequest returns each HTTP response directly, including 421. A write
  // must never be replayed below the original managed dispatch record.
  request.signal.throwIfAborted();
  const outgoing=https.request(url,{method:request.method,
    headers:{Accept:'application/vnd.github+json','User-Agent':'tongxu-managed-github-cli',Authorization:'Bearer '+request.authorization,...(request.body===null?{}:{'Content-Type':'application/json'})}});
  let response:IncomingMessage|undefined;
  const abort=()=>{
    const error=request.signal.reason instanceof Error?request.signal.reason:new Error('github_cli_request_incomplete');
    outgoing.destroy(error);response?.destroy(error);
  };
  request.signal.addEventListener('abort',abort,{once:true});
  try{
    response=await new Promise<IncomingMessage>((resolve,reject)=>{
      outgoing.once('response',resolve);
      outgoing.once('error',reject);
      outgoing.end(request.body??undefined);
    });
    const status=response.statusCode!;
    if(status>=300&&status<400)fail('github_cli_redirect_refused');
    const chunks:Buffer[]=[];
    let length=0;
    for await(const part of response){
      const chunk=Buffer.from(part);length+=chunk.length;
      if(length>responseLimit)fail('github_cli_response_limit');
      chunks.push(chunk);
    }
    if(!response.complete)fail('github_cli_request_incomplete');
    const headers:Record<string,string>={};
    for(const [name,value] of Object.entries(response.headers))if(value!==undefined)headers[name]=Array.isArray(value)?value.join(', '):value;
    return {status,body:new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)),headers};
  }catch(error){response?.destroy();outgoing.destroy();throw error;}
  finally{request.signal.removeEventListener('abort',abort);}
};
export async function readGitHubCliResponse(response:Response):Promise<HttpReply>{
  if(response.status>=300&&response.status<400){await response.body?.cancel();fail('github_cli_redirect_refused');}
  const chunks:Uint8Array[]=[];
  let length=0;
  const reader=response.body?.getReader();
  if(reader)try{
    for(;;){
      const part=await reader.read();
      if(part.done)break;
      length+=part.value.byteLength;
      if(length>responseLimit){await reader.cancel();fail('github_cli_response_limit');}
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  return {status:response.status,body:new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)),headers:Object.fromEntries(response.headers.entries())};
}
const productionRuntime:GitHubCliPublisherRuntime={request:githubCliProductionRequest,identity:'account_publisher',report:code=>{process.stderr.write(code+'\n');}};
function object(response:HttpReply):Record<string,any>{
  let value:unknown;
  try{value=JSON.parse(response.body);}catch{fail('github_cli_identity_unavailable');}
  if(response.status!==200||!value||typeof value!=='object'||Array.isArray(value))fail('github_cli_identity_unavailable');
  return value as Record<string,any>;
}
function nextPage(headers:Record<string,string>){
  if(!headers.link)return false;
  const relations=new Set<string>();
  for(const part of headers.link.split(',')){
    const match=/^\s*<([^>]+)>;\s*rel="([a-z]+)"\s*$/.exec(part);
    if(!match)fail('github_cli_pagination_unavailable');
    const target=new URL(match![1]!);
    if(target.origin!=='https://api.github.com'||relations.has(match![2]!))fail('github_cli_pagination_unavailable');
    relations.add(match![2]!);
  }
  return relations.has('next');
}
async function authenticate(config:GitHubCliPublisherConfig,runtime:GitHubCliPublisherRuntime,signal:AbortSignal){
  const token=await existingToken(config,signal);
  const request=(method:GitHubCliRequest['method'],path:string,body:string|null=null)=>runtime.request({method,path,body,authorization:token,signal});
  const userResponse=await request('GET','/user'),user=object(userResponse);
  if(user.id!==config.actorId||user.type!=='User')fail('github_cli_identity_unavailable');
  const scopes=userResponse.headers['x-oauth-scopes'];
  if(typeof scopes!=='string'||scopes.length>4096||!scopes.split(',').map(scope=>scope.trim()).includes('repo'))fail('github_cli_scope_unavailable');
  const repositoryResponse=await request('GET','/repos/'+config.repository),repository=object(repositoryResponse);
  if(repository.id!==config.repositoryId||typeof repository.full_name!=='string'||repository.full_name.toLowerCase()!==config.repository.toLowerCase()
    ||repository.permissions?.admin!==true||repository.permissions?.push!==true
    ||repository.archived!==false||repository.disabled!==false||repository.allow_merge_commit!==true){
    fail('github_cli_repository_unavailable');
  }
  return {request,repositoryResponse};
}
async function mergeScope(config:GitHubCliPublisherConfig,command:MergeCommand,auth:Awaited<ReturnType<typeof authenticate>>){
  const b=command.binding,root='/repos/'+config.repository;
  const pr=object(await auth.request('GET',`${root}/pulls/${b.pr}`));
  if(pr.number!==b.pr||pr.state!=='open'||pr.draft!==false||pr.merged!==false
    ||pr.head?.repo?.id!==config.repositoryId||pr.base?.repo?.id!==config.repositoryId
    ||pr.base?.repo?.full_name?.toLowerCase()!==config.repository.toLowerCase()
    ||pr.head?.sha!==b.H||pr.base?.ref!==b.targetRef||!config.targets.includes(pr.base.ref))fail('github_cli_merge_scope_changed');
  const target=object(await auth.request('GET',`${root}/git/ref/heads/${encodeURIComponent(b.targetRef)}`));
  if(target.ref!=='refs/heads/'+b.targetRef||target.object?.type!=='commit'||target.object.sha!==b.B)fail('github_cli_merge_scope_changed');
}

export async function runGitHubCliCommand(config:unknown,raw:Buffer,runtime:GitHubCliPublisherRuntime=productionRuntime):Promise<MergeReply>{
  const c=parseGitHubCliPublisherConfig(config);
  if(raw.length>inputLimit)fail('github_cli_input_limit');
  let command:MergeCommand;
  try{command=parseMergeCommand(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw)),c);}catch{fail('github_cli_command_invalid');}
  const inputSha256=hash(canonical(command!)),signal=AbortSignal.timeout(c.timeoutMs);
  let auth:Awaited<ReturnType<typeof authenticate>>;
  try{auth=await authenticate(c,runtime,signal);}catch(error){
    const reason=publicProblem(error,'github_cli_credentials_unavailable');
    runtime.report?.(reason);
    if(command!.command!=='capabilities')fail(reason);
    return {protocol:command!.protocol,inputSha256,result:{kind:'capabilities',credentialState:'unavailable',actorId:null,identity:'unknown',repositoryIds:[],targetRefs:[],merge:false,bypass:false,synchronousHeadCondition:false,sourceReference:null}};
  }
  if(command!.command==='capabilities')return {protocol:command!.protocol,inputSha256,result:{kind:'capabilities',credentialState:'available',actorId:c.actorId,identity:runtime.identity,repositoryIds:[c.repositoryId],targetRefs:c.targets,merge:true,bypass:false,synchronousHeadCondition:true,sourceReference:`github-cli:${c.actorId}:repository:${c.repositoryId}:repo-scope-admin`}};
  try{
    if(command!.command==='merge')await mergeScope(c,command!,auth!);
    const plan=mergeHttpRequest(command!);
    const response=command!.read?.kind==='repository'?auth!.repositoryResponse:await auth!.request(plan.method,plan.path,plan.body);
    const more=nextPage(response.headers);
    if(more&&(command!.command!=='read'||!['rules','checks','statuses','reviews'].includes(command!.read!.kind)))fail('github_cli_pagination_unavailable');
    const reply:MergeReply={protocol:command!.protocol,inputSha256,result:{kind:'http',status:response.status,body:response.body,nextPage:more}};
    if(Buffer.byteLength(JSON.stringify(reply))>=responseLimit)fail('github_cli_response_limit');
    return reply;
  }catch(error){return fail(publicProblem(error,'github_cli_request_incomplete'));}
}
export async function githubCliPublisherMain(config:unknown){
  try{
    if(canonical(process.argv.slice(1))!==canonical(['--tongxu-managed-merge-v1']))fail('github_cli_entry_arguments_invalid');
    const chunks:Buffer[]=[];
    let length=0;
    for await(const part of process.stdin){
      const bytes=Buffer.from(part);length+=bytes.length;
      if(length>inputLimit)fail('github_cli_input_limit');
      chunks.push(bytes);
    }
    const reply=await runGitHubCliCommand(config,Buffer.concat(chunks));
    process.stdout.write(JSON.stringify(reply)+'\n');
  }catch(error){process.stderr.write(publicProblem(error,'github_cli_publisher_unavailable')+'\n');process.exitCode=1;}
}
