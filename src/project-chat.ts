import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {save} from './live-process.js';
import {BoundedCodexSession,readRepairSession,secretarySchema} from './repair-native.js';
import {assembleRolePrompt} from './role-prompts.js';
import {chatId,validateProjectChatConfig,projectChatInstructions,projectChatTools,type ProjectChatConfig} from './project-chat-contract.js';
import {exactKeys} from './authority-contract.js';
import type {GitHubProjects} from './github-projects.js';
import type {Candidate} from './live-codex.js';

export type ProjectChatScope=ReturnType<GitHubProjects['selection']>;
type Row=Record<string,any>;
type Reader=(scope:ProjectChatScope,tool:string,args:Row)=>Promise<unknown>;
const now=()=>new Date().toISOString();
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_:,-]+$/.test(e.message)?e.message:'project_chat_execution_incomplete';
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}};
const activePhase=(phase:string)=>['registered','running','unknown'].includes(phase);
type Active={promise:Promise<void>;session?:BoundedCodexSession;stop:boolean};

/** One durable conversation history. Existing task queues and native capture
 * contracts remain authoritative; opening or replaying a chat never sends. */
export class ProjectChat{
  private active=new Map<string,Active>();private accepting=true;private owner=randomUUID();
  private constructor(private config:ProjectChatConfig,private db:DatabaseSync,private read:Reader,private verify:(scope:ProjectChatScope)=>Promise<void>){}
  static async open(config:ProjectChatConfig,read:Reader,verify:(scope:ProjectChatScope)=>Promise<void>){
    validateProjectChatConfig(config);if(!await exists(config.root))await privateDirectory(config.root,true);else await privateDirectory(config.root,false);
    const path=join(config.root,'conversations.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(path,64*1024*1024);
    const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,account INTEGER NOT NULL,repository INTEGER NOT NULL,node_id TEXT NOT NULL,name TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversations(id),parent TEXT,question TEXT NOT NULL,phase TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,pid INTEGER,owner TEXT,problem TEXT,report TEXT,receipt TEXT);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation,created_at,id);`);
    return new ProjectChat(structuredClone(config),db,read,verify);
  }
  private transaction<T>(fn:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private conversationRow(scope:ProjectChatScope,id:string){
    if(!chatId(id))throw new Error('project_chat_id_invalid');const c=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row|undefined;
    if(!c||c.account!==scope.account.id||c.repository!==scope.repository.id||c.node_id!==scope.repository.nodeId)throw new Error('project_chat_outside_project');return c;
  }
  private rows(id:string){return this.db.prepare('SELECT * FROM messages WHERE conversation=? ORDER BY rowid').all(id) as Row[];}
  private directory(id:string){if(!chatId(id))throw new Error('project_chat_id_invalid');return join(this.config.root,id);}
  private async recover(row:Row){
    if(!activePhase(row.phase)||this.active.has(row.id)||row.owner!==this.owner&&row.pid&&alive(row.pid))return;
    try{await this.complete(row.id);return;}catch{}
    const native=join(this.directory(row.id),'native');let ended=false,unstarted=false;
    try{
      // The durable running transition precedes every native launch. Only a
      // still-registered row with no native stage proves launch never began.
      if(row.phase==='registered'&&!await exists(native)){ended=true;unstarted=true;}
      else{const process=JSON.parse((await regular(join(native,'process.json'),4096)).toString());
        if(!exactKeys(process,['pid','status'])||!Number.isSafeInteger(process.pid)||process.pid<=0||process.status!=='spawn_attempted')throw new Error('project_chat_process_unknown');
        ended=!alive(process.pid);
      }
    }catch{} // Missing, malformed or inaccessible identity remains unknown.
    if(!ended){this.db.prepare("UPDATE messages SET phase='unknown',problem='project_chat_process_unknown' WHERE id=? AND phase IN ('registered','running','unknown')").run(row.id);return;}
    this.db.prepare("UPDATE messages SET phase='interrupted',finished_at=?,problem=? WHERE id=? AND phase IN ('registered','running','unknown')").run(now(),unstarted?'project_chat_controller_ended_before_launch':'project_chat_original_incomplete',row.id);
  }
  async list(scope:ProjectChatScope){
    const conversations=this.db.prepare('SELECT * FROM conversations WHERE account=? AND repository=? AND node_id=? ORDER BY created_at DESC,id DESC LIMIT 128').all(scope.account.id,scope.repository.id,scope.repository.nodeId) as Row[];
    for(const c of conversations)for(const row of this.rows(c.id))await this.recover(row);
    const busy=conversations.flatMap(c=>this.rows(c.id).filter(r=>activePhase(r.phase)).map(r=>({conversationId:c.id,requestId:r.id,status:r.phase})));
    return {available:true,executionKind:this.config.executionKind,project:scope.repository,busy,conversations:conversations.map(c=>({id:c.id,title:c.title,createdAt:c.created_at})),newModelInputs:0};
  }
  async conversation(scope:ProjectChatScope,id:string){
    const c=this.conversationRow(scope,id);for(const row of this.rows(id))await this.recover(row);
    const messages=[];for(const r of this.rows(id)){let answer=r.report,receipt=r.receipt?JSON.parse(r.receipt):null,status=r.phase,problem=r.problem;if(status==='completed')try{const checked=await this.verified(r.id);if(checked.report!==answer||canonical(checked.receipt)!==canonical(receipt))throw new Error('project_chat_saved_answer_changed');}catch(e){answer=null;receipt=null;status='unavailable';problem=reason(e);}messages.push({id:r.id,parent:r.parent,question:r.question,status,createdAt:r.created_at,finishedAt:r.finished_at,problem,answer,receipt,active:activePhase(r.phase)&&!!(this.active.has(r.id)||r.phase!=='unknown'&&r.pid&&alive(r.pid)),owned:this.active.has(r.id)});}
    return {id:c.id,title:c.title,project:scope.repository,messages,newModelInputs:0,continuation:'saved_history_in_new_native_context'};
  }
  async begin(scope:ProjectChatScope,body:unknown){
    if(!this.accepting)throw new Error('project_chat_closing');const b=body as Row;
    if(!exactKeys(b,['conversationId','requestId','parent','question'])||!chatId(b.conversationId)||!chatId(b.requestId)||!(b.parent===null||chatId(b.parent))||typeof b.question!=='string'||!b.question.trim()||b.question.length>8192||b.question.includes('\0'))throw new Error('project_chat_question_invalid');
    const old=this.db.prepare('SELECT * FROM messages WHERE id=?').get(b.requestId) as Row|undefined;
    if(old){this.conversationRow(scope,old.conversation);if(old.conversation!==b.conversationId||old.question!==b.question||old.parent!==b.parent)throw new Error('project_chat_request_changed');return {conversationId:b.conversationId,requestId:b.requestId,duplicate:true,newModelInputs:0};}
    const c=this.db.prepare('SELECT id FROM conversations WHERE id=?').get(b.conversationId);
    if(c){this.conversationRow(scope,b.conversationId);for(const row of this.rows(b.conversationId))await this.recover(row);}
    const projectRows=this.db.prepare("SELECT messages.* FROM messages JOIN conversations ON conversations.id=messages.conversation WHERE conversations.account=? AND conversations.repository=? AND messages.phase IN ('registered','running','unknown')").all(scope.account.id,scope.repository.id) as Row[];for(const row of projectRows)await this.recover(row);
    const busy=this.db.prepare("SELECT messages.id FROM messages JOIN conversations ON conversations.id=messages.conversation WHERE conversations.account=? AND conversations.repository=? AND messages.phase IN ('registered','running','unknown') LIMIT 1").get(scope.account.id,scope.repository.id);if(busy)throw new Error('project_chat_reply_pending');
    const history=this.rows(b.conversationId),last=history.at(-1);
    for(const row of history)if(row.phase==='completed'){const original=await this.verified(row.id);if(original.report!==row.report)throw new Error('project_chat_saved_answer_changed');}
    if((last?.id??null)!==b.parent)throw new Error('project_chat_parent_changed');if(last&&activePhase(last.phase))throw new Error('project_chat_reply_pending');
    if(history.length>=64||Buffer.byteLength(canonical(history.map(r=>({question:r.question,answer:r.report,status:r.phase}))))>192*1024)throw new Error('project_chat_context_limit');
    this.transaction(()=>{
      if(this.db.prepare("SELECT messages.id FROM messages JOIN conversations ON conversations.id=messages.conversation WHERE conversations.account=? AND conversations.repository=? AND messages.phase IN ('registered','running','unknown') LIMIT 1").get(scope.account.id,scope.repository.id))throw new Error('project_chat_reply_pending');
      if(!c){const n=this.db.prepare('SELECT count(*) n FROM conversations WHERE account=? AND repository=?').get(scope.account.id,scope.repository.id) as Row;if(n.n>=128)throw new Error('project_chat_history_limit');this.db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?)').run(b.conversationId,scope.account.id,scope.repository.id,scope.repository.nodeId,scope.repository.fullName,b.question.slice(0,80),now());}
      const latest=this.rows(b.conversationId).at(-1);if((latest?.id??null)!==b.parent||latest&&activePhase(latest.phase))throw new Error('project_chat_parent_changed');
      this.db.prepare("INSERT INTO messages(id,conversation,parent,question,phase,created_at,pid,owner) VALUES (?,?,?,?,'registered',?,?,?)").run(b.requestId,b.conversationId,b.parent,b.question,now(),process.pid,this.owner);
    });
    const active:Active={promise:Promise.resolve(),stop:false};this.active.set(b.requestId,active);
    active.promise=this.execute(scope,b.requestId,active).catch(()=>{/* The durable registration stays unresolved if recording the failure also fails. */}).finally(()=>this.active.delete(b.requestId));
    return {conversationId:b.conversationId,requestId:b.requestId,duplicate:false,registered:true,newModelInputs:null};
  }
  private async execute(scope:ProjectChatScope,id:string,active:Active){
    const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row,directory=this.directory(id),native=join(directory,'native');
    try{
      await privateDirectory(directory,true);const initial={kind:'project_context',observedAt:now(),data:{account:scope.account,repository:scope.repository}},initialId=hash(canonical(initial));
      const observations:Array<{id:string;tool:string;observation:unknown}>=[{id:initialId,tool:'initial_project_context',observation:initial}];save(join(directory,'observations.json'),observations);
      const history=this.rows(row.conversation).filter(r=>r.id!==id).map(r=>({requestId:r.id,question:r.question,status:r.phase,answer:r.report}));
      const candidate:Candidate={kind:'project-conversation',repository:scope.repository.fullName,pr:null,projectId:scope.repository.id,accountId:scope.account.id,conversationId:row.conversation,H:scope.repository.defaultHead??'',B:scope.repository.defaultHead??'',target:scope.repository.defaultHead?scope.repository.defaultBranch??'':'',sourceSha256:initialId};
      const prompt=await assembleRolePrompt('secretary',projectChatInstructions),input={kind:'project_secretary_question',candidate,initialObservation:{observationId:initialId,...initial},conversation:history,question:row.question};
      save(join(directory,'request.json'),{requestId:id,conversationId:row.conversation,candidate,input,system:prompt.system,config:this.config,historyTransfer:'complete_saved_history_new_native_context'});
      let bytes=0,calls=0;const check=async()=>{if(active.stop||!this.accepting)throw new Error('project_chat_stopped');await this.verify(scope);if(active.stop||!this.accepting)throw new Error('project_chat_stopped');};
      const gate={check,call:async(p:{tool:string;arguments:Row;callId:string},before?:()=>void)=>{
        await check();before?.();if(++calls>24||!projectChatTools.some(t=>t.name===p.tool))throw new Error('project_chat_tool_limit');
        const data=await this.read(scope,p.tool,p.arguments),observation={tool:p.tool,arguments:p.arguments,observedAt:now(),data},raw=canonical(observation);bytes+=Buffer.byteLength(raw);
        if(Buffer.byteLength(raw)>128*1024||bytes>512*1024)throw new Error('project_chat_material_limit');await check();before?.();const observationId=hash(raw);observations.push({id:observationId,tool:p.tool,observation});save(join(directory,'observations.json'),observations);
        return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({observationId,...observation})}]};
      }};
      await check();
      // Account/read and ordinary rate-limit observations are captured by the
      // native executor immediately before input. No stale evidence is dated anew.
      active.session=await BoundedCodexSession.start({executable:this.config.codexExecutable,directory:native,operation:directory,candidate,role:'secretary',projectSecretary:true,system:prompt.system,inputManifestSha256:hash(canonical(input)),scopeSource:'User-selected GitHub repository '+scope.repository.id,arrangementSource:'Project work secretary; read only; saved history passed into a new native context',disabledMcpServers:this.config.disabledMcpServers,allowedInstructionSources:this.config.allowedInstructionSources,timeoutMs:this.config.timeoutMs,executionKind:this.config.executionKind,beforeTurn:check,gate,control:{beforeControl:async request=>{if(!active.stop||request.action!=='interrupt'||request.id!=='stop-'+id)throw new Error('project_chat_control_not_allowed');},beforeControlSendSync:(request,send)=>{if(!active.stop||request.action!=='interrupt'||request.id!=='stop-'+id)throw new Error('project_chat_control_not_allowed');send();}}});
      await check();this.db.prepare("UPDATE messages SET phase='running' WHERE id=?").run(id);await active.session.turn(canonical(input),candidate,secretarySchema);await active.session.close();await this.complete(id);
    }catch(e){
      await active.session?.close().catch(()=>{});try{await this.complete(id);return;}catch{}
      const rowPhase=(this.db.prepare('SELECT phase FROM messages WHERE id=?').get(id) as Row).phase;
      const unstarted=rowPhase==='registered'&&!await exists(native);let ended=unstarted;
      if(!ended)try{const original=JSON.parse((await regular(join(native,'process.json'),4096)).toString());ended=exactKeys(original,['pid','status'])&&Number.isSafeInteger(original.pid)&&original.pid>0&&original.status==='spawn_attempted'&&!alive(original.pid);}catch{ended=false;}
      const phase=!ended?'unknown':active.stop?'interrupted':'failed';
      this.db.prepare('UPDATE messages SET phase=?,problem=?,finished_at=? WHERE id=?').run(phase,reason(e),now(),id);
      if(await exists(directory))save(join(directory,'outcome.json'),{status:phase,nativeProcessState:unstarted?'not_started':ended?'ended':'unknown',invocationOutcome:active.stop?'stop_requested':'error',reason:reason(e),automaticResend:false});
    }
  }
  private async verified(id:string){
    const directory=this.directory(id),request=JSON.parse((await regular(join(directory,'request.json'),1024*1024)).toString()),parsed=await readRepairSession(join(directory,'native'));
    if(parsed.binding.run!==directory||parsed.binding.role!=='secretary'||canonical(parsed.binding.candidate)!==canonical(request.candidate)||parsed.binding.inputManifestSha256!==hash(canonical(request.input))||parsed.turns.length!==1||!parsed.turns[0]?.final)throw new Error('project_chat_original_mismatch');
    const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row;if(!row||request.requestId!==id||request.conversationId!==row.conversation||request.input.question!==row.question||request.candidate.conversationId!==row.conversation)throw new Error('project_chat_request_changed');
    const c=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.conversation) as Row;if(request.candidate.projectId!==c.repository||request.candidate.accountId!==c.account)throw new Error('project_chat_original_mismatch');
    const answer=JSON.parse(parsed.turns[0].final.text),observations=JSON.parse((await regular(join(directory,'observations.json'),1024*1024)).toString()) as Row[];
    if(!exactKeys(answer,['candidateH','report','observationIds'])||answer.candidateH!==request.candidate.H||typeof answer.report!=='string'||!answer.report.trim()||Buffer.byteLength(answer.report)>256*1024||!Array.isArray(answer.observationIds)||!answer.observationIds.length||answer.observationIds.some((id:unknown)=>!observations.some(o=>o.id===id)))throw new Error('project_chat_answer_unverified');
    const pairs=JSON.parse((await regular(join(directory,'native','reconciled-tools.json'),2*1024*1024)).toString()) as Row[];
    for(const o of observations){if(hash(canonical(o.observation))!==o.id)throw new Error('project_chat_observation_changed');if(o.tool==='initial_project_context'){const {observationId,...initial}=request.input.initialObservation;if(o.id!==observationId||canonical(o.observation)!==canonical(initial))throw new Error('project_chat_observation_changed');}else if(!pairs.some(p=>p.response?.result?.contentItems?.[0]?.text===JSON.stringify({observationId:o.id,...o.observation})))throw new Error('project_chat_observation_changed');}
    const receipt={sessionId:parsed.binding.sessionId,turnId:parsed.binding.turnIds[0],executionKind:parsed.binding.sourceKind,reportSha256:hash(answer.report),observationIds:answer.observationIds,observations:observations.filter(o=>answer.observationIds.includes(o.id)),continuation:'saved_history_in_new_native_context',modelExplanationIsNotApproval:true};
    return {report:answer.report,receipt};
  }
  private async complete(id:string){const result=await this.verified(id);save(join(this.directory(id),'answer.json'),result);this.db.prepare("UPDATE messages SET phase='completed',finished_at=COALESCE(finished_at,?),problem=NULL,report=?,receipt=? WHERE id=?").run(now(),result.report,canonical(result.receipt),id);}

  private async stopNative(id:string,active:Active){
    const state=active.session?.controlState();if(state?.currentTurnActive)await active.session!.control({id:'stop-'+id,action:'interrupt',threadId:state.threadId!,sessionId:state.sessionId!,turnId:state.turnId!,input:null}).catch(()=>{});
    await active.session?.close();
  }
  async stopSelected(accountId:number,repositoryId:number,id:string){
    if(!chatId(id)||!Number.isSafeInteger(accountId)||!Number.isSafeInteger(repositoryId))throw new Error('project_chat_id_invalid');
    const row=this.db.prepare('SELECT messages.*,conversations.account,conversations.repository FROM messages JOIN conversations ON conversations.id=messages.conversation WHERE messages.id=?').get(id) as Row|undefined;
    if(!row||row.account!==accountId||row.repository!==repositoryId)throw new Error('project_chat_outside_project');
    const active=this.active.get(id);if(!active){await this.recover(row);return {requestId:id,stopRequested:false,newModelInputs:0};}
    active.stop=true;this.db.prepare("UPDATE messages SET problem='project_chat_user_stop_requested' WHERE id=?").run(id);
    if(await exists(this.directory(id)))save(join(this.directory(id),'stop-request.json'),{at:now(),requestId:id,source:'explicit_user_stop'});
    await this.stopNative(id,active);return {requestId:id,stopRequested:true,newModelInputs:0};
  }
  async drain(){this.accepting=false;for(const a of this.active.values())a.stop=true;await Promise.allSettled([...this.active].map(([id,a])=>this.stopNative(id,a)));await Promise.allSettled([...this.active.values()].map(a=>a.promise));this.db.close();}

}
