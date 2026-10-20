import { mkdir } from 'node:fs/promises';
import { join,isAbsolute,resolve } from 'node:path';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { regular } from './repair-workspace.js';
import { disabledFeatures,checkConfig } from './live-codex.js';
import { executable,LiveProcess,newStage,save,checkCapture } from './live-process.js';

export type SessionReadSpec={schemaVersion:1;kind:'tongxu-exact-codex-session-read';executable:string;executableSha256:string;threadId:string;sessionId:string|null;workspace:string|null;disabledMcpServers:string[];executionKind:'fixture'|'native_capture'};
type Row=Record<string,any>;
export type SessionObservation={spec:SessionReadSpec;directory:string;observedAt:string;metadata:Row|null;gap:string|null;reader:Row;originals:Record<string,Buffer>;replayed:boolean;modelRequestsSent:0;unexpectedExecutionObserved:boolean;controlPermissionGranted:false};
const issued=new WeakMap<object,string>(),digest=/^[a-f0-9]{64}$/;
const nativeId=(value:unknown):value is string=>typeof value==='string'&&/^[-A-Za-z0-9_.:]{1,128}$/.test(value);
const absolutePath=(value:unknown):value is string=>typeof value==='string'&&!value.includes('\0')&&isAbsolute(value)&&resolve(value)===value;
const key=(s:SessionObservation)=>hash(canonical({...s,originals:Object.fromEntries(Object.entries(s.originals).map(([name,bytes])=>[name,{sha256:hash(bytes),bytes:bytes.length}]))}));
export function parseSessionReadSpec(bytes:Buffer):SessionReadSpec{
  const s=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  if(!s||Object.keys(s).sort().join()!=='disabledMcpServers,executable,executableSha256,executionKind,kind,schemaVersion,sessionId,threadId,workspace'||s.schemaVersion!==1||s.kind!=='tongxu-exact-codex-session-read'||!digest.test(s.executableSha256)||!['fixture','native_capture'].includes(s.executionKind)||!Array.isArray(s.disabledMcpServers)||s.disabledMcpServers.length>30||new Set(s.disabledMcpServers).size!==s.disabledMcpServers.length||s.disabledMcpServers.some((x:unknown)=>typeof x!=='string'||!/^[-\w]+$/.test(x)))throw new Error('session_read_spec_invalid');
  if(!nativeId(s.threadId)||s.sessionId!==null&&!nativeId(s.sessionId))throw new Error('exact_native_session_identity_required');
  if(!absolutePath(s.executable)||s.workspace!==null&&!absolutePath(s.workspace))throw new Error('session_read_absolute_path_required');
  return s;
}
function readerArgs(spec:SessionReadSpec){const args=disabledFeatures.flatMap(name=>['-c',`features.${name}=false`]);for(const name of spec.disabledMcpServers)args.push('-c',`mcp_servers.${name}.enabled=false`);return [...args,'-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','model_provider="openai"','-c','service_tier="default"','app-server','--listen','stdio://'];}
function metadataOf(result:Row,spec:SessionReadSpec){
  const t=result?.thread;if(!t||t.id!==spec.threadId||!nativeId(t.sessionId)||!absolutePath(t.cwd)||spec.sessionId!==null&&t.sessionId!==spec.sessionId||spec.workspace!==null&&t.cwd!==spec.workspace)throw new Error('native_session_metadata_identity_mismatch');
  return {threadId:t.id,sessionId:t.sessionId,workspace:t.cwd,createdWithVersion:typeof t.cliVersion==='string'?t.cliVersion:null,reportedStatus:t.status??null,ephemeral:typeof t.ephemeral==='boolean'?t.ephemeral:null,parentThreadId:t.parentThreadId??null,forkedFromId:t.forkedFromId??null,historyIncluded:false,reportedStatusDoesNotEstablishWriterOwnership:true,capabilities:{readMetadata:'observed',readOriginalCapture:'separate_evidence_required',resume:'not_verified',steer:'not_verified',interrupt:'not_verified',sendTurn:'not_authorized',write:'not_authorized'}};
}
/** This owns only its new metadata reader process. Reading one stored ID does
 * not resume that conversation or establish that its original writer ended. */
