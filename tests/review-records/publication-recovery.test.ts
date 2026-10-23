import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ReviewRecords} from '../../src/review-record-store.js';
import {hash} from '../../src/snapshot.js';

// Storage fixtures only. Native-shaped records below are deliberately synthetic;
// these checks do not represent model execution or actual GitHub publication.
function fixture(t:test.TestContext) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,kind TEXT,object TEXT,data TEXT,observed_at TEXT);
    CREATE TABLE operations(id TEXT PRIMARY KEY,packet INTEGER,status TEXT,result TEXT,target TEXT,generation INTEGER,finished_at TEXT);
    CREATE TABLE claims(target TEXT,operation TEXT,generation INTEGER);CREATE TABLE blobs(hash TEXT PRIMARY KEY,bytes BLOB);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO meta VALUES('seats','2');PRAGMA user_version=6;`);
  const sources:Record<string,any>={},publications:Record<string,any>={};
  const open=()=>new ReviewRecords(db,fn=>{db.exec('BEGIN');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},id=>sources[id],id=>publications[id]);
  const records=open();records.enable();
  const blob=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)),sha=hash(bytes);db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,bytes);return sha;};
  const add=(n:number)=>{
    const id=`repair-${n}`,publication=`publication-${n}`,H=n.toString(16).padStart(40,'0'),beforeH='a'.repeat(40),B='b'.repeat(40),candidate={repository:'fixture/reception',pr:1,H:beforeH,B,targetRef:'base'},context={scope:{id:'S',version:'1',source:'fixture:adoption'}},sha=blob({});
    const result={actualRepairPerformed:true,status:'completed',executionKind:'native_capture',before:{H:beforeH},after:{H}},repair={phase:'returned',bindingHash:sha,planSha256:sha,requestSha256:sha,configSha256:sha,resultSha256:blob(result),evidenceSha256:blob({fixture:true}),counters:{actualFileWrites:1},result};
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(id,n,'complete',JSON.stringify({repair}),'fixture/base',1,null);
    sources[id]={candidate,context};sources[publication]={candidate:{...candidate,H},context:structuredClone(context)};
    const preflight={H,B,target:'base'};
    publications[publication]={document:{candidate:{...candidate,H},publicationId:publication},stages:{comment:{lastState:'verified',intent:{remotePreflight:{...preflight}},verified:{remote:{id:n}}},status:{lastState:'verified',intent:{remotePreflight:{...preflight}},verified:{remote:{id:n,candidateH:H}}}}};
    db.prepare('INSERT INTO events(kind,object,data) VALUES(?,?,?)').run('publication_verified','publication:'+publication,JSON.stringify({stage:'status'}));
    return {id,publication,repair};
  };
  const next=()=>{
    const id='next',candidate=sources['repair-4'].candidate,context=sources['repair-4'].context,receiver={judgment:{verdict:'RETURN_FOR_WORK'},judgmentId:'j',bindingHash:'binding',controllerReturned:true,executionKind:'native_capture'};
    sources[id]={candidate,context,receiver};db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(id,10,'complete','{}','fixture/base',1,null);
    const bytes=(x:unknown)=>Buffer.from(JSON.stringify(x));
    return [id,bytes({operation:id,packet:10,judgmentId:'j',bindingHash:'binding',context}),bytes({candidate:{...candidate,target:candidate.targetRef},authorization:{allowRepair:true,source:'fixture:existing permission'},executionRoot:'/fixture/new-root'}),bytes({executionKind:'native_capture'})] as const;
  };
  return {db,records,open,add,next,sources,publications};
}

test('published receipts recover once after reopening; partial, wrong candidate/scope and simulated repairs never count',t=>{
  const f=fixture(t),valid=f.add(1);
  const mutations=[
    (x:any,p:any)=>{p.stages.status.lastState='problem';},
    (x:any,p:any)=>{p.stages.comment.lastState='problem';},
    (x:any,p:any)=>{p.document.candidate.B='c'.repeat(40);},
    (x:any,p:any)=>{p.document.candidate.pr=2;},
    (x:any,p:any)=>{p.stages.status.intent.remotePreflight.H='d'.repeat(40);},
    (x:any,p:any)=>{p.stages.comment.intent.remotePreflight.target='other';},
    (x:any,p:any)=>{f.sources[x.publication].context.scope.version='2';},
    (x:any)=>{x.repair.result.executionKind='fixture';},
    (x:any)=>{x.repair.counters.actualFileWrites=0;},
    (x:any)=>{x.repair.result.before.H=x.repair.result.after.H;},
    (x:any,p:any)=>{delete p.stages.status.intent;},
    (x:any,p:any)=>{p.stages.status.verified.remote.candidateH='e'.repeat(40);}
  ];
  mutations.forEach((mutate,i)=>{const x=f.add(i+2);mutate(x,f.publications[x.publication]);f.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify({repair:x.repair}),x.id);});
  const first=f.open().reconcilePublishedRepairs();assert.equal(first.recorded,1);assert.equal(first.batches[0]!.operation,valid.id);
  assert.equal(first.newModelInputs,0);assert.equal(first.newRemoteRequests,0);
  const events=f.records.status().events;assert.equal(f.open().reconcilePublishedRepairs().recorded,0);assert.deepEqual(f.records.status().events,events);
  // A second publication of the same new H still belongs to the original batch.
  f.publications.copy=structuredClone(f.publications[valid.publication]);f.sources.copy=f.sources[valid.publication];
  f.db.prepare('INSERT INTO events(kind,object,data) VALUES(?,?,?)').run('publication_verified','publication:copy',JSON.stringify({stage:'status'}));
  assert.equal(f.records.reconcilePublishedRepairs().recorded,0);assert.equal(f.records.status().events.filter(e=>e.kind==='repair_batch_published').length,1);
});

test('next repair admission backfills all four batches and persists its refusal; only an original reflection response reopens it',t=>{
  const f=fixture(t);for(let n=1;n<=4;n++)f.add(n);const request=f.next();
  assert.throws(()=>f.records.reserve(...request),/simplification_reflection_due/);
  const saved=f.open().status().events,trigger=saved.find(e=>e.kind==='simplification_reflection_due')!;
  assert.equal(saved.filter(e=>e.kind==='repair_batch_published').length,4);assert.ok(trigger);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM claims').get()!.n,0);
  assert.throws(()=>f.open().reserve(...request),/simplification_reflection_due/);assert.deepEqual(f.records.status().events,saved);
  const chain=trigger.data.trigger.chain;
  f.records.reflectionResponse(chain,trigger.id,'fixture:existing report and original A response',Buffer.from('bounded fixture reflection'),Buffer.from('A response fixture'));
  assert.equal(f.records.reserve(...request).repair.phase,'reserved');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM claims').get()!.n,1);
});

test('an absent original result fails recovery rather than silently approving the next repair',t=>{
  const f=fixture(t),x=f.add(1);f.db.prepare('DELETE FROM blobs WHERE hash=?').run(x.repair.resultSha256);
  assert.throws(()=>f.records.reconcilePublishedRepairs(),/review_original_changed/);
  assert.equal(f.records.status().events.length,0);
});
