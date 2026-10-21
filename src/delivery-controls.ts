import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest,ownerDecisionText} from './authority-contract.js';
import {readOwnerSource} from './authority-source.js';
import {prepareDeliveryOutcome} from './delivery-outcome.js';

export type DeliverySelection={id:string;source:string;batchSha256:string};
type Source={id:string;store:string;item:string};
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'delivery_source_unavailable';
export class DeliveryControls{
  constructor(private selections:DeliverySelection[],private sources:Source[],readonly writable:boolean){}
  private select(id:string){const entry=this.selections.find(x=>x.id===id),source=entry&&this.sources.find(x=>x.id===entry.source);if(!entry||!source)throw new Error('delivery_not_selected');return {entry,source};}
  private assertMember(batch:{members:Array<{item:string}>},source:Source){if(!batch.members.some(m=>m.item===source.item))throw new Error('delivery_member_not_selected');}
  async state(){return Promise.all(this.selections.map(async entry=>{try{const {source}=this.select(entry.id),[batch]=await QueueStore.observeDeliveries(source.store,[entry.batchSha256]);this.assertMember(batch!,source);const requests=await QueueStore.observeDeliveryRequests(source.store,entry.batchSha256);return {id:entry.id,source:entry.source,available:true,batch,requests:requests.map(r=>r.available?{...r,ownerComment:ownerDecisionText(r.proposalSha256)}:r),canPrepare:this.writable&&batch!.currentVersion&&batch!.currentMaterials&&batch!.scope.currentAdoption,permissionsGranted:false};}catch(e){return {id:entry.id,source:entry.source,available:false,reason:reason(e),canPrepare:false,permissionsGranted:false};}}));}
  async prepare(id:string,body:any){
    if(!this.writable)throw new Error('read_only_workbench');if(!exactKeys(body,['outcome','rationale','evidenceSha256','previousOutcome']))throw new Error('delivery_outcome_body_invalid');const {entry,source}=this.select(id),q=await QueueStore.open(source.store);
    try{const batch=q.deliveries().state(entry.batchSha256);this.assertMember(batch,source);const request={schemaVersion:1,kind:'tongxu-delivery-outcome-request',id:hash(canonical([entry.batchSha256,body])),batchSha256:entry.batchSha256,...body};return prepareDeliveryOutcome(q,Buffer.from(canonical(request)));}finally{q.close();}
  }
  async apply(id:string,body:any){
    if(!this.writable)throw new Error('read_only_workbench');if(!exactKeys(body,['proposalSha256','commentId'])||!isAuthorityDigest(body.proposalSha256)||!Number.isSafeInteger(body.commentId)||body.commentId<=0)throw new Error('delivery_outcome_source_invalid');const {entry,source}=this.select(id),q=await QueueStore.open(source.store);
    try{const batch=q.deliveries().state(entry.batchSha256);this.assertMember(batch,source);const a=q.authority(),p=a.proposal(body.proposalSha256).proposal;if(p.kind!=='delivery_outcome'||p.batchSha256!==entry.batchSha256)throw new Error('delivery_outcome_not_selected');
      if(batch.outcomes.some(o=>o.proposalSha256===body.proposalSha256)){const original=a.inspectRecordedDecision(body.proposalSha256);if(original.source.commentId!==body.commentId)throw new Error('delivery_outcome_source_changed');return {duplicate:true,originalDecisionRecorded:true,externalStateRechecked:false,permissionsGranted:false};}
      // Runtime input supplies only an exact source comment ID. Paths, source
      // executable and queries stay under the existing trusted profile.
      const {profile}=a.configuration(),parent=join(source.store,'delivery-owner-sources');await mkdir(parent,{recursive:true,mode:0o700});const root=join(parent,body.proposalSha256+'-'+randomUUID()),observation=await readOwnerSource(profile,body.proposalSha256,body.commentId,root),dependencies=[];
      for(const [i,ref] of a.sourceRequests(p.adoption).entries())dependencies.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,'adoption-'+i)));
      return {...a.apply(body.proposalSha256,observation,dependencies),permissionsGranted:false};
    }finally{q.close();}
  }
  async report(id:string,assessment:string){const {entry,source}=this.select(id),[batch]=await QueueStore.observeDeliveries(source.store,[entry.batchSha256]);this.assertMember(batch!,source);const report=await QueueStore.observeDeliveryAssessment(source.store,assessment,true);if(report.batchSha256!==entry.batchSha256)throw new Error('delivery_assessment_not_selected');return report;}
}
