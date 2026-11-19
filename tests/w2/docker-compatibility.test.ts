import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DockerRuntime,reconcileDocker} from '../../src/docker-sandbox.js';
import {hash} from '../../src/snapshot.js';
import {dockerProtocolFixture as fixture} from './docker-protocol-fixture.js';

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
