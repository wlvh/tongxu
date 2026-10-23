import {isAbsolute,resolve} from 'node:path';
import {exactKeys,safeRelativePath} from './authority-contract.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {repoPattern,shaPattern,validBranchRef} from './contract.js';
import {parseQueueContext,type QueueContext} from './queue-evidence.js';

export type DevelopmentTask={schemaVersion:1;kind:'tongxu-development-task';id:string;repository:string;title:string;goal:string;acceptance:string[];source:string;issue:number|null;context:QueueContext;workspace:string;base:string;target:string;paths:string[]};
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
export function parseDevelopmentTask(bytes:Buffer):DevelopmentTask{
  if(bytes.length>64*1024)throw new Error('development_task_size_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  if(!exactKeys(p,['schemaVersion','kind','id','repository','title','goal','acceptance','source','issue','context','workspace','base','target','paths'])||p.schemaVersion!==1||p.kind!=='tongxu-development-task'||!text(p.id,96)||!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(p.id)||typeof p.repository!=='string'||!repoPattern.test(p.repository)||!text(p.title,160)||!text(p.goal,16000)||!text(p.source,2048)||!Array.isArray(p.acceptance)||!p.acceptance.length||p.acceptance.length>32||p.acceptance.some((v:unknown)=>!text(v,2048))||!(p.issue===null||Number.isSafeInteger(p.issue)&&p.issue>0)||!text(p.workspace,4096)||!isAbsolute(p.workspace)||resolve(p.workspace)!==p.workspace||!shaPattern.test(p.base)||!validBranchRef(p.target)||!Array.isArray(p.paths)||!p.paths.length||p.paths.length>32||new Set(p.paths).size!==p.paths.length||!p.paths.every(safeRelativePath))throw new Error('development_task_invalid');
  p.context=parseQueueContext(p.context);return p;
}
export const developmentTaskId=(p:DevelopmentTask)=>hash(canonical(['development-task',p.repository.toLowerCase(),p.id]));
export type TaskCandidate={kind:'development-task';repository:string;taskId:string;taskName:string;pr:null;H:string;B:string;targetRef:string;mergeBase:string|null;observedAt:string;sourceSha256:string};
