import {readdir,readFile,writeFile} from 'node:fs/promises';
import {lstatSync,readdirSync,readFileSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists,processState} from './repair-workspace.js';
import {integrationRecipe,type IntegrationMaterial} from './integration-producer.js';
import {readIntegrationGit,integrationGitCaptureSha as stepHash} from './integration-git.js';
import {verifyObjectSource} from './integration-objects.js';
import {requireNodeRuntime} from './workbench-launch.js';

export const integrationContinuationProtocol='ended-fixed-prefix-v1';
export const integrationRuntimeNames=['integration','integration-store','integration-contract','integration-producer','integration-git','integration-objects','integration-continuation','queue-store','authority-store','workbench-launch'];
export async function integrationRuntimeHashes(){return Object.fromEntries(await Promise.all(integrationRuntimeNames.map(async n=>[n,hash(await readFile(new URL('./'+n+'.js',import.meta.url)))])));}
const encoded=(x:unknown)=>Buffer.from(canonical(x));
type StepResult=Awaited<ReturnType<typeof readIntegrationGit>>;
export type IntegrationContinuationProof={material:IntegrationMaterial;producerSha256:string;lastBoundarySha256:string;completedSteps:string[];completedCaptures:Record<string,Record<string,string>>;nextStep:string;priorControllerEnded:true;priorChildrenEnded:true;privateStateMatches:true;originals:Map<string,Buffer>};
const issued=new WeakMap<object,string>();
const proofDigest=(p:IntegrationContinuationProof)=>hash(canonical({...p,material:{request:p.material.request,source:p.material.source,directory:p.material.directory,requestSha256:p.material.requestSha256,objectSource:p.material.objectSource},originals:[...p.originals].map(([sha,b])=>[sha,hash(b)]).sort()}));
export function requireIntegrationContinuation(p:IntegrationContinuationProof){if(!issued.has(p)||issued.get(p)!==proofDigest(p))throw new Error('integration_checked_continuation_required');return p;}
async function save(path:string,bytes:Buffer){await writeFile(path,bytes,{flag:'wx',mode:0o600});}

/** Hash only the private candidate output, never the author's checkout. A
 * successful command boundary has no live process or unexplained lock file. */
export function integrationPrivateState(directory:string){
  const files:Record<string,{kind:string;mode:number;bytes?:number;sha256?:string}>={};let count=0,total=0;
  const visit=(relative:string)=>{
    const path=join(directory,relative),s=lstatSync(path);if(++count>20000||s.isSymbolicLink()||relative.split('/').some(x=>x.endsWith('.lock'))||realpathSync(path)!==path)throw new Error('integration_private_state_unverified');
    if(s.isDirectory()){files[relative]={kind:'directory',mode:s.mode&0o777};for(const name of readdirSync(path).sort())visit(relative+'/'+name);}
    else if(s.isFile()&&s.nlink===1){total+=s.size;if(s.size>64*1024*1024||total>256*1024*1024)throw new Error('integration_private_state_limit');const b=readFileSync(path);if(b.length!==s.size)throw new Error('integration_private_state_unverified');files[relative]={kind:'file',mode:s.mode&0o777,bytes:b.length,sha256:hash(b)};}
    else throw new Error('integration_private_state_unverified');
  };
  visit('candidate.git');if(existsSync(join(directory,'candidate.bundle')))visit('candidate.bundle');return files;
}
export function checkIntegrationContinuationBoundary(proof:IntegrationContinuationProof){
  const p=requireIntegrationContinuation(proof),bytes=p.originals.get(p.lastBoundarySha256);if(!bytes||hash(bytes)!==p.lastBoundarySha256||canonical(integrationPrivateState(p.material.directory))!==canonical(JSON.parse(bytes.toString()).state))throw new Error('integration_continuation_private_state_changed');
  for(const name of p.completedSteps)for(const [file,sha] of Object.entries(p.completedCaptures[name]!)){const path=join(p.material.directory,'steps',name,file),stat=lstatSync(path);if(!stat.isFile()||stat.nlink!==1||stat.size>64*1024*1024||realpathSync(path)!==path||hash(readFileSync(path))!==sha)throw new Error('integration_continuation_prefix_capture_changed');}
}
export function checkIntegrationPrefixCapture(proof:IntegrationContinuationProof,name:string,result:StepResult){const p=requireIntegrationContinuation(proof);if(!p.completedCaptures[name]||stepHash(result)!==hash(canonical(p.completedCaptures[name])))throw new Error('integration_continuation_prefix_capture_changed');}

