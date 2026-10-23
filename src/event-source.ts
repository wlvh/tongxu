import { PublicationHttp } from './publication-http.js';
import { canonical } from './comparison.js';
import { privateDirectory,hash } from './snapshot.js';
import { shaPattern,validBranchRef } from './contract.js';
import { parseEventProfile,type EventProfile } from './event-contract.js';

type Row=Record<string,any>;
export type SourceRead={kind:string;endpoint:string;page:number;status:number;body:Buffer;headers:Record<string,string>;directory:string};
export type EventSourceObservation={profileSha256:string;pr:number;records:SourceRead[];result:ReturnType<typeof interpretEventSource>;transportGap:string|null;knownPublished:Array<{id:number;bodySha256:string}>;observedAt:string};
const observations=new WeakSet<object>();
const maxBytes=16*1024*1024;
export const eventMaterialHash=(semantic:Row)=>hash(canonical({prBodySha256:semantic.prBodySha256,comments:semantic.comments,inline:semantic.inline,reviews:semantic.reviews}));
export function materialProjection(pr:Row,comments:Row[],inline:Row[],reviews:Row[],knownPublished:Array<{id:number;bodySha256:string}>){
  const textRows=(rows:Row[])=>rows.map(r=>{
    if(!Number.isSafeInteger(r.id)||typeof r.body!=='string'||!Number.isSafeInteger(r.user?.id))throw new Error('source_material_identity_unknown');
    return {id:r.id,actor:r.user.id,bodySha256:hash(r.body),path:typeof r.path==='string'?r.path:null,line:Number.isSafeInteger(r.line)?r.line:null,commit:typeof r.commit_id==='string'?r.commit_id:null,state:typeof r.state==='string'?r.state:null};
  }).sort((a,b)=>a.id-b.id);
  if(!(typeof pr.body==='string'||pr.body===null))throw new Error('source_pr_body_unknown');
  return {prBodySha256:hash(pr.body??''),comments:textRows(comments).filter(r=>!knownPublished.some(k=>k.id===r.id&&k.bodySha256===r.bodySha256)),inline:textRows(inline),reviews:textRows(reviews)};
}
function decode(r:SourceRead){if(r.status!==200)throw new Error('source_http_'+r.status);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(r.body));}
const next=(r:SourceRead)=>{
  if(r.headers.link===undefined)return false;
  let found=false;
  for(const part of r.headers.link.split(',')){
    const m=/^\s*<([^>]+)>\s*;\s*rel="(next|last|prev|first)"\s*$/.exec(part);if(!m)throw new Error('source_pagination_header_invalid');
    const u=new URL(m[1]!);if(u.origin!=='https://api.github.com'||u.pathname!=='/'+r.endpoint.split('?')[0]||u.hash||u.username||u.password||u.searchParams.get('per_page')!=='100'||!(/^[1-9][0-9]*$/).test(u.searchParams.get('page')??'')||[...u.searchParams.keys()].some(k=>!['page','per_page','filter'].includes(k))||(u.searchParams.get('filter')??null)!==(r.kind==='checks'?'latest':null))throw new Error('source_pagination_header_invalid');
    if(m[2]==='next')found=true;
  }
  return found;
};

/** Semantic projection omits update timestamps and transport noise. Original
 * bytes still remain available; omitting timestamps never asserts coverage. */
