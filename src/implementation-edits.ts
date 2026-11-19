import {execFile} from 'node:child_process';
import {lstat,readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular,treeHash,safeEnv,projectPathWritable,orderedProjectTree,type Tree,type ProjectFiles} from './repair-workspace.js';
import {replacementText,implementationEditProfile,type EditProfile} from './repair-edits.js';
import {implementationTools} from './implementation-ai.js';
const exec=promisify(execFile);

export function replayImplementationWrite(expected:Tree,p:any,c:any,allowedPaths:string[],profile:EditProfile|undefined,projectFiles?:ProjectFiles){
 if(p.tool==='tongxu_replace_file'){
  const file=p.arguments.path,before=expected[file];if(!(projectFiles?projectPathWritable(projectFiles,file):allowedPaths.includes(file))||!before||c.status!=='applied'||hash(c.beforeText)!==c.beforeSha256||c.beforeSha256!==before.sha256||p.arguments.expectedSha256!==before.sha256||c.beforeExecutable!==before.executable||c.afterExecutable!==before.executable||replacementText(p.arguments,Buffer.from(c.beforeText),profile)!==c.afterText||hash(c.afterText)!==c.afterSha256)throw new Error('implementation_edit_receipt_changed');
  expected[file]={...before,text:new TextDecoder('utf8',{fatal:true}).decode(Buffer.from(c.afterText)),sha256:c.afterSha256,bytes:Buffer.byteLength(c.afterText)};
 }
 if(p.tool==='tongxu_create_file'){
  const {path,text,mode}=p.arguments;
  if(!projectFiles||!projectPathWritable(projectFiles,path)||Object.hasOwn(expected,path)||!['100644','100755'].includes(mode)||
     typeof text!=='string'||c.status!=='applied')throw new Error('implementation_edit_receipt_changed');
  const file={sha256:hash(text),bytes:Buffer.byteLength(text),text:new TextDecoder('utf8',{fatal:true}).decode(Buffer.from(text)),executable:mode==='100755'?0o100:0};
  if(canonical(c.newFile)!==canonical(file))throw new Error('implementation_edit_receipt_changed');
  expected=orderedProjectTree({...expected,[path]:file});
 }
 if(p.tool==='tongxu_delete_file'||p.tool==='tongxu_rename_file'){
  const {path,destination,expectedSha256}=p.arguments,move=p.tool==='tongxu_rename_file';
  const file=expected[path];
  if(!projectFiles||!projectPathWritable(projectFiles,path)||!Object.hasOwn(expected,path)||!file||
     file.sha256!==expectedSha256||canonical(file)!==canonical(c.beforeFile)||c.status!=='applied'||
     move&&(!projectPathWritable(projectFiles,destination)||Object.hasOwn(expected,destination)))throw new Error('implementation_edit_receipt_changed');
  delete expected[path];
  expected=orderedProjectTree(move?{...expected,[destination]:file}:expected);
 }
 return expected;
}

/** Historical new-profile receipts are replayed from their original before
 * bytes. Old profiles retain their existing consumers and wire contract. */
export async function verifyImplementationEdits(state:any,plan:any,manifest:any,native:string){
 const request=state.plan.request,profile=implementationEditProfile(request,plan,manifest);
 const projectFiles=request.workspaceRequest.projectFiles?{protectedPaths:request.workspaceRequest.protectedPaths}:undefined;
 if(!profile&&!projectFiles)return;
 const tools=projectFiles?implementationTools(request,plan,manifest):null;
 const json=async(path:string)=>JSON.parse((await regular(path,32*1024*1024)).toString());
 let expected:Tree=await json(join(state.plan.operationRoot,'initial-tree.json'));
 const replay=async(directory:string,capture:string)=>{
  if(tools){
   const sent=(await regular(join(capture,'stdin.ndjson'),16*1024*1024)).toString().trim().split('\n').map(line=>JSON.parse(line));
   const start=sent.filter(item=>item.method==='thread/start');
   if(start.length!==1||start[0].params.baseInstructions!==request.workflowPrompt?.system||
      canonical(manifest.prompt)!==canonical(request.workflowPrompt)||
      canonical(start[0].params.dynamicTools)!==canonical(tools))throw new Error('implementation_project_file_capture_changed');
  }
  const pairs=await json(join(capture,'reconciled-tools.json'));
  for(const pair of pairs){const p=pair.request.params,c=await json(join(directory,'calls',p.callId+'.json'));
   if(c.request.tool!==p.tool||c.request.callId!==p.callId||canonical(c.request.arguments)!==canonical(p.arguments)||canonical(c.response)!==canonical(pair.response.result))throw new Error('implementation_edit_receipt_changed');
   if(tools&&!tools.some(tool=>tool.name===p.tool))throw new Error('implementation_edit_receipt_changed');
   expected=replayImplementationWrite(expected,p,c,request.workspaceRequest.allowedPaths,profile,projectFiles);
   if(c.afterTreeSha256!==treeHash(expected))throw new Error('implementation_edit_receipt_changed');
  }
 };
 if(state.result?.validationCorrection){await replay(state.plan.operationRoot,state.validationFailure.nativeDirectory);await replay(join(state.plan.operationRoot,'validation-correction'),native);}
 else await replay(state.plan.operationRoot,native);
 if(treeHash(expected)!==(state.result.treeSha256??treeHash(await json(join(state.plan.operationRoot,'initial-tree.json')))))throw new Error('implementation_edit_receipt_changed');
}

