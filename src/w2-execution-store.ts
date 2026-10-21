import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {now} from './contract.js';

const guards=[
  {name:'w2_execution_registration_guard',sql:`CREATE TRIGGER w2_execution_registration_guard BEFORE INSERT ON events WHEN NEW.kind IN ('recomposition_test_verifier_registered','delivery_validation_started') AND json_extract(NEW.data,'$.value.executionRegistryVersion') IS NOT 1 BEGIN SELECT RAISE(ABORT,'w2_execution_registry_required'); END`},
  {name:'w2_execution_result_guard',sql:`CREATE TRIGGER w2_execution_result_guard BEFORE INSERT ON events WHEN NEW.kind IN ('recomposition_test_result','delivery_validation_result')
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events a WHERE a.id=(SELECT MAX(id) FROM events) AND a.kind='w2_execution_capture_admitted' AND a.object=NEW.object AND json_extract(a.data,'$.reportSha256')=json_extract(NEW.data,'$.value.reportSha256') AND json_extract(a.data,'$.executionRegistrySha256') IS json_extract(NEW.data,'$.value.executionRegistrySha256')) THEN RAISE(ABORT,'w2_execution_registry_capture_required') END; END`}
];
/** An already-open older consumer cannot omit the new execution identities
 * or record a result without the current capture consumer's admission. */
export function installW2ExecutionGuards(db:DatabaseSync){for(const g of guards){const old=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name) as {sql:string}|undefined;if(old&&old.sql!==g.sql)throw new Error('w2_execution_guard_changed');if(!old)db.exec(g.sql);}}
export function admitW2Capture(db:DatabaseSync,object:string,reportSha256:string,executionRegistrySha256:string|null){installW2ExecutionGuards(db);db.prepare('INSERT INTO events(kind,object,data,observed_at) VALUES(?,?,?,?)').run('w2_execution_capture_admitted',object,canonical({reportSha256,executionRegistrySha256}),now());}
