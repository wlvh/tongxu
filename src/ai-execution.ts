import {canonical} from './comparison.js';
import {codexModelList,parseAIModels,requireModelChoice,validateModelChoice,type AIModelChoice} from './ai-catalog.js';
import type {AIRuntimeChoice} from './ai-settings.js';

export const modelChoice=(value:AIRuntimeChoice):AIModelChoice=>({model:value.model,effort:value.effort});
export function codexThreadChoice(choice?:AIModelChoice){if(!choice)return {};validateModelChoice(choice);return {model:choice.model,...(choice.effort!==null?{config:{model_reasoning_effort:choice.effort}}:{})};}
export function codexTurnChoice(choice?:AIModelChoice){if(!choice)return {effort:'high'};validateModelChoice(choice);return {model:choice.model,...(choice.effort!==null?{effort:choice.effort}:{})};}
export function checkCodexSelected(thread:any,choice?:AIModelChoice){if(choice&&(thread.model!==choice.model||choice.effort!==null&&thread.reasoningEffort!==choice.effort))throw new Error('ai_selected_model_not_applied');}
export async function checkCodexChoice(request:(m:string,p:any)=>Promise<any>,choice?:AIModelChoice){if(choice)requireModelChoice(await codexModelList(request),choice);}
export function claudeChoiceArgs(choice?:AIModelChoice){if(!choice)return [];validateModelChoice(choice);return ['--model',choice.model,...(choice.effort!==null?['--effort',choice.effort]:[])];}
export function checkClaudeChoice(identity:any,choice?:AIModelChoice){if(!choice)return null;const models=parseAIModels('claude',identity.capabilities?.initialization?.models);return requireModelChoice(models,choice);}
export function checkClaudeSelected(init:any,identity:any,choice?:AIModelChoice){if(!choice)return;const expected=checkClaudeChoice(identity,choice)!;if(init.model!==expected.id&&init.model!==expected.resolvedId)throw new Error('ai_selected_model_not_applied');}
/** Historical model-list replies are verified against their submitted requests;
 * replay never consults today's catalog or silently adopts today's settings. */
export function capturedCodexModels(sent:any[],received:any[],choice:AIModelChoice){
  const requests=sent.filter(m=>m.method==='model/list');if(!requests.length)throw new Error('ai_model_catalog_proof_missing');const rows:any[]=[];let cursor:string|null=null;const seen=new Set<string>();
  for(const r of requests){if(canonical(r.params)!==canonical({limit:50,includeHidden:false,...(cursor?{cursor}:{})}))throw new Error('ai_model_catalog_proof_changed');const replies=received.filter(m=>m.id===r.id&&!m.method);if(replies.length!==1||replies[0].error||!Array.isArray(replies[0].result?.data))throw new Error('ai_model_catalog_proof_changed');rows.push(...replies[0].result.data);cursor=replies[0].result.nextCursor??null;if(cursor!==null){if(typeof cursor!=='string'||seen.has(cursor))throw new Error('ai_model_catalog_proof_changed');seen.add(cursor);}}
  if(cursor!==null)throw new Error('ai_model_catalog_proof_incomplete');return requireModelChoice(parseAIModels('codex',rows),choice);
}
