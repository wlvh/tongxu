import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {isAuthorityDigest} from './authority-contract.js';
import {parseDeliveryBatch,deliveryBatchSha,type DeliveryBatch} from './delivery-contract.js';

type Row=Record<string,any>;
type ScopeState={adoptionRecorded:boolean;currentAdoption:boolean;sourceOriginalsVerified:boolean;reason?:string;scopeBodySha256?:string;executionKind?:'github'|'fixture';decisionSource?:string;sourceFreshness:'not_rechecked'};
/** Fixed outcome material in the original event/blob store. Registration is
 * neither execution evidence nor an Owner acceptance or permission grant. */
export class DeliveryRecords{
  constructor(private db:DatabaseSync,private transaction:<T>(fn:()=>T)=>T,private currentItem:(id:string)=>Row,private inspectDecision:(sha:string)=>Row){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('delivery_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private events(id:string):Row[]{return this.db.prepare("SELECT * FROM events WHERE kind='delivery_batch_registered' AND object=? ORDER BY id").all('delivery:'+id) as Row[];}
  private original(sha:string){
    if(!isAuthorityDigest(sha))throw new Error('delivery_batch_digest_invalid');
    const rows=this.db.prepare("SELECT * FROM events WHERE kind='delivery_batch_registered' AND json_extract(data,'$.batchSha256')=? ORDER BY id").all(sha) as Row[];if(rows.length!==1)throw new Error('delivery_batch_original_missing');
    const row=rows[0]!,ref=JSON.parse(row.data),snapshot=JSON.parse(this.bytes(ref.snapshotSha256).toString()),manifest=parseDeliveryBatch(this.bytes(ref.manifestSha256)),original=parseDeliveryBatch(this.bytes(ref.originalSha256));
    if(deliveryBatchSha(manifest)!==sha||canonical(manifest)!==canonical(original)||row.object!=='delivery:'+manifest.id||ref.revision!==manifest.revision||ref.previous!==manifest.previous||snapshot.batchSha256!==sha||snapshot.members.length!==manifest.members.length||snapshot.members.some((m:Row,i:number)=>canonical({item:m.item,packet:m.packet,fingerprint:m.fingerprint})!==canonical(manifest.members[i])))throw new Error('delivery_batch_index_changed');
    return {manifest,snapshot,registeredAt:row.observed_at,ref};
  }
  private scope(batch:DeliveryBatch):ScopeState{
    const row=this.db.prepare("SELECT data FROM events WHERE kind='authority_scope_adopted' AND object=? ORDER BY id DESC LIMIT 1").get('authority-scope:'+batch.scope.id) as Row|undefined,latest=row&&JSON.parse(row.data);
    if(batch.scope.adoption===null)return {adoptionRecorded:false,currentAdoption:false,sourceOriginalsVerified:false,reason:'delivery_scope_adoption_missing',sourceFreshness:'not_rechecked'};
    if(!latest||latest.proposalSha256!==batch.scope.adoption||latest.scopeVersion!==batch.scope.version)throw new Error('delivery_current_scope_adoption_required');
    const decision=this.inspectDecision(batch.scope.adoption),p=decision.proposal;
    if(p.kind!=='adopt_scope'||p.scopeId!==batch.scope.id||p.scopeVersion!==batch.scope.version||hash(canonical(p.body))!==latest.scopeBodySha256||batch.goals.some(g=>!p.body.goals.includes(g))||p.body.nonGoals.some((g:string)=>!batch.nonGoals.includes(g)))throw new Error('delivery_adopted_goals_mismatch');
    const revoked=this.db.prepare("SELECT 1 FROM events WHERE kind='authority_revoked' AND json_extract(data,'$.decision')=? LIMIT 1").get(batch.scope.adoption);if(revoked)throw new Error('delivery_scope_adoption_revoked');
    return {adoptionRecorded:true,currentAdoption:true,sourceOriginalsVerified:true,scopeBodySha256:latest.scopeBodySha256,executionKind:decision.executionKind,decisionSource:decision.source.sourceUrl,sourceFreshness:'not_rechecked'};
  }
  register(raw:Buffer){return this.transaction(()=>{
    const p=parseDeliveryBatch(raw),sha=deliveryBatchSha(p),history=this.events(p.id),old=history.find(e=>JSON.parse(e.data).batchSha256===sha);if(old)return {...this.stateOf(sha),duplicate:true};
    const repository=(this.db.prepare("SELECT value FROM meta WHERE key='repository'").get() as Row|undefined)?.value;if(repository!==p.repository.toLowerCase())throw new Error('delivery_repository_mismatch');
    const latest=history.at(-1);if((latest?JSON.parse(latest.data).batchSha256:null)!==p.previous||p.revision!==history.length+1)throw new Error('delivery_previous_version_changed');
    if(p.previous){const prior=this.original(p.previous).manifest;if(prior.issue!==p.issue||prior.repository!==p.repository)throw new Error('delivery_identity_changed');if(p.scope.adoption===null&&(canonical(prior.scope)!==canonical(p.scope)||canonical(prior.goals)!==canonical(p.goals)||canonical(prior.nonGoals)!==canonical(p.nonGoals)))throw new Error('delivery_scope_change_requires_adoption');}
    const scope=this.scope(p),members=p.members.map(m=>{const c=this.currentItem(m.item);if(!c.current||c.packet!==m.packet||c.fingerprint!==m.fingerprint||c.candidate.repository.toLowerCase()!==p.repository.toLowerCase()||c.context.scope.id!==p.scope.id||c.context.scope.version!==p.scope.version)throw new Error('delivery_member_current_material_mismatch');return {item:m.item,packet:m.packet,fingerprint:m.fingerprint,candidate:c.candidate,contextSha256:hash(canonical(c.context)),subjectSha256:c.subjectSha256??null};});
    for(const r of p.related){const other=this.original(r.batch).manifest;if(other.repository!==p.repository||other.id===p.id)throw new Error('delivery_relation_outside_batch');}
    const snapshot={batchSha256:sha,members,scope},data={batchSha256:sha,revision:p.revision,previous:p.previous,manifestSha256:this.blob(Buffer.from(canonical(p))),originalSha256:this.blob(raw),snapshotSha256:this.blob(Buffer.from(canonical(snapshot)))};
    this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('delivery_batch_registered','delivery:'+p.id,canonical(data),now());return {...this.stateOf(sha),duplicate:false};
  });}
  private stateOf(sha:string){
    const {manifest:p,snapshot,registeredAt}=this.original(sha),latest=this.events(p.id).at(-1)!,currentVersion=JSON.parse(latest.data).batchSha256===sha;
    const members=snapshot.members.map((m:Row)=>{let current=false,reason:string|null=null;try{const c=this.currentItem(m.item);current=c.current&&c.packet===m.packet&&c.fingerprint===m.fingerprint&&hash(canonical(c.context))===m.contextSha256;if(!current)reason='delivery_member_changed';}catch{reason='delivery_member_unavailable';}return {...m,current,reason};});
    let scope:ScopeState;try{scope=this.scope(p);}catch(e){scope={...snapshot.scope,currentAdoption:false,sourceOriginalsVerified:false,reason:e instanceof Error?e.message:'delivery_scope_unavailable',sourceFreshness:'not_rechecked'};}
    return {batchSha256:sha,id:p.id,revision:p.revision,previous:p.previous,title:p.title,repository:p.repository,issue:p.issue,target:p.target,scope:{...p.scope,...scope},goals:p.goals,nonGoals:p.nonGoals,scenarios:p.scenarios,related:p.related,registeredAt,currentVersion,members,currentMaterials:members.every((m:Row)=>m.current),scenarioExecutionVerified:false,userOutcomeAccepted:false,productionActionAllowed:false,externalStateRechecked:false};
  }
  state(sha:string){return this.transaction(()=>this.stateOf(sha));}
  manifest(sha:string){return this.transaction(()=>this.original(sha).manifest);}
}
