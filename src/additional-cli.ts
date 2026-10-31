/** Read-only ACP adapters. No account migration, generic shell launcher or
 * permission grants. Each program has an explicit local restriction profile. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,access,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {parse as parseToml} from 'smol-toml';
import {parse as parseJavaScript} from 'acorn';
import {LiveProcess,newStage,save,checkCapture} from './live-process.js';
import {selectExternalExecutable,assertExternalExecutable} from './external-executable.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';
import type {AdditionalProgram} from './ai-programs.js';
import type {AIModel,AIModelChoice,AIProvider} from './ai-catalog.js';

const exec=promisify(execFile);
const word=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<512&&!/[\x00-\x20]/.test(v)&&!v.startsWith('-');
const present=async(p:string)=>access(p).then(()=>true,()=>false);
export function readConfigJson(b:Buffer):any{
  const text=new TextDecoder('utf8',{fatal:true}).decode(b),ast=parseJavaScript('('+text+'\n)',{ecmaVersion:'latest'}) as any;
  const value=(n:any):any=>{if(n?.type==='Literal'&&!n.regex&&n.bigint===undefined)return n.value;if(n?.type==='ArrayExpression')return n.elements.map(value);if(n?.type==='ObjectExpression'){const out:Record<string,any>={};for(const p of n.properties){if(p.type!=='Property'||p.kind!=='init'||p.method||p.computed||p.shorthand||p.key.type!=='Literal'||typeof p.key.value!=='string'||['__proto__','constructor','prototype'].includes(p.key.value)||Object.hasOwn(out,p.key.value))throw Error('external_cli_configuration_invalid');out[p.key.value]=value(p.value);}return out;}throw Error('external_cli_configuration_invalid');};
  if(ast.body.length!==1||ast.body[0].type!=='ExpressionStatement')throw Error('external_cli_configuration_invalid');return value(ast.body[0].expression);
}
const read=async(p:string)=>{const b=await readFile(p);if(b.length>1024*1024)throw Error('external_cli_configuration_limit');return b;};
const overrides=['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_GEMINI_BASE_URL','KIMI_MODEL_NAME','KIMI_CODE_BASE_URL','KIMI_CODE_OAUTH_HOST','KIMI_OAUTH_HOST','KIMI_CODE_CUSTOM_HEADERS','OPENCODE_API_KEY'];
export type ExtraProfile={tool:AdditionalProgram;args:string[];env:Record<string,string>;files:Record<string,string>;configurationSha256:string;auth:'subscription'|'existing_account';allowedModelPrefixes:string[]};
export const extraProfileArgs=(tool:AdditionalProgram,directory:string)=>tool==='gemini'?['--acp','--admin-policy',join(directory,'deny-tools.toml'),'--extensions']:tool==='opencode'?['--pure','acp']:['acp'];
export const extraInitializeParams=()=>({protocolVersion:1,clientInfo:{name:'tongxu-readonly',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true}});
export function extraProfileFiles(tool:AdditionalProgram,directory:string,system:string):Record<string,string>{
  if(tool==='kimi')return {'workspace/.kimi-code/agents/agent.md':'---\nname: agent\noverride: true\ndescription: Tongxu supplied-material reader\ntools: []\nsubagents: []\n---\n'+system+'\n'};
  if(tool==='gemini')return {'system.md':system,'deny-tools.toml':'[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n','gemini-system.json':JSON.stringify({security:{auth:{selectedType:'oauth-personal'}},admin:{mcp:{enabled:false},extensions:{enabled:false},skills:{enabled:false}},hooksConfig:{enabled:false},skills:{enabled:false},tools:{core:[],discoveryCommand:'',callCommand:''},context:{fileName:'TONGXU_NO_IMPORTED_CONTEXT.md'},telemetry:{enabled:false},general:{enableAutoUpdate:false},policyPaths:[join(directory,'deny-tools.toml')]})};
  return {'opencode.json':JSON.stringify({$schema:'https://opencode.ai/config.json',plugin:[],mcp:{},instructions:[],permission:{'*':'deny'},default_agent:'tongxu',agent:{tongxu:{description:'Tongxu supplied-material reader',mode:'primary',prompt:system,tools:{'*':false},permission:{'*':'deny'}}}})};
}


/** Only non-secret metadata is returned or recorded. Authentication stays in
 * the existing CLI's own store; a hash records the observed configuration. */
