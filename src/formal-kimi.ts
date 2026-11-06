import {join} from 'node:path';
import {ExtraCliSession,extraProfileFiles,extraProfileArgs,extraInitializeParams,acpOptions,checkAcpSessionEvents,parseAcpPrompt} from './additional-cli.js';
import {checkCapture,save} from './live-process.js';
import {capturedExecutableMatches} from './cli-capabilities.js';
import {regular} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import type {AIModelChoice} from './ai-catalog.js';

type Row=Record<string,any>;
export type FormalKimiRequest={directory:string;executable:string;aiModel:AIModelChoice;system:string;input:string;timeoutMs:number;executionKind:'fixture'|'native_capture'};
export type KimiReceiverRequest=FormalKimiRequest;
const profiles={impact:{kind:'tongxu-formal-kimi-impact',role:'verifier_impact',request:'formal-impact-request.json',completed:'tongxu-formal-kimi-impact-result'},receiver:{kind:'tongxu-kimi-receiver',role:'receiver',request:'receiver-request.json',completed:'tongxu-kimi-receiver-result'}} as const;
type Profile=typeof profiles[keyof typeof profiles];
const binding=(o:FormalKimiRequest,p:Profile)=>({kind:p.kind,role:p.role,executable:o.executable,aiModel:o.aiModel,inputSha256:hash(o.input),systemSha256:hash(o.system),executionKind:o.executionKind});
const invalid=(p:Profile,reason:string)=>Error(p.role==='receiver'?reason.replace(/^formal_/,'receiver_'):reason);
function lines(raw:Buffer){const text=new TextDecoder('utf8',{fatal:true}).decode(raw);if(text&&!text.endsWith('\n'))throw Error('external_cli_incomplete_frame');return text.split('\n').filter(Boolean).map(line=>JSON.parse(line));}

/** This reads a single original formal stage, not a MessagePlan or a second
 * message/resource operation. Existing ACP parsing and capture checks apply. */
