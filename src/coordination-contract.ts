import {exactKeys,isAuthorityDigest,safeRelativePath} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {validBranchRef} from './contract.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';

export const coordinationStages=['investigate','implement','receive','publish','enable'] as const;
export type CoordinationStage=typeof coordinationStages[number];
export type CoordinationActor={id:string;tool:'codex'|'claude'};
export type CoordinatedTask={id:string;item:string;actor:string;originActor:string;dispatch:'same_tool_new'|'other_tool_new'|'owner_backlog';stages:CoordinationStage[];independentPaths:string[];workspace:string|null;publishBranch:string|null;outputs:Array<{id:string;stage:CoordinationStage;kind:'message_report'|'receiver_judgment'|'repair_candidate'|'publication_readback'}>};
export type SharedPart={id:string;tasks:string[];paths:string[];contract:string;feedbackFrom:string[];blockedStages:CoordinationStage[]};
export type CoordinationPlan={schemaVersion:1;kind:'tongxu-task-coordination';name:string;revision:string;previous:string|null;source:string;authorityIntent:string|null;mode:'parallel'|'stage_serial'|'unified_owner';actors:CoordinationActor[];tasks:CoordinatedTask[];shared:SharedPart[];dependencies:Array<{task:string;stage:CoordinationStage;producer:string;capability:string}>};
const text=(v:unknown,max=2048):v is string=>typeof v==='string'&&Boolean(v.trim())&&Buffer.byteLength(v)<=max&&!v.includes('\0');
const list=(v:unknown,check:(v:any)=>boolean,max=32):v is any[]=>Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(check);
const stage=(v:unknown):v is CoordinationStage=>typeof v==='string'&&(coordinationStages as readonly string[]).includes(v);
export const coordinationPlanId=(p:CoordinationPlan)=>hash(canonical(p));
/** Exact part content and affected assignments, not a global r label, decide
 * which old feedback needs rechecking. No permission is carried by this hash. */