export async function readExactCodexSession(spec:SessionReadSpec,directory:string):Promise<SessionObservation>{
  spec=parseSessionReadSpec(Buffer.from(canonical(spec)));await newStage(directory);
  save(join(directory,'read-spec.json'),spec);
  if(hash(await regular(spec.executable,512*1024*1024))!==spec.executableSha256)throw new Error('session_reader_executable_changed');
  const reader=await executable(spec.executable,'codex-cli 0.163.0-alpha.10.2');if(reader.sha256!==spec.executableSha256)throw new Error('session_reader_executable_changed');save(join(directory,'executable.json'),reader);
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])if(process.env[key])throw new Error('api_billing_override_present');
  const cwd=join(directory,'reader-workspace');await mkdir(cwd,{mode:0o700});
  const args=readerArgs(spec);
  const rpc=new LiveProcess(directory,spec.executable,args,cwd,spec.executionKind==='fixture'?{PATH:'/usr/bin:/bin',HOME:cwd}:process.env);let metadata:Row|null=null,gap:string|null=null;
  try{
    await rpc.request('initialize',{clientInfo:{name:'tongxu-exact-session-reader',version:'0.1.0'},capabilities:{experimentalApi:true}});rpc.send({method:'initialized',params:{}});
    // No model or resumed runtime is created. Reading global configuration
    // would collect unrelated projects/settings without proving ownership.
    metadata=metadataOf(await rpc.request('thread/read',{threadId:spec.threadId,includeTurns:false}),spec);
  }catch(e){gap=e instanceof Error?e.message:'native_session_read_unknown';}
  finally{await rpc.close();}
  try{await checkCapture(directory);if(rpc.failure||rpc.exit?.code!==0||rpc.events.some(e=>e.method==='turn/started'||e.method==='item/tool/call'))throw new Error('session_reader_capture_or_boundary_failed');if(hash(await regular(spec.executable,512*1024*1024))!==spec.executableSha256)throw new Error('session_reader_executable_changed');}
  catch(e){metadata=null;gap=e instanceof Error?e.message:'session_reader_capture_unknown';}
  const originals:Record<string,Buffer>={};for(const name of ['read-spec.json','executable.json','launch.json','process.json','stdin.ndjson','stdout.ndjson','stderr.txt','exit.json','capture-status.json'])originals[name]=await regular(join(directory,name),16*1024*1024);
  if(!rpc.failure&&rpc.exit?.code===0)try{const checked=await replaySessionRead(spec,directory);metadata=checked.metadata;gap=checked.gap;}catch(e){metadata=null;gap=e instanceof Error?e.message:'session_reader_transcript_unknown';}
  const observation:SessionObservation={spec,directory,observedAt:new Date().toISOString(),metadata,gap,reader,originals,replayed:false,modelRequestsSent:0,unexpectedExecutionObserved:rpc.events.some(e=>e.method==='turn/started'||e.method==='item/tool/call'),controlPermissionGranted:false};issued.set(observation,key(observation));
  save(join(directory,'session-observation.json'),{...observation,originals:Object.fromEntries(Object.entries(originals).map(([name,b])=>[name,{sha256:hash(b),bytes:b.length}]))});return observation;
}
export function requireSessionObservation(value:SessionObservation,spec:SessionReadSpec){
  if(issued.get(value)!==key(value)||canonical(value.spec)!==canonical(spec)||!value.replayed&&Date.now()-Date.parse(value.observedAt)>300000||Date.parse(value.observedAt)>Date.now()+60000)throw new Error('actual_current_session_read_required');return value;
}
/** Reconsume only an ended, complete original metadata read. This preserves
 * its observation time and sends no native command, even after CLI removal. */
export async function replaySessionRead(spec:SessionReadSpec,directory:string):Promise<SessionObservation>{
  spec=parseSessionReadSpec(Buffer.from(canonical(spec)));await checkCapture(directory);
  const originals:Record<string,Buffer>={};for(const name of ['read-spec.json','executable.json','launch.json','process.json','stdin.ndjson','stdout.ndjson','stderr.txt','exit.json','capture-status.json'])originals[name]=await regular(join(directory,name),16*1024*1024);
  const decode=(name:string)=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(originals[name]!)),lines=(name:string)=>{const raw=originals[name]!;if(!raw.length||raw.at(-1)!==10)throw new Error('session_original_partial_frame');return new TextDecoder('utf8',{fatal:true}).decode(raw).trim().split('\n').map(x=>JSON.parse(x));};
  const reader=decode('executable.json'),launch=decode('launch.json'),exit=decode('exit.json'),cwd=join(directory,'reader-workspace');
  if(canonical(decode('read-spec.json'))!==canonical(spec)||reader.sha256!==spec.executableSha256||reader.path!==spec.executable||reader.realpath!==spec.executable||reader.version!=='codex-cli 0.163.0-alpha.10.2'||launch.command!==spec.executable||launch.cwd!==cwd||canonical(launch.args)!==canonical(readerArgs(spec))||exit.code!==0||exit.signal!==null||!Number.isFinite(Date.parse(exit.at)))throw new Error('session_original_reader_contract_mismatch');
  const sent=lines('stdin.ndjson'),received=lines('stdout.ndjson'),initial=[{id:1,method:'initialize',params:{clientInfo:{name:'tongxu-exact-session-reader',version:'0.1.0'},capabilities:{experimentalApi:true}}},{method:'initialized',params:{}}];
  const current=[...initial,{id:2,method:'thread/read',params:{threadId:spec.threadId,includeTurns:false}}],legacy=[...initial,{id:2,method:'config/read',params:{includeLayers:false,cwd}},{id:3,method:'thread/read',params:{threadId:spec.threadId,includeTurns:false}}],legacyRead=canonical(sent)===canonical(legacy);
  if(canonical(sent)!==canonical(current)&&!legacyRead||received.some((m:Row)=>m.method==='turn/started'||m.method==='item/tool/call'||m.method&&m.id!==undefined))throw new Error('session_original_read_boundary_changed');
  const reply=(id:number)=>{const r=received.filter((m:Row)=>!m.method&&m.id===id);if(r.length!==1||('error'in r[0])===('result'in r[0]))throw new Error('session_original_response_ambiguous');return r[0];};
  if(received.some((m:Row)=>!m.method&&![1,2,...(legacyRead?[3]:[])].includes(m.id)))throw new Error('session_original_unexpected_response');
  if(reply(1).error||legacyRead&&reply(2).error)throw new Error('session_original_initialization_failed');if(legacyRead)checkConfig(reply(2).result.config);
  let metadata:Row|null=null,gap:string|null=null;const last=reply(legacyRead?3:2);
  if(last.error){if(!Number.isInteger(last.error.code)||typeof last.error.message!=='string')throw new Error('session_original_error_invalid');gap='executor_rpc_error';}else try{metadata=metadataOf(last.result,spec);}catch(e){gap=e instanceof Error?e.message:'native_session_read_unknown';}
  const value:SessionObservation={spec,directory,observedAt:exit.at,metadata,gap,reader,originals,replayed:true,modelRequestsSent:0,unexpectedExecutionObserved:false,controlPermissionGranted:false};issued.set(value,key(value));return value;
}
