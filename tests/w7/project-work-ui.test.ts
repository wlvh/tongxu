import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page} from './github-projects-ui-fixture.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const find=(node:any,text:string):any=>node?.tag==='button'&&node.textContent===text?node:(node?.children??[]).map((c:any)=>find(c,text)).find(Boolean);
async function workPage(){const p=await page();p.run(await readFile(new URL('../../../web/workbench/project-work.js',import.meta.url),'utf8'));p.run("entryInfo={githubProjects:true,projectWork:true};gh.selected={id:1,nodeId:'R1',fullName:'fixture/repo1'};state={tasks:[],project:{repository:gh.selected}};projectWorkData().ready=true;projectWorkData().available=true;");return p;}
const summary={id:'22222222-2222-4222-8222-222222222222',conversationId:'11111111-1111-4111-8111-111111111111',issue:{number:201,title:'A useful issue'},version:0,stage:'draft',updatedAt:'2026-11-12T00:00:00Z',active:false};
const list={available:true,settings:null,works:[summary]},detail={draft:{...summary,goal:'original goal',events:[]},execution:null};
test('empty project offers a usable start path and an Issue detail opens the same saved work without a POST',async()=>{
  const p=await workPage(),home=p.run('overview()');assert.ok(find(home,'从 Issue 开始一项工作'));
  p.run('projectWorkData().works='+JSON.stringify([summary]));const pending=p.run("openGithubItem('issues',{number:201,title:'A useful issue'})");
  p.calls[0]!.resolve({repository:{fullName:'fixture/repo1'},item:{number:201,body:'original issue',url:'https://github.com/fixture/repo1/issues/201'}});await pending;
  const button=find(p.nodes.get('report-meta'),'交给同序准备');assert.ok(button);button.onclick();assert.equal(p.run('view'),'project-work');assert.equal(p.run('projectWorkData().selected'),summary.id);assert.equal(p.fetchCalls.length,1);assert.equal(p.fetchCalls[0]!.options.method,undefined);
  p.fetchCalls[0]!.resolve({ok:true,status:200,json:async()=>list});await flush();p.fetchCalls[1]!.resolve({ok:true,status:200,json:async()=>detail});await flush();assert.equal(p.fetchCalls.filter(c=>c.options.method==='POST').length,0);
});
test('double create uses one request, and a late create reply cannot select a conversation after an ABA project switch',async()=>{
  const p=await workPage();p.run("projectWorkData().issue='201';projectWorkData().goal='keep this';view='project-work';renderProjectWork();render=()=>{};");
  const button=find(p.nodes.get('content'),'保存或打开这项工作');assert.ok(button);const first=button.onclick();const second=button.onclick();assert.equal(p.fetchCalls.length,1);assert.equal(p.fetchCalls[0]!.options.method,'POST');const body=JSON.parse(p.fetchCalls[0]!.options.body);assert.equal(body.issueNumber,201);assert.equal(body.goal,'keep this');
  p.run("let changedConversation=false;chooseProjectConversation=()=>{changedConversation=true;};gh.epoch++;gh.selected={id:2,nodeId:'R2',fullName:'fixture/repo2'};gh.epoch++;gh.selected={id:1,nodeId:'R1',fullName:'fixture/repo1'};");
  p.fetchCalls[0]!.resolve({ok:true,status:200,json:async()=>({...summary,conversationId:'33333333-3333-4333-8333-333333333333'})});await Promise.all([first,second]);assert.equal(p.run('changedConversation'),false);assert.equal(p.fetchCalls.length,1);assert.equal(p.run('projectWorkData().selected'),null);
});
test('action failure remains after subsequent successful reads and missing location does not become an empty history',async()=>{
  const p=await workPage();p.run("render=()=>{};projectWorkData().selected="+JSON.stringify(summary.id));
  const action=p.run("projectWorkAction(()=>projectWorkPost('/'+projectWorkData().selected+'/prepare',{goal:'original'}))");p.fetchCalls[0]!.resolve({ok:false,status:503,json:async()=>({error:'project_work_repository_location_required'})});await action;assert.match(p.run('projectWorkData().actionError'),/草案已经保留/);
  const refresh=p.run('loadProjectWorks(true)');p.fetchCalls[1]!.resolve({ok:true,status:200,json:async()=>({...list,works:[{...summary,stage:'needs_input',problem:'project_work_repository_location_required'}]})});await flush();p.fetchCalls[2]!.resolve({ok:true,status:200,json:async()=>detail});await refresh;
  assert.match(p.run('projectWorkData().actionError'),/草案已经保留/);assert.equal(p.run('projectWorkData().works.length'),1);assert.equal(p.run('projectWorkData().selected'),summary.id);
});
