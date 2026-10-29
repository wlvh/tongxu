import {cliVersion} from './cli-capabilities.js';
import {resultCliVersion} from './codex-results.js';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { regular, exists, processState } from './repair-workspace.js';
import { readdir } from 'node:fs/promises';
import { checkCapture } from './live-process.js';
import { checkConfig, disabledFeatures } from './live-codex.js';
import { secretaryInstructions, secretarySchema } from './repair-native.js';
import {selectedSecretaryTools} from './secretary-tools.js';
import type { SecretaryPlan } from './secretary.js';
import { hash } from './snapshot.js';

function metadataRequests(directory:string,p:SecretaryPlan,frozen:any){
  const cwd=join(directory,'workspace');let id=0;const request=(method:string,params:any)=>({id:++id,method,params});
  return [
    request('initialize', { clientInfo: { name: (p.taskControls||p.queueActions)?'tongxu-task-secretary':'tongxu-readonly-secretary', version: '0.1.0' }, capabilities: { experimentalApi: true } }),
    { method: 'initialized', params: {} },
    request('account/read', { refreshToken: false }), request('config/read', { includeLayers: false, cwd }), request('account/rateLimits/read', {}),
    request('thread/start', { cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: frozen.system, developerInstructions: secretaryInstructions(!!p.taskControls,!!p.queueActions,p.receptionReports===true,!!p.taskSources), dynamicTools: selectedSecretaryTools(!!p.taskControls,p.deliveryOutcomes===true,p.deliveryReports===true,!!p.workbench,p.scopeFollowupReports===true,!!p.queueActions,p.receptionReports===true,!!p.taskSources), environments: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [cwd] }),
    request('account/rateLimits/read', {})
  ];
}
function verifyLaunch(launch:any,executable:any,directory:string,p:SecretaryPlan){
  const args = disabledFeatures.flatMap(name => ['-c', `features.${name}=${name === 'code_mode_host'}`]);
  for (const name of p.disabledMcpServers) args.push('-c', `mcp_servers.${name}.enabled=false`);
  args.push('-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'model_provider="openai"', '-c', 'service_tier="default"', 'app-server', '--listen', 'stdio://');
  if (launch.command !== p.codexExecutable || launch.cwd !== join(directory,'workspace') || !equal(launch.args, args) || executable.path !== p.codexExecutable || executable.sha256 !== p.codexSha256 || !cliVersion(executable.version,'codex') || p.runtimeSelection&&executable.version!==p.runtimeSelection.observedVersion) throw new Error('secretary_launch_boundary_mismatch');
}

/** Called under the original secretary controller lock. An ended metadata
 * handshake proves zero input only when the complete original stream agrees;
 * a missing final answer, exit code or empty turn list alone is insufficient. */
export async function verifyUnstartedSecretaryCapture(directory:string,p:SecretaryPlan,frozen:any,inputSha256:string,output:string){
  const names=['launch.json','process.json','exit.json','executable.json','expected-requests.json','stdout.ndjson','stdin.ndjson','stderr.txt','capture-status.json','binding.json','thread.json','effective-config.json','reconciled-tools.json'];
  const originals:Record<string,Buffer>={};let size=0;
  for(const name of names){const b=await regular(join(directory,name),1024*1024);size+=b.length;if(size>4*1024*1024)throw new Error('secretary_unstarted_capture_limit');originals[name]=b;}
  const json=(n:string)=>JSON.parse(originals[n]!.toString()),proc=json('process.json'),exit=json('exit.json'),binding=json('binding.json');
  if(!Number.isSafeInteger(proc.pid)||proc.pid<=0||processState(proc.pid)!=='ended'||exit.code!==0||exit.signal!==null)throw new Error('secretary_original_execution_active_or_unknown');
  await checkCapture(directory);verifyLaunch(json('launch.json'),json('executable.json'),directory,p);
  if((await readdir(directory)).some(n=>n==='inputs.json'||n==='completed.json'||n.startsWith('turn-')||n==='native-tool-transports.json')||await exists(join(output,'queries'))&&!((await readdir(join(output,'queries'))).length===0))throw new Error('secretary_original_model_input_registered');
  const frames=(b:Buffer)=>{if(!b.length||b.at(-1)!==10)throw new Error('secretary_original_partial_frame');return new TextDecoder('utf8',{fatal:true}).decode(b).trim().split('\n').map(x=>JSON.parse(x));};
  const sent=frames(originals['stdin.ndjson']!),received=frames(originals['stdout.ndjson']!),prefix=metadataRequests(directory,p,frozen),cwd=join(directory,'workspace');
  if(![prefix.length-1,prefix.length].includes(sent.length)||!equal(sent,prefix.slice(0,sent.length))||!equal(sent,json('expected-requests.json'))||!equal(json('reconciled-tools.json'),[]))throw new Error('secretary_original_model_input_or_protocol_unknown');
  const expectedBinding={schemaVersion:1,protocol:binding.protocol,...(binding.protocol==='codex-app-server/thread-turn-v1'?{runtimeVersion:binding.runtimeVersion}:{}),sourceKind:p.executionKind,role:'secretary',run:output,sessionId:binding.sessionId,threadId:binding.threadId,turnIds:[],workspace:cwd,scopeSource:p.scopeSource,arrangementSource:p.arrangementSource,inputManifestSha256:inputSha256,promptSha256:hash(frozen.system),candidate:p.candidate};
  if(typeof binding.threadId!=='string'||!binding.threadId||typeof binding.sessionId!=='string'||!binding.sessionId||!equal(binding,expectedBinding))throw new Error('secretary_unstarted_binding_changed');
  const replies=new Map<number,any>();
  for(const m of received){
    if(Object.hasOwn(m,'id')){if(m.method||!sent.some(s=>s.id===m.id)||!Object.hasOwn(m,'result')||Object.hasOwn(m,'error')||replies.has(m.id))throw new Error('secretary_unstarted_protocol_unknown');replies.set(m.id,m.result);}
    else if(m.method==='thread/started'){if(!equal(m.params?.thread,json('thread.json').thread))throw new Error('secretary_unstarted_thread_changed');}
    else if(m.method==='thread/status/changed'){if(m.params?.threadId!==binding.threadId||m.params?.status?.type!=='idle')throw new Error('secretary_unstarted_thread_active');}
    else if(m.method!=='account/rateLimits/updated')throw new Error('secretary_unstarted_protocol_unknown');
  }
  const thread=replies.get(5),t=thread?.thread;
  if(replies.size!==sent.length-1||replies.get(2)?.account?.type!=='chatgpt'||replies.get(4)?.ordinaryUsageAllowed!==true||!equal(replies.get(3),json('effective-config.json'))||!equal(thread,json('thread.json'))||t?.id!==binding.threadId||t?.sessionId!==binding.sessionId||t?.cwd!==cwd||t?.cliVersion!==resultCliVersion(binding)||t?.parentThreadId!=null||t?.forkedFromId!=null||thread.cwd!==cwd||thread.approvalPolicy!=='never'||thread.sandbox?.type!=='readOnly'||thread.sandbox.networkAccess!==false||thread.modelProvider!=='openai'||(thread.instructionSources??[]).some((path:string)=>!p.allowedInstructionSources.some(ref=>ref.path===path)))throw new Error('secretary_unstarted_metadata_changed');
  checkConfig(replies.get(3).config,true);
  return {metadataOnly:true,originalPid:proc.pid,originalProcessEnded:true,modelInputs:0,toolCalls:0,originals:Object.fromEntries(Object.entries(originals).map(([name,b])=>[name,{sha256:hash(b),bytes:b.length}]))};
}

/** Reconstruct policy from the trusted plan, never from expected-requests.json.
 * Hashes preserve bytes; this separately checks the meaning and RPC references. */
export async function verifySecretaryCapture(directory: string, p: SecretaryPlan, frozen: any, binding: any, question: string, observations: any[]) {
  const json = async (name: string) => JSON.parse((await regular(join(directory, name), 16 * 1024 * 1024)).toString());
  const lines = async (name: string) => (await regular(join(directory, name), 16 * 1024 * 1024)).toString().trim().split('\n').map(s => JSON.parse(s));
  const sent = await lines('stdin.ndjson'), received = await lines('stdout.ndjson'), cwd = join(directory, 'workspace');
  const inputs = [{ input: question, subjectCandidate: p.candidate, schema: secretarySchema }];
  if (!['codex-app-server/0.163.0-alpha.10.2','codex-app-server/thread-turn-v1'].includes(binding.protocol) || binding.sourceKind !== p.executionKind || binding.scopeSource !== p.scopeSource || binding.arrangementSource !== p.arrangementSource || binding.promptSha256 !== hash(JSON.stringify({ system: frozen.system, inputs })) || !equal(await json('inputs.json'), inputs)) throw new Error('secretary_input_binding_changed');
  const id=7,prefix=[...metadataRequests(directory,p,frozen),{id,method:'turn/start',params:{threadId:binding.threadId,input:[{type:'text',text:question}],approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},effort:'high',outputSchema:secretarySchema}}];
  const replies = new Map<number, any>(), expectedToolReplies: any[] = [];
  for (const m of received) {
    if (!Object.hasOwn(m, 'id')) continue;
    if (!m.method) {
      if (!Number.isSafeInteger(m.id) || m.id < 1 || m.id > id || !Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error') || replies.has(m.id) && !equal(replies.get(m.id), m.result)) throw new Error('secretary_rpc_reply_mismatch');
      replies.set(m.id, m.result); continue;
    }
    const args = m.params, record = observations.find(o => o.request.callId === args?.callId);
    if (m.method !== 'item/tool/call' || !record || args.threadId !== binding.threadId || args.turnId !== binding.turnIds[0] || args.namespace != null || !equal(record.request, { tool: args.tool, arguments: args.arguments, callId: args.callId })) throw new Error('secretary_server_request_mismatch');
    expectedToolReplies.push({ id: m.id, result: record.response });
  }
  if (!equal(sent, [...prefix, ...expectedToolReplies]) || replies.size !== id || binding.workspace !== cwd) throw new Error('secretary_submitted_protocol_changed');
  if (replies.get(2)?.account?.type !== 'chatgpt' || replies.get(4)?.ordinaryUsageAllowed !== true || replies.get(6)?.ordinaryUsageAllowed !== true) throw new Error('secretary_subscription_reply_mismatch');
  checkConfig(replies.get(3)?.config, true);
  const thread = replies.get(5), t = thread?.thread;
  if (!t || t.id !== binding.threadId || t.sessionId !== binding.sessionId || t.cwd !== cwd || t.cliVersion !== resultCliVersion(binding) || t.parentThreadId != null || t.forkedFromId != null || thread.cwd !== cwd || thread.approvalPolicy !== 'never' || thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess !== false || thread.modelProvider !== 'openai' || replies.get(7)?.turn?.id !== binding.turnIds[0]) throw new Error('secretary_native_acceptance_mismatch');
  if ((thread.instructionSources ?? []).some((path: string) => !p.allowedInstructionSources.some(ref => ref.path === path)) || !equal(await json('thread.json'), thread) || !equal(await json('effective-config.json'), replies.get(3))) throw new Error('secretary_metadata_reply_mismatch');
  verifyLaunch(await json('launch.json'),await json('executable.json'),directory,p);
}
