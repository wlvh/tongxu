import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,realpath,rm,mkdir,cp} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PublicationHttp} from '../../src/publication-http.js';
import {hash} from '../../src/snapshot.js';

async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(await realpath(tmpdir()),'tongxu-publication-dispatch-fixture-')),executable=join(root,'explicit-fake-gh.mjs');
  t.after(async()=>{const parent=process.env.TONGXU_PUBLICATION_TEST_EVIDENCE;if(parent){await mkdir(parent,{recursive:true});await cp(root,join(parent,basename(root)),{recursive:true});}await rm(root,{recursive:true,force:true});});
  const code=`#!${process.execPath}\nlet input='';for await(const b of process.stdin)input+=b;process.stdout.write('HTTP/2.0 201 Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify({id:123,received:JSON.parse(input)}));`;
  await writeFile(executable,code,{mode:0o700});return {root,http:new PublicationHttp(root,executable,hash(code),'fixture/reception',1,'a'.repeat(40),'fixture')};
}
const endpoint='repos/fixture/reception/issues/1/comments',payload={body:'Explicit local fixture only; no supplier or GitHub access'};
test('publication effect holds the controller transaction through spawn and the actual input pipe',async t=>{
  const f=await fixture(t),db=new DatabaseSync(join(f.root,'controller.sqlite'));let directory='',savedEffect:(()=>void)|undefined,started=false;
  try{
    const reply=await f.http.request('POST',endpoint,payload,{
      intent:dir=>{assert.equal(db.isTransaction,true);directory=dir;},
      started:pid=>{assert.equal(db.isTransaction,true);assert.ok(pid>0);started=true;},
      dispatch:(dir,effect)=>{db.exec('BEGIN IMMEDIATE');savedEffect=effect;try{effect();assert.equal(started,true);const submitted=JSON.parse(readFileSync(join(dir,'submitted.json'),'utf8'));assert.equal(submitted.bodySha256,hash(JSON.stringify(payload)));assert.equal(submitted.remoteAcceptanceVerified,false);db.exec('COMMIT');}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}
    });
    assert.equal(reply.status,201);assert.deepEqual(reply.value.received,payload);assert.equal(reply.directory,directory);assert.equal(db.isTransaction,false);assert.throws(()=>savedEffect!(),/effect_not_current/);assert.equal((await readdir(f.root)).filter(n=>n.startsWith('http-')).length,1);
  }finally{db.close();}
});
test('publication dispatch refusal and rollback after input retain different original evidence',async t=>{
  for(const afterInput of [false,true]){
    const f=await fixture(t);let directory='',intentCalls=0;
    await assert.rejects(f.http.request('POST',endpoint,payload,{intent:()=>{intentCalls++;},started:()=>{},dispatch:(dir,effect)=>{directory=dir;if(afterInput)effect();throw new Error(afterInput?'fixture_commit_failed':'fixture_permission_revoked');}}),/fixture_commit_failed|fixture_permission_revoked/);
    const failure=JSON.parse(await readFile(join(directory,'dispatch-error.json'),'utf8'));assert.equal(failure.inputMayHaveBeenSubmitted,afterInput);assert.equal(failure.spawnAttempted,afterInput);assert.equal(failure.remoteAcceptanceVerified,false);assert.equal(intentCalls,afterInput?1:0);assert.equal(existsSync(join(directory,'submission-intent.json')),afterInput);assert.equal(existsSync(join(directory,'exit.json')),afterInput);assert.equal((await readdir(f.root)).filter(n=>n.startsWith('http-')).length,1);
  }
});
