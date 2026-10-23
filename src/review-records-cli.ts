#!/usr/bin/env node
import { QueueStore } from './queue-store.js';
import { runQueueRepair, closeUnstartedQueueRepair } from './queue-repair.js';
import { regular } from './repair-workspace.js';
import { hash } from './snapshot.js';
import { overallReview } from './overall-review.js';
import {inspectRepairContinuation} from './repair-continuation.js';
try {
  const a = process.argv.slice(2); let result: unknown;
  if (a[0] === 'repair' && a[1] === '--plan' && (a.length === 3 || a.length === 4 && a[3] === '--reconcile-ended')) result = await runQueueRepair(a[2]!,a.length===4);
  else if(a[0]==='repair-close-unstarted'&&a[1]==='--plan'&&a[3]==='--source'&&a.length===5)result=await closeUnstartedQueueRepair(a[2]!,a[4]!);
  else if(a[0]==='continuation-source'&&a[1]==='--store'&&a[3]==='--operation'&&a[5]==='--mode'&&a[7]==='--source'&&a.length===9)result=await inspectRepairContinuation(a[2]!,a[4]!,a[6]!,a[8]!);
  else if(a[0]==='overall-close-unstarted'&&a[1]==='--plan'&&a[3]==='--source'&&a.length===5)result=await overallReview(a[2]!,'close-unstarted',a[4]!);
  else if (['overall-prepare','overall-run','overall-reconcile'].includes(a[0]!) && a[1]==='--plan' && a.length===3) result=await overallReview(a[2]!,a[0]!.slice(8) as 'prepare'|'run'|'reconcile');
  else if (a.length === 3 && ['enable','status'].includes(a[0]!) && a[1] === '--store') { const q=await QueueStore.open(a[2]!); try { result=a[0]==='enable'?q.reviewRecords().enable():q.reviewRecords().status(); } finally { q.close(); } }
  else if (a.length === 3 && a[0]==='record' && a[1]==='--request') {
    const p=JSON.parse((await regular(a[2]!)).toString()), q=await QueueStore.open(p.store);
    try { const r=q.reviewRecords();
      if (p.kind==='judgment') result=r.registerJudgment(p.operation,p.classification);
      else if (p.kind==='sample') result=r.sample(p.id,p.judgmentIds,p.reason,p.source);
      else if (p.kind==='published-repair') result=r.publishedRepair(p.operation,p.publicationOperation);
      else if (p.kind==='reflection-response') {
        const report=await regular(p.report.path), response=await regular(p.responsibleResponse.path);
        if(hash(report)!==p.report.sha256||hash(response)!==p.responsibleResponse.sha256) throw new Error('reflection_material_changed');
        result=r.reflectionResponse(p.chain,p.triggerEvent,p.source,report,response);
      }
      else if (p.kind==='feedback') {
        const originals:Record<string,Buffer>={};
        if (!Array.isArray(p.material) || p.material.length>30) throw new Error('feedback_material_invalid');
        for(const m of p.material) { const b=await regular(m.path,1024*1024); if(hash(b)!==m.sha256 || Object.hasOwn(originals,m.name)) throw new Error('feedback_material_changed'); originals[m.name]=b; }
        result=r.feedback(p.judgmentId,p.record,originals);
      } else throw new Error('unknown_review_record_kind');
    } finally { q.close(); }
  } else throw new Error('usage: enable|status --store ABS | repair --plan ABS [--reconcile-ended] | record --request ABS');
  process.stdout.write(JSON.stringify(result)+'\n');
} catch(e) { process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'review_records_error'})+'\n'); process.exitCode=1; }
