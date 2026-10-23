import {readFileSync,lstatSync,realpathSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';

/** All receiver entry points use this read-only check under the same queue
 * admission transaction. Its only subprocess is a fixed read-only index check;
 * no provider CLI, model, network, repair, or index refresh is invoked. */
export function verifyMemberRefutationOriginals(executionRoot:string,terminalSha256:string,result:any,requestSha256:string){
  const read=(path:string,limit:number)=>{if(resolve(path)!==path||realpathSync(path)!==path)throw new Error('completion_evidence_changed');const stat=lstatSync(path);if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw new Error('completion_evidence_changed');const bytes=readFileSync(path);if(bytes.length!==stat.size)throw new Error('completion_evidence_changed');return bytes;};
  const operation=join(executionRoot,'operation'),terminalBytes=read(join(operation,'terminal-record.json'),4*1024*1024);
  if(hash(terminalBytes)!==terminalSha256)throw new Error('completion_evidence_changed');const terminal=JSON.parse(terminalBytes.toString());
  if(canonical(terminal.result)!==canonical(result)||!terminal.files||typeof terminal.files!=='object'||Object.keys(terminal.files).length>20000)throw new Error('completion_evidence_changed');
  let total=0;for(const [path,digest] of Object.entries(terminal.files)){if(!path||path.startsWith('/')||/[\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw new Error('completion_evidence_changed');const bytes=read(join(operation,path),32*1024*1024);total+=bytes.length;if(total>512*1024*1024||hash(bytes)!==digest)throw new Error('completion_evidence_changed');}
  const workspace=join(executionRoot,'workspace'),git=join(workspace,'.git'),marker=JSON.parse(read(join(git,'tongxu-managed.json'),1024*1024).toString());
  if(marker.kind!=='owned-project-workspace'||marker.executionRoot!==executionRoot||marker.requestSha256!==requestSha256||hash(read(join(executionRoot,'request.json'),2*1024*1024))!==requestSha256||canonical(marker.sourceCandidate)!==canonical(result.sourceCandidate)||marker.initialH!==result.before.H||marker.preparerSourceWritesFinished!==true||existsSync(join(git,'tongxu-writer.json')))throw new Error('completed_workspace_changed');
  // The owned preparer creates these exact loose refs. If another actor packs
  // or replaces them, the changed metadata needs inspection before new work.
  if(read(join(git,'HEAD'),4096).toString()!=='ref: refs/heads/repair-project\n'||read(join(git,'refs/heads/repair-project'),4096).toString().trim()!==result.after.H||read(join(git,'refs/heads/project-base'),4096).toString().trim()!==result.before.H)throw new Error('completed_workspace_changed');
  // Worktree bytes alone miss staged mode-only changes. Compare the index to
  // the exact commit without refreshing it or invoking external diff drivers.
  try{execFileSync('/usr/bin/git',['--no-optional-locks','--no-replace-objects','--no-lazy-fetch','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-C',workspace,'diff-index','--cached','--quiet','--no-ext-diff','--no-textconv',result.after.H,'--'],{env:{PATH:'/usr/bin:/bin',LANG:'C',HOME:workspace,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_ATTR_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:''},stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:65536});}catch{throw new Error('completed_workspace_changed');}
  const tree:Record<string,unknown>=Object.create(null);let files=0;
  const walk=(sub:string)=>{for(const name of readdirSync(join(workspace,sub)).sort()){if(!sub&&name==='.git')continue;const path=sub?sub+'/'+name:name,full=join(workspace,path),stat=lstatSync(full);if(stat.isSymbolicLink()||!/^[A-Za-z0-9_.\/-]+$/.test(path))throw new Error('completed_workspace_changed');if(stat.isDirectory())walk(path);else{const bytes=read(full,256*1024);tree[path]={sha256:hash(bytes),bytes:bytes.length,text:new TextDecoder('utf8',{fatal:true}).decode(bytes),executable:stat.mode&0o111};if(++files>2048)throw new Error('completed_workspace_changed');}}};
  walk('');const treeBytes=JSON.stringify(tree);if(Buffer.byteLength(treeBytes)>16*1024*1024||hash(treeBytes)!==result.treeSha256)throw new Error('completed_workspace_changed');
}
