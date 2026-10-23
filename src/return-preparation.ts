import {writeFile,realpath,rename} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {regular,exists} from './repair-workspace.js';
import {exactKeys,isAuthorityDigest,safeRelativePath} from './authority-contract.js';
import {messagePath} from './message-contract.js';
import {parseQueueRepairPlan,withQueueRepairLock} from './queue-repair.js';
import type {ProjectRequest} from './project-repair.js';

type Ref={path:string;sha256:string};
type Source={id:string;store:string;item:string};
export type ReturnPreparationEntry={id:string;title:string;source:string;prepare:Ref};
type Profile={schemaVersion:1;kind:'tongxu-return-preparation';candidate:{repository:string;pr:number;B:string;target:string};scope:{id:string;version:string;source:string};objects:string;executionParent:string;allowedPaths:string[];materialPaths:string[];protectedPaths:string[];contract:string;testPlan:Ref;config:Ref;authorization:ProjectRequest['authorization'];demonstrationFixture:boolean;generatedDirectories:string[]};
export type ReturnPreparation={entry:ReturnPreparationEntry;source:Source;raw:Buffer;profile:Profile;configBytes:Buffer};
export const returnPreparationRef=(v:unknown):v is Ref=>exactKeys(v,['path','sha256'])&&messagePath((v as Ref).path)&&isAuthorityDigest((v as Ref).sha256);
const text=(v:unknown,max=16000)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
const paths=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(safeRelativePath);
// Called only under the existing original-operation lock. A crash can leave
// an unpublished temporary file, but never a half-published authoritative
// input. Leftover temporary bytes are retained and are not execution proof.
async function fixed(path:string,bytes:Buffer){
  if(!await exists(path)){const temporary=join(dirname(path),'.pending-'+basename(path)+'-'+randomUUID());await writeFile(temporary,bytes,{flag:'wx',mode:0o600});if(!(await regular(temporary,2*1024*1024)).equals(bytes))throw new Error('return_preparation_write_incomplete');if(!await exists(path))await rename(temporary,path);}
  if(!(await regular(path,2*1024*1024)).equals(bytes))throw new Error('return_preparation_original_changed');
}

/** One reusable supported scope, not a per-operation plan or authorization
 * inferred from a reviewer. Every actual effect still uses runQueueRepair. */
export async function loadReturnPreparation(entry:ReturnPreparationEntry,source:Source):Promise<ReturnPreparation>{
  if(!returnPreparationRef(entry.prepare))throw new Error('return_preparation_reference_invalid');
  const raw=await regular(entry.prepare.path,128*1024);if(hash(raw)!==entry.prepare.sha256)throw new Error('return_preparation_profile_changed');const p=JSON.parse(raw.toString()) as Profile;
  if(!exactKeys(p,['schemaVersion','kind','candidate','scope','objects','executionParent','allowedPaths','materialPaths','protectedPaths','contract','testPlan','config','authorization','demonstrationFixture','generatedDirectories'])||p.schemaVersion!==1||p.kind!=='tongxu-return-preparation'||!exactKeys(p.candidate,['repository','pr','B','target'])||!text(p.candidate.repository,200)||!Number.isSafeInteger(p.candidate.pr)||p.candidate.pr<1||!(/^[a-f0-9]{40}$/).test(p.candidate.B)||!text(p.candidate.target,256)||!exactKeys(p.scope,['id','version','source'])||!Object.values(p.scope).every(x=>text(x))||!messagePath(p.objects)||!messagePath(p.executionParent)||!paths(p.allowedPaths,32)||!p.allowedPaths.length||!paths(p.materialPaths,64)||!paths(p.protectedPaths,128)||p.allowedPaths.some(x=>!p.materialPaths.includes(x)||p.protectedPaths.includes(x))||!text(p.contract)||!returnPreparationRef(p.testPlan)||!returnPreparationRef(p.config)||!exactKeys(p.authorization,['source','allowRepair','allowReconcileEnded','maxRepairRounds'])||!text(p.authorization.source)||typeof p.authorization.allowRepair!=='boolean'||typeof p.authorization.allowReconcileEnded!=='boolean'||!Number.isInteger(p.authorization.maxRepairRounds)||p.authorization.maxRepairRounds<1||p.authorization.maxRepairRounds>3||typeof p.demonstrationFixture!=='boolean'||!paths(p.generatedDirectories,16))throw new Error('return_preparation_profile_invalid');
  if(await realpath(p.objects)!==p.objects||await realpath(p.executionParent)!==p.executionParent)throw new Error('return_preparation_directory_changed');
  const configBytes=await regular(p.config.path),tests=await regular(p.testPlan.path);if(hash(configBytes)!==p.config.sha256||hash(tests)!==p.testPlan.sha256)throw new Error('return_preparation_input_changed');
  return {entry:structuredClone(entry),source:structuredClone(source),raw,profile:p,configBytes};
}

