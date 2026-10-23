import type test from 'node:test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {setupRepair} from '../review-records/queue-repair-fixture.js';
import {memberInputFixture} from '../integration-member/repair-fixture.js';
import {startWorkbench} from '../../src/workbench.js';
import {hash} from '../../src/snapshot.js';
export type Basic=Awaited<ReturnType<typeof setupRepair>>;
export async function returnWorkFixture(t:test.TestContext,kind='repair'){
  const hooks:Array<()=>unknown>=[],lifetime={after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext;
  const member=kind==='refute'?await (await memberInputFixture(lifetime,'project-refuted',false)).prepareRepair():null;
  const f=member??await setupRepair(lifetime,'return',kind==='partial'?'project-interrupt':'project');
  let refutation=null;
  if(member){
    await writeFile(member.plan.claudeExecutable,(await readFile(member.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="complete"'));
    const plan={schemaVersion:1,kind:'tongxu-member-refutation-reception',id:'page-refutation',store:member.store,memberReturn:member.memberReturn,repairPlan:{path:member.planPath,sha256:hash(await readFile(member.planPath))},receiverPlan:{path:member.receiverPath,sha256:hash(await readFile(member.receiverPath))},source:'Explicit page fixture; original false finding is independently rechecked without editing the member.'},path=join(f.root,'refutation-for-page.json');await writeFile(path,JSON.stringify(plan));refutation={path,sha256:hash(await readFile(path))};
  }
  if(kind==='broken'){const broken={...f.request,materialPaths:[...f.request.materialPaths,'missing.txt']};await writeFile(f.requestPath,JSON.stringify(broken));await writeFile(f.planPath,JSON.stringify({...f.p,requestSha256:hash(await readFile(f.requestPath))}));}
  const item=member?member.member.item:(f as Basic).plan.item,sources=[{id:'original',title:'原退回任务（明确样例）',store:f.store,item}],catalog={schemaVersion:1,kind:'tongxu-return-controls',entries:[{id:'original-return',title:'核实原退回并处理',source:'original',repair:{path:f.planPath,sha256:hash(await readFile(f.planPath))},afterRefutation:refutation}]},catalogPath=join(f.root,'return-controls.json');await writeFile(catalogPath,JSON.stringify(catalog));
  const plan={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'原退回处理测试入口',goal:'原任务、原计划、原结果；不搬报告',sources,returnControls:{path:catalogPath,sha256:hash(await readFile(catalogPath))}},path=join(f.root,'workbench-return.json');await writeFile(path,JSON.stringify(plan));
  const app=await startWorkbench(path),u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)},post=(action:string,body:unknown={})=>fetch(u.origin+'/api/return-work/original-return/'+action,{method:'POST',headers:{...headers,Origin:u.origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),get=async()=>await(await fetch(u.origin+'/api/state',{headers})).json() as any;
  let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};
  t.after(async()=>{await close();if(process.env.TONGXU_RETURN_EVIDENCE){const out=process.env.TONGXU_RETURN_EVIDENCE;await mkdir(out,{recursive:true});await writeFile(join(out,basename(f.root)+'.json'),JSON.stringify({kind,root:f.root,modelRoot:f.model.root,store:f.store,workbench:path,catalog:catalogPath,officialModels:0,originalsPreservedInPlace:true},null,2)+'\n');f.q.close();}else for(const fn of hooks.reverse())await fn();});
  return {...f,member,sources,catalog,catalogPath,path,app,close,u,headers,post,get,item};
}
export async function waitForReturnWork(f:Awaited<ReturnType<typeof returnWorkFixture>>,condition:(r:any)=>boolean){const end=Date.now()+90000;let r;while(Date.now()<end){r=(await f.get()).returnWork[0];if(condition(r))return r;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('return_page_timeout:'+JSON.stringify(r));}
