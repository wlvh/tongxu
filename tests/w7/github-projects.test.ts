import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitHubProjects,GitHubProjectError,type GitHubReaderFactory} from '../../src/github-projects.js';
import {startWorkbench,parseWorkbenchPlan} from '../../src/workbench.js';

const updated='2026-10-30T00:00:00Z';
const repo=(id=1,full_name='fixture/one')=>({id,full_name,description:'Explicit test repository',private:true,archived:false,default_branch:'main',updated_at:updated});
const issue=(number=9)=>({id:number+100,number,title:'Original <script> text',state:'open',body:'Complete original body\n<script>not executed</script>',user:{login:'fixture-user'},labels:[{name:'needs review'}],updated_at:updated,comments:2});
const pr=(number=65)=>({...issue(number),title:'Draft change',draft:true,head:{ref:'feature'},base:{ref:'main'},merged_at:null});
function fixture(){
  let user={id:7,login:'fixture-user'},failure:string|null=null;const calls:string[]=[];const replies=new Map<string,{body:unknown;status?:number;headers?:Record<string,string>}>();
  const factory:GitHubReaderFactory=async()=>({get:async(path,signal)=>{
    if(signal.aborted)throw new GitHubProjectError('github_read_cancelled');calls.push(path);if(failure)throw new GitHubProjectError(failure);
    const override=replies.get(path);let value:unknown=path==='user'?user:path.startsWith('user/repos')?[repo(),repo(2,'fixture/two')]:path==='repositories/1'?repo():path==='repositories/2'?repo(2,'fixture/two'):path.includes('/pulls/')?pr():path.includes('/issues/')?issue():path.includes('/pulls?')?[pr()]:path.includes('/issues?')?[issue(),{...issue(65),pull_request:{url:'https://api.github.com/fixture'}}]:null;
    return {status:override?.status??200,headers:override?.headers??{},body:JSON.stringify(override?override.body:value),provenance:'gh-http-body'};
  }});
  return {factory,calls,replies,setUser:(id:number)=>{user={id,login:'fixture-'+id};},setFailure:(value:string|null)=>{failure=value;}};
}
const url=(path:string)=>new URL('http://127.0.0.1'+path);
test('current account discovers paginated accessible projects; Issues exclude PRs and detail returns the complete original body',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory),first='user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=50&page=1';f.replies.set(first,{body:[repo()],headers:{link:'<https://api.github.com/user/repos?page=2>; rel="next"'}});
  const list=await client.read(url('/api/github/projects')) as any;assert.equal(list.connection.account.id,7);assert.equal(list.hasNext,true);assert.equal(list.repositories[0].url,'https://github.com/fixture/one');
  await client.read(url('/api/github/projects?page=2'));const items=await client.read(url('/api/github/repositories/1/issues?account=7')) as any;assert.deepEqual(items.items.map((x:any)=>x.number),[9]);assert.equal(items.readOnly,true);assert.equal(items.modelInputs,0);
  const pulls=await client.read(url('/api/github/repositories/1/pulls?account=7&state=all')) as any;assert.equal(pulls.items[0].draft,true);assert.equal(pulls.items[0].url,'https://github.com/fixture/one/pull/65');
  const detail=await client.read(url('/api/github/repositories/1/issues/9?account=7')) as any;assert.equal(detail.item.body,issue().body);assert.equal(f.calls.some(x=>x.startsWith('https:')),false);await client.close();
});
test('undiscovered repositories, injected routes and invalid pagination cannot cause remote requests',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);
  for(const path of ['/api/github/repositories/3/issues?account=7','/api/github/projects?page=0','/api/github/projects?page=1&page=2','/api/github/projects?url=https://elsewhere','/api/github/projects?page=1001','/api/github/repositories/1/issues?account=7&state=all;delete','/api/github/repositories/1/actions?account=7'])await assert.rejects(client.read(url(path)),/github_/);
  assert.equal(f.calls.length,0);await client.read(url('/api/github/projects'));const before=f.calls.length;await assert.rejects(client.read(url('/api/github/repositories/3/issues?account=7')),/project_not_selected/);assert.equal(f.calls.length,before);await client.close();
});
test('account switch invalidates project selection and does not return the previous private account data',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);await client.read(url('/api/github/projects'));f.setUser(8);
  await assert.rejects(client.read(url('/api/github/repositories/1/issues?account=7')),/account_changed/);
  await assert.rejects(client.read(url('/api/github/repositories/1/issues?account=8')),/project_not_selected/);
  const next=await client.read(url('/api/github/projects')) as any;assert.equal(next.connection.account.id,8);await client.read(url('/api/github/repositories/1/issues?account=8'));await client.close();
});
test('identity changing during a read, missing permission, rate limit and malformed results remain failures, never empty success',async()=>{
  const f=fixture();let users=0;const original=await f.factory(new AbortController().signal);const factory:GitHubReaderFactory=async()=>({get:async(path,signal)=>{if(path==='user'&&++users===2)f.setUser(99);return original.get(path,signal);}});const mixed=new GitHubProjects(factory);await assert.rejects(mixed.read(url('/api/github/projects')),/account_changed/);await mixed.close();
  for(const [status,headers,pattern] of [[401,{},/not_signed_in/],[403,{},/access_denied/],[403,{'x-ratelimit-remaining':'0'},/rate_limited/],[500,{},/service_unavailable/]] as const){const g=fixture();g.replies.set('user',{status,headers,body:{message:'sensitive server details are not exposed'}});const c=new GitHubProjects(g.factory);await assert.rejects(c.read(url('/api/github/projects')),pattern);await c.close();}
  const bad=fixture(),c=new GitHubProjects(bad.factory);bad.replies.set('user',{body:{id:7,login:null}});await assert.rejects(c.read(url('/api/github/projects')),/response_invalid/);await c.close();
});
test('shutdown cancels an outstanding GitHub read and rejects later work',async()=>{
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const factory:GitHubReaderFactory=async()=>({get:async(_path,signal)=>new Promise((_,reject)=>{entered();signal.addEventListener('abort',()=>reject(new GitHubProjectError('github_read_cancelled')),{once:true});})});
  const client=new GitHubProjects(factory),pending=client.read(url('/api/github/projects'));const refused=assert.rejects(pending,/cancelled/);await ready;await client.close();await refused;await assert.rejects(client.read(url('/api/github/projects')),/reader_closed/);
});
test('normal server starts without local task records, requires its key, only reads GitHub and preserves the original local plan',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-github-entry-')));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'plan.json'),plan={schemaVersion:1,kind:'tongxu-local-workbench',title:'Explicit GitHub entry test',goal:'Choose repository then read Issues and PRs',sources:[],githubProjects:true};await writeFile(path,JSON.stringify(plan));
  const f=fixture(),app=await startWorkbench(path,undefined,{githubReader:f.factory});t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)},get=(route:string)=>fetch(u.origin+route,{headers});
  assert.equal(f.calls.length,0);const entry=await(await get('/api/entry')).json() as any;assert.equal(entry.githubProjects,true);assert.equal(entry.hasLocalSources,false);
  assert.equal((await fetch(u.origin+'/api/github/projects')).status,401);assert.equal((await fetch(u.origin+'/api/github/projects',{method:'POST',headers})).status,405);assert.equal((await fetch(u.origin+'/api/github/projects',{headers:{...headers,Origin:'https://elsewhere.example'}})).status,403);assert.equal(f.calls.length,0);
  const projects=await(await get('/api/github/projects')).json() as any;assert.equal(projects.repositories.length,2);const content=await(await get('/api/github/repositories/1/pulls?account=7')).json() as any;assert.equal(content.items[0].number,65);
  assert.equal((await get('/api/github/projects?extra=1')).status,503);assert.equal(parseWorkbenchPlan(Buffer.from(JSON.stringify(plan))).githubProjects,true);
});
test('GitHub bootstrap and reads do not open unavailable legacy queues or controls',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-github-lazy-')));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'plan.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'Separate old history',goal:'Do not require old local sources for GitHub',sources:[{id:'old',title:'Unavailable history',store:join(root,'absent-store'),item:'a'.repeat(64)}],secretary:{path:join(root,'absent-secretary'),sha256:'b'.repeat(64)},githubProjects:true}));
  const f=fixture(),app=await startWorkbench(path,undefined,{githubReader:f.factory});t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)};
  assert.equal((await fetch(u.origin+'/api/github/projects',{headers})).status,200);assert.equal((await fetch(u.origin+'/api/state',{headers})).status,503);assert.equal((await fetch(u.origin+'/api/github/projects',{headers})).status,200);
});
