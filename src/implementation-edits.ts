import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular,treeHash,projectPathWritable,orderedProjectTree,projectRepairToolsFor,type Tree} from './repair-workspace.js';
import {replacementText,implementationEditProfile} from './repair-edits.js';
/** Historical new-profile receipts are replayed from their original before
 * bytes. Old profiles retain their existing consumers and wire contract. */
export async function verifyImplementationEdits(state:any,plan:any,manifest:any,native:string){
 const request=state.plan.request,profile=implementationEditProfile(request,plan,manifest);
 const projectFiles=request.workspaceRequest.projectFiles?{protectedPaths:request.workspaceRequest.protectedPaths}:undefined;
 if(!profile&&!projectFiles)return;
 const json=async(path:string)=>JSON.parse((await regular(path,32*1024*1024)).toString());
 let expected:Tree=await json(join(state.plan.operationRoot,'initial-tree.json'));
 const replay=async(directory:string,capture:string)=>{
  if(projectFiles){
   const sent=(await regular(join(capture,'stdin.ndjson'),16*1024*1024)).toString().trim().split('\n').map(line=>JSON.parse(line));
   const start=sent.filter(item=>item.method==='thread/start');
   if(start.length!==1||start[0].params.baseInstructions!==request.workflowPrompt?.system||
      canonical(manifest.prompt)!==canonical(request.workflowPrompt)||
      canonical(start[0].params.dynamicTools)!==canonical(projectRepairToolsFor(profile,true)))throw new Error('implementation_project_file_capture_changed');
  }
  const pairs=await json(join(capture,'reconciled-tools.json'));
  for(const pair of pairs){const p=pair.request.params,c=await json(join(directory,'calls',p.callId+'.json'));
   if(c.request.tool!==p.tool||c.request.callId!==p.callId||canonical(c.request.arguments)!==canonical(p.arguments)||canonical(c.response)!==canonical(pair.response.result))throw new Error('implementation_edit_receipt_changed');
   if(p.tool==='tongxu_replace_file'){
    const file=p.arguments.path,before=expected[file];if(!(projectFiles?projectPathWritable(projectFiles,file):request.workspaceRequest.allowedPaths.includes(file))||!before||c.status!=='applied'||hash(c.beforeText)!==c.beforeSha256||c.beforeSha256!==before.sha256||p.arguments.expectedSha256!==before.sha256||c.beforeExecutable!==before.executable||c.afterExecutable!==before.executable||replacementText(p.arguments,Buffer.from(c.beforeText),profile)!==c.afterText||hash(c.afterText)!==c.afterSha256)throw new Error('implementation_edit_receipt_changed');
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
   if(c.afterTreeSha256!==treeHash(expected))throw new Error('implementation_edit_receipt_changed');
  }
 };
 if(state.result?.validationCorrection){await replay(state.plan.operationRoot,state.validationFailure.nativeDirectory);await replay(join(state.plan.operationRoot,'validation-correction'),native);}
 else await replay(state.plan.operationRoot,native);
 if(treeHash(expected)!==(state.result.treeSha256??treeHash(await json(join(state.plan.operationRoot,'initial-tree.json')))))throw new Error('implementation_edit_receipt_changed');
}
