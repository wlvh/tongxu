import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {now} from './contract.js';
import {requirePublicationDispatchCapture,type PublicationDispatchCapture} from './publication-dispatch-capture.js';
import type {PublicationReturnReference} from './publication-return-contract.js';
import {publicationReturnReference} from './publication-return-contract.js';
type Row=Record<string,any>;

/** A formal RETURN is original evidence, not a model sender, a permission or
 * a new owner. These records use the original queue and immutable blobs. */
export class PublicationReturns{
  constructor(private db:DatabaseSync,private transaction:<T>(f:()=>T)=>T,private source:(operation:string,current:boolean)=>Row,private originals:(operation:string)=>Row[],private association:(task:string,link:string)=>Row|null){}
  private bytes(sha:string){const r=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=r&&Buffer.from(r.bytes);if(!b||hash(b)!==sha)throw new Error('publication_return_original_changed');return b;}
  private blob(b:Buffer){const sha=hash(b);this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(sha,b);this.bytes(sha);return sha;}
  record(operation:string,values:PublicationDispatchCapture[]){return this.transaction(()=>{
    const source=this.source(operation,true),original=this.originals(operation),captures=values.map(requirePublicationDispatchCapture);
    if(original.length!==2||captures.length!==2||new Set(captures.map(c=>c.directory)).size!==2)throw new Error('publication_return_complete_capture_required');
    const stages=original.map(o=>{const c=captures.find(c=>c.directory===o.prepared.directory);
      if(!c||c.phase!=='ended_possible'||c.preparedSha256!==hash(canonical(o.prepared))||c.observedPid!==o.registered?.pid||canonical(c.processIdentity??null)!==canonical(o.registered?.identity??null))throw new Error('publication_return_capture_changed');
      return {stage:o.prepared.stage,directory:c.directory,captureSha256:c.digest,originals:Object.fromEntries([...c.originals].map(([name,bytes])=>[name,{sha256:this.blob(bytes),bytes:bytes.length}]))};});
    const proof={schemaVersion:1,kind:'tongxu-publication-return-receipt',...source,stages,permissionGranted:false,businessAcceptance:false},receiptSha256=this.blob(Buffer.from(canonical(proof))),old=this.db.prepare("SELECT data FROM events WHERE kind='publication_return_receipt' AND object=?").get(operation) as Row|undefined;
    if(old){if(JSON.parse(old.data).receiptSha256!==receiptSha256)throw new Error('publication_return_original_receipt_changed');return {receiptSha256,duplicate:true};}
    this.db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('publication_return_receipt',operation,canonical({receiptSha256}),now());return {receiptSha256,duplicate:false};
  });}
  material(task:string,reference:PublicationReturnReference,current=true){return this.transaction(()=>{
    if(!publicationReturnReference(reference))throw new Error('publication_return_reference_invalid');
    const row=this.db.prepare("SELECT data FROM events WHERE kind='publication_return_receipt' AND object=?").get(reference.operation) as Row|undefined;
    if(!row||JSON.parse(row.data).receiptSha256!==reference.receiptSha256)throw new Error('publication_return_original_receipt_required');
    const proof=JSON.parse(this.bytes(reference.receiptSha256).toString()),source=this.source(reference.operation,current),{schemaVersion,kind,stages,permissionGranted,businessAcceptance,...original}=proof;
    if(schemaVersion!==1||kind!=='tongxu-publication-return-receipt'||canonical(source)!==canonical(original))throw new Error('publication_return_source_changed');
    for(const stage of stages)for(const ref of Object.values(stage.originals) as Row[])this.bytes(ref.sha256);
    const link=this.association(task,reference.taskLink)?.association;
    if(!link?.current||link.candidateItem!==source.item||link.candidatePacket!==source.packet||['H','B','pr'].some(k=>link[k]!==source.candidate[k])||link.repository!==source.candidate.repository||link.target!==source.candidate.targetRef)throw new Error('publication_return_exact_task_candidate_required');
    return {reference,receipt:proof,taskLink:link.link,sourceKind:'formal_publication_return',notModelSender:true,permissionGranted:false};
  });}
}
