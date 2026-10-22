import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {candidateFixture,raw} from './fixture.js';
import {hash} from '../../src/snapshot.js';
import {runObservedCandidate} from '../../src/observed-candidate.js';
import {runReception} from '../../src/receiver.js';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFile(path:string){const end=Date.now()+10000;for(;;){try{await stat(path);return;}catch{}if(Date.now()>end)throw new Error('fixture_latch_timeout');await delay(10);}}

// OC-F01: the final target GET may finish after a newer, contradictory PR
// observation. Neither a late success nor its late error may replace that fact.
for(const olderClosed of [false,true])test(`late ${olderClosed?'failure':'success'} cannot replace the observation made after its read began`,async t=>{
  const f=await candidateFixture(t),control=join(f.root,'order-control.json'),ready=join(f.root,'last-ref-ready'),release=join(f.root,'release-ref'),exe=join(f.root,'order-gh.mjs'),c=f.candidate;
  await writeFile(control,raw({repository:c.repository,repositoryId:71,pr:99,H:c.H,B:c.B,target:c.target,mode:'normal',pauseNext:false,slowGroup:null}));
  await writeFile(exe,`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const control=${JSON.stringify(control)},ready=${JSON.stringify(ready)},release=${JSON.stringify(release)},group=path.dirname(process.cwd()),args=process.argv.slice(2),method=args[args.indexOf('--method')+1],endpoint=args.at(-1);
if(method!=='GET')throw new Error('fixture_mutation_forbidden');let r=JSON.parse(fs.readFileSync(control,'utf8'));if(r.pauseNext&&!r.slowGroup){r.slowGroup=group;r.pauseNext=false;fs.writeFileSync(control,JSON.stringify(r));}
const base='repos/'+r.repository,repo={id:r.repositoryId,full_name:r.repository};let value;
if(endpoint===base)value=repo;
else if(endpoint===base+'/pulls/'+r.pr)value={number:r.pr,state:r.mode==='closed'?'closed':'open',merged:false,html_url:'https://github.com/'+r.repository+'/pull/'+r.pr,head:{sha:r.H,ref:'fixture-integration',repo},base:{sha:r.B,ref:r.target,repo}};
else if(endpoint===base+'/git/ref/heads/'+encodeURIComponent(r.target)){value={ref:'refs/heads/'+r.target,object:{type:'commit',sha:r.B}};if(group===r.slowGroup){const marker=path.join(group,'first-ref-seen');if(!fs.existsSync(marker))fs.writeFileSync(marker,'first');else{fs.writeFileSync(ready,'ready');while(!fs.existsSync(release))await new Promise(resolve=>setTimeout(resolve,10));}}}else throw new Error('fixture_endpoint_denied');
process.stdout.write('HTTP/2.0 200 Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(value));
`,{mode:0o700});
  const p={...f.link,kind:'tongxu-observed-integration-candidate',repositoryId:71,ghExecutable:exe,ghSha256:hash(await readFile(exe))},path=join(f.root,'observe.json');await writeFile(path,raw(p));await runObservedCandidate(f.store,path);
  const update=async(v:Record<string,unknown>)=>writeFile(control,raw({...JSON.parse(await readFile(control,'utf8')),...v}));
  await update({pauseNext:true,mode:olderClosed?'closed':'normal'});const inFlight=runObservedCandidate(f.store,path).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',reason:error.message}));
  try{await waitFile(ready);await update({mode:olderClosed?'normal':'closed'});if(olderClosed)await runObservedCandidate(f.store,path);else{await assert.rejects(runObservedCandidate(f.store,path),/remote_changed/);await assert.rejects(runReception(f.receiverPath),/integration_remote_observation_unresolved/);}}finally{await writeFile(release,'release only this GET fixture');}
  const old=await inFlight;assert.equal(old.status,'rejected');const db=new DatabaseSync(join(f.store,'queue.sqlite'),{readOnly:true});let events:any[];try{events=db.prepare("SELECT id,data FROM events WHERE kind='integration_remote_observation' AND object=? ORDER BY id").all(f.candidateItem).map((x:any)=>({...x,data:JSON.parse(x.data)}));}finally{db.close();}
  assert.equal(events.length,2);assert.equal(events.at(-1).data.matched,olderClosed);assert.equal(await f.count(),0);
  if(olderClosed)assert.equal((await runReception(f.receiverPath)).receiver.phase,'returned');else await assert.rejects(runReception(f.receiverPath),/integration_remote_observation_unresolved/);
  await writeFile(join(f.root,'read-order-proof.json'),raw({olderClosed,old,events,roleInputs:await f.count(),explicitFixture:true}));
});
