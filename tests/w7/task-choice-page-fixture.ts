import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {taskChoiceFixture} from '../w6/task-contact-choice-fixture.js';
import {TaskControls} from '../../src/task-controls.js';
import {startWorkbench} from '../../src/workbench.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

export async function taskChoicePageFixture(t:test.TestContext,mode='contact'){
  const f=await taskChoiceFixture(t,mode),current=f.q.tasks().current(f.a.item),sources=[{id:'a',title:'原任务A（明确样例）',store:f.store,item:f.a.item},{id:'b',title:'独立任务B（明确样例）',store:f.store,item:f.b.item}],catalog={schemaVersion:1,kind:'tongxu-task-controls',contacts:[{id:'choose-contact',title:'检查任务并选择必要联系',source:'a',packet:current.packet,sourceSha256:current.fingerprint,request:{path:f.path,sha256:hash(f.raw)}}]},catalogPath=join(f.root,'choice-controls.json');await writeFile(catalogPath,canonical(catalog));
  const plan={schemaVersion:1,kind:'tongxu-controlled-workbench',title:'原角色主动联系样例',goal:'按需要联系，原回复自动回A；不依赖秘书。',sources,controls:{path:catalogPath,sha256:hash(await readFile(catalogPath))}},planPath=join(f.root,'choice-workbench.json');await writeFile(planPath,canonical(plan));
  const app=await startWorkbench(planPath),u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)},post=(body:unknown={})=>fetch(u.origin+'/api/task-control/choose-contact/start',{method:'POST',headers:{...headers,Origin:u.origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),get=async()=>await(await fetch(u.origin+'/api/state',{headers})).json() as any,report=async()=>await(await fetch(u.origin+'/api/task-control-report/choose-contact',{headers})).json() as any;
  t.after(()=>app.close());const load=()=>TaskControls.load(catalogPath,hash(Buffer.from(canonical(catalog))),sources);
  return {...f,sources,catalog,catalogPath,planPath,app,u,headers,post,get,report,load};
}
export async function waitForTaskChoicePage(f:Awaited<ReturnType<typeof taskChoicePageFixture>>,condition:(v:any)=>boolean){const end=Date.now()+15000;let value;while(Date.now()<end){value=(await f.get()).taskControls[0];if(condition(value))return value;await new Promise(r=>setTimeout(r,15));}throw new Error('task_choice_page_timeout:'+JSON.stringify(value));}
