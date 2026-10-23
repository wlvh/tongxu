import type {DatabaseSync} from 'node:sqlite';
export const memberRefutationKey='member_refutation_format';
export const memberRefutationContract='unchanged-member-fresh-parent-reception-v1';
const guards=[
  {name:'member_refutation_receiver_guard',sql:`CREATE TRIGGER member_refutation_receiver_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND EXISTS(SELECT 1 FROM packets WHERE id=NEW.packet AND json_type(summary,'$.memberRefutation')='object' AND json_extract(summary,'$.memberRefutation.sha256') IS NOT json_extract(NEW.result,'$.receiver.memberRefutationSha256'))
BEGIN SELECT RAISE(ABORT,'member_refutation_complete_input_required'); END`},
  {name:'member_refutation_lineage_guard',sql:`CREATE TRIGGER member_refutation_lineage_guard BEFORE INSERT ON packets
WHEN EXISTS(SELECT 1 FROM items JOIN packets ON packets.id=items.current_packet WHERE items.id=NEW.item AND json_type(packets.summary,'$.memberRefutation')='object' AND json_extract(packets.summary,'$.memberRefutation.sha256') IS NOT json_extract(NEW.summary,'$.memberRefutation.sha256'))
BEGIN SELECT RAISE(ABORT,'member_refutation_lineage_required'); END`}
];
export function memberRefutationGuards(db:DatabaseSync,install=false){for(const g of guards){const old=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name);if(!old){if(!install)throw new Error('member_refutation_guard_missing');db.exec(g.sql);}else if(old.sql!==g.sql)throw new Error('member_refutation_guard_changed');}}

const originalsGuard=`CREATE TRIGGER member_refutation_originals_guard BEFORE UPDATE ON operations
WHEN NEW.status IN ('receiving','merging') AND (OLD.status!=NEW.status OR (NEW.status='receiving' AND json_extract(OLD.result,'$.receiver.phase')='reserved' AND json_extract(NEW.result,'$.receiver.phase')='dispatch_registered') OR (NEW.status='merging' AND json_array_length(NEW.result,'$.merge.attempts')>json_array_length(OLD.result,'$.merge.attempts'))) AND EXISTS(SELECT 1 FROM packets WHERE id=NEW.packet AND json_type(summary,'$.memberRefutation')='object')
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events a JOIN packets p ON p.id=NEW.packet JOIN blobs b ON b.hash=json_extract(p.summary,'$.memberRefutation.sha256') WHERE a.id=(SELECT MAX(id) FROM events) AND a.kind='integration_consumer_admitted' AND a.object=NEW.id AND json_extract(a.data,'$.packet')=NEW.packet AND json_extract(a.data,'$.status')=NEW.status AND json_extract(a.data,'$.memberRefutationSha256')=b.hash AND json_extract(a.data,'$.memberRefutationTerminalSha256')=json_extract(CAST(b.bytes AS TEXT),'$.repair.terminalRecordSha256')) THEN RAISE(ABORT,'member_refutation_originals_admission_required') END; END`;
/** Additive guard: old completed captures stay readable. Even a preopened
 * reader from the failed candidate cannot perform a new unchecked dispatch. */
export function installMemberRefutationOriginalsGuard(db:DatabaseSync){const old=db.prepare("SELECT sql FROM sqlite_schema WHERE name='member_refutation_originals_guard'").get();if(!old)db.exec(originalsGuard);else if(old.sql!==originalsGuard)throw new Error('member_refutation_originals_guard_changed');}
