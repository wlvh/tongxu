import type {DatabaseSync} from 'node:sqlite';

const receiverGuard=`CREATE TRIGGER conditional_entry_receiver_guard BEFORE UPDATE ON operations
WHEN NEW.status='receiving' AND (OLD.status!=NEW.status OR (json_extract(OLD.result,'$.receiver.phase')='reserved' AND json_extract(NEW.result,'$.receiver.phase')='dispatch_registered'))
BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM events p WHERE p.kind='coordination_normal_entry_step' AND json_extract(p.data,'$.value.reference.kind')='packet' AND json_extract(p.data,'$.value.reference.item')=NEW.item AND NOT EXISTS(
 SELECT 1 FROM events a,json_each(a.data,'$.normalEntryReceivers') b WHERE a.id=(SELECT MAX(id) FROM events) AND a.kind='integration_consumer_admitted' AND a.object=NEW.id AND json_extract(b.value,'$.entryId')=json_extract(p.data,'$.value.entryId') AND json_extract(b.value,'$.item')=NEW.item AND json_extract(b.value,'$.operation')=NEW.id AND json_extract(b.value,'$.requestSha256')=json_extract(NEW.result,'$.receiver.planSha256')
)) THEN RAISE(ABORT,'conditional_entry_original_receiver_required') END; END`;
/** Older open consumers cannot omit the normal entry's original receiver
 * association at the existing reservation and dispatch transaction. */
export function installConditionalEntryGuards(db:DatabaseSync){const old=db.prepare("SELECT sql FROM sqlite_schema WHERE name='conditional_entry_receiver_guard'").get() as {sql:string}|undefined;if(old&&old.sql!==receiverGuard)throw new Error('conditional_entry_guard_changed');if(!old)db.exec(receiverGuard);}
