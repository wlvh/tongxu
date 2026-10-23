import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {parseRecompositionLink,type RecompositionLink} from './member-recomposition-contract.js';
import {enableMemberRecompositionFormat} from './queue-format.js';
type Row=Record<string,any>;
export class MemberRecompositionRecords{
  constructor(private db:DatabaseSync,private transaction:<T>(fn:()=>T)=>T,private source:(p:RecompositionLink)=>{proof:Row;originals:Map<string,Buffer>}){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row|undefined,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('member_recomposition_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private original(id:string){const row=this.db.prepare("SELECT data FROM events WHERE kind='member_recomposition_linked' AND object=?").get('member-recomposition:'+id) as Row|undefined;if(!row)throw new Error('member_recomposition_not_recorded');const ref=JSON.parse(row.data),value=JSON.parse(this.bytes(ref.sha256).toString());if(canonical(ref.value)!==canonical(value))throw new Error('member_recomposition_index_changed');const request=parseRecompositionLink(this.bytes(value.requestSha256)),proof=JSON.parse(this.bytes(value.proofSha256).toString());if(request.id!==id||request.composition.subjectSha256!==value.subjectSha256||hash(canonical(request))!==value.requestSha256)throw new Error('member_recomposition_binding_changed');for(const sha of value.originals)this.bytes(sha);return {request,value,proof};}
  record(raw:Buffer){return this.transaction(()=>{const p=parseRecompositionLink(raw),sha=hash(canonical(p)),old=this.db.prepare("SELECT 1 FROM events WHERE kind='member_recomposition_linked' AND object=?").get('member-recomposition:'+p.id);if(old){const x=this.original(p.id);if(x.value.requestSha256!==sha)throw new Error('member_recomposition_request_changed');return {...x.value,duplicate:true};}
    const s=this.source(p);enableMemberRecompositionFormat(this.db);for(const [sha,b] of s.originals){if(hash(b)!==sha)throw new Error('member_recomposition_original_changed');this.blob(b);}const value={requestSha256:this.blob(Buffer.from(canonical(p))),originalRequestSha256:this.blob(raw),proofSha256:this.blob(Buffer.from(canonical(s.proof))),subjectSha256:p.composition.subjectSha256,originals:[...s.originals.keys()].sort(),recordedAt:now(),priorAcceptanceTransferred:false,permissionGranted:false};this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('member_recomposition_linked','member-recomposition:'+p.id,canonical({sha256:this.blob(Buffer.from(canonical(value))),value}),now());return {...value,duplicate:false};
  });}
  state(id:string){return this.transaction(()=>this.original(id));}
  forSubject(sha:string){return this.transaction(()=>{const rows=this.db.prepare("SELECT object FROM events WHERE kind='member_recomposition_linked' AND json_extract(data,'$.value.subjectSha256')=? ORDER BY id").all(sha) as Row[];return rows.map(row=>{const x=this.original(row.object.slice('member-recomposition:'.length));return {proofSha256:x.value.proofSha256,...x.proof};});});}
}
