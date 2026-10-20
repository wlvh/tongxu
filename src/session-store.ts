import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { hash } from './snapshot.js';
import { canonical } from './comparison.js';
import { now } from './contract.js';
import { parseSessionReadSpec,requireSessionObservation,type SessionObservation } from './session-source.js';
import { requireArchivedSession,type ArchivedSession } from './session-capture.js';

type Row=Record<string,any>;
const roles=['secretary','issue_owner','implementer','reviewer','verifier_fact','verifier_impact','receiver','external_report','acceptance'];
/** Associations are observations beside the original queue. They grant no
 * actor identity, writer ownership, message delivery or session control. */
export class SessionRecords {
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private directory:string,private item:(id:string)=>Row){}
  private event(kind:string,id:string,data:unknown){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('session_'+kind,'session:'+id,JSON.stringify(data),now());}
  private events(id:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'session_%' ORDER BY id").all('session:'+id) as Row[]).map(e=>({...e,data:JSON.parse(e.data)}));}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('session_original_missing_or_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private original(id:string){const event=this.events(id).find(e=>e.kind==='session_read_prepared');if(!event)throw new Error('original_session_read_required');const saved=event.data,plan=JSON.parse(this.bytes(saved.planSha256).toString());if(hash(canonical(plan))!==saved.planSha256)throw new Error('session_original_plan_changed');return {saved,plan};}
  prepare(id:string,raw:Buffer){return this.transaction(()=>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)||raw.length>16384)throw new Error('session_read_request_invalid');
    const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
    if(!p||Object.keys(p).sort().join()!=='item,kind,role,schemaVersion,source'||p.schemaVersion!==1||p.kind!=='tongxu-session-association'||!roles.includes(p.role)||!(/^[a-f0-9]{64}$/).test(p.item))throw new Error('session_association_invalid');
    const spec=parseSessionReadSpec(Buffer.from(canonical(p.source))),encoded=Buffer.from(canonical(p));
    if(this.events(id).some(e=>e.kind==='session_capture_linked'))throw new Error('session_request_kind_changed');
    if(this.events(id).some(e=>e.kind==='session_read_prepared')){const old=this.original(id);if(old.saved.planSha256!==hash(encoded))throw new Error('session_read_request_changed');return {...this.view(id),duplicate:true};}
    const item=this.item(p.item);
    const owner=(this.db.prepare("SELECT value FROM meta WHERE key='owner_authority_profile'").get() as Row)?.value;
    if(owner&&(JSON.parse(this.bytes(owner).toString()).executionKind==='fixture')!==(spec.executionKind==='fixture'))throw new Error('session_owner_profile_kind_mismatch');
    if(spec.executionKind==='fixture'&&(this.db.prepare("SELECT 1 FROM operations WHERE json_extract(result,'$.receiver.executionKind')='native_capture'").get()))throw new Error('fixture_session_reader_requires_non_native_queue');
    const saved={requestId:id,planSha256:this.blob(encoded),originalSha256:this.blob(raw),item:p.item,requestedRole:p.role,binding:item,spec,directory:join(this.directory,'session-read-'+hash(id),'capture'),preparedAt:now(),associationSource:'operator_declared_readonly_link',executionCandidateVerified:false,controlPermissionGranted:false};
    this.event('read_prepared',id,saved);return {...this.view(id),duplicate:false};
  });}
  linkCapture(id:string,itemId:string,role:string,source:ArchivedSession){return this.transaction(()=>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)||!roles.includes(role))throw new Error('session_capture_link_invalid');requireArchivedSession(source);
    if(source.recordedRole!==null&&source.recordedRole!==role)throw new Error('archived_session_role_mismatch');
    if(this.events(id).some(e=>e.kind==='session_read_prepared'))throw new Error('session_request_kind_changed');
    const originals=Object.fromEntries(Object.entries(source.originals).map(([name,b])=>[name,{sha256:hash(b),bytes:b.length}])),sourceIndex={...source,originals};
    const old=this.events(id).find(e=>e.kind==='session_capture_linked');if(old){if(old.data.item!==itemId||old.data.requestedRole!==role||canonical(old.data.source)!==canonical(sourceIndex))throw new Error('session_capture_link_changed');return {...this.view(id),duplicate:true};}
    const binding=this.item(itemId),c=source.candidate,current=binding.candidate,candidateMatches=Boolean(c&&c.repository?.toLowerCase()===current.repository.toLowerCase()&&c.pr===current.pr&&c.H===current.H&&c.B===current.B&&(c.target??c.targetRef)===current.targetRef);
    for(const b of Object.values(source.originals))this.blob(b);
    this.event('capture_linked',id,{requestId:id,item:itemId,requestedRole:role,binding,source:sourceIndex,sourceSha256:this.blob(Buffer.from(canonical(sourceIndex))),capturedCandidateMatches:candidateMatches,associationSource:'operator_linked_validated_archive',executionCandidateVerified:false,controlPermissionGranted:false});return {...this.view(id),duplicate:false};
  });}
  started(id:string){return this.transaction(()=>{this.original(id);if(this.events(id).some(e=>['session_read_started','session_read_observed'].includes(e.kind)))throw new Error('original_session_read_already_started');this.event('read_started',id,{controllerPid:process.pid,startedAt:now(),modelRequestsSent:0});return this.view(id);});}
  observe(id:string,observation:SessionObservation){return this.transaction(()=>{
    const {saved}=this.original(id);requireSessionObservation(observation,saved.spec);
    if(observation.directory!==saved.directory||!this.events(id).some(e=>e.kind==='session_read_started'))throw new Error('session_original_reader_mismatch');
    const references=Object.fromEntries(Object.entries(observation.originals).map(([name,b])=>[name,{sha256:hash(b),bytes:b.length}]));
    const data={observedAt:observation.observedAt,metadata:observation.metadata,gap:observation.gap,reader:observation.reader,originals:references,recoveredFromOriginalCapture:observation.replayed,modelRequestsSent:0,unexpectedExecutionObserved:observation.unexpectedExecutionObserved,controlPermissionGranted:false};
    const encoded=Buffer.from(canonical(data)),existing=this.events(id).find(e=>e.kind==='session_read_observed');if(existing){if(existing.data.observationSha256!==hash(encoded))throw new Error('original_session_observation_changed');return {...this.view(id),duplicate:true};}
    for(const b of Object.values(observation.originals))this.blob(b);this.event('read_observed',id,{...data,observationSha256:this.blob(encoded)});return {...this.view(id),duplicate:false};
  });}
  problem(id:string,reason:string){return this.transaction(()=>{this.original(id);this.event('read_problem',id,{reason:reason.slice(0,512),automaticResend:false});return this.view(id);});}
  private view(id:string){
    const archived=this.events(id).find(e=>e.kind==='session_capture_linked')?.data;
    if(archived){if(canonical(JSON.parse(this.bytes(archived.sourceSha256).toString()))!==canonical(archived.source))throw new Error('archived_session_index_changed');for(const r of Object.values(archived.source.originals) as Row[])if(this.bytes(r.sha256).length!==r.bytes)throw new Error('session_original_length_changed');let current=false;try{const item=this.item(archived.item);current=item.current&&item.packet===archived.binding.packet&&item.fingerprint===archived.binding.fingerprint;}catch{}return {...archived,status:'archived_result_linked',bindingCurrent:Boolean(current),currentNativeStatus:'not_observed',actualRoleBehaviorVerified:false,writerOwnershipVerified:false,controlPermissionGranted:false};}
    const {saved}=this.original(id),events=this.events(id),result=events.find(e=>e.kind==='session_read_observed')?.data;
    if(result){const {observationSha256,...data}=result;if(canonical(JSON.parse(this.bytes(observationSha256).toString()))!==canonical(data))throw new Error('session_observation_index_changed');for(const r of Object.values(result.originals) as Row[])if(this.bytes(r.sha256).length!==r.bytes)throw new Error('session_original_length_changed');}
    let bindingCurrent=false;try{const current=this.item(saved.item);bindingCurrent=current.packet===saved.binding.packet&&current.fingerprint===saved.binding.fingerprint&&current.current;}catch{}
    return {...saved,status:result?result.metadata?'metadata_observed':'metadata_unavailable':events.some(e=>e.kind==='session_read_started')?'read_started_or_unknown':'prepared_not_started',observation:result??null,bindingCurrent:Boolean(bindingCurrent),recentMetadataRead:Boolean(result?.metadata&&Date.now()-Date.parse(result.observedAt)<=300000),currentNativeStateVerified:false,latestProblem:events.filter(e=>e.kind==='session_read_problem').at(-1)?.data??null,automaticResend:false,actualRoleBehaviorVerified:false,writerOwnershipVerified:false,controlPermissionGranted:false};
  }
  status(id:string){return this.transaction(()=>this.view(id));}
}
