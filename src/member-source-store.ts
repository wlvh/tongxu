import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {currentEventSource} from './event-gates.js';
import type {AuthorityCandidateSource} from './authority-contract.js';
import type {CoordinationRecords} from './coordination-store.js';
import type {ConditionalMemberCollection} from './conditional-entry-source.js';
type Row=Record<string,any>;

/** A source observation for an exact controlled new head. It is not a queue
 * packet or a test result. The original source and repair remain historical. */
export class MemberSourceRecords{
 constructor(private db:DatabaseSync,private records:CoordinationRecords,private base:(origin:string,entry:string,task:string)=>Row,private item:(id:string)=>Row){}
 private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('member_source_original_changed');return b;}
 private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);return sha;}
 private original(ref:AuthorityCandidateSource){
  const row=this.db.prepare("SELECT data FROM events WHERE kind='member_candidate_source_recorded' AND object=?").get('member-source:'+ref.sha256) as Row|undefined;if(!row)throw new Error('member_source_not_recorded');
  const r=JSON.parse(row.data),value=JSON.parse(this.bytes(r.sha256).toString());if(r.sha256!==ref.sha256||hash(canonical(value))!==ref.sha256)throw new Error('member_source_original_changed');this.bytes(value.manifestSha256);return value;
 }
 private current(value:Row){
  const r=this.records,entry=r.normalEntry(value.originPlan,value.entry),identity=entry&&r.normalEntryIdentity(value.entry,entry.catalogSha256),current=identity&&r.current(identity.name);
  if(!entry||!current||!r.normalEntryAncestor(current.id,value.entry,value.originPlan,entry.catalogSha256))throw new Error('member_source_current_entry_required');
  const catalog=JSON.parse(this.bytes(entry.catalogSha256).toString()),cap=catalog.repairs?.find((x:Row)=>x.task===value.task);if(!cap?.postRepair)throw new Error('member_source_capability_required');
  const collection=r.normalEntryHistory(current.id,value.entry,'member-collection-'+value.task);if(collection?.reference.kind!=='member-snapshot'||!collection.request.equals(Buffer.from(canonical(value.collection))))throw new Error('member_source_original_collection_required');
  const base=this.base(value.originPlan,value.entry,value.task);if(canonical(base.repair)!==canonical(value.collection.repair)||canonical(base.candidate)!==canonical(value.collection.candidate)||canonical(base.context)!==canonical(value.collection.context))throw new Error('member_source_original_repair_changed');
  const origin=r.reference(value.originPlan).plan,relevant=new Set<string>(base.memberReturn?[...catalog.integration.members,value.task]:[value.task]),shape=(p:Row)=>({tasks:p.tasks.filter((t:Row)=>relevant.has(t.id)).map(({item:_item,...t}:Row)=>t),actors:p.actors.filter((a:Row)=>p.tasks.some((t:Row)=>relevant.has(t.id)&&(t.actor===a.id||t.originActor===a.id))),shared:p.shared.filter((s:Row)=>s.tasks.some((id:string)=>relevant.has(id))),dependencies:p.dependencies.filter((d:Row)=>relevant.has(d.task)||relevant.has(d.producer))});
  if(base.memberReturn){if(base.subjectMembers?.length!==catalog.integration.members.length)throw new Error('member_source_configured_subject_required');const bindings=r.originalBindings(value.originPlan);for(const [i,taskId] of catalog.integration.members.entries()){const member=base.subjectMembers[i],binding=bindings[taskId];if(!member||!binding||['repository','pr','H','B','targetRef'].some(k=>member.candidate[k]!==binding.candidate[k]))throw new Error('member_source_configured_subject_required');}}
  if(canonical(shape(origin))!==canonical(shape(current.plan)))throw new Error('member_source_arrangement_changed');
  const bindings=r.originalBindings(value.originPlan);for(const task of origin.tasks.filter(t=>relevant.has(t.id)&&t.id!==value.task)){const before=bindings[task.id],now=this.item(task.item);if(!now.current||now.packet!==before.packet||now.fingerprint!==before.fingerprint)throw new Error('member_source_other_member_changed');}
  const c=value.collection.candidate,source=currentEventSource(this.db,c);if(!source.registered||!source.current)throw new Error('member_source_current_observation_required');
  if(source.profile.repositoryId!==catalog.integration.sourceReader.repositoryId)throw new Error('member_source_repository_changed');
  for(const ref of source.index.records.filter((x:Row)=>x.kind==='pr')){const p=JSON.parse(this.bytes(ref.sha256).toString());if(p.head?.repo?.id!==source.profile.repositoryId||p.base?.repo?.id!==source.profile.repositoryId||p.head.repo.full_name?.toLowerCase()!==c.repository.toLowerCase()||p.base.repo.full_name?.toLowerCase()!==c.repository.toLowerCase())throw new Error('member_source_repository_changed');}
  if(base.original.prerequisites.length)throw new Error('member_source_prerequisites_unmet');
  if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND stopped=1 AND kind IN ('investment','implementation','candidate')").get(base.context.scope.id))throw new Error('member_recomposition_stopped');return base;
 }
 register(originPlan:string,entry:string,task:string,collection:ConditionalMemberCollection,manifest:Buffer){
  const m=JSON.parse(manifest.toString());if(collection.task!==task||m.gitComplete!==true||m.rounds.at(-1)?.current!==true||m.rounds.at(-1)?.gaps.length||['repository','pr','H','B','targetRef'].some(k=>m.candidate?.[k]!== (collection.candidate as Row)[k]))throw new Error('member_source_complete_collection_required');
  const value={schemaVersion:1,kind:'tongxu-controlled-member-observation',originPlan,entry,task,collection,manifestSha256:hash(manifest)},sha256=hash(canonical(value)),ref:AuthorityCandidateSource={kind:'controlled-member-observation',sha256};this.current(value);this.blob(manifest);
  const old=this.db.prepare("SELECT 1 FROM events WHERE kind='member_candidate_source_recorded' AND object=?").get('member-source:'+sha256);if(!old){this.blob(Buffer.from(canonical(value)));this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('member_candidate_source_recorded','member-source:'+sha256,canonical({sha256}),new Date().toISOString());}return ref;
 }
 subject(id:string,ref:AuthorityCandidateSource,current=true){
  if(ref.kind!=='controlled-member-observation'||id!==ref.sha256)throw new Error('member_source_binding_required');const value=this.original(ref),base=current?this.current(value):this.base(value.originPlan,value.entry,value.task);
  return {item:id,packet:null,fingerprint:ref.sha256,candidate:value.collection.candidate,context:base.context,subjectSha256:null,current,prerequisites:[],evidenceComplete:false,candidateSource:ref,sourceOnlyObservation:true,originalItem:base.original.item,originalPacket:base.original.packet,originalOperation:base.repair.operation};
 }
 material(ref:AuthorityCandidateSource,current=true){const record=this.original(ref);return {record,subject:this.subject(ref.sha256,ref,current)};}
}
