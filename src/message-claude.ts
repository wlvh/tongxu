import { canonical } from './comparison.js';

type Row=Record<string,any>;
export type MessageClaudeVersion='2.1.233'|'2.1.304';
export const messageClaudeExecutables=['2.1.233 (Claude Code)','2.1.304 (Claude Code)'] as const;
export function messageClaudeVersion(identity:string):MessageClaudeVersion {
  if(identity==='2.1.233 (Claude Code)')return '2.1.233';
  if(identity==='2.1.304 (Claude Code)')return '2.1.304';
  throw new Error('message_claude_unsupported_version');
}
export function checkMessageClaudeInit(init:Row,session:string,version:MessageClaudeVersion){
  if(init.type!=='system'||init.subtype!=='init'||init.session_id!==session||init.claude_code_version!==version||init.permissionMode!=='dontAsk'||init.apiKeySource!=='none'||!Array.isArray(init.tools)||init.tools.length||!Array.isArray(init.mcp_servers)||init.mcp_servers.length)throw new Error('message_claude_role_boundary_not_applied');
}
/** 304's official stream-input protocol supports verbatim composed messages.
 * Do not send that new field to historical 233, or infer support by semver. */
export function messageClaudeInput(version:MessageClaudeVersion,session:string,uuid:string,text:string){
  return {type:'user',session_id:session,parent_tool_use_id:null,uuid,...(version==='2.1.304'?{client_composed:true}:{}),message:{role:'user',content:text}};
}
export function checkMessageClaudeReceipt(events:Row[],session:string,uuid:string,text:string){
  const echoes=events.filter(e=>e.type==='user'),results=events.filter(e=>e.type==='result');
  if(echoes.length!==1||echoes[0]!.uuid!==uuid||echoes[0]!.session_id!==session||echoes[0]!.message?.role!=='user'||echoes[0]!.message.content!==text||results.length!==1||events.indexOf(results[0]!)<events.indexOf(echoes[0]!))throw new Error('message_claude_receipt_ambiguous');
}
/** Every reply uses its original input UUID. 304 adds lifecycle completion,
 * explicit consumed user UUIDs and native child/tool denial summaries; these
 * are checked in addition to the shared final-message and terminal contract. */
export function messageClaudeFinal(events:Row[],session:string,version:MessageClaudeVersion,uuid:string){
  const results=events.filter(e=>e.type==='result'),r=results[0];
  if(!r||results.length!==1||r.session_id!==session||r.subtype!=='success'||r.is_error!==false||r.terminal_reason!=='completed'||r.stop_reason!=='end_turn'||r.api_error_status!=null||typeof r.result!=='string'||!r.result.trim()||events.some(e=>e.parent_tool_use_id!=null||e.aborted===true||e.type==='assistant'&&e.session_id!==session||Array.isArray(e.message?.content)&&e.message.content.some((x:Row)=>x.type==='tool_use')))throw new Error('message_claude_final_not_complete');
  if(version==='2.1.304'){
    // 304 emits a new init for each composed input in the SAME session.
    // Check each command's boundary; neither a global one-init assumption nor
    // accepting arbitrary repeated init messages matches that protocol.
    const inits=events.filter(e=>e.type==='system'&&e.subtype==='init');
    if(inits.length!==1)throw new Error('message_claude_initialization_ambiguous');
    checkMessageClaudeInit(inits[0]!,session,version);
    const lifecycle=events.filter(e=>e.type==='command_lifecycle'),stats=r.subagent_stats;
    if(events.some(e=>!['system','user','assistant','result','command_lifecycle','rate_limit_event'].includes(e.type)||e.session_id!==session)||canonical(lifecycle.map(e=>e.state))!==canonical(['queued','started','completed'])||lifecycle.some(e=>e.command_uuid!==uuid)||events.indexOf(lifecycle[1]!)>events.indexOf(r)||events.indexOf(lifecycle[2]!)<events.indexOf(r)||events.at(-1)!==lifecycle[2]||r.user_message_uuid!==uuid||canonical(r.user_message_uuids)!==canonical([uuid])||r.queued_turn_count!==0||!Number.isSafeInteger(r.result_index)||r.result_index<0||!Array.isArray(r.permission_denials)||r.permission_denials.length||r.safety_stops!==0||!stats||[stats.spawned,stats.spawned_by_subagents,stats.started_in_background,stats.completed,stats.failed,stats.max_depth,stats.requested?.background,stats.requested?.foreground,stats.requested?.unset,stats.killed?.parent,stats.killed?.user,stats.killed?.system,stats.refused?.depth_limit,stats.refused?.concurrency_limit,stats.refused?.budget].some(x=>x!==0)||!stats.by_type||typeof stats.by_type!=='object'||Array.isArray(stats.by_type)||Object.keys(stats.by_type).length)throw new Error('message_claude_304_command_not_complete');
  }
  return r.result as string;
}
