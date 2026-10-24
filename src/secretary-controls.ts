import {writeFile,readdir,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {parseSecretaryPlan,selectSecretaryRuntime,runSecretary,readSecretaryResult,closeUnstartedSecretary,type SecretaryPlan} from './secretary.js';
import {save} from './live-process.js';

type Source={id:string;store:string;item:string};
type Entry={source:string;title:string;template:{path:string;sha256:string};outputRoot:string};
type Frozen={entry:Entry;source:Source;template:Buffer;plan:SecretaryPlan};
type Question={schemaVersion:1;kind:'tongxu-workbench-question';source:string;item:string;store:string;requestId:string;question:string;templateSha256:string;planSha256:string;createdAt:string;registrationRecoveredAt?:string};
type Registration={directory:string;request:Question;template:Buffer;plan:Buffer};
const errorCode=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'secretary_original_unknown';
async function fixed(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path)).equals(bytes))throw new Error('secretary_question_id_changed');}}
async function projection(path:string,bytes:Buffer){
  if(await exists(path)){if(!(await regular(path,128*1024)).equals(bytes))throw new Error('secretary_question_id_changed');return;}
  // The registration transaction excludes competing publishers. A partial
  // write stays in a private temporary file, never at the projection path.
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});if(await exists(path)){if(!(await regular(path,128*1024)).equals(bytes))throw new Error('secretary_question_id_changed');}else await rename(temporary,path);}
  finally{await unlink(temporary).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});}
}
async function ensure(path:string){try{await privateDirectory(path,true);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await privateDirectory(path,false);}}

/** The page selects a fixed original secretary. User input can change only the
 * bounded question, never the executor, policy, authority or output root. */
