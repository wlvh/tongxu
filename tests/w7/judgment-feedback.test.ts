import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {judgmentFeedbackFixture} from './judgment-feedback-fixture.js';
import {startWorkbench} from '../../src/workbench.js';

test('selected original judgment feedback keeps different candidates and evidence kinds separate without exposing another task or dispatching',async t=>{
 const f=await judgmentFeedbackFixture(t),app=await startWorkbench(f.workbenchPath);t.after(()=>app.close());const u=new URL(app.url),headers={Authorization:'Bearer '+u.hash.slice(1)},get=async(path:string)=>{const r=await fetch(u.origin+path,{headers});return {status:r.status,body:await r.json() as any};},before=f.q.status(),state=await get('/api/state'),view=state.body.tasks[0].judgmentFeedback;
 assert.equal(view.available,true);assert.equal(view.judgments.length,1);const j=view.judgments[0];assert.equal(j.judgmentId,f.original.judgmentId);assert.equal(j.verdict,f.original.verdict);assert.equal(j.outcome,'unobserved');assert.deepEqual(j.feedback.map((r:any)=>r.kind),['responsible_response','counterexample','later_code','assessment']);assert.equal(j.feedback[2].candidate.H,'e'.repeat(40));assert.notEqual(j.candidate.H,j.feedback[2].candidate.H);assert.equal(view.accuracyFromSilence,false);assert.equal(view.rankingAvailable,false);assert.equal(view.permissionsChanged,false);assert.equal(view.samples.length,1);assert.equal(view.samples[0].partialSelection,true);assert.equal(view.samples[0].selections.length,1);assert.ok(!JSON.stringify(view).includes('unselected confidential'));assert.ok(!JSON.stringify(view).includes(f.hidden.judgmentId));
 const path='/api/judgment-feedback-report/original?judgment='+encodeURIComponent(f.original.judgmentId)+'&feedback=counter-1',full=await get(path);assert.equal(full.status,200,JSON.stringify(full));assert.equal(full.body.report,f.counter.report);assert.equal(full.body.feedback.originalCandidate.H,f.original.candidate.H);assert.equal(full.body.permissionsChanged,false);
 assert.equal((await get(path.replace(f.original.judgmentId,f.hidden.judgmentId))).status,503);assert.equal((await get(path.replace('/original?','/unselected?'))).status,503);assert.equal((await get(path+'&executable=sh')).status,503);assert.equal((await get(path+'&feedback=other')).status,503);await get('/api/state');assert.deepEqual(f.q.status(),before);assert.deepEqual(await readFile(f.trace),f.traceBefore);
});
test('full feedback refuses changed original evidence rather than presenting unverified text as a valid saved report',async t=>{
 const f=await judgmentFeedbackFixture(t),app=await startWorkbench(f.workbenchPath);t.after(()=>app.close());const db=new DatabaseSync(join(f.store,'queue.sqlite'));try{db.prepare('UPDATE blobs SET bytes=? WHERE hash=?').run(Buffer.from('explicit corruption fixture'),f.materialSha256);}finally{db.close();}
 const u=new URL(app.url),r=await fetch(u.origin+'/api/judgment-feedback-report/original?judgment='+encodeURIComponent(f.original.judgmentId)+'&feedback=counter-1',{headers:{Authorization:'Bearer '+u.hash.slice(1)}});assert.equal(r.status,503);assert.equal((await r.json() as any).error,'review_original_changed');assert.deepEqual(await readFile(f.trace),f.traceBefore);
});