export async function recordIntegrationBoundary(m:IntegrationMaterial,name:string,result:StepResult|null,previousSha256:string|null){
  if(name!=='initial'&&!/^\d{3}-[a-z0-9-]+$/.test(name)||result&&!result.successful)throw new Error('integration_boundary_not_successful');
  const directory=join(m.directory,'boundaries');if(!await exists(directory))await privateDirectory(directory,true);else await privateDirectory(directory,false);
  const bytes=encoded({schemaVersion:1,protocol:integrationContinuationProtocol,requestSha256:m.requestSha256,producerSha256:hash(await regular(join(m.directory,'producer.json'))),name,previousSha256,stepSha256:result?stepHash(result):null,state:await integrationPrivateState(m.directory)});
  await save(join(directory,name+'.json'),bytes);return {sha256:hash(bytes),bytes};
}
export async function integrationControllerReturned(directory:string,id:string,producerSha256:string){
  const root=join(directory,'controller-returns');if(!await exists(root))await privateDirectory(root,true);else await privateDirectory(root,false);
  await save(join(root,id+'.json'),encoded({schemaVersion:1,id,producerSha256,controllerPid:process.pid,returned:true,at:new Date().toISOString()}));
}
async function requireEnded(directory:string,id:string,pid:unknown,producerSha256:string,originals:Map<string,Buffer>){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(pid)||Number(pid)<2)throw new Error('integration_original_controller_unknown');
  const path=join(directory,'controller-returns',id+'.json');
  if(await exists(path)){const bytes=await regular(path),returned=JSON.parse(bytes.toString());if(returned.schemaVersion!==1||returned.id!==id||returned.producerSha256!==producerSha256||returned.controllerPid!==pid||returned.returned!==true||!Number.isFinite(Date.parse(returned.at)))throw new Error('integration_original_controller_end_changed');originals.set(hash(bytes),bytes);return;}
  if(processState(pid)!=='ended')throw new Error('integration_original_controller_active_or_unknown');
}

/** The probe only replays captured bytes. It issues no Git command, changes
 * no ref, and never repairs or deletes the evidence it is trying to verify. */
