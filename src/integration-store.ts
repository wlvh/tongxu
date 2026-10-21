import type {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {parseIntegrationRequest,integrationRequestSha256,type IntegrationRequest} from './integration-contract.js';
import type {OwnerObservation} from './authority-source.js';
import {requireIntegrationCapture,type IntegrationCapture} from './integration-producer.js';

type Row=Record<string,any>;
export type IntegrationSource={
  operation:string;item:string;packet:number;fingerprint:string;current:boolean;
  context:Row;composition:Row;report:Row;manifestSha256:string;reportSha256:string;contextSha256:string;
  originals:Map<string,Buffer>;
};
const boundIndex=`CREATE UNIQUE INDEX integration_authority_unique ON events(json_extract(data,'$.value.authorityIntent')) WHERE kind='integration_authority_bound'`;

/** The producer owns only a new private Git artifact. It neither changes an
 * author checkout nor turns an old composition into an accepted candidate. */
export class IntegrationRecords{
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private directory:string,
    private source:(operation:string)=>IntegrationSource,
    private authority:(id:string,observations:OwnerObservation[]|null)=>Row){}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('integration_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private events(id:string):Row[]{return (this.db.prepare("SELECT * FROM events WHERE object=? AND kind LIKE 'integration_%' ORDER BY id").all('integration:'+id) as Row[]).map(e=>{const ref=JSON.parse(e.data),value=JSON.parse(this.bytes(ref.sha256).toString());if(canonical(value)!==canonical(ref.value))throw new Error('integration_index_changed');return {...e,data:value};});}
  private event(id:string,kind:string,value:Row){this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('integration_'+kind,'integration:'+id,canonical({sha256:this.blob(Buffer.from(canonical(value))),value}),now());}
  private original(id:string){const record=this.events(id).find(e=>e.kind==='integration_prepared')?.data;if(!record)throw new Error('integration_not_prepared');const request=parseIntegrationRequest(this.bytes(record.requestSha256)),original=parseIntegrationRequest(this.bytes(record.originalRequestSha256)),source=JSON.parse(this.bytes(record.sourceSha256).toString());if(request.id!==id||integrationRequestSha256(request)!==record.requestSha256||canonical(request)!==canonical(original)||source.operation!==request.operation||source.composition.sha256!==request.subjectSha256||hash(canonical(source.context.scope))!==request.scopeSha256||hash(canonical(source.context.arrangement))!==request.arrangementSha256)throw new Error('integration_binding_changed');for(const sha of source.originals)this.bytes(sha);return {record,request,source};}
  private current(p:IntegrationRequest){const s=this.source(p.operation);if(!s.current)throw new Error('integration_source_not_current');if(s.composition.sha256!==p.subjectSha256||hash(canonical(s.context.scope))!==p.scopeSha256||hash(canonical(s.context.arrangement))!==p.arrangementSha256)throw new Error('integration_source_binding_changed');if(this.db.prepare("SELECT 1 FROM controls WHERE scope=? AND kind='investment' AND stopped=1").get(s.context.scope.id))throw new Error('new_investment_stopped');return s;}
  private authorityCheck(p:IntegrationRequest,s:IntegrationSource,observations:OwnerObservation[]){
    if(!this.db.prepare("SELECT 1 FROM meta WHERE key='owner_authority_profile'").get()){if(p.authorityIntent!==null)throw new Error('integration_authority_profile_missing');return;}
    if(!p.authorityIntent)throw new Error('integration_authority_required');const a=this.authority(p.authorityIntent,observations),r=a.request,c=s.composition.subject.members.at(-1).candidate;
    // Reconstructing fixed objects is a verification/preparation action, not
    // authority for a model to edit members or for a publisher to update refs.
    if(a.role!=='background'||r.action!=='test'||r.item!==s.item||a.binding?.packet!==s.packet||a.binding?.fingerprint!==s.fingerprint||r.candidate?.H!==c.H||r.candidate?.B!==c.B||r.candidate?.subjectSha256!==p.subjectSha256||r.resourceRefs.length||r.paths.length)throw new Error('integration_authority_binding_mismatch');
    if(this.db.prepare("SELECT 1 FROM events WHERE kind='delivery_validation_authority_bound' AND json_extract(data,'$.value.authorityIntent')=?").get(p.authorityIntent))throw new Error('integration_test_intent_already_bound');
    const prior=this.db.prepare("SELECT object FROM events WHERE kind='integration_authority_bound' AND json_extract(data,'$.value.authorityIntent')=?").get(p.authorityIntent) as Row|undefined;if(prior&&prior.object!=='integration:'+p.id)throw new Error('integration_test_intent_already_bound');
  }
  prepare(raw:Buffer,observations:OwnerObservation[]){return this.transaction(()=>{
    const p=parseIntegrationRequest(raw),requestSha256=integrationRequestSha256(p);if(this.events(p.id).length){const old=this.original(p.id);if(old.record.requestSha256!==requestSha256)throw new Error('integration_request_id_changed');return {...this.stateOf(p.id),duplicate:true};}
    const s=this.current(p);this.authorityCheck(p,s,observations);
    for(const row of this.db.prepare("SELECT object FROM events WHERE kind='integration_prepared' AND json_extract(data,'$.value.operation')=?").all(p.operation) as Row[]){const state=this.stateOf(row.object.slice('integration:'.length));if(state.phase==='produced')throw new Error('integration_source_already_has_candidate');if(!['closed_unstarted','failed_ended'].includes(state.phase))throw new Error('integration_original_unresolved');}
    const subject=s.composition.subject;if(!subject.testedHead||!subject.testedTree||s.report.stages.length!==subject.members.length+1||s.report.stages.some((x:Row)=>!x.head||!x.tree||!x.mergeOutput&&x.index!==0))throw new Error('integration_complete_composition_tree_required');
    const source={operation:s.operation,item:s.item,packet:s.packet,fingerprint:s.fingerprint,context:s.context,composition:s.composition,report:s.report,manifestSha256:s.manifestSha256,reportSha256:s.reportSha256,contextSha256:s.contextSha256,originals:[...s.originals.keys()].sort()};for(const [sha,b] of s.originals){if(hash(b)!==sha)throw new Error('integration_original_changed');this.blob(b);}
    const old=this.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get('integration_authority_unique') as Row|undefined;if(old&&old.sql!==boundIndex)throw new Error('integration_guard_changed');if(!old)this.db.exec(boundIndex);
    if(p.authorityIntent)this.event(p.id,'authority_bound',{authorityIntent:p.authorityIntent,requestSha256,operation:p.operation});
    this.event(p.id,'prepared',{requestSha256:this.blob(Buffer.from(canonical(p))),originalRequestSha256:this.blob(raw),sourceSha256:this.blob(Buffer.from(canonical(source))),operation:p.operation,directory:join(this.directory,'integration-'+requestSha256),preparedAt:now()});return {...this.stateOf(p.id),duplicate:false};
  });}
  sourceMaterial(id:string){return this.transaction(()=>{const x=this.original(id);return {request:x.request,source:x.source,directory:x.record.directory,requestSha256:x.record.requestSha256,originals:x.source.originals.map((sha256:string)=>({sha256,bytes:this.bytes(sha256)}))};});}
  private checkOf(id:string,observations:OwnerObservation[]){const x=this.original(id);if(x.record.directory!==join(this.directory,'integration-'+x.record.requestSha256))throw new Error('integration_original_workspace_required');const s=this.current(x.request);if(s.packet!==x.source.packet||s.fingerprint!==x.source.fingerprint)throw new Error('integration_source_packet_changed');this.authorityCheck(x.request,s,observations);return {source:s,request:x.request};}
  check(id:string,observations:OwnerObservation[]){return this.transaction(()=>this.checkOf(id,observations));}
  start(id:string,observations:OwnerObservation[]){return this.transaction(()=>{this.checkOf(id,observations);const s=this.stateOf(id);if(s.phase!=='prepared_not_started')throw new Error('integration_original_started_or_closed');this.event(id,'started',{controllerPid:process.pid,startedAt:now()});return this.stateOf(id);});}
  effect<T>(id:string,observations:OwnerObservation[],f:()=>T):T{return this.transaction(()=>{if(this.stateOf(id).phase!=='started_or_unknown')throw new Error('integration_not_running');this.checkOf(id,observations);return f();});}
  complete(id:string,capture:IntegrationCapture){return this.transaction(()=>{
    const c=requireIntegrationCapture(capture),x=this.original(id),events=this.events(id),subject=x.source.composition.subject;
    if(!events.some(e=>e.kind==='integration_started')||events.some(e=>e.kind==='integration_closed_unstarted')||c.binding.requestSha256!==x.record.requestSha256||c.binding.operation!==x.request.operation||c.binding.subjectSha256!==x.request.subjectSha256||c.success&&(c.candidate.B!==subject.B||c.candidate.T!==subject.testedTree||c.candidate.target!==subject.targetRef||c.candidate.repository!==subject.repository))throw new Error('integration_capture_binding_changed');
    const value=c.success?{success:true,candidate:c.candidate,prefixes:c.prefixes,diffSha256:hash(c.diff),bundleSha256:hash(c.bundle),originals:[...new Set([...c.originals.keys(),hash(c.diff),hash(c.bundle)])].sort(),steps:c.steps,completedAt:c.completedAt,requiresOwnValidation:true,requiresOwnReception:true,onlyPrivateCandidateCreated:true,technicalAcceptanceGranted:false,targetUpdated:false}:{success:false,reason:c.reason,originals:[...c.originals.keys()].sort(),steps:c.steps,partialPrivateArtifactMayExist:true,technicalAcceptanceGranted:false,targetUpdated:false};
    const old=events.find(e=>e.kind==='integration_result');if(old){if(canonical(old.data)!==canonical(value))throw new Error('integration_result_changed');return {...this.stateOf(id),duplicate:true};}
    for(const [sha,b] of c.originals){if(hash(b)!==sha)throw new Error('integration_original_changed');this.blob(b);}if(c.success){this.blob(c.diff);this.blob(c.bundle);}this.event(id,'result',value);return {...this.stateOf(id),duplicate:false};
  });}
  artifacts(id:string){return this.transaction(()=>{const s=this.stateOf(id);if(s.phase!=='produced')throw new Error('integration_candidate_not_produced');return {state:s,bundle:this.bytes(s.result!.bundleSha256),diff:this.bytes(s.result!.diffSha256)};});}
  closeUnstarted(id:string){return this.transaction(()=>{const s=this.stateOf(id);if(s.phase!=='prepared_not_started'&&s.phase!=='closed_unstarted')throw new Error('integration_original_started_or_closed');if(s.phase!=='closed_unstarted')this.event(id,'closed_unstarted',{originalRequestPreserved:true,newGitProcesses:0});return this.stateOf(id);});}
  problem(id:string,reason:string){return this.transaction(()=>{this.original(id);this.event(id,'problem',{reason,observedAt:now(),automaticResend:false});});}
  private stateOf(id:string){const x=this.original(id),events=this.events(id),result=events.find(e=>e.kind==='integration_result')?.data;if(result)for(const sha of result.originals)this.bytes(sha);let current=false;try{const s=this.source(x.request.operation);current=s.current&&s.packet===x.source.packet&&s.fingerprint===x.source.fingerprint;}catch{}
    return {id,requestSha256:x.record.requestSha256,operation:x.request.operation,subjectSha256:x.request.subjectSha256,directory:x.record.directory,phase:result?(result.success?'produced':'failed_ended'):events.some(e=>e.kind==='integration_closed_unstarted')?'closed_unstarted':events.some(e=>e.kind==='integration_started')?'started_or_unknown':'prepared_not_started',currentSource:current,result:result??null,problems:events.filter(e=>e.kind==='integration_problem').map(e=>e.data),automaticResend:false,technicalAcceptanceGranted:false,targetUpdated:false,userOutcomeAccepted:false};}
  state(id:string){return this.transaction(()=>this.stateOf(id));}
}
