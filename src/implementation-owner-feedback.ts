import {validationResultCapture,readFailedValidationTests} from './implementation-validation.js';
import {assertUnselectedGitUnchanged} from './repair-workspace.js';
import {lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId} from './message-contract.js';
import {regular,tree,treeHash,type Tree} from './repair-workspace.js';
import {readRepairSession} from './repair-native.js';
import {observeTaskWorkspace,taskGitReadSync,type TaskObservation} from './task-source.js';
import type {DevelopmentTask} from './task-contract.js';

type Row=Record<string,any>;
export type ImplementationOwnerTarget={source:string;requestId:string;task:string;operation:string;requestSha256:string};
export type OwnerContactReference={task:string;key:string};
export type ImplementationOwnerSnapshot={target:ImplementationOwnerTarget;state:Row;request:Row;definition:DevelopmentTask;family:Row[];resourcesSettled:boolean;currentAdoption:string|null};
type FileRef={path:string;sha256:string|null};
export type ImplementationOwnerProof={target:ImplementationOwnerTarget;logicalOwner:string;resultSha256:string;H:string;treeSha256:string;adoption:string;observation:TaskObservation;files:FileRef[];definition:DevelopmentTask;material:Row};
const issued=new WeakMap<object,string>();

export function implementationOwnerTarget(value:unknown):value is ImplementationOwnerTarget{
 const t=value as Row;
 return !!t&&exactKeys(t,['source','requestId','task','operation','requestSha256'])&&messageId(t.source)&&messageId(t.requestId)&&isAuthorityDigest(t.task)&&messageId(t.operation)&&isAuthorityDigest(t.requestSha256);
}
export function ownerContactReference(value:unknown):value is OwnerContactReference{
 const r=value as Row;return !!r&&exactKeys(r,['task','key'])&&isAuthorityDigest(r.task)&&isAuthorityDigest(r.key);
}

/** The original implementation result is checked against its actual ended
 * native capture. Its SQLite result remains authoritative; no new model runs. */
export async function readImplementationResult(state:Row){
 if(!state.result)throw new Error('implementation_original_report_not_available');
 if(state.result.completeCapture){
  const root=state.plan.operationRoot,capture=await readRepairSession(await validationResultCapture(state));
  const manifest=JSON.parse((await regular(join(root,'input-manifest.json'))).toString()),{inputManifestSha256,...original}=manifest;
  if(hash(canonical(original))!==inputManifestSha256||capture.binding.inputManifestSha256!==inputManifestSha256||capture.binding.role!=='implementer'||capture.binding.sessionId!==state.result.sessionId||manifest.planSha256!==state.plan.sha256||canonical(manifest.request)!==canonical(state.plan.request)||capture.turns.length!==1||canonical(JSON.parse(capture.turns[0]!.final!.text))!==canonical(state.result.report))throw new Error('implementation_original_capture_changed');
 }
 if(state.result.status==='completed'&&state.plan.request.workspaceRequest.materialView==='selected_files')await assertUnselectedGitUnchanged(state.plan.workspace,state.H0,state.result.H1,[...state.plan.request.workspaceRequest.materialPaths,...state.plan.request.workspaceRequest.protectedPaths]);
 if(state.result.status==='failed'){const p=JSON.parse((await regular(state.plan.path)).toString()),t=await readFailedValidationTests(state.result.testsDirectory,p);if(canonical(t.result)!==canonical(state.result.tests)||state.result.H1!==null)throw new Error('implementation_validation_capture_changed');}
 return {id:state.id,task:state.task,issue:state.issue,operation:state.operation,...state.result,...(state.validationFailure?{originalValidationFailure:{report:state.validationFailure.report,tests:state.validationFailure.tests,sessionId:state.validationFailure.sessionId}}:{})};
}

/** These are reads of the completed, bounded workspace, including ignored and
 * untracked files. Git's working-tree filters and hooks are never executed. */
