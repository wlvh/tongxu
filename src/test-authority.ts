import type {DatabaseSync} from 'node:sqlite';
import {hash} from './snapshot.js';
type Row=Record<string,any>;
const sql=`CREATE UNIQUE INDEX isolated_test_authority_unique ON events(json_extract(data,'$.value.authorityIntent')) WHERE kind IN ('integration_authority_bound','delivery_validation_authority_bound')`;
/** One reserved test action belongs to one original consumer. The index also
 * rejects an already-open older consumer at its event insertion boundary. */
export function installTestAuthorityGuard(db:DatabaseSync){const old=db.prepare("SELECT sql FROM sqlite_schema WHERE name='isolated_test_authority_unique'").get() as Row|undefined;if(old&&old.sql!==sql)throw new Error('test_authority_guard_changed');if(!old)db.exec(sql);}
export function requireTestAuthorityConsumer(db:DatabaseSync,intent:string,object:string){
  if(db.prepare("SELECT 1 FROM events WHERE kind IN ('integration_authority_bound','delivery_validation_authority_bound') AND json_extract(data,'$.value.authorityIntent')=? AND object!=?").get(intent,object))throw new Error('test_authority_intent_already_bound');
  // Pre-binding delivery records still consumed the original reservation.
  for(const row of db.prepare("SELECT object,data FROM events WHERE kind='delivery_validation_registered' AND object!=?").all(object) as Row[]){const ref=JSON.parse(row.data).value.originalSha256,b=(db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(ref) as Row|undefined)?.bytes;if(!b||hash(Buffer.from(b))!==ref)throw new Error('test_authority_original_changed');if(JSON.parse(Buffer.from(b).toString()).authorityIntent===intent)throw new Error('test_authority_intent_already_bound');}
}
