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

test('an explicit second Issue never inherits the prior work or goal; generic, same Issue, direct ID and new work keep their own selection',async()=>{
  const p=await workPage();p.run('projectWorkData().works='+JSON.stringify([summary])+';render=()=>{};openProjectWork(202);');
  p.fetchCalls[0]!.resolve({ok:true,status:200,json:async()=>list});await flush();
  assert.equal(p.fetchCalls.length,1);assert.equal(p.run('projectWorkData().selected'),null);assert.equal(p.run('projectWorkData().goal'),'');assert.equal(p.run('projectWorkData().issue'),'202');
  p.run('openProjectWork(201)');p.fetchCalls[1]!.resolve({ok:true,status:200,json:async()=>list});await flush();p.fetchCalls[2]!.resolve({ok:true,status:200,json:async()=>detail});await flush();assert.equal(p.run('projectWorkData().selected'),summary.id);
  p.run("projectWorkData().selected=null;openProjectWork();");p.fetchCalls[3]!.resolve({ok:true,status:200,json:async()=>list});await flush();p.fetchCalls[4]!.resolve({ok:true,status:200,json:async()=>detail});await flush();assert.equal(p.run('projectWorkData().selected'),summary.id);
  p.run('openProjectWork(null,'+JSON.stringify(summary.id)+')');p.fetchCalls[5]!.resolve({ok:true,status:200,json:async()=>list});await flush();p.fetchCalls[6]!.resolve({ok:true,status:200,json:async()=>detail});await flush();assert.equal(p.run('projectWorkData().selected'),summary.id);
  p.run("projectWorkData().selected=null;projectWorkData().newWork=true;projectWorkData().detail=null;projectWorkData().goal='';");const refresh=p.run('loadProjectWorks(true)');p.fetchCalls[7]!.resolve({ok:true,status:200,json:async()=>list});await refresh;assert.equal(p.fetchCalls.length,8);assert.equal(p.run('projectWorkData().selected'),null);assert.equal(p.run('projectWorkData().goal'),'');
});

test('original authorizing version has an explicit same-version lookup action; stopped and unfixed input cannot start',async()=>{
  const p=await workPage(),proposal={goal:'exact scope',acceptance:[],allowedPaths:['code.mjs'],protectedPaths:[],questions:[],validation:{description:'exact test',script:'test'},report:'original'};
  const item={...detail.draft,stage:'authorizing',version:1,preparation:{proposal,proposalDigest:'a'.repeat(64)},problem:'project_work_owner_source_unknown'};
  p.run('projectWorkData().selected='+JSON.stringify(summary.id)+';projectWorkData().detail='+JSON.stringify({draft:item})+';projectWorkData().works='+JSON.stringify([{...summary,stage:'authorizing'}])+";view='project-work';renderProjectWork();render=()=>{};");
  const resume=find(p.nodes.get('content'),'核对原批准并继续原工作');assert.ok(resume);assert.equal(p.fetchCalls.length,0);const action=resume.onclick();assert.equal(JSON.parse(p.fetchCalls[0]!.options.body).version,1);assert.equal(JSON.parse(p.fetchCalls[0]!.options.body).proposalSha256,'a'.repeat(64));p.fetchCalls[0]!.resolve({ok:false,status:503,json:async()=>({error:'project_work_owner_source_unknown'})});await action;
  for(const change of [{stopRequested:true},{preparation:{proposal:{...proposal,questions:['clarify']}}}]){
    p.run('projectWorkData().detail='+JSON.stringify({draft:{...item,...change}})+';renderProjectWork();');assert.equal(find(p.nodes.get('content'),'核对原批准并继续原工作'),undefined);
  }
});

test('failed preparation shows pending words on cold read while the old proposal and version remain fixed',async()=>{
  const p=await workPage();p.run('render=()=>{};projectWorkData().selected='+JSON.stringify(summary.id));const read=p.run('loadProjectWorks(true)');p.fetchCalls[0]!.resolve({ok:true,status:200,json:async()=>list});await flush();
  const fixed={...detail.draft,version:1,stage:'authorizing',goal:'original approved goal',draftGoal:'new words retained after missing conditions'};
  p.fetchCalls[1]!.resolve({ok:true,status:200,json:async()=>({draft:fixed,execution:null})});await read;assert.equal(p.run('projectWorkData().goal'),fixed.draftGoal);assert.equal(p.run('projectWorkData().detail.draft.goal'),'original approved goal');assert.equal(p.run('projectWorkData().detail.draft.version'),1);
});

for(const matchingConversation of [false,true])test('second Issue create sends only its empty new goal despite prior conversation fallback: '+matchingConversation,async()=>{
  const p=await workPage();p.run('projectWorkData().works='+JSON.stringify([summary])+';chatData=()=>({conversationId:'+JSON.stringify(matchingConversation?summary.conversationId:'unrelated')+'});render=()=>{};openProjectWork(202);');
  p.fetchCalls[0]!.resolve({ok:true,status:200,json:async()=>list});await flush();assert.equal(p.fetchCalls.length,1);assert.equal(p.run('projectWorkData().detail'),null);p.run('renderProjectWork()');
  const button=find(p.nodes.get('content'),'保存或打开这项工作');assert.ok(button);const creating=button.onclick();assert.equal(p.fetchCalls.length,2);assert.equal(p.fetchCalls[1]!.options.method,'POST');const body=JSON.parse(p.fetchCalls[1]!.options.body);assert.equal(body.issueNumber,202);assert.equal(body.goal,'');assert.equal(body.newWork,false);p.fetchCalls[1]!.resolve({ok:false,status:503,json:async()=>({error:'project_work_repository_location_required'})});await creating;
});

