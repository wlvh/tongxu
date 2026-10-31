import {additionalPrograms,isAdditionalProgram,aiPrograms,type AIProgram} from './ai-programs.js';
import {probeAdditionalProgram} from './additional-cli.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdir,readdir,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter,dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {executable,LiveProcess,newStage,save} from './live-process.js';
import {codexConversation,claudeConversation,claudeMetadata,type CliTool} from './cli-capabilities.js';
import {disabledFeatures,checkConfig} from './live-codex.js';
import {hash,privateDirectory} from './snapshot.js';
import {externalExecutableFamily,externalEntrypoint} from './external-executable.js';

const exec=promisify(execFile);
export type AIModel={id:string;resolvedId:string|null;name:string;description:string;efforts:string[];defaultEffort:string|null;isDefault:boolean};
export type AIProvider={id:string;tool:AIProgram;path:string;installed?:boolean;version:string|null;available:boolean;reason:string|null;authentication:'subscription'|'not_logged_in'|'other'|'unknown'|'existing_account';models:AIModel[];defaults?:{model:string|null;effort:string|null;source:'codex_config_read'};observedAt:string;capabilities:{readonlyMessages:boolean;scopedTools:boolean;ownedControl:boolean;controlledReports?:boolean;impactReports?:boolean};evidence:string};
export type AIModelChoice={model:string;effort:string|null};
export type AICatalogConfig={root:string;configured:Array<{tool:AIProgram;path:string}>};
const word=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!v.startsWith('-')&&!/[\x00-\x20]/.test(v);
const label=(v:unknown,fallback:string)=>typeof v==='string'?v.slice(0,1024):fallback;
export function parseAIModels(tool:CliTool,rows:unknown):AIModel[]{
  if(!Array.isArray(rows)||rows.length>512)throw new Error('ai_model_catalog_invalid');
  const models:AIModel[]=[],ids=new Set<string>();
  for(const row of rows){
    const id=tool==='codex'?row?.model??row?.id:row?.value;
    if(!word(id)||ids.has(id))throw new Error('ai_model_catalog_invalid');ids.add(id);
    if(row.hidden===true)continue;
    const efforts=tool==='codex'?(row.supportedReasoningEfforts??[]).map((e:any)=>e.reasoningEffort):row.supportedEffortLevels??[];
    if(!Array.isArray(efforts)||efforts.length>16||efforts.some(e=>!word(e))||new Set(efforts).size!==efforts.length)throw new Error('ai_effort_catalog_invalid');
    const defaultEffort=tool==='codex'?row.defaultReasoningEffort??null:null;
    if(defaultEffort!==null&&!efforts.includes(defaultEffort))throw new Error('ai_effort_catalog_invalid');
    models.push({id,resolvedId:word(row.resolvedModel)?row.resolvedModel:null,name:label(row.displayName,id),description:label(row.description,''),efforts,defaultEffort,isDefault:row.isDefault===true});
  }
  return models;
}
export function validateModelChoice(value:unknown):asserts value is AIModelChoice{
  const v=value as AIModelChoice;if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='effort,model'||!word(v.model)||!(v.effort===null||word(v.effort)))throw new Error('ai_model_choice_invalid');
}
export function requireModelChoice(models:AIModel[],choice:AIModelChoice){validateModelChoice(choice);const model=models.find(m=>m.id===choice.model);if(!model)throw new Error('ai_model_no_longer_available');if(choice.effort!==null&&!model.efforts.includes(choice.effort))throw new Error('ai_effort_not_supported');return model;}
export const codexDiscoveryArgs=(disabled:string[]=[])=>[...disabledFeatures.flatMap(name=>['-c',`features.${name}=false`]),...disabled.map(name=>{if(!/^[-\w]+$/.test(name))throw new Error('invalid_mcp_name');return ['-c',`mcp_servers.${name}.enabled=false`];}).flat(),'-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','model_provider="openai"','-c','service_tier="default"','app-server','--listen','stdio://'];
export async function codexModelList(request:(method:string,params:any)=>Promise<any>){
  const rows:any[]=[],seen=new Set<string>();let cursor:string|null=null;
  for(let page=0;page<16;page++){const response=await request('model/list',{limit:50,includeHidden:false,...(cursor?{cursor}:{})});if(!Array.isArray(response?.data))throw new Error('ai_model_catalog_invalid');rows.push(...response.data);if(rows.length>512)throw new Error('ai_model_catalog_limit');if(response.nextCursor==null)return parseAIModels('codex',rows);if(typeof response.nextCursor!=='string'||!response.nextCursor||response.nextCursor.length>4096||response.nextCursor.includes('\0')||seen.has(response.nextCursor))throw new Error('ai_model_catalog_pagination_invalid');cursor=response.nextCursor;seen.add(cursor!);}
  throw new Error('ai_model_catalog_limit');
}
/** Metadata only: initialize/account/model catalog. Never thread/start,
 * turn/start, prompt, login, install, or credential copying. */
