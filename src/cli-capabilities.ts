import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from './snapshot.js';
import {randomUUID} from 'node:crypto';

const exec=promisify(execFile);
export type CliTool='codex'|'claude';
export type CliRequirement={tool:CliTool;methods?:string[]};
export const codexConversation:CliRequirement={tool:'codex',methods:['initialize','account/read','account/rateLimits/read','config/read','thread/start','turn/start']};
export const claudeConversation:CliRequirement={tool:'claude'};
export function cliVersion(identity:string,tool:CliTool){
  const match=(tool==='codex'?/^codex-cli ([^\s\x00-\x1f]{1,128})$/:/^([^\s\x00-\x1f]{1,128}) \(Claude Code\)$/).exec(identity);
  if(!match)throw new Error(tool+'_identity_not_observed');return match[1]!;
}
const missing=(tool:CliTool,capability:string):never=>{throw new Error(tool+'_capability_missing_'+capability.replace(/[^a-z0-9]/gi,'_').toLowerCase());};
const parameters:Record<string,string[]>={
  initialize:['clientInfo','capabilities'],
  'account/read':['refreshToken'], 'account/rateLimits/read':[], 'config/read':['includeLayers','cwd'],
  'thread/start':['cwd','ephemeral','approvalPolicy','sandbox','baseInstructions','developerInstructions','dynamicTools','environments','selectedCapabilityRoots','runtimeWorkspaceRoots'],
  'thread/read':['threadId','includeTurns'],
  'thread/resume':['threadId','cwd','approvalPolicy','sandbox','excludeTurns','runtimeWorkspaceRoots'],
  'turn/start':['threadId','input','approvalPolicy','sandboxPolicy','effort','outputSchema'],
  'turn/steer':['threadId','input','expectedTurnId'], 'turn/interrupt':['threadId','turnId']
};
function schemaNode(root:any,node:any):any{
  if(node?.$ref?.startsWith('#/definitions/'))return root.definitions?.[node.$ref.slice(14)];
  if(node?.anyOf)return node.anyOf.map((x:any)=>schemaNode(root,x)).find((x:any)=>x?.type!=='null');
  return node;
}
/** The CLI exports its own request schema. Version labels do not select this
 * contract. Effective permissions and all reply/result fields are additionally
 * checked by the existing live transport before any result can be consumed. */
