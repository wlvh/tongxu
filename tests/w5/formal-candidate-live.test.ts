import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {formalFixture,ended} from './formal-round-fixture.js';
import {sourceFixture} from '../events/source-fixture.js';
import {readEventSource} from '../../src/event-source.js';
import {sourceTick} from '../../src/event-tick.js';
import {FormalReviewControls} from '../../src/formal-review-controls.js';
import {git} from '../../src/repair-workspace.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';

function foregroundClock(controls:FormalReviewControls){
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  const timers=new Map<ReturnType<typeof setTimeout>,()=>void>();
  globalThis.setTimeout=((callback:(...args:any[])=>void,delay?:number,...args:any[])=>{
    if(delay!==10000)return originalSet(callback,delay,...args);
    const handle={unref(){return handle;}} as unknown as ReturnType<typeof setTimeout>;
    timers.set(handle,()=>callback(...args));
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout=((handle:ReturnType<typeof setTimeout>)=>{
    if(!timers.delete(handle))originalClear(handle);
  }) as typeof clearTimeout;
  return {
    pending:()=>timers.size,
    fire(){
      const scheduled=timers.entries().next().value;
      assert.ok(scheduled,'foreground discovery timer must remain scheduled');
      timers.delete(scheduled[0]);scheduled[1]();
    },
    async tick(){this.fire();await (controls as any).checking;},
    restore(){globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
  };
}

test('formal timer start is serial during a check and drain prevents rearming',async t=>{
  const {mkdtemp}=await import('node:fs/promises'),{tmpdir}=await import('node:os');
  const root=await mkdtemp(join(tmpdir(),'formal-timer-'));
  const catalog=join(root,'catalog.json'),bytes=Buffer.from(canonical({schemaVersion:1,kind:'tongxu-formal-review-catalog',entries:[]}));
  await writeFile(catalog,bytes);
  const controls=await FormalReviewControls.load(catalog,hash(bytes),[]),clock=foregroundClock(controls);
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  let checks=0;
  controls.advance=async()=>{checks++;await pending;};
  try{
    controls.start();controls.start();assert.equal(clock.pending(),1);
    clock.fire();controls.start();controls.start();
    assert.equal(clock.pending(),0,'start during checking cannot schedule another timer');
    const drained=controls.drain();release();await drained;
    controls.start();assert.equal(clock.pending(),0);assert.equal(checks,1);
  }finally{
    release();await controls.drain();clock.restore();
    const {rm}=await import('node:fs/promises');await rm(root,{recursive:true,force:true});
  }
});

async function publishedFixture(t:test.TestContext,incompleteItem=false,beforeWork?:(f:Awaited<ReturnType<typeof formalFixture>>)=>Promise<void>){
  const f=await formalFixture(t,'confirmed');
  await beforeWork?.(f);
  const prepared=await f.controls.prepare(f.entry.id,'published-live-source');
  await f.controls.begin(f.entry.id,prepared.operation);
  const first=await ended(f,prepared.operation);
  assert.equal(first.phase,'awaiting_publication',JSON.stringify(first.detail));
  const fix=first.result.fix;
  const remote=await sourceFixture(t,'fixture/reception');
  const source=(await readFile(remote.profile.ghExecutable,'utf8'))
    .replace('number:1,body:s.body','id:101,number:1,body:s.body')
    .replace('comments:s.comments.length','commits:s.collectionCommits.length,changed_files:s.collectionFiles.length,comments:s.comments.length');
  await writeFile(remote.profile.ghExecutable,source);
  remote.profile.ghSha256=hash(source);
  remote.profile.pollIntervalMs=60000;
  const commits=(await git(fix.workspace,['rev-list',first.material.mergeBase+'..'+fix.H1]))
    .split('\n').filter(Boolean).map(sha=>({sha,commit:{message:'Explicit actual local fixture commit'}}));
  const files=(await git(fix.workspace,['diff','--name-only',first.material.mergeBase,fix.H1]))
    .split('\n').filter(Boolean).map(filename=>({filename,status:'modified',patch:'Explicit fixture listing; complete patch is read from Git'}));
  const prefix='repos/fixture/reception';
  await remote.change({H:fix.H1,B:first.candidate.B,target:first.candidate.target,body:fix.proposedPRBody,
    collectionCommits:commits,collectionFiles:files,related:{
      [prefix+'/pulls/1/commits?per_page=100&page=1']:commits,
      [prefix+'/pulls/1/files?per_page=100&page=1']:files,
      [prefix+'/issues/72']:{id:172,updated_at:new Date().toISOString(),number:72,title:'Explicit adopted formal flow',body:f.live.issue.body,comments:0,html_url:f.live.issue.url},
      [prefix+'/issues/72/comments?per_page=100&page=1']:[]
    }});
  f.q.events().configure(Buffer.from(canonical(remote.profile)));
  f.live.candidate.H=fix.H1;
  if(incompleteItem){
    await git(f.entry.objects,['fetch','--no-tags',fix.workspace,fix.H1]);
    const imported=await f.packet({H:fix.H1,B:first.candidate.B,incomplete:true,
      sourceAt:new Date().toISOString(),executionAt:new Date().toISOString()});
    assert.equal(f.q.status().items.find((item:any)=>item.id===imported.item).summary.evidenceComplete,false);
  }
  await sourceTick(f.store);
  f.live.observation=await readEventSource(remote.profile,1,join(remote.root,'fresh-published-source'));
  return {f,first,fix,remote};
}

if(process.env.TONGXU_TEST_DOCKER_CONFIG){
  test('formal idle ticks preserve a new work automatic publication opportunity and one successor',async t=>{
    let clock:ReturnType<typeof foregroundClock>|undefined;
    t.after(()=>clock?.restore());
    const {f,first,fix}=await publishedFixture(t,false,async f=>{
      clock=foregroundClock(f.controls);
      const read=(f.controls as any).read;
      let sourceReads=0;
      (f.controls as any).read=async(...args:any[])=>{sourceReads++;return read(...args);};
      f.controls.start();
      for(let tick=0;tick<360;tick++)await clock.tick();
      assert.equal(sourceReads,0,'idle discovery cannot perform remote source reads');
      assert.equal(clock.pending(),1,'idle time cannot exhaust later automatic work');
    });
    try{
      const before=(await f.calls()).length;
      await clock!.tick();
      const child=(await f.controls.state())[0]!.requests.find((r:any)=>r.previousOperation===first.operation);
      assert.ok(child);assert.equal((await ended(f,child.operation)).phase,'pass');
      assert.equal(child.candidate.H,fix.H1);
      await clock!.tick();await f.controls.advance();await f.controls.begin(f.entry.id,child.operation);
      assert.equal((await f.calls()).length,before+1,'repeat checks and start cannot duplicate the successor review');
      await f.controls.drain();
      const cold=await FormalReviewControls.load(f.catalog,hash(await readFile(f.catalog)),f.sources,undefined,async()=>f.live);
      try{await cold.advance();await cold.begin(f.entry.id,child.operation);assert.equal((await f.calls()).length,before+1);}
      finally{await cold.drain();}
    }finally{await f.controls.drain();clock!.restore();}
  });

  test('formal work automatic limit is visible and manual publication check remains usable',async t=>{
    const {f,first,fix}=await publishedFixture(t),clock=foregroundClock(f.controls);
    const read=(f.controls as any).read;
    let sourceReads=0;
    (f.controls as any).read=async(...args:any[])=>{sourceReads++;return read(...args);};
    f.live.candidate.H=first.candidate.H;
    try{
      f.controls.start();
      for(let tick=0;tick<360;tick++)await clock.tick();
      const exhausted=await f.controls.report(f.entry.id,first.operation);
      assert.deepEqual((exhausted as any).automaticContinuation,{used:360,limit:360,exhausted:true});
      assert.equal(sourceReads,360);
      await clock.tick();f.controls.start();assert.equal(sourceReads,360);assert.equal(clock.pending(),1);
      f.live.candidate.H=fix.H1;
      await f.controls.advance();
      const child=(await f.controls.state())[0]!.requests.find((r:any)=>r.previousOperation===first.operation);
      assert.ok(child);assert.equal((await ended(f,child.operation)).phase,'pass');
      assert.deepEqual((child as any).automaticContinuation,{used:0,limit:360,exhausted:false});
      assert.equal((await f.controls.report(f.entry.id,first.operation) as any).automaticContinuation.used,360);
    }finally{await f.controls.drain();clock.restore();}
  });

  test('formal stopped original stays stopped after timer start and publication',async t=>{
    const {f,first}=await publishedFixture(t),clock=foregroundClock(f.controls),before=(await f.calls()).length;
    try{
      await f.controls.stop(f.entry.id,first.operation);
      f.controls.start();await clock.tick();f.controls.start();await clock.tick();
      assert.equal((await f.controls.state())[0]!.requests.length,1);
      assert.equal((await f.calls()).length,before);
      await f.controls.drain();f.controls.start();assert.equal(clock.pending(),0);
    }finally{await f.controls.drain();clock.restore();}
  });

  for(const incompleteItem of [false,true]){
    test('formal published candidate verifies after a recent 60000ms source read; incomplete item='+incompleteItem,async t=>{
      const {f,first,fix}=await publishedFixture(t,incompleteItem);
      await f.controls.advance();
      const verification=f.q.formalReviews().forEntry(f.entry.id+':candidate-material');
      assert.equal(verification.length,1,'a matching incomplete item cannot replace the original verifier');
      assert.equal(verification[0]!.terminal?.result.status,'candidate_material_recorded');
      assert.equal(verification[0]!.stages[0].stage.role,'test');
      assert.equal(verification[0]!.stages[0].dispatched,true);
      const child=(await f.controls.state())[0]!.requests.find((row:any)=>row.round===2);
      assert.ok(child);
      const result=await ended(f,child.operation);
      assert.equal(result.phase,'pass',JSON.stringify(result.detail));
      assert.equal(result.candidate.H,fix.H1);
      assert.equal(result.candidate.B,first.candidate.B);
      const count=(await f.calls()).length;
      await f.controls.advance();
      assert.equal((await f.calls()).length,count);
      assert.equal(f.q.formalReviews().forEntry(f.entry.id+':candidate-material').length,1);
    });
  }

  for(const corrupt of [false,true]){
    test('formal original known-unstarted preparation is retained on explicit recovery; corrupt='+corrupt,async t=>{
      const {f,first,fix}=await publishedFixture(t);
      const previous=f.q.formalReviews().state(first.operation);
      const verification=join(previous.request.directory,'next-candidate','verification');
      let rejectInitialPreparation=true;
      const controls=await FormalReviewControls.load(f.catalog,hash(await readFile(f.catalog)),f.sources,undefined,async()=>{
        if(rejectInitialPreparation&&existsSync(join(verification,'verification.json')))throw new Error('formal_next_source_refresh_not_due');
        return f.live;
      });
      t.after(()=>controls.drain());
      await assert.rejects(controls.advance(),/formal_next_verifier_not_started/);
      const probe=join(verification,'docker-runtime','probe','execution.json');
      const original=await readFile(probe);
      const capture=JSON.parse(original.toString());
      assert.equal(capture.phase,'not_started');
      assert.equal(capture.cleanup,'removed');
      assert.equal(capture.clientPid,undefined);
      rejectInitialPreparation=false;
      const before=(await f.calls()).length;
      await assert.rejects(controls.advance(false),/formal_next_verifier_preparation_requires_original_inspection/);
      assert.equal((await f.calls()).length,before,'a background tick cannot authorize another preparation');
      if(corrupt){
        await writeFile(probe,JSON.stringify({...capture,phase:'started',cleanup:'unknown'}));
        const retained=await readFile(probe);
        await assert.rejects(controls.advance(),/formal_original_next_verifier_unknown|formal_next_verifier_preparation_requires_original_inspection/);
        assert.deepEqual(await readFile(probe),retained);
        assert.equal((await f.calls()).length,before);
        return;
      }
      await controls.advance();
      assert.deepEqual(await readFile(probe),original);
      const child=(await controls.state())[0]!.requests.find((row:any)=>row.round===2);
      assert.ok(child);
      const result=await ended({...f,controls},child.operation);
      assert.equal(result.phase,'pass',JSON.stringify(result.detail));
      assert.equal(result.candidate.H,fix.H1);
      const verified=f.q.formalReviews().forEntry(f.entry.id+':candidate-material');
      assert.equal(verified.length,1);
      assert.notEqual(verified[0]!.stages[0].stage.directory,verification);
      assert.equal((await f.calls()).length,before+1);
    });
  }

  test('a manual fresh review of the known published fix verifies partial material and retains its predecessor',async t=>{
    const {f,first,fix}=await publishedFixture(t,true);
    const next=await f.controls.prepare(f.entry.id,'explicit-fresh-review');
    assert.equal(next.previousOperation,first.operation);
    assert.equal(next.candidate.H,fix.H1);
    assert.equal(f.q.formalReviews().forEntry(f.entry.id+':candidate-material').length,1);
    const original=f.q.formalReviews().state(next.operation);
    assert.equal(original.request.project.objects,fix.workspace);
    assert.equal((await f.controls.prepare(f.entry.id,'explicit-fresh-review')).operation,next.operation);
    await f.controls.begin(f.entry.id,next.operation);
    assert.equal((await ended(f,next.operation)).phase,'pass');
    const calls=(await f.calls()).length;
    await f.controls.advance();
    assert.equal((await f.calls()).length,calls);
  });

  for(const publication of ['valid','missing-observation','missing-record']){
    test('manual fresh review with independently complete material still checks original publication; '+publication,async t=>{
      const {f,first,fix,remote}=await publishedFixture(t);
      await git(f.entry.objects,['fetch','--no-tags',fix.workspace,fix.H1]);
      const imported=await f.packet({H:fix.H1,B:first.candidate.B,
        sourceAt:new Date().toISOString(),executionAt:new Date().toISOString()});
      const pollDirectory=join(f.store,'source-poll-1-'+randomUUID());
      const poll=f.q.events().beginPoll(1,pollDirectory,true);
      assert.equal(poll.started,true);
      if(!poll.started)throw new Error('fixture_explicit_poll_required');
      f.q.events().observe(1,poll.sequence,await readEventSource(remote.profile,1,pollDirectory,poll.knownPublished));
      f.q.events().reconcilePackets();
      assert.equal(f.q.status().items.find((item:any)=>item.id===imported.item).summary.evidenceComplete,true);
      const current=f.q.formalReviews().currentSource(imported.item);
      assert.equal(current.current,true,JSON.stringify(current.prerequisites));
      assert.deepEqual(current.prerequisites,[]);
      const calls=(await f.calls()).length;
      assert.equal(f.q.reviewRecords().status().events.filter((event:any)=>event.kind==='repair_batch_published').length,0);
      if(publication==='missing-observation')delete f.live.observation;
      if(publication==='missing-record'){
        await remote.change({body:'Explicit fixture PR body without its required original fix record.'});
        f.live.observation=await readEventSource(remote.profile,1,join(remote.root,'changed-publication'));
      }
      if(publication!=='valid'){
        await assert.rejects(f.controls.prepare(f.entry.id,'complete-manual-review'),
          /formal_actual_remote_publication_observation_required|formal_remote_fix_and_record_not_verified/);
        assert.equal((await f.calls()).length,calls);
        assert.equal(f.q.formalReviews().forEntry(f.entry.id).length,1);
        assert.equal(f.q.reviewRecords().status().events.filter((event:any)=>event.kind==='repair_batch_published').length,0);
      }else{
        const next=await f.controls.prepare(f.entry.id,'complete-manual-review');
        assert.equal(next.previousOperation,first.operation);
        assert.equal(f.q.reviewRecords().status().events.filter((event:any)=>event.kind==='repair_batch_published').length,1);
        await f.controls.begin(f.entry.id,next.operation);
        assert.equal((await ended(f,next.operation)).phase,'pass');
        await f.controls.advance();
        assert.equal(f.q.reviewRecords().status().events.filter((event:any)=>event.kind==='repair_batch_published').length,1);
        assert.equal((await f.calls()).length,calls+1);
      }
      assert.equal(f.q.formalReviews().forEntry(f.entry.id+':candidate-material').length,0,
        'complete independently supplied material is reusable without another Docker verification');
    });
  }
}
