import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {governedPublicationFixture} from './governed-publication-fixture.js';
import {resourceMain} from '../../src/resource-cli.js';
import {publicationProcessIdentity} from '../../src/publication-process.js';
import {processState} from '../../src/repair-workspace.js';

for(const savedOutcome of [false,true])test(`old 6fe saved publication result with outcome=${savedOutcome} cannot settle a live original through resources`,{skip:!process.env.TONGXU_OLD_PUBLICATION_SOURCE,timeout:120000},async t=>{
  const f=await governedPublicationFixture(t,'orphan-status'),old=process.env.TONGXU_OLD_PUBLICATION_SOURCE!,module=(name:string)=>import(pathToFileURL(join(old,'dist/src',name+'.js')).href),oldPub=await module('publisher'),oldResource=await module('resource-store'),oldClaims=await module('resource-claims');let pid:number|undefined,identity:ReturnType<typeof publicationProcessIdentity>=null;
  try{
    const child=spawn(process.execPath,[new URL('../../src/publisher-cli.js',import.meta.url).pathname,'publish','--plan',f.pubPath],{stdio:'ignore'});const [,signal]=await once(child,'close');assert.equal(signal,'SIGKILL');pid=JSON.parse(await readFile(join(f.root,'owned-orphan.json'),'utf8')).pid;identity=publicationProcessIdentity(pid!);assert.ok(identity);assert.equal(processState(pid),'alive');
    const directory=f.q.publicationState(f.p.operation).stages.status.intent.directory;await writeFile(join(directory,'exit.json'),JSON.stringify({code:0,signal:null,finishedAt:new Date().toISOString()}));
    const method=savedOutcome?'dispatchResult':'prepareOutcome',original=oldResource.ResourceRecords.prototype[method];oldResource.ResourceRecords.prototype[method]=()=>{throw new Error('explicit_fixture_stop_before_provider_result');};
    try{await oldPub.publication(f.pubPath,'reconcile');}finally{oldResource.ResourceRecords.prototype[method]=original;}
    const historical=f.q.publicationState(f.p.operation).events.find((e:any)=>e.kind==='result_recorded');assert.ok(historical);assert.equal(Boolean(f.q.resources().status(f.resourceId).outcome),savedOutcome);assert.equal(f.ledger.state().settlements.length,0);assert.equal(processState(pid),'alive');
    // Explicit isolated old-schema sample, never a production migration or
    // workaround: remove only the newly added guard in this test database.
    const db=new DatabaseSync(join(f.store,'queue.sqlite'));db.exec('DROP TRIGGER publication_resource_result_guard');db.close();
    await assert.rejects(resourceMain(['record-result','--store',f.store,'--id',f.resourceId]),/publication_original_process_active/);assert.equal(f.ledger.state().settlements.length,0);assert.equal(processState(pid),'alive');
    const verify=new DatabaseSync(join(f.store,'queue.sqlite'));assert.ok(verify.prepare("SELECT 1 FROM sqlite_schema WHERE name='publication_resource_result_guard'").get());verify.close();
    // Already-open old code cannot pass the final durable result guard, even
    // if it still trusts its previously saved result or outcome.
    await assert.rejects(oldClaims.resourceAction(f.store,f.resourceId,'record-result','background'),/publication_original_terminal_check_required/);assert.equal(f.ledger.state().settlements.length,0);
    assert.deepEqual(publicationProcessIdentity(pid!),identity);process.kill(-pid!,'SIGKILL');for(let i=0;i<50&&processState(pid)!=='ended';i++)await delay(20);assert.equal(processState(pid),'ended');
    const result=await resourceMain(['record-result','--store',f.store,'--id',f.resourceId]);assert.equal(result.state,'consumed');assert.equal(f.ledger.state().settlements.length,1);const again=await resourceMain(['record-result','--store',f.store,'--id',f.resourceId]);assert.equal(again.newProviderCall,false);assert.equal(f.ledger.state().settlements.length,1);assert.equal((await f.remote()).posts.length,2);assert.equal(f.q.publicationState(f.p.operation).events.find((e:any)=>e.kind==='result_recorded').resultSha256,historical.resultSha256);
    await writeFile(join(f.root,'old-result-recovery.json'),JSON.stringify({oldSource:old,savedOutcome,pid,identity,originalResultSha256:historical.resultSha256,result,again,posts:2,settlements:1,originalResultUnchanged:true,newOfficialInputs:0},null,2));
  }finally{if(pid&&processState(pid)==='alive'&&identity&&JSON.stringify(publicationProcessIdentity(pid))===JSON.stringify(identity)){const observed=execFileSync('/bin/ps',['-p',String(pid),'-o','pid=,pgid=,command='],{encoding:'utf8'}).trim();if(observed.split(/\s+/)[1]===String(pid)&&observed.includes(f.p.ghExecutable))process.kill(-pid,'SIGKILL');}}
});