test('rejected preparation questions are visibly unaccepted and answers use an explicit same-work new preparation',async()=>{
  const p=await workPage(),diagnostic={accepted:false,reason:'non_terminal_agent_message',questions:['Synthetic premise requires clarification.'],nextStep:'在普通目标中答复，再明确准备新版本。'};
  const item={...detail.draft,version:1,stage:'needs_input',problem:'controlled_result_not_final:non_terminal_agent_message',preparation:{directory:'/private/fixture'}};
  p.run('projectWorkData().selected='+JSON.stringify(summary.id)+';projectWorkData().detail='+JSON.stringify({draft:item,preparationDiagnostic:diagnostic,history:[{version:0,preparationDiagnostic:diagnostic}]})+';projectWorkData().works='+JSON.stringify([{...summary,stage:'needs_input'}])+";view='project-work';renderProjectWork();render=()=>{};");
  const texts=(n:any):string=>[n.textContent,...(n.children??[]).map(texts)].join('\n'),shown=texts(p.nodes.get('content'));assert.match(shown,/未接受的准备问题/);assert.match(shown,/不是已接受方案或批准/);assert.match(shown,/Synthetic premise/);assert.match(shown,/历史版本 0/);assert.equal(find(p.nodes.get('content'),'请本人确认范围并开始'),undefined);assert.equal(p.fetchCalls.length,0);
  p.run("projectWorkData().goal='Answer for the explicit next version';");const action=find(p.nodes.get('content'),'重新核对并准备').onclick();assert.ok(p.fetchCalls[0]!.path.includes(summary.id+'/prepare'));assert.deepEqual(JSON.parse(p.fetchCalls[0]!.options.body),{goal:'Answer for the explicit next version'});p.fetchCalls[0]!.resolve({ok:false,status:503,json:async()=>({error:'project_work_original_active_or_unknown'})});await action;
});

test('only verified zero-input eligibility offers an explicit first input action',async()=>{
 const p=await workPage(),item={...detail.draft,version:1,stage:'execution',catalog:{path:'fixture'},source:'fixture'},current={...summary,stage:'execution',execution:{phase:'active_or_unknown',controllerActive:false}};
 p.run('projectWorkData().selected='+JSON.stringify(summary.id)+';projectWorkData().detail='+JSON.stringify({draft:item,firstInputContinuation:{eligible:false}})+';projectWorkData().works='+JSON.stringify([current])+";view='project-work';renderProjectWork();render=()=>{};");assert.equal(find(p.nodes.get('content'),'继续原工作的首次输入'),undefined);assert.equal(p.fetchCalls.length,0);
 p.run('projectWorkData().detail.firstInputContinuation={eligible:true};renderProjectWork();');const button=find(p.nodes.get('content'),'继续原工作的首次输入');assert.ok(button);const action=button.onclick();assert.ok(p.fetchCalls[0]!.path.endsWith(summary.id+'/continue-first-input'));assert.deepEqual(JSON.parse(p.fetchCalls[0]!.options.body),{});p.fetchCalls[0]!.resolve({ok:false,status:503,json:async()=>({error:'implementation_original_controller_active_or_unknown'})});await action;assert.equal(p.fetchCalls.length,1);
});

test('known validation failure shows the retained final and offers only an explicit bounded correction',async()=>{
 const p=await workPage(),item={...detail.draft,version:1,stage:'execution',catalog:{path:'fixture'},source:'fixture'},failure={eligible:false,reason:'implementation_validation_tree_changed',report:{decision:'implemented',report:'Honest synthetic final: registered validation failed.'},tests:{passed:false}};
 p.run('projectWorkData().selected='+JSON.stringify(summary.id)+';projectWorkData().detail='+JSON.stringify({draft:item,validationFailure:failure})+';projectWorkData().works='+JSON.stringify([{...summary,stage:'execution',execution:{phase:'validation_failed',controllerActive:false}}])+";view='project-work';renderProjectWork();render=()=>{};");assert.equal(find(p.nodes.get('content'),'按原范围修正验证'),undefined);assert.equal(p.fetchCalls.length,0);
 p.run('projectWorkData().detail.validationFailure.eligible=true;renderProjectWork();');const action=find(p.nodes.get('content'),'按原范围修正验证').onclick();assert.ok(p.fetchCalls[0]!.path.endsWith(summary.id+'/correct-validation'));assert.deepEqual(JSON.parse(p.fetchCalls[0]!.options.body),{});p.fetchCalls[0]!.resolve({ok:false,status:503,json:async()=>({error:'work_validation_material_consent_required'})});await action;assert.equal(p.fetchCalls.length,1);
});
