import {queueFeatureVersion} from './queue-format.js';
import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {parseDevelopmentTask,developmentTaskId,type DevelopmentTask,type TaskCandidate} from './task-contract.js';
import {inspectTaskObservation,requireTaskObservation,type TaskObservation} from './task-source.js';
type Row=Record<string,any>;
const taskSummary=(p:DevelopmentTask,o:TaskObservation)=>{const id=developmentTaskId(p);return {kind:'development-task',evidenceComplete:false,testsExecuted:false,tree:o.tree,gaps:['formal_candidate_not_attached','tests_not_executed','selected_workspace_paths_only'],originalOperations:[],limitations:['No PR exists for this task source.','Only declared paths were observed; this is not a test or acceptance report.'],observation:o.observedAt,sourceObservation:o.observedAt,task:{id,title:p.title,issue:p.issue,sourceSha256:o.materialSha256}};};

// No-PR material is never a verification report or a formal receiver input.
export const taskOperationGuard=`CREATE TRIGGER development_task_operation_guard BEFORE UPDATE ON operations
WHEN NEW.status IN ('receiving','repairing','merging') AND EXISTS(SELECT 1 FROM items WHERE id=NEW.item AND json_extract(candidate,'$.kind')='development-task')
BEGIN SELECT RAISE(ABORT,'development_task_requires_formal_candidate'); END`;

/** Uses the original queue's items, packets, blobs and event history. A task
 * remains the same task across source observations; old operations stay bound
 * to their original packet. No extra scheduler or synthetic PR is created. */
