import {AsyncLocalStorage} from 'node:async_hooks';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {exactKeys} from './authority-contract.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {discoverAIEntries,inspectAIProvider,requireModelChoice,type AIProvider,type AIModelChoice,type AICatalogConfig} from './ai-catalog.js';
import {selectExternalExecutable} from './external-executable.js';
import type {MessageParticipant} from './message-contract.js';

export const aiRoles=[
  {id:'secretary',name:'工作秘书',need:'scopedTools',description:'读取当前项目的 Issues、PR 和原任务报告'},
  {id:'issue_owner',name:'任务负责人',need:'readonlyMessages',description:'原任务的分析、联系与综合；写入权限另按原任务执行'},
  {id:'reviewer',name:'独立审核者',need:'readonlyMessages',description:'独立阅读固定材料并返回审核报告'},
  {id:'verifier_fact',name:'事实核实与修复',need:'scopedTools',description:'使用原执行器的受限文件、测试及授权修复工具'},
  {id:'verifier_impact',name:'影响核实者',need:'readonlyMessages',description:'分析已核实问题的影响和修正范围'},
  {id:'acceptance',name:'接收与综合',need:'readonlyMessages',description:'解释证据与汇总结果；不替代本人接受'}
] as const;
export type AIRole=typeof aiRoles[number]['id'];
export type AISettingChoice=AIModelChoice&{providerId:string};
export type AIRuntimeChoice=AIModelChoice&{tool:'codex'|'claude';executable:string;resolvedModel:string|null;settingsRevision:number;role:AIRole;project:{account:number;repository:number;nodeId:string};catalogObservedAt:string};
export type AISettingsConfig=AICatalogConfig&{disabledMcpServers:string[]};
export type AISettingsScope={account:{id:number};repository:{id:number;nodeId:string;fullName:string}};
export type AIPreferenceSnapshot={revision:number;scope:AISettingsScope;roles:Partial<Record<AIRole,AIRuntimeChoice>>;errors?:Partial<Record<AIRole,string>>};
const context=new AsyncLocalStorage<AIPreferenceSnapshot>();
export const withAIPreferences=<T>(snapshot:AIPreferenceSnapshot,fn:()=>T):T=>context.run(structuredClone(snapshot),fn);
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
  private constructor(private config:AISettingsConfig,private db:DatabaseSync,private probe:typeof inspectAIProvider){}
  static async open(config:AISettingsConfig,probe=inspectAIProvider){validateAISettingsConfig(config);await mkdir(config.root,{recursive:true,mode:0o700});await privateDirectory(config.root,false);const file=join(config.root,'settings.sqlite');try{await writeFile(file,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS catalogs(id INTEGER PRIMARY KEY AUTOINCREMENT,observed TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS preferences(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL)');return new AISettings(config,db,probe);}
  private catalog(){const row=this.db.prepare('SELECT body FROM catalogs ORDER BY id DESC LIMIT 1').get() as {body:string}|undefined;return row?JSON.parse(row.body) as AIProvider[]:[];}
  private prefs(scope:AISettingsScope){const row=this.db.prepare('SELECT revision,body FROM preferences WHERE scope=?').get(scopeKey(scope)) as {revision:number;body:string}|undefined;return row?{revision:row.revision,choices:JSON.parse(row.body) as Partial<Record<AIRole,AISettingChoice>>}:{revision:0,choices:{}};}
  state(scope:AISettingsScope){return {roles:aiRoles,catalog:this.catalog().map(({evidence,...p})=>p),...this.prefs(scope),project:scope.repository,scanning:!!this.scanning,modelInputsFromDiscovery:0,appliesTo:'new_unstarted_runs',historicalRunsUnchanged:true};}
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
