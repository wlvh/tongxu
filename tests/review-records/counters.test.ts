import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ReviewRecords } from '../../src/review-record-store.js';
import { hash } from '../../src/snapshot.js';

// Explicit storage fixtures: these values exercise provenance joins and do NOT
// claim native execution, GitHub publication or an actual reflection took place.
test('only matched published new candidates count, four batches create one persisted reflection, unrelated PRs and repeats cannot affect it',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,kind TEXT,object TEXT,data TEXT,observed_at TEXT);CREATE TABLE operations(id TEXT PRIMARY KEY,packet INTEGER,status TEXT,result TEXT);CREATE TABLE claims(target TEXT,operation TEXT);CREATE TABLE blobs(hash TEXT PRIMARY KEY,bytes BLOB);PRAGMA user_version=6;`);
  const sources:Record<string,any>={},publications:Record<string,any>={};
  const r=new ReviewRecords(db,fn=>{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},id=>sources[id],id=>publications[id]);r.enable();
  const fixture=(n:number,pr=1)=>{
    const id='repair-'+n,H=String(n).repeat(40).slice(0,40),B='b'.repeat(40),candidate={repository:'fixture/reception',pr,H,B,targetRef:'base'},context={scope:{id:'S',version:'1',source:'fixture:adoption'}};
    const bytes=Buffer.from('{}'),sha=hash(bytes);db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,bytes);
    const repairResult={actualRepairPerformed:true,status:'completed',executionKind:'native_capture',before:{H:'a'.repeat(40)},after:{H}},resultBytes=Buffer.from(JSON.stringify(repairResult)),resultSha=hash(resultBytes);db.prepare('INSERT INTO blobs VALUES(?,?)').run(resultSha,resultBytes);
    const result={repair:{phase:'returned',bindingHash:sha,planSha256:sha,requestSha256:sha,configSha256:sha,resultSha256:resultSha,evidenceSha256:sha,counters:{actualFileWrites:1},result:repairResult}};
    db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(id,n,'complete',JSON.stringify(result));sources[id]={candidate,context};sources['publication-'+n]={candidate,context};
    publications['publication-'+n]={document:{candidate,publicationId:'publication-'+n},stages:{comment:{lastState:'verified',intent:{remotePreflight:{H,B,target:'base'}},verified:{remote:{id:n}}},status:{lastState:'verified',intent:{remotePreflight:{H,B,target:'base'}},verified:{remote:{id:n,candidateH:H}}}}};
    return {id,publication:'publication-'+n};
  };
  let chain='';
  for(let n=1;n<=4;n++){const f=fixture(n),value=r.publishedRepair(f.id,f.publication);chain=value.chain;assert.equal(value.ordinal,n);assert.equal(value.reflectionDue,n===4);assert.equal(r.publishedRepair(f.id,f.publication).duplicate,true);}
  assert.equal(r.status().events.filter(e=>e.kind==='simplification_reflection_due').length,1);
  const other=fixture(5,2);assert.equal(r.publishedRepair(other.id,other.publication).ordinal,1);
  const bad=fixture(6);publications[bad.publication].stages.status.lastState='pending';assert.throws(()=>r.publishedRepair(bad.id,bad.publication),/published_repair_not_bound/);
  publications[bad.publication].stages.status.lastState='verified';publications[bad.publication].document.candidate.B='c'.repeat(40);sources[bad.id]={...sources[bad.id],candidate:{...sources[bad.id].candidate,B:'b'.repeat(40)}};assert.throws(()=>r.publishedRepair(bad.id,bad.publication),/published_repair_not_bound/);
  const due=r.status().events.find(e=>e.kind==='simplification_reflection_due')!;
  const response=r.reflectionResponse(chain,due.id,'fixture:responsible explicit import',Buffer.from('Existing simplification report fixture'),Buffer.from('Responsible response fixture'));
  assert.equal(response.newModelDispatched,false);assert.equal(response.newPermissionGranted,false);
  assert.equal(r.reflectionResponse(chain,due.id,'fixture:responsible explicit import',Buffer.from('Existing simplification report fixture'),Buffer.from('Responsible response fixture')).duplicate,true);
  assert.throws(()=>r.reflectionResponse(chain,due.id,'fixture:responsible explicit import',Buffer.from('changed'),Buffer.from('Responsible response fixture')),/reflection_response_changed/);
  db.close();
});
