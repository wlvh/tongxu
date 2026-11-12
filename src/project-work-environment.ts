import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DockerRuntime,parseDockerConfig,dockerEvidenceMatches,dockerTerminalEvidence,type DockerConfig,type DockerStartGate} from './docker-sandbox.js';
import {canonical} from './comparison.js';
import {hash,privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';

// Host-owned and independent of all repository text. No source/other mounts.
export const workEnvironmentProbe=`const fs=require('node:fs'),cp=require('node:child_process');const options={encoding:'utf8',timeout:3000,maxBuffer:4096};const child=cp.spawnSync(process.execPath,['-e','process.stdout.write("child-ok")'],options);let bash=null;for(const path of ['/bin/bash','/usr/bin/bash']){if(!fs.existsSync(path))continue;const r=cp.spawnSync(path,['--noprofile','--norc','--version'],options);bash={path,available:!r.error&&r.status===0,version:!r.error&&r.status===0?r.stdout.split(String.fromCharCode(10))[0].slice(0,256):null};break;}console.log(JSON.stringify({node:process.version,childProcess:!child.error&&child.status===0&&child.stdout==='child-ok',bash,workPresent:fs.existsSync('/work')}));`;
const files=['runtime/connection.json','runtime/probe-result.json','runtime/probe/execution.json','runtime/probe/stdout','runtime/probe/stderr','capability/execution.json','capability/stdout','capability/stderr'] as const;
type Row=Record<string,any>;
export type WorkEnvironment={schemaVersion:2;configurationSha256:string;imageId:string;observed:{node:string;childProcess:boolean;bash:{path:string;available:boolean;version:string|null}|null;workPresent:boolean};evidenceSha256:string;networkAccess:false;sourceMounted:false;hostShell:false};
function observation(x:Row):WorkEnvironment['observed']{
  if(!/^v\d+\.\d+\.\d+(?:[-.\w]*)?$/.test(x.node)||typeof x.childProcess!=='boolean'||typeof x.workPresent!=='boolean'||x.bash!==null&&(!['/bin/bash','/usr/bin/bash'].includes(x.bash?.path)||typeof x.bash.available!=='boolean'||(x.bash.available?typeof x.bash.version!=='string'||!x.bash.version||x.bash.version.length>256:x.bash.version!==null)))throw new Error('project_work_environment_observation_invalid');
  return x as WorkEnvironment['observed'];
}
/** Only confirm ended original probes; never inspect/stop/start a container on GET. */
export async function assertWorkEnvironmentEnded(directory:string,config:DockerConfig){
  for(const path of ['runtime/probe','capability']){
    const dir=join(directory,path);if(!await exists(dir))continue;
    const record=await regular(join(dir,'execution.json')),original=JSON.parse(record.toString());
    if(!['ended','not_started'].includes(dockerTerminalEvidence(record,config,dir,original.binding)))throw new Error('project_work_environment_original_unknown');
  }
}
export async function prepareWorkEnvironment(config:DockerConfig,directory:string,H:string,T:string,gate:DockerStartGate){
  await privateDirectory(directory,true);
  const runtime=await DockerRuntime.prepare(config,join(directory,'runtime'),gate),binding={run:directory,stage:0,tool:'work-validation-capabilities',head:H,tree:T,planHash:hash(canonical(config))};
  const result=await runtime.run({directory:join(directory,'capability'),argv:[config.node,'-e',workEnvironmentProbe],timeoutMs:10000,maxBytes:4*1024*1024,binding,startGate:gate});
  if(result.status!=='completed'||result.exitCode!==0)throw new Error('project_work_environment_probe_failed');
  const observed=observation(JSON.parse(result.stdout.toString()));
  const hashes:Record<string,string>={};for(const name of files)hashes[name]=hash(await regular(join(directory,name)));
  const proof={schemaVersion:2,configuration:config,binding,imageId:runtime.connection.imageId,observed,files:hashes};
  await writeFile(join(directory,'observation.json'),canonical(proof),{flag:'wx',mode:0o600});
  return readWorkEnvironment(directory,H,T);
}
export async function readWorkEnvironment(directory:string,H:string,T:string):Promise<WorkEnvironment>{
  const bytes=await regular(join(directory,'observation.json')),p=JSON.parse(bytes.toString()),config=parseDockerConfig(p.configuration),configurationSha256=hash(canonical(config));
  if(p.schemaVersion!==2||canonical(p.binding)!==canonical({run:directory,stage:0,tool:'work-validation-capabilities',head:H,tree:T,planHash:configurationSha256})||!/^sha256:[a-f0-9]{64}$/.test(p.imageId)||canonical(Object.keys(p.files).sort())!==canonical([...files].sort()))throw new Error('project_work_environment_binding_changed');
  for(const name of files)if(hash(await regular(join(directory,name)))!==p.files[name])throw new Error('project_work_environment_evidence_changed');
  const connection=JSON.parse((await regular(join(directory,'runtime/connection.json'))).toString());
  if(connection.imageId!==p.imageId||canonical(connection.config)!==canonical(config))throw new Error('project_work_environment_binding_changed');
  for(const [relative,limit,binding] of [['runtime/probe',16384,undefined],['capability',4*1024*1024,p.binding]] as const){
    const dir=join(directory,relative),raw=await regular(join(dir,'execution.json')),r=JSON.parse(raw.toString()),stdout=await regular(join(dir,'stdout')),stderr=await regular(join(dir,'stderr'));
    if(dockerTerminalEvidence(raw,config,dir,binding)!=='ended'||r.status!=='completed'||r.exitCode!==0||r.maxBytes!==limit||canonical(r.paths)!=='{}'||canonical(r.connection)!==canonical(connection)||r.capture?.complete!==true||hash(stdout)!==r.capture.stdoutSha256||hash(stderr)!==r.capture.stderrSha256)throw new Error('project_work_environment_evidence_changed');
    if(relative==='capability'&&!dockerEvidenceMatches(raw,config,p.binding,{dockerExecutionDirectory:'capability',argv:[config.node,'-e',workEnvironmentProbe],status:'completed',exitCode:0,stdout:{sha256:hash(stdout),bytes:stdout.length},stderr:{sha256:hash(stderr),bytes:stderr.length}},10000))throw new Error('project_work_environment_evidence_changed');
  }
  const observed=observation(JSON.parse((await regular(join(directory,'capability/stdout'))).toString()));
  if(canonical(observed)!==canonical(p.observed))throw new Error('project_work_environment_observation_changed');
  return {schemaVersion:2,configurationSha256,imageId:p.imageId,observed,evidenceSha256:hash(bytes),networkAccess:false,sourceMounted:false,hostShell:false};
}
