import {lstatSync,readFileSync,realpathSync,existsSync,readdirSync,statSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {hash} from './snapshot.js';

export type ExternalExecutable={kind:'configured-current-executable-v1';configuredPath:string;entrypoint:string;realpath:string;sha256:string};
const pathValid=(p:unknown):p is string=>typeof p==='string'&&isAbsolute(p)&&resolve(p)===p&&!/[\0\r\n]/.test(p);
const claudeDesktop=(path:string)=>/^(.*\/Claude\/claude-code)\/[^/]+\/[^/]+\/claude\.app\/Contents\/MacOS\/claude$/.exec(path);
export const externalExecutableFamily=(path:string)=>{const match=claudeDesktop(path);return match?match[1]+'/current-desktop-cli':path;};
/** Follow the package manager's stable formula entry, never search for an
 * unrelated program or select a path supplied by a model/report. Ordinary
 * operator-owned symlinks are also valid entries. */
export function externalEntrypoint(path:string):string{
  if(!pathValid(path))throw new Error('external_executable_path_invalid');
  const desktop=claudeDesktop(path);
  if(desktop){
    const versions=readdirSync(desktop[1]!,{withFileTypes:true}).filter(d=>d.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}));
    if(!versions.length)throw new Error('external_desktop_entry_unavailable');
    const root=desktop[1]+'/'+versions[0]!.name,builds=readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>root+'/'+d.name+'/claude.app/Contents/MacOS/claude').filter(existsSync).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
    if(!builds[0])throw new Error('external_desktop_entry_unavailable');return builds[0];
  }
  const brew=/^(.*)\/Cellar\/([^/]+)\/[^/]+\/((?:bin|libexec\/bin)\/[^/]+)$/.exec(path);
  if(brew){
    const entry=`${brew[1]}/opt/${brew[2]}/${brew[3]}`;
    if(existsSync(entry)){
      const actual=realpathSync(entry),root=`${brew[1]}/Cellar/${brew[2]}/`;
      if(!actual.startsWith(root)||!actual.endsWith('/'+brew[3]))throw new Error('external_package_entry_changed');
      return entry;
    }
  }
  return path;
}
export function selectExternalExecutable(path:string):ExternalExecutable{
  const entrypoint=externalEntrypoint(path),actual=realpathSync(entrypoint),st=lstatSync(actual);
  if(!st.isFile()||!(st.mode&0o111)||st.size>512*1024*1024)throw new Error('external_executable_invalid');
  return {kind:'configured-current-executable-v1',configuredPath:path,entrypoint,realpath:actual,sha256:hash(readFileSync(actual))};
}
export function assertExternalExecutable(selected:ExternalExecutable){
  try{const actual=selectExternalExecutable(selected.configuredPath);
    if(actual.entrypoint!==selected.entrypoint||actual.realpath!==selected.realpath||actual.sha256!==selected.sha256)throw new Error('changed');
  }catch{throw new Error('external_executable_changed_during_operation');}
}
/** Pure historical check: the original binary need not still be installed. */
export function capturedExternalExecutable(value:any,path:string){
  return value?.kind==='configured-current-executable-v1'&&value.configuredPath===path&&pathValid(value.entrypoint)&&pathValid(value.realpath)&&/^[a-f0-9]{64}$/.test(value.sha256??'');
}
