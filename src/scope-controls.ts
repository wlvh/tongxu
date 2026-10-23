import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {now} from './contract.js';
type Row=Record<string,any>;
export type LocalScopeControl={schemaVersion:1;kind:'tongxu-local-scope-control';id:string;item:string;scopeSha256:string;control:'implementation'|'investment'|'merge';state:'stopped'|'open';expectedRevision:number;source:string};
export function parseLocalScopeControl(raw:Buffer):LocalScopeControl{
  if(raw.length>8192)throw new Error('local_scope_control_size');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','id','item','scopeSha256','control','state','expectedRevision','source'])||p.schemaVersion!==1||p.kind!=='tongxu-local-scope-control'||!messageId(p.id)||!isAuthorityDigest(p.item)||!isAuthorityDigest(p.scopeSha256)||!['implementation','investment','merge'].includes(p.control)||!['stopped','open'].includes(p.state)||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||/[\x00-\x1f]/.test(p.source))throw new Error('local_scope_control_invalid');return p;
}
/** Local operator controls retain their original shadow semantics. A request
 * receipt is never an Owner adoption, permission grant or process-termination
 * proof; the existing SQL Owner-stop guard remains at the actual write. */
export class LocalScopeControls{
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private currentItem:(id:string)=>Row,private applyControl:(scope:string,kind:string,state:string,source:string)=>Row){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('local_scope_control_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  private original(id:string){const row=this.db.prepare("SELECT data FROM events WHERE kind='local_scope_control_applied' AND object=? ORDER BY id LIMIT 1").get('local-control:'+id) as Row;if(!row)return null;const record=JSON.parse(row.data),value=JSON.parse(this.bytes(record.sha256).toString());if(canonical(value)!==canonical(record.value))throw new Error('local_scope_control_index_changed');const p=parseLocalScopeControl(this.bytes(value.originalSha256));if(p.id!==id||hash(canonical(p))!==value.requestSha256||canonical(p)!==canonical(value.request))throw new Error('local_scope_control_original_changed');return value;}
  private result(value:Row,duplicate:boolean){let scopeStillMatches=false;try{const scope=this.currentItem(value.request.item).context.scope,adopted=this.db.prepare("SELECT data FROM events WHERE kind='authority_scope_adopted' AND object=? ORDER BY id DESC LIMIT 1").get('authority-scope:'+scope.id) as Row|undefined;scopeStillMatches=hash(canonical(scope))===value.request.scopeSha256&&(!adopted||JSON.parse(adopted.data).scopeVersion===scope.version);}catch{}const current=this.db.prepare('SELECT * FROM controls WHERE scope=? AND kind=?').get(value.result.scope,value.request.control) as Row|undefined;return {requestId:value.request.id,requestSha256:value.requestSha256,receipt:value.result,duplicate,currentControl:current?{scope:current.scope,kind:current.kind,state:current.stopped?'stopped':'open',revision:current.revision,sourceSha256:hash(current.source),effectiveAt:current.effective_at}:null,scopeSha256:value.request.scopeSha256,scopeStillMatches,receiptStillLatest:scopeStillMatches&&current?.revision===value.result.revision,ownerApproval:false,permissionsGranted:false,processTerminationProven:false,externalStateRechecked:false};}
  apply(raw:Buffer){return this.transaction(()=>{
    const p=parseLocalScopeControl(raw),requestSha256=hash(canonical(p)),old=this.original(p.id);if(old){if(old.requestSha256!==requestSha256||canonical(old.request)!==canonical(p))throw new Error('local_scope_control_request_id_changed');return this.result(old,true);}
    const item=this.currentItem(p.item),scope=item.context.scope;if(hash(canonical(scope))!==p.scopeSha256)throw new Error('local_scope_control_scope_changed');
    const adopted=this.db.prepare("SELECT data FROM events WHERE kind='authority_scope_adopted' AND object=? ORDER BY id DESC LIMIT 1").get('authority-scope:'+scope.id) as Row|undefined;if(adopted&&JSON.parse(adopted.data).scopeVersion!==scope.version)throw new Error('local_scope_control_adopted_version_changed');
    const previous=this.db.prepare('SELECT * FROM controls WHERE scope=? AND kind=?').get(scope.id,p.control) as Row|undefined;if((previous?.revision??0)!==p.expectedRevision)throw new Error('local_scope_control_revision_changed');
    const unchanged=previous&&!!previous.stopped===(p.state==='stopped');const result=unchanged?{scope:scope.id,kind:p.control,state:p.state,revision:previous.revision,requestedAt:previous.requested_at,effectiveAt:previous.effective_at,effect:'local_shadow_only',externalControl:'unverified',unchanged:true}:this.applyControl(scope.id,p.control,p.state,p.source);
    const value={request:p,requestSha256,originalSha256:this.blob(raw),result,recordedAt:now()},sha256=this.blob(Buffer.from(canonical(value)));this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('local_scope_control_applied','local-control:'+p.id,canonical({value,sha256}),now());return this.result(value,false);
  });}
  receipt(id:string){return this.transaction(()=>{const old=this.original(id);if(!old)throw new Error('local_scope_control_receipt_missing');return this.result(old,true);});}
}
