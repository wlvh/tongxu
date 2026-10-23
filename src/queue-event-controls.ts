import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest,parseActionRequest,type ActionRequest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {parseQueuePreference,type QueuePreference,type EventHint} from './event-contract.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';

type Source={id:string;store:string;item:string};
type Common={id:string;title:string;source:string;profileSha256:string};
type Entry=Common&({kind:'hint';hintKind:EventHint['kind']}|{kind:'preference';preference:QueuePreference;request:ActionRequest;authorization:string});
export type EventControlRef={path:string;sha256:string;source:string};
const sourceId=(x:unknown):x is string=>typeof x==='string'&&/^[a-z0-9-]{1,64}$/.test(x);
export function validateEventControlRef(ref:unknown):asserts ref is EventControlRef{
  const x=ref as EventControlRef;
  if(!exactKeys(x,['path','sha256','source'])||!messagePath(x.path)||!isAuthorityDigest(x.sha256)||!sourceId(x.source))throw new Error('event_control_reference_invalid');
}
function parse(raw:Buffer):Entry[]{
  const x=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(x,['schemaVersion','kind','actions'])||x.schemaVersion!==1||x.kind!=='tongxu-queue-event-controls'||!Array.isArray(x.actions)||!x.actions.length||x.actions.length>32)throw new Error('event_control_catalog_invalid');
  const ids=new Set();
  for(const e of x.actions){
    if(!exactKeys(e,['id','title','source','profileSha256','kind',...(e?.kind==='hint'?['hintKind']:['preference','request','authorization'])])||!messageId(e.id)||ids.has(e.id)||typeof e.title!=='string'||!e.title.trim()||e.title.length>100||e.title.includes('\0')||!sourceId(e.source)||!isAuthorityDigest(e.profileSha256))throw new Error('event_control_action_invalid');
    ids.add(e.id);
    if(e.kind==='hint'){if(!['submitted','head_changed','checks_finished','prerequisite_changed','consumer_feedback','decision_changed'].includes(e.hintKind))throw new Error('event_control_hint_invalid');}
    else if(e.kind==='preference'){
      parseQueuePreference(Buffer.from(canonical(e.preference)));parseActionRequest(e.request);
      if(!isAuthorityDigest(e.authorization)||e.request.action!=='coordinate'||e.request.item!==e.preference.item||e.request.paths.length||e.request.resourceRefs.length||e.request.payloadSha256!==hash(canonical(e.preference)))throw new Error('event_control_preference_binding_invalid');
    }else throw new Error('event_control_kind_invalid');
  }
  return x.actions;
}
/** A fixed consumer of the original hint and preference records. It cannot
 * configure a source, construct a new permission, dispatch an agent or merge. */
