import {execFile} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {selectGhExecutable,assertGhExecutableUnchanged} from './gh-executable.js';
import {parseGh} from './transport.js';
import type {Response} from './contract.js';

type Row=Record<string,any>;
type Account={id:number;login:string};
export type GitHubProjectReader={get:(endpoint:string,signal:AbortSignal)=>Promise<Response>};
export type GitHubReaderFactory=(signal:AbortSignal)=>Promise<GitHubProjectReader>;
export class GitHubProjectError extends Error{
  constructor(code:string,readonly retryAfterSeconds?:number){super(code);}
}
const name=/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0;
const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
const timestamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const now=()=>new Date().toISOString();
const fail=(code='github_response_invalid'):never=>{throw new GitHubProjectError(code);};
function allowed(endpoint:string){
  if(endpoint==='user'||/^user\/repos\?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=50&page=[1-9]\d{0,3}$/.test(endpoint)||/^repositories\/[1-9]\d*$/.test(endpoint))return;
  if(/^repos\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/(issues|pulls)(?:\/[1-9]\d*|\?state=(?:open|closed|all)&sort=updated&direction=desc&per_page=30&page=[1-9]\d{0,3})$/.test(endpoint))return;
  fail('github_read_endpoint_denied');
}
/** Uses the existing CLI account. No login, token extraction, shell command,
 * remote mutation, model request or fixed CLI release is part of this reader. */
export const currentGitHubReader:GitHubReaderFactory=async signal=>{
  const explicit=process.env.TONGXU_GH;
  if(explicit&&!isAbsolute(explicit))fail('github_cli_entry_invalid');
  const candidates=explicit?[explicit]:[...(process.env.PATH??'').split(':').filter(Boolean).map(p=>join(p,'gh')),'/opt/homebrew/bin/gh','/usr/local/bin/gh','/usr/bin/gh'];
  let path:string|undefined;
  for(const candidate of [...new Set(candidates)]){try{await access(candidate,constants.X_OK);path=candidate;break;}catch{}}
  if(!path)fail('github_cli_missing');
  let selected:Awaited<ReturnType<typeof selectGhExecutable>>;
  try{selected=await selectGhExecutable(path!,'0'.repeat(64));}catch{fail('github_cli_capabilities_unavailable');}
  if(signal.aborted)fail('github_read_cancelled');
  return {get:async(endpoint,signal)=>{
    allowed(endpoint);assertGhExecutableUnchanged(selected);
    const env:NodeJS.ProcessEnv={...process.env,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GH_PAGER:'cat',PAGER:'cat'};delete env.GH_DEBUG;delete env.GH_FORCE_TTY;
    const args=['api','--hostname','github.com','--method','GET','--include','-H','Accept: application/vnd.github+json',endpoint];
    const raw=await new Promise<string>((resolve,reject)=>{
      execFile(selected.realpath,args,{env,signal,timeout:20000,maxBuffer:8*1024*1024},(error,stdout,stderr)=>{
        if(signal.aborted){reject(new GitHubProjectError('github_read_cancelled'));return;}
        if(error&&!/^HTTP\/\S+\s+\d+/.test(stdout)){reject(new GitHubProjectError((error as any).code==='ENOENT'?'github_cli_missing':/gh auth login|not logged|authentication required/i.test(stderr)?'github_not_signed_in':'github_connection_unavailable'));return;}
        resolve(stdout);
      });
    });
    try{assertGhExecutableUnchanged(selected);}catch{fail('github_cli_changed_during_read');}
    try{return parseGh(raw);}catch{return fail();}
  }};
};
function decode(r:Response):any{
  if(r.status===401)fail('github_not_signed_in');
  if(r.status===429||r.status===403&&(r.headers['x-ratelimit-remaining']==='0'||r.headers['retry-after'])){
    const seconds=Number(r.headers['retry-after']);throw new GitHubProjectError('github_rate_limited',Number.isFinite(seconds)&&seconds>0?Math.min(seconds,86400):undefined);
  }
  if(r.status===403)fail('github_access_denied');
  if(r.status===404)fail('github_repository_unavailable');
  if(r.status!==200)fail('github_service_unavailable');
  try{return JSON.parse(r.body);}catch{fail();}
}
function account(value:Row):Account{
  if(!positive(value?.id)||!bounded(value.login,128)||!value.login)fail();return {id:value.id,login:value.login};
}
function repository(v:Row){
  if(!positive(v?.id)||!name.test(v.full_name??'')||typeof v.private!=='boolean'||typeof v.archived!=='boolean'||!(v.description===null||bounded(v.description,16384))||!(v.default_branch===null||bounded(v.default_branch,256))||!timestamp(v.updated_at))fail();
  return {id:v.id,fullName:v.full_name as string,description:v.description??'',private:v.private,archived:v.archived,defaultBranch:v.default_branch??null,updatedAt:v.updated_at as string,url:'https://github.com/'+v.full_name};
}
function entry(v:Row,repo:string,kind:'issues'|'pulls',full=false){
  if(!positive(v?.number)||!bounded(v.title,4096)||!['open','closed'].includes(v.state)||!timestamp(v.updated_at)||!(v.body==null||bounded(v.body,1024*1024))||!positive(v.id))fail();
  if(kind==='issues'&&v.pull_request)fail('github_item_kind_changed');
  if(kind==='pulls'&&(typeof v.draft!=='boolean'||!(v.merged_at===null||timestamp(v.merged_at))||!bounded(v.head?.ref,512)||!bounded(v.base?.ref,512)))fail();
  return {number:v.number as number,title:v.title as string,state:v.state as 'open'|'closed',updatedAt:v.updated_at as string,author:bounded(v.user?.login,128)?v.user.login:null,labels:Array.isArray(v.labels)?v.labels.slice(0,50).map((x:any)=>typeof x==='string'?x:x?.name).filter((x:any)=>bounded(x,128)):[],url:`https://github.com/${repo}/${kind==='pulls'?'pull':'issues'}/${v.number}`,...(kind==='pulls'?{draft:v.draft,merged:!!v.merged_at,head:v.head.ref,base:v.base.ref}:{}),...(full?{body:v.body??'',comments:Number.isSafeInteger(v.comments)?v.comments:null}: {})};
}
function queryNumber(url:URL,key:string,fallback?:number){
  const raw=url.searchParams.get(key);if(raw===null&&fallback!==undefined)return fallback;
  if(!raw||!/^[1-9]\d*$/.test(raw)||!positive(Number(raw)))fail('github_query_invalid');return Number(raw);
}
function queryKeys(url:URL,keys:string[]){const actual=[...url.searchParams.keys()];if(new Set(actual).size!==actual.length||actual.some(k=>!keys.includes(k)))fail('github_query_invalid');}

