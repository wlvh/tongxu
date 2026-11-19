import {DatabaseSync} from 'node:sqlite';
import {renameSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {save} from './live-process.js';
import {BoundedCodexSession,readRepairSession,projectSecretarySchema,isSecretaryOutputSchema} from './repair-native.js';
import {assembleRolePrompt} from './role-prompts.js';
import {chatId,validateProjectChatConfig,projectChatInstructionsFor,projectChatToolsFor,projectChatToolLimit,projectWorkTarget,type ProjectWorkTarget,type ProjectWorkOrigin,type ProjectChatConfig} from './project-chat-contract.js';
import {exactKeys} from './authority-contract.js';
import type {GitHubProjects} from './github-projects.js';
import type {Candidate} from './live-codex.js';
import {currentAIChoice,currentAIPreferences,withAIPreferences,type AIPreferenceSnapshot,type AIRuntimeChoice} from './ai-settings.js';
import {modelChoice,checkCodexSelected,capturedCodexModels,codexTurnChoice} from './ai-execution.js';

export type ProjectChatScope=ReturnType<GitHubProjects['selection']>;
type Row=Record<string,any>;
type Reader=(scope:ProjectChatScope,tool:string,args:Row)=>Promise<unknown>;
const now=()=>new Date().toISOString();
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_:,-]+$/.test(e.message)?e.message:'project_chat_execution_incomplete';
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}};
const activePhase=(phase:string)=>['registered','running','unknown'].includes(phase);
export type SupplementTarget={source:string;requestId:string;task:string;operation:string};
export type RepairInboxItem={requestId:string;originalRequestId:string;text:string;receivedAt:string};
export type PublishedRepairStep={
  operation:string;round:number;previousH:string;H:string;publicationSha256:string;fixSha256:string;
};
export type PublishedRepairPredecessor={
  previousH:string;workspace:string;reviewOperation:string;reviewMaterialSha256:string;requirementsSha256:string;
  publicationSha256:string;fixSha256:string;testPlans:Array<{path:string;sha256:string}>;protectedPaths:string[];image:string;
  contract:string;revisions:Array<{requirement:string;acceptance:string[]}>;ancestors?:PublishedRepairStep[];
};
export type EndedRepairSupplement={operation:string;round:number;H:string;sessionId:string;report:Row;published?:PublishedRepairPredecessor};
export function repairPredecessorMatches(repair:EndedRepairSupplement,H:unknown){
  const {published}=repair;
  return (published?.previousH??repair.H)===H||published?.ancestors?.some(step=>step.previousH===H)===true;
}
export type SupplementConsumer={targets(scope:ProjectChatScope):Promise<Array<SupplementTarget&{title:string}>>;read(scope:ProjectChatScope,target:SupplementTarget,compiled:string|null,text:string,receivedId?:string):Promise<Row>;work(scope:ProjectChatScope,target:SupplementTarget,id:string,text:string,beforeRegistration:()=>void,endedRepair?:EndedRepairSupplement):Promise<string>;review?(scope:ProjectChatScope,target:SupplementTarget,id:string,text:string,stillCurrent:()=>void):Promise<Row>;cancel(scope:ProjectChatScope,target:SupplementTarget,id:string,text:string):Promise<void>};
export type ProjectWorkLink={requestId:string;linked:boolean};
export type ProjectWorkRequest={origin:ProjectWorkOrigin;original:ProjectWorkLink|null};
export type ProjectWorkConsumer={options(scope:ProjectChatScope):Promise<Array<ProjectWorkTarget&{title:string}>>;coordinate(scope:ProjectChatScope,target:ProjectWorkTarget,request:ProjectWorkRequest,checkpoint:(link?:ProjectWorkLink)=>void):Promise<ProjectWorkLink>;read(scope:ProjectChatScope,target:ProjectWorkTarget,request:ProjectWorkRequest):Promise<Row|null>;cancel(scope:ProjectChatScope,target:ProjectWorkTarget,request:ProjectWorkRequest):Promise<Row>;stop(scope:ProjectChatScope,target:ProjectWorkTarget,request:ProjectWorkRequest):Promise<Row>};
type Active={promise:Promise<void>;session?:BoundedCodexSession;closePromise?:Promise<void>;stop:boolean;timedOut?:boolean};
type ProjectChatIdentity={account:{id:number};repository:{id:number;nodeId:string}};

/** One durable conversation history. Existing task queues and native capture
 * contracts remain authoritative; opening or replaying a chat never sends. */