async function inspect(o:FormalKimiRequest,p:Profile){
  await checkCapture(o.directory);
  const names=[p.request,'input.txt','system.txt','executable.json','launch.json','process.json','exit.json','capture-status.json','stdin.ndjson','stdout.ndjson','stderr.txt','profile.json','initialize.json','session.json','selection.json','prompt-boundaries.ndjson',...Object.keys(extraProfileFiles('kimi',o.directory,o.system)),...(o.executionKind==='native_capture'?['profile-observed.json']:[])],originals:Record<string,Buffer>={};
  for(const name of names)originals[name]=await regular(join(o.directory,name),16*1024*1024);
  const read=(name:string)=>JSON.parse(originals[name]!.toString());
  if(canonical(read(p.request))!==canonical(binding(o,p))||originals['input.txt']!.toString()!==o.input||originals['system.txt']!.toString()!==o.system)throw invalid(p,'formal_original_impact_input_changed');
  const exit=read('exit.json'),process=read('process.json'),launch=read('launch.json'),identity=read('executable.json'),profile=read('profile.json'),session=read('session.json'),selection=read('selection.json');
  if(exit.code!==0||exit.signal!==null||!Number.isSafeInteger(process.pid)||process.pid<1||process.status!=='spawn_attempted')throw invalid(p,'formal_kimi_process_unresolved');
  if(!capturedExecutableMatches(identity,o.executable,identity.sha256)||canonical(identity.externalSelection)!==canonical(launch.executableSelection)||launch.command!==o.executable||launch.cwd!==join(o.directory,'workspace')||canonical(launch.args)!==canonical(extraProfileArgs('kimi',o.directory))||canonical(selection.requested)!==canonical(o.aiModel)||profile.tool!=='kimi'||profile.auth!=='subscription')throw invalid(p,'formal_kimi_execution_binding_changed');
  for(const [path,text]of Object.entries(extraProfileFiles('kimi',o.directory,o.system)))if(originals[path]!.toString()!==text||profile.files[path]!==hash(text))throw Error('external_cli_profile_changed');
  if(o.executionKind==='native_capture'){
    const observed=read('profile-observed.json');
    if(observed.systemPromptSha256!==hash(o.system.trim())||!Array.isArray(observed.activeToolNames)||observed.activeToolNames.length||!Array.isArray(observed.subagents)||observed.subagents.length||!Array.isArray(observed.agentsMdPaths)||observed.agentsMdPaths.length||observed.modelAlias!==o.aiModel.model||o.aiModel.effort!==null&&observed.thinkingEffort!==o.aiModel.effort||!profile.allowedModelPrefixes.includes(o.aiModel.model))throw Error('external_cli_readonly_profile_missing');
  }
  const sent=lines(originals['stdin.ndjson']!),received=lines(originals['stdout.ndjson']!),allowed=['initialize','session/new','session/set_config_option','session/set_model','session/prompt','session/close'];
  if(sent.some((r,i)=>r.jsonrpc!=='2.0'||r.id!==i+1||!allowed.includes(r.method))||sent.filter(r=>r.method==='initialize').length!==1||sent.filter(r=>r.method==='session/new').length!==1)throw Error('external_cli_unregistered_request');
  const response=(r:Row)=>{const rows=received.filter(m=>m.id===r.id&&!m.method);if(rows.length!==1||rows[0].error||!Object.hasOwn(rows[0],'result'))throw Error('external_cli_response_missing');return rows[0];};sent.forEach(response);
  if(received.some(r=>r.jsonrpc!=='2.0'||r.method&&Object.hasOwn(r,'id')||!r.method&&!sent.some(q=>q.id===r.id)))throw Error('external_cli_unregistered_request');
  const initialize=sent.find(r=>r.method==='initialize')!,start=sent.find(r=>r.method==='session/new')!;
  if(sent[0]!==initialize||canonical(initialize.params)!==canonical(extraInitializeParams())||canonical(response(initialize).result)!==canonical(read('initialize.json'))||canonical(response(start).result)!==canonical(session)||canonical(start.params)!==canonical({cwd:join(o.directory,'workspace'),mcpServers:[]})||typeof session.sessionId!=='string')throw Error('external_cli_initialize_changed');
  checkAcpSessionEvents(received,session.sessionId);
  for(const request of sent)if(request.method.startsWith('session/')&&request.method!=='session/new'&&request.params?.sessionId!==session.sessionId)throw Error('external_cli_wrong_session');
  const prompts=sent.filter(r=>r.method==='session/prompt'),boundaries=lines(originals['prompt-boundaries.ndjson']!);
  if(prompts.length!==1||boundaries.length!==1)throw invalid(p,'formal_kimi_single_original_input_required');
  const prompt=prompts[0]!,boundary=boundaries[0]!,end=received.indexOf(response(prompt)),rawOutput=originals['stdout.ndjson']!,rawInput=originals['stdin.ndjson']!;
  if(canonical(prompt.params)!==canonical({sessionId:session.sessionId,prompt:[{type:'text',text:o.input}]})||boundary.schemaVersion!==1||boundary.requestId!==prompt.id||boundary.requestSha256!==hash(JSON.stringify(prompt)+'\n')||!Number.isSafeInteger(boundary.stdoutBytes)||boundary.stdoutBytes<0||boundary.stdoutBytes>rawOutput.length||!Number.isSafeInteger(boundary.stdinBytes)||boundary.stdinBytes<0||boundary.stdinBytes>rawInput.length)throw Error('external_cli_input_boundary_changed');
  const outputPrefix=rawOutput.subarray(0,boundary.stdoutBytes),inputPrefix=rawInput.subarray(0,boundary.stdinBytes),prefix=lines(outputPrefix);
  if(hash(outputPrefix)!==boundary.stdoutSha256||hash(inputPrefix)!==boundary.stdinSha256||boundary.stdoutEvents!==prefix.length||boundary.stdoutEvents<=received.indexOf(response(start))||boundary.stdoutEvents>end||rawInput.subarray(boundary.stdinBytes).toString().split('\n')[0]!==JSON.stringify(prompt)||prefix.some(r=>r.params?.update?.sessionUpdate==='agent_message_chunk')||received.slice(end+1).some(r=>r.params?.update?.sessionUpdate==='agent_message_chunk'))throw Error('external_cli_input_boundary_changed');
  const legacy=!acpOptions(session.configOptions,'model');let model=acpOptions(session.configOptions,'model')?.currentValue??session.models?.currentModelId,effort=acpOptions(session.configOptions,'thought_level')?.currentValue??null,configurationEnd=received.indexOf(response(start));
  for(const request of sent.slice(0,sent.indexOf(prompt))){
    if(request.method==='session/set_model'){if(!legacy)throw Error('external_cli_model_interface_changed');model=request.params.modelId;configurationEnd=received.indexOf(response(request));}
    if(request.method==='session/set_config_option'){const options=response(request).result.configOptions,returned=options?.find((p:Row)=>p.id===request.params.configId);if(returned?.currentValue!==request.params.value)throw Error('ai_selected_model_not_applied');model=acpOptions(options,'model')?.currentValue??(legacy?model:undefined);effort=acpOptions(options,'thought_level')?.currentValue??null;configurationEnd=received.indexOf(response(request));}
  }
  for(const event of received.slice(configurationEnd+1,boundary.stdoutEvents))if(event.params?.update?.sessionUpdate==='config_option_update'){const options=event.params.update.configOptions;model=acpOptions(options,'model')?.currentValue??(legacy?model:undefined);effort=acpOptions(options,'thought_level')?.currentValue??null;}
  if(model!==o.aiModel.model||o.aiModel.effort!==null&&effort!==o.aiModel.effort)throw Error('ai_selected_model_not_applied');
  const finalText=parseAcpPrompt(received.slice(boundary.stdoutEvents,end+1),session.sessionId,response(prompt).result,o.aiModel);
  return {sessionId:session.sessionId,requestId:prompt.id,finalText,finalSha256:hash(finalText),inputSha256:hash(o.input),systemPromptSha256:hash(o.system),rawSha256:hash(rawOutput),protocol:'kimi-acp/1',originals};
}