/** In-memory discovery only. It never imports a candidate, grants write
 * authority, creates an execution plan or replaces the original task ledger. */
export class GitHubProjects{
  private identity:Account|null=null;
  private repositories=new Map<number,string>();
  private epoch=0;
  private closed=false;
  private controllers=new Set<AbortController>();
  private reads=new Set<Promise<unknown>>();
  constructor(private reader:GitHubReaderFactory=currentGitHubReader){}
  private changed(){this.identity=null;this.repositories.clear();this.epoch++;}
  async read(url:URL):Promise<unknown>{
    if(this.closed)fail('github_reader_closed');
    const controller=new AbortController();this.controllers.add(controller);
    const promise=this.readCurrent(url,controller.signal);this.reads.add(promise);
    try{return await promise;}catch(e){if(e instanceof GitHubProjectError&&['github_not_signed_in','github_account_changed'].includes(e.message))this.changed();throw e;}
    finally{this.reads.delete(promise);this.controllers.delete(controller);}
  }
  private async readCurrent(url:URL,signal:AbortSignal){
    const list=url.pathname==='/api/github/projects',match=/^\/api\/github\/repositories\/([1-9]\d*)\/(issues|pulls)(?:\/([1-9]\d*))?$/.exec(url.pathname);
    if(!list&&!match)fail('github_route_not_found');
    queryKeys(url,list?['page']:match![3]?['account']:['account','page','state']);
    const page=queryNumber(url,'page',1);if(page>1000)fail('github_page_limit');
    const expected=list?null:queryNumber(url,'account'),repoId=match?Number(match[1]):null,kind=match?.[2] as 'issues'|'pulls'|undefined,state=url.searchParams.get('state')??'open';
    if(!['open','closed','all'].includes(state))fail('github_query_invalid');
    if(!list&&(!positive(repoId)||!this.identity||this.identity.id!==expected||!this.repositories.has(repoId)))fail('github_project_not_selected');
    const reader=await this.reader(signal),get=async(path:string)=>{if(signal.aborted)fail('github_read_cancelled');allowed(path);const r=await reader.get(path,signal);return {response:r,value:decode(r)};};
    const before=account((await get('user')).value);
    if(expected!==null&&before.id!==expected)fail('github_account_changed');
    if(this.identity?.id!==before.id){this.changed();this.identity=before;}
    const epoch=this.epoch;
    let result:Row,newRepositories:ReturnType<typeof repository>[]=[];
    if(list){
      const r=await get(`user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=50&page=${page}`);
      if(!Array.isArray(r.value)||r.value.length>50)fail();newRepositories=r.value.map(repository);
      result={repositories:newRepositories,page,hasNext:/rel="next"/.test(r.response.headers.link??'')};
    }else{
      const repo=repository((await get('repositories/'+repoId)).value);if(repo.id!==repoId)fail('github_repository_identity_changed');
      const path=`repos/${repo.fullName}/${kind}`+(match![3]?'/'+match![3]:`?state=${state}&sort=updated&direction=desc&per_page=30&page=${page}`),r=await get(path);
      if(match![3]){const item=entry(r.value,repo.fullName,kind!,true);if(item.number!==Number(match![3]))fail();result={repository:repo,kind,item};}
      else {if(!Array.isArray(r.value)||r.value.length>30)fail();const rows=kind==='issues'?r.value.filter((x:Row)=>!x.pull_request):r.value;result={repository:repo,kind,state,page,items:rows.map((x:Row)=>entry(x,repo.fullName,kind!)),hasNext:/rel="next"/.test(r.response.headers.link??''),pageMayExcludePullRequests:kind==='issues'};}
    }
    const after=account((await get('user')).value);
    if(signal.aborted)fail('github_read_cancelled');
    if(before.id!==after.id||epoch!==this.epoch||this.identity?.id!==after.id)fail('github_account_changed');
    for(const repo of newRepositories)this.repositories.set(repo.id,repo.fullName);
    return {connection:{status:'connected',account:after,checkedAt:now()},...result,source:'github_live_read',readOnly:true,modelInputs:0};
  }
  async close(){this.closed=true;for(const c of this.controllers)c.abort();await Promise.allSettled([...this.reads]);}
}