export class ProjectChat{
  private active=new Map<string,Active>();private accepting=true;private owner=randomUUID();
  // Only admissions made in this process can start automatically. The row,
  // not this map, is authoritative for whether anything has been sent.
  private waiting=new Map<string,{scope:ProjectChatScope;preferences:AIPreferenceSnapshot|null;checking?:boolean}>();
  private constructor(private config:ProjectChatConfig,private db:DatabaseSync,private read:Reader,private verify:(scope:ProjectChatScope)=>Promise<void>,private supplements?:SupplementConsumer,private work?:ProjectWorkConsumer){}
  static async open(config:ProjectChatConfig,read:Reader,verify:(scope:ProjectChatScope)=>Promise<void>,supplements?:SupplementConsumer,work?:ProjectWorkConsumer){
    validateProjectChatConfig(config);if(!await exists(config.root))await privateDirectory(config.root,true);else await privateDirectory(config.root,false);
    const path=join(config.root,'conversations.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(path,64*1024*1024);
    const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,account INTEGER NOT NULL,repository INTEGER NOT NULL,node_id TEXT NOT NULL,name TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversations(id),parent TEXT,question TEXT NOT NULL,phase TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,pid INTEGER,owner TEXT,problem TEXT,report TEXT,receipt TEXT);
      CREATE TABLE IF NOT EXISTS unstarted_attempt_moves(id TEXT PRIMARY KEY REFERENCES messages(id),body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_supplements(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversations(id),target TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,compiled TEXT);
      CREATE TABLE IF NOT EXISTS task_supplement_groups(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversations(id),text TEXT NOT NULL,created_at TEXT NOT NULL,targets TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_supplement_members(member TEXT PRIMARY KEY REFERENCES task_supplements(id),group_id TEXT NOT NULL REFERENCES task_supplement_groups(id));
      CREATE TABLE IF NOT EXISTS task_supplement_repair_inboxes(operation TEXT NOT NULL,round INTEGER NOT NULL,target TEXT NOT NULL,requests TEXT NOT NULL,PRIMARY KEY(operation,round));
      CREATE TABLE IF NOT EXISTS task_work_requests(id TEXT PRIMARY KEY REFERENCES messages(id),target TEXT NOT NULL,original_request TEXT,linked INTEGER NOT NULL DEFAULT 0,coordinated INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,problem TEXT);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation,created_at,id);`);
    return new ProjectChat(structuredClone(config),db,read,verify,supplements,work);
  }
  private transaction<T>(fn:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private conversationRow(scope:ProjectChatScope,id:string){
    if(!chatId(id))throw new Error('project_chat_id_invalid');const c=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row|undefined;
    if(!c||c.account!==scope.account.id||c.repository!==scope.repository.id||c.node_id!==scope.repository.nodeId)throw new Error('project_chat_outside_project');return c;
  }
  private rows(id:string){return this.db.prepare('SELECT * FROM messages WHERE conversation=? ORDER BY rowid').all(id) as Row[];}
  private preceding(conversation:string,id:string){
    return this.db.prepare('SELECT * FROM messages WHERE conversation=? AND rowid < (SELECT rowid FROM messages WHERE id=?) ORDER BY rowid').all(conversation,id) as Row[];
  }
  private projectMessages(scope:ProjectChatIdentity,phase:'active'|'queued'){
    const phases=phase==='active'?"('registered','running','unknown')":"('queued')";
    return this.db.prepare(`SELECT messages.* FROM messages JOIN conversations ON conversations.id=messages.conversation
      WHERE conversations.account=? AND conversations.repository=? AND conversations.node_id=?
      AND messages.phase IN ${phases} ORDER BY messages.rowid`).all(scope.account.id,scope.repository.id,scope.repository.nodeId) as Row[];
  }
  private modelHistory(rows:Row[]){
    const history=rows.filter(r=>r.problem!=='project_chat_queued_cancelled')
      .map(r=>({requestId:r.id,question:r.question,status:r.phase,answer:r.report}));
    if(history.length>=64||Buffer.byteLength(canonical(history))>192*1024)throw new Error('project_chat_context_limit');
    return history;
  }
  private async verifyHistory(history:Row[]){
    for(const row of history)if(row.phase==='completed'){
      const original=await this.verified(row.id);
      if(original.report!==row.report)throw new Error('project_chat_saved_answer_changed');
    }
  }
  /** A preparation page may create the same conversation without inventing
   * a secretary question, answer or model execution. */
  ensureWorkConversation(scope:ProjectChatScope,id:string,title:string){
    if(!chatId(id))throw new Error('project_chat_id_invalid');
    return this.transaction(()=>this.ensureConversation(scope,id,title));
  }
  private ensureConversation(scope:ProjectChatScope,id:string,title:string){
    if(this.db.prepare('SELECT id FROM conversations WHERE id=?').get(id)){
      this.conversationRow(scope,id);return {id,duplicate:true};
    }
    const count=this.db.prepare('SELECT COUNT(*) n FROM conversations WHERE account=? AND repository=?').get(scope.account.id,scope.repository.id) as Row;
    if(count.n>=128)throw new Error('project_chat_history_limit');
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?)').run(id,scope.account.id,scope.repository.id,scope.repository.nodeId,scope.repository.fullName,title.slice(0,80),now());
    return {id,newModelInputs:0};
  }
  private directory(id:string){if(!chatId(id))throw new Error('project_chat_id_invalid');return join(this.config.root,id);}
  private requeue(id:string,owner:string,problem:string){
    return this.transaction(()=>{
      const value=this.db.prepare("UPDATE messages SET phase='queued',pid=NULL,owner=NULL,problem=? WHERE id=? AND owner=? AND phase IN ('registered','running','unknown')").run(problem,id,owner);
      if(value.changes===1)this.db.prepare('DELETE FROM unstarted_attempt_moves WHERE id=?').run(id);
      return value.changes===1;
    });
  }
  private async unstartedAttempt(directory:string,ended:boolean){
    const files=['request.json','outcome.json'];
    if(ended)files.push('native/process.json','native/exit.json','native/stdin.ndjson');
    const originals=Object.fromEntries(await Promise.all(files.map(async name=>[name,await regular(join(directory,name),16*1024*1024)] as const)));
    if(await exists(join(directory,'native','turn-1-intent.json'))||!ended&&await exists(join(directory,'native')))throw new Error('project_chat_original_process_unknown');
    if(ended){
      const wire=originals['native/stdin.ndjson']!.toString();
      if(!wire.endsWith('\n')||wire.trim().split('\n').some(line=>JSON.parse(line).method==='turn/start'))throw new Error('project_chat_original_process_unknown');
    }
    return Object.fromEntries(Object.entries(originals).map(([name,bytes])=>[name,hash(bytes)]));
  }
  private async resumeUnstartedMove(row:Row,raw:string){
    const intent=JSON.parse(raw),{archive,owner,problem,ended,files}=intent;
    if(!exactKeys(intent,['archive','owner','problem','ended','files'])||!chatId(archive)||owner!==row.owner||typeof ended!=='boolean'||
       !['github_connection_unavailable','github_service_unavailable'].includes(problem))throw new Error('project_chat_original_process_unknown');
    const original=this.directory(row.id),destination=original+'.unstarted-'+archive,source=await exists(original),moved=await exists(destination);
    if(source===moved||canonical(await this.unstartedAttempt(source?original:destination,ended))!==canonical(files))throw new Error('project_chat_original_process_unknown');
    if(source)renameSync(original,destination);
    this.requeue(row.id,owner,problem);
  }
  private async recover(row:Row){
    if(!activePhase(row.phase)||this.active.has(row.id)||row.owner!==this.owner&&row.pid&&alive(row.pid))return;
    const transfer=this.db.prepare('SELECT body FROM unstarted_attempt_moves WHERE id=?').get(row.id) as {body:string}|undefined;
    if(transfer){
      try{await this.resumeUnstartedMove(row,transfer.body);}
      catch{this.db.prepare("UPDATE messages SET phase='unknown',problem='project_chat_process_unknown' WHERE id=? AND owner=? AND phase IN ('registered','running','unknown')").run(row.id,row.owner);}
      return;
    }
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
    const oldest=this.projectMessages(scope,'queued')[0];
    const nextQuestion=oldest?{conversationId:oldest.conversation,requestId:oldest.id,checking:this.waiting.get(oldest.id)?.checking===true}:null;
    return {available:true,executionKind:this.config.executionKind,project:scope.repository,supplementTargets:this.supplements?await this.supplements.targets(scope):[],work:await this.workOptions(scope),busy,nextQuestion,conversations:conversations.map(c=>({id:c.id,title:c.title,createdAt:c.created_at})),newModelInputs:0};
  }
  async conversation(scope:ProjectChatScope,id:string){
    const c=this.conversationRow(scope,id);for(const row of this.rows(id))await this.recover(row);
    const messages=[];for(const r of this.rows(id)){let answer=r.report,receipt=r.receipt?JSON.parse(r.receipt):null,status=r.phase,problem=r.problem;if(status==='completed')try{const checked=await this.verified(r.id);if(checked.report!==answer||canonical(checked.receipt)!==canonical(receipt))throw new Error('project_chat_saved_answer_changed');}catch(e){answer=null;receipt=null;status='unavailable';problem=reason(e);}messages.push({id:r.id,parent:r.parent,question:r.question,status,createdAt:r.created_at,finishedAt:r.finished_at,problem,answer,receipt,active:activePhase(r.phase)&&!!(this.active.has(r.id)||r.phase!=='unknown'&&r.pid&&alive(r.pid)),owned:this.active.has(r.id)});}
    return {id:c.id,title:c.title,project:scope.repository,messages,supplements:await this.supplementState(scope,id),workRequests:await this.workState(scope,id),newModelInputs:0,continuation:'saved_history_in_new_native_context'};
  }
  async begin(scope:ProjectChatScope,body:unknown){
    if(!this.accepting)throw new Error('project_chat_closing');const b=structuredClone(body) as Row;
    if(!exactKeys(b,['conversationId','requestId','parent','question',...(b&&Object.hasOwn(b,'workTarget')?['workTarget']:[])])||!chatId(b.conversationId)||!chatId(b.requestId)||!(b.parent===null||chatId(b.parent))||typeof b.question!=='string'||!b.question.trim()||b.question.length>8192||b.question.includes('\0')||Object.hasOwn(b,'workTarget')&&!projectWorkTarget(b.workTarget))throw new Error('project_chat_question_invalid');
    const duplicate=()=>{
      if(this.db.prepare('SELECT id FROM task_supplements WHERE id=? UNION SELECT id FROM task_supplement_groups WHERE id=?').get(b.requestId,b.requestId))throw new Error('project_chat_request_changed');
      const old=this.db.prepare('SELECT * FROM messages WHERE id=?').get(b.requestId) as Row|undefined;
      if(!old)return null;
      this.conversationRow(scope,old.conversation);
      if(old.conversation!==b.conversationId||old.question!==b.question||old.parent!==b.parent||(this.workRow(b.requestId)?.target??null)!==(b.workTarget?canonical(b.workTarget):null))throw new Error('project_chat_request_changed');
      return {conversationId:b.conversationId,requestId:b.requestId,duplicate:true,status:old.phase as string,newModelInputs:0};
    };
    const previous=duplicate();if(previous)return previous;
    if(b.workTarget){await this.verify(scope);const options=await this.workOptions(scope);if(!options.options.some(t=>t.source===b.workTarget.source&&t.issueNumber===b.workTarget.issueNumber))throw new Error('project_work_target_not_supported');}
    const result=this.transaction(()=>{
      if(!this.accepting)throw new Error('project_chat_closing');
      const same=duplicate();if(same)return same;
      const queued=!!(this.projectMessages(scope,'active').length||this.projectMessages(scope,'queued').length);
      if(queued&&b.workTarget)throw new Error('project_chat_reply_pending');
      this.ensureConversation(scope,b.conversationId,b.question);
      const history=this.rows(b.conversationId);
      if((history.at(-1)?.id??null)!==b.parent)throw new Error('project_chat_parent_changed');
      if(!queued)this.modelHistory(history);
      const status=queued?'queued':'registered';
      this.db.prepare('INSERT INTO messages(id,conversation,parent,question,phase,created_at,pid,owner) VALUES (?,?,?,?,?,?,?,?)').run(b.requestId,b.conversationId,b.parent,b.question,status,now(),queued?null:process.pid,queued?null:this.owner);
      if(b.workTarget)this.db.prepare('INSERT INTO task_work_requests(id,target) VALUES(?,?)').run(b.requestId,canonical(b.workTarget));
      return {conversationId:b.conversationId,requestId:b.requestId,duplicate:false,status,registered:!queued,newModelInputs:queued?0:null};
    });
    if(!result.duplicate){
      if(result.status==='queued'){
        this.waiting.set(b.requestId,{scope,preferences:currentAIPreferences(['secretary'])});
        this.processWaiting(scope);
      }
      else this.start(scope,b.requestId);
    }
    return result;
  }
  private start(scope:ProjectChatScope,id:string,fromQueue=false){
    const active:Active={promise:Promise.resolve(),stop:false};this.active.set(id,active);
    active.promise=this.execute(scope,id,active,fromQueue).catch(()=>{/* The durable registration stays unresolved if recording the failure also fails. */}).finally(()=>{
      if(this.active.get(id)===active)this.active.delete(id);
      this.processWaiting(scope);
    });
  }
  private processWaiting(project:ProjectChatIdentity){
    if(!this.accepting||this.projectMessages(project,'active').length)return;
    const next=this.projectMessages(project,'queued')[0];if(!next)return;
    const waiting=this.waiting.get(next.id);if(!waiting||waiting.checking)return;
    const {scope,preferences}=waiting;
    waiting.checking=true;
    // Automatic continuation bypasses the HTTP project check. Verify before
    // claiming the row so a failed check leaves the original question queued.
    void this.verify(scope).then(()=>{
      const resume=()=>this.continueQuestion(scope,next.id);
      return preferences?withAIPreferences(preferences,resume):resume();
    }).catch(()=>{/* The saved question remains available for explicit continuation. */}).finally(()=>this.waiting.delete(next.id));
  }
  async continueQuestion(scope:ProjectChatScope,id:string){
    if(!this.accepting||!chatId(id))throw new Error('project_chat_id_invalid');
    const original=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row|undefined;
    if(!original)throw new Error('project_chat_outside_project');
    this.conversationRow(scope,original.conversation);
    for(const row of this.projectMessages(scope,'active'))await this.recover(row);
    const result=this.transaction(()=>{
      if(!this.accepting)throw new Error('project_chat_closing');
      const current=this.db.prepare('SELECT phase FROM messages WHERE id=?').get(id) as Row;
      if(current.phase!=='queued')return {requestId:id,status:current.phase as string,newModelInputs:0,duplicate:true};
      if(this.active.has(id)||this.projectMessages(scope,'active').length||this.projectMessages(scope,'queued')[0]?.id!==id)return {requestId:id,status:'queued',newModelInputs:0,duplicate:false};
      this.db.prepare("UPDATE messages SET phase='registered',pid=?,owner=?,problem=NULL WHERE id=? AND phase='queued'").run(process.pid,this.owner,id);
      return {requestId:id,status:'registered',newModelInputs:null,duplicate:false};
    });
    if(result.status==='registered'&&!result.duplicate){this.waiting.delete(id);this.start(scope,id,true);}
    return result;
  }
  private workRow(id:string){return this.db.prepare('SELECT * FROM task_work_requests WHERE id=?').get(id) as Row|undefined;}
  private workRequest(row:Row,intent:Row):ProjectWorkRequest{return {origin:{kind:'project_secretary_work_request',conversationId:row.conversation,requestId:row.id,text:row.question},original:intent.original_request?{requestId:intent.original_request,linked:!!intent.linked}:null};}
  private async workOptions(scope:ProjectChatScope){try{return {available:!!this.work,options:this.work?await this.work.options(scope):[],reason:this.work?null:'project_work_not_configured'};}catch(e){return {available:false,options:[],reason:reason(e)};}}
  private async workState(scope:ProjectChatScope,conversation:string){
    const rows=this.db.prepare('SELECT w.*,m.question,m.conversation FROM task_work_requests w JOIN messages m ON m.id=w.id WHERE m.conversation=? ORDER BY m.rowid').all(conversation) as Row[];
    return Promise.all(rows.map(async r=>{let original:Row|null=null,problem=r.problem;try{if(this.work)original=await this.work.read(scope,JSON.parse(r.target),this.workRequest(r,r));}catch(e){problem=problem??reason(e);}return {id:r.id,text:r.question,target:JSON.parse(r.target),originalRequestId:original?.id??null,linkedExisting:!!original&&!!r.linked,newTextDeliveredToExisting:false,coordinated:!!original,cancelRequested:!!r.cancel_requested,problem,original,receivedIsNotDelivered:true};}));
  }
  async coordinateWork(scope:ProjectChatScope,id:string,checkActive:()=>void=()=>{}){
    if(!chatId(id)||!this.work||!this.accepting)throw new Error('project_work_not_configured');const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row|undefined,intent=this.workRow(id);
    if(!row||!intent)throw new Error('project_work_request_required');this.conversationRow(scope,row.conversation);const target=JSON.parse(intent.target) as ProjectWorkTarget;
    const check=()=>{checkActive();const current=this.workRow(id);if(!this.accepting||!current||current.target!==intent.target||current.cancel_requested)throw new Error('project_work_cancelled_or_changed');};
    check();await this.verify(scope);check();if(!(await this.work.options(scope)).some(t=>canonical({source:t.source,issueNumber:t.issueNumber})===canonical(target)))throw new Error('project_work_target_not_supported');
    // A fence-only checkpoint precedes registration. Persist a link only once
    // the original queue has registered and verified that exact relationship.
    const checkpoint=(link?:ProjectWorkLink)=>{check();if(!link)return;this.transaction(()=>{check();const current=this.workRow(id)!;if(current.original_request&&(current.original_request!==link.requestId||!!current.linked!==link.linked))throw new Error('project_work_original_is_fixed');this.db.prepare('UPDATE task_work_requests SET original_request=?,linked=?,coordinated=1,problem=NULL WHERE id=?').run(link.requestId,link.linked?1:0,id);});};
    try{const link=await this.work.coordinate(scope,target,this.workRequest(row,intent),checkpoint);return {requestId:id,originalRequestId:link.requestId,linkedExisting:link.linked,newTextDeliveredToExisting:false,original:await this.work.read(scope,target,{origin:this.workRequest(row,intent).origin,original:link}),registrationIsNotImplementation:true};}
    catch(e){this.db.prepare('UPDATE task_work_requests SET problem=? WHERE id=?').run(reason(e),id);throw e;}
  }
  async stopWork(scope:ProjectChatScope,id:string){
    if(!chatId(id)||!this.work)throw new Error('project_work_request_required');const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row|undefined,intent=this.workRow(id);if(!row||!intent)throw new Error('project_work_original_not_registered');this.conversationRow(scope,row.conversation);
    return this.work.stop(scope,JSON.parse(intent.target),this.workRequest(row,intent));
  }
  async cancelWork(scope:ProjectChatScope,id:string){
    if(!chatId(id)||!this.work)throw new Error('project_work_request_required');const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row|undefined,intent=this.workRow(id);if(!row||!intent)throw new Error('project_work_request_required');this.conversationRow(scope,row.conversation);
    // Persist the cancellation fence first. Queue registration checks it while
    // holding its own transaction; cancellation then serializes in that queue.
    this.transaction(()=>this.db.prepare('UPDATE task_work_requests SET cancel_requested=1 WHERE id=?').run(id));
    try{const current=this.workRow(id)!,result=await this.work.cancel(scope,JSON.parse(current.target),this.workRequest(row,current));this.db.prepare('UPDATE task_work_requests SET problem=NULL WHERE id=?').run(id);return {requestId:id,...result};}catch(e){this.db.prepare('UPDATE task_work_requests SET problem=? WHERE id=?').run(reason(e),id);throw e;}
  }
  private supplementRows(conversation:string){
    return this.db.prepare(`SELECT s.*,g.id AS original_id,g.text AS original_text FROM task_supplements s
      LEFT JOIN task_supplement_members m ON m.member=s.id LEFT JOIN task_supplement_groups g ON g.id=m.group_id
      WHERE s.conversation=? ORDER BY s.rowid`).all(conversation) as Row[];
  }
  private supplementText(row:Row){return (row.original_text??row.text) as string;}
  compiledRepairSupplements(scope:ProjectChatScope,target:SupplementTarget){
    return this.targetSupplements(scope,target).filter(row=>!row.cancelled&&row.compiled&&this.inRepairInbox(row.id))
      .map(row=>({id:row.id,compiled:row.compiled as string,text:this.supplementText(row)}));
  }
  repairInbox(scope:ProjectChatScope,target:SupplementTarget,operation:string,round:number,recheck:string[]=[],settled:string[]=[]):RepairInboxItem[]{
    return this.transaction(()=>{
      if(this.compiledRepairSupplements(scope,target).some(row=>!settled.includes(row.compiled)))
        throw new Error('formal_repair_supplement_ordinary_active_or_unknown');
      const selection=canonical({account:scope.account.id,repository:scope.repository.id,nodeId:scope.repository.nodeId,target});
      const previous=this.db.prepare('SELECT target,requests FROM task_supplement_repair_inboxes WHERE operation=? AND round=?').get(operation,round) as Row|undefined;
      if(previous&&previous.target!==selection)throw new Error('formal_repair_inbox_binding_changed');
      const rows=this.targetSupplements(scope,target);
      const selected=previous?(JSON.parse(previous.requests) as string[]).map(id=>{
        const row=rows.find(r=>r.id===id);
        if(!row||row.cancelled)throw new Error('formal_repair_inbox_binding_changed');
        return row;
      }):rows.filter(row=>!row.cancelled&&!row.compiled&&(recheck.includes(row.id)||!this.inRepairInbox(row.id)));
      const inbox=selected.map(row=>({requestId:row.id,originalRequestId:row.original_id??row.id,text:this.supplementText(row),receivedAt:row.created_at}));
      if(inbox.length>32||Buffer.byteLength(canonical(inbox))>192*1024)throw new Error('project_supplement_context_limit');
      if(!previous)this.db.prepare('INSERT INTO task_supplement_repair_inboxes VALUES (?,?,?,?)').run(operation,round,selection,canonical(inbox.map(item=>item.requestId)));
      return inbox;
    });
  }
  private inRepairInbox(id:string){
    return !!this.db.prepare('SELECT 1 FROM task_supplement_repair_inboxes, json_each(requests) WHERE json_each.value=? LIMIT 1').get(id);
  }
  private async supplementState(scope:ProjectChatScope,conversation:string,includePlanningReports=true){
    return Promise.all(this.supplementRows(conversation).map(async r=>{
      const target=JSON.parse(r.target),text=this.supplementText(r);let original;
      try{original=this.supplements?await this.supplements.read(scope,target,r.compiled,text,r.id):{reason:'project_supplement_consumer_unavailable'};}
      catch(e){original={reason:reason(e)};}
      if(r.compiled&&!original.endedRepair&&this.inRepairInbox(r.id))
        original={...original,resumable:false,reason:original.reason??'formal_repair_supplement_writer_unresolved'};
      if(!includePlanningReports&&original.planning){
        const {state,approved,executionKind}=original.planning;
        original={...original,planning:{state,approved,executionKind}};
      }
      return {id:r.id,...(r.original_id?{originalRequestId:r.original_id}:{}),text,target,createdAt:r.created_at,cancelled:!!r.cancelled,compiledRequest:r.compiled,original,received:true,receivedIsNotDelivered:true};
    }));
  }
  async receiveSupplement(scope:ProjectChatScope,body:unknown){
    if(!this.accepting||!this.supplements)throw new Error('project_supplement_consumer_unavailable');const b=body as Row;
    if(b&&Object.hasOwn(b,'targets'))return this.receiveSharedSupplement(scope,b);
    if(!exactKeys(b,['conversationId','requestId','target','text'])||!chatId(b.conversationId)||!chatId(b.requestId)||!exactKeys(b.target,['source','requestId','task','operation'])||typeof b.text!=='string'||!b.text.trim()||b.text.length>8192||b.text.includes('\0'))throw new Error('project_supplement_invalid');
    const target=canonical(b.target),old=this.db.prepare('SELECT * FROM task_supplements WHERE id=?').get(b.requestId) as Row|undefined;
    if(old){this.conversationRow(scope,old.conversation);if(old.conversation!==b.conversationId||old.target!==target||old.text!==b.text)throw new Error('project_supplement_id_is_fixed');return {requestId:b.requestId,received:true,duplicate:true,newModelInputs:0};}
    await this.verify(scope);const targets=await this.supplements.targets(scope);if(!targets.some(({title,...t})=>canonical(t)===target))throw new Error('project_supplement_target_not_registered');await this.verify(scope);
    this.transaction(()=>{
      const repeated=this.db.prepare('SELECT * FROM task_supplements WHERE id=?').get(b.requestId) as Row|undefined;if(repeated){this.conversationRow(scope,repeated.conversation);if(repeated.conversation!==b.conversationId||repeated.target!==target||repeated.text!==b.text)throw new Error('project_supplement_id_is_fixed');return;}
      if(this.db.prepare('SELECT id FROM messages WHERE id=? UNION SELECT id FROM task_supplement_groups WHERE id=?').get(b.requestId,b.requestId))throw new Error('project_chat_request_changed');
      const c=this.db.prepare('SELECT id FROM conversations WHERE id=?').get(b.conversationId);if(c)this.conversationRow(scope,b.conversationId);else{const count=this.db.prepare('SELECT COUNT(*) n FROM conversations WHERE account=? AND repository=?').get(scope.account.id,scope.repository.id) as Row;if(count.n>=128)throw new Error('project_chat_history_limit');this.db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?)').run(b.conversationId,scope.account.id,scope.repository.id,scope.repository.nodeId,scope.repository.fullName,b.text.slice(0,80),now());}
      const rows=this.supplementRows(b.conversationId);if(rows.length>=32||Buffer.byteLength(canonical([...new Map(rows.map(row=>[row.original_id??row.id,this.supplementText(row)])).values()]))+Buffer.byteLength(b.text)>192*1024)throw new Error('project_supplement_history_limit');
      this.db.prepare('INSERT INTO task_supplements(id,conversation,target,text,created_at) VALUES(?,?,?,?,?)').run(b.requestId,b.conversationId,target,b.text,now());
    });
    return {requestId:b.requestId,received:true,duplicate:false,newModelInputs:0,meaning:'saved_intent_not_native_delivery'};
  }
  private async receiveSharedSupplement(scope:ProjectChatScope,b:Row){
    if(!exactKeys(b,['conversationId','requestId','targets','text'])||!chatId(b.conversationId)||!chatId(b.requestId)||
      !Array.isArray(b.targets)||b.targets.length<2||b.targets.length>8||
      !b.targets.every((target:unknown)=>exactKeys(target,['source','requestId','task','operation']))||
      typeof b.text!=='string'||!b.text.trim()||b.text.length>8192||b.text.includes('\0'))throw new Error('project_supplement_invalid');
    const targets=[...new Set<string>(b.targets.map(canonical))].sort(),binding=canonical(targets);
    if(targets.length!==b.targets.length)throw new Error('project_supplement_invalid');
    const receipt=(duplicate:boolean)=>({requestId:b.requestId,received:true,duplicate,newModelInputs:0,targets:targets.map(target=>JSON.parse(target)),meaning:'saved_intent_not_native_delivery'});
    const duplicate=()=>{
      const old=this.db.prepare('SELECT * FROM task_supplement_groups WHERE id=?').get(b.requestId) as Row|undefined;
      if(!old)return false;
      this.conversationRow(scope,old.conversation);
      if(old.conversation!==b.conversationId||old.targets!==binding||old.text!==b.text)throw new Error('project_supplement_id_is_fixed');
      return true;
    };
    if(duplicate())return receipt(true);
    await this.verify(scope);
    const registered=new Set((await this.supplements!.targets(scope)).map(({title:_,...target})=>canonical(target)));
    if(!targets.every(target=>registered.has(target)))throw new Error('project_supplement_target_not_registered');
    await this.verify(scope);
    return this.transaction(()=>{
      if(duplicate())return receipt(true);
      const occupied=(id:string)=>this.db.prepare('SELECT id FROM messages WHERE id=? UNION SELECT id FROM task_supplements WHERE id=? UNION SELECT id FROM task_supplement_groups WHERE id=?').get(id,id,id);
      if(occupied(b.requestId))throw new Error('project_chat_request_changed');
      this.ensureConversation(scope,b.conversationId,b.text.slice(0,80));
      const rows=this.supplementRows(b.conversationId),texts=[...new Map(rows.map(row=>[row.original_id??row.id,this.supplementText(row)])).values()];
      if(rows.length+targets.length>32||Buffer.byteLength(canonical(texts))+Buffer.byteLength(b.text)>192*1024)throw new Error('project_supplement_history_limit');
      const at=now();
      this.db.prepare('INSERT INTO task_supplement_groups (id,conversation,text,created_at,targets) VALUES (?,?,?,?,?)').run(b.requestId,b.conversationId,b.text,at,binding);
      for(const target of targets){
        const digest=hash(canonical([b.requestId,target])).slice(0,32),id=digest.replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
        if(occupied(id))throw new Error('project_chat_request_changed');
        this.db.prepare('INSERT INTO task_supplements(id,conversation,target,text,created_at) VALUES (?,?,?,?,?)').run(id,b.conversationId,target,'',at);
        this.db.prepare('INSERT INTO task_supplement_members(member,group_id) VALUES (?,?)').run(id,b.requestId);
      }
      return receipt(false);
    });
  }
  async reviewSupplement(scope:ProjectChatScope,id:string){
    if(!chatId(id)||!this.supplements?.review)throw new Error('project_supplement_consumer_unavailable');
    const r=this.db.prepare('SELECT conversation FROM task_supplements WHERE id=?').get(id) as Row|undefined;
    if(!r)throw new Error('project_supplement_not_found');
    const row=this.supplementRows(r.conversation).find(item=>item.id===id)!;
    this.conversationRow(scope,row.conversation);
    const target=JSON.parse(row.target) as SupplementTarget;
    const check=()=>{
      const current=this.db.prepare('SELECT cancelled, compiled FROM task_supplements WHERE id=?').get(id) as Row;
      if(!this.accepting||current.cancelled||current.compiled)throw new Error('project_supplement_cancelled_or_changed');
    };
    check();
    for(const earlier of this.targetSupplements(scope,target)){
      if(earlier.id===id)break;
      if(earlier.cancelled)continue;
      if(!(await this.supplements.read(scope,target,earlier.compiled,this.supplementText(earlier),earlier.id)).successful)
        throw new Error('project_supplement_earlier_request_pending');
    }
    check();
    return this.supplements.review(scope,target,id,this.supplementText(row),check);
  }
  async cancelSupplement(scope:ProjectChatScope,id:string){
    if(!chatId(id)||!this.supplements)throw new Error('project_supplement_invalid');const r=this.db.prepare(`SELECT s.*,g.text AS original_text FROM task_supplements s LEFT JOIN task_supplement_members m ON m.member=s.id
      LEFT JOIN task_supplement_groups g ON g.id=m.group_id WHERE s.id=?`).get(id) as Row|undefined;if(!r)throw new Error('project_supplement_not_found');this.conversationRow(scope,r.conversation);
    if(r.cancelled)return {requestId:id,cancelled:true,duplicate:true,newModelInputs:0};
    if(this.inRepairInbox(id))throw new Error('formal_repair_supplement_already_reserved');
    if(r.compiled)await this.supplements.cancel(scope,JSON.parse(r.target),r.compiled,this.supplementText(r));
    this.transaction(()=>{const current=this.db.prepare('SELECT * FROM task_supplements WHERE id=?').get(id) as Row;if(current.compiled!==r.compiled)throw new Error('project_supplement_compilation_started');if(this.inRepairInbox(id))throw new Error('formal_repair_supplement_already_reserved');this.db.prepare('UPDATE task_supplements SET cancelled=1 WHERE id=?').run(id);});return {requestId:id,cancelled:true,newModelInputs:0};
  }
  private targetSupplements(scope:ProjectChatScope,target:SupplementTarget){
    return this.db.prepare(`SELECT s.*,g.id AS original_id,g.text AS original_text FROM task_supplements s JOIN conversations c ON c.id=s.conversation
      LEFT JOIN task_supplement_members m ON m.member=s.id LEFT JOIN task_supplement_groups g ON g.id=m.group_id
      WHERE c.account=? AND c.repository=? AND c.node_id=? AND s.target=? ORDER BY s.rowid`).all(scope.account.id,scope.repository.id,scope.repository.nodeId,canonical(target)) as Row[];
  }
  async processSupplements(scope:ProjectChatScope,target:SupplementTarget,explicit=false){
    if(!this.accepting||!this.supplements)throw new Error('project_supplement_consumer_unavailable');
    for(const row of this.targetSupplements(scope,target)){
      if(row.cancelled)continue;
      const state=await this.supplements.read(scope,target,row.compiled,this.supplementText(row),row.id);
      if(state.successful)continue;
      if(row.compiled?!state.resumable:!state.ready)break;
      const endedRepair=state.endedRepair as EndedRepairSupplement|undefined;
      if((endedRepair||row.compiled&&this.inRepairInbox(row.id))&&(!endedRepair||!explicit))break;
      const compiled=row.compiled??'supplement-'+row.id;
      if(!row.compiled)this.transaction(()=>{
        const current=this.db.prepare('SELECT * FROM task_supplements WHERE id=?').get(row.id) as Row;
        if(current.cancelled||current.compiled)throw new Error('project_supplement_original_changed');
        if(this.inRepairInbox(row.id)){
          const binding=canonical({account:scope.account.id,repository:scope.repository.id,nodeId:scope.repository.nodeId,target});
          const latest=this.db.prepare('SELECT operation,round FROM task_supplement_repair_inboxes WHERE target=? ORDER BY rowid DESC LIMIT 1').get(binding) as Row;
          const operations=endedRepair?[endedRepair.operation,endedRepair.operation+'/after-repair']:[];
          if(!endedRepair||latest?.round!==endedRepair.round||!operations.includes(latest.operation))
            throw new Error('formal_repair_supplement_already_reserved');
          const reserved=this.db.prepare(`SELECT 1 FROM task_supplement_repair_inboxes,json_each(requests)
            WHERE target=? AND round=? AND operation IN (?,?) AND json_each.value=?`).get(binding,endedRepair.round,operations[0]!,operations[1]!,row.id);
          if(!reserved)throw new Error('formal_repair_inbox_binding_changed');
        }else if(endedRepair&&!endedRepair.published)throw new Error('formal_repair_inbox_binding_changed');
        this.db.prepare('UPDATE task_supplements SET compiled=? WHERE id=?').run(compiled,row.id);
      });
      const beforeRegistration=()=>{const current=this.db.prepare('SELECT * FROM task_supplements WHERE id=?').get(row.id) as Row;if(!this.accepting||current.cancelled||current.compiled!==compiled)throw new Error('project_supplement_cancelled_or_changed');};
      await this.supplements.work(scope,target,compiled,this.supplementText(row),beforeRegistration,endedRepair);break;
    }
    return {newModelInputs:null,originalRequestsRetained:true};
  }
  private async execute(scope:ProjectChatScope,id:string,active:Active,fromQueue:boolean){
    const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row,directory=this.directory(id),native=join(directory,'native');
    const waitLimitMs=this.config.timeoutMs;let turnStartedAt:number|null=null;
    const timeBudget=()=>{const elapsedMs=turnStartedAt===null?null:Math.max(0,Math.floor(performance.now()-turnStartedAt));return {limitMs:waitLimitMs,elapsedMs,remainingMs:elapsedMs===null?null:Math.max(0,waitLimitMs-elapsedMs)};};
    let firstInputPreparing=false,preInputOutage:Error|undefined;
    try{
      const initial={kind:'project_context',observedAt:now(),data:{account:scope.account,repository:scope.repository},toolBudget:{limit:projectChatToolLimit,used:0,remaining:projectChatToolLimit},timeBudget:timeBudget()},initialId=hash(canonical(initial));
      const observations:Array<{id:string;tool:string;observation:unknown}>=[{id:initialId,tool:'initial_project_context',observation:initial}];
      const preceding=this.preceding(row.conversation,id);
      const history=this.modelHistory(preceding);
      await this.verifyHistory(preceding);
      const taskSupplements=await this.supplementState(scope,row.conversation,false),taskWork=await this.workState(scope,row.conversation),work=this.workRow(id);
      const candidate:Candidate={kind:'project-conversation',repository:scope.repository.fullName,pr:null,projectId:scope.repository.id,accountId:scope.account.id,conversationId:row.conversation,H:scope.repository.defaultHead??'',B:scope.repository.defaultHead??'',target:scope.repository.defaultHead?scope.repository.defaultBranch??'':'',sourceSha256:initialId};
      const prompt=await assembleRolePrompt('secretary',projectChatInstructionsFor(!!work)),input={kind:'project_secretary_question',candidate,initialObservation:{observationId:initialId,...initial},conversation:history,taskSupplements,taskWork,...(work?{workTarget:JSON.parse(work.target)}:{}),question:row.question};
      if(Buffer.byteLength(canonical(input))>512*1024)throw new Error('project_chat_context_limit');
      const aiSelection=currentAIChoice('secretary');if(aiSelection&&(aiSelection.tool!=='codex'||aiSelection.project.account!==scope.account.id||aiSelection.project.repository!==scope.repository.id||aiSelection.project.nodeId!==scope.repository.nodeId))throw new Error('ai_role_tools_not_supported');
      const runtimeConfig=aiSelection?{...this.config,codexExecutable:aiSelection.executable}:this.config;
      const checkStopped=()=>{if(active.stop||active.timedOut||!this.accepting)throw new Error('project_chat_stopped');};
      const check=async()=>{
        checkStopped();
        try{await this.verify(scope);}catch(e){
          if(!firstInputPreparing&&e instanceof Error&&['github_connection_unavailable','github_service_unavailable'].includes(e.message))preInputOutage=e;
          throw e;
        }
        checkStopped();
      };
      let bytes=0,calls=0;
      const gate={check,call:async(p:{tool:string;arguments:Row;callId:string},before?:()=>void)=>{
        await check();before?.();if(++calls>projectChatToolLimit||!projectChatToolsFor(!!work).some(t=>t.name===p.tool))throw new Error('project_chat_tool_limit');
        const data=p.tool==='tongxu_coordinate_selected_work'?(exactKeys(p.arguments,[])?await this.coordinateWork(scope,id,()=>{before?.();if(active.stop||active.timedOut||!this.accepting)throw new Error('project_chat_stopped');}):(()=>{throw new Error('project_work_empty_arguments_required');})()):await this.read(scope,p.tool,p.arguments),observation={tool:p.tool,arguments:p.arguments,observedAt:now(),data,toolBudget:{limit:projectChatToolLimit,used:calls,remaining:projectChatToolLimit-calls},timeBudget:timeBudget()},raw=canonical(observation);bytes+=Buffer.byteLength(raw);
        if(Buffer.byteLength(raw)>128*1024||bytes>512*1024)throw new Error('project_chat_material_limit');await check();before?.();const observationId=hash(raw);observations.push({id:observationId,tool:p.tool,observation});save(join(directory,'observations.json'),observations);
        return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({observationId,...observation})}]};
      }};
      await privateDirectory(directory,true);
      save(join(directory,'observations.json'),observations);
      save(join(directory,'request.json'),{requestId:id,conversationId:row.conversation,candidate,input,system:prompt.system,config:runtimeConfig,...(aiSelection?{aiSelection}:{}),historyTransfer:'complete_saved_history_new_native_context'});
      await check();
      // Account/read and ordinary rate-limit observations are captured by the
      // native executor immediately before input. No stale evidence is dated anew.
      const allowedStop=(request:{action:string;id:string})=>request.action==='interrupt'&&(active.stop&&request.id==='stop-'+id||active.timedOut&&request.id==='timeout-'+id);
      active.session=await BoundedCodexSession.start({executable:runtimeConfig.codexExecutable,...(aiSelection?{aiModel:modelChoice(aiSelection)}:{}),directory:native,operation:directory,candidate,role:'secretary',projectSecretary:true,...(work?{projectSecretaryWork:true as const}:{}),system:prompt.system,inputManifestSha256:hash(canonical(input)),scopeSource:'User-selected GitHub repository '+scope.repository.id,arrangementSource:work?'Project work secretary; coordinate only this saved user-selected approved work; new native context':'Project work secretary; read only; saved history passed into a new native context',disabledMcpServers:this.config.disabledMcpServers,allowedInstructionSources:this.config.allowedInstructionSources,timeoutMs:waitLimitMs,executionKind:this.config.executionKind,beforeTurn:check,beforeSendSync:()=>{checkStopped();firstInputPreparing=true;},afterTurnStarted:()=>{turnStartedAt=performance.now();},gate,control:{beforeControl:async request=>{if(!allowedStop(request))throw new Error('project_chat_control_not_allowed');},beforeControlSendSync:(request,send)=>{if(!allowedStop(request))throw new Error('project_chat_control_not_allowed');send();}}});
      await check();this.db.prepare("UPDATE messages SET phase='running' WHERE id=?").run(id);await active.session.turn(canonical(input),candidate,projectSecretarySchema);await this.closeNative(active);await this.complete(id);
    }catch(e){
      let cleanupRecordProblem:string|null=null;
      if(reason(e)==='executor_wait_timeout'&&active.session){
        active.timedOut=true;
        try{save(join(directory,'timeout-stop-request.json'),{at:now(),requestId:id,source:'configured_wait_limit',timeoutMs:this.config.timeoutMs,automaticResend:false});}
        catch{cleanupRecordProblem='timeout_record_unavailable';}
        finally{await this.stopNative(id,active,'timeout').catch(()=>{});}
      }
      const closed=await this.closeNative(active).then(()=>true,()=>false);try{await this.complete(id);return;}catch{}
      const current=this.db.prepare('SELECT phase,owner FROM messages WHERE id=?').get(id) as Row;
      const unstarted=current.phase==='registered'&&!await exists(native);let ended=unstarted;
      if(!ended)try{const original=JSON.parse((await regular(join(native,'process.json'),4096)).toString());ended=exactKeys(original,['pid','status'])&&Number.isSafeInteger(original.pid)&&original.pid>0&&original.status==='spawn_attempted'&&!alive(original.pid);}catch{ended=false;}
      const hasDirectory=await exists(directory);
      const outcome=(status:string)=>({status,nativeProcessState:unstarted?'not_started':ended?'ended':'unknown',invocationOutcome:active.stop?'stop_requested':active.timedOut?'timeout':'error',reason:reason(e),...(cleanupRecordProblem?{cleanupRecordProblem}:{}),automaticResend:false});
      if(fromQueue&&preInputOutage&&e===preInputOutage&&closed&&ended&&
        current.owner===this.owner&&['registered','running'].includes(current.phase)&&
        !await exists(join(native,'turn-1-intent.json'))&&!active.stop&&this.accepting){
        let preserved=!hasDirectory,moveRegistered=false;
        if(hasDirectory)try{
          // Preserve the unsent attempt before making the same request eligible again.
          save(join(directory,'outcome.json'),outcome('queued'));
          const archive=randomUUID(),files=await this.unstartedAttempt(directory,!unstarted);
          const move={archive,owner:this.owner,problem:reason(e),ended:!unstarted,files};
          this.db.prepare('INSERT INTO unstarted_attempt_moves VALUES(?,?)').run(id,canonical(move));
          moveRegistered=true;
          renameSync(directory,directory+'.unstarted-'+archive);
          preserved=true;
        }catch{/* Keep the original capture and settle as a failure if it cannot be preserved. */}
        if(preserved){
          this.requeue(id,this.owner,reason(e));
          return;
        }
        if(moveRegistered)return;
      }
      const phase=!ended?'unknown':active.stop?'interrupted':'failed';
      this.db.prepare('UPDATE messages SET phase=?,problem=?,finished_at=? WHERE id=?').run(phase,reason(e),now(),id);
      if(hasDirectory)save(join(directory,'outcome.json'),outcome(phase));
    }
  }
  private async verified(id:string){
    const directory=this.directory(id),request=JSON.parse((await regular(join(directory,'request.json'),1024*1024)).toString()),parsed=await readRepairSession(join(directory,'native'));
    if(parsed.binding.run!==directory||parsed.binding.role!=='secretary'||canonical(parsed.binding.candidate)!==canonical(request.candidate)||parsed.binding.inputManifestSha256!==hash(canonical(request.input))||parsed.turns.length!==1||!parsed.turns[0]?.final)throw new Error('project_chat_original_mismatch');
    const sent=(await regular(join(directory,'native','stdin.ndjson'),16*1024*1024)).toString().trim().split('\n').map(l=>JSON.parse(l)),turns=sent.filter(m=>m.method==='turn/start');
    if(turns.length!==1||!isSecretaryOutputSchema(turns[0]?.params?.outputSchema))throw new Error('project_chat_original_mismatch');
    const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row;if(!row||request.requestId!==id||request.conversationId!==row.conversation||request.input.question!==row.question||request.candidate.conversationId!==row.conversation)throw new Error('project_chat_request_changed');
    const c=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.conversation) as Row;if(request.candidate.projectId!==c.repository||request.candidate.accountId!==c.account)throw new Error('project_chat_original_mismatch');
    const answer=JSON.parse(parsed.turns[0].final.text),observations=JSON.parse((await regular(join(directory,'observations.json'),1024*1024)).toString()) as Row[];
    if(!exactKeys(answer,['candidateH','report','observationIds'])||answer.candidateH!==request.candidate.H||typeof answer.report!=='string'||!answer.report.trim()||Buffer.byteLength(answer.report)>256*1024||!Array.isArray(answer.observationIds)||!answer.observationIds.length||answer.observationIds.some((id:unknown)=>!observations.some(o=>o.id===id)))throw new Error('project_chat_answer_unverified');
    const pairs=JSON.parse((await regular(join(directory,'native','reconciled-tools.json'),2*1024*1024)).toString()) as Row[];
    for(const o of observations){if(hash(canonical(o.observation))!==o.id)throw new Error('project_chat_observation_changed');if(o.tool==='initial_project_context'){const {observationId,...initial}=request.input.initialObservation;if(o.id!==observationId||canonical(o.observation)!==canonical(initial))throw new Error('project_chat_observation_changed');}else if(!pairs.some(p=>p.response?.result?.contentItems?.[0]?.text===JSON.stringify({observationId:o.id,...o.observation})))throw new Error('project_chat_observation_changed');}
    let aiExecution:any;
    if(request.aiSelection){const choice=modelChoice(request.aiSelection),received=(await regular(join(directory,'native','stdout.ndjson'),16*1024*1024)).toString().trim().split('\n').map(l=>JSON.parse(l));capturedCodexModels(sent,received,choice);const start=sent.find(m=>m.method==='thread/start'),thread=received.find(m=>m.id===start?.id&&!m.method)?.result;checkCodexSelected(thread,choice);const turn=turns[0];for(const [k,v] of Object.entries(codexTurnChoice(choice)))if(turn?.params[k]!==v)throw new Error('ai_selected_model_not_applied');aiExecution={selection:request.aiSelection,actualModel:thread.model,actualEffort:thread.reasoningEffort};}
    const receipt={sessionId:parsed.binding.sessionId,turnId:parsed.binding.turnIds[0],executionKind:parsed.binding.sourceKind,reportSha256:hash(answer.report),observationIds:answer.observationIds,observations:observations.filter(o=>answer.observationIds.includes(o.id)),continuation:'saved_history_in_new_native_context',modelExplanationIsNotApproval:true,...(aiExecution?{aiExecution}:{})};
    return {report:answer.report,receipt};
  }
  private async complete(id:string){const result=await this.verified(id);save(join(this.directory(id),'answer.json'),result);this.db.prepare("UPDATE messages SET phase='completed',finished_at=COALESCE(finished_at,?),problem=NULL,report=?,receipt=? WHERE id=?").run(now(),result.report,canonical(result.receipt),id);}

  private async closeNative(active:Active){
    // Stop and execute must wait for the same process and capture cleanup.
    if(active.session)await (active.closePromise??=active.session.close());
  }
  private async stopNative(id:string,active:Active,cause:'user'|'timeout'='user'){
    const state=active.session?.controlState();if(state?.currentTurnActive)await active.session!.control({id:(cause==='timeout'?'timeout-':'stop-')+id,action:'interrupt',threadId:state.threadId!,sessionId:state.sessionId!,turnId:state.turnId!,input:null}).catch(()=>{});
    await this.closeNative(active);
  }
  async stopSelected(accountId:number,repositoryId:number,id:string,withdrawQueued=false){
    if(!chatId(id)||!Number.isSafeInteger(accountId)||!Number.isSafeInteger(repositoryId))throw new Error('project_chat_id_invalid');
    const row=this.db.prepare('SELECT messages.*,conversations.account,conversations.repository,conversations.node_id FROM messages JOIN conversations ON conversations.id=messages.conversation WHERE messages.id=?').get(id) as Row|undefined;
    if(!row||row.account!==accountId||row.repository!==repositoryId)throw new Error('project_chat_outside_project');
    if(withdrawQueued||row.phase==='queued'){
      const cancelled=this.db.prepare("UPDATE messages SET phase='interrupted',finished_at=?,problem='project_chat_queued_cancelled' WHERE id=? AND phase='queued'").run(now(),id).changes===1;
      if(!cancelled&&withdrawQueued){
        const current=this.db.prepare('SELECT phase,problem FROM messages WHERE id=?').get(id) as Row;
        if(current.phase==='interrupted'&&current.problem==='project_chat_queued_cancelled')return {requestId:id,stopRequested:true,stopRecordSaved:true,newModelInputs:0};
        throw new Error('project_chat_withdrawal_state_changed');
      }
      if(cancelled){
        this.waiting.delete(id);
        this.processWaiting({account:{id:accountId},repository:{id:repositoryId,nodeId:row.node_id}});
      }
      return {requestId:id,stopRequested:cancelled,stopRecordSaved:cancelled,newModelInputs:0};
    }
    const active=this.active.get(id);if(!active){await this.recover(row);return {requestId:id,stopRequested:false,newModelInputs:0};}
    active.stop=true;let stopRecordSaved=false;
    try{this.db.prepare("UPDATE messages SET problem='project_chat_user_stop_requested' WHERE id=?").run(id);if(await exists(this.directory(id))){save(join(this.directory(id),'stop-request.json'),{at:now(),requestId:id,source:'explicit_user_stop'});stopRecordSaved=true;}}
    catch{/* Explanatory record failure must never bypass owned cleanup. */}
    finally{await this.stopNative(id,active).catch(()=>{});}
    return {requestId:id,stopRequested:true,stopRecordSaved,newModelInputs:0};
  }
  async drain(){this.accepting=false;for(const a of this.active.values())a.stop=true;await Promise.allSettled([...this.active].map(([id,a])=>this.stopNative(id,a)));await Promise.allSettled([...this.active.values()].map(a=>a.promise));this.db.close();}

}
