import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secretaryFixture} from '../w4/secretary-fixture.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {startWorkbench} from '../../src/workbench.js';
import {sourceFixture} from '../events/source-fixture.js';
export async function secretaryEntryFixture(t:test.TestContext,mode='normal',withQueue=false,configure?:(f:Awaited<ReturnType<typeof secretaryFixture>>)=>Promise<void>){
  // Stop the foreground caller and server before removing their source files.
  const cleanup:Array<()=>unknown>=[],lifetime={after:(fn:()=>unknown)=>cleanup.push(fn)} as unknown as test.TestContext;
  t.after(async()=>{for(const fn of cleanup.reverse())await fn();});
  const f=await secretaryFixture(lifetime,mode);await configure?.(f);let eventSource:Awaited<ReturnType<typeof sourceFixture>>|undefined,eventControls:{path:string;sha256:string}|undefined;
  if(withQueue){eventSource=await sourceFixture(lifetime,'fixture/reception');f.q.enableSupplements();await eventSource.change({H:f.p.candidate.H,B:f.p.candidate.B,target:f.p.candidate.target});f.q.events().configure(Buffer.from(canonical(eventSource.profile)));const path=join(f.root,'queue-controls.json');await writeFile(path,JSON.stringify({schemaVersion:1,kind:'tongxu-queue-event-controls',actions:[{id:'remind',title:'核查原任务接收条件',source:'selected',profileSha256:hash(canonical(eventSource.profile)),kind:'hint',hintKind:'consumer_feedback'}]}));eventControls={path,sha256:hash(await readFile(path))};f.p.kind='tongxu-task-secretary';f.p.queueActions={...eventControls,source:'selected'};await writeFile(f.secretaryPlan,JSON.stringify(f.p));}
  const sources=[{id:'selected',title:'原测试任务',store:f.store,item:f.item}],root=join(f.root,'questions'),catalog={schemaVersion:1,kind:'tongxu-workbench-secretaries',entries:[{source:'selected',title:'所选任务的工作秘书',template:{path:f.secretaryPlan,sha256:hash(await readFile(f.secretaryPlan))},outputRoot:root}]},catalogPath=join(f.root,'secretaries.json');await writeFile(catalogPath,JSON.stringify(catalog));
  const sha=hash(await readFile(catalogPath)),plan={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'明确秘书入口样例',goal:'提问后通过原秘书读取完整回答和原回执',sources,secretary:{path:catalogPath,sha256:sha},...(eventControls?{eventControls,eventPolling:[{source:'selected',profileSha256:hash(canonical(eventSource!.profile)),maxTicks:3}]}:{})},path=join(f.root,'workbench.json');await writeFile(path,JSON.stringify(plan));
  const app=await startWorkbench(path);lifetime.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)},post=(action:string,body:unknown,origin=u.origin)=>fetch(u.origin+'/api/secretary/selected/'+action,{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),get=async()=>await(await fetch(u.origin+'/api/state',{headers})).json() as any;
  return {...f,fixtureRoot:f.root,eventSource,root,app,u,headers,post,get,path,sources,catalogPath,catalogSha256:sha};
}
