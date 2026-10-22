import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest,type OwnerProposal} from './authority-contract.js';
import {readOwnerSource} from './authority-source.js';

type Source={id:string;store:string;item:string};
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'owner_control_source_unavailable';
const controlRequestId=(item:string,proposal:OwnerProposal,revision:number)=>'workbench-control-'+hash(canonical([item,proposal,revision]));
/** Forms assemble the existing proposal records. A local viewer key can
 * prepare a request, but cannot replace its independent Owner source. */
export class OwnerControls{
  constructor(private selected:string[],private sources:Source[]){}
  private source(id:string){const s=this.sources.find(x=>x.id===id);if(!s||!this.selected.includes(id))throw new Error('owner_control_task_not_selected');return s;}
  async state(){return Promise.all(this.selected.map(async id=>{const source=this.source(id);try{return {source:id,available:true,...await QueueStore.observeOwnerTask(source.store,source.item)};}catch(e){return {source:id,available:false,reason:reason(e),permissionsGranted:false};}}));}
  async prepare(id:string,body:any){
    const s=this.source(id),current=await QueueStore.observeOwnerTask(s.store,s.item);let proposal:OwnerProposal;
    if(body?.kind==='goal'&&exactKeys(body,['kind','scopeVersion','body','previousAdoption'])){
      if(body.previousAdoption!==current.currentAdoption)throw new Error('owner_scope_previous_version_changed');
      proposal={kind:'adopt_scope',scopeId:current.scopeId,scopeVersion:body.scopeVersion,body:body.body,previousAdoption:current.currentAdoption};
    }else if(body?.kind==='delegate'&&exactKeys(body,['kind','adoption','roles','actions','paths','resourceRefs','expiresAt'])){
      if(body.adoption!==current.currentAdoption)throw new Error('current_adopted_scope_required');
      proposal={kind:'delegate',adoption:body.adoption,roles:body.roles,targets:[current.target],actions:body.actions,paths:body.paths,resourceRefs:body.resourceRefs,expiresAt:body.expiresAt};
    }else if(body?.kind==='control'&&exactKeys(body,['kind','adoption','control','state','expectedRevision'])){
      if(!current.currentAdoption||body.adoption!==current.currentAdoption)throw new Error('current_adopted_scope_required');
      if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)throw new Error('owner_control_revision_changed');
      proposal={kind:'control',adoption:body.adoption,control:body.control,state:body.state};
    }else if(body?.kind==='revoke'&&exactKeys(body,['kind','decision'])){
      if(!current.requests.some(r=>r.proposalSha256===body.decision&&r.applied&&['delegate','confirm_action'].includes(r.proposal.kind)))throw new Error('owner_control_decision_outside_task');
      proposal={kind:'revoke',decision:body.decision};
    }else throw new Error('owner_control_form_invalid');
    const q=await QueueStore.open(s.store);try{
      return q.withOwnerTask(s.item,current.scopeId,current.target,a=>{
        if(proposal.kind==='control'){
          const latest=a.forScope(current.scopeId,{item:s.item,target:current.target});
          if(latest.currentAdoption!==proposal.adoption)throw new Error('current_adopted_scope_required');
          if(latest.controls.find(c=>c.control===proposal.control)?.revision!==body.expectedRevision)throw new Error('owner_control_revision_changed');
          return a.prepare(controlRequestId(s.item,proposal,body.expectedRevision),Buffer.from(canonical(proposal)));
        }
        return a.prepare('workbench-'+hash(canonical([s.item,proposal])).slice(0,48),Buffer.from(canonical(proposal)));
      });
    }finally{q.close();}
  }
  async apply(id:string,body:any){
    if(!exactKeys(body,['proposalSha256','sourceUrl'])||!isAuthorityDigest(body.proposalSha256)||typeof body.sourceUrl!=='string')throw new Error('owner_control_source_invalid');
    const s=this.source(id),state=await QueueStore.observeOwnerTask(s.store,s.item),request=state.requests.find(r=>r.proposalSha256===body.proposalSha256);if(!request)throw new Error('owner_control_proposal_outside_task');
    const prefix=`https://github.com/${state.repository}/issues/${state.issue}#issuecomment-`;if(!body.sourceUrl.startsWith(prefix)||!/^[1-9]\d*$/.test(body.sourceUrl.slice(prefix.length)))throw new Error('owner_control_exact_source_url_required');const commentId=Number(body.sourceUrl.slice(prefix.length));if(!Number.isSafeInteger(commentId))throw new Error('owner_control_source_invalid');
    const q=await QueueStore.open(s.store);try{const a=q.authority(),{profile}=a.configuration();
      if(request.applied){const original=a.inspectRecordedDecision(body.proposalSha256);if(original.source.commentId!==commentId)throw new Error('owner_decision_source_is_fixed');return {duplicate:true,originalDecisionRecorded:true,externalStateRechecked:false};}
      const root=join(s.store,'workbench-owner-sources');await mkdir(root,{recursive:true,mode:0o700});const observation=await readOwnerSource(profile,body.proposalSha256,commentId,join(root,randomUUID()));return q.withOwnerTask(s.item,state.scopeId,state.target,records=>{
        const latest=records.forScope(state.scopeId,{item:s.item,target:state.target});
        if(!latest.requests.some(r=>r.proposalSha256===body.proposalSha256))throw new Error('owner_control_proposal_outside_task');
        const prepared=records.proposal(body.proposalSha256),p=prepared.proposal;
        if(p.kind==='control'&&prepared.requestId.startsWith('workbench-control-')&&!latest.requests.find(r=>r.proposalSha256===body.proposalSha256)!.applied){
          const revision=latest.controls.find(c=>c.control===p.control)!.revision;
          if(prepared.requestId!==controlRequestId(s.item,p,revision))throw new Error('owner_control_revision_changed');
        }
        return records.apply(body.proposalSha256,observation);
      });
    }finally{q.close();}
  }
}