export function interpretEventSource(p:EventProfile,pr:number,records:SourceRead[],transportGap:string|null,knownPublished:Array<{id:number;bodySha256:string}>){
  const gaps:string[]=transportGap?[transportGap]:[],by=(kind:string)=>records.filter(r=>r.kind===kind);let candidate:Row|null=null,first:Row|null=null,last:Row|null=null;
  try{
    const values=by('pr');if(values.length!==2)throw new Error('pr_pair_missing');first=decode(values[0]!);last=decode(values[1]!);
    const valid=(v:Row)=>v&&v.number===pr&&v.base?.repo?.id===p.repositoryId&&v.base.repo.full_name?.toLowerCase()===p.repository.toLowerCase()&&shaPattern.test(v.head?.sha??'')&&validBranchRef(v.base?.ref)&&['open','closed'].includes(v.state)&&typeof v.draft==='boolean';
    if(!valid(first!)||!valid(last!))throw new Error('pr_identity_unknown');
    if(first!.head.sha!==last!.head.sha||first!.base.ref!==last!.base.ref||first!.state!==last!.state||first!.draft!==last!.draft||first!.comments!==last!.comments||first!.review_comments!==last!.review_comments||first!.body!==last!.body)throw new Error('pr_changed_during_read');
    const refs=by('target');if(refs.length!==2)throw new Error('target_pair_missing');const a=decode(refs[0]!),z=decode(refs[1]!);
    if([a,z].some(r=>r.ref!==`refs/heads/${first!.base.ref}`||r.object?.type!=='commit'||!shaPattern.test(r.object.sha??''))||a.object.sha!==z.object.sha)throw new Error('direct_target_changed_or_unknown');
    candidate={repository:p.repository,repositoryId:p.repositoryId,pr,H:first!.head.sha,B:z.object.sha,targetRef:first!.base.ref,state:first!.state,draft:first!.draft};
  }catch(e){gaps.push(e instanceof Error?e.message:'candidate_unavailable');}
  function pages(kind:string,field?:string,expected?:number):Row[]{
    const reads=by(kind),all:Row[]=[],ids=new Set<number>();let total:number|undefined;
    try{
      if(!reads.length)throw new Error('missing');
      for(const [i,r] of reads.entries()){
        if(r.page!==i+1||next(r)!==(i<reads.length-1))throw new Error('pagination');
        const v=decode(r),rows=field?v[field]:v;if(!Array.isArray(rows)||rows.length>100||i<reads.length-1&&rows.length!==100)throw new Error('shape');
        if(field){if(!Number.isSafeInteger(v.total_count)||v.total_count<0||total!==undefined&&total!==v.total_count)throw new Error('count');total=v.total_count;}
        for(const row of rows){if(!row||!Number.isSafeInteger(row.id)||row.id<=0||ids.has(row.id))throw new Error('id');ids.add(row.id);all.push(row);}
      }
      if(total!==undefined&&all.length!==total||expected!==undefined&&all.length!==expected)throw new Error('count');
    }catch{gaps.push(kind+'_coverage_incomplete');}
    return all;
  }
  const expected=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0?v as number:undefined;
  if(expected(first?.comments)===undefined||expected(first?.review_comments)===undefined)gaps.push('comment_counts_unknown');
  const comments=pages('comments',undefined,expected(first?.comments)),inline=pages('inline',undefined,expected(first?.review_comments)),reviews=pages('reviews'),checks=pages('checks','check_runs'),statuses=pages('statuses');
  const textRows=(rows:Row[])=>rows.map(r=>{
    if(typeof r.body!=='string'||!Number.isSafeInteger(r.user?.id))gaps.push('source_body_or_actor_unknown');
    return {id:r.id,actor:Number.isSafeInteger(r.user?.id)?r.user.id:null,bodySha256:hash(typeof r.body==='string'?r.body:''),path:typeof r.path==='string'?r.path:null,line:Number.isSafeInteger(r.line)?r.line:null,commit:typeof r.commit_id==='string'?r.commit_id:null,state:typeof r.state==='string'?r.state:null};
  }).sort((a,b)=>a.id-b.id);
  const commentFacts=textRows(comments).filter(r=>!knownPublished.some(k=>k.id===r.id&&k.bodySha256===r.bodySha256)),inlineFacts=textRows(inline),reviewFacts=textRows(reviews);
  const effectiveChecks=new Map<string,Row>();
  for(const r of checks){
    if(r.head_sha!==candidate?.H||typeof r.name!=='string'||!Number.isSafeInteger(r.app?.id)||typeof r.status!=='string'||!(r.conclusion===null||typeof r.conclusion==='string')){gaps.push('check_identity_unknown');continue;}
    const key=canonical([r.app.id,r.name]);if(!effectiveChecks.has(key)||effectiveChecks.get(key)!.id<r.id)effectiveChecks.set(key,r);
  }
  const checkFacts=[...effectiveChecks.values()].map(r=>({app:r.app.id,name:r.name,status:r.status,conclusion:r.conclusion})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  const effectiveStatuses=new Map<string,Row>();
  for(const r of statuses){if(typeof r.context!=='string'||typeof r.state!=='string'||!Number.isFinite(Date.parse(r.created_at))){gaps.push('status_identity_unknown');continue;}const key=r.context.toLowerCase(),old=effectiveStatuses.get(key);if(!old||Date.parse(r.created_at)>Date.parse(old.created_at)||r.created_at===old.created_at&&r.id>old.id)effectiveStatuses.set(key,r);}
  const statusFacts=[...effectiveStatuses.entries()].map(([context,r])=>({context,state:r.state})).sort((a,b)=>a.context.localeCompare(b.context));
  const semantic={candidate,prBodySha256:typeof last?.body==='string'?hash(last.body):last?.body===null?hash(''):null,comments:commentFacts,inline:inlineFacts,reviews:reviewFacts,checks:checkFacts,statuses:statusFacts};
  if(semantic.prBodySha256===null)gaps.push('pr_body_unknown');
  return {complete:gaps.length===0,candidate,semantic,semanticSha256:hash(canonical(semantic)),gaps:[...new Set(gaps)],prReportedBase:first?.base?.sha??null,nonAtomicRemoteObservation:true,modelTasksStarted:0};
}

export async function readEventSource(profile:EventProfile,pr:number,directory:string,knownPublished:Array<{id:number;bodySha256:string}>=[]):Promise<EventSourceObservation>{
  const p=parseEventProfile(Buffer.from(canonical(profile)));if(!p.prs.includes(pr))throw new Error('event_subject_not_registered');
  await privateDirectory(directory,true);const records:SourceRead[]=[];let total=0,transportGap:string|null=null;
  const http=(H:string,target:string)=>new PublicationHttp(directory,p.ghExecutable,p.ghSha256,p.repository,pr,H,target,true,p.executionKind==='github'),root=`repos/${p.repository}`;
  const get=async(client:PublicationHttp,kind:string,endpoint:string,page=1)=>{
    const reply=await client.request('GET',endpoint);total+=reply.body.length;if(total>maxBytes)throw new Error('event_source_aggregate_limit');
    const record={kind,endpoint,page,status:reply.status,body:reply.body,headers:reply.headers,directory:reply.directory};records.push(record);return record;
  };
  try{
    const initial=http('0'.repeat(40),'source-read-placeholder'),first=decode(await get(initial,'pr',`${root}/pulls/${pr}`));
    if(first.number!==pr||first.base?.repo?.id!==p.repositoryId||first.base.repo.full_name?.toLowerCase()!==p.repository.toLowerCase()||!shaPattern.test(first.head?.sha??'')||!validBranchRef(first.base?.ref))throw new Error('event_initial_candidate_invalid');
    const fixed=http(first.head.sha,first.base.ref),ref=`${root}/git/ref/heads/${encodeURIComponent(first.base.ref)}`;await get(fixed,'target',ref);
    for(const [kind,path] of [['comments',`issues/${pr}/comments`],['inline',`pulls/${pr}/comments`],['reviews',`pulls/${pr}/reviews`],['checks',`commits/${first.head.sha}/check-runs?filter=latest&`],['statuses',`commits/${first.head.sha}/statuses`]] as const){
      for(let page=1;page<=10;page++){
        const endpoint=`${root}/${path}${kind==='checks'?'':'?'}per_page=100&page=${page}`,r=await get(fixed,kind,endpoint,page);
        if(r.status!==200||!next(r))break;
      }
    }
    await get(fixed,'pr',`${root}/pulls/${pr}`);await get(fixed,'target',ref);
  }catch(e){transportGap=e instanceof Error?e.message:'event_source_unavailable';}
  const result=interpretEventSource(p,pr,records,transportGap,knownPublished),value=Object.freeze({profileSha256:hash(canonical(p)),pr,records,result,transportGap,knownPublished,observedAt:new Date().toISOString()});observations.add(value);return value;
}
export function requireEventSource(value:EventSourceObservation,p:EventProfile,pr:number){
  if(!observations.has(value)||value.profileSha256!==hash(canonical(p))||value.pr!==pr||Date.now()-Date.parse(value.observedAt)>60000||Date.parse(value.observedAt)>Date.now()+1000||value.records.reduce((n,r)=>n+r.body.length,0)>maxBytes)throw new Error('actual_event_source_observation_required');
  if(canonical(interpretEventSource(p,pr,value.records,value.transportGap,value.knownPublished))!==canonical(value.result))throw new Error('event_source_original_changed');
}
