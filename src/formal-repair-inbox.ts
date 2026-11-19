import {join} from 'node:path';
import {canonical} from './comparison.js';
import {exists,regular} from './repair-workspace.js';
import {writeFixed} from './project-work-runtime.js';
import type {RepairInboxItem,SupplementTarget} from './project-chat.js';
import type {ReviewedSupplement} from './project-supplement-review.js';
import type {ProjectContract} from './project-repair.js';
import {projectTestPlan} from './project-repair.js';
import {hash} from './snapshot.js';
import {readFailedValidationTests} from './implementation-validation.js';

export type FormalProjectWork={id:string;account:number;repository:number;nodeId:string;target:SupplementTarget};
export type FormalRepairInboxItem=RepairInboxItem&{revision?:ReviewedSupplement};
export type RepairCheckpoint='before-repair'|'after-repair';
export type ReadRepairInbox=(work:FormalProjectWork,operation:string,round:number,H:string,executionKind:string,recheck?:string[])=>Promise<FormalRepairInboxItem[]>;
const path=(directory:string,round:number,checkpoint:RepairCheckpoint)=>join(directory,'repair-inbox-'+round+(checkpoint==='after-repair'?'-after':'')+'.json');

export async function readRepairInbox(directory:string,round:number,work:FormalProjectWork,checkpoint:RepairCheckpoint='before-repair'):Promise<FormalRepairInboxItem[]|null>{
  const file=path(directory,round,checkpoint);
  if(!await exists(file))return null;
  const saved=JSON.parse((await regular(file,512*1024)).toString());
  if(canonical(saved.work)!==canonical(work)||saved.round!==round||!Array.isArray(saved.items))
    throw new Error('formal_repair_inbox_binding_changed');
  return saved.items;
}

export async function freezeRepairInbox(directory:string,round:number,work:FormalProjectWork,items:FormalRepairInboxItem[],checkpoint:RepairCheckpoint='before-repair'){
  const bytes=canonical({round,work,items});
  if(Buffer.byteLength(bytes)>512*1024)throw new Error('project_supplement_context_limit');
  await writeFixed(path(directory,round,checkpoint),bytes);
  return items;
}

export const repairSupplementTest=(revision:ReviewedSupplement)=>'supplement-'+revision.inputSha256.slice(0,20);
export type AdoptedRepairRevision=Pick<RepairInboxItem,'requestId'|'originalRequestId'>&{revision:ReviewedSupplement};
export const adoptedRepairRevisions=(items:FormalRepairInboxItem[]):AdoptedRepairRevision[]=>items.flatMap(item=>
  item.revision?[{requestId:item.requestId,originalRequestId:item.originalRequestId,revision:item.revision}]:[]);

export async function verifiedRepairSupplementTests(verification:Record<string,any>,H:string){
  const {result}=await readFailedValidationTests(verification.directory,verification.plan,false);
  if(!result.passed||verification.binding.candidate.H!==H||hash(canonical(result))!==verification.binding.testResultCanonicalSha256)
    throw new Error('formal_fixed_supplement_test_capture_changed');
  return result;
}

export async function formalRepairSupplementPlan(original:ProjectContract,path:string,revisions:AdoptedRepairRevision[]){
  if(!revisions.length)return null;
  const {plan}=await projectTestPlan(original);
  const tools=revisions.map(({revision})=>({
    id:repairSupplementTest(revision),argv:[plan.executor!.node,'--input-type=module','--eval',revision.validation.script],timeoutMs:30000
  }));
  const bytes=canonical({...plan,tools});
  await writeFixed(path,bytes);
  return {...original,testPlan:path,testPlanSha256:hash(bytes)};
}
