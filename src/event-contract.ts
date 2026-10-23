import { isAbsolute,resolve } from 'node:path';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { repoPattern,shaPattern } from './contract.js';
import { exactKeys,isAuthorityDigest } from './authority-contract.js';

export type EventProfile={schemaVersion:1;kind:'tongxu-bounded-event-source';repository:string;repositoryId:number;ghExecutable:string;ghSha256:string;executionKind:'fixture'|'github';prs:number[];pollIntervalMs:number;maxSubjectsPerTick:number};
export type EventHint={schemaVersion:1;id:string;pr:number;kind:'submitted'|'head_changed'|'checks_finished'|'prerequisite_changed'|'consumer_feedback'|'decision_changed'};
export function parseEventProfile(raw:Buffer):EventProfile{
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','repository','repositoryId','ghExecutable','ghSha256','executionKind','prs','pollIntervalMs','maxSubjectsPerTick'])||p.schemaVersion!==1||p.kind!=='tongxu-bounded-event-source'||typeof p.repository!=='string'||!repoPattern.test(p.repository)||!Number.isSafeInteger(p.repositoryId)||p.repositoryId<=0||typeof p.ghExecutable!=='string'||!isAbsolute(p.ghExecutable)||resolve(p.ghExecutable)!==p.ghExecutable||!isAuthorityDigest(p.ghSha256)||!['fixture','github'].includes(p.executionKind)||!Array.isArray(p.prs)||!p.prs.length||p.prs.length>8||new Set(p.prs).size!==p.prs.length||!p.prs.every((n:unknown)=>Number.isSafeInteger(n)&&(n as number)>0)||!Number.isSafeInteger(p.pollIntervalMs)||p.pollIntervalMs<(p.executionKind==='fixture'?10:60000)||p.pollIntervalMs>86400000||!Number.isSafeInteger(p.maxSubjectsPerTick)||p.maxSubjectsPerTick<1||p.maxSubjectsPerTick>p.prs.length)throw new Error('bounded_event_profile_invalid');
  return p;
}
export function parseEventHint(raw:Buffer,p:EventProfile):EventHint{
  const x=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(raw.length>4096||!exactKeys(x,['schemaVersion','id','pr','kind'])||x.schemaVersion!==1||typeof x.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x.id)||!p.prs.includes(x.pr)||!['submitted','head_changed','checks_finished','prerequisite_changed','consumer_feedback','decision_changed'].includes(x.kind))throw new Error('bounded_event_hint_invalid');
  return x;
}
export const eventKey=(repository:string,pr:number)=>`${repository.toLowerCase()}#${pr}`;
export const semanticEventHash=(x:unknown)=>hash(canonical(x));
export type QueuePreference={schemaVersion:1;kind:'queue_preference';item:string;priority:number;mainIncident:boolean;reason:string};
export function parseQueuePreference(raw:Buffer):QueuePreference{
  const x=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(raw.length>8192||!exactKeys(x,['schemaVersion','kind','item','priority','mainIncident','reason'])||x.schemaVersion!==1||x.kind!=='queue_preference'||!isAuthorityDigest(x.item)||!Number.isSafeInteger(x.priority)||x.priority< -2||x.priority>2||typeof x.mainIncident!=='boolean'||typeof x.reason!=='string'||!x.reason.trim()||x.reason.length>2048||x.reason.includes('\0'))throw new Error('queue_preference_invalid');
  return x;
}

export type RankItem={
  item:string;packet:number;H:string;createdAt:string;current:boolean;waiting:string[];
  target:string;active:boolean;stage:'evaluate'|'receive'|'repair'|'publish'|'merge'|'materials'|'finished';
  classification:'ordinary'|'verified_return'|'verified_finish'|'adopted_main_incident';
  priority:number;estimatedCost:number|null;
  requires:Array<{item:string;H:string}>;evidence:string[];
};
export type SelectionHistory={item:string;class:'urgent'|'ordinary';selectedAt:string};
/** Internal projection only. The queue builds it from original records and
 * verified preference sources; a report cannot submit RankItems to an executor. */
