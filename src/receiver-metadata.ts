import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
type Row=Record<string,any>;
const label=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);

/** Project only immutable registered blobs. No executable, account, recorded
 * pathname or today's preference is consulted when displaying old work. */
export function registeredReceiverMetadata(receiver:Row|undefined,blob:(sha:string)=>Buffer):Row{
  if(!receiver)return {state:'not_dispatched'};
  const base:Row={executionKind:receiver.executionKind,tool:'Claude Code'};
  try{
    const plan=receiver.planSha256?JSON.parse(blob(receiver.planSha256).toString()):null,choice=plan?.ai?.roles?.receiver;
    if(choice?.tool==='kimi')base.tool='Kimi CLI';else if(choice&&choice.tool!=='claude')throw Error('original_provider_invalid');
    const read=(name:string)=>{const ref=receiver.blobs?.[name];if(!ref)throw Error('original_metadata_not_registered');const raw=blob(ref.sha256);if(raw.length!==ref.bytes||raw.length>2*1024*1024)throw Error('original_metadata_invalid');return {raw,value:JSON.parse(raw.toString()),sha256:ref.sha256};};
    if(choice?.tool==='kimi'){
      const names=['receiver-request.json','executable.json','session.json','selection.json'],parts=Object.fromEntries(names.map(name=>[name,read(name)])),request=parts['receiver-request.json']!.value,identity=parts['executable.json']!.value,session=parts['session.json']!.value,selected=parts['selection.json']!.value,completed=read('completed.json');
      if(request.kind!=='tongxu-kimi-receiver'||request.role!=='receiver'||request.executable!==choice.executable||canonical(request.aiModel)!==canonical({model:choice.model,effort:choice.effort})||request.inputSha256!==receiver.inputSha256||request.systemSha256!==receiver.systemSha256||canonical(selected.requested)!==canonical(request.aiModel)||completed.value.kind!=='tongxu-kimi-receiver-result'||completed.value.bindingSha256!==hash(canonical(request))||completed.value.sessionId!==session.sessionId||completed.value.inputSha256!==receiver.inputSha256||completed.value.systemPromptSha256!==receiver.systemSha256||typeof completed.value.finalText!=='string'||completed.value.finalSha256!==hash(completed.value.finalText)||names.some(name=>completed.value.originals?.[name]!==hash(parts[name]!.raw))||![identity.version,choice.model,session.sessionId].every(label))throw Error('original_kimi_metadata_invalid');
      return {...base,state:'recorded',version:identity.version,model:choice.model,session:session.sessionId,evidenceSha256:completed.sha256};
    }
    if(!receiver.blobs?.['init.json'])return {...base,state:'unavailable',reason:'original_init_not_registered'};
    const init=read('init.json');if(init.raw.length>65536||init.value.type!=='system'||init.value.subtype!=='init'||![init.value.claude_code_version,init.value.model,init.value.session_id].every(label))throw Error('original_init_invalid');
    return {...base,state:'recorded',version:init.value.claude_code_version,model:init.value.model,session:init.value.session_id,evidenceSha256:init.sha256};
  }catch{return {...base,state:'unavailable',reason:'original_metadata_unreadable_or_invalid'};}
}
