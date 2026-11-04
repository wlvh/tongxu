import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular} from './repair-workspace.js';
import {exactKeys,isAuthorityDigest,scopeBodyHash,type ActionRequest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {parseReceiverPlan,runReception,reconcileReception,type ReceiverPlan} from './receiver.js';
import {sourceTick} from './event-tick.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {prepareResourceRequest} from './resource-claims.js';
import {resourceRequestHash,type ResourceRequest} from './resource-contract.js';
type Row=Record<string,any>;
type Source={id:string;store:string;item:string};
type Entry={id:string;source:string;template:{path:string;sha256:string};authorization:string;budgets:Array<{ledgerId:string;resourceRef:string;unit:string;quantity:number}>};

/** The source checker still never dispatches a model. This one explicit
 * registered action prepares an exact current packet for the existing governed
 * receiver and reads the same operation; it is not a background scheduler. */
export class ReceptionControls{
  private active=new Map<string,Promise<unknown>>();private problems=new Map<string,string>();private accepting=true;
  private constructor(private path:string,private sha256:string,private entries:Array<{entry:Entry;source:Source;plan:ReceiverPlan}>){ }
  static async load(path:string,sha256:string,sources:Source[],selected?:ReadonlySet<string>){
    const raw=await regular(path,128*1024),p=JSON.parse(raw.toString());
    if(hash(raw)!==sha256||!exactKeys(p,['schemaVersion','kind','entries'])||p.schemaVersion!==1||p.kind!=='tongxu-reception-controls'||!Array.isArray(p.entries)||p.entries.length>32)throw new Error('reception_controls_invalid');
    const entries=[];
    for(const e of p.entries as Entry[]){
      if(!exactKeys(e,['id','source','template','authorization','budgets'])||!messageId(e.id)||!sources.some(s=>s.id===e.source)||!exactKeys(e.template,['path','sha256'])||!messagePath(e.template.path)||!isAuthorityDigest(e.template.sha256)||!isAuthorityDigest(e.authorization)||!Array.isArray(e.budgets)||e.budgets.length>16||e.budgets.some(b=>!exactKeys(b,['ledgerId','resourceRef','unit','quantity'])||typeof b.ledgerId!=='string'||typeof b.resourceRef!=='string'||typeof b.unit!=='string'||!Number.isSafeInteger(b.quantity)||b.quantity<1))throw new Error('reception_control_entry_invalid');
      if(selected&&!selected.has(e.source))continue;
      const source=sources.find(s=>s.id===e.source)!,bytes=await regular(e.template.path),plan=parseReceiverPlan(bytes);
      if(hash(bytes)!==e.template.sha256||plan.store!==source.store||plan.item!==source.item||plan.governance)throw new Error('reception_control_template_binding_invalid');
      entries.push({entry:e,source,plan});
    }
    if(new Set(entries.map(e=>e.entry.id)).size!==entries.length)throw new Error('reception_control_duplicate_id');
    return new ReceptionControls(path,sha256,entries);
  }
  private selected(id:string){const value=this.entries.find(e=>e.entry.id===id);if(!value)throw new Error('reception_source_not_selected');return value;}
  private async fixed(){if(hash(await regular(this.path,128*1024))!==this.sha256)throw new Error('reception_control_catalog_changed');}
  async state(){return Promise.all(this.entries.map(async f=>{
    try{const snapshot=await QueueStore.observe(f.source.store,[f.source.item]),item=snapshot.items.find((i:Row)=>i.id===f.source.item);if(!item)throw new Error('reception_source_not_found');
      const operation=snapshot.operations.filter((o:Row)=>o.item===f.source.item&&o.packet===item.currentPacket).at(-1),receiver=operation?.result?.receiver;
      return {id:f.entry.id,source:f.source.id,available:true,investmentStopped:snapshot.controls.some((c:Row)=>c.scope===item.context.scope.id&&c.kind==='investment'&&c.stopped),executionKind:f.plan.executionKind,packet:item.currentPacket,candidate:item.candidate,eventSource:item.eventSource,phase:receiver?.phase??'not_started',operation:operation?.id??null,currentMaterialMatches:receiver?.currentMaterialMatches??null,verdict:receiver?.judgment?.verdict??null,controllerActive:this.active.has(f.entry.id),problem:this.problems.get(f.entry.id)??null};
    }catch(error){return {id:f.entry.id,source:f.source.id,available:false,problem:error instanceof Error?error.message:'reception_unavailable',controllerActive:this.active.has(f.entry.id)};}
  }));}
  async check(id:string){if(!this.accepting)throw new Error('reception_controls_closing');await this.fixed();const f=this.selected(id);const result=await sourceTick(f.source.store);return {...result,newModelInputs:0,meaning:'source_observation_not_reception'};}
  async begin(id:string,body:Row){
    if(!this.accepting||!exactKeys(body,['expectedPacket'])||!Number.isSafeInteger(body.expectedPacket)||body.expectedPacket<1)throw new Error('reception_request_invalid');
    await this.fixed();if(!this.accepting)throw new Error('reception_controls_closing');this.selected(id);if(this.active.has(id))return {id,controllerActive:true,duplicate:true};
    this.problems.delete(id);const work=this.execute(id,body.expectedPacket);this.active.set(id,work);work.catch(error=>this.problems.set(id,error instanceof Error?error.message:'reception_unknown')).finally(()=>this.active.delete(id));return {id,controllerActive:true,registrationIsNotDispatch:true};
  }
  private async execute(id:string,expectedPacket:number){
    const f=this.selected(id);await this.fixed();await sourceTick(f.source.store);
    const q=await QueueStore.open(f.source.store);try{
      const snapshot=q.status(),item=snapshot.items.find((i:Row)=>i.id===f.source.item);if(!item||item.currentPacket!==expectedPacket)throw new Error('reception_material_changed_refresh_required');
      const original=snapshot.operations.find((o:Row)=>o.item===f.source.item&&o.packet===expectedPacket);
      if(original?.result?.receiver)return await reconcileReception(f.source.store,original.id);
      const a=q.authority(),profile=a.configuration().profile,observations:OwnerObservation[]=[],directory=join(f.source.store,'normal-reception-sources',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
      for(const ref of a.sourceRequests(f.entry.authorization))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(directory,ref.proposalSha256)));
      const adoption=a.inspectRecordedDecision(f.entry.authorization).proposal;if(!('adoption' in adoption))throw new Error('reception_exact_authorization_required');
      const scope=a.inspectRecordedDecision(adoption.adoption).proposal;if(scope.kind!=='adopt_scope')throw new Error('reception_scope_adoption_required');
      const intent='normal-reception-'+hash(canonical([this.sha256,f.source.item,expectedPacket])).slice(0,44),candidate=item.candidate;
      const action:ActionRequest={schemaVersion:1,scopeId:item.context.scope.id,scopeVersion:item.context.scope.version,scopeBodySha256:scopeBodyHash(scope.body),repository:candidate.repository,target:candidate.targetRef,action:'receive',item:f.source.item,candidate:{H:candidate.H,B:candidate.B,subjectSha256:null},paths:[],resourceRefs:f.entry.budgets.map(b=>b.resourceRef)};
      if(q.status().items.find((i:Row)=>i.id===f.source.item)?.currentPacket!==expectedPacket)throw new Error('reception_material_changed_refresh_required');
      a.reserveAction(intent,action,'receiver',f.entry.authorization,observations);
      const begun=q.begin(f.source.item,'normal-independent-reception');if(begun.blocked)throw new Error(begun.blocked.join(', '));
      const current=q.receiverState(begun.operation);if(current.currentPacket!==expectedPacket)throw new Error('reception_material_changed_refresh_required');if(current.receiver)return await reconcileReception(f.source.store,begun.operation);q.evaluate(begun.operation);
      const requests:ResourceRequest[]=f.entry.budgets.map(b=>({schemaVersion:1,ledgerId:b.ledgerId,repository:candidate.repository,operation:begun.operation,authorityIntent:intent,resourceRef:b.resourceRef,unit:b.unit,quantity:b.quantity,role:'receiver',actionSha256:hash(canonical(action))}));
      const plan:ReceiverPlan={...f.plan,governance:{authorityIntent:intent,resourceRequests:requests.map(resourceRequestHash)}};
      const bytes=Buffer.from(canonical(plan)),planPath=join(f.source.store,'normal-reception-'+begun.operation+'.json');
      try{await writeFile(planPath,bytes,{flag:'wx',mode:0o600});}catch(error:any){if(error.code!=='EEXIST'||hash(await regular(planPath))!==hash(bytes))throw new Error('reception_original_plan_changed');}
      a.enableGovernedReceiver();
      for(const request of requests)await prepareResourceRequest(f.source.store,Buffer.from(canonical(request)),'receiver');
      observations.length=0;const latest=join(directory,'current');await mkdir(latest,{mode:0o700});
      for(const ref of a.sourceRequests(f.entry.authorization))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(latest,ref.proposalSha256)));
      q.receiverResourceAdmission(begun.operation,bytes,observations);
      return await runReception(planPath);
    }finally{q.close();}
  }
  async drain(){this.accepting=false;await Promise.allSettled(this.active.values());}
}