export function rankQueue(items:RankItem[],history:SelectionHistory[],at:number){
  if(!Number.isFinite(at)||items.length>256||new Set(items.map(x=>x.item)).size!==items.length)throw new Error('ranking_input_invalid');
  const by=new Map(items.map(i=>[i.item,i])),oldestWaitMs=30*60*1000,urgentBurst=3;
  for(const i of items)if(!isAuthorityDigest(i.item)||!Number.isSafeInteger(i.packet)||i.packet<1||!shaPattern.test(i.H)||!Number.isFinite(Date.parse(i.createdAt))||!Number.isSafeInteger(i.priority)||i.priority< -2||i.priority>2||!(i.estimatedCost===null||Number.isFinite(i.estimatedCost)&&i.estimatedCost>=0)||!i.evidence.every(isAuthorityDigest))throw new Error('ranking_record_invalid');
  const baseClass=(i:RankItem)=>i.classification==='adopted_main_incident'?0:i.classification==='verified_finish'||i.classification==='verified_return'?1:2;
  const inherited=new Map<string,{rank:number;because:string[]}>();
  const promote=(id:string,rank:number,from:string,visiting:Set<string>)=>{
    const node=by.get(id);if(!node||visiting.has(id)||visiting.size>=32)return;
    const next=new Set(visiting).add(id);
    for(const dependency of node.requires){const upstream=by.get(dependency.item);if(!upstream||upstream.H!==dependency.H)continue;const old=inherited.get(upstream.item);if(!old||rank<old.rank)inherited.set(upstream.item,{rank,because:[from]});else if(rank===old.rank&&!old.because.includes(from))old.because.push(from);promote(upstream.item,rank,from,next);}
  };
  for(const i of items)if(i.current&&baseClass(i)<2)promote(i.item,baseClass(i),i.item,new Set());
  const rows=items.map(i=>{
    const inheritedPriority=inherited.get(i.item),rank=Math.min(baseClass(i),inheritedPriority?.rank??2),waitMs=Math.max(0,at-Date.parse(i.createdAt));
    const selectable=i.current&&!i.active&&!i.waiting.length&&i.stage!=='finished';
    const reasons=[...(!i.current?['candidate_or_material_not_current']:[]),...(i.active?['original_execution_active_or_unknown']:[]),...i.waiting,...(i.stage==='finished'?['no_new_stage']:[]),`classification:${i.classification}`,`adopted_priority:${i.priority}`,`wait_minutes:${Math.floor(waitMs/60000)}`,...(inheritedPriority&&inheritedPriority.rank<=baseClass(i)?['necessary_upstream_for:'+inheritedPriority.because.sort().join(',')]:[]),i.estimatedCost===null?'cost_unknown':`recorded_cost:${i.estimatedCost}`];
    return {...i,selectable,rank,waitMs,reasons,fairnessTurn:false};
  });
  // A short urgent burst is followed by one oldest waiting eligible task. This
  // is selection at a safe boundary, never interruption of a long execution.
  const recent=history.slice(-urgentBurst),burst=recent.length===urgentBurst&&recent.every(h=>h.class==='urgent');
  if(burst){const aged=rows.filter(i=>i.selectable&&i.rank===2&&i.waitMs>=oldestWaitMs).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.item.localeCompare(b.item))[0];if(aged){aged.fairnessTurn=true;aged.reasons.push('oldest_waiting_turn_after_three_urgent_starts');}}
  rows.sort((a,b)=>Number(b.selectable)-Number(a.selectable)||Number(b.fairnessTurn)-Number(a.fairnessTurn)||a.rank-b.rank||b.priority-a.priority||Math.floor(b.waitMs/oldestWaitMs)-Math.floor(a.waitMs/oldestWaitMs)||(a.estimatedCost??Infinity)-(b.estimatedCost??Infinity)||a.createdAt.localeCompare(b.createdAt)||a.item.localeCompare(b.item));
  return {items:rows,selected:rows.find(i=>i.selectable)??null,policy:{oldestWaitMs,urgentBurst,preemption:false},rankingGrantsAuthority:false,modelTasksStarted:0};
}
