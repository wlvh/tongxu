import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {parseTaskCandidateLink} from './task-link-contract.js';
import {requireTaskLinkSource,taskLinkSourceMatches,taskLinkSourceIdentity,type TaskLinkSource} from './task-link-source.js';
import type {TaskRecords} from './task-store.js';
type Row=Record<string,any>;

/** Associations are immutable references to two original packets, never a
 * replacement item, a fabricated candidate or an authorization transfer. */
export class TaskCandidateLinks {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private tasks:TaskRecords,private candidate:(id:string)=>Row){}
  configuration(){if((this.db.prepare('PRAGMA user_version').get() as Row).user_version!==16||(this.db.prepare("SELECT value FROM meta WHERE key='task_candidate_link_contract'").get() as Row)?.value!=='exact-original-packets-v1')throw new Error('task_candidate_link_format_not_enabled');return {schemaVersion:16,contract:'exact-original-packets-v1'};}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('task_candidate_link_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private latestSource(task:string){
    const row=this.db.prepare("SELECT data FROM events WHERE kind='task_candidate_source_observed' AND object=? ORDER BY id DESC LIMIT 1").get(task) as Row;if(!row)return null;
    const record=JSON.parse(row.data),v=record.value??record;
    if(record.value&&canonical(JSON.parse(this.bytes(record.sha256).toString()))!==canonical(v))throw new Error('task_candidate_source_index_changed');
    const source=JSON.parse(this.bytes(v.proofSha256).toString());if(taskLinkSourceIdentity(source)!==v.signature||(v.watermark??source.observedAt)!==source.observedAt)throw new Error('task_candidate_source_index_changed');return {...v,watermark:source.observedAt,conflict:v.conflict===true,source};
  }
  hasSource(task:string){return !!this.db.prepare("SELECT 1 FROM events WHERE kind='task_candidate_source_observed' AND object=?").get(task);}
  observe(source:TaskLinkSource){return this.transaction(()=>{
    this.configuration();const task=source.observation.taskId,current=this.tasks.current(task);requireTaskLinkSource(source,current.definition);if(source.observation.materialSha256!==current.fingerprint)throw new Error('task_candidate_source_refresh_required');
    const signature=taskLinkSourceIdentity(source),old=this.latestSource(task),time=Date.parse(source.observedAt),previous=old?Date.parse(old.watermark):-Infinity;
    if(time<previous)throw new Error('task_link_source_observation_older');
    const value={signature,proofSha256:this.blob(Buffer.from(canonical(source))),watermark:source.observedAt,conflict:!!old&&time===previous&&(old.conflict||old.signature!==signature)};
    // Retain a newer observation even when bytes/modes are unchanged. Otherwise
    // a delayed older changed observation could overwrite that newer witness.
    if(old?.proofSha256!==value.proofSha256||old?.conflict!==value.conflict){const sha256=this.blob(Buffer.from(canonical(value)));this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('task_candidate_source_observed',task,canonical({value,sha256}),now());}
    return value;
  });}
  private events(task:string){if(this.hasSource(task))this.configuration();return (this.db.prepare("SELECT * FROM events WHERE kind='task_candidate_linked' AND object=? ORDER BY id").all(task) as Row[]).map(e=>{const r=JSON.parse(e.data);if(canonical(JSON.parse(this.bytes(r.sha256).toString()))!==canonical(r.value))throw new Error('task_candidate_link_index_changed');const record=r.value;this.bytes(record.proofSha256);this.bytes(record.requestSha256);return {...record,link: r.sha256,recordedAt:e.observed_at};});}
  private match(task:Row,candidate:Row){const t=task.manifest.candidate,c=candidate.candidate;
    if(c.kind==='development-task'||!Number.isSafeInteger(c.pr)||c.pr<1||candidate.subjectSha256)throw new Error('task_link_requires_individual_pr_candidate');
    if(t.repository.toLowerCase()!==c.repository.toLowerCase()||['H','B','targetRef'].some(k=>t[k]!==c[k])||canonical(task.context.scope)!==canonical(candidate.context.scope))throw new Error('task_link_exact_candidate_or_scope_mismatch');
    if(!candidate.current)throw new Error('task_link_candidate_not_current');
  }
  attach(raw:Buffer,source:TaskLinkSource){return this.transaction(()=>{
    this.configuration();
    const p=parseTaskCandidateLink(raw),task=this.tasks.current(p.task);requireTaskLinkSource(source,task.definition);taskLinkSourceMatches(source);const signature=taskLinkSourceIdentity(source),latest=this.latestSource(p.task);if(latest?.conflict)throw new Error('task_link_source_order_conflict');if(latest?.signature!==signature)throw new Error('task_candidate_source_refresh_required');
    if(task.fingerprint!==source.observation.materialSha256)throw new Error('task_link_task_material_changed');const candidate=this.candidate(p.candidateItem);this.match(task,candidate);
    const binding={task:p.task,taskPacket:task.packet,taskFingerprint:task.fingerprint,sourceSignature:signature,candidateItem:p.candidateItem,candidatePacket:candidate.packet,candidateFingerprint:candidate.fingerprint,candidate:candidate.candidate,context:candidate.context};
    const identity=hash(canonical(binding)),old=this.events(p.task).find(e=>e.identity===identity);if(old)return {...this.project(old),duplicate:true};
    const value={identity,...binding,requestSha256:this.blob(raw),proofSha256:this.blob(Buffer.from(canonical(source))),candidateEvidenceComplete:candidate.evidenceComplete,candidatePrerequisitesAtLink:candidate.prerequisites.length,selectedFilesOnly:true,wholeWorkspaceClean:false,permissionGranted:false};const link=this.blob(Buffer.from(canonical(value)));
    this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('task_candidate_linked',p.task,canonical({value,sha256:link}),now());return {...this.project({...value,link,recordedAt:now()}),duplicate:false};
  });}
  private project(record:Row){let current=false,reason:string|null=null;try{const task=this.tasks.current(record.task),candidate=this.candidate(record.candidateItem),latest=this.latestSource(record.task);this.match(task,candidate);if(!latest)throw new Error('task_candidate_source_refresh_required');if(latest.conflict)throw new Error('task_link_source_order_conflict');taskLinkSourceMatches(latest.source);current=task.packet===record.taskPacket&&task.fingerprint===record.taskFingerprint&&candidate.packet===record.candidatePacket&&candidate.fingerprint===record.candidateFingerprint&&latest.signature===record.sourceSignature;if(!current)reason='task_or_candidate_packet_changed';}catch(e){reason=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'original_material_unavailable';}
    const c=record.candidate,proof=JSON.parse(this.bytes(record.proofSha256).toString()),modeVerified=proof.executableModeContract==='git-owner-execute-bit';return {link:record.link,task:record.task,taskPacket:record.taskPacket,candidateItem:record.candidateItem,candidatePacket:record.candidatePacket,repository:c.repository,pr:c.pr,H:c.H,B:c.B,target:c.targetRef,sourceProofSha256:record.proofSha256,recordedAt:record.recordedAt,current,reason,candidateEvidenceCompleteAtLink:record.candidateEvidenceComplete,candidatePrerequisitesAtLink:record.candidatePrerequisitesAtLink,selectedFilesOnly:true,selectedIndexMatchedAtLink:true,selectedExecutableModesMatchedAtLink:modeVerified,executableModeContract:modeVerified?'git-owner-execute-bit':null,wholeWorkspaceClean:false,externalStateRechecked:false,permissionGranted:false};
  }
  state(task:string){return this.transaction(()=>{this.tasks.current(task);return this.events(task).map(e=>this.project(e));});}
  material(task:string,link?:string){return this.transaction(()=>{
    const records=this.events(task),current=records.filter(r=>(!link||r.link===link)&&this.project(r).current);if(current.length>1&&new Set(current.map(r=>r.candidateItem)).size>1)throw new Error('task_multiple_current_candidates_require_selection');
    const r=current.at(-1);if(!r)return null;const candidate=this.candidate(r.candidateItem);return {association:this.project(r),originalCandidate:{candidate:candidate.candidate,context:candidate.context,packet:candidate.packet,fingerprint:candidate.fingerprint,manifestSha256:candidate.manifestSha256,verificationSha256:candidate.verificationSha256,collection:candidate.collection,verification:candidate.verification},sourceArtifactScope:'W1/W2 structured original indexes; raw output and artifact bodies are not supplied by this association view',formalAcceptance:false,permissionGranted:false};
  });}
  requireCurrent(task:string,link:string){return this.transaction(()=>{const record=this.events(task).find(r=>r.link===link);if(!record)throw new Error('task_candidate_link_not_found');const state=this.project(record);if(!state.current)throw new Error('task_candidate_link_no_longer_current');return state;});}
}