/** Observe registered new paths, including retained move targets, without touching the index. */
export async function retainedProjectAdditions(workspace:string,operation:string,H0:string,scope:ProjectFiles,profile?:EditProfile){
 const calls=join(operation,'calls'),names=await readdir(calls).catch(error=>{
  if(error.code==='ENOENT')return [];
  throw error;
 });
 if(!names.length)return {additions:[],diff:''};
 const initial:Tree=JSON.parse((await regular(join(operation,'initial-tree.json'),20*1024*1024)).toString());
 const managed=JSON.parse((await regular(join(workspace,'.git','tongxu-managed.json'))).toString());
 if(managed.kind!=='owned-project-workspace'||managed.initialH!==H0||managed.initialTreeSha256!==treeHash(initial))throw new Error('implementation_initial_tree_changed');
 const writes=new Set(['tongxu_create_file','tongxu_replace_file','tongxu_delete_file','tongxu_rename_file']);
 const receipts=[];
 for(const name of names.filter(name=>/^[A-Za-z0-9_-]{1,128}\.json$/.test(name))){
  const receipt=JSON.parse((await regular(join(calls,name))).toString());
  if(receipt.request?.callId!==name.slice(0,-5)||!receipt.request.arguments)throw new Error('implementation_edit_receipt_changed');
  if(writes.has(receipt.request.tool)&&receipt.status==='applied')receipts.push(receipt);
 }
 const replay=(tree:Tree,receipt:any)=>{
  const after=replayImplementationWrite({...tree},receipt.request,receipt,[],profile,scope);
  if(treeHash(after)!==receipt.afterTreeSha256)throw new Error('implementation_edit_receipt_changed');
  return after;
 };
 let expected:Tree=initial;
 if(receipts.some(r=>r.writeSequence!==undefined)){
  receipts.sort((a,b)=>a.writeSequence-b.writeSequence);
  let previous=0;
  for(const receipt of receipts){
   if(!Number.isSafeInteger(receipt.writeSequence)||receipt.writeSequence<=previous)throw new Error('implementation_edit_receipt_changed');
   expected=replay(expected,receipt);previous=receipt.writeSequence;
  }
 }else{
  // Historical receipts lacked a sequence. Proceed only when the next
  // effect has a unique match against the current tree and the saved digest.
  while(receipts.length){
   const matches=receipts.flatMap((receipt,index)=>{try{return [{index,after:replay(expected,receipt)}];}catch{return [];}});
   if(matches.length!==1)throw new Error('implementation_edit_receipt_changed');
   expected=matches[0]!.after;receipts.splice(matches[0]!.index,1);
  }
 }
 const removed=Object.keys(initial).filter(path=>!Object.hasOwn(expected,path));
 const checkRemoved=async()=>{
  for(const path of removed){
   try{await lstat(join(workspace,path));}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))continue;throw error;}
   throw new Error('implementation_edit_receipt_changed');
  }
 };
 await checkRemoved();
 const additions:string[]=[],diffs:string[]=[];
 for(const [path,entry] of Object.entries(expected)){
  if(Object.hasOwn(initial,path))continue;
  try{
   const full=join(workspace,path);
   const digest=async()=>hash(await regular(full,256*1024));
   const mode=async()=>(await lstat(full)).mode&0o111;
   if(await digest()!==entry.sha256||await mode()!==entry.executable)continue;
   // An addition already present in the index is covered by the main diff.
   if((await exec('/usr/bin/git',['--literal-pathspecs','-C',workspace,'ls-files','--',path],{env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0'}})).stdout)continue;
   const diff=await exec('/usr/bin/git',['-C',workspace,'diff','--no-index','--no-ext-diff','--no-textconv','--binary','--','/dev/null',path],
    {env:{...safeEnv,GIT_OPTIONAL_LOCKS:'0'},timeout:15000,maxBuffer:2*1024*1024}).catch(error=>{
     if(error.code===1&&typeof error.stdout==='string')return {stdout:error.stdout as string};
     throw error;
    });
   if(diff.stdout&&await digest()===entry.sha256&&await mode()===entry.executable){additions.push(path);diffs.push(diff.stdout);}
  }catch(error:any){
   if(!['ENOENT','ENOTDIR'].includes(error.code)&&!['noncanonical_repair_path','invalid_repair_file','repair_file_changed_during_read','implementation_edit_receipt_changed'].includes(error.message))throw error;
  }
 }
 await checkRemoved();
 return {additions,diff:diffs.join('')};
}
