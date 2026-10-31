import {AsyncLocalStorage} from 'node:async_hooks';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {exactKeys} from './authority-contract.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {discoverAIEntries,inspectAIProvider,requireModelChoice,validateModelChoice,type AIProvider,type AIModelChoice,type AICatalogConfig} from './ai-catalog.js';
import {selectExternalExecutable} from './external-executable.js';
import {externalExecutableFamily} from './external-executable.js';
import type {MessageParticipant} from './message-contract.js';
import {assembleRolePrompt} from './role-prompts.js';

export const aiRoles=[
  {id:'secretary',name:'工作秘书',need:'scopedTools',description:'读取当前项目的 Issues、PR 和原任务报告'},
  {id:'issue_owner',name:'任务负责人',need:'readonlyMessages',description:'原任务的分析、联系与综合；写入权限另按原任务执行'},
  {id:'reviewer',name:'独立审核者',need:'controlledReports',description:'独立阅读固定材料并返回审核报告'},
  {id:'verifier_fact',name:'事实核实与修复',need:'scopedTools',description:'使用原执行器的受限文件、测试及授权修复工具'},
  {id:'verifier_impact',name:'影响核实者',need:'impactReports',description:'分析已核实问题的影响和修正范围'},
  {id:'acceptance',name:'接收与综合',need:'readonlyMessages',description:'解释证据与汇总结果；不替代本人接受'}
] as const;
export type AIRole=typeof aiRoles[number]['id'];
const aiRoleUsage:Record<AIRole,{view:string;entry:string;interaction:string}>={
  secretary:{view:'secretary',entry:'右侧工作秘书：输入问题并发送',interaction:'读取所选项目的资料、Issues/PR、原接收及协作报告。聊天不会自动启动开发或扩大权限；旧任务秘书仍使用其已固定配置。'},
  issue_owner:{view:'tasks',entry:'任务与报告：选择原任务，再使用已登记的联系或补查入口',interaction:'程序发送该任务的完整材料和前序报告，角色返回完整消息；当前联系角色没有任意文件或命令工具。没有已登记任务时不能仅靠保存设置启动。'},
  reviewer:{view:'retrospective',entry:'判断与复盘：准备并运行已登记的整体复盘；独立再审也由原修复链触发',interaction:'新的独立上下文阅读固定源码和证据并返回判断。该只读审核不持有写入权限，也不把未执行的测试写成本轮实测。'},
  verifier_fact:{view:'tasks',entry:'任务与报告：在对应 RETURN 的核实与修复入口启动',interaction:'原执行器先开放限定文件读取和测试；写入责任及授权成立后才开放替换文件工具。新候选交独立审核，不自批。'},
  verifier_impact:{view:'tasks',entry:'任务与报告：由已启动的核实与修复链交给独立影响角色',interaction:'收到原候选、事实报告和固定材料后独立返回影响报告；该阶段没有写入或任意网络工具。'},
  acceptance:{view:'deliveries',entry:'成果与验收：选择原成果和已登记的验证方案',interaction:'程序装配成果证据，由验收角色解释并返回完整报告；不代替本人接受。这里的选择不修改旧 PR 技术接收器的固定计划。'}
};
export type AISettingChoice=AIModelChoice&{providerId:string};
export type AIRuntimeChoice=AIModelChoice&{tool:'codex'|'claude';executable:string;resolvedModel:string|null;settingsRevision:number;role:AIRole;project:{account:number;repository:number;nodeId:string};catalogObservedAt:string};
export type AISettingsConfig=AICatalogConfig&{disabledMcpServers:string[]};
export type AISettingsScope={account:{id:number};repository:{id:number;nodeId:string;fullName:string}};
export type AIPreferenceSnapshot={revision:number;scope:AISettingsScope;roles:Partial<Record<AIRole,AIRuntimeChoice>>;errors?:Partial<Record<AIRole,string>>};
const context=new AsyncLocalStorage<AIPreferenceSnapshot>();
export const withAIPreferences=<T>(snapshot:AIPreferenceSnapshot,fn:()=>T):T=>context.run(structuredClone(snapshot),fn);
export const currentAIPreferences=(roles?:AIRole[])=>{const snapshot=context.getStore();if(!snapshot)return null;const copy=structuredClone(snapshot);if(roles){copy.roles=Object.fromEntries(Object.entries(copy.roles).filter(([role])=>roles.includes(role as AIRole)));copy.errors=Object.fromEntries(Object.entries(copy.errors??{}).filter(([role])=>roles.includes(role as AIRole)));}return copy;};
/** Only execution preferences cross an owned worker boundary, never authority,
 * credentials, arbitrary arguments or tools. The original consumer still
 * validates repository, role profile, billing and its frozen operation. */