export async function inspectAIProvider(tool:AIProgram,path:string,directory:string,disabledMcpServers:string[]=[]):Promise<AIProvider>{
  if(isAdditionalProgram(tool))return probeAdditionalProgram(tool,path,directory);
  const result:AIProvider={id:hash(JSON.stringify([tool,externalExecutableFamily(path)])).slice(0,24),tool,path,version:null,available:false,reason:null,authentication:'unknown',models:[],observedAt:new Date().toISOString(),capabilities:{readonlyMessages:false,scopedTools:false,ownedControl:false},evidence:directory};
  await newStage(directory);let rpc:LiveProcess|undefined;
  try{
    const observedVersion=await exec(externalEntrypoint(path),['--version'],{timeout:10000,maxBuffer:16384,env:{...process.env,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});result.version=observedVersion.stdout.trim().slice(0,256);
    const identity=await executable(path,tool==='codex'?{...codexConversation,methods:[...codexConversation.methods!,'model/list']}:claudeConversation,'native_capture');result.version=identity.version;save(join(directory,'executable.json'),identity);
    if(tool==='codex'){
      const cwd=join(directory,'workspace');await mkdir(cwd,{mode:0o700});rpc=new LiveProcess(directory,path,codexDiscoveryArgs(disabledMcpServers),cwd,process.env,undefined,identity.externalSelection);
      await rpc.request('initialize',{clientInfo:{name:'tongxu-local-ai-catalog',version:'0.1.0'},capabilities:{experimentalApi:true}});rpc.send({method:'initialized',params:{}});
      const account=await rpc.request('account/read',{refreshToken:false});result.authentication=account.account?.type==='chatgpt'?'subscription':account.account==null?'not_logged_in':'other';
      result.models=await codexModelList((m,p)=>rpc!.request(m,p));
      const config=await rpc.request('config/read',{includeLayers:false,cwd});checkConfig(config.config);
      result.defaults={model:word(config.config.model)?config.config.model:null,effort:word(config.config.model_reasoning_effort)?config.config.model_reasoning_effort:null,source:'codex_config_read'};
      const packageRoot=resolve(dirname(identity.realpath),'../../..'),host=join(packageRoot,'bin','codex-code-mode-host');let scopedTools=false;
      if(identity.realpath===join(packageRoot,'CodexCLI.app/Contents/MacOS/codex'))try{await access(host,constants.X_OK);scopedTools=true;}catch{}
      result.capabilities={readonlyMessages:true,scopedTools,ownedControl:(identity.capabilities as any).optionalProfiles?.ownedControl===true,controlledReports:true,impactReports:false};
    }else{
      const auth=await exec(identity.realpath,['auth','status','--json'],{timeout:15000,maxBuffer:256*1024,env:{...process.env,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}).then(r=>JSON.parse(r.stdout),()=>null);
      result.authentication=auth?.loggedIn&&auth.authMethod==='claude.ai'&&auth.apiProvider==='firstParty'?'subscription':auth?.loggedIn?'other':auth?.loggedIn===false?'not_logged_in':'unknown';
      const metadata=(identity.capabilities as any).initialization??await claudeMetadata(identity.realpath,process.env);result.models=parseAIModels('claude',metadata.models);
      save(join(directory,'catalog-metadata.json'),{reportedVersion:metadata.reportedVersion,rawResponseSha256:metadata.rawResponseSha256,models:metadata.models,rawOutput:metadata.rawOutput,userMessagesSent:0});
      result.capabilities={readonlyMessages:true,scopedTools:false,ownedControl:false,controlledReports:false,impactReports:true};
    }
    result.available=result.models.length>0&&result.authentication==='subscription';result.reason=result.available?null:result.authentication!=='subscription'?'ai_subscription_not_confirmed':'ai_model_catalog_empty';
  }catch(e){result.reason=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'ai_probe_unavailable';}
  finally{await rpc?.close();}
  save(join(directory,'catalog.json'),result);return result;
}
export async function discoverAIEntries(configured:AICatalogConfig['configured']):Promise<AICatalogConfig['configured']>{
  const entries=[...configured];const add=(tool:AIProgram,path:string)=>{if(isAbsolute(path)&&resolve(path)===path&&!entries.some(e=>e.tool===tool&&externalExecutableFamily(e.path)===externalExecutableFamily(path)))entries.push({tool,path});};
  for(const tool of aiPrograms){for(const dir of (process.env.PATH??'').split(delimiter).filter(isAbsolute))add(tool,join(dir,tool));for(const dir of ['.local/bin','.bun/bin','.npm-global/bin','/opt/homebrew/bin','/usr/local/bin'])add(tool,join(isAbsolute(dir)?dir:join(homedir(),dir),tool));}
  add('kimi',join(homedir(),'.kimi-code/bin/kimi'));add('opencode',join(homedir(),'.opencode/bin/opencode'));add('claude',join(homedir(),'.claude/local/claude'));add('codex','/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const claudeApp=join(homedir(),'Library/Application Support/Claude/claude-code');
  try{const versions=(await readdir(claudeApp,{withFileTypes:true})).filter(d=>d.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true})).slice(0,3);for(const v of versions)for(const d of (await readdir(join(claudeApp,v.name),{withFileTypes:true})).filter(d=>d.isDirectory()).slice(0,2))add('claude',join(claudeApp,v.name,d.name,'claude.app/Contents/MacOS/claude'));}catch{}
  const found=[];for(const e of entries){try{await access(externalEntrypoint(e.path),constants.X_OK);found.push(e);}catch{}}
  return found.slice(0,16);
}