export function inspectCodexCapabilities(schema:any,methods:string[]){
  if(!Array.isArray(schema?.oneOf)||!schema.definitions)missing('codex','request_schema');
  const observed:Record<string,string[]>={};
  for(const method of methods){
    const matches=schema.oneOf.filter((x:any)=>x?.properties?.method?.enum?.includes(method));
    if(matches.length!==1)missing('codex',method);
    const node=schemaNode(schema,matches[0].properties.params),fields=Object.keys(node?.properties??{});
    for(const field of parameters[method]??[])if(!fields.includes(field))missing('codex',method+'_'+field);
    observed[method]=fields;
  }
  return {kind:'codex-app-server-thread-turn-v1' as const,methods:observed};
}
const claudeFlags=['--safe-mode','--setting-sources','--tools','--permission-mode','--strict-mcp-config','--mcp-config','--no-chrome','--no-session-persistence','--disable-slash-commands','--output-format','--verbose','--system-prompt','--input-format','--replay-user-messages','--session-id'];
export function inspectClaudeCapabilities(help:string){
  // Some current releases hide --verbose from help. The metadata-only
  // initialization below still passes it and must actually succeed; an
  // unsupported flag fails there instead of trusting a version label.
  for(const flag of claudeFlags)if(flag!=='--verbose'&&!new RegExp('(^|[\\s,])'+flag+'(?=[\\s,=<\\[]|$)','m').test(help))missing('claude',flag);
  return {kind:'claude-stream-command-v1' as const,flags:claudeFlags};
}
export async function claudeMetadata(path:string,env:NodeJS.ProcessEnv){
  const directory=await mkdtemp(join(tmpdir(),'tongxu-claude-capability-'));
  const request={type:'control_request',request_id:'tongxu-capabilities',request:{subtype:'initialize'}};
  const args=['-p','--safe-mode','--setting-sources','','--tools','','--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--no-session-persistence','--disable-slash-commands','--output-format','stream-json','--verbose','--system-prompt','Metadata initialization only; no user work or model turn.','--input-format','stream-json','--replay-user-messages','--session-id',randomUUID()];
  try{
    const stdout=await new Promise<string>((resolve,reject)=>{
      const child=execFile(path,args,{cwd:directory,env,timeout:15000,maxBuffer:2*1024*1024},(error,stdout)=>error?reject(new Error('claude_capability_initialization_unavailable')):resolve(stdout));
      child.stdin?.end(JSON.stringify(request)+'\n');
    });
    const events=stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
    if(events.length!==1||events[0]?.type!=='control_response')missing('claude','zero_input_initialization');
    const response=events[0].response,value=response?.response;
    if(response?.subtype!=='success'||response.request_id!==request.request_id||!Array.isArray(response.pending_permission_requests)||response.pending_permission_requests.length||!Array.isArray(response.pending_user_dialog_requests)||response.pending_user_dialog_requests.length||value?.current_permission_mode!=='dontAsk'||value.session_state!=='idle'||value.fast_mode_state!=='off'||!Array.isArray(value.commands)||value.commands.length||typeof value.claude_code_version!=='string')missing('claude','restricted_initialization');
    return {request,rawResponseSha256:hash(stdout),rawOutput:stdout,reportedVersion:value.claude_code_version,permissionMode:value.current_permission_mode,sessionState:value.session_state,fastMode:value.fast_mode_state,userMessagesSent:0,models:value.models??[],account:value.account??null};
  }finally{await rm(directory,{recursive:true,force:true});}
}
export async function probeCliCapabilities(path:string,requirement:CliRequirement,executionKind:'fixture'|'native_capture'){
  // Fixtures exercise the same live metadata/result checks. They are never
  // presented as proof of an installed vendor CLI or production permissions.
  if(executionKind==='fixture')return {kind:requirement.tool==='codex'?'codex-app-server-thread-turn-v1':'claude-stream-command-v1',source:'explicit_fixture',methods:requirement.methods??[]};
  const overrideKeys=requirement.tool==='codex'?['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL']:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'];
  if(overrideKeys.some(key=>process.env[key]))throw new Error('api_billing_override_present');
  const env={...process.env,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const help=await exec(path,['--help'],{timeout:15000,maxBuffer:2*1024*1024,env});
  if(requirement.tool==='claude')return {...inspectClaudeCapabilities(help.stdout),source:'actual_cli_help',helpSha256:hash(help.stdout),initialization:await claudeMetadata(path,env)};
  const directory=await mkdtemp(join(tmpdir(),'tongxu-cli-schema-'));
  try{
    await exec(path,['app-server','generate-json-schema','--experimental','--out',directory],{timeout:30000,maxBuffer:2*1024*1024,env});
    const raw=await readFile(join(directory,'ClientRequest.json'));if(raw.length>16*1024*1024)missing('codex','bounded_request_schema');
    const schema=JSON.parse(raw.toString());let ownedControl=false;try{inspectCodexCapabilities(schema,['thread/read','thread/resume','turn/steer','turn/interrupt']);ownedControl=true;}catch{}
    return {...inspectCodexCapabilities(schema,requirement.methods??codexConversation.methods!),optionalProfiles:{ownedControl},source:'actual_cli_schema',helpSha256:hash(help.stdout),requestSchemaSha256:hash(raw)};
  }finally{await rm(directory,{recursive:true,force:true});}
}
/** The configured path is the approved entry; its long-lived fingerprint is
 * historical setup data. A new run records the actually selected executable.
 * Original captures without this selection contract retain their old binding. */
export function capturedExecutableMatches(identity:any,path:string,configuredSha:string){
  if(identity?.path!==path||!/^[a-f0-9]{64}$/.test(identity?.sha256??''))return false;
  return identity.selection==='configured-current-v1'?Boolean(identity.capabilities&&['actual_cli_schema','actual_cli_help','explicit_fixture'].includes(identity.capabilities.source)):identity.sha256===configuredSha;
}
