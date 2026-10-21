import {lstat,realpath} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {exists,regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';

type Marker={path:string;text:string;sha256:string};
export type ObjectSource={kind:'local-git-object-directory-v1';repository:string;layout:'bare'|'directory'|'gitfile';gitDirectory:string;commonDirectory:string;objectDirectory:string;markers:Marker[]};
const path=(x:string)=>isAbsolute(x)&&resolve(x)===x&&!/[\x00-\x1f\x7f]/.test(x);
function line(s:string){const value=s.replace(/\r?\n$/,'');if(!value||/[\x00-\x1f\x7f]/.test(value))throw new Error('integration_git_layout_invalid');return value;}
/** Resolve only standard layout markers as data. No Git process is ever run
 * with the author's repository as its Git directory or working directory. */
export async function inspectObjectSource(repository:string):Promise<ObjectSource>{
  if(!path(repository)||await realpath(repository)!==repository||!(await lstat(repository)).isDirectory())throw new Error('integration_object_source_invalid');
  const markers:Marker[]=[],read=async(p:string)=>{const b=await regular(p,4096),text=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(b);if(!Buffer.from(text).equals(b))throw new Error('integration_git_layout_invalid');markers.push({path:p,text,sha256:hash(b)});return text;};
  const dot=join(repository,'.git');let layout:ObjectSource['layout']='bare',gitDirectory=repository;
  if(await exists(dot)){const s=await lstat(dot);if(s.isSymbolicLink())throw new Error('integration_git_layout_invalid');if(s.isDirectory()){layout='directory';gitDirectory=dot;}else{layout='gitfile';const text=line(await read(dot));if(!text.startsWith('gitdir: '))throw new Error('integration_git_layout_invalid');gitDirectory=resolve(repository,text.slice(8));}}
  if(!path(gitDirectory)||await realpath(gitDirectory)!==gitDirectory||!(await lstat(gitDirectory)).isDirectory())throw new Error('integration_git_layout_invalid');
  // HEAD is a bounded layout marker, never executed or used to select a head.
  await read(join(gitDirectory,'HEAD'));let commonDirectory=gitDirectory;
  if(await exists(join(gitDirectory,'commondir')))commonDirectory=resolve(gitDirectory,line(await read(join(gitDirectory,'commondir'))));
  const objectDirectory=join(commonDirectory,'objects');if(!path(commonDirectory)||await realpath(commonDirectory)!==commonDirectory||await realpath(objectDirectory)!==objectDirectory||!(await lstat(objectDirectory)).isDirectory())throw new Error('integration_git_layout_invalid');
  const value:ObjectSource={kind:'local-git-object-directory-v1',repository,layout,gitDirectory,commonDirectory,objectDirectory,markers};verifyObjectSource(value,repository);return value;
}
export function verifyObjectSource(p:ObjectSource,repository:string){
  if(p?.kind!=='local-git-object-directory-v1'||p.repository!==repository||!path(repository)||!Array.isArray(p.markers)||p.markers.length>3||new Set(p.markers.map(m=>m.path)).size!==p.markers.length||p.markers.some(m=>typeof m.text!=='string'||hash(m.text)!==m.sha256))throw new Error('integration_git_layout_invalid');
  const expected:string[]=[],read=(name:string)=>{expected.push(name);const m=p.markers.find(m=>m.path===name);if(!m)throw new Error('integration_git_layout_invalid');return m.text;};let gitDirectory=repository;
  if(p.layout==='directory')gitDirectory=join(repository,'.git');else if(p.layout==='gitfile'){const text=line(read(join(repository,'.git')));if(!text.startsWith('gitdir: '))throw new Error('integration_git_layout_invalid');gitDirectory=resolve(repository,text.slice(8));}else if(p.layout!=='bare')throw new Error('integration_git_layout_invalid');
  line(read(join(gitDirectory,'HEAD')));const commonMarker=p.markers.find(m=>m.path===join(gitDirectory,'commondir')),commonDirectory=commonMarker?resolve(gitDirectory,line(read(commonMarker.path))):gitDirectory;
  if(!path(gitDirectory)||!path(commonDirectory)||gitDirectory!==p.gitDirectory||commonDirectory!==p.commonDirectory||join(commonDirectory,'objects')!==p.objectDirectory||canonical(expected.sort())!==canonical(p.markers.map(m=>m.path).sort()))throw new Error('integration_git_layout_invalid');return p;
}