export class TaskRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T){}
  private mode(){if(![15,16].includes(queueFeatureVersion(this.db))||(this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='development_task_operation_guard'").get() as Row)?.sql!==taskOperationGuard)throw new Error('development_task_format_not_enabled');}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('task_original_missing_or_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private event(id:string,kind:string,value:unknown){const sha256=this.blob(Buffer.from(canonical(value)));this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('development_task_'+kind,id,JSON.stringify({value,sha256}),now());}
  private events(id:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'development_task_%' ORDER BY id").all(id) as Row[]).map(e=>{const d=JSON.parse(e.data);if(canonical(JSON.parse(this.bytes(d.sha256).toString()))!==canonical(d.value))throw new Error('task_history_changed');return {...e,data:d.value};});}
  definition(id:string):DevelopmentTask{this.mode();const r=this.events(id).find(e=>e.kind==='development_task_registered')?.data;if(!r)throw new Error('development_task_not_registered');const p=parseDevelopmentTask(this.bytes(r.definitionSha256));if(developmentTaskId(p)!==id)throw new Error('task_identity_changed');return p;}
  observe(p:DevelopmentTask,o:TaskObservation){return this.transaction(()=>{
    this.mode();p=parseDevelopmentTask(Buffer.from(canonical(p)));requireTaskObservation(o,p);
    if((this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row).value!==p.repository.toLowerCase())throw new Error('queue_repository_mismatch');
    const id=developmentTaskId(p),definition=Buffer.from(canonical(p)),definitionSha256=hash(definition),old=this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Row|undefined;
    if(old&&canonical(this.definition(id))!==canonical(p))throw new Error('task_definition_is_fixed');
    const at=now(),candidate:TaskCandidate={kind:'development-task',repository:p.repository,taskId:id,taskName:p.title,pr:null,H:o.head,B:o.base,targetRef:p.target,mergeBase:o.mergeBase,observedAt:o.observedAt,sourceSha256:o.materialSha256};
    const manifest={schemaVersion:1,kind:'tongxu-development-task-source',definitionSha256,candidate},manifestHash=this.blob(Buffer.from(canonical(manifest))),reportHash=this.blob(Buffer.from(canonical(o))),contextHash=this.blob(Buffer.from(canonical(p.context)));
    this.blob(definition);
    if(!old){this.db.prepare('INSERT INTO items(id,candidate,context,created_at) VALUES(?,?,?,?)').run(id,canonical(candidate),canonical(p.context),at);this.event(id,'registered',{definitionSha256});}
    const previous=old?.current_packet?this.db.prepare('SELECT * FROM packets WHERE id=?').get(old.current_packet) as Row:undefined;
    // Even repeated reads retain their actual observation; identity excludes
    // observation time so rereading an unchanged file does not start new work.
    this.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?)').run(id,o.materialSha256,manifestHash,reportHash,contextHash,o.observedAt);
    if(previous){this.evidence(previous);if(Date.parse(o.observedAt)<Date.parse(old!.latest_observation))throw new Error('task_observation_older');
      if(previous.fingerprint===o.materialSha256){this.db.prepare('UPDATE items SET latest_observation=?,latest_source_observation=? WHERE id=?').run(o.observedAt,o.observedAt,id);return {item:id,packet:previous.id,duplicate:true,sourceSha256:o.materialSha256};}}
    const summary=taskSummary(p,o);
    const packet=Number(this.db.prepare('INSERT INTO packets(item,fingerprint,manifest_hash,report_hash,context_hash,summary,created_at) VALUES(?,?,?,?,?,?,?)').run(id,o.materialSha256,manifestHash,reportHash,contextHash,canonical(summary),at).lastInsertRowid);
    this.db.prepare('UPDATE items SET current_packet=?,candidate=?,latest_observation=?,latest_source_observation=?,observation_conflict=0 WHERE id=?').run(packet,canonical(candidate),o.observedAt,o.observedAt,id);
    this.event(id,'observed',{packet,previousPacket:previous?.id??null,materialSha256:o.materialSha256,reportSha256:reportHash});
    return {item:id,packet,duplicate:false,sourceSha256:o.materialSha256};
  });}
  evidence(packet:Row){
    this.mode();const definition=this.definition(packet.item),manifest=JSON.parse(this.bytes(packet.manifest_hash).toString()),report=inspectTaskObservation(JSON.parse(this.bytes(packet.report_hash).toString()),definition),context=JSON.parse(this.bytes(packet.context_hash).toString());
    const expected={schemaVersion:1,kind:'tongxu-development-task-source',definitionSha256:hash(canonical(definition)),candidate:{kind:'development-task',repository:definition.repository,taskId:packet.item,taskName:definition.title,pr:null,H:report.head,B:report.base,targetRef:report.target,mergeBase:report.mergeBase,observedAt:report.observedAt,sourceSha256:report.materialSha256}};
    if(canonical(manifest)!==canonical(expected)||canonical(context)!==canonical(definition.context)||packet.fingerprint!==report.materialSha256||canonical(JSON.parse(packet.summary))!==canonical(taskSummary(definition,report)))throw new Error('task_packet_binding_changed');
    return {context,manifest,report,definition};
  }
  current(id:string){const i=this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Row;if(!i)throw new Error('development_task_not_registered');const p=this.db.prepare('SELECT * FROM packets WHERE id=?').get(i.current_packet) as Row,e=this.evidence(p);if(canonical(JSON.parse(i.candidate))!==canonical(e.manifest.candidate)||canonical(JSON.parse(i.context))!==canonical(e.context))throw new Error('task_current_index_changed');return {item:id,packet:p.id,fingerprint:p.fingerprint,...e};}
  context(id:string){return this.transaction(()=>{const e=this.current(id);const value={schemaVersion:1,kind:'tongxu-development-task-context',item:id,packet:e.packet,definition:e.definition,candidate:e.manifest.candidate,observation:e.report,formalCandidate:false,permissionsGranted:false};return Buffer.from(canonical(value));});}
  status(id:string){const e=this.current(id);return {id,title:e.definition.title,issue:e.definition.issue,kind:'development-task',pr:null,currentPacket:e.packet,sourceSha256:e.fingerprint,testsExecuted:false,selectedPathsOnly:true,history:this.events(id).filter(e=>e.kind==='development_task_observed').map(e=>e.data),workspaceControlGranted:false};}
}
