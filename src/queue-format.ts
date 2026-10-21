import type {DatabaseSync} from 'node:sqlite';

type Row=Record<string,any>;
const key='delivery_assessment_format';
const contract='complete-assessment-evidence-v1';
export const assessmentGuards=[
  {name:'delivery_assessment_run_unique',sql:`CREATE UNIQUE INDEX delivery_assessment_run_unique ON events(json_extract(data,'$.value.run')) WHERE kind='delivery_assessment_prepared'`},
  {name:'delivery_assessment_message_guard',sql:`CREATE TRIGGER delivery_assessment_message_guard BEFORE INSERT ON events
WHEN NEW.kind IN ('message_runtime_started','message_send_registered') AND EXISTS(SELECT 1 FROM events a WHERE a.kind='delivery_assessment_prepared' AND 'messages:'||json_extract(a.data,'$.value.run')=NEW.object)
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events a WHERE a.kind='delivery_assessment_admitted' AND a.object=NEW.object AND a.id=(SELECT MAX(id) FROM events) AND json_extract(a.data,'$.value.effect')=NEW.kind) THEN RAISE(ABORT,'delivery_assessment_dispatch_check_required') END; END`}
];

export function queueFormatVersion(db:DatabaseSync):number{return (db.prepare('PRAGMA user_version').get() as Row).user_version;}
function feature(version:unknown):version is number{return Number.isInteger(version)&&Number(version)>=3&&Number(version)<=16;}
function guards(db:DatabaseSync,install=false){for(const g of assessmentGuards){const old=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name) as Row|undefined;if(!old){if(!install)throw new Error('delivery_assessment_guard_missing');db.exec(g.sql);}else if(old.sql!==g.sql)throw new Error('delivery_assessment_guard_changed');}}

/** Format 17 adds assessment evidence, without claiming that earlier optional
 * receiver/authority/resource features have been enabled. Preserve their exact
 * version and let their existing guard checks and opt-ins continue to apply. */
export function queueFeatureVersion(db:DatabaseSync):number{
  const version=queueFormatVersion(db),hasMeta=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='meta'").get(),saved=hasMeta?(db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row|undefined)?.value:undefined;
  if(version!==17){if(saved!==undefined)throw new Error('delivery_assessment_format_downgraded');return version;}
  let value:Row;try{value=JSON.parse(saved);}catch{throw new Error('delivery_assessment_format_missing');}
  if(!value||value.contract!==contract||!feature(value.featureVersion)||Object.keys(value).sort().join(',')!=='contract,featureVersion')throw new Error('delivery_assessment_format_changed');
  guards(db);return value.featureVersion;
}
export function requireAssessmentFormat(db:DatabaseSync){if(queueFormatVersion(db)!==17)throw new Error('delivery_assessment_prepare_format_upgrade_required');queueFeatureVersion(db);}
export function enableAssessmentFormat(db:DatabaseSync){
  const version=queueFeatureVersion(db);if(queueFormatVersion(db)===17)return false;if(!feature(version))throw new Error('unsupported_queue_schema_or_mode');
  guards(db,true);db.prepare('INSERT INTO meta VALUES(?,?)').run(key,JSON.stringify({contract,featureVersion:version}));db.exec('PRAGMA user_version=17');return true;
}
/** Called inside the original feature's transaction, after its own guards. */
export function setQueueFeatureVersion(db:DatabaseSync,version:number){
  const old=queueFeatureVersion(db);if(!feature(version)||version<old)throw new Error('queue_feature_version_cannot_regress');
  if(queueFormatVersion(db)===17)db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify({contract,featureVersion:version}),key);
  else db.exec('PRAGMA user_version='+version);
}