export function coordinationPartId(p:CoordinationPlan,part:SharedPart){
  return hash(canonical({part,tasks:p.tasks.filter(t=>part.tasks.includes(t.id)).map(({id,item,actor,originActor,workspace,publishBranch})=>({id,item,actor,originActor,workspace,publishBranch})),actors:p.actors.filter(a=>p.tasks.some(t=>part.tasks.includes(t.id)&&(t.actor===a.id||t.originActor===a.id)))}));
}
export function parseCoordinationPlan(raw:Buffer):CoordinationPlan{
  if(raw.length>256*1024)throw new Error('coordination_plan_limit');
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','name','revision','previous','source','authorityIntent','mode','actors','tasks','shared','dependencies'])||p.schemaVersion!==1||p.kind!=='tongxu-task-coordination'||!messageId(p.name)||!messageId(p.revision)||!(p.previous===null||isAuthorityDigest(p.previous))||!text(p.source)||!(p.authorityIntent===null||messageId(p.authorityIntent))||!['parallel','stage_serial','unified_owner'].includes(p.mode)||!Array.isArray(p.actors)||p.actors.length<1||p.actors.length>8||!Array.isArray(p.tasks)||p.tasks.length<2||p.tasks.length>8||!Array.isArray(p.shared)||p.shared.length>16||!Array.isArray(p.dependencies)||p.dependencies.length>32)throw new Error('coordination_plan_invalid');
  const actors=new Map<string,CoordinationActor>();for(const a of p.actors){if(!exactKeys(a,['id','tool'])||!messageId(a.id)||actors.has(a.id)||!['codex','claude'].includes(a.tool))throw new Error('coordination_actor_invalid');actors.set(a.id,a);}
  const tasks=new Map<string,CoordinatedTask>();for(const t of p.tasks){
    if(!exactKeys(t,['id','item','actor','originActor','dispatch','stages','independentPaths','workspace','publishBranch','outputs'])||!messageId(t.id)||tasks.has(t.id)||!isAuthorityDigest(t.item)||!actors.has(t.actor)||!actors.has(t.originActor)||!['same_tool_new','other_tool_new','owner_backlog'].includes(t.dispatch)||!list(t.stages,stage,5)||t.stages[0]!=='investigate'||t.stages.some((s:CoordinationStage,i:number)=>i>0&&coordinationStages.indexOf(s)<=coordinationStages.indexOf(t.stages[i-1]))||!list(t.independentPaths,safeRelativePath,64)||!(t.workspace===null||messagePath(t.workspace))||!(t.publishBranch===null||typeof t.publishBranch==='string'&&validBranchRef(t.publishBranch))||!Array.isArray(t.outputs)||t.outputs.length>16)throw new Error('coordination_task_invalid');
    if(t.dispatch==='owner_backlog'&&t.actor!==t.originActor||t.dispatch!=='owner_backlog'&&t.actor===t.originActor||t.dispatch==='same_tool_new'&&actors.get(t.actor)!.tool!==actors.get(t.originActor)!.tool||t.dispatch==='other_tool_new'&&actors.get(t.actor)!.tool===actors.get(t.originActor)!.tool)throw new Error('coordination_dispatch_does_not_match_actor_tools');
    const outputKinds:Partial<Record<CoordinationStage,string>>={investigate:'message_report',implement:'repair_candidate',receive:'receiver_judgment',publish:'publication_readback'};
    const outputs=new Set<string>();for(const o of t.outputs){if(!exactKeys(o,['id','stage','kind'])||!messageId(o.id)||outputs.has(o.id)||!t.stages.includes(o.stage)||o.kind!==outputKinds[o.stage as CoordinationStage])throw new Error('coordination_output_invalid');outputs.add(o.id);}
    tasks.set(t.id,t);
  }
  if(p.mode==='unified_owner'&&new Set(p.tasks.map((t:CoordinatedTask)=>t.actor)).size!==1)throw new Error('coordination_unified_owner_required');
  const parts=new Set<string>();for(const part of p.shared){
    if(!exactKeys(part,['id','tasks','paths','contract','feedbackFrom','blockedStages'])||!messageId(part.id)||parts.has(part.id)||!list(part.tasks,t=>tasks.has(t),8)||part.tasks.length<2||!list(part.paths,safeRelativePath,64)||!part.paths.length||!text(part.contract,32768)||!list(part.feedbackFrom,t=>part.tasks.includes(t),8)||!part.feedbackFrom.length||!list(part.blockedStages,(s:unknown)=>stage(s)&&s!=='investigate',4)||!part.blockedStages.length||part.tasks.some((id:string)=>tasks.get(id)!.independentPaths.some(path=>part.paths.includes(path)))||part.tasks.some((id:string)=>tasks.get(id)!.stages.includes('implement'))&&!part.blockedStages.includes('implement'))throw new Error('coordination_shared_part_invalid');parts.add(part.id);
  }
  const edges=new Map<string,string[]>(),node=(id:string,s:string)=>id+':'+s;
  for(const t of tasks.values())for(const [i,s] of t.stages.entries())edges.set(node(t.id,s),i?[node(t.id,t.stages[i-1]!)]:[]);
  const dependencies=new Set<string>();for(const d of p.dependencies){
    const producer=tasks.get(d.producer),output=producer?.outputs.find(o=>o.id===d.capability),key=canonical(d);
    if(!exactKeys(d,['task','stage','producer','capability'])||!tasks.get(d.task)?.stages.includes(d.stage)||!output||dependencies.has(key))throw new Error('coordination_dependency_invalid');dependencies.add(key);edges.get(node(d.task,d.stage))!.push(node(d.producer,output.stage));
  }
  const active=new Set<string>(),done=new Set<string>();const visit=(key:string)=>{if(active.has(key))throw new Error('coordination_dependency_cycle');if(done.has(key))return;active.add(key);for(const dependency of edges.get(key)!)visit(dependency);active.delete(key);done.add(key);};for(const key of edges.keys())visit(key);
  if(p.mode==='stage_serial'&&!p.dependencies.length)throw new Error('coordination_precise_serial_dependency_required');
  return p;
}
