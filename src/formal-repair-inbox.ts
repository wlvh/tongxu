import {join} from 'node:path';
import {canonical} from './comparison.js';
import {exists,regular} from './repair-workspace.js';
import {writeFixed} from './project-work-runtime.js';
import type {RepairInboxItem,SupplementTarget} from './project-chat.js';

export type FormalProjectWork={id:string;account:number;repository:number;nodeId:string;target:SupplementTarget};
export type ReadRepairInbox=(work:FormalProjectWork,operation:string,round:number)=>Promise<RepairInboxItem[]>;
const path=(directory:string,round:number)=>join(directory,'repair-inbox-'+round+'.json');

export async function readRepairInbox(directory:string,round:number,work:FormalProjectWork):Promise<RepairInboxItem[]|null>{
  const file=path(directory,round);
  if(!await exists(file))return null;
  const saved=JSON.parse((await regular(file,196608+1024)).toString());
  if(canonical(saved.work)!==canonical(work)||saved.round!==round||!Array.isArray(saved.items))
    throw new Error('formal_repair_inbox_binding_changed');
  return saved.items;
}

export async function freezeRepairInbox(directory:string,round:number,work:FormalProjectWork,items:RepairInboxItem[]){
  await writeFixed(path(directory,round),canonical({round,work,items}));
  return items;
}
