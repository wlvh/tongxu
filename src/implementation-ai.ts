import {implementationEditProfile} from './repair-edits.js';
import {projectRepairToolsFor} from './repair-workspace.js';
import {captureRoleAI,currentAIPreferences,parseAIPreferences,type AIPreferenceSnapshot} from './ai-settings.js';
import {canonical} from './comparison.js';
import {regular} from './repair-workspace.js';
import {join} from 'node:path';
import {modelChoice,codexThreadChoice,codexTurnChoice,capturedCodexModels,checkCodexSelected} from './ai-execution.js';
import {capturedExternalExecutable} from './external-executable.js';
type Row=Record<string,any>;
export type ImplementationAI=AIPreferenceSnapshot;
export function parseImplementationAI(value:unknown,repository?:string){
 const snapshot=parseAIPreferences(value),choice=snapshot.roles.implementer;
 if(!choice||Object.keys(snapshot.roles).join()!=='implementer'||Object.keys(snapshot.errors??{}).length||choice.tool!=='codex'||repository&&snapshot.scope.repository.fullName.toLowerCase()!==repository.toLowerCase())throw new Error('ai_implementation_selection_invalid');
 return snapshot;
}
export function captureImplementationAI(repository:string){
 const choice=captureRoleAI(['implementer'],repository).implementer;if(!choice)return undefined;
 const value=currentAIPreferences(['implementer'])!;
 return parseImplementationAI({revision:value.revision,scope:{account:{id:value.scope.account.id},repository:{id:value.scope.repository.id,nodeId:value.scope.repository.nodeId,fullName:value.scope.repository.fullName}},roles:{implementer:choice},...(value.errors?{errors:value.errors}:{})},repository);
}
export function implementationChoice(request:Row,plan:Row,manifest?:Row){
 if(canonical(request.implementationAI??null)!==canonical(plan.implementationAI??null)||manifest&&canonical(manifest.implementationAI??null)!==canonical(request.implementationAI??null))throw new Error('implementation_original_model_changed');
 if(!request.implementationAI)return undefined;return parseImplementationAI(request.implementationAI).roles.implementer!;
}
/** Frozen settings are proved against original wire replies, never today's UI. */
export async function verifyImplementationModel(request:Row,plan:Row,manifest:Row,directory:string,unsent=false){
 const choice=implementationChoice(request,plan,manifest),profile=implementationEditProfile(request,plan,manifest);
 const read=async(name:string)=>JSON.parse((await regular(join(directory,name),16*1024*1024)).toString()),frames=async(name:string)=>(await regular(join(directory,name),16*1024*1024)).toString().trim().split('\n').map(x=>JSON.parse(x));
 const sent=await frames('stdin.ndjson'),received=await frames('stdout.ndjson'),starts=sent.filter(x=>x.method==='thread/start'),turns=sent.filter(x=>x.method==='turn/start');
 const selection=choice?await read('model-choice.json'):null,identity=choice?await read('executable.json'):null;
 if(starts.length!==1||canonical(starts[0].params.dynamicTools)!==canonical(projectRepairToolsFor(profile,request.workspaceRequest?.projectFiles)))throw new Error('implementation_edit_profile_changed');if(!choice)return;
 const requested=modelChoice(choice);if(starts.length!==1||(unsent?turns.length!==0:turns.length!==1)||!capturedExternalExecutable(identity.externalSelection,choice.executable)||identity.path!==choice.executable||canonical(selection.requested)!==canonical(requested))throw new Error('implementation_original_model_changed');
 for(const [key,value] of Object.entries(codexThreadChoice(requested)))if(canonical(starts[0].params[key])!==canonical(value))throw new Error('implementation_original_model_changed');
 for(const turn of turns)for(const [key,value] of Object.entries(codexTurnChoice(requested)))if(canonical(turn.params[key])!==canonical(value))throw new Error('implementation_original_model_changed');
 const replies=received.filter(x=>!x.method&&x.id===starts[0].id);if(replies.length!==1||replies[0].error)throw new Error('implementation_original_model_changed');checkCodexSelected(replies[0].result,requested);capturedCodexModels(sent,received,requested);
 if(selection.actualModel!==replies[0].result.model||selection.actualEffort!==replies[0].result.reasoningEffort)throw new Error('implementation_original_model_changed');
}