/** A deterministic projection from one exact original RETURN. This function
 * is read-only; the explicit start action below freezes files, never GET. */
export async function resolvePreparedReturn(f:ReturnPreparation,operation:string){
  if(!/^[a-f0-9-]{36}$/.test(operation))throw new Error('return_control_not_selected');
  const original=(await QueueStore.observeIncomingReturns(f.source.store,f.source.item,operation))[0];if(!original?.available)throw new Error(original?.reason??'return_control_not_selected');
  const p=f.profile,c=original.candidate;
  if(c.repository!==p.candidate.repository||c.pr!==p.candidate.pr||c.B!==p.candidate.B||c.targetRef!==p.candidate.target||canonical(original.context.scope)!==canonical(p.scope))throw new Error('return_preparation_outside_fixed_scope');
  if((JSON.parse(f.configBytes.toString()).executionKind??'native_capture')!==original.executionKind)throw new Error('return_preparation_execution_kind_changed');
  const directory=join(f.source.store,'return-input-'+operation),request:ProjectRequest={schemaVersion:1,kind:'tongxu-project-repair-request',executionRoot:join(p.executionParent,'return-'+operation),objects:p.objects,candidate:{kind:'github-pr',repository:c.repository,pr:c.pr,H:c.H,B:c.B,target:c.targetRef},allowedPaths:p.allowedPaths,materialPaths:p.materialPaths,protectedPaths:p.protectedPaths,contract:p.contract,testPlan:p.testPlan.path,testPlanSha256:p.testPlan.sha256,findings:[],authorization:p.authorization,demonstrationFixture:p.demonstrationFixture,generatedDirectories:p.generatedDirectories},requestBytes=Buffer.from(canonical(request)),configPath=join(directory,'config.json');
  const raw=Buffer.from(canonical({schemaVersion:1,kind:'tongxu-queue-repair',store:f.source.store,operation,packet:original.packet,judgmentId:original.judgmentId,bindingHash:original.bindingHash,context:original.context,request:join(directory,'request.json'),requestSha256:hash(requestBytes),config:configPath,configSha256:hash(f.configBytes)})),plan=parseQueueRepairPlan(raw),path=join(directory,'plan.json');
  const binding=Buffer.from(canonical({kind:'original-return-preparation',profileSha256:hash(f.raw),item:f.source.item,operation,selectionSha256:original.selectionSha256,planSha256:hash(raw)}));
  const prepared=await exists(path);if(prepared){for(const [name,bytes] of [['binding.json',binding],['request.json',requestBytes],['config.json',f.configBytes],['plan.json',raw]] as const)if(!(await regular(join(directory,name),2*1024*1024)).equals(bytes))throw new Error('return_preparation_original_changed');}
  return {entry:{id:f.entry.id+':'+operation,title:f.entry.title,source:f.entry.source,repair:{path,sha256:hash(raw)},afterRefutation:null},source:f.source,raw,plan,request,refutation:null,preparation:{selectionSha256:original.selectionSha256,prepared,originalOperation:operation,permissionsGranted:false},original,directory,binding,requestBytes};
}

export async function freezePreparedReturn(f:ReturnPreparation,operation:string,selectionSha256:string,beforeWrite:()=>void){
  if(!(await regular(f.entry.prepare.path,128*1024)).equals(f.raw)||!(await regular(f.profile.config.path)).equals(f.configBytes)||hash(await regular(f.profile.testPlan.path))!==f.profile.testPlan.sha256)throw new Error('return_preparation_input_changed');
  return withQueueRepairLock(f.source.store,operation,async()=>{
  const selected=await resolvePreparedReturn(f,operation);if(selected.preparation.selectionSha256!==selectionSha256)throw new Error('return_preparation_selection_changed');
  if(!selected.preparation.prepared&&!selected.original.current)throw new Error('return_preparation_source_no_longer_current');beforeWrite();
  if(!await exists(selected.directory))try{await privateDirectory(selected.directory,true);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  await privateDirectory(selected.directory,false);
  for(const [name,bytes] of [['binding.json',selected.binding],['request.json',selected.requestBytes],['config.json',f.configBytes],['plan.json',selected.raw]] as const){beforeWrite();await fixed(join(selected.directory,name),bytes);}
  return selected;
  });
}
