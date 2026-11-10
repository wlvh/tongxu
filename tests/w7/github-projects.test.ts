import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitHubProjects,GitHubProjectError,currentGitHubReader,type GitHubReaderFactory} from '../../src/github-projects.js';
import {startWorkbench,parseWorkbenchPlan} from '../../src/workbench.js';

const updated='2026-10-30T00:00:00Z';
const repo=(id=1,full_name='fixture/one')=>({id,nodeId:'R_'+id,full_name,description:'Explicit test repository',private:true,archived:false,defaultBranchRef:{name:'main',target:{oid:'a'.repeat(40)}},updated_at:updated});
const issue=(number=9)=>({id:number+100,number,title:'Original <script> text',state:'OPEN',body:'Complete original body\n<script>not executed</script>',author:{login:'fixture-user'},labels:{nodes:[{name:'needs review'}]},updated_at:updated,comments:{totalCount:2}});
const pr=(number=65)=>({...issue(number),title:'Draft change',draft:true,headRefName:'feature',baseRefName:'main',merged_at:null});
const comment=(id:number,body='Complete ordinary comment\n<script>data only</script>')=>({databaseId:id,author:{login:'fixture-user'} as {login:string}|null,createdAt:updated,updatedAt:updated,url:`https://github.com/fixture/one/issues/9#issuecomment-${id}`,body});
const commentConnection=(nodes:ReturnType<typeof comment>[],older=false)=>({totalCount:nodes.length,edges:nodes.map(node=>({cursor:'comment-'+node.databaseId,node})),pageInfo:{hasPreviousPage:older,startCursor:nodes.length?'comment-'+nodes[0]!.databaseId:null}});
function fixture(){
  let user={id:7,login:'fixture-user'},failure:string|null=null;const calls:Array<{operation:string;variables:any}>=[];const replies=new Map<string,{body:unknown;status?:number;headers?:Record<string,string>}>();
  const connection=(nodes:any[])=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
  const factory:GitHubReaderFactory=async()=>({query:async(operation,variables,signal)=>{
    if(signal.aborted)throw new GitHubProjectError('github_read_cancelled');calls.push({operation,variables});if(failure)throw new GitHubProjectError(failure);
    const selected=variables.id==='R_2'?repo(2,'fixture/two'):repo();
    const value=operation==='projects'?{account:{...user,projects:connection([repo(),repo(2,'fixture/two')])}}:{account:user,repository:{...selected,...(operation==='issue_comments'||operation==='pull_comments'?{item:{number:variables.number,comments:commentConnection([comment(1)])}}:operation==='issue'||operation==='pull'?{item:operation==='issue'?issue(variables.number):pr(variables.number)}:{items:connection(operation==='issues'?[issue()]:[pr()])})}};
    const override=replies.get(operation);return {status:override?.status??200,headers:override?.headers??{},body:JSON.stringify(override?override.body:{data:value}),provenance:'gh-http-body'};
  }});
  return {factory,calls,replies,setUser:(id:number)=>{user={id,login:'fixture-'+id};},setFailure:(value:string|null)=>{failure=value;}};
}
const url=(path:string)=>new URL('http://127.0.0.1'+path);
test('current account discovers paginated accessible projects; Issues exclude PRs and detail returns the complete original body',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);f.replies.set('projects',{body:{data:{account:{id:7,login:'fixture-user',projects:{nodes:[repo()],pageInfo:{hasNextPage:true,endCursor:'next-page'}}}}}});
  const list=await client.read(url('/api/github/projects')) as any;assert.equal(list.connection.account.id,7);assert.equal(list.hasNext,true);assert.equal(list.repositories[0].url,'https://github.com/fixture/one');
  await client.read(url('/api/github/projects?page=2&account=7&cursor='+encodeURIComponent(list.nextCursor)));const items=await client.read(url('/api/github/repositories/1/issues?account=7')) as any;assert.deepEqual(items.items.map((x:any)=>x.number),[9]);assert.equal(items.readOnly,true);assert.equal(items.modelInputs,0);
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
  const comments=await(await get('/api/github/repositories/1/issues/9/comments?account=7')).json() as any;assert.equal(comments.comments[0].body,comment(1).body);assert.equal(comments.readOnly,true);
  assert.equal((await get('/api/github/projects?extra=1')).status,503);assert.equal(parseWorkbenchPlan(Buffer.from(JSON.stringify(plan))).githubProjects,true);
});