export function parseAIPreferences(value:unknown):AIPreferenceSnapshot{
  const v=value as AIPreferenceSnapshot;
  if(!v||!exactKeys(v,['revision','scope','roles',...(Object.hasOwn(v,'errors')?['errors']:[])])||!Number.isSafeInteger(v.revision)||v.revision<0||!v.scope||!exactKeys(v.scope,['account','repository'])||!exactKeys(v.scope.account,['id'])||!exactKeys(v.scope.repository,['id','nodeId','fullName'])||typeof v.scope.repository.fullName!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(v.scope.repository.fullName))throw new Error('ai_worker_preferences_invalid');
  scopeKey(v.scope);if(typeof v.scope.repository.nodeId!=='string'||v.scope.repository.nodeId.length>256)throw new Error('ai_worker_preferences_invalid');
  if(!v.roles||typeof v.roles!=='object'||Array.isArray(v.roles)||Object.keys(v.roles).some(id=>!aiRoles.some(r=>r.id===id)))throw new Error('ai_worker_preferences_invalid');
  for(const [role,c] of Object.entries(v.roles)){
    if(!c||!exactKeys(c,['tool','executable','model','effort','resolvedModel','settingsRevision','role','project','catalogObservedAt'])||c.role!==role||c.settingsRevision!==v.revision||!['codex','claude'].includes(c.tool)||!path(c.executable)||!(c.resolvedModel===null||typeof c.resolvedModel==='string')||!Number.isFinite(Date.parse(c.catalogObservedAt))||!exactKeys(c.project,['account','repository','nodeId'])||c.project.account!==v.scope.account.id||c.project.repository!==v.scope.repository.id||c.project.nodeId!==v.scope.repository.nodeId)throw new Error('ai_worker_preferences_invalid');
    validateModelChoice({model:c.model,effort:c.effort});
  }
  if(Object.hasOwn(v,'errors')&&(!v.errors||typeof v.errors!=='object'||Array.isArray(v.errors)||Object.keys(v.errors).some(id=>!aiRoles.some(r=>r.id===id))||Object.values(v.errors).some(e=>typeof e!=='string'||!e||e.length>2048||e.includes('\0'))))throw new Error('ai_worker_preferences_invalid');
  return structuredClone(v);
}
export const currentAIChoice=(role:AIRole):AIRuntimeChoice|undefined=>{const c=context.getStore();if(c?.errors?.[role])throw new Error(c.errors[role]);const value=c?.roles[role];return value?structuredClone(value):undefined;};
export function captureRoleAI(roles:AIRole[],repository:string){const selected:Partial<Record<AIRole,AIRuntimeChoice>>={};for(const role of roles){const choice=currentAIChoice(role);if(!choice)continue;if(context.getStore()!.scope.repository.fullName.toLowerCase()!==repository.toLowerCase())throw new Error('ai_settings_outside_project');selected[role]=choice;}return selected;}
export function selectedProviderOptions(choice:AIRuntimeChoice|undefined,tool:'codex'|'claude',fallback:string){if(!choice)return {executable:fallback};if(choice.tool!==tool)throw new Error('ai_selected_provider_not_supported_by_operation');return {executable:choice.executable,aiModel:{model:choice.model,effort:choice.effort}};}
export function participantWithAI(original:MessageParticipant,repository:string){
  const c=context.getStore(),choice=currentAIChoice(original.role);if(!choice)return {participant:original,selection:null};
  if(c!.scope.repository.fullName.toLowerCase()!==repository.toLowerCase())throw new Error('ai_settings_outside_project');
  const selected=selectExternalExecutable(choice.executable);
  const participant:MessageParticipant={...original,tool:choice.tool,executable:choice.executable,executableSha256:selected.sha256,aiModel:{model:choice.model,effort:choice.effort},...(choice.tool==='claude'?{disabledMcpServers:[],allowedInstructionSources:[]}:{})};
  return {participant,selection:choice};
}
export function frozenParticipantMatches(original:MessageParticipant,selection:AIRuntimeChoice,actual:MessageParticipant){
  if(!selection||selection.role!==original.role||!['codex','claude'].includes(selection.tool)||!path(selection.executable))return false;
  const expected={...original,tool:selection.tool,executable:selection.executable,executableSha256:actual.executableSha256,aiModel:{model:selection.model,effort:selection.effort},...(selection.tool==='claude'?{disabledMcpServers:[],allowedInstructionSources:[]}:{})};return canonical(actual)===canonical(expected);
}
const path=(s:unknown):s is string=>typeof s==='string'&&isAbsolute(s)&&resolve(s)===s&&!/[\0\r\n]/.test(s);
export function validateAISettingsConfig(c:unknown):asserts c is AISettingsConfig{
  const v=c as AISettingsConfig;if(!exactKeys(v,['root','configured','disabledMcpServers'])||!path(v.root)||!Array.isArray(v.configured)||v.configured.length>16||v.configured.some(e=>!exactKeys(e,['tool','path'])||!['codex','claude'].includes(e.tool)||!path(e.path))||!Array.isArray(v.disabledMcpServers)||v.disabledMcpServers.some(s=>typeof s!=='string'||!/^[-\w]+$/.test(s)))throw new Error('ai_settings_configuration_invalid');
}
const scopeKey=(s:AISettingsScope)=>{if(!Number.isSafeInteger(s.account.id)||s.account.id<1||!Number.isSafeInteger(s.repository.id)||s.repository.id<1||!s.repository.nodeId)throw new Error('ai_settings_project_invalid');return canonical([s.account.id,s.repository.id,s.repository.nodeId]);};
/** Settings express a local choice of execution program/model. They never
 * supply tools, filesystem permissions, credentials, billing or merge rights. */
