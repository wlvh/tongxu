import type {DatabaseSync} from 'node:sqlite';

type Row=Record<string,any>;
export const integrationFormatKey='minimal_integration_format';
export const integrationFormatContract='fixed-candidate-original-provenance-v1';
const known=`EXISTS(SELECT 1 FROM events e JOIN items i ON i.id=NEW.item WHERE e.kind='integration_result' AND json_extract(e.data,'$.value.success')=1 AND json_extract(e.data,'$.value.candidate.H')=json_extract(i.candidate,'$.H') AND json_extract(e.data,'$.value.candidate.B')=json_extract(i.candidate,'$.B') AND lower(json_extract(e.data,'$.value.candidate.repository'))=lower(json_extract(i.candidate,'$.repository')) AND json_extract(e.data,'$.value.candidate.target')=json_extract(i.candidate,'$.targetRef'))`;
export const integrationGuards=[
  {name:'integration_candidate_lineage_guard',sql:`CREATE TRIGGER integration_candidate_lineage_guard BEFORE INSERT ON packets
WHEN EXISTS(SELECT 1 FROM packets p WHERE p.item=NEW.item AND json_type(p.summary,'$.integration')='object') AND json_type(NEW.summary,'$.integration') IS NOT 'object'
BEGIN SELECT RAISE(ABORT,'integration_candidate_lineage_required'); END`},
  {name:'integration_consumer_guard',sql:`CREATE TRIGGER integration_consumer_guard BEFORE UPDATE ON operations
WHEN ${known} AND (NEW.status='repairing' OR (NEW.status IN ('receiving','merging') AND (OLD.status!=NEW.status OR (NEW.status='receiving' AND json_extract(OLD.result,'$.receiver.phase')='reserved' AND json_extract(NEW.result,'$.receiver.phase')='dispatch_registered') OR (NEW.status='merging' AND json_array_length(NEW.result,'$.merge.attempts')>json_array_length(OLD.result,'$.merge.attempts')))))
BEGIN SELECT CASE WHEN NEW.status='repairing' THEN RAISE(ABORT,'integration_requires_member_scoped_repair') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events a JOIN packets p ON p.id=NEW.packet WHERE a.id=(SELECT MAX(id) FROM events) AND a.kind='integration_consumer_admitted' AND a.object=NEW.id AND json_extract(a.data,'$.packet')=NEW.packet AND json_extract(a.data,'$.status')=NEW.status AND json_extract(a.data,'$.integrationSha256')=json_extract(p.summary,'$.integration.sha256') AND json_extract(NEW.result,'$.receiver.integrationSha256')=json_extract(p.summary,'$.integration.sha256')) THEN RAISE(ABORT,'integration_current_consumer_check_required') END; END`}
];
export function integrationFormatGuards(db:DatabaseSync,install=false){for(const g of integrationGuards){const old=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name) as Row|undefined;if(!old){if(!install)throw new Error('integration_guard_missing');db.exec(g.sql);}else if(old.sql!==g.sql)throw new Error('integration_guard_changed');}}
