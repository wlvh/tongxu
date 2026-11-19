import {join} from 'node:path';
import {canonical} from './comparison.js';
import {exists,regular} from './repair-workspace.js';
import {writeFixed} from './project-work-runtime.js';
import type {RepairInboxItem,SupplementTarget} from './project-chat.js';
import type {ReviewedSupplement} from './project-supplement-review.js';
import type {ProjectContract} from './project-repair.js';
import {projectTestPlan} from './project-repair.js';
import {hash} from './snapshot.js';

export type FormalProjectWork={id:string;account:number;repository:number;nodeId:string;target:SupplementTarget};
export type FormalRepairInboxItem=RepairInboxItem&{revision?:ReviewedSupplement};
export type ReadRepairInbox=(work:FormalProjectWork,operation:string,round:number,H:string,executionKind:string)=>Promise<FormalRepairInboxItem[]>;
const path=(directory:string,round:number)=>join(directory,'repair-inbox-'+round+'.json');

export async function readRepairInbox(directory:string,round:number,work:FormalProjectWork):Promise<FormalRepairInboxItem[]|null>{
  const file=path(directory,round);
  if(!await exists(file))return null;
  const saved=JSON.parse((await regular(file,512*1024)).toString());
  if(canonical(saved.work)!==canonical(work)||saved.round!==round||!Array.isArray(saved.items))
    throw new Error('formal_repair_inbox_binding_changed');
  return saved.items;
}

export async function freezeRepairInbox(directory:string,round:number,work:FormalProjectWork,items:FormalRepairInboxItem[]){
  const bytes=canonical({round,work,items});
  if(Buffer.byteLength(bytes)>512*1024)throw new Error('project_supplement_context_limit');
  await writeFixed(path(directory,round),bytes);
  return items;
}

export const repairSupplementTest=(revision:ReviewedSupplement)=>'supplement-'+revision.inputSha256.slice(0,20);

export async function formalRepairSupplementPlan(original:ProjectContract,path:string,inbox:FormalRepairInboxItem[]){
  const revisions=inbox.flatMap(item=>item.revision?[item.revision]:[]);
  if(!revisions.length)return null;
  const {plan}=await projectTestPlan(original);
  const tools=revisions.map(revision=>({
    id:repairSupplementTest(revision),argv:[plan.executor!.node,'--input-type=module','--eval',revision.validation.script],timeoutMs:30000
  }));
  const bytes=canonical({...plan,tools});
  await writeFixed(path,bytes);
  return {...original,testPlan:path,testPlanSha256:hash(bytes)};
}