export class AISettings{
  private scanning:Promise<AIProvider[]>|undefined;
  private constructor(private config:AISettingsConfig,private db:DatabaseSync,private probe:typeof inspectAIProvider,private secretaryExecutable?:string){}
  static async open(config:AISettingsConfig,probe=inspectAIProvider,secretaryExecutable?:string){validateAISettingsConfig(config);await mkdir(config.root,{recursive:true,mode:0o700});await privateDirectory(config.root,false);const file=join(config.root,'settings.sqlite');try{await writeFile(file,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS catalogs(id INTEGER PRIMARY KEY AUTOINCREMENT,observed TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS preferences(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL)');return new AISettings(config,db,probe,secretaryExecutable);}
  private catalog(){const row=this.db.prepare('SELECT body FROM catalogs ORDER BY id DESC LIMIT 1').get() as {body:string}|undefined;return row?JSON.parse(row.body) as AIProvider[]:[];}
  private prefs(scope:AISettingsScope){const row=this.db.prepare('SELECT revision,body FROM preferences WHERE scope=?').get(scopeKey(scope)) as {revision:number;body:string}|undefined;return row?{revision:row.revision,choices:JSON.parse(row.body) as Partial<Record<AIRole,AISettingChoice>>}:{revision:0,choices:{}};}
  defaultSecretary(){
    if(!this.secretaryExecutable)return null;
    const provider=this.catalog().find(p=>p.tool==='codex'&&externalExecutableFamily(p.path)===externalExecutableFamily(this.secretaryExecutable!));
    return {tool:'codex' as const,path:this.secretaryExecutable,source:'project_secretary_startup' as const,observed:provider?.defaults??null,observedAt:provider?.defaults?provider.observedAt:null,available:provider?.available??false};
  }
  state(scope:AISettingsScope){return {defaults:{secretary:this.defaultSecretary()},roles:aiRoles.map(r=>({...r,...aiRoleUsage[r.id]})),catalog:this.catalog().map(({evidence,...p})=>p),...this.prefs(scope),project:scope.repository,scanning:!!this.scanning,modelInputsFromDiscovery:0,appliesTo:'new_unstarted_runs',historicalRunsUnchanged:true};}
  async prompt(role:string){if(!aiRoles.some(r=>r.id===role))throw new Error('ai_role_not_found');return {role,assembly:await assembleRolePrompt(role as AIRole),meaning:'当前公共边界、角色与固定上游提示全文。每次实际执行还会加入该任务的材料、工具和输出要求，并随原运行保存；此处不是某次历史运行的完整输入。',modelInputs:0};}
  async scan(scope:AISettingsScope){if(!this.scanning){this.scanning=(async()=>{const entries=await discoverAIEntries(this.config.configured),out:AIProvider[]=[];for(const entry of entries){const directory=join(this.config.root,'discovery',randomUUID());await mkdir(join(this.config.root,'discovery'),{recursive:true,mode:0o700});out.push(await this.probe(entry.tool,entry.path,directory,this.config.disabledMcpServers));}this.db.prepare('INSERT INTO catalogs(observed,body) VALUES (?,?)').run(new Date().toISOString(),canonical(out));return out;})().finally(()=>{this.scanning=undefined;});}await this.scanning;return this.state(scope);}
  async change(scope:AISettingsScope,body:unknown){
    const b=body as any;if(!exactKeys(b,['revision','role','choice'])||!Number.isSafeInteger(b.revision)||b.revision<0||!aiRoles.some(r=>r.id===b.role)||!(b.choice===null||exactKeys(b.choice,['providerId','model','effort'])&&typeof b.choice.providerId==='string'))throw new Error('ai_settings_request_invalid');
    if(b.choice!==null)this.resolveChoice(scope,b.role,b.choice,b.revision+1);
    this.db.exec('BEGIN IMMEDIATE');try{const old=this.prefs(scope);if(old.revision!==b.revision)throw new Error('ai_settings_revision_changed');const choices={...old.choices};if(b.choice===null)delete choices[b.role as AIRole];else choices[b.role as AIRole]=b.choice;const revision=old.revision+1;
      this.db.prepare('INSERT INTO preferences VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(scopeKey(scope),revision,canonical(choices));this.db.prepare('INSERT INTO changes(scope,revision,body,at) VALUES (?,?,?,?)').run(scopeKey(scope),revision,canonical({role:b.role,choice:b.choice}),new Date().toISOString());this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}return this.state(scope);
  }
  private resolveChoice(scope:AISettingsScope,role:AIRole,choice:AISettingChoice,revision:number):AIRuntimeChoice{
    const provider=this.catalog().find(p=>p.id===choice.providerId);if(!provider?.available)throw new Error('ai_selected_provider_unavailable');const need=aiRoles.find(r=>r.id===role)!.need;if(!provider.capabilities[need])throw new Error('ai_role_tools_not_supported');const model=requireModelChoice(provider.models,{model:choice.model,effort:choice.effort});return {tool:provider.tool,executable:provider.path,model:choice.model,effort:choice.effort,resolvedModel:model.resolvedId,settingsRevision:revision,role,project:{account:scope.account.id,repository:scope.repository.id,nodeId:scope.repository.nodeId},catalogObservedAt:provider.observedAt};
  }
  snapshot(scope:AISettingsScope):AIPreferenceSnapshot{const p=this.prefs(scope),roles:AIPreferenceSnapshot['roles']={},errors:AIPreferenceSnapshot['errors']={};for(const [role,choice] of Object.entries(p.choices))try{roles[role as AIRole]=this.resolveChoice(scope,role as AIRole,choice,p.revision);}catch(e){errors[role as AIRole]=e instanceof Error?e.message:'ai_selected_provider_unavailable';}return {revision:p.revision,scope:structuredClone(scope),roles,errors};}
  async close(){await this.scanning?.catch(()=>{});this.db.close();}
}