test('ordinary Issue and PR comments preserve full sources and reverse-page toward older comments',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);
  const reply=(kind:'issue_comments'|'pull_comments',nodes:ReturnType<typeof comment>[],older=false)=>f.replies.set(kind,{body:{data:{account:{id:7,login:'fixture-user'},repository:{...repo(),item:{number:kind==='issue_comments'?9:65,comments:commentConnection(nodes,older)}}}}});
  await client.read(url('/api/github/projects'));
  reply('issue_comments',[comment(4),{...comment(5),author:null}],true);
  const first=await client.read(url('/api/github/repositories/1/issues/9/comments?account=7')) as any;
  assert.deepEqual(first.comments.map((c:any)=>c.id),[5,4]);assert.equal(first.comments[0].author,null);
  assert.equal(first.comments[1].body,comment(4).body);assert.equal(first.comments[1].createdAt,updated);assert.equal(first.comments[1].updatedAt,updated);
  assert.equal(first.comments[1].url,comment(4).url);assert.equal(first.comments[1].bodyOmission,null);
  assert.equal(first.nextCursor,'comment-4');assert.equal(first.order,'newest_created_first');assert.equal(first.livePagesMayChange,true);
  reply('issue_comments',[comment(1),comment(2),comment(3)]);
  const last=await client.read(url('/api/github/repositories/1/issues/9/comments?account=7&page=2&cursor='+first.nextCursor)) as any;
  assert.deepEqual(last.comments.map((c:any)=>c.id),[3,2,1]);assert.equal(last.hasNext,false);assert.equal(f.calls.at(-1)!.variables.before,'comment-4');
  reply('pull_comments',[{...comment(6),url:'https://github.com/fixture/one/pull/65#issuecomment-6'}]);
  const pull=await client.read(url('/api/github/repositories/1/pulls/65/comments?account=7')) as any;assert.equal(pull.comments[0].url,'https://github.com/fixture/one/pull/65#issuecomment-6');assert.equal(pull.kind,'pulls');
  reply('issue_comments',[]);const empty=await client.read(url('/api/github/repositories/1/issues/9/comments?account=7')) as any;assert.deepEqual(empty.comments,[]);assert.equal(empty.hasNext,false);assert.equal(empty.totalCount,0);
  await client.close();
});

