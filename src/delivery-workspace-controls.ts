import {QueueStore} from './queue-store.js';
import {DeliveryControls,type DeliverySelection} from './delivery-controls.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';

type Source={id:string;title:string;store:string;item:string};
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'delivery_preparation_source_unavailable';
/** Discover only selected roots and their recorded subsequent tasks. Preparing
 * a batch records fixed material; it neither runs tests nor grants permission. */
export class DeliveryWorkspaceControls{
  constructor(private fixed:DeliverySelection[],private preparable:string[],private sources:Source[],readonly writable:boolean){}
  private groups(){const groups=new Map<string,Source[]>();for(const s of this.sources)if(this.preparable.includes(s.id))groups.set(s.store,[...(groups.get(s.store)??[]),s]);return [...groups.entries()];}
  private sourceFor(store:string,roots:Source[],v:{item:string;selectedFrom:string;scope:{version:string}}){const root=roots.find(s=>s.item===v.selectedFrom)!;if(v.item===root.item)return root;const value={id:'followup-'+hash(canonical([root.id,v.item])).slice(0,48),title:root.title+' / '+v.scope.version,store,item:v.item},collision=this.sources.find(s=>s.id===value.id);if(collision&&(collision.store!==store||collision.item!==v.item))throw new Error('delivery_preparation_source_identity_conflict');return value;}
  private async catalogue(){const result=[...this.fixed],allSources=[...this.sources],problems:Array<{id:string;source:string;available:false;reason:string;canPrepare:false;batch:undefined}>=[];
    for(const [store,roots] of this.groups())try{
      const members=await QueueStore.observeDeliveryPreparation(store,roots.map(s=>s.item)),expanded=members.map(v=>this.sourceFor(store,roots,v));for(const s of expanded)if(!allSources.some(x=>x.id===s.id))allSources.push(s);
      const batches=await QueueStore.observeSelectedDeliveries(store,roots.map(s=>s.item));for(const batch of batches){const source=expanded.find(s=>s.item===batch.members[0]!.item);if(!source)throw new Error('delivery_preparation_source_changed');
        if(result.some(d=>d.batchSha256===batch.batchSha256&&allSources.find(s=>s.id===d.source)?.store===store))continue;
        result.push({id:'batch-'+hash(canonical([source.id,batch.batchSha256])).slice(0,48),source:source.id,batchSha256:batch.batchSha256});
      }
    }catch(e){problems.push({id:'source-'+roots[0]!.id,source:roots[0]!.id,available:false,reason:reason(e),canPrepare:false,batch:undefined});}
    return {entries:result,problems,sources:allSources};
  }
  async state(){const c=await this.catalogue();return [...await new DeliveryControls(c.entries,c.sources,this.writable).state(),...c.problems];}
  async preparation(){return Promise.all(this.groups().map(async([store,roots])=>{const base={source:roots[0]!.id,permissionsGranted:false,newModelRequests:0};try{
    const values=await QueueStore.observeDeliveryPreparation(store,roots.map(s=>s.item));return {...base,available:true,members:values.map(v=>{const s=this.sourceFor(store,roots,v);return {...v,source:s.id,title:s.title};})};
  }catch(e){return {...base,available:false,reason:reason(e)};}}));}
  private async selected(id:string){const c=await this.catalogue();if(!c.entries.some(e=>e.id===id))throw new Error('delivery_not_selected');return new DeliveryControls(c.entries,c.sources,this.writable);}
  async prepare(id:string,body:any){return (await this.selected(id)).prepare(id,body);}
  async apply(id:string,body:any){return (await this.selected(id)).apply(id,body);}
  async report(id:string,assessment:string){return (await this.selected(id)).report(id,assessment);}
  async register(sourceId:string,body:any){
    if(!this.writable)throw new Error('read_only_workbench');
    if(!exactKeys(body,['requestId','title','issue','adoption','previous','members','scenarios'])||!messageId(body.requestId)||!isAuthorityDigest(body.adoption)||!(body.previous===null||isAuthorityDigest(body.previous))||!Array.isArray(body.members)||!body.members.length||body.members.length>8||!Array.isArray(body.scenarios)||!body.scenarios.length||body.scenarios.length>52)throw new Error('delivery_preparation_form_invalid');
    const c=await this.catalogue(),source=c.sources.find(s=>s.id===sourceId),roots=this.groups().find(([store])=>store===source?.store)?.[1];if(!source||!roots)throw new Error('delivery_preparation_source_not_selected');
    const known=await QueueStore.observeDeliveryPreparation(source.store,roots.map(s=>s.item)),allowed=known.map(v=>this.sourceFor(source.store,roots,v)),lookup=(id:string)=>{const s=allowed.find(s=>s.id===id);if(!s)throw new Error('delivery_preparation_member_not_selected');return s.item;};
    lookup(sourceId);
    const members=body.members.map((m:any)=>{if(!exactKeys(m,['source','packet','fingerprint']))throw new Error('delivery_preparation_form_invalid');return {item:lookup(m.source),packet:m.packet,fingerprint:m.fingerprint};});
    if(!members.some((m:any)=>m.item===source.item))throw new Error('delivery_preparation_anchor_required');
    const scenarios=body.scenarios.map((s:any)=>{if(!exactKeys(s,['id','title','expected','sources'])||!Array.isArray(s.sources))throw new Error('delivery_preparation_form_invalid');return {id:s.id,title:s.title,expected:s.expected,members:s.sources.map(lookup)};});
    if(body.previous&&!c.entries.some(d=>d.batchSha256===body.previous&&allowed.some(s=>s.id===d.source)))throw new Error('delivery_preparation_previous_not_selected');
    const q=await QueueStore.open(source.store);try{return q.registerWorkbenchDelivery(source.item,allowed.map(s=>s.item),{...body,members,scenarios});}finally{q.close();}
  }
}
