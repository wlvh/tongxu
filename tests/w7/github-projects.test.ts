import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitHubProjects,GitHubProjectError,currentGitHubReader,type GitHubReaderFactory} from '../../src/github-projects.js';
import {startWorkbench,parseWorkbenchPlan} from '../../src/workbench.js';

const updated='2026-10-30T00:00:00Z';
const repo=(id=1,full_name='fixture/one')=>({id,nodeId:'R_'+id,full_name,description:'Explicit test repository',private:true,archived:false,defaultBranchRef:{name:'main'},updated_at:updated});
const issue=(number=9)=>({id:number+100,number,title:'Original <script> text',state:'OPEN',body:'Complete original body\n<script>not executed</script>',author:{login:'fixture-user'},labels:{nodes:[{name:'needs review'}]},updated_at:updated,comments:{totalCount:2}});
const pr=(number=65)=>({...issue(number),title:'Draft change',draft:true,headRefName:'feature',baseRefName:'main',merged_at:null});
function fixture(){
  let user={id:7,login:'fixture-user'},failure:string|null=null;const calls:Array<{operation:string;variables:any}>=[];const replies=new Map<string,{body:unknown;status?:number;headers?:Record<string,string>}>();
  const connection=(nodes:any[])=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
  const factory:GitHubReaderFactory=async()=>({query:async(operation,variables,signal)=>{
    if(signal.aborted)throw new GitHubProjectError('github_read_cancelled');calls.push({operation,variables});if(failure)throw new GitHubProjectError(failure);
    const selected=variables.id==='R_2'?repo(2,'fixture/two'):repo();
    const value=operation==='projects'?{account:{...user,projects:connection([repo(),repo(2,'fixture/two')])}}:{account:user,repository:{...selected,...(operation==='issue'||operation==='pull'?{item:operation==='issue'?issue(variables.number):pr(variables.number)}:{items:connection(operation==='issues'?[issue()]:[pr()])})}};
    const override=replies.get(operation);return {status:override?.status??200,headers:override?.headers??{},body:JSON.stringify(override?override.body:{data:value}),provenance:'gh-http-body'};
  }});
  return {factory,calls,replies,setUser:(id:number)=>{user={id,login:'fixture-'+id};},setFailure:(value:string|null)=>{failure=value;}};
}
const url=(path:string)=>new URL('http://127.0.0.1'+path);
test('current account discovers paginated accessible projects; Issues exclude PRs and detail returns the complete original body',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);f.replies.set('projects',{body:{data:{account:{id:7,login:'fixture-user',projects:{nodes:[repo()],pageInfo:{hasNextPage:true,endCursor:'next-page'}}}}}});
  const list=await client.read(url('/api/github/projects')) as any;assert.equal(list.connection.account.id,7);assert.equal(list.hasNext,true);assert.equal(list.repositories[0].url,'https://github.com/fixture/one');
  await client.read(url('/api/github/projects?page=2&account=7'));const items=await client.read(url('/api/github/repositories/1/issues?account=7')) as any;assert.deepEqual(items.items.map((x:any)=>x.number),[9]);assert.equal(items.readOnly,true);assert.equal(items.modelInputs,0);
  const pulls=await client.read(url('/api/github/repositories/1/pulls?account=7&state=all')) as any;assert.equal(pulls.items[0].draft,true);assert.equal(pulls.items[0].url,'https://github.com/fixture/one/pull/65');
  const detail=await client.read(url('/api/github/repositories/1/issues/9?account=7')) as any;assert.equal(detail.item.body,issue().body);assert.equal(f.calls.every(x=>['projects','issues','pulls','issue','pull'].includes(x.operation)),true);await client.close();
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
test('account and data belong to the same authenticated query, while partial GraphQL errors never become empty success',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);f.setUser(8);const first=await client.read(url('/api/github/projects')) as any;assert.equal(first.connection.account.id,8);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.operation,'projects');f.setUser(7);
  await assert.rejects(client.read(url('/api/github/repositories/1/issues?account=8')),/account_changed/);assert.equal(f.calls.length,2);await client.close();
  for(const [status,headers,pattern] of [[401,{},/not_signed_in/],[403,{},/access_denied/],[403,{'x-ratelimit-remaining':'0'},/rate_limited/],[500,{},/service_unavailable/]] as const){const g=fixture();g.replies.set('projects',{status,headers,body:{message:'sensitive server details are not exposed'}});const c=new GitHubProjects(g.factory);await assert.rejects(c.read(url('/api/github/projects')),pattern);await c.close();}
  const bad=fixture(),c=new GitHubProjects(bad.factory);bad.replies.set('projects',{body:{data:{account:{id:7,login:'fixture'}},errors:[{type:'FORBIDDEN',message:'private details'}]}});await assert.rejects(c.read(url('/api/github/projects')),/access_denied/);await c.close();
});
test('a delayed old-account error cannot erase the new account project selection',async()=>{
  const f=fixture(),base=await f.factory(new AbortController().signal);let release!:(value:any)=>void,block=true;
  const factory:GitHubReaderFactory=async()=>({query:async(op,variables,signal)=>{if(op==='issues'&&block){block=false;return new Promise(r=>{release=r;});}return base.query(op,variables,signal);}});
  const client=new GitHubProjects(factory);await client.read(url('/api/github/projects'));const pending=client.read(url('/api/github/repositories/1/issues?account=7')),rejected=assert.rejects(pending,/not_signed_in|account_changed|superseded/);await new Promise(r=>setImmediate(r));
  f.setUser(8);await client.read(url('/api/github/projects'));release({status:401,body:'{}',headers:{},provenance:'gh-http-body'});await rejected;
  const current=await client.read(url('/api/github/repositories/1/pulls?account=8')) as any;assert.equal(current.connection.account.id,8);assert.equal(current.items[0].number,65);await client.close();
});
test('shutdown cancels an outstanding GitHub read and rejects later work',async()=>{
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const factory:GitHubReaderFactory=async()=>({query:async(_operation,_variables,signal)=>new Promise((_,reject)=>{entered();signal.addEventListener('abort',()=>reject(new GitHubProjectError('github_read_cancelled')),{once:true});})});
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


for(const phase of ['version','help'])test('shutdown during gh '+phase+' capability check waits for the child to end and starts no later probe',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-gh-probe-cancel-'))),trace=join(root,'trace.json'),binary=join(root,'gh');t.after(()=>rm(root,{recursive:true,force:true}));
  const code=`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),phase=args.includes('--version')?'version':args.includes('--help')?'help':'unexpected';fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({phase,pid:process.pid})+'\\n');if(phase===${JSON.stringify(phase)})setInterval(()=>{},1000);else if(phase==='version')console.log('gh version 999.0.0');else console.log('--hostname --method --include --input --header --raw-field');`;
  await writeFile(binary,code,{mode:0o700});const old=process.env.TONGXU_GH;process.env.TONGXU_GH=binary;t.after(()=>{if(old===undefined)delete process.env.TONGXU_GH;else process.env.TONGXU_GH=old;});
  const client=new GitHubProjects(currentGitHubReader);t.after(()=>client.close());const pending=client.read(url('/api/github/projects')),refused=assert.rejects(pending,/read_cancelled/);let rows:any[]=[];
  for(let i=0;i<200;i++){try{rows=(await readFile(trace,'utf8')).trim().split('\n').map(x=>JSON.parse(x));if(rows.some(x=>x.phase===phase))break;}catch{}await new Promise(r=>setTimeout(r,10));}
  assert.equal(rows.some(x=>x.phase===phase),true);const start=Date.now();await client.close();await refused;assert.ok(Date.now()-start<3000);const final=(await readFile(trace,'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.deepEqual(final.map(x=>x.phase),phase==='version'?['version']:['version','help']);
  for(const row of final)assert.throws(()=>process.kill(row.pid,0),(error:any)=>error.code==='ESRCH');
});
