import { join } from 'node:path';
import { hash } from './snapshot.js';
import { canonical } from './comparison.js';
import { regular,exists } from './repair-workspace.js';
import { readCodexExecution } from './live-codex.js';
import { readRepairSession } from './repair-native.js';
import { readClaudeExecution,claudeArgs } from './live-claude.js';

export type CaptureFormat='codex-readonly'|'codex-controlled'|'claude-readonly';
export type ArchivedSession={format:CaptureFormat;directory:string;tool:'codex'|'claude';recordedRole:string|null;candidate:Record<string,any>|null;sessionId:string;threadId:string|null;turnIds:string[];finals:Array<{turnId:string|null;text:string;sha256:string}>;originals:Record<string,Buffer>;executionKindAsRecorded:string|null;currentNativeStatus:'not_observed';executionProvenanceVerified:false;controlPermissionGranted:false};
const issued=new WeakMap<object,string>();
const identity=(v:ArchivedSession)=>hash(canonical({...v,originals:Object.fromEntries(Object.entries(v.originals).map(([k,b])=>[k,{sha256:hash(b),bytes:b.length}]))}));
/** Strict existing capture validators establish original bytes, native IDs and
 * finals. They do not authenticate an external archive's producer or revive a
 * closed runtime, so association cannot turn this result into control rights. */
export async function readArchivedSession(format:CaptureFormat,directory:string):Promise<ArchivedSession>{
  if(!['codex-readonly','codex-controlled','claude-readonly'].includes(format))throw new Error('session_capture_format_invalid');
  const originals:Record<string,Buffer>={};let size=0;
  for(const name of ['stdin.ndjson','stdout.ndjson','stderr.txt','exit.json','launch.json','process.json','executable.json','capture-status.json','completed.json','binding.json','thread.json','effective-config.json','inputs.json','expected-requests.json','reconciled-tools.json','native-tool-transports.json'])if(await exists(join(directory,name))){const b=await regular(join(directory,name),32*1024*1024);size+=b.length;if(size>64*1024*1024)throw new Error('session_archive_capture_limit');originals[name]=b;}
  let value:ArchivedSession;
  if(format==='claude-readonly'){
    const r=await readClaudeExecution(directory),launch=JSON.parse(originals['launch.json']!.toString()),system=launch.args[launch.args.indexOf('--system-prompt')+1];
    if(canonical(launch.args)!==canonical(claudeArgs(system)))throw new Error('archived_claude_tool_boundary_changed');
    let binding:any=null;try{binding=JSON.parse(originals['stdin.ndjson']!.toString()).binding;}catch{}
    value={format,directory,tool:'claude',recordedRole:typeof binding?.role==='string'?binding.role:null,candidate:binding?.candidate??null,sessionId:r.sessionId,threadId:null,turnIds:[],finals:[{turnId:null,text:r.finalText,sha256:hash(r.finalText)}],originals,executionKindAsRecorded:null,currentNativeStatus:'not_observed',executionProvenanceVerified:false,controlPermissionGranted:false};
  }else{
    const r=format==='codex-readonly'?await readCodexExecution(directory):await readRepairSession(directory);
    value={format,directory,tool:'codex',recordedRole:r.binding.role,candidate:r.binding.candidate,sessionId:r.binding.sessionId,threadId:r.binding.threadId,turnIds:r.binding.turnIds,finals:r.turns.map(t=>({turnId:t.id,text:t.final!.text,sha256:hash(t.final!.text)})),originals,executionKindAsRecorded:r.binding.sourceKind,currentNativeStatus:'not_observed',executionProvenanceVerified:false,controlPermissionGranted:false};
  }
  if(!value.sessionId||!value.finals.length)throw new Error('archived_session_identity_or_final_missing');
  // Reject a source changing while it was being validated, without rewriting it.
  for(const [name,b] of Object.entries(originals))if(hash(await regular(join(directory,name),32*1024*1024))!==hash(b))throw new Error('archived_session_changed_during_read');
  issued.set(value,identity(value));return value;
}
export function requireArchivedSession(value:ArchivedSession){if(issued.get(value)!==identity(value))throw new Error('original_archived_session_read_required');return value;}
