import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from './queue-store.js';
import { privateDirectory } from './snapshot.js';
import { regular } from './repair-workspace.js';
import { readEventSource } from './event-source.js';

/** One bounded foreground check. A caller can schedule ticks, but this module
 * installs no daemon and contains no merge/model dispatch loop. */
export async function sourceTick(store:string,advanceLocalEvaluation=false){
  await privateDirectory(store,false);const path=join(store,'event-controller.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(path,4*1024*1024);
  const lock=new DatabaseSync(path);try{lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}catch{lock.close();throw new Error('source_tick_controller_active');}
  let q:QueueStore|null=null;
  try{
    q=await QueueStore.open(store);
    const e=q.events(),profile=e.configuration(),due=e.due(),results=[];
    for(const subject of due.subjects){
      const directory=join(store,`source-poll-${subject.pr}-${randomUUID()}`),start=e.beginPoll(subject.pr,directory);if(!start.started)continue;
      try{const observation=await readEventSource(profile,subject.pr,directory,start.knownPublished);results.push(e.observe(subject.pr,start.sequence!,observation));}
      catch(error){results.push(e.problem(subject.pr,start.sequence!,error instanceof Error?error.message:'source_read_failed'));}
    }
    const materials=e.reconcilePackets();let localEvaluation=null;
    if(advanceLocalEvaluation){const selected=q.selectEvaluation('tick-'+randomUUID());localEvaluation=selected.operation?{selection:selected,result:q.evaluate(selected.operation)}:{selection:selected};}
    return {checked:results,deferred:due.deferred,materials,localEvaluation,ranking:q.scheduling(),state:e.status(),modelTasksStarted:0,mergeRequestsSent:0,sourceChecksOnly:!advanceLocalEvaluation};
  }finally{q?.close();lock.exec('ROLLBACK');lock.close();}
}
