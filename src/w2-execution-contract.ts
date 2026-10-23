import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys} from './authority-contract.js';

export type W2ExecutionIntent={run:string;stage:number;tool:string;head:string;tree:string;planHash:string;directory:string};
export function checkW2ExecutionIntent(value:W2ExecutionIntent,run:string,planHash:string,tools:Array<{id:string}>,stages:number){
  if(!exactKeys(value,['run','stage','tool','head','tree','planHash','directory'])||value.run!==run||value.planHash!==planHash||!Number.isSafeInteger(value.stage)||value.stage<0||value.stage>=stages||!tools.some(t=>t.id===value.tool)||![value.head,value.tree].every(s=>/^[a-f0-9]{40}$/.test(s))||!value.directory.startsWith(`docker-tool-${value.stage}-${value.tool}-`)||!/^docker-tool-[0-9]+-[A-Za-z0-9_-]+-[a-f0-9-]{36}$/.test(value.directory))throw new Error('w2_execution_intent_mismatch');
}
export const w2ExecutionRegistrySha=(values:W2ExecutionIntent[]|undefined)=>values===undefined?null:hash(canonical(values));
