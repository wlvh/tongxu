import {canonical} from './comparison.js';
import {hash} from './snapshot.js';

type Row=Record<string,any>;
export type OriginalTaskExecution={task:string;request:string;context:Buffer;inputs:Row[];state:Row;interrupted:boolean};

/** A per-input, lossless projection of verified task records. References point
 * into the supplied tables, not to a file the readonly role cannot open. Raw
 * envelopes and captures remain in MessageRecords and are never rewritten. */
export class TaskHistoryProjection {
  readonly executions:Record<string,Row>={};
  readonly inputs:Record<string,Row>={};
  readonly materials:Record<string,Row>={};
  private active=new Set<string>();
  constructor(private load:(run:string)=>OriginalTaskExecution,current?:{task:string;value:Row}){
    if(current){const source={task:current.task,name:'task-source',sha256:hash(canonical(current.value))};this.materials[this.id('material',source)]={source,rootField:'task'};}
  }
  private id(kind:string,source:unknown){return hash(canonical({kind,source}));}
  execution(task:string,run:string,request?:string):Row{
    const original=this.load(run);
    if(original.task!==task||request!==undefined&&original.request!==request)throw new Error('task_history_execution_identity_changed');
    const id=this.id('execution',{task,run}),ref={task,run,request:original.request,historyRef:id};
    if(this.executions[id])return ref;
    if(this.active.has(id))throw new Error('task_history_cycle');this.active.add(id);
    try{
      const s=original.state;
      this.executions[id]={task,request:original.request,run,bindings:s.registration.bindings,
        originalRoleInputs:original.inputs.map(input=>this.input(original,run,input)),
        reports:s.messages.map((m:Row)=>({id:m.id,recipient:m.sent?.recipient??null,receipt:this.report(task,run,m.id,m.reply),...(m.interruption?{state:m.state,interruption:m.interruption}:{})})),
        ...(original.interrupted?{interruptedRequestClosed:true,originalRunCompleted:false}:{}),
        nativeControlHistory:s.nativeControls??[],
        nativeSessionResumed:s.runtimes.some((r:Row)=>r.route?.nativeSessionResumed===true)};
      return ref;
    }finally{this.active.delete(id);}
  }
  private report(task:string,run:string,messageId:string,receipt:Row|null){
    if(!receipt)return null;
    const source={task,run,messageId,name:'task-report',sha256:hash(canonical(receipt))},id=this.id('material',source);
    if(!this.materials[id])this.materials[id]={source,value:receipt};
    return {...source,historyRef:id};
  }
  sender(value:Row|null):Row|null{
    if(!value)return null;
    // Read the exact original capture, without requiring an old report to be
    // current or importing the sender's unrelated input history.
    const original=this.load(value.run),s=original.state,m=s.messages.find((m:Row)=>m.id===value.messageId),p=s.plan.participants.find((p:Row)=>p.id===m?.to),r=s.runtimes.find((r:Row)=>r.participant===p?.id);
    if(original.task!==value.task||p?.item!==value.task||m?.state!=='Reply'||!m.reply?.reportedConsumption||r?.captureVerification?.proof.successfulCapture!==true||s.registration.bindings[p?.id]?.fingerprint!==value.sourceSha256||canonical(r.route)!==canonical(value.route))throw new Error('task_history_sender_identity_changed');
    const reply=this.report(value.task,value.run,value.messageId,m.reply);
    if(canonical(value.reply)!==canonical(m.reply)&&canonical(value.reply)!==canonical(reply))throw new Error('task_history_sender_reply_changed');
    return {...value,reply};
  }
  ownerFeedback(value:Row|null,oldProjection?:Row):Row|null{
    if(!value)return null;
    if(value.kind!=='tongxu-original-implementation-owner-feedback'||!value.originalTarget?.task||!value.originalTarget?.operation||!value.originalResultSha256)throw new Error('task_history_owner_feedback_format_unknown');
    let report=value.originalReport;
    if(report?.historyRef){if(report.task!==value.originalTarget.task||report.operation!==value.originalTarget.operation||report.request!==value.originalTarget.requestId||report.resultSha256!==value.originalResultSha256||report.name!=='original-implementation-report')throw new Error('task_history_owner_feedback_original_changed');const entry=oldProjection?.materials?.[report.historyRef];if(!entry||canonical(entry.source)!==canonical(Object.fromEntries(Object.entries(report).filter(([k])=>k!=='historyRef')))||hash(canonical(entry.value))!==report.sha256)throw new Error('task_history_owner_feedback_original_changed');report=entry.value;}
    if(!report||typeof report!=='object'||Array.isArray(report))throw new Error('task_history_owner_feedback_format_unknown');
    const source={task:value.originalTarget.task,operation:value.originalTarget.operation,request:value.originalTarget.requestId,name:'original-implementation-report',resultSha256:value.originalResultSha256,sha256:hash(canonical(report))},id=this.id('material',source);
    if(!this.materials[id])this.materials[id]={source,value:report};
    return {...value,originalReport:{...source,historyRef:id}};
  }
  private input(original:OriginalTaskExecution,run:string,input:Row){
    const sent=original.state.messages.find((m:Row)=>m.id===input.messageId)?.sent,sha256=hash(canonical(input));
    if(input.run!==run||!sent||sent.inputSha256!==sha256)throw new Error('task_history_input_identity_changed');
    const source={task:original.task,run,messageId:input.messageId,sha256},id=this.id('input',source);
    if(!this.inputs[id])this.inputs[id]={source,value:{...input,material:input.material.map((material:Row)=>{
      if(typeof material.text!=='string'||hash(Buffer.from(material.text))!==material.sha256)throw new Error('task_history_material_changed');
      const source={task:original.task,name:material.name,sha256:material.sha256},key=this.id('material',source);
      if(!this.materials[key]){
        if(material.name==='task-owner-context.json'){
          if(material.sha256!==hash(original.context)||material.text!==original.context.toString())throw new Error('task_history_generated_context_changed');
          const context=JSON.parse(material.text);
          this.materials[key]={source,value:this.context(context,original.task)};
        }else this.materials[key]={source,value:material};
      }
      return {name:material.name,sha256:material.sha256,historyRef:key};
    })}};
    return {...source,historyRef:id};
  }
  scope(value:Row|null):Row|null{
    if(!value)return null;
    if(value.kind!=='tongxu-task-scope-followup-context')throw new Error('task_history_scope_format_unknown');
    const latest=value.latestOriginal;
    return {...value,latestOriginal:latest?{
      task:latest.task,request:latest.request,run:latest.run,phase:latest.phase,
      ...this.execution(latest.task,latest.run,latest.request)
    }:null};
  }
  private context(value:Row,task:string):Row{
    if(![1,2].includes(value.schemaVersion)||value.kind!=='tongxu-task-owner-context'||value.task?.item!==task||!Array.isArray(value.previousExecutions))throw new Error('task_history_context_format_unknown');
    const {historyProjection,previousExecutions,scopeContinuation,sender,ownerFeedback,...rest}=value;
    // Only the selected, hash-checked task material is opened. A user question
    // or report containing JSON is an opaque string throughout this class.
    const source={task,name:'task-source',sha256:hash(canonical(value.task))},id=this.id('material',source);
    if(!this.materials[id])this.materials[id]={source,value:value.task};
    return {...rest,task:{item:task,historyRef:id},sender:this.sender(sender),previousExecutions:previousExecutions.map((e:Row)=>this.execution(e.task??task,e.run,e.request)),...(ownerFeedback?{ownerFeedback:this.ownerFeedback(ownerFeedback,historyProjection)}:{}),
      ...(scopeContinuation?{scopeContinuation:this.scope(scopeContinuation)}:{})};
  }
  value(){return {schemaVersion:1,kind:'tongxu-task-history-projection',executions:this.executions,inputs:this.inputs,materials:this.materials};}
}
