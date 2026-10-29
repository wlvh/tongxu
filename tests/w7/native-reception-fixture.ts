import {writeFile} from 'node:fs/promises';
/** Explicit local process double for publication tests. It
 * speaks the current capability/receipt contract; it never calls a model. */
export async function nativeReceptionFixture(path:string,trace:string,options:{mode?:string;report?:string}={}){
  await writeFile(path,`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n'),version='99.9.0',args=process.argv.slice(2),session=args[args.indexOf('--session-id')+1],trace=${JSON.stringify(trace)},mode=${JSON.stringify(options.mode??'complete')};
if(args.includes('--version')){console.log(version+' (Claude Code)');process.exit(0);}
if(args.includes('--help')){console.log('--safe-mode --setting-sources --tools --permission-mode --strict-mcp-config --mcp-config --no-chrome --no-session-persistence --disable-slash-commands --output-format --verbose --system-prompt --input-format --replay-user-messages --session-id');process.exit(0);}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));process.exit(0);}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='control_request'){emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,pending_permission_requests:[],pending_user_dialog_requests:[],response:{claude_code_version:version,current_permission_mode:'dontAsk',session_state:'idle',fast_mode_state:'off',commands:[]}}});return;}
if(m.type!=='user'||m.client_composed!==true)throw Error('fixture_composed_input_required');const x=JSON.parse(m.message.content);fs.appendFileSync(trace,'model-dispatch\\n');
for(const state of ['queued','started'])emit({type:'command_lifecycle',session_id:session,command_uuid:m.uuid,state});
emit({type:'system',subtype:'init',session_id:session,model:'explicit-fixture',claude_code_version:version,permissionMode:'dontAsk',apiKeySource:'none',tools:[],mcp_servers:[]});emit(m);
const judgment={schemaVersion:x.responseShape.schemaVersion,operation:x.binding.operation,judgmentId:x.binding.judgmentId,bindingHash:mode==='bad-binding'?'0'.repeat(64):x.bindingHash,verdict:'ACCEPT_WITHIN_SCOPE',report:${JSON.stringify(options.report??'Explicit process fixture; no real model or acceptance.')},findings:[]};
const fence=String.fromCharCode(96).repeat(3),fenced=fence+'json\\n'+JSON.stringify(judgment)+'\\n'+fence,formatted=mode==='fenced'?fenced:mode==='fenced-prose'?'note\\n'+fenced:mode==='fenced-double'?fenced+'\\n'+fenced:JSON.stringify(judgment);
emit({type:'result',session_id:session,subtype:'success',is_error:false,terminal_reason:mode==='aborted'?'aborted_streaming':'completed',stop_reason:'end_turn',result:formatted,user_message_uuid:m.uuid,user_message_uuids:[m.uuid],queued_turn_count:0,result_index:0,permission_denials:[],safety_stops:0,subagent_stats:{spawned:0,spawned_by_subagents:0,started_in_background:0,completed:0,failed:0,max_depth:0,requested:{background:0,foreground:0,unset:0},killed:{parent:0,user:0,system:0},refused:{depth_limit:0,concurrency_limit:0,budget:0},by_type:{}}});
emit({type:'command_lifecycle',session_id:session,command_uuid:m.uuid,state:'completed'});
});
`,{mode:0o700});
}