export class SecretaryControls {
  private accepting=true;
  private active=new Map<string,Promise<void>>();
  private preparing=new Set<Promise<unknown>>();
  private problems=new Map<string,string>();
  private constructor(private entries:Frozen[]){}
  static async load(path:string,sha256:string,sources:Source[]){
    if(!messagePath(path)||!isAuthorityDigest(sha256))throw new Error('secretary_control_reference_invalid');
    const raw=await regular(path,128*1024);if(hash(raw)!==sha256)throw new Error('secretary_control_catalog_changed');const c=JSON.parse(raw.toString());
    if(!exactKeys(c,['schemaVersion','kind','entries'])||c.schemaVersion!==1||c.kind!=='tongxu-workbench-secretaries'||!Array.isArray(c.entries)||!c.entries.length||c.entries.length>8)throw new Error('secretary_control_catalog_invalid');
    const seen=new Set(),roots=new Set(),entries:Frozen[]=[];
    for(const e of c.entries as Entry[]){
      const source=sources.find(s=>s.id===e?.source);
      if(!exactKeys(e,['source','title','template','outputRoot'])||!source||seen.has(e.source)||typeof e.title!=='string'||!e.title.trim()||e.title.length>100||!exactKeys(e.template,['path','sha256'])||!messagePath(e.template.path)||!isAuthorityDigest(e.template.sha256)||!messagePath(e.outputRoot)||roots.has(e.outputRoot))throw new Error('secretary_control_entry_invalid');
      const template=await regular(e.template.path,128*1024);if(hash(template)!==e.template.sha256)throw new Error('secretary_control_template_changed');const plan=parseSecretaryPlan(template);
      if(plan.store!==source.store||plan.item!==source.item||[plan.taskControls,plan.workbench,plan.queueActions].some(ref=>ref&&ref.source!==source.id))throw new Error('secretary_control_task_mismatch');
      if(await exists(e.outputRoot))await privateDirectory(e.outputRoot,false);seen.add(e.source);roots.add(e.outputRoot);entries.push({entry:structuredClone(e),source:structuredClone(source),template,plan});
    }
    return new SecretaryControls(entries);
  }
  private selected(source:string){const f=this.entries.find(e=>e.source.id===source);if(!f)throw new Error('secretary_task_not_selected');return f;}
  private directory(f:Frozen,id:string){if(!messageId(id))throw new Error('secretary_question_id_invalid');return join(f.entry.outputRoot,hash(id));}
  private async questions(f:Frozen){
    if(!await exists(f.entry.outputRoot))return [];await privateDirectory(f.entry.outputRoot,false);
    const names=(await readdir(f.entry.outputRoot)).filter(n=>isAuthorityDigest(n));if(names.length>4096)throw new Error('secretary_question_history_limit');
    const out:Array<{directory:string;request:Question}>=[];
    for(const name of names){const directory=join(f.entry.outputRoot,name);if(!await exists(join(directory,'question.json'))&&!await exists(join(directory,'registration.json')))continue;out.push(await this.original(f,directory));}
    return out.sort((a,b)=>b.request.createdAt.localeCompare(a.request.createdAt));
  }
  private async original(f:Frozen,directory:string):Promise<Registration>{
    await privateDirectory(directory,false);let r:Question,template:Buffer,plan:Buffer;
    if(await exists(join(directory,'registration.json'))){
      const record=JSON.parse((await regular(join(directory,'registration.json'),1024*1024)).toString());
      if(!exactKeys(record,['schemaVersion','kind','request','template','plan'])||record.schemaVersion!==1||record.kind!=='tongxu-web-secretary-registration')throw new Error('secretary_registration_invalid');
      const decode=(v:any)=>{if(!exactKeys(v,['base64','sha256'])||typeof v.base64!=='string')throw new Error('secretary_registration_invalid');const bytes=Buffer.from(v.base64,'base64');if(bytes.toString('base64')!==v.base64||hash(bytes)!==v.sha256)throw new Error('secretary_registration_invalid');return bytes;};
      r=record.request;template=decode(record.template);plan=decode(record.plan);
      for(const [name,bytes] of [['template.json',template],['input-plan.json',plan],['question.json',Buffer.from(canonical(r))]] as const)if(await exists(join(directory,name))&&!(await regular(join(directory,name),128*1024)).equals(bytes))throw new Error('secretary_question_id_changed');
    }else{
      r=JSON.parse((await regular(join(directory,'question.json'),128*1024)).toString());template=await regular(join(directory,'template.json'),128*1024);plan=await regular(join(directory,'input-plan.json'),128*1024);
    }
    return this.validateOriginal(f,directory,r,template,plan);
  }
  private validateOriginal(f:Frozen,directory:string,r:Question,template:Buffer,plan:Buffer):Registration{
    if(r.schemaVersion!==1||r.kind!=='tongxu-workbench-question'||r.source!==f.source.id||r.item!==f.source.item||r.store!==f.source.store||directory!==this.directory(f,r.requestId))throw new Error('secretary_question_binding_changed');
    const p=parseSecretaryPlan(plan);
    const originalTemplate=parseSecretaryPlan(template);
    const expected={...originalTemplate,question:r.question,...(p.runtimeSelection?{codexSha256:p.codexSha256,runtimeSelection:p.runtimeSelection}:{})};
    if(p.runtimeSelection&&p.runtimeSelection.configuredSha256!==originalTemplate.codexSha256)throw new Error('secretary_runtime_selection_invalid');
    if(hash(template)!==r.templateSha256||hash(plan)!==r.planSha256||canonical(p)!==canonical(expected)||p.store!==f.source.store||p.item!==f.source.item)throw new Error('secretary_question_binding_changed');
    return {directory,request:r,template,plan};
  }
  private saveRegistration(original:Registration){
    const {directory,request,template,plan}=original,encode=(bytes:Buffer)=>({base64:bytes.toString('base64'),sha256:hash(bytes)});
    save(join(directory,'registration.json'),{schemaVersion:1,kind:'tongxu-web-secretary-registration',request,template:encode(template),plan:encode(plan)});
  }
  private async restoreRegistration(original:Registration){
    // Called only under the existing registration transaction. These are
    // recoverable projections, never permission to replace conflicting bytes.
    await projection(join(original.directory,'template.json'),original.template);await projection(join(original.directory,'input-plan.json'),original.plan);await projection(join(original.directory,'question.json'),Buffer.from(canonical(original.request)));
  }
  private async pendingQuestion(f:Frozen,question:string){
    for(const q of (await this.questions(f)).filter(q=>q.request.question===question)){const state=await this.view(f,q);if(state.active||['registered_not_sent','submitted_or_unknown'].includes(state.phase))return this.original(f,q.directory);}
    return undefined;
  }
  private async view(f:Frozen,original:{directory:string;request:Question},full=false){
    const {directory,request}=original,output=join(directory,'execution'),base={requestId:request.requestId,question:request.question,createdAt:request.createdAt,...(request.registrationRecoveredAt?{registrationRecoveredAt:request.registrationRecoveredAt}:{}),templateSha256:request.templateSha256,active:this.active.has(directory),controllerRecordProblem:this.problems.get(directory)??null,newModelTasks:0};
    if(await exists(join(output,'closed-unstarted.json')))return {...base,phase:'closed_unstarted',canResume:false};
    try{const result=await readSecretaryResult(join(directory,'input-plan.json'),output);return {...base,phase:'completed',canResume:false,executionKind:result.executionKind,sessionId:result.sessionId,turnId:result.turnId,reportSha256:hash(result.report),...(full?{result}:{})};}
    catch(e){const sent=await exists(join(output,'codex-secretary')),last=await exists(join(directory,'controller-return.json'))?JSON.parse((await regular(join(directory,'controller-return.json'))).toString()):null;return {...base,phase:sent?'submitted_or_unknown':'registered_not_sent',canResume:!base.active,reason:base.active?null:last?.reason??(sent?errorCode(e):null),automaticResend:false};}
  }
  async state(){return Promise.all(this.entries.map(async f=>{
    try{return {source:f.source.id,title:f.entry.title,available:true,executionKind:f.plan.executionKind,questions:await Promise.all((await this.questions(f)).slice(0,32).map(q=>this.view(f,q))),historyShown:32,permissionsGranted:false};}
    catch(e){return {source:f.source.id,title:f.entry.title,available:false,reason:errorCode(e),questions:[],permissionsGranted:false};}
  }));}
  async report(source:string,id:string){const f=this.selected(source);return this.view(f,await this.original(f,this.directory(f,id)),true);}
  async begin(source:string,body:any){
    if(!this.accepting)throw new Error('secretary_control_closing');
    const work=this.beginPrepared(source,body);this.preparing.add(work);try{return await work;}finally{this.preparing.delete(work);}
  }
  private async beginPrepared(source:string,body:any){
    if(!exactKeys(body,['requestId','question'])||!messageId(body.requestId)||typeof body.question!=='string'||!body.question.trim()||body.question.length>8192||body.question.includes('\0'))throw new Error('secretary_question_invalid');
    const f=this.selected(source);await ensure(f.entry.outputRoot);await fixed(join(f.entry.outputRoot,'source.json'),Buffer.from(canonical(f.source)));
    const path=join(f.entry.outputRoot,'registration.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await regular(path,4*1024*1024);const db=new DatabaseSync(path);
    try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}catch(e){db.close();throw new Error('secretary_registration_active');}
    let original:Registration;
    try{
      const directory=this.directory(f,body.requestId);
      if(await exists(join(directory,'question.json'))||await exists(join(directory,'registration.json'))){original=await this.original(f,directory);if(original.request.question!==body.question)throw new Error('secretary_question_id_changed');}
      else if(await exists(join(directory,'input-plan.json'))){
        // Upgrade an interrupted pre-atomic registration only from its saved
        // selection and the matching caller ID, never from today's executable.
        if(await exists(join(directory,'execution')))throw new Error('secretary_question_original_missing');
        const template=await regular(join(directory,'template.json'),128*1024),plan=await regular(join(directory,'input-plan.json'),128*1024),selected=parseSecretaryPlan(plan);
        if(selected.question!==body.question)throw new Error('secretary_question_id_changed');
        const pending=await this.pendingQuestion(f,body.question);
        if(pending)original=pending;
        else{const recoveredAt=new Date().toISOString(),request:Question={schemaVersion:1,kind:'tongxu-workbench-question',source:f.source.id,item:f.source.item,store:f.source.store,requestId:body.requestId,question:body.question,templateSha256:hash(template),planSha256:hash(plan),createdAt:recoveredAt,registrationRecoveredAt:recoveredAt};
          original=this.validateOriginal(f,directory,request,template,plan);this.saveRegistration(original);}
      }
      else{
        // An unresolved identical question cannot be evaded by another UI nonce
        // or a newly selected template. A known completed question may be asked
        // again deliberately; retries keep their original request ID.
        const pending=await this.pendingQuestion(f,body.question);
        if(pending)original=pending;
        else{
          if((await this.questions(f)).length>=4096)throw new Error('secretary_question_history_limit');await ensure(directory);
          // Resolve the configured installed CLI for this new question only.
          // Re-entry reads the original question before ever probing again.
          if(await exists(join(directory,'execution')))throw new Error('secretary_registration_incomplete');
          const template=await exists(join(directory,'template.json'))?await regular(join(directory,'template.json'),128*1024):f.template;
          const plan=Buffer.from(canonical(await selectSecretaryRuntime({...parseSecretaryPlan(template),question:body.question},true)));
          const request:Question={schemaVersion:1,kind:'tongxu-workbench-question',source:f.source.id,item:f.source.item,store:f.source.store,requestId:body.requestId,question:body.question,templateSha256:hash(template),planSha256:hash(plan),createdAt:new Date().toISOString()};
          original=this.validateOriginal(f,directory,request,template,plan);this.saveRegistration(original);
        }
      }
      await this.restoreRegistration(original);
    }finally{db.exec('ROLLBACK');db.close();}
    if(!this.accepting)throw new Error('secretary_control_closing');
    const state=await this.view(f,original),directory=original.directory;
    if(!this.active.has(directory)&&!['completed','closed_unstarted'].includes(state.phase)){
      const work=runSecretary(join(directory,'input-plan.json'),join(directory,'execution')).then(result=>{save(join(directory,'controller-return.json'),{completed:true,sessionId:result.sessionId,turnId:result.turnId,reportSha256:hash(result.report),newModelTasks:result.newModelTasks});},e=>{save(join(directory,'controller-return.json'),{completed:false,reason:errorCode(e),automaticResend:false});}).catch(e=>{this.problems.set(directory,errorCode(e));}).finally(()=>this.active.delete(directory));this.active.set(directory,work);
    }
    return {accepted:true,requestId:original.request.requestId,registrationIsNotDelivery:true,state:await this.view(f,original)};
  }
  async closeUnstarted(source:string,id:string){const f=this.selected(source),original=await this.original(f,this.directory(f,id));if(this.active.has(original.directory))throw new Error('secretary_original_controller_active');return closeUnstartedSecretary(join(original.directory,'execution'));}
  async drain(){this.accepting=false;while(this.preparing.size||this.active.size)await Promise.allSettled([...this.preparing,...this.active.values()]);}
}
