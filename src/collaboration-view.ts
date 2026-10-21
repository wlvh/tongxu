import type {DatabaseSync} from 'node:sqlite';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';

type Row=Record<string,any>;
type Sources={item:(id:string)=>Row;message:(run:string)=>Row;coordination:(id:string)=>Row;resource:(id:string)=>Row;settled:(id:string)=>boolean;messageResource:(run:string)=>Row;repair:(operation:string)=>Row};
const safe=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'original_record_unavailable';
/** Selected-task facts from one readonly SQLite snapshot. No provider, model,
 * filesystem execution, authorization refresh or new event is available here. */
export class CollaborationView {
  constructor(private db:DatabaseSync,private sources:Sources){}
  private bytes(sha:string){const row=this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(sha) as Row,b=row&&Buffer.from(row.bytes);if(!b||hash(b)!==sha)throw new Error('collaboration_original_changed');return b;}
  private events(kind:string,item:string){return this.db.prepare("SELECT DISTINCT e.object FROM events e, json_each(json_extract(e.data,'$.value.bindings')) b WHERE e.kind=? AND json_extract(b.value,'$.item')=? ORDER BY e.id LIMIT 65").all(kind,item) as Row[];}
  private current(binding:Row,item:string){const now=this.sources.item(item);return now.current===true&&binding.packet===now.packet&&binding.fingerprint===now.fingerprint&&canonical(binding.context.scope)===canonical(now.context.scope);}
  private resource(id:string){const r=this.sources.resource(id);return {id,state:r.state,claimId:r.claim?.id??null,outcomeSha256:r.outcome?.outcomeSha256??null,providerOutcomeSha256:r.claim?.outcomeSha256??null,settled:this.sources.settled(id),claimAttempts:r.claimAttempts,resultAttempts:r.resultAttempts,executionKind:r.executionKind,providerRechecked:false};}
  private arrangement(run:string){
    const links=this.db.prepare("SELECT object FROM events WHERE kind='coordination_messages_bound' AND json_extract(data,'$.value.run')=?").all(run) as Row[];
    if(!links.length)return null;if(links.length!==1)throw new Error('coordination_message_binding_ambiguous');
    const id=links[0]!.object.slice(13),c=this.sources.coordination(id);
    const selection=this.db.prepare("SELECT data FROM events WHERE object=? AND kind='coordination_dispatch_selected' AND json_extract(data,'$.value.run')=?").get('coordination:'+id,run) as Row|undefined;
    let selected=true;if(selection){const old=JSON.parse(selection.data).value,latest=this.db.prepare("SELECT data FROM events WHERE object=? AND kind='coordination_dispatch_selected' AND json_extract(data,'$.value.task')=? AND json_extract(data,'$.value.purpose')=? ORDER BY id DESC LIMIT 1").get('coordination:'+id,old.task,old.purpose) as Row;selected=JSON.parse(latest.data).value.run===run;}
    return {id,revision:c.plan.revision,current:c.current&&selected};
  }
  private selected(run:string,item:string){const m=this.sources.message(run),participants=m.plan.participants.filter((p:Row)=>p.item===item);if(!participants.length)throw new Error('report_not_found');return {m,participants,ids:new Set(participants.map((p:Row)=>p.id))};}
  messageReport(item:string,run:string,id:string){
    const {m,participants,ids}=this.selected(run,item),message=m.messages.find((x:Row)=>x.id===id&&ids.has(x.to));
    if(!message?.reply||typeof message.reply.finalText!=='string'||hash(message.reply.finalText)!==message.reply.finalSha256)throw new Error('report_not_found');
    const runtime=m.runtimes.find((x:Row)=>x.participant===message.to),arrangement=this.arrangement(run),current=participants.every((p:Row)=>this.current(m.registration.bindings[p.id],item))&&arrangement?.current!==false;
    return {item,run,message:id,report:message.reply.finalText,reportSha256:message.reply.finalSha256,reportText:message.reply.report,reportTextSha256:hash(message.reply.report),state:message.state,current,executionKind:m.plan.executionKind,sessionId:message.reply.sessionId,turnId:message.reply.turnId??null,completeCapture:runtime?.captureVerification?.proof.successfulCapture===true,consumptionConfirmed:message.reply.reportedConsumption===true,formalJudgmentGranted:false};
  }
  state(item:string){
    this.sources.item(item);const messageRows=this.events('message_registered',item),coordRows=this.events('coordination_registered',item);if(messageRows.length>64||coordRows.length>64)throw new Error('collaboration_history_limit');
    const messages=messageRows.map(row=>{const run=row.object.slice(9);try{
      const {m,participants,ids}=this.selected(run,item),arrangement=this.arrangement(run),current=participants.every((p:Row)=>this.current(m.registration.bindings[p.id],item))&&arrangement?.current!==false;
      let resources:Row[]=[];let resourcesSettled:boolean|null=m.plan.resourceBudget?false:null;
      if(m.plan.resourceBudget){try{const binding=this.sources.messageResource(run);resources=binding.resourceRequests.map((id:string)=>this.resource(id));resourcesSettled=binding.phase==='returned'&&resources.length===m.plan.resourceBudget.length&&resources.every(r=>r.settled);}catch(e){resources=[{state:'unknown',settled:false,error:safe(e)}];}}
      return {run,available:true,current,arrangement,executionKind:m.plan.executionKind,registeredAt:m.registration.registeredAt,resources,resourcesSettled,
        participants:participants.map((p:Row)=>{const r=m.runtimes.find((r:Row)=>r.participant===p.id);return {id:p.id,tool:p.tool,role:p.role,sessionId:r?.route?.sessionId??null,threadId:r?.route?.threadId??null,started:!!r?.started,ended:!!r?.ended,completeCapture:r?.captureVerification?.proof.successfulCapture===true};}),
        messages:m.messages.filter((x:Row)=>ids.has(x.to)).map((x:Row)=>({id:x.id,to:x.to,from:x.from!==null&&ids.has(x.from)?x.from:null,fromUnselectedParticipant:x.from!==null&&!ids.has(x.from),state:x.state,sendRegistered:!!x.sent,delivered:!!x.delivery,replyRecorded:!!x.reply,reportSha256:x.reply?.finalSha256??null,consumptionConfirmed:x.reply?.reportedConsumption===true,sessionId:x.reply?.sessionId??null,turnId:x.reply?.turnId??null})),
        continuation:m.continuation?{nextRun:m.continuation.nextRun,completed:m.continuation.completed===true,nativeSessionResumed:false}:null,problemCount:m.problems.length};
    }catch(e){return {run,available:false,error:safe(e)};}});
    const coordination=coordRows.map(row=>{const id=row.object.slice(13);try{const c=this.sources.coordination(id),tasks=c.plan.tasks.filter((t:Row)=>t.item===item),ids=new Set(tasks.map((t:Row)=>t.id));return {id,available:true,revision:c.plan.revision,current:c.current,mode:c.plan.mode,
      tasks:tasks.map((t:Row)=>({id:t.id,actor:t.actor,originActor:t.originActor,dispatch:t.dispatch,originActorContactVerified:false,executionContext:'fresh_managed_context',stages:c.tasks.find((s:Row)=>s.id===t.id).stages.map((s:Row)=>({stage:s.stage,phasePrerequisitesMet:s.phasePrerequisitesMet,blockers:s.blockers,executionAuthorized:false}))})),
      shared:c.parts.filter((p:Row)=>c.plan.shared.find((s:Row)=>s.id===p.id).tasks.some((t:string)=>ids.has(t))).map((p:Row)=>({id:p.id,hash:p.hash,requiredFeedback:p.feedback.length,agreed:p.feedback.filter((f:Row)=>f.reply?.position==='agreed'&&f.reply.currentApplicable!==false).length,conflict:p.feedback.some((f:Row)=>f.reply?.position==='conflict'),unknown:p.feedback.some((f:Row)=>!f.reply||f.reply.position==='unknown'||f.reply.currentApplicable===false)})),writingPermissionGranted:false};}catch(e){return {id,available:false,error:safe(e)};}});
    const operations=this.db.prepare("SELECT id,packet FROM operations WHERE item=? AND json_type(result,'$.repair')='object' ORDER BY started_at LIMIT 65").all(item) as Row[];if(operations.length>64)throw new Error('collaboration_history_limit');
    const repairs=operations.map(o=>{try{const state=this.sources.repair(o.id),r=state.repair;let result:Row|null=null;if(r.resultSha256){result=JSON.parse(this.bytes(r.resultSha256).toString());if(canonical(result)!==canonical(r.result))throw new Error('repair_result_index_changed');this.bytes(r.evidenceSha256);}
      return {operation:o.id,available:true,currentPacket:o.packet===this.sources.item(item).packet,phase:r.phase,controllerReturned:r.controllerReturned===true,sourceJudgmentId:r.sourceJudgmentId,resultSha256:r.resultSha256??null,
        result:result?{status:result.status,beforeH:result.before?.H??null,afterH:result.after?.H??null,actualRepairPerformed:result.actualRepairPerformed===true,executionKind:result.executionKind,demonstrationFixture:result.demonstrationFixture===true,testsPassed:result.data?.tests?.passed===true,reviewVerdict:result.data?.review?.verdict??null,reviewCandidateH:result.data?.review?.candidateH??null}:null,
        resources:(r.resourceRequests??[]).map((id:string)=>this.resource(id))};}catch(e){return {operation:o.id,available:false,error:safe(e)};}});
    return {item,coordination,messages,repairs,localRecordsOnly:true,originalActorContactInferred:false,modelCallsStarted:0,providerCallsStarted:0,writingPermissionGranted:false};
  }
}