async function readOriginal(o:FormalKimiRequest,p:Profile){
  const completedBytes=await regular(join(o.directory,'completed.json')),completed=JSON.parse(completedBytes.toString()),checked=await inspect(o,p);
  if(completed.kind!==p.completed||completed.bindingSha256!==hash(canonical(binding(o,p)))||completed.finalSha256!==checked.finalSha256||completed.sessionId!==checked.sessionId||completed.requestId!==checked.requestId||p.role==='receiver'&&(completed.finalText!==checked.finalText||completed.inputSha256!==checked.inputSha256||completed.systemPromptSha256!==checked.systemPromptSha256)||canonical(completed.originals)!==canonical(Object.fromEntries(Object.entries(checked.originals).map(([name,b])=>[name,hash(b)]))))throw invalid(p,'formal_kimi_completed_capture_changed');
  const originals:Record<string,Buffer>={...checked.originals,'completed.json':completedBytes};return {...checked,originals};
}

async function runOriginal(o:FormalKimiRequest,p:Profile,refreshBeforeDispatch:()=>Promise<void>,beforeSendSync:()=>void,dispatchGate?:<T>(effect:()=>T)=>T){
  let session:ExtraCliSession|undefined;
  try{
    session=await ExtraCliSession.open('kimi',o.executable,o.directory,o.system,o.executionKind==='fixture');
    save(join(o.directory,p.request),binding(o,p));
    const {writeFile}=await import('node:fs/promises');await writeFile(join(o.directory,'input.txt'),o.input,{flag:'wx',mode:0o600});await writeFile(join(o.directory,'system.txt'),o.system,{flag:'wx',mode:0o600});
    await session.select(o.aiModel);const result=await session.prompt(o.input,o.timeoutMs,beforeSendSync,refreshBeforeDispatch,dispatchGate);session.assertCanForward();await session.close();
    const checked=await inspect(o,p);if(checked.finalText!==result.final||checked.requestId!==result.requestId||checked.sessionId!==session.session.sessionId)throw invalid(p,'formal_kimi_final_capture_changed');
    save(join(o.directory,'completed.json'),{kind:p.completed,bindingSha256:hash(canonical(binding(o,p))),sessionId:checked.sessionId,requestId:checked.requestId,finalSha256:checked.finalSha256,...(p.role==='receiver'?{finalText:checked.finalText,inputSha256:checked.inputSha256,systemPromptSha256:checked.systemPromptSha256}:{}),originals:Object.fromEntries(Object.entries(checked.originals).map(([name,b])=>[name,hash(b)]))});
    return await readOriginal(o,p);
  }finally{await session?.close();}
}

// Only these two original consumers select a profile; plans cannot supply an
// arbitrary role or reinterpret one role's completed capture as another's.
export const readFormalKimiImpact=(o:FormalKimiRequest)=>readOriginal(o,profiles.impact);
export const runFormalKimiImpact=(o:FormalKimiRequest,refresh:()=>Promise<void>,before:()=>void)=>runOriginal(o,profiles.impact,refresh,before);
export const readKimiReceiver=(o:KimiReceiverRequest)=>readOriginal(o,profiles.receiver);
export const runKimiReceiver=(o:KimiReceiverRequest,refresh:()=>Promise<void>,before:()=>void,gate?:<T>(effect:()=>T)=>T)=>runOriginal(o,profiles.receiver,refresh,before,gate);