export async function prepareExtraProfile(tool:AdditionalProgram,directory:string,system:string,fixture=false):Promise<ExtraProfile>{
  const cwd=join(directory,'workspace');await mkdir(cwd,{recursive:true,mode:0o700});await mkdir(join(cwd,'.git'),{recursive:true});
  if(!fixture&&overrides.some(k=>process.env[k]))throw Error('api_billing_override_present');
  const files=extraProfileFiles(tool,directory,system),env:Record<string,string>={};let configurationSha256=hash('explicit-fixture'),auth:ExtraProfile['auth']='subscription',allowedModelPrefixes:string[]=[];
  if(tool==='kimi'){
    if(!fixture){
      const home=process.env.KIMI_CODE_HOME||join(homedir(),'.kimi-code'),raw=await read(join(home,'config.toml')),config=parseToml(raw.toString()) as any;
      if(config.hooks?.length||config.plugins||config.extra_agent_dirs?.length)throw Error('kimi_custom_startup_not_isolated');
      for(const p of ['mcp.json','hooks.json','plugins'])if(await present(join(home,p)))throw Error('kimi_custom_startup_not_isolated');
      const provider=config.providers?.['managed:kimi-code'];
      if(!provider||provider.type!=='kimi'||provider.api_key||provider.api_key_env||provider.env||provider.custom_headers||provider.oauth?.storage!=='file'||provider.oauth?.key!=='oauth/kimi-code'||!['https://api.kimi.com/coding/v1','https://api.kimi.ai/coding/v1'].includes(String(provider.base_url).replace(/\/$/,'')))throw Error('ai_subscription_not_confirmed');
      allowedModelPrefixes=Object.entries(config.models??{}).filter(([,m]:any)=>m.provider==='managed:kimi-code').map(([id])=>id);
      configurationSha256=hash(raw);
    }
    Object.assign(env,{KIMI_CODE_NO_AUTO_UPDATE:'1',KIMI_DISABLE_TELEMETRY:'1',KIMI_DISABLE_CRON:'1',KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT:'0',KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE:'exit'});
  }else if(tool==='gemini'){
    auth='existing_account';
    if(!fixture){const raw=await read(join(homedir(),'.gemini/settings.json'));const config=readConfigJson(raw);if(config.security?.auth?.selectedType!=='oauth-personal'||!await present(join(homedir(),'.gemini/oauth_creds.json')))throw Error('ai_subscription_not_confirmed');configurationSha256=hash(raw);}
    Object.assign(env,{GEMINI_CLI_SYSTEM_SETTINGS_PATH:join(directory,'gemini-system.json'),GEMINI_SYSTEM_MD:join(directory,'system.md'),GEMINI_TELEMETRY_ENABLED:'false'});
  }else{
    // OpenCode's provider bindings vary; only pre-existing OAuth connections
    // may be used. Auth inspection below never prints or copies credentials.
    Object.assign(env,{OPENCODE_CONFIG_CONTENT:files['opencode.json']!,OPENCODE_PURE:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_DEFAULT_PLUGINS:'1',OPENCODE_DISABLE_EXTERNAL_SKILLS:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_LSP_DOWNLOAD:'1',OPENCODE_DISABLE_AUTOCOMPACT:'1'});
  }
  for(const [path,text]of Object.entries(files)){await mkdir(dirname(join(directory,path)),{recursive:true,mode:0o700});await import('node:fs/promises').then(fs=>fs.writeFile(join(directory,path),text,{flag:'wx',mode:0o600}));}
  return {tool,args:extraProfileArgs(tool,directory),env,files:Object.fromEntries(Object.entries(files).map(([p,s])=>[p,hash(s)])),configurationSha256,auth,allowedModelPrefixes};
}
export function acpOptions(options:any[],category:string){const value=options?.find(o=>o.category===category);if(!value||value.type!=='select'||!word(value.id)||!word(value.currentValue))return null;const flatten=(rows:any[]):any[]=>rows.flatMap(o=>Array.isArray(o.options)?flatten(o.options):[o]);const entries=flatten(value.options??[]);if(entries.length>512||entries.some(o=>!word(o.value)||typeof o.name!=='string')||new Set(entries.map(o=>o.value)).size!==entries.length)throw Error('acp_configuration_invalid');return {...value,options:entries};}
export function acpModels(response:any):AIModel[]{
  const o=acpOptions(response.configOptions,'model');const rows=o?o.options.map((x:any)=>({id:x.value,name:x.name})):response.models?.availableModels?.map((x:any)=>({id:x.modelId,name:x.name}));
  if(!Array.isArray(rows)||!rows.length||rows.length>128||rows.some(x=>!word(x.id)||typeof x.name!=='string')||new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('acp_model_catalog_unavailable');
  return rows.map(x=>({id:x.id,resolvedId:null,name:x.name,description:'Program-reported ACP model',efforts:[],defaultEffort:null,isDefault:x.id===(o?.currentValue??response.models.currentModelId)}));
}
export class ExtraCliSession{
  rpc!:LiveProcess;identity:any;profile!:ExtraProfile;session:any;initial:any;options:any[]=[];catalog:AIModel[]=[];readonly submitted:Array<{requestId:number;input:string;model:string;effort:string|null;final:string}>=[];
  private constructor(readonly tool:AdditionalProgram,readonly executable:string,readonly directory:string,readonly fixture:boolean){}
  private choice:AIModelChoice|undefined;
  private system='';
  static async open(tool:AdditionalProgram,executable:string,directory:string,system:string,fixture=false,prepared=false){
    if(!prepared)await newStage(directory);const self=new ExtraCliSession(tool,executable,directory,fixture);
    try{
      self.system=system;self.profile=await prepareExtraProfile(tool,directory,system,fixture);save(join(directory,'profile.json'),self.profile);
      const selected=selectExternalExecutable(executable),version=await exec(selected.realpath,['--version'],{timeout:10000,maxBuffer:16384}),help=await exec(selected.realpath,['--help'],{timeout:10000,maxBuffer:65536});
      if(!version.stdout.trim()||!help.stdout.includes('acp')||tool==='gemini'&&!help.stdout.includes('--admin-policy')||tool==='opencode'&&!help.stdout.includes('--pure'))throw Error('external_cli_acp_capability_missing');
      self.identity={path:executable,realpath:selected.realpath,sha256:selected.sha256,version:version.stdout.trim(),selection:'configured-current-v1',externalSelection:selected,capabilities:{kind:'acp-readonly-v1',source:fixture?'explicit_fixture':'actual_cli_help',helpSha256:hash(help.stdout)}};save(join(directory,'executable.json'),self.identity);
      if(tool==='opencode'&&!fixture){
        const result=await exec(selected.realpath,['--pure','auth','list','--format','json'],{timeout:20000,maxBuffer:256*1024,env:{...process.env,...self.profile.env}}),connections=JSON.parse(result.stdout);
        if(!Array.isArray(connections))throw Error('opencode_billing_route_unknown');
        self.profile.allowedModelPrefixes=connections.filter(p=>word(p.id)&&p.connections?.length&&p.connections.every((c:any)=>c.type==='credential'&&c.method==='oauth'&&!c.status)).map(p=>p.id+'/');
        if(!self.profile.allowedModelPrefixes.length)throw Error('opencode_billing_route_unknown');save(join(directory,'profile.json'),self.profile);
      }
      assertExternalExecutable(selected);
      self.rpc=new LiveProcess(directory,executable,self.profile.args,join(directory,'workspace'),{...process.env,...self.profile.env},undefined,selected,'acp');
      self.initial=await self.rpc.request('initialize',extraInitializeParams());
      if(self.initial?.protocolVersion!==1||typeof self.initial.agentInfo?.name!=='string')throw Error('external_cli_acp_capability_missing');save(join(directory,'initialize.json'),self.initial);
      self.session=await self.rpc.request('session/new',{cwd:join(directory,'workspace'),mcpServers:[]});
      if(!word(self.session?.sessionId))throw Error('acp_session_identity_missing');self.options=self.session.configOptions??[];save(join(directory,'session.json'),self.session);self.catalog=acpModels(self.session);
      if(!fixture)self.catalog=self.catalog.filter(m=>tool==='gemini'||(tool==='kimi'?self.profile.allowedModelPrefixes.includes(m.id):self.profile.allowedModelPrefixes.some(p=>m.id.startsWith(p))));
      if(!self.catalog.length)throw Error('ai_subscription_not_confirmed');
      await self.verifyProfile();
      if(tool==='opencode'){
        const modes=self.session.modes?.availableModes??[];if(!modes.some((m:any)=>m.id==='tongxu'))throw Error('external_cli_readonly_profile_missing');await self.rpc.request('session/set_mode',{sessionId:self.session.sessionId,modeId:'tongxu'});
      }
      return self;
    }catch(e){await self.close();throw e;}
  }
  async select(choice:AIModelChoice){
    if(!this.catalog.some(m=>m.id===choice.model))throw Error('ai_model_no_longer_available');
    const option=acpOptions(this.options,'model');const result=await this.rpc.request(option?'session/set_config_option':'session/set_model',option?{sessionId:this.session.sessionId,configId:option.id,value:choice.model}:{sessionId:this.session.sessionId,modelId:choice.model});
    if(option){this.options=result.configOptions??[];if(acpOptions(this.options,'model')?.currentValue!==choice.model)throw Error('ai_selected_model_not_applied');}
    if(choice.effort!==null){const effort=acpOptions(this.options,'thought_level');if(!effort?.options.some((e:any)=>e.value===choice.effort))throw Error('ai_effort_not_supported');const changed=await this.rpc.request('session/set_config_option',{sessionId:this.session.sessionId,configId:effort.id,value:choice.effort});this.options=changed.configOptions??[];if(acpOptions(this.options,'thought_level')?.currentValue!==choice.effort)throw Error('ai_selected_model_not_applied');}
    save(join(this.directory,'selection.json'),{requested:choice,reportedModel:acpOptions(this.options,'model')?.currentValue??null,reportedEffort:acpOptions(this.options,'thought_level')?.currentValue??null,modelSelectionAcknowledged:true});
    this.choice=structuredClone(choice);
  }
  async models(){
    const rows:AIModel[]=[];for(const model of this.catalog){await this.select({model:model.id,effort:null});const effort=acpOptions(this.options,'thought_level');rows.push({...model,efforts:effort?.options.map((e:any)=>e.value)??[],defaultEffort:effort?.currentValue??null});}return rows;
  }
  async prompt(input:string,timeoutMs:number){
    for(const [p,sha]of Object.entries(this.profile.files))if(hash(await read(join(this.directory,p)))!==sha)throw Error('external_cli_profile_changed');
    await this.verifyProfile();if(this.rpc.failure)throw Error(this.rpc.failure);const index=this.rpc.events.length;
    const result=await this.rpc.request('session/prompt',{sessionId:this.session.sessionId,prompt:[{type:'text',text:input}]},timeoutMs);
    const window=this.rpc.events.slice(index);const parsed=parseAcpPrompt(window,this.session.sessionId,result,this.choice);if(this.rpc.failure)throw Error(this.rpc.failure);await this.verifyProfile();return parsed;
  }
  private async verifyProfile(){
    if(this.fixture||this.tool!=='kimi')return;
    const home=process.env.KIMI_CODE_HOME||join(homedir(),'.kimi-code');
    if(hash(await read(join(home,'config.toml')))!==this.profile.configurationSha256)throw Error('external_cli_configuration_changed');
    const id=this.session.sessionId;if(!/^session_[a-zA-Z0-9-]+$/.test(id))throw Error('external_cli_readonly_profile_missing');
    const paths:string[]=[];for(const entry of await readdir(join(home,'sessions'),{withFileTypes:true})){if(entry.isDirectory()){const p=join(home,'sessions',entry.name,id,'agents/main/wire.jsonl');if(await present(p))paths.push(p);}}
    if(paths.length!==1)throw Error('external_cli_readonly_profile_missing');const raw=await readFile(paths[0]!);if(raw.length>16*1024*1024)throw Error('external_cli_profile_limit');
    const rows=raw.toString().split('\n').filter(Boolean).map(line=>JSON.parse(line)),profile=rows.filter(r=>r.type==='profile.bind'&&r.agentId==='main').at(-1);
    if(!profile||profile.systemPrompt?.trim()!==this.system.trim()||!Array.isArray(profile.activeToolNames)||profile.activeToolNames.length||!Array.isArray(profile.subagents)||profile.subagents.length||!Array.isArray(profile.agentsMdPaths)||profile.agentsMdPaths.length)throw Error('external_cli_readonly_profile_missing');
    save(join(this.directory,'profile-observed.json'),{source:paths[0],profileName:profile.profileName,systemPromptSha256:hash(profile.systemPrompt.trim()),activeToolNames:profile.activeToolNames,subagents:profile.subagents,agentsMdPaths:profile.agentsMdPaths,modelAlias:profile.modelAlias,thinkingEffort:profile.thinkingEffort});
    if(this.choice&&(profile.modelAlias!==this.choice.model||this.choice.effort!==null&&profile.thinkingEffort!==this.choice.effort))throw Error('ai_selected_model_not_applied');
  }
  async close(){if(!this.rpc)return;try{if(this.session?.sessionId&&this.initial?.agentCapabilities?.sessionCapabilities?.close)await this.rpc.request('session/close',{sessionId:this.session.sessionId},3000);}catch{}await this.rpc.close();}
}
export function parseAcpPrompt(events:any[],sessionId:string,result:any,choice?:AIModelChoice){
  if(result?.stopReason!=='end_turn')throw Error('external_cli_incomplete_result');let text='';
  for(const event of events){if(event.method&&event.method!=='session/update')throw Error('external_cli_unexpected_event');if(!event.method)continue;const p=event.params,u=p?.update;if(p?.sessionId!==sessionId)throw Error('external_cli_wrong_session');if(['tool_call','tool_call_update','plan'].includes(u?.sessionUpdate))throw Error('external_cli_tool_boundary_failed');if(u?.sessionUpdate==='config_option_update'&&choice){const model=acpOptions(u.configOptions,'model'),effort=acpOptions(u.configOptions,'thought_level');if(model&&model.currentValue!==choice.model||effort&&choice.effort!==null&&effort.currentValue!==choice.effort)throw Error('ai_selected_model_not_applied');}if(u?.sessionUpdate==='agent_message_chunk'){if(u.content?.type!=='text'||typeof u.content.text!=='string')throw Error('external_cli_nontext_result');text+=u.content.text;}}
  if(!text.trim()||Buffer.byteLength(text)>1024*1024)throw Error('external_cli_final_missing');return text;
}
export async function probeAdditionalProgram(tool:AdditionalProgram,path:string,directory:string):Promise<AIProvider>{
  const result:AIProvider={id:hash(JSON.stringify([tool,path])).slice(0,24),tool,path,version:null,available:false,reason:null,authentication:'unknown',models:[],observedAt:new Date().toISOString(),capabilities:{readonlyMessages:false,scopedTools:false,ownedControl:false,controlledReports:false,impactReports:false},evidence:directory};let session:ExtraCliSession|undefined;
  try{session=await ExtraCliSession.open(tool,path,directory,'Metadata inspection only. No model input is authorized.');result.version=session.identity.version;result.models=await session.models();result.authentication=session.profile.auth;result.available=true;result.capabilities.readonlyMessages=true;}
  catch(e){result.reason=e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'external_cli_probe_unavailable';}
  finally{await session?.close();}
  save(join(directory,'catalog.json'),result);return result;
}