export async function inspectIntegrationContinuation(m:IntegrationMaterial){
  const producerBytes=await regular(join(m.directory,'producer.json')),producer=JSON.parse(producerBytes.toString()),producerSha256=hash(producerBytes);
  const originals=new Map<string,Buffer>([[producerSha256,producerBytes]]);
  if(producer.kind!=='tongxu-fixed-git-integration'||producer.requestSha256!==m.requestSha256||producer.sourceSha256!==hash(canonical(m.source))||producer.directory!==m.directory||producer.continuationProtocol!==integrationContinuationProtocol)throw new Error('integration_continuation_original_protocol_required');
  if(canonical(producer.runtimeModules)!==canonical(await integrationRuntimeHashes()))throw new Error('integration_continuation_executor_changed');
  await requireNodeRuntime();
  await requireEnded(m.directory,producer.controllerId,producer.controllerPid,producerSha256,originals);
  const attempts=join(m.directory,'continuations');if(await exists(attempts))for(const name of await readdir(attempts)){
    if(!/^[a-f0-9-]{36}\.json$/.test(name))throw new Error('integration_continuation_record_changed');const bytes=await regular(join(attempts,name)),a=JSON.parse(bytes.toString());originals.set(hash(bytes),bytes);
    if(a.id+'.json'!==name||a.producerSha256!==producerSha256||a.requestSha256!==m.requestSha256)throw new Error('integration_continuation_record_changed');await requireEnded(m.directory,a.id,a.controllerPid,producerSha256,originals);
  }
  const layoutBytes=await regular(join(m.directory,'object-source.json'));if(hash(layoutBytes)!==producer.objectSourceSha256)throw new Error('integration_object_source_changed');
  const objectSource=verifyObjectSource(JSON.parse(layoutBytes.toString()),m.request.objects),material={...m,objectSource};
  const initialBytes=await regular(join(m.directory,'boundaries/initial.json'),8*1024*1024),initial=JSON.parse(initialBytes.toString());
  originals.set(hash(initialBytes),initialBytes);originals.set(hash(layoutBytes),layoutBytes);
  const check=(b:any,name:string,previous:string|null,result:StepResult|null)=>{if(b.schemaVersion!==1||b.protocol!==integrationContinuationProtocol||b.requestSha256!==m.requestSha256||b.producerSha256!==producerSha256||b.name!==name||b.previousSha256!==previous||b.stepSha256!==(result?stepHash(result):null)||!b.state||typeof b.state!=='object')throw new Error('integration_boundary_binding_changed');};
  check(initial,'initial',null,null);let last=initial,lastSha256=hash(initialBytes),missing:string|null=null;const names:string[]=[],completedCaptures:Record<string,Record<string,string>>={};
  const boundaryMissing=new Error('integration_continuation_next_step');
  try{await integrationRecipe(material,async(name,step)=>{
    const directory=join(m.directory,'steps',name);if(!await exists(directory)){missing=name;throw boundaryMissing;}
    const result=await readIntegrationGit(directory,step);if(!result.successful)throw new Error('integration_continuation_failed_step');
    const process=JSON.parse(result.originals['process.json']!.toString());if(processState(process.pid)!=='ended')throw new Error('integration_original_child_active_or_unknown');
    const bytes=await regular(join(m.directory,'boundaries',name+'.json'),8*1024*1024),boundary=JSON.parse(bytes.toString());check(boundary,name,lastSha256,result);last=boundary;lastSha256=hash(bytes);originals.set(lastSha256,bytes);for(const b of Object.values(result.originals))originals.set(hash(b),b);completedCaptures[name]=Object.fromEntries(Object.entries(result.originals).map(([file,b])=>[file,hash(b)]));names.push(name);return result;
  });}catch(e){if(e!==boundaryMissing)throw e;}
  if(!missing)throw new Error('integration_continuation_complete_capture_use_reconcile');
  if(canonical((await readdir(join(m.directory,'steps'))).sort())!==canonical([...names].sort())||canonical((await readdir(join(m.directory,'boundaries'))).sort())!==canonical(['initial.json',...names.map(n=>n+'.json')].sort()))throw new Error('integration_continuation_unexplained_step');
  if(canonical(await integrationPrivateState(m.directory))!==canonical(last.state))throw new Error('integration_continuation_private_state_changed');
  const proof:IntegrationContinuationProof={material,producerSha256,lastBoundarySha256:lastSha256,completedSteps:names,completedCaptures,nextStep:missing,priorControllerEnded:true,priorChildrenEnded:true,privateStateMatches:true,originals};issued.set(proof,proofDigest(proof));return proof;
}
export async function recordIntegrationContinuation(directory:string,id:string,proof:Awaited<ReturnType<typeof inspectIntegrationContinuation>>){
  const root=join(directory,'continuations');if(!await exists(root))await privateDirectory(root,true);else await privateDirectory(root,false);
  const bytes=encoded({schemaVersion:1,id,requestSha256:proof.material.requestSha256,producerSha256:proof.producerSha256,controllerPid:process.pid,node:await requireNodeRuntime(),completedSteps:proof.completedSteps,nextStep:proof.nextStep,lastBoundarySha256:proof.lastBoundarySha256,checkedAt:new Date().toISOString()});await save(join(root,id+'.json'),bytes);return bytes;
}