function sourceTreeSync(workspace:string):Tree{
 if(realpathSync(workspace)!==workspace)throw new Error('owner_feedback_workspace_changed');
 const result:Tree=Object.create(null);
 const walk=(sub:string)=>{for(const name of readdirSync(join(workspace,sub)).sort()){
  if(!sub&&name==='.git')continue;
  const path=sub?sub+'/'+name:name,full=join(workspace,path),s=lstatSync(full);
  if(s.isSymbolicLink()||!/^[-A-Za-z0-9_.\/]+$/.test(path))throw new Error('owner_feedback_workspace_changed');
  if(s.isDirectory())walk(path);
  else{if(!s.isFile()||s.nlink!==1||s.size>256*1024||realpathSync(full)!==full)throw new Error('owner_feedback_workspace_changed');const b=readFileSync(full);if(b.length!==s.size)throw new Error('owner_feedback_workspace_changed');result[path]={sha256:hash(b),bytes:b.length,text:new TextDecoder('utf8',{fatal:true}).decode(b),executable:s.mode&0o111};}
  if(Object.keys(result).length>2048)throw new Error('owner_feedback_source_limit');
 }};walk('');if(Buffer.byteLength(JSON.stringify(result))>16*1024*1024)throw new Error('owner_feedback_source_limit');return result;
}
function absent(path:string){try{lstatSync(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}}
export function assertImplementationOwnerSourceSync(proof:ImplementationOwnerProof){
 const p=proof.definition;
 if(taskGitReadSync(p,['rev-parse','--verify','HEAD^{commit}']).trim()!==proof.H||!absent(join(p.workspace,'.git','tongxu-writer.json'))||!absent(join(p.workspace,'.git','index.lock'))||treeHash(sourceTreeSync(p.workspace))!==proof.treeSha256)throw new Error('owner_feedback_source_no_longer_current');
 try{taskGitReadSync(p,['diff-index','--cached','--quiet',proof.H,'--']);}catch{throw new Error('owner_feedback_index_changed');}
 for(const f of proof.files){if(f.sha256===null){if(!absent(f.path))throw new Error('owner_feedback_original_capture_changed');continue;}const s=lstatSync(f.path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>32*1024*1024||realpathSync(f.path)!==f.path||hash(readFileSync(f.path))!==f.sha256)throw new Error('owner_feedback_original_capture_changed');}
}
export function checkImplementationOwnerSnapshot(snapshot:ImplementationOwnerSnapshot,proof?:ImplementationOwnerProof){
 const {target:t,state:s,request:r}=snapshot;
 if(!implementationOwnerTarget(t)||s.source!==t.source||s.id!==t.requestId||s.task!==t.task||s.operation!==t.operation||s.requestSha256!==t.requestSha256||r.task!==t.task||r.id!==t.requestId)throw new Error('owner_feedback_original_target_changed');
 if(s.stopped||s.phase!=='returned'||!['completed','no_change'].includes(s.result?.status)||!s.result.completeCapture||!snapshot.resourcesSettled)throw new Error('owner_feedback_original_pending_or_unknown');
 const latest=snapshot.family.filter(x=>x.logicalOwner===s.logicalOwner&&x.result?.status!=='cancelled_unstarted').at(-1);
 if(!latest||latest.id!==s.id||latest.operation!==s.operation)throw new Error('owner_feedback_original_result_superseded');
 if(snapshot.currentAdoption!==r.adoptedScope.adoption)throw new Error('owner_feedback_adopted_requirement_changed');
 if(proof&&(canonical(proof.target)!==canonical(t)||proof.logicalOwner!==s.logicalOwner||proof.resultSha256!==hash(canonical(s.result))||proof.adoption!==snapshot.currentAdoption||proof.H!==(s.result.H1??s.result.H0)))throw new Error('owner_feedback_fixed_result_changed');
}

export async function readImplementationOwnerProof(snapshot:ImplementationOwnerSnapshot):Promise<ImplementationOwnerProof>{
 checkImplementationOwnerSnapshot(snapshot);
 const {state:s,request:r,definition}=snapshot,result=await readImplementationResult(s),H=result.H1??result.H0;
 if(result.H0!==r.workspaceRequest.candidate.H||result.status==='completed'&&(!result.H1||result.H1===result.H0||result.testCandidateBinding?.candidate?.H!==H)||definition.workspace!==s.plan.workspace)throw new Error('owner_feedback_original_result_changed');
 const current=await tree(definition.workspace,true),expected=result.status==='completed'?result.treeSha256:treeHash(JSON.parse((await regular(join(s.plan.operationRoot,'initial-tree.json'),20*1024*1024)).toString()));
 if(treeHash(current)!==expected)throw new Error('owner_feedback_source_no_longer_current');
 const native=await validationResultCapture(s),names=['completed.json','binding.json','reconciled-tools.json','expected-requests.json','exit.json','stdout.ndjson','stdin.ndjson','stderr.txt','capture-status.json','capture-failure.json','native-tool-transports.json'];
 if(s.firstInputContinuation||s.validationCorrection)names.push('inputs.json','thread.json','executable.json','effective-config.json','launch.json','process.json');
 const files:FileRef[]=[];for(const name of names){const path=join(native,name);try{files.push({path,sha256:hash(await regular(path,32*1024*1024))});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;files.push({path,sha256:null});}}
 for(const name of ['input-manifest.json','initial-tree.json']){const path=join(s.plan.operationRoot,name);files.push({path,sha256:hash(await regular(path,20*1024*1024))});}
 for(const [name,sha256] of Object.entries(s.firstInputContinuation?.proof.files??{}) as Array<[string,string]>)files.push({path:join(r.workspaceRequest.executionRoot,name),sha256});
 for(const [path,sha256] of Object.entries(s.validationFailure?.files??{}) as Array<[string,string]>)files.push({path,sha256});
 const observation=await observeTaskWorkspace(definition);
 if(observation.head!==H)throw new Error('owner_feedback_source_no_longer_current');
 const proof:ImplementationOwnerProof={target:snapshot.target,logicalOwner:s.logicalOwner,resultSha256:hash(canonical(s.result)),H,treeSha256:expected,adoption:r.adoptedScope.adoption,definition,observation,files,
  material:{kind:'tongxu-original-implementation-owner-feedback',originalTarget:snapshot.target,logicalOwner:s.logicalOwner,originalNativeSession:result.sessionId,newReadonlyContext:true,nativeSessionResumed:false,H0:result.H0,H1:result.H1,effectiveHead:H,issue:{number:r.issue.number,bodySha256:r.issue.bodySha256,adoption:r.adoptedScope.adoption,scopeBodySha256:r.adoptedScope.bodySha256},originalReport:result.report,originalResultSha256:hash(canonical(s.result)),permissionsGranted:false}};
 assertImplementationOwnerSourceSync(proof);issued.set(proof,hash(canonical(proof)));return proof;
}
export function requireIssuedImplementationOwnerProof(proof:ImplementationOwnerProof){if(issued.get(proof)!==hash(canonical(proof)))throw new Error('owner_feedback_actual_source_proof_required');assertImplementationOwnerSourceSync(proof);return proof;}