test('comment cursors stay within account, repository, kind and item, and malformed pages remain failures',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);await client.read(url('/api/github/projects'));
  const body=(connection:any)=>({data:{account:{id:7,login:'fixture-user'},repository:{...repo(),item:{number:9,comments:connection}}}});
  f.replies.set('issue_comments',{body:body(commentConnection([comment(5)],true))});
  const first=await client.read(url('/api/github/repositories/1/issues/9/comments?account=7')) as any,before=f.calls.length;
  for(const path of [
    '/api/github/repositories/1/issues/10/comments?account=7&page=2&cursor=comment-5',
    '/api/github/repositories/1/pulls/9/comments?account=7&page=2&cursor=comment-5',
    '/api/github/repositories/2/issues/9/comments?account=7&page=2&cursor=comment-5',
    '/api/github/repositories/1/issues/9/comments?account=8&page=2&cursor=comment-5',
    '/api/github/repositories/1/issues/9/comments?account=7&page=2&cursor=guessed',
    '/api/github/repositories/1/issues/9/comments?account=7&state=all',
    '/api/github/repositories/1/issues/9/comments?account=7&page=1&page=2'
  ])await assert.rejects(client.read(url(path)),/github_/);
  assert.equal(f.calls.length,before);
  for(const bad of [{...comment(5),url:'https://elsewhere.example/comment'}, {...comment(5),body:null}, {...comment(5),author:{}}, {...comment(5),createdAt:'invalid'}]){
    f.replies.set('issue_comments',{body:body(commentConnection([bad as any]))});await assert.rejects(client.read(url('/api/github/repositories/1/issues/9/comments?account=7')),/response_invalid/);
  }
  f.replies.set('issue_comments',{body:{...body(commentConnection([])),errors:[{type:'FORBIDDEN'}]}});await assert.rejects(client.read(url('/api/github/repositories/1/issues/9/comments?account=7')),/access_denied/);
  f.replies.delete('issue_comments');f.setUser(8);await assert.rejects(client.read(url('/api/github/repositories/1/issues/9/comments?account=7')),/account_changed/);await client.read(url('/api/github/projects'));
  await assert.rejects(client.read(url('/api/github/repositories/1/issues/9/comments?account=8&page=2&cursor='+first.nextCursor)),/page_not_discovered/);
  await client.close();
});

test('comment page byte limits defer whole older comments without gaps and identify a single omitted body',async()=>{
  const f=fixture(),base=await f.factory(new AbortController().signal),all=Array.from({length:5},(_,i)=>comment(i+1,'中文🙂'.repeat(4000)));
  const factory:GitHubReaderFactory=async()=>({query:async(op,variables,signal)=>{
    if(op!=='issue_comments')return base.query(op,variables,signal);
    const before=variables.before?Number(variables.before.slice('comment-'.length)):6,nodes=all.filter(c=>c.databaseId<before);
    return {status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:{account:{id:7,login:'fixture-user'},repository:{...repo(),item:{number:9,comments:{...commentConnection(nodes),totalCount:all.length}}}}})};
  }});
  const client=new GitHubProjects(factory);await client.read(url('/api/github/projects'));
  const seen:number[]=[];let page=1,cursor:string|null=null,first=true;
  do{
    const result=await client.read(url('/api/github/repositories/1/issues/9/comments?account=7&page='+page+(cursor?'&cursor='+cursor:''))) as any;
    if(first){assert.equal(result.deferredBySize,true);assert.equal(result.nextCursor,'comment-4');first=false;}
    assert.ok(Buffer.byteLength(JSON.stringify({tool:'tongxu_project_comments',arguments:{kind:'issues',number:9,page,cursor},observedAt:updated,data:result,toolBudget:{limit:24,used:page,remaining:24-page}}))<128*1024);
    for(const c of result.comments){seen.push(c.id);assert.equal(c.body,all[c.id-1]!.body);assert.equal(c.bodyOmission,null);}
    cursor=result.nextCursor;page++;
  }while(cursor);
  assert.deepEqual(seen,[5,4,3,2,1]);await client.close();
  const g=fixture(),other=new GitHubProjects(g.factory);await other.read(url('/api/github/projects'));
  const huge=comment(1,'中文🙂'.repeat(20000));g.replies.set('issue_comments',{body:{data:{account:{id:7,login:'fixture-user'},repository:{...repo(),item:{number:9,comments:commentConnection([huge])}}}}});
  const result=await other.read(url('/api/github/repositories/1/issues/9/comments?account=7')) as any;
  assert.equal(result.hasNext,false);assert.equal(result.comments[0].body,null);assert.deepEqual(result.comments[0].bodyOmission,{reason:'comment_exceeds_page_size_limit',bodyBytes:Buffer.byteLength(huge.body)});assert.equal(result.comments[0].url,huge.url);await other.close();
});

