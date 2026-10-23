import type { DatabaseSync } from 'node:sqlite';
import { hash } from './snapshot.js';
import { eventKey,parseEventProfile } from './event-contract.js';
import { eventMaterialHash,materialProjection } from './event-source.js';
import type { Candidate } from './contract.js';

type Row=Record<string,any>;
export const eventStateKey=(repository:string,pr:number)=>'event-source:'+eventKey(repository,pr);
const legacyMembersSql=`SELECT CASE WHEN json_type(p.summary,'$.composition')='object' THEN json_extract(member.value,'$.candidate') ELSE i.candidate END AS candidate FROM items i JOIN packets p ON p.id=NEW.packet JOIN json_each(CASE WHEN json_type(p.summary,'$.composition')='object' THEN json_extract(p.summary,'$.composition.subject.members') ELSE '[{}]' END) member WHERE i.id=NEW.item`;
const membersSql=legacyMembersSql.replace('END AS candidate FROM','END AS candidate,i.latest_source_observation AS latest_source_observation FROM')+` AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(p.summary,'$.composition.subject.members')) newer WHERE newer.key>member.key AND json_extract(newer.value,'$.candidate.pr')=json_extract(member.value,'$.candidate.pr'))`;
const legacyFreshnessSql=`julianday(json_extract(m.value,'$.lastGoodAt'))<julianday(json_extract(c.candidate,'$.observedAt'))`;
const freshnessSql=`COALESCE(julianday(json_extract(m.value,'$.lastGoodAt')),0)<max(COALESCE(julianday(json_extract(c.candidate,'$.observedAt')),0),COALESCE(julianday(c.latest_source_observation),0))`;
const monitoredSql=`EXISTS(SELECT 1 FROM (${membersSql}) c JOIN meta m ON m.key='event-source:'||lower(json_extract(c.candidate,'$.repository'))||'#'||json_extract(c.candidate,'$.pr'))`;
const invalidSql=`EXISTS(SELECT 1 FROM (${membersSql}) c JOIN meta m ON m.key='event-source:'||lower(json_extract(c.candidate,'$.repository'))||'#'||json_extract(c.candidate,'$.pr') WHERE json_extract(m.value,'$.complete') IS NOT 1 OR json_extract(m.value,'$.candidate.H') IS NOT json_extract(c.candidate,'$.H') OR json_extract(m.value,'$.candidate.B') IS NOT json_extract(c.candidate,'$.B') OR json_extract(m.value,'$.candidate.targetRef') IS NOT json_extract(c.candidate,'$.targetRef') OR json_extract(m.value,'$.candidate.state') IS NOT 'open' OR COALESCE(julianday(json_extract(m.value,'$.validUntilAt')),0)<julianday('now') OR ${freshnessSql} OR json_extract(m.value,'$.bindings."'||NEW.item||'"') IS NOT NEW.packet)`;
export const eventGuards=[
  {name:'event_new_operation_guard',sql:`CREATE TRIGGER event_new_operation_guard BEFORE INSERT ON operations WHEN NEW.status='running' AND ${invalidSql} BEGIN SELECT RAISE(ABORT,'current_event_source_and_material_required'); END`},
  {name:'event_new_stage_guard',sql:`CREATE TRIGGER event_new_stage_guard BEFORE UPDATE ON operations WHEN ((NEW.status IN ('receiving','repairing','merging') AND OLD.status!=NEW.status) OR NEW.status='receiving' AND json_extract(NEW.result,'$.receiver.phase')='dispatch_registered' AND json_extract(OLD.result,'$.receiver.phase') IS NOT 'dispatch_registered' OR NEW.status='merging' AND json_array_length(json_extract(NEW.result,'$.merge.attempts'))>COALESCE(json_array_length(json_extract(OLD.result,'$.merge.attempts')),0)) AND ${invalidSql} BEGIN SELECT RAISE(ABORT,'current_event_source_and_material_required'); END`},
  {name:'event_receiver_input_guard',sql:`CREATE TRIGGER event_receiver_input_guard BEFORE UPDATE ON operations WHEN NEW.status='receiving' AND ${monitoredSql} AND json_extract(NEW.result,'$.receiver.eventSourcePacket') IS NOT NEW.packet BEGIN SELECT RAISE(ABORT,'receiver_event_source_binding_required'); END`},
  {name:'event_material_lineage_guard',sql:`CREATE TRIGGER event_material_lineage_guard BEFORE INSERT ON packets WHEN json_type(NEW.summary,'$.eventSources') IS NOT 'array' AND EXISTS(SELECT 1 FROM items JOIN packets ON packets.id=items.current_packet WHERE items.id=NEW.item AND json_type(packets.summary,'$.eventSources')='array') BEGIN SELECT RAISE(ABORT,'event_material_lineage_required'); END`},
];
export const legacyEventGuards=eventGuards.map(g=>({...g,sql:g.sql.replaceAll(membersSql,legacyMembersSql).replaceAll(freshnessSql,legacyFreshnessSql)}));
export function eventGuardsPresent(db:DatabaseSync){return eventGuards.every(g=>(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(g.name) as Row)?.sql===g.sql);}
export function effectiveEventCandidate(c:Candidate,watermark:string|null):Candidate{return {...c,observedAt:watermark&&(!c.observedAt||watermark>c.observedAt)?watermark:c.observedAt};}
function bytes(db:DatabaseSync,sha:string){const row=db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('event_original_missing_or_changed');return b;}
export function currentEventSource(db:DatabaseSync,c:Candidate,item?:string,packet?:number):Row{
  const profileRef=(db.prepare("SELECT value FROM meta WHERE key='bounded_event_source_profile'").get() as Row)?.value;
  if(!profileRef)return {registered:false,current:true,materialBound:true};
  try{
    const p=parseEventProfile(bytes(db,profileRef));if(p.repository.toLowerCase()!==c.repository.toLowerCase()||!p.prs.includes(c.pr))return {registered:false,current:true,materialBound:true};
    if(!eventGuardsPresent(db))throw new Error('event_storage_guards_missing');
    const row=db.prepare('SELECT value FROM meta WHERE key=?').get(eventStateKey(c.repository,c.pr)) as Row,s=row&&JSON.parse(row.value);if(!s)throw new Error('event_subject_state_missing');
    const index=s.projectionSha256?JSON.parse(bytes(db,s.projectionSha256).toString()):null;
    if(index)for(const r of index.records)if(bytes(db,r.sha256).length!==r.bytes)throw new Error('event_capture_length_changed');
    const observed=s.candidate,current=s.complete===true&&index?.result.complete===true&&observed&&observed.H===c.H&&observed.B===c.B&&observed.targetRef===c.targetRef&&observed.state==='open'&&Date.parse(s.validUntilAt)>=Date.now()&&(!c.observedAt||Date.parse(index.observedAt)>=Date.parse(c.observedAt));
    return {registered:true,current:Boolean(current),materialBound:Boolean(current&&item&&packet&&s.bindings?.[item]===packet),state:s,index,profile:p,reason:!s.complete?'source_unavailable_or_not_observed':!current?'source_candidate_changed_or_expired':item&&packet&&s.bindings?.[item]!==packet?'new_source_material_requires_binding':null};
  }catch(e){return {registered:true,current:false,materialBound:false,reason:e instanceof Error?e.message:'event_source_unknown'};}
}
/** Derive the comparison baseline from intact original W1 responses, never
 * from a human-readable summary or a caller's "already reviewed" boolean. */
