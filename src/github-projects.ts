import {execFile} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {selectGhExecutable,assertGhExecutableUnchanged} from './gh-executable.js';
import {parseGh} from './transport.js';
import type {Response} from './contract.js';

type Row=Record<string,any>;
type Account={id:number;login:string};
type ProjectQuery='projects'|'project'|'issues'|'pulls'|'issue'|'pull';
export type GitHubProjectReader={query:(operation:ProjectQuery,variables:Row,signal:AbortSignal)=>Promise<Response>};
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
const repoFields='id:databaseId nodeId:id full_name:nameWithOwner description private:isPrivate archived:isArchived defaultBranchRef{name} updated_at:updatedAt';
const itemFields='id:databaseId number title state updated_at:updatedAt author{login} labels(first:50){nodes{name}}';
const pullFields='draft:isDraft merged_at:mergedAt headRefName baseRefName';
const pageFields='pageInfo{hasNextPage endCursor}';
const viewer='account:viewer{id:databaseId login}';
const queries={
 project:`query TongxuProject($id:ID!){${viewer} repository:node(id:$id){...on Repository{${repoFields}}}}`,
 projects:`query TongxuProjects($after:String){account:viewer{id:databaseId login projects:repositories(first:50,after:$after,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${repoFields}} ${pageFields}}}}`,
 issues:`query TongxuIssues($id:ID!,$after:String,$states:[IssueState!]){${viewer} repository:node(id:$id){...on Repository{${repoFields} items:issues(first:30,after:$after,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${itemFields}} ${pageFields}}}}}`,
 pulls:`query TongxuPulls($id:ID!,$after:String,$states:[PullRequestState!]){${viewer} repository:node(id:$id){...on Repository{${repoFields} items:pullRequests(first:30,after:$after,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${itemFields} ${pullFields}} ${pageFields}}}}}`,
 issue:`query TongxuIssue($id:ID!,$number:Int!){${viewer} repository:node(id:$id){...on Repository{${repoFields} item:issue(number:$number){${itemFields} body comments{totalCount}}}}}`,
 pull:`query TongxuPull($id:ID!,$number:Int!){${viewer} repository:node(id:$id){...on Repository{${repoFields} item:pullRequest(number:$number){${itemFields} ${pullFields} body comments{totalCount}}}}}`
};
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
  try{selected=await selectGhExecutable(path!,'0'.repeat(64),signal);}catch{fail(signal.aborted?'github_read_cancelled':'github_cli_capabilities_unavailable');}
  if(signal.aborted)fail('github_read_cancelled');
  return {query:async(operation,variables,signal)=>{
    if(!Object.hasOwn(queries,operation))fail('github_read_endpoint_denied');
    assertGhExecutableUnchanged(selected);
    const env:NodeJS.ProcessEnv={...process.env,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GH_PAGER:'cat',PAGER:'cat'};delete env.GH_DEBUG;delete env.GH_FORCE_TTY;
    const args=['api','--hostname','github.com','--method','POST','--include','-H','Accept: application/vnd.github+json','graphql','--input','-'];
    // GraphQL uses POST for a fixed query document; no mutation text or
    // arbitrary endpoint/operation is accepted from the browser or a report.
    const raw=await new Promise<string>((resolve,reject)=>{
      let ended=false,result:{error:Error|null;stdout:string}|undefined;
      const finish=()=>{if(!ended||!result)return;result.error?reject(result.error):resolve(result.stdout);};
      const child=execFile(selected.realpath,args,{env,signal,killSignal:'SIGKILL',timeout:20000,maxBuffer:8*1024*1024},(error,stdout,stderr)=>{
        const problem=signal.aborted?new GitHubProjectError('github_read_cancelled'):error&&!/^HTTP\/\S+\s+\d+/.test(stdout)?new GitHubProjectError((error as any).code==='ENOENT'?'github_cli_missing':/gh auth login|not logged|authentication required/i.test(stderr)?'github_not_signed_in':'github_connection_unavailable'):null;
        result={error:problem,stdout};finish();
      });
      child.once('close',()=>{ended=true;finish();});child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify({query:queries[operation],variables}));
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
  let value:any;try{value=JSON.parse(r.body);}catch{return fail();}
  if(value?.errors?.length){
    const types=value.errors.map((e:Row)=>e.type);
    fail(types.includes('RATE_LIMITED')?'github_rate_limited':types.includes('FORBIDDEN')?'github_access_denied':types.includes('NOT_FOUND')?'github_repository_unavailable':'github_response_invalid');
  }
  if(!value?.data||typeof value.data!=='object')fail();return value.data;

}
function account(value:Row):Account{
  if(!positive(value?.id)||!bounded(value.login,128)||!value.login)fail();return {id:value.id,login:value.login};
}
function repository(v:Row){
  if(v===null)fail('github_repository_unavailable');
  v={...v,default_branch:v?.defaultBranchRef?.name??null};
  if(!positive(v?.id)||!bounded(v.nodeId,512)||!v.nodeId||!name.test(v.full_name??'')||typeof v.private!=='boolean'||typeof v.archived!=='boolean'||!(v.description===null||bounded(v.description,16384))||!(v.default_branch===null||bounded(v.default_branch,256))||!timestamp(v.updated_at))fail();
  return {id:v.id,nodeId:v.nodeId as string,fullName:v.full_name as string,description:v.description??'',private:v.private,archived:v.archived,defaultBranch:v.default_branch??null,updatedAt:v.updated_at as string,url:'https://github.com/'+v.full_name};
}
function entry(v:Row,repo:string,kind:'issues'|'pulls',full=false){
  v={...v,state:v?.state==='MERGED'?'closed':v?.state?.toLowerCase(),user:v?.author,labels:v?.labels?.nodes,head:{ref:v?.headRefName},base:{ref:v?.baseRefName},comments:v?.comments?.totalCount};
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
  private repositories=new Map<number,ReturnType<typeof repository>>();
  private projectCursors=new Map<number,Set<string>>();
  private itemCursors=new Map<string,Map<number,Set<string>>>();
  private epoch=0;
  private closed=false;
  private controllers=new Set<AbortController>();
  private reads=new Set<Promise<unknown>>();
  constructor(private reader:GitHubReaderFactory=currentGitHubReader){}
  selection(accountId:number,repositoryId:number){
    const repo=this.repositories.get(repositoryId);
    if(this.closed||!positive(accountId)||!positive(repositoryId)||this.identity?.id!==accountId||!repo)fail('github_project_not_selected');
    return {account:{...this.identity!},repository:{...repo!},generation:this.epoch};
  }
  async confirmSelection(accountId:number,repositoryId:number){
    this.selection(accountId,repositoryId);
    await this.read(new URL('http://127.0.0.1/api/github/repositories/'+repositoryId+'?account='+accountId));
    return this.selection(accountId,repositoryId);
  }
  assertSelection(selection:ReturnType<GitHubProjects['selection']>){
    const current=this.selection(selection.account.id,selection.repository.id);
    if(current.generation!==selection.generation||current.repository.nodeId!==selection.repository.nodeId||current.repository.fullName!==selection.repository.fullName)fail('github_project_selection_changed');
  }
  private changed(){this.identity=null;this.repositories.clear();this.projectCursors=new Map();this.itemCursors.clear();this.epoch++;}
  async read(url:URL):Promise<unknown>{
    if(this.closed)fail('github_reader_closed');
    const controller=new AbortController(),epoch=this.epoch;this.controllers.add(controller);
    const promise=this.readCurrent(url,controller.signal,epoch);this.reads.add(promise);
    try{return await promise;}catch(e){
      // An ended old-account request cannot invalidate a newly discovered one.
      if(epoch===this.epoch&&e instanceof GitHubProjectError&&['github_not_signed_in','github_account_changed'].includes(e.message))this.changed();throw e;
    }finally{this.reads.delete(promise);this.controllers.delete(controller);}
  }
  private async readCurrent(url:URL,signal:AbortSignal,epoch:number){
    const list=url.pathname==='/api/github/projects',match=/^\/api\/github\/repositories\/([1-9]\d*)(?:\/(issues|pulls)(?:\/([1-9]\d*))?)?$/.exec(url.pathname);
    if(!list&&!match)fail('github_route_not_found');
    queryKeys(url,list?['page','account','cursor']:!match![2]||match![3]?['account']:['account','page','state','cursor']);
    const page=queryNumber(url,'page',1);if(page>1000)fail('github_page_limit');
    const expected=list&&page===1?null:queryNumber(url,'account'),repoId=match?Number(match[1]):null,kind=match?.[2] as 'issues'|'pulls'|undefined,state=url.searchParams.get('state')??'open';
    if(!['open','closed','all'].includes(state))fail('github_query_invalid');
    if(expected!==null&&this.identity?.id!==expected)fail('github_project_not_selected');
    const selected=repoId?this.repositories.get(repoId):undefined;
    if(!list&&(!positive(repoId)||!selected))fail('github_project_not_selected');
    const group=list?'projects':`${repoId}:${kind}:${state}`;
    const cursors=list?this.projectCursors:this.itemCursors.get(group);
    const cursor=url.searchParams.get('cursor');
    if(page===1&&cursor!==null||page>1&&(!bounded(cursor,2048)||!cursor||!cursors?.get(page)?.has(cursor)))fail('github_page_not_discovered');
    const number=match?.[3]?Number(match[3]):null;if(number!==null&&(!positive(number)||number>2147483647))fail('github_query_invalid');
    const operation:ProjectQuery=list?'projects':!kind?'project':number!==null?(kind==='issues'?'issue':'pull'):kind!;
    const variables=list?{after:cursor}:!kind?{id:selected!.nodeId}:number!==null?{id:selected!.nodeId,number}:{id:selected!.nodeId,after:cursor,states:state==='all'?null:state==='open'?['OPEN']:kind==='pulls'?['CLOSED','MERGED']:['CLOSED']};
    const reader=await this.reader(signal);if(signal.aborted)fail('github_read_cancelled');
    const data=decode(await reader.query(operation,variables,signal)),observed=account(data.account);
    // Viewer identity and all returned data share this ONE authenticated query.
    if(expected!==null&&observed.id!==expected)fail('github_account_changed');
    if(epoch!==this.epoch&&this.identity?.id!==observed.id)fail('github_read_superseded');
    let result:Row,connection:any,newRepositories:ReturnType<typeof repository>[]=[];
    if(list){connection=data.account.projects;if(!Array.isArray(connection?.nodes)||connection.nodes.length>50)fail();newRepositories=connection.nodes.map(repository);result={repositories:newRepositories,page};}
    else{
      const repo=repository(data.repository);if(repo.id!==repoId||repo.nodeId!==selected!.nodeId)fail('github_repository_identity_changed');newRepositories=[repo];
      if(!kind)result={repository:repo};
      else if(number!==null){if(!data.repository.item)fail('github_repository_unavailable');const item=entry(data.repository.item,repo.fullName,kind!,true);if(item.number!==number)fail();result={repository:repo,kind,item};}
      else{connection=data.repository.items;if(!Array.isArray(connection?.nodes)||connection.nodes.length>30)fail();result={repository:repo,kind,state,page,items:connection.nodes.map((x:Row)=>entry(x,repo.fullName,kind!))};}
    }
    if(connection){const info=connection.pageInfo;if(typeof info?.hasNextPage!=='boolean'||!(info.endCursor===null||bounded(info.endCursor,2048))||info.hasNextPage&&!info.endCursor)fail();result.hasNext=info.hasNextPage;result.nextCursor=info.hasNextPage?info.endCursor:null;}
    if(signal.aborted)fail('github_read_cancelled');
    if(this.identity?.id!==observed.id){this.changed();this.identity=observed;}
    for(const repo of newRepositories)this.repositories.set(repo.id,repo);
    if(connection){
      const destination=list?this.projectCursors:this.itemCursors.get(group)??new Map<number,Set<string>>();
      // Each view sends its own returned position. Another first-page read
      // must not replace it. Bound retention; expired positions fail explicitly.
      if(connection.pageInfo.hasNextPage){
        const positions=destination.get(page+1)??new Set<string>();positions.add(connection.pageInfo.endCursor);
        while(positions.size>64)positions.delete(positions.values().next().value!);
        destination.set(page+1,positions);
      }
      if(!list)this.itemCursors.set(group,destination);
    }
    return {connection:{status:'connected',account:observed,checkedAt:now()},...result,source:'github_live_read',readOnly:true,modelInputs:0};
  }
  async close(){this.closed=true;for(const c of this.controllers)c.abort();await Promise.allSettled([...this.reads]);}
}
