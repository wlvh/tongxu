import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {DockerRuntime,parseDockerConfig,reconcileDocker} from '../../src/docker-sandbox.js';
import {hash} from '../../src/snapshot.js';

/** Actual child processes, explicit fake Docker protocol. No daemon/container
 * isolation or external model is claimed by these upgrade/recovery tests. */
async function fixture(t:test.TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'tongxu-docker-compat-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const socket=join(root,'engine.sock'),server=createServer();await new Promise<void>(r=>server.listen(socket,r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const state=join(root,'state.json'),client=join(root,'docker'),image='sha256:'+'a'.repeat(64);
  await writeFile(state,JSON.stringify({image,engine:'fixture-original-engine',containers:{},calls:[]}));
  const source=`#!${process.execPath}
import fs from 'node:fs';
const path=${JSON.stringify(state)},s=JSON.parse(fs.readFileSync(path,'utf8')),a=process.argv.slice(6),save=()=>fs.writeFileSync(path,JSON.stringify(s)),out=x=>console.log(typeof x==='string'?x:JSON.stringify(x));s.calls.push(a);save();
if(a[0]==='info'){if(s.changeClient)fs.appendFileSync(process.argv[1],'\\n// upgraded while reading\\n');out({OSType:'linux',ID:s.engine,ServerVersion:'999.0.0'});}
else if(a[0]==='image')out([{Id:s.image,Os:'linux',Config:{Env:['FIXTURE=1'],Volumes:{}}}]);
else if(a[0]==='create'){
 const get=k=>a[a.indexOf(k)+1],id=String(s.calls.length).padStart(64,'0'),name=get('--name'),execution=name.slice(7),index=a.findIndex(x=>x.startsWith('sha256:')),user=a.find(x=>x==='--user')?get('--user'):'0';
 const v={Id:id,Name:'/'+name,Image:a[index],Config:{Labels:{'io.tongxu.execution':execution,'io.tongxu.executor':'docker-v1'},User:user,Entrypoint:['/usr/bin/env'],Cmd:a.slice(index+1),Tty:false,OpenStdin:false,WorkingDir:get('--workdir'),Healthcheck:{Test:['NONE']},Env:['FIXTURE=1']},HostConfig:{Init:a.includes('--init'),Privileged:false,ReadonlyRootfs:true,NetworkMode:'none',PidMode:'',UTSMode:'',IpcMode:'private',CgroupnsMode:'private',CapDrop:s.badIsolation?[]:['ALL'],SecurityOpt:['no-new-privileges','seccomp=builtin'],Memory:1073741824,MemorySwap:1073741824,NanoCpus:2000000000,PidsLimit:128,RestartPolicy:{Name:'no'},LogConfig:{Type:'local',Config:{'max-size':'4m','max-file':'1',compress:'false'}},MaskedPaths:['/proc/keys'],ReadonlyPaths:['/proc/sys'],Tmpfs:{'/tmp':'rw,exec,nosuid,nodev,size=268435456,mode=1777','/home/tongxu':'rw,size=16777216,mode=700,uid='+user.split(':')[0]+',gid='+user.split(':')[1]}},Mounts:[],State:{Running:false,Status:'created',ExitCode:0}};
 s.containers[id]=v;save();out(id);
}else if(a[0]==='container'){
 const v=s.containers[a[2]]??Object.values(s.containers).find(x=>x.Name==='/'+a[2]);if(!v){console.error('No such container');process.exit(1);}out([v]);
}else if(a[0]==='start'){
 const v=s.containers[a.at(-1)];v.State={Running:false,Status:'exited',ExitCode:0};save();out({node:'v100.0.0',sqliteTransactions:true,git:'git version 999',uid:Number(v.Config.User.split(':')[0]),seccomp:true,noNewPrivileges:true,capabilitiesEmpty:true});
}else if(a[0]==='rm'){delete s.containers[a[1]];save();}
else if(a[0]==='kill'){const v=s.containers[a.at(-1)];v.State={Running:false,Status:'exited',ExitCode:137};save();}
else if(a[0]!=='logs')process.exit(2);
`;
  await writeFile(client,source,{mode:0o700});
  const config=parseDockerConfig({kind:'docker',client,endpoint:'unix://'+socket,image:'tongxu-fixture:current',node:'/usr/bin/node'});
  const read=async()=>JSON.parse(await readFile(state,'utf8')),set=async(v:any)=>writeFile(state,JSON.stringify({...await read(),...v}));
  return {root,client,config,read,set};
}
test('an image alias is resolved for each new preparation; an existing run keeps its actual image and recovered CLI may upgrade',async t=>{
  const f=await fixture(t),first=await DockerRuntime.prepare(f.config,join(f.root,'first')),oldImage=first.connection.imageId;
  await f.set({image:'sha256:'+'b'.repeat(64)});
  const run=join(f.root,'run'),result=await first.run({directory:run,argv:['/usr/bin/node','-e','0'],timeoutMs:1000,maxBytes:4096});assert.equal(result.status,'completed',result.record.toString());assert.equal(JSON.parse(result.record.toString()).before.Image,oldImage);
  const next=await DockerRuntime.prepare(f.config,join(f.root,'next'));assert.notEqual(next.connection.imageId,oldImage);assert.equal(first.connection.config.image,'tongxu-fixture:current');
  const original=await readFile(join(run,'execution.json')),starts=(await f.read()).calls.filter((x:string[])=>['create','start'].includes(x[0]!)).length;
  await appendFile(f.client,'\n// compatible Docker client upgrade\n');const recovered=await reconcileDocker(run,'inspect',f.config);assert.equal(recovered.outcome,'original_completed_record');assert.equal(recovered.sentNewTask,false);assert.notEqual(recovered.executableSelection.sha256,first.connection.clientSha256);
  assert.deepEqual(await readFile(join(run,'execution.json')),original);assert.equal((await f.read()).calls.filter((x:string[])=>['create','start'].includes(x[0]!)).length,starts);
  await assert.rejects(reconcileDocker(run,'stop',f.config),/controller_active_or_unknown/);
  await f.set({engine:'another-engine'});await assert.rejects(reconcileDocker(run,'inspect',f.config),/engine_changed_or_unavailable/);
});
test('unknown original state is retained without a new run; actual isolation and during-call executable checks still refuse',async t=>{
  const f=await fixture(t),runtime=await DockerRuntime.prepare(f.config,join(f.root,'runtime')),run=join(f.root,'run');
  await runtime.run({directory:run,argv:['/usr/bin/node','-e','0'],timeoutMs:1000,maxBytes:4096});
  const p=join(run,'execution.json'),r=JSON.parse(await readFile(p,'utf8'));r.phase='unknown';r.capture.complete=false;await writeFile(p,JSON.stringify(r));const before=hash(await readFile(p)),count=(await f.read()).calls.length;
  const recovered=await reconcileDocker(run,'inspect',f.config);assert.equal(recovered.outcome,'container_absent_original_result_unknown');assert.equal(hash(await readFile(p)),before);assert.equal((await f.read()).calls.slice(count).some((a:string[])=>['create','start'].includes(a[0]!)),false);
  await f.set({badIsolation:true});await assert.rejects(DockerRuntime.prepare(f.config,join(f.root,'unsafe')),/runtime_probe_failed/);
  await f.set({badIsolation:false,changeClient:true});await assert.rejects(DockerRuntime.prepare(f.config,join(f.root,'changed')),/changed_during_operation/);
});