test('shutdown cancels an in-flight comment query and no later page is dispatched',async()=>{
  const f=fixture(),base=await f.factory(new AbortController().signal);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const factory:GitHubReaderFactory=async()=>({query:async(op,variables,signal)=>{
    if(op!=='issue_comments')return base.query(op,variables,signal);
    entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new GitHubProjectError('github_read_cancelled')),{once:true}));
  }});
  const client=new GitHubProjects(factory);await client.read(url('/api/github/projects'));
  const pending=client.read(url('/api/github/repositories/1/issues/9/comments?account=7')),rejected=assert.rejects(pending,/cancelled/);await ready;await client.close();await rejected;
  await assert.rejects(client.read(url('/api/github/repositories/1/issues/9/comments?account=7&page=2&cursor=unknown')),/reader_closed/);
});

test('a delayed comment page cannot restore a cursor after switching accounts away and back',async()=>{
  const f=fixture(),base=await f.factory(new AbortController().signal);let release!:(value:any)=>void;
  const factory:GitHubReaderFactory=async()=>({query:async(op,variables,signal)=>op==='issue_comments'?new Promise(r=>{release=r;}):base.query(op,variables,signal)});
  const client=new GitHubProjects(factory);await client.read(url('/api/github/projects'));
  const pending=client.read(url('/api/github/repositories/1/issues/9/comments?account=7')),refused=assert.rejects(pending,/read_superseded/);await new Promise(r=>setImmediate(r));
  f.setUser(8);await client.read(url('/api/github/projects'));f.setUser(7);await client.read(url('/api/github/projects'));
  release({status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:{account:{id:7,login:'fixture-user'},repository:{...repo(),item:{number:9,comments:commentConnection([comment(5)],true)}}}})});await refused;
  await assert.rejects(client.read(url('/api/github/repositories/1/issues/9/comments?account=7&page=2&cursor=comment-5')),/page_not_discovered/);await client.close();
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


test('two browser traversals continue from their own returned position even after another first-page refresh',async()=>{
  let starts=0;const afters:any[]=[];const factory:GitHubReaderFactory=async()=>({query:async(op,variables)=>{
    assert.equal(op,'projects');afters.push(variables.after);const first=variables.after===null,which=first?++starts:variables.after==='cursor-a'?2:3;
    return {status:200,headers:{},provenance:'gh-http-body',body:JSON.stringify({data:{account:{id:7,login:'fixture',projects:{nodes:[repo(which,'fixture/repo'+which)],pageInfo:{hasNextPage:first,endCursor:first?(which===1?'cursor-a':'cursor-b'):null}}}}})};
  }});
  const client=new GitHubProjects(factory);const a=await client.read(url('/api/github/projects')) as any;await client.read(url('/api/github/projects'));
  const continued=await client.read(url('/api/github/projects?page=2&account=7&cursor='+encodeURIComponent(a.nextCursor))) as any;assert.equal(afters.at(-1),'cursor-a');assert.equal(continued.repositories[0].id,2);assert.equal(a.repositories[0].id,1);await client.close();
});


test('pagination rejects guessed and cross-list cursors instead of silently using another view position',async()=>{
  const f=fixture(),client=new GitHubProjects(f.factory);f.replies.set('projects',{body:{data:{account:{id:7,login:'fixture',projects:{nodes:[repo()],pageInfo:{hasNextPage:true,endCursor:'project-position'}}}}}});await client.read(url('/api/github/projects'));
  const before=f.calls.length;for(const path of ['/api/github/projects?page=2&account=7','/api/github/projects?page=2&account=7&cursor=guessed','/api/github/projects?cursor=project-position','/api/github/repositories/1/issues?account=7&page=2&cursor=project-position'])await assert.rejects(client.read(url(path)),/page_not_discovered/);assert.equal(f.calls.length,before);
  await client.read(url('/api/github/projects?page=2&account=7&cursor=project-position'));assert.equal(f.calls.at(-1)!.variables.after,'project-position');await client.close();
});
