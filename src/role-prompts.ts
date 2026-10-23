import { readFile,lstat,realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { canonical } from './comparison.js';
import { hash } from './snapshot.js';

export type PromptRole='secretary'|'issue_owner'|'implementer'|'reviewer'|'verifier_fact'|'verifier_impact'|'receiver'|'external_report'|'acceptance';
const roles:PromptRole[]=['secretary','issue_owner','implementer','reviewer','verifier_fact','verifier_impact','receiver','external_report','acceptance'];
export const upstreamRevision='1772cd2c25bfc42b7a89cf38b35bf19d3dc22000';
const upstream={
  review:{path:'zh/prompts/pr_review_system.md',sha256:'08e491ed00e59294408d9a97dd6b64bfa1b5d1d3bd44ba51ada4a6c85585ebe9'},
  issue:{path:'zh/prompts/issue_agent.md',sha256:'4d223d297c9de9b817f435b37dac3922b233e2978859a9af354e0a0934246021'},
  workflow:{path:'zh/docs/development_workflow/README.md',sha256:'44cb352caa056c86b8f26fe13998bf1a90544f627f29f37de248a2e804ab52c0'},
};
type Part={kind:'runtime'|'role'|'upstream'|'task_policy';source:string;sha256:string;bytes:number;text:string};
export type RolePrompt={schemaVersion:1;kind:'tongxu-role-prompt';role:PromptRole;parts:Part[];system:string;sha256:string;permissionGranted:false};
const issued=new WeakMap<object,string>();
const required=(role:PromptRole):Array<keyof typeof upstream>=>role==='secretary'||role==='acceptance'?[]:role==='issue_owner'?['issue','workflow']:role==='reviewer'?['review','workflow']:['workflow'];
const part=(kind:Part['kind'],source:string,text:string):Part=>({kind,source,sha256:hash(text),bytes:Buffer.byteLength(text),text});
const systemText=(parts:Part[])=>parts.map(p=>p.text).join('\n\n');
async function local(relative:string){
  const root=fileURLToPath(new URL('../../prompts/',import.meta.url)),path=join(root,relative),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>128*1024||await realpath(path)!==path)throw new Error('role_prompt_source_not_regular');
  return new TextDecoder('utf8',{fatal:true}).decode(await readFile(path));
}
/** Role and task policy come from the trusted runner, never from a report.
 * The complete adopted upstream is packaged, so no live network fallback or
 * silently shortened substitute is needed at model dispatch time. */
export async function assembleRolePrompt(role:PromptRole,taskPolicy=''):Promise<RolePrompt>{
  if(!roles.includes(role)||typeof taskPolicy!=='string'||Buffer.byteLength(taskPolicy)>64*1024||taskPolicy.includes('\0'))throw new Error('role_prompt_request_invalid');
  const parts=[part('runtime','tongxu:prompts/runtime_contract.md',await local('runtime_contract.md')),part('role',`tongxu:prompts/${role}.md`,await local(role+'.md'))];
  for(const key of required(role)){
    const ref=upstream[key],text=await local(`upstream/${upstreamRevision}/${key}.md`);
    if(hash(text)!==ref.sha256)throw new Error('fixed_upstream_prompt_changed');
    parts.push(part('upstream',`github:wlvh/coding-workflow@${upstreamRevision}:${ref.path}`,text));
  }
  if(taskPolicy)parts.push(part('task_policy','trusted-runner:task-policy',taskPolicy));
  const system=systemText(parts);if(Buffer.byteLength(system)>128*1024)throw new Error('complete_role_prompt_input_limit');
  const value:RolePrompt={schemaVersion:1,kind:'tongxu-role-prompt',role,parts,system,sha256:hash(system),permissionGranted:false};
  issued.set(value,hash(canonical(value)));return value;
}
/** Historical manifests can be checked for complete bytes and role identity.
 * This does not certify a serialized caller's execution or permission. */
export function inspectRolePrompt(value:RolePrompt,role:PromptRole){
  if(!value||value.schemaVersion!==1||value.kind!=='tongxu-role-prompt'||value.role!==role||!roles.includes(role)||!Array.isArray(value.parts)||value.permissionGranted!==false)throw new Error('role_prompt_binding_invalid');
  const expected=[['runtime','tongxu:prompts/runtime_contract.md'],['role',`tongxu:prompts/${role}.md`],...required(role).map(key=>['upstream',`github:wlvh/coding-workflow@${upstreamRevision}:${upstream[key].path}`])];
  if(value.parts.at(-1)?.kind==='task_policy')expected.push(['task_policy','trusted-runner:task-policy']);
  if(value.parts.length!==expected.length)throw new Error('complete_role_prompt_parts_required');
  for(const [i,p] of value.parts.entries()){
    if(p.kind!==expected[i]![0]||p.source!==expected[i]![1]||typeof p.text!=='string'||!p.text.trim()||p.bytes!==Buffer.byteLength(p.text)||p.sha256!==hash(p.text))throw new Error('role_prompt_part_changed_or_wrong_role');
    if(p.kind==='upstream'&&!Object.values(upstream).some(r=>p.source===`github:wlvh/coding-workflow@${upstreamRevision}:${r.path}`&&p.sha256===r.sha256))throw new Error('fixed_upstream_prompt_changed');
  }
  if(value.system!==systemText(value.parts)||value.sha256!==hash(value.system)||Buffer.byteLength(value.system)>128*1024)throw new Error('role_prompt_actual_system_mismatch');
  return {role,systemSha256:value.sha256,parts:value.parts.map(({text:_text,...ref})=>ref),permissionGranted:false,executionProvenanceVerified:false};
}
export function requireIssuedRolePrompt(value:RolePrompt,role:PromptRole){
  if(issued.get(value)!==hash(canonical(value)))throw new Error('actual_role_prompt_assembly_required');return inspectRolePrompt(value,role);
}
export async function assemblePromptSet<T extends Record<string,string>>(supplied:T,roleMap:Record<keyof T,PromptRole>){
  const prompts={} as T,promptAssemblies={} as Record<keyof T,RolePrompt>;
  for(const key of Object.keys(supplied) as Array<keyof T>){const assembly=await assembleRolePrompt(roleMap[key],supplied[key]);requireIssuedRolePrompt(assembly,roleMap[key]);prompts[key]=assembly.system as T[keyof T];promptAssemblies[key]=assembly;}
  return {prompts,promptAssemblies};
}
export function inspectPromptSet(supplied:Record<string,string>,roleMap:Record<string,PromptRole>,frozen:{prompts:Record<string,string>;promptAssemblies?:Record<string,RolePrompt>}){
  if(canonical(Object.keys(frozen.prompts).sort())!==canonical(Object.keys(supplied).sort()))throw new Error('frozen_role_set_changed');
  if(!frozen.promptAssemblies){if(canonical(frozen.prompts)!==canonical(supplied))throw new Error('legacy_frozen_role_policy_changed');return {legacy:true};}
  if(canonical(Object.keys(frozen.promptAssemblies).sort())!==canonical(Object.keys(supplied).sort()))throw new Error('complete_role_prompt_set_required');
  for(const key of Object.keys(supplied)){
    const assembly=frozen.promptAssemblies[key]!;inspectRolePrompt(assembly,roleMap[key]!);
    if(assembly.system!==frozen.prompts[key]||(assembly.parts.find(p=>p.kind==='task_policy')?.text??'')!==supplied[key])throw new Error('frozen_role_policy_or_system_changed');
  }
  return {legacy:false};
}
