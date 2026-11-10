import type test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,realpath,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readGitHubCliResponse,type GitHubCliPublisherConfig,type GitHubCliPublisherRuntime} from '../../src/github-cli-publisher.js';
import type {ManagedMergeBinding} from '../../src/merge-contract.js';
import type {publisherFixture} from './provider-fixture.js';

/** The credential and both HTTP servers are explicit fixtures. The fake gh
 * really runs as a child, and its token file stays outside captured artifacts. */
export async function cliPublisherFixture(t:test.TestContext,business:Awaited<ReturnType<typeof publisherFixture>>,binding:ManagedMergeBinding){
  const ghConfigDir=await mkdtemp(join(await realpath(tmpdir()),'tongxu-gh-login-fixture-'));
  await chmod(ghConfigDir,0o751);
  t.after(()=>rm(ghConfigDir,{recursive:true,force:true}));
  const token='opaque-fixture-'+randomUUID(),tokenPath=join(ghConfigDir,'test-token');
  await writeFile(tokenPath,token+'\n',{mode:0o600});
  const ghExecutable=join(business.root,'gh-fixture.mjs'),modePath=join(business.root,'gh-mode.json'),callsPath=join(business.root,'gh-calls.ndjson');
  await writeFile(modePath,JSON.stringify('normal'));
  const source=`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),mode=JSON.parse(fs.readFileSync(${JSON.stringify(modePath)},'utf8'));
if(JSON.stringify(args)!==JSON.stringify(['auth','token','--hostname','github.com']))process.exit(9);
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,environment:Object.keys(process.env)})+'\\n');
const token=fs.readFileSync(process.env.GH_CONFIG_DIR+'/test-token','utf8');
if(mode==='token-error'){process.stderr.write(token);process.exit(7);}
if(mode==='token-spam'){process.stdout.write(token+'x'.repeat(100000));}
else if(mode==='token-timeout'){setTimeout(()=>process.stdout.write(token),60000);}
else {if(mode==='program-change')fs.appendFileSync(process.argv[1],'\\n// fixture upgrade during use\\n');process.stdout.write(mode==='token-whitespace'?'has spaces\\n':token);}
`;
  await writeFile(ghExecutable,source,{mode:0o700});
  const config:GitHubCliPublisherConfig={schemaVersion:1,kind:'tongxu-github-cli-publisher',repository:binding.repository,repositoryId:binding.repositoryId,targets:[binding.targetRef],actorId:business.profile.actorId,ghExecutable,ghConfigDir,timeoutMs:3000,decisionReference:{kind:'recorded_user_decision',sha256:'b'.repeat(64)}};
  let mode='normal';
  const requests:Array<{method:string;path:string;body:string;tokenMatches:boolean}>=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part.toString();
    const path=req.url!,method=req.method!,tokenMatches=req.headers.authorization==='Bearer '+token;
    requests.push({method,path,body:raw,tokenMatches});
    if(!tokenMatches){res.writeHead(401);res.end('{}');return;}
    const isPut=method==='PUT';
    if(mode==='before-redirect'&&path==='/user'){res.writeHead(302,{location:'https://unrelated.invalid'});res.end('{}');return;}
    if(mode==='before-timeout'&&path==='/user'){req.on('close',()=>res.destroy());return;}
    if(mode==='before-large'&&path==='/user'){res.end('x'.repeat(5*1024*1024));return;}
    if(path==='/user'){
      const user={id:mode==='wrong-actor'?999:config.actorId,type:mode==='wrong-type'?'Bot':'User'};
      const scope=mode==='missing-scope'?'repo:status':mode==='public-scope'?'public_repo':'repo, read:org';
      if(mode!=='no-scope-header')res.setHeader('x-oauth-scopes',scope);
      if(mode==='rotate-after-token')await writeFile(tokenPath,'different-fixture-token\n');
      res.end(JSON.stringify(user));return;
    }
    if(path==='/repos/'+binding.repository){
      const repository={id:mode==='wrong-repository'?999:config.repositoryId,full_name:config.repository,owner:{type:'Organization'},permissions:{admin:mode!=='not-admin',push:mode!=='not-push'},archived:false,disabled:false,allow_merge_commit:true};
      res.end(JSON.stringify(repository));return;
    }
    try{
      const response=await fetch(business.origin+path,{method,...(raw?{body:raw}:{}),redirect:'manual'});
      const body=await response.text();
      if(isPut&&mode==='after-timeout'){req.on('close',()=>res.destroy());return;}
      if(isPut&&mode==='after-redirect'){res.writeHead(307,{location:'https://unrelated.invalid'});res.end('{}');return;}
      if(isPut&&mode==='after-large'){res.end('x'.repeat(5*1024*1024));return;}
      if(isPut&&mode==='after-malformed'){res.end('{malformed');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers.entries()));res.end(body);
    }catch{res.destroy();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const runtime:GitHubCliPublisherRuntime={identity:'fixture',request:async request=>readGitHubCliResponse(await fetch(origin+request.path,{method:request.method,headers:{Authorization:'Bearer '+request.authorization},...(request.body===null?{}:{body:request.body}),signal:request.signal,redirect:'manual'}))};
  async function attach(){
    const code=`#!${process.execPath}
import fs from 'node:fs';
import {runGitHubCliCommand,readGitHubCliResponse} from ${JSON.stringify(new URL('../../src/github-cli-publisher.js',import.meta.url).href)};
const config=${JSON.stringify(config)},origin=${JSON.stringify(origin)};
const request=async q=>readGitHubCliResponse(await fetch(origin+q.path,{method:q.method,headers:{Authorization:'Bearer '+q.authorization},...(q.body===null?{}:{body:q.body}),signal:q.signal,redirect:'manual'}));
let raw='';for await(const part of process.stdin)raw+=part;
try{console.log(JSON.stringify(await runGitHubCliCommand(config,Buffer.from(raw),{request,identity:'fixture'})));}catch{console.error('explicit_github_cli_fixture_unavailable');process.exitCode=1;}
`;
    await writeFile(business.profile.executable,code,{mode:0o700});
  }
  return {config,runtime,token,tokenPath,requests,origin,attach,
    setMode:(value:string)=>{mode=value;},
    setGhMode:(value:string)=>writeFile(modePath,JSON.stringify(value)),
    calls:async()=>{try{return (await readFile(callsPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}}};
}
