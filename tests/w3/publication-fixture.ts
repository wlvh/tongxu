import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setup} from './receiver-fixture.js';
import {runReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';

export async function publicationFixture(t: test.TestContext, mode = 'normal',receiverMode='complete') {
  const f = await setup(t,receiverMode);
  // Native-shaped local fixture plus a fake gh process. No supplier or GitHub
  // request is possible; this declaration is not reported as a real capture.
  const secret = 'PRIVATE_REPORT_SENTINEL @someone /Users/private/token=fixture ```';
  await writeFile(f.plan.claudeExecutable, (await readFile(f.plan.claudeExecutable, 'utf8')).replace("report:'明确标注的模拟接收判断；没有真实模型或业务批准。'", 'report:' + JSON.stringify(secret)));
  await writeFile(f.path, JSON.stringify({ ...f.plan, executionKind: 'native_capture' }));
  const result = await runReception(f.path), remotePath = join(f.root, 'fake-remote.json');
  const data = { mode, repository: 'fixture/reception', repositoryId: 71, actor: { id: 72, login: 'fixture-publisher' }, H: result.candidate.H, B: result.candidate.B, target: result.candidate.targetRef, comments: [], statuses: [], requests: [], posts: [], rejectionConsumed: false };
  await writeFile(remotePath, JSON.stringify(data)); const gh = join(f.root, 'gh-fixture.mjs');
  await writeFile(gh, `#!${process.execPath}
import fs from 'node:fs';
import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js', import.meta.url).href)};
const path=${JSON.stringify(remotePath)},store=${JSON.stringify(f.store)},args=process.argv.slice(2),method=args[args.indexOf('--method')+1],endpoint=args.at(-1);
let input='';for await(const b of process.stdin)input+=b;
let r=JSON.parse(fs.readFileSync(path,'utf8'));r.requests.push({method,endpoint});
const base='repos/'+r.repository,save=()=>{const tmp=path+'.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(r));fs.renameSync(tmp,path)};
function emit(status,value){save();process.stdout.write('HTTP/2.0 '+status+' Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(value));process.exitCode=status>=400?1:0;}
if(method==='GET'){
 if(endpoint==='user')emit(200,r.actor);
 else if(endpoint===base)emit(200,{id:r.repositoryId,full_name:r.repository,permissions:{push:true}});
 else if(endpoint===base+'/pulls/1')emit(200,{number:1,state:'open',head:{sha:r.H,repo:{id:r.repositoryId}},base:{sha:r.B,ref:r.target,repo:{id:r.repositoryId}}});
 else if(endpoint.startsWith(base+'/git/ref/heads/')){if(r.mode==='stop-on-ref'){const q=await QueueStore.open(store);q.control('scope','investment','stopped','fixture:concurrent-stop');q.close();}emit(200,{ref:'refs/heads/'+r.target,object:{type:'commit',sha:r.refB??r.B}});}
 else if(endpoint.includes('/issues/1/comments?')){const page=Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));emit(200,r.comments.slice((page-1)*100,page*100));}
 else if(endpoint.startsWith(base+'/issues/comments/')){const value=r.comments.find(x=>x.id===Number(endpoint.split('/').at(-1)));emit(value?200:404,value??{message:'missing'});}
 else if(endpoint.includes('/commits/')&&endpoint.includes('/statuses?')){const page=Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));emit(200,r.statuses.slice((page-1)*100,page*100));}
 else emit(404,{message:'fixture endpoint absent'});
}else{
 const p=JSON.parse(input),comment=endpoint===base+'/issues/1/comments';
 r.posts.push({endpoint,payload:p});
 if(r.mode==='empty-no-create'){save();process.exit(1);}
 if(!comment&&r.mode==='reject-status'&&!r.rejectionConsumed){r.rejectionConsumed=true;emit(403,{message:'explicit fixture rejection'});}
 else {
  if(comment&&r.mode==='slow-comment')await new Promise(resolve=>setTimeout(resolve,600));
  const value=comment?{id:100+r.comments.length,user:r.actor,body:p.body,issue_url:'https://api.github.com/'+base+'/issues/1',html_url:'https://github.com/'+r.repository+'/pull/1#issuecomment-'+(100+r.comments.length)}:{id:200+r.statuses.length,creator:r.actor,...p};
  if(comment)r.comments.push(value);else r.statuses.unshift(value);
  if(comment&&r.mode==='change-head-after-comment')r.H='a'.repeat(40);
  save();
  if(!comment&&r.mode==='orphan-status'){fs.writeFileSync(${JSON.stringify(join(f.root,'owned-orphan.json'))},JSON.stringify({pid:process.pid,parent:process.ppid}));process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000);await new Promise(()=>{});}
  if(comment&&r.mode==='kill-parent-after-comment'){process.kill(process.ppid,'SIGKILL');process.exit(0);}
  else if(!comment&&r.mode==='lose-status-response')process.exit(1);
  else emit(201,value);
 }
}
`, { mode: 0o700 });
  if(mode==='sync-input')await writeFile(gh,(await readFile(gh,'utf8')).replace("let input='';for await(const b of process.stdin)input+=b;","let input='';const buffer=Buffer.alloc(65536);while(true){const n=fs.readSync(0,buffer);if(!n)break;input+=buffer.subarray(0,n);try{JSON.parse(input);break;}catch{}}"));
  const p = { schemaVersion: 1, kind: 'tongxu-reception-publication', store: f.store, operation: result.operation, channel: 'commit-status', ghExecutable: gh, ghSha256: hash(await readFile(gh)), repositoryId: 71, actor: data.actor, source: 'fixture:explicit-record-only-publication' };
  const path = join(f.root, 'publication-plan.json'); await writeFile(path, JSON.stringify(p));
  const read = async () => JSON.parse(await readFile(remotePath, 'utf8'));
  const change = async (changes: Record<string, any>) => writeFile(remotePath, JSON.stringify({ ...await read(), ...changes }));
  return { ...f, result, p, pubPath: path, remotePath, remote: read, change, secret };
}
