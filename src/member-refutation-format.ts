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
