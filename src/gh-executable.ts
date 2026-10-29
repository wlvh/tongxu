import {selectExternalExecutable,assertExternalExecutable,capturedExternalExecutable,type ExternalExecutable} from './external-executable.js';
import {execFile} from 'node:child_process';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {promisify} from 'node:util';
import {hash} from './snapshot.js';

const exec=promisify(execFile),digest=/^[a-f0-9]{64}$/;
const flags=['--hostname','--method','--include','--input','--header','--raw-field'];
export type GhExecutableSelection={kind:'configured-original-gh-v1'|'configured-current-gh-v1';externalSelection?:ExternalExecutable;configuredPath:string;configuredSha256:string;realpath:string;sha256:string;version?:string;apiHelpSha256?:string};
/** A configured entry can be upgraded. Old fingerprints describe setup, while
 * one read/publication attempt still uses one observed executable throughout. */
export async function selectGhExecutable(path:string,configuredSha256:string):Promise<GhExecutableSelection>{
  if(!isAbsolute(path)||resolve(path)!==path||!digest.test(configuredSha256))throw new Error('gh_entry_invalid');
  const externalSelection=selectExternalExecutable(path),actual=externalSelection.realpath,s=await lstat(actual);
  if(!s.isFile()||s.nlink!==1||!(s.mode&0o111)||s.size>128*1024*1024)throw new Error('gh_entry_invalid');
  const sha256=hash(await readFile(actual)),base={externalSelection,configuredPath:path,configuredSha256,realpath:actual,sha256};
  if(sha256===configuredSha256)return {kind:'configured-original-gh-v1',...base};
  const options={timeout:10000,maxBuffer:2*1024*1024,env:{...process.env,GH_PROMPT_DISABLED:'1',GH_PAGER:'cat',PAGER:'cat'}};
  let version:string,help:string;
  try{version=(await exec(actual,['--version'],options)).stdout.trim();help=(await exec(actual,['api','--help'],options)).stdout;}
  catch{throw new Error('gh_current_capabilities_unavailable');}
  if(version.length>4096||!/^gh version [^\s\x00-\x1f]+(?:\s|$)/.test(version))throw new Error('gh_current_identity_not_observed');
  for(const flag of flags)if(!new RegExp('(^|[\\s,])'+flag+'(?=[\\s,=<\\[]|$)','m').test(help))throw new Error('gh_capability_missing_'+flag.slice(2).replaceAll('-','_'));
  const selected:GhExecutableSelection={kind:'configured-current-gh-v1',...base,version,apiHelpSha256:hash(help)};
  assertGhExecutableUnchanged(selected);return selected;
}
export function assertGhExecutableUnchanged(selected:GhExecutableSelection){
  if(selected.externalSelection){try{assertExternalExecutable(selected.externalSelection);return;}catch{throw new Error('gh_executable_changed_during_operation');}}
  try{const s=lstatSync(selected.realpath);
    if(!s.isFile()||s.nlink!==1||s.size>128*1024*1024||realpathSync(selected.configuredPath)!==selected.realpath||hash(readFileSync(selected.realpath))!==selected.sha256)throw new Error('changed');
  }catch{throw new Error('gh_executable_changed_during_operation');}
}
/** Historical dispatch validation never probes or executes today's gh. */
export function capturedGhExecutableMatches(request:any,path:string,configuredSha256:string){
  if(request?.command!==path||!digest.test(request?.executableHash??''))return false;
  const s=request.executableSelection;
  if(s===undefined)return request.executableHash===configuredSha256;
  if(!s||s.configuredPath!==path||s.configuredSha256!==configuredSha256||s.sha256!==request.executableHash||typeof s.realpath!=='string'||!isAbsolute(s.realpath)||resolve(s.realpath)!==s.realpath)return false;
  if(s.externalSelection!==undefined&&(!capturedExternalExecutable(s.externalSelection,path)||s.externalSelection.sha256!==s.sha256||s.externalSelection.realpath!==s.realpath))return false;
  if(s.kind==='configured-original-gh-v1')return s.sha256===configuredSha256;
  return s.kind==='configured-current-gh-v1'&&typeof s.version==='string'&&s.version.length<=4096&&/^gh version [^\s\x00-\x1f]+(?:\s|$)/.test(s.version)&&digest.test(s.apiHelpSha256??'');
}