export function packetSourceMaterial(db:DatabaseSync,manifest:Row,knownPublished:Array<{id:number;bodySha256:string}>):string|null{
  try{
    const round=manifest.rounds.at(-1);if(!round?.current||round.gaps.length||['pr','pr_comments','review_comments','reviews'].some(k=>round.coverage[k]?.state!=='complete'))return null;
    const artifacts=manifest.artifacts.filter((r:Row)=>r.round===round.number&&r.status===200),values=(kind:string)=>{
      const refs=artifacts.filter((r:Row)=>r.kind===kind).sort((a:Row,b:Row)=>(a.page??0)-(b.page??0));
      if(!refs.length||refs.length!==round.coverage[kind].pages||kind!=='pr'&&refs.some((r:Row,i:number)=>r.page!==i+1))throw new Error('w1_source_pages_unknown');
      const result=refs.map((r:Row)=>JSON.parse(bytes(db,r.sha256).toString()));if((kind==='pr'?result.length:result.flat().length)!==round.coverage[kind].records)throw new Error('w1_source_count_unknown');return result;
    };
    const pr=values('pr');if(pr.length!==1)return null;
    return eventMaterialHash(materialProjection(pr[0],values('pr_comments').flat(),values('review_comments').flat(),values('reviews').flat(),knownPublished));
  }catch{return null;}
}
export function storedEventMaterial(db:DatabaseSync,reference:Row):Row{
  const index=JSON.parse(bytes(db,reference.projectionSha256).toString());
  if(!index.result.complete||eventMaterialHash(index.result.semantic)!==reference.materialSha256||index.result.candidate?.pr!==reference.pr)throw new Error('stored_event_material_binding_changed');
  return {pr:reference.pr,projectionSha256:reference.projectionSha256,materialSha256:reference.materialSha256,profileSha256:index.profileSha256,observedAt:index.observedAt,candidate:index.result.candidate,
    originals:index.records.filter((r:Row)=>['pr','comments','inline','reviews'].includes(r.kind)).map((r:Row)=>{const raw=bytes(db,r.sha256);if(raw.length!==r.bytes)throw new Error('event_capture_length_changed');return {kind:r.kind,endpoint:r.endpoint,status:r.status,sha256:r.sha256,text:new TextDecoder('utf8',{fatal:true}).decode(raw)};})};
}
