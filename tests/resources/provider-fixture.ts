import type test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash } from '../../src/snapshot.js';
import { canonical } from '../../src/comparison.js';
import { parseLedgerProfile,resourceRequestHash,type LedgerProfile,type ResourceRequest,type LedgerCommand } from '../../src/resource-contract.js';
import { callResourceProvider,requireLedgerObservation } from '../../src/resource-provider.js';

// Explicit original-ledger fixture only; no production balance.
export async function fixture(t:test.TestContext,mode='normal'){
  const root=await mkdtemp(join(await realpath(tmpdir()),'tongxu-original-ledger-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dbPath=join(root,'original-fixture.sqlite'),db=new DatabaseSync(dbPath);db.exec('CREATE TABLE capacity(n INTEGER NOT NULL);INSERT INTO capacity VALUES(1);CREATE TABLE requests(id TEXT PRIMARY KEY,body TEXT NOT NULL,result TEXT NOT NULL);CREATE TABLE settlements(id TEXT PRIMARY KEY,body TEXT NOT NULL);');db.close();
  const executable=join(root,'provider.mjs'),code=`#!${process.execPath}
import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
const mode=${JSON.stringify(mode)},canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}',hash=x=>createHash('sha256').update(x).digest('hex');
if(process.argv.slice(2).join()!=='--tongxu-ledger-v1')process.exit(5);
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
const c=JSON.parse(input),db=new DatabaseSync(${JSON.stringify(dbPath)});db.exec('PRAGMA busy_timeout=10000;BEGIN IMMEDIATE');let result;
if(c.command==='capabilities')result={credentialState:mode==='credentials-missing'?'unavailable':'available',claim:true,recordResult:true,idempotency:'same_request_same_effect',lookup:'durable_request_id'};
else{
 const previous=db.prepare('SELECT * FROM requests WHERE id=?').get(c.requestId);
 if(previous&&previous.body!==canonical(c.request))throw new Error('fixture original request changed');
 if(c.command==='lookup')result=previous?JSON.parse(previous.result):{state:'absent',reason:null,claim:null};
 else if(c.command==='claim'){
  if(previous)result=JSON.parse(previous.result);
  else if(db.prepare('SELECT n FROM capacity').get().n<c.request.quantity||mode==='credentials-missing')result={state:'refused',reason:mode==='credentials-missing'?'credential_unavailable':'insufficient_resource',claim:null};
  else{result={state:'present',reason:null,claim:{id:'fixture-claim-'+c.requestId,requestId:c.requestId,requestSha256:hash(canonical(c.request)),resourceRef:c.request.resourceRef,unit:c.request.unit,quantity:c.request.quantity,state:'held',outcomeSha256:null}};db.prepare('UPDATE capacity SET n=n-?').run(c.request.quantity);db.prepare('INSERT INTO requests VALUES(?,?,?)').run(c.requestId,canonical(c.request),JSON.stringify(result));}
 }else if(c.command==='record_result'){
  if(!previous)throw new Error('no original claim');result=JSON.parse(previous.result);if(result.claim.id!==c.outcome.claimId)throw new Error('wrong original claim');
  const old=db.prepare('SELECT body FROM settlements WHERE id=?').get(c.requestId);if(old&&old.body!==canonical(c.outcome))throw new Error('changed original settlement');
  result.claim.state='consumed';result.claim.outcomeSha256=hash(canonical(c.outcome));db.prepare('INSERT OR IGNORE INTO settlements VALUES(?,?)').run(c.requestId,canonical(c.outcome));db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(result),c.requestId);
 }
}
db.exec('COMMIT');db.close();
if(mode==='lost-after-claim'&&c.command==='claim'||mode==='lost-after-result'&&c.command==='record_result')process.exit(7);
const reply={protocol:c.protocol,ledgerId:c.ledgerId,executionKind:'fixture',command:c.command,requestId:c.requestId,inputSha256:hash(canonical(c)),observedAt:new Date().toISOString(),revision:'fixture-1',result};
if(mode==='wrong-id')reply.requestId='f'.repeat(64);if(mode==='wrong-version')reply.protocol='unknown-v2';
if(mode==='partial')process.stdout.write('{"protocol":');else{console.log(JSON.stringify(reply));if(mode==='two-replies')console.log(JSON.stringify(reply));}
});`;
  await writeFile(executable,code,{mode:0o700});
  const profile:LedgerProfile={schemaVersion:1,kind:'tongxu-existing-resource-ledger',ledgerId:'existing-fixture-ledger',repository:'fixture/reception',executionKind:'fixture',executable,executableSha256:hash(code),protocol:'tongxu-existing-ledger-v1',timeoutMs:3000,resources:[{ref:'existing-fixture-slot',unit:'fixture-task',maxPerClaim:1}]};
  const request:ResourceRequest={schemaVersion:1,ledgerId:profile.ledgerId,repository:profile.repository,operation:'00000000-0000-4000-8000-000000000001',authorityIntent:'fixed-fixture-action',resourceRef:profile.resources[0]!.ref,unit:'fixture-task',quantity:1,role:'receiver',actionSha256:'a'.repeat(64)};
  const cmd=(command:LedgerCommand['command'],r=request,outcome:LedgerCommand['outcome']=null):LedgerCommand=>({protocol:profile.protocol,ledgerId:profile.ledgerId,command,requestId:resourceRequestHash(r),request:command==='capabilities'?null:r,outcome});
  let n=0;const call=(c:LedgerCommand,gate?:(directory:string)=>void)=>callResourceProvider(profile,c,join(root,'call-'+(++n)),gate);
  const state=()=>{const d=new DatabaseSync(dbPath);try{return {remaining:(d.prepare('SELECT n FROM capacity').get() as any).n,claims:d.prepare('SELECT * FROM requests').all(),settlements:d.prepare('SELECT * FROM settlements').all()};}finally{d.close();}};
  return {root,profile,request,cmd,call,state};
}