export class QueueEventControls {
  private constructor(private path:string,readonly catalogSha256:string,private entries:Array<{entry:Entry;source:Source}>){ }
  static async load(path:string,sha256:string,sources:Source[],selectedSource?:string){
    if(!messagePath(path)||!isAuthorityDigest(sha256)||selectedSource!==undefined&&!sourceId(selectedSource))throw new Error('event_control_reference_invalid');
    const raw=await regular(path,128*1024);if(hash(raw)!==sha256)throw new Error('event_control_catalog_changed');
    const entries=parse(raw).filter(e=>selectedSource===undefined||e.source===selectedSource).map(entry=>{
      const source=sources.find(s=>s.id===entry.source);
      if(!source||entry.kind==='preference'&&entry.preference.item!==source.item)throw new Error('event_control_task_not_selected');
      return {entry,source:structuredClone(source)};
    });
    if(!entries.length)throw new Error('event_control_task_not_selected');
    return new QueueEventControls(path,sha256,entries);
  }
  manifest(){return {catalogSha256:this.catalogSha256,actions:this.entries.map(({entry:e})=>({id:e.id,title:e.title,source:e.source,kind:e.kind,...(e.kind==='hint'?{hintKind:e.hintKind}:{preference:e.preference}),permissionsGranted:false})),modelDispatchAvailable:false};}
  private selected(id:string){const f=this.entries.find(f=>f.entry.id===id);if(!f)throw new Error('event_control_not_selected');return f;}
  private prefix(id:string){return 'qe-'+hash(canonical([this.catalogSha256,id]))+'-';}
  private async context(f:{entry:Entry;source:Source}){
    const state=await QueueStore.observe(f.source.store,[],[],[f.source.item]),item=state.items.find((i:any)=>i.id===f.source.item);
    if(!item||!Number.isSafeInteger(item.candidate.pr)||item.candidate.pr<1)throw new Error('event_control_formal_candidate_required');
    return item;
  }
  private profile(q:QueueStore,f:{entry:Entry;source:Source},item:any){
    const profile=q.events().configuration();
    if(hash(canonical(profile))!==f.entry.profileSha256||profile.repository.toLowerCase()!==item.candidate.repository.toLowerCase()||!profile.prs.includes(item.candidate.pr))throw new Error('event_control_source_profile_changed');
    return profile;
  }
  async state(){return Promise.all(this.entries.map(async f=>{
    try{const item=await this.context(f),q=await QueueStore.open(f.source.store);try{
      const profile=this.profile(q,f,item),receipts=q.events().controlReceipts(f.entry.kind,this.prefix(f.entry.id)),ranked=q.scheduling().items.find((i:any)=>i.item===f.source.item);
      return {id:f.entry.id,source:f.source.id,title:f.entry.title,kind:f.entry.kind,available:true,executionKind:profile.executionKind,receipts,currentQueue:ranked?{priority:ranked.priority,stage:ranked.stage,waiting:ranked.waiting,current:ranked.current}:null,authorityReobserved:false,modelTasksStarted:0};
    }finally{q.close();}}catch(e){return {id:f.entry.id,source:f.source.id,title:f.entry.title,kind:f.entry.kind,available:false,reason:e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'event_control_unavailable',modelTasksStarted:0};}
  }));}
  async execute(id:string,requestId:string,beforeRegistration?:()=>void){
    if(!messageId(requestId))throw new Error('event_control_request_id_invalid');
    const f=this.selected(id),e=f.entry;
    if(hash(await regular(this.path,128*1024))!==this.catalogSha256)throw new Error('event_control_catalog_changed');
    const item=await this.context(f),q=await QueueStore.open(f.source.store),originalId=this.prefix(id)+hash(requestId).slice(0,32);
    try{
      const profile=this.profile(q,f,item),prior=q.events().controlReceipt(e.kind,originalId);
      if(prior)return {action:id,requestId,originalId,record:prior,duplicate:true,modelTasksStarted:0,taskExecutionStarted:false};
      let record:unknown;
      if(e.kind==='hint'){
        beforeRegistration?.();record=q.events().hint(Buffer.from(canonical({schemaVersion:1,id:originalId,pr:item.candidate.pr,kind:e.hintKind})));
      }else{
        const authority=q.authority(),owner=authority.configuration().profile,observations:OwnerObservation[]=[];
        if(owner.executionKind!==profile.executionKind)throw new Error('event_control_execution_kind_mismatch');
        for(const ref of authority.sourceRequests(e.authorization))observations.push(await readOwnerSource(owner,ref.proposalSha256,ref.commentId,join(f.source.store,'event-control-source-'+randomUUID())));
        // The original authority consumer checks current candidate, revocation,
        // single-use confirmation or delegation. Tool text supplies none of it.
        beforeRegistration?.();authority.reserveAction(originalId,e.request,'secretary',e.authorization,observations);
        beforeRegistration?.();record=q.events().applyPreference(originalId,Buffer.from(canonical(e.preference)),observations);
      }
      return {action:id,requestId,originalId,record,duplicate:!!(record as any)?.duplicate,ownerSourcesRechecked:e.kind==='preference',modelTasksStarted:0,taskExecutionStarted:false};
    }finally{q.close();}
  }
}
