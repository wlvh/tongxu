import type {DatabaseSync} from 'node:sqlite';
import {installTestAuthorityGuard} from './test-authority.js';

const guards=[
  {name:'purpose_test_consumer_guard',sql:`CREATE TRIGGER purpose_test_consumer_guard BEFORE INSERT ON events
WHEN NEW.kind IN ('integration_authority_bound','delivery_validation_authority_bound') AND EXISTS(SELECT 1 FROM events r WHERE r.kind='authority_action_reserved' AND r.object='authority-intent:'||json_extract(NEW.data,'$.value.authorityIntent') AND json_extract(r.data,'$.request.action')='test' AND json_type(r.data,'$.request.payloadSha256') IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'test_authority_purpose_mismatch'); END`},
  {name:'recomposition_test_resource_guard',sql:`CREATE TRIGGER recomposition_test_resource_guard BEFORE INSERT ON events
WHEN NEW.kind='resource_claim_dispatched' AND EXISTS(SELECT 1 FROM events p JOIN events r ON r.kind='authority_action_reserved' AND r.object='authority-intent:'||json_extract(p.data,'$.authorityIntent') WHERE p.kind='resource_request_prepared' AND p.object=NEW.object AND json_extract(r.data,'$.request.action')='test' AND json_type(r.data,'$.request.payloadSha256') IS NOT NULL)
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events a JOIN events b ON b.kind='recomposition_test_prepared' AND json_extract(b.data,'$.value.operation')=json_extract(NEW.data,'$.originalOperation') WHERE a.kind='member_resource_claim_admitted' AND a.object=NEW.object AND a.id=(SELECT MAX(id) FROM events) AND json_extract(a.data,'$.operation')=json_extract(NEW.data,'$.originalOperation') AND json_extract(a.data,'$.requestSha256')=json_extract(NEW.data,'$.requestSha256') AND json_extract(a.data,'$.recompositionTestId')=substr(b.object,20) AND json_extract(a.data,'$.recompositionTestPlanSha256')=json_extract(b.data,'$.value.planSha256') AND EXISTS(SELECT 1 FROM json_each(b.data,'$.value.resourceRequests') WHERE value=json_extract(NEW.data,'$.requestSha256'))) THEN RAISE(ABORT,'recomposition_test_resource_binding_required') END; END`}
];

/** Install when the purpose-bound permission is reserved, before an older
 * already-open consumer can claim its resources or consume that permission. */
export function installRecompositionTestGuards(db:DatabaseSync){
  installTestAuthorityGuard(db);
  for(const g of guards){const old=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name) as {sql:string}|undefined;if(old&&old.sql!==g.sql)throw new Error('recomposition_test_guard_changed');if(!old)db.exec(g.sql);}
}
