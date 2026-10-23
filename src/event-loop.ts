import {QueueStore} from './queue-store.js';
import {sourceTick} from './event-tick.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';

export type EventPollingSelection={source:string;profileSha256:string;maxTicks:number};
type Source={id:string;store:string;item:string};
type Entry={selection:EventPollingSelection;store:string;interval:number;prs:number[];executionKind:string;timer?:ReturnType<typeof setTimeout>;active?:Promise<void>;started:number;finished:number;lastStartedAt?:string;nextCheckAt?:string;lastResult?:unknown;lastError?:string};
export function validateEventPolling(value:unknown,sources:Source[]):asserts value is EventPollingSelection[]{
  if(!Array.isArray(value)||!value.length||value.length>8)throw new Error('event_polling_selection_invalid');
  const selected=new Set();for(const e of value){const s=sources.find(s=>s.id===e?.source);if(!exactKeys(e,['source','profileSha256','maxTicks'])||!s||selected.has(s.store)||!isAuthorityDigest(e.profileSha256)||!Number.isSafeInteger(e.maxTicks)||e.maxTicks<1||e.maxTicks>1440)throw new Error('event_polling_selection_invalid');selected.add(s.store);}
}
/** Calls the existing bounded source checker during this foreground app's
 * lifetime. No new scheduler state, model loop, merge or installed service. */
export class SourceTickLoop {
  private accepting=false;
  private constructor(private entries:Entry[]){}
  static async load(selections:EventPollingSelection[],sources:Source[]){
    validateEventPolling(selections,sources);const entries:Entry[]=[];
    for(const selection of selections){
      const source=sources.find(s=>s.id===selection.source)!,observed=await QueueStore.observe(source.store,[],[],[source.item]),item=observed.items.find((i:any)=>i.id===source.item);if(!item)throw new Error('event_polling_task_missing');const q=await QueueStore.open(source.store);
      try{const p=q.events().configuration();if(hash(canonical(p))!==selection.profileSha256||p.repository.toLowerCase()!==item.candidate.repository.toLowerCase()||!p.prs.includes(item.candidate.pr))throw new Error('event_polling_profile_changed');entries.push({selection:structuredClone(selection),store:source.store,interval:p.pollIntervalMs,prs:p.prs,executionKind:p.executionKind,started:0,finished:0});}finally{q.close();}
    }
    return new SourceTickLoop(entries);
  }
  start(){if(this.accepting)throw new Error('event_polling_already_started');this.accepting=true;for(const e of this.entries)this.schedule(e,0);}
  private schedule(e:Entry,delay:number){
    if(!this.accepting||e.started>=e.selection.maxTicks)return;
    e.nextCheckAt=new Date(Date.now()+delay).toISOString();e.timer=setTimeout(()=>{
      delete e.timer;delete e.nextCheckAt;
      if(!this.accepting)return;
      const active=this.tick(e).finally(()=>{delete e.active;this.schedule(e,e.interval);});e.active=active;
    },delay);e.timer.unref();
  }
  private async tick(e:Entry){
    e.started++;e.lastStartedAt=new Date().toISOString();
    try{
      const q=await QueueStore.open(e.store);try{if(hash(canonical(q.events().configuration()))!==e.selection.profileSha256)throw new Error('event_polling_profile_changed');}finally{q.close();}
      e.lastResult=await sourceTick(e.store);delete e.lastError;
    }catch(error){e.lastError=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'event_polling_failed';}
    finally{e.finished++;}
  }
  state(){return this.entries.map(e=>({source:e.selection.source,profileSha256:e.selection.profileSha256,prs:e.prs,executionKind:e.executionKind,intervalMs:e.interval,maxTicks:e.selection.maxTicks,checksStarted:e.started,checksFinished:e.finished,active:!!e.active,lastStartedAt:e.lastStartedAt??null,nextCheckAt:e.nextCheckAt??null,lastResult:e.lastResult??null,lastError:e.lastError??null,accepting:this.accepting,limitReached:e.started>=e.selection.maxTicks,modelTasksStarted:0,mergeRequestsSent:0}));}
  async drain(){this.accepting=false;for(const e of this.entries){if(e.timer)clearTimeout(e.timer);delete e.timer;delete e.nextCheckAt;}await Promise.allSettled(this.entries.flatMap(e=>e.active?[e.active]:[]));}
}
