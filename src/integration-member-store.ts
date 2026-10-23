import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {parseIntegrationMemberReturn,integrationMemberReturnSha256,type IntegrationMemberReturn} from './integration-member-contract.js';
type Row=Record<string,any>;
export type IntegrationMemberSource={proof:Row;originals:Map<string,Buffer>};

/** An evidence association in the original queue. Recording it is never a
 * repair reservation or an individual member's fabricated reception. */
export class IntegrationMemberRecords{
  constructor(private db:DatabaseSync,private transaction:<T>(fn:()=>T)=>T,private source:(p:IntegrationMemberReturn)=>IntegrationMemberSource,private recorded?:()=>void){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('integration_member_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private original(id:string){const row=this.db.prepare("SELECT data FROM events WHERE kind='integration_member_return_recorded' AND object=?").get('integration-member:'+id) as Row|undefined;if(!row)throw new Error('integration_member_return_not_recorded');const ref=JSON.parse(row.data),value=JSON.parse(this.bytes(ref.sha256).toString());if(canonical(value)!==canonical(ref.value))throw new Error('integration_member_index_changed');const request=parseIntegrationMemberReturn(this.bytes(value.requestSha256)),source=JSON.parse(this.bytes(value.sourceSha256).toString());if(request.id!==id||integrationMemberReturnSha256(request)!==value.requestSha256||canonical(parseIntegrationMemberReturn(this.bytes(value.originalRequestSha256)))!==canonical(request))throw new Error('integration_member_binding_changed');for(const sha of source.originals)this.bytes(sha);return {value,request,source};}
  record(raw:Buffer){return this.transaction(()=>{
    const p=parseIntegrationMemberReturn(raw),sha=integrationMemberReturnSha256(p),old=this.db.prepare("SELECT 1 FROM events WHERE kind='integration_member_return_recorded' AND object=?").get('integration-member:'+p.id);if(old){if(this.original(p.id).value.requestSha256!==sha)throw new Error('integration_member_request_changed');this.recorded?.();return {...this.stateOf(p.id),duplicate:true};}
    const source=this.source(p);this.recorded?.();for(const [sha,b] of source.originals){if(hash(b)!==sha)throw new Error('integration_member_original_changed');this.blob(b);}
    const value={requestSha256:this.blob(Buffer.from(canonical(p))),originalRequestSha256:this.blob(raw),sourceSha256:this.blob(Buffer.from(canonical({proof:source.proof,originals:[...source.originals.keys()].sort()}))),recordedAt:now()};this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('integration_member_return_recorded','integration-member:'+p.id,canonical({sha256:this.blob(Buffer.from(canonical(value))),value}),now());return {...this.stateOf(p.id),duplicate:false};
  });}
  private stateOf(id:string){const x=this.original(id);let current=false,reason:string|null=null;try{const source=this.source(x.request);current=hash(canonical({proof:source.proof,originals:[...source.originals.keys()].sort()}))===x.value.sourceSha256;if(!current)reason='integration_member_source_changed';}catch(e){reason=e instanceof Error?e.message:'integration_member_source_unavailable';}
    const repairs=(this.db.prepare("SELECT id,status,result FROM operations WHERE json_extract(result,'$.repair.memberReturn.sourceSha256')=?").all(x.value.sourceSha256) as Row[]).map(o=>{const r=JSON.parse(o.result).repair;return {operation:o.id,status:o.status,phase:r.phase,actualRepairPerformed:r.result?.actualRepairPerformed??null,afterH:r.result?.after.H??null};});
    return {id,phase:'recorded_evidence_only',requestSha256:x.value.requestSha256,sourceSha256:x.value.sourceSha256,recordedAt:x.value.recordedAt,receptionOperation:x.request.reception.operation,memberItem:x.request.member.item,memberHead:x.request.member.H,current,reason,repairStartedByThisRecord:false,repairs,writePermissionGranted:false,individualReceptionInferred:false,newModelInputs:0};}
  state(id:string){return this.transaction(()=>this.stateOf(id));}
  material(id:string){return this.transaction(()=>{const x=this.original(id);return {state:this.stateOf(id),request:x.request,proof:x.source.proof,originals:(x.source.originals as string[]).map(sha256=>({sha256,bytes:this.bytes(sha256)}))};});}
  private all(){return (this.db.prepare("SELECT object FROM events WHERE kind='integration_member_return_recorded' ORDER BY id").all() as Row[]).map(x=>this.original(x.object.slice('integration-member:'.length)));}
  hasPendingForItem(item:string){return this.transaction(()=>this.all().some(x=>x.request.member.item===item));}
  contextFor(members:Row[],context:Row,excludeReception?:string){return this.transaction(()=>{
    const values=new Map<string,Row>();for(const x of this.all()){const proof=x.source.proof,c=proof.member.manifest.candidate;if(x.request.reception.operation===excludeReception||canonical(proof.member.context.scope)!==canonical(context.scope)||canonical(proof.member.context.arrangement)!==canonical(context.arrangement)||!members.some(m=>['repository','pr','H','B','targetRef'].every(k=>m.candidate[k]===c[k])))continue;
      if(!values.has(x.value.sourceSha256))values.set(x.value.sourceSha256,{sourceSha256:x.value.sourceSha256,parent:proof.parent,selectedMember:proof.selectedMember,selectedFindings:proof.selectedFindings,memberCandidate:c,permissionGranted:false});}
    return [...values.values()];
  });}
}
