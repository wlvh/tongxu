import {readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';
import {shaPattern} from './contract.js';
import {verifyObjectSource,type ObjectSource} from './integration-objects.js';
import {regular,exists} from './repair-workspace.js';
import {readIntegrationGit,readIntegrationGitRefusal,integrationGitCaptureSha,type GitStep} from './integration-git.js';

type Row=Record<string,any>;
export type IntegrationMaterial={request:Row;source:Row;directory:string;requestSha256:string;objectSource?:ObjectSource};
export type IntegrationSuccess={success:true;binding:{requestSha256:string;operation:string;subjectSha256:string};candidate:{H:string;B:string;T:string;target:string;repository:string};diff:Buffer;bundle:Buffer;originals:Map<string,Buffer>;steps:number;prefixes:Row[];completedAt:string};
export type IntegrationFailure={success:false;binding:IntegrationSuccess['binding'];reason:string;originals:Map<string,Buffer>;steps:number;partialPrivateArtifactMayExist:true};
export type IntegrationCapture=IntegrationSuccess|IntegrationFailure;
type StepResult=Awaited<ReturnType<typeof readIntegrationGit>>;
const issued=new WeakMap<object,string>();
const digest=(x:IntegrationCapture)=>hash(canonical({...x,...(x.success?{diff:hash(x.diff),bundle:hash(x.bundle)}:{}),originals:[...x.originals].map(([sha,b])=>[sha,hash(b)]).sort()}));
const commit=(tree:string,parents:string[],message:string)=>Buffer.from('tree '+tree+'\n'+[...new Set(parents)].map(p=>'parent '+p+'\n').join('')+'author Tongxu fixed integration <integration@example.invalid> 0 +0000\ncommitter Tongxu fixed integration <integration@example.invalid> 0 +0000\n\n'+message+'\n');
const commitSha=(b:Buffer)=>createHash('sha1').update(Buffer.concat([Buffer.from('commit '+b.length+'\0'),b])).digest('hex');
const text=(r:StepResult)=>new TextDecoder('utf8',{fatal:true}).decode(r.stdout).trim();

/** The same fixed recipe constructs a candidate or verifies its saved command
 * captures. Replaying never calls Git or interprets report-supplied commands. */
export async function integrationRecipe(m:IntegrationMaterial,step:(name:string,s:GitStep)=>Promise<StepResult>):Promise<IntegrationSuccess>{
  if(!m.objectSource)throw new Error('integration_object_source_unverified');verifyObjectSource(m.objectSource,m.request.objects);const subject=m.source.composition.subject,B=subject.B,repo=join(m.directory,'candidate.git'),members=subject.members,originals=new Map<string,Buffer>(),prefixes:Row[]=[];let count=0,completedAt='';
  const run=async(name:string,cwd:string,args:string[],stdin=Buffer.alloc(0),artifacts?:string[],objectDirectory?:string)=>{const r=await step(String(count++).padStart(3,'0')+'-'+name,{cwd,args,stdin,...(artifacts?{artifacts}:{}),...(objectDirectory?{objectDirectory}:{})});for(const b of Object.values(r.originals))originals.set(hash(b),b);if(!r.successful)throw new Error('integration_git_step_failed');if(typeof r.exit.observedAt!=='string'||!Number.isFinite(Date.parse(r.exit.observedAt)))throw new Error('integration_git_capture_changed');completedAt=r.exit.observedAt;return r;};
  await run('git-version',m.directory,['--version']);
  // pack-objects reads fixed object IDs; it invokes no upload-pack hook and
  // does not fetch, checkout, run filters, or move a ref in the author's repo.
  await run('init',repo,['init','--bare','--object-format=sha1','--template=']);
  const heads=[...new Set<string>([B,...members.flatMap((x:Row)=>[x.candidate.B,x.candidate.H])])],pack=await run('source-pack',repo,['pack-objects','--stdout','--revs','--no-reuse-delta','--no-reuse-object','--threads=1'],Buffer.from(heads.join('\n')+'\n'),undefined,m.objectSource.objectDirectory);
  await run('import-pack',repo,['index-pack','--stdin','--strict'],pack.stdout);
  const resolved=text(await run('source-commits',repo,['rev-parse',...heads.map(h=>h+'^{commit}')]));if(resolved!==heads.join('\n'))throw new Error('integration_git_source_identity_changed');
  let previous=B,tree='';
  for(const [i,member] of members.entries()){
    await run('base-'+i,repo,['merge-base','--is-ancestor',member.candidate.B,previous]);const merged=await run('merge-'+i,repo,['merge-tree','--write-tree',previous,member.candidate.H]);tree=text(merged).split('\n')[0]!;
    if(!shaPattern.test(tree)||tree!==m.source.report.stages[i+1]?.tree)throw new Error('integration_reconstructed_tree_changed');
    const bytes=commit(tree,[previous,member.candidate.H],'tongxu fixed prefix\nrequest '+m.requestSha256+'\nmember '+i),H=text(await run('prefix-'+i,repo,['hash-object','-t','commit','-w','--stdin'],bytes));if(H!==commitSha(bytes))throw new Error('integration_commit_identity_changed');prefixes.push({index:i,inputHead:member.candidate.H,parent:previous,H,T:tree,originalTestedHead:m.source.report.stages[i+1].head});previous=H;
  }
  if(tree!==subject.testedTree)throw new Error('integration_reconstructed_tree_changed');
  const bytes=commit(tree,[B],'tongxu minimum integration\nrequest '+m.requestSha256+'\nsubject '+m.request.subjectSha256+'\nsource-operation '+m.request.operation),H=text(await run('candidate',repo,['hash-object','-t','commit','-w','--stdin'],bytes));if(H!==commitSha(bytes))throw new Error('integration_commit_identity_changed');
  const body=await run('candidate-readback',repo,['cat-file','commit',H]);if(!body.stdout.equals(bytes))throw new Error('integration_commit_readback_changed');
  await run('candidate-ref',repo,['update-ref','refs/heads/candidate',H,'0'.repeat(40)]);
  const refs=['refs/heads/candidate'];for(const [i,member] of members.entries()){const ref='refs/tongxu/source/'+i;await run('source-ref-'+i,repo,['update-ref',ref,member.candidate.H,'0'.repeat(40)]);refs.push(ref);}
  const diff=await run('full-diff',repo,['diff','--binary','--full-index','--no-ext-diff','--no-textconv',B,H,'--']);
  const output=join(m.directory,'candidate.bundle'),bundle=await run('bundle',repo,['bundle','create',output,...refs],Buffer.alloc(0),[output]);await run('bundle-verify',repo,['bundle','verify',output]);
  return {success:true,binding:{requestSha256:m.requestSha256,operation:m.request.operation,subjectSha256:m.request.subjectSha256},candidate:{H,B,T:tree,target:subject.targetRef,repository:subject.repository},diff:diff.stdout,bundle:bundle.artifacts[0]!,originals,steps:count,prefixes,completedAt};
}
export async function readIntegrationCapture(m:IntegrationMaterial){
  const producer=await regular(join(m.directory,'producer.json')),p=JSON.parse(producer.toString());if(p.kind!=='tongxu-fixed-git-integration'||p.requestSha256!==m.requestSha256||p.sourceSha256!==hash(canonical(m.source))||p.directory!==m.directory)throw new Error('integration_original_producer_changed');
  const layout=await regular(join(m.directory,'object-source.json')),objectSource=verifyObjectSource(JSON.parse(layout.toString()),m.request.objects);if(p.objectSourceSha256!==hash(layout))throw new Error('integration_object_source_changed');m={...m,objectSource};const originals=new Map<string,Buffer>([[hash(producer),producer],[hash(layout),layout]]);let endedSteps=0,knownFailure:string|null=null;
  let value:IntegrationCapture,boundarySha256:string|null=null;
  if(p.continuationProtocol==='ended-fixed-prefix-v1'){const bytes=await regular(join(m.directory,'boundaries/initial.json'),8*1024*1024),b=JSON.parse(bytes.toString());if(b.protocol!==p.continuationProtocol||b.requestSha256!==m.requestSha256||b.producerSha256!==hash(producer)||b.name!=='initial'||b.previousSha256!==null||b.stepSha256!==null)throw new Error('integration_boundary_capture_changed');boundarySha256=hash(bytes);originals.set(boundarySha256,bytes);}
  try{value=await integrationRecipe(m,async(name,s)=>{const path=join(m.directory,'steps',name);if(await exists(join(path,'not-started.json'))){const r=await readIntegrationGitRefusal(path,s);for(const b of Object.values(r.originals))originals.set(hash(b),b);knownFailure='integration_effect_refused';throw new Error(knownFailure);}
    const r=await readIntegrationGit(path,s);for(const b of Object.values(r.originals))originals.set(hash(b),b);endedSteps++;if(!r.successful)knownFailure='integration_git_step_failed';
    if(r.successful&&p.continuationProtocol==='ended-fixed-prefix-v1'){const bytes=await regular(join(m.directory,'boundaries',name+'.json'),8*1024*1024),b=JSON.parse(bytes.toString());if(b.protocol!==p.continuationProtocol||b.requestSha256!==m.requestSha256||b.producerSha256!==hash(producer)||b.name!==name||b.previousSha256!==boundarySha256||b.stepSha256!==integrationGitCaptureSha(r))throw new Error('integration_boundary_capture_changed');boundarySha256=hash(bytes);originals.set(boundarySha256,bytes);}return r;});
  }catch(e){const why=e instanceof Error?e.message:'';if(!knownFailure&&!['integration_reconstructed_tree_changed','integration_commit_identity_changed','integration_commit_readback_changed','integration_git_source_identity_changed'].includes(why))throw e;
    value={success:false,binding:{requestSha256:m.requestSha256,operation:m.request.operation,subjectSha256:m.request.subjectSha256},reason:knownFailure??why,originals,steps:endedSteps,partialPrivateArtifactMayExist:true};
  }
  // Capture the immutable boundary and continuation declarations that existed
  // before this result. Controller-return notes written after completion are
  // separately retained in their original admission event, not unstable result inputs.
  if(p.continuationProtocol==='ended-fixed-prefix-v1')for(const folder of ['boundaries','continuations'])if(await exists(join(m.directory,folder)))for(const name of (await readdir(join(m.directory,folder))).sort()){if(!/^[a-z0-9-]+\.json$/.test(name))throw new Error('integration_continuation_record_changed');const b=await regular(join(m.directory,folder,name),8*1024*1024);value.originals.set(hash(b),b);}
  value.originals.set(hash(layout),layout);value.originals.set(hash(producer),producer);issued.set(value,digest(value));return value;
}
export function requireIntegrationCapture(value:IntegrationCapture){if(!issued.has(value)||issued.get(value)!==digest(value))throw new Error('integration_managed_capture_required');return value;}
