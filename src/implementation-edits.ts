import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular,treeHash,type Tree} from './repair-workspace.js';
import {replacementText,implementationEditProfile} from './repair-edits.js';
/** Historical new-profile receipts are replayed from their original before
 * bytes. Old profiles retain their existing consumers and wire contract. */
export async function verifyImplementationEdits(state:any,plan:any,manifest:any,native:string){
 const profile=implementationEditProfile(state.plan.request,plan,manifest);if(!profile)return;
 const json=async(path:string)=>JSON.parse((await regular(path,32*1024*1024)).toString());
 let expected:Tree=await json(join(state.plan.operationRoot,'initial-tree.json'));
 const replay=async(directory:string,capture:string)=>{
  const pairs=await json(join(capture,'reconciled-tools.json'));
  for(const pair of pairs){const p=pair.request.params,c=await json(join(directory,'calls',p.callId+'.json'));
   if(c.request.tool!==p.tool||c.request.callId!==p.callId||canonical(c.request.arguments)!==canonical(p.arguments)||canonical(c.response)!==canonical(pair.response.result))throw new Error('implementation_edit_receipt_changed');
   if(p.tool==='tongxu_replace_file'){
    const file=p.arguments.path,before=expected[file];if(!state.plan.request.workspaceRequest.allowedPaths.includes(file)||!before||c.status!=='applied'||hash(c.beforeText)!==c.beforeSha256||c.beforeSha256!==before.sha256||p.arguments.expectedSha256!==before.sha256||c.beforeExecutable!==before.executable||c.afterExecutable!==before.executable||replacementText(p.arguments,Buffer.from(c.beforeText),profile)!==c.afterText||hash(c.afterText)!==c.afterSha256)throw new Error('implementation_edit_receipt_changed');
    expected[file]={...before,text:new TextDecoder('utf8',{fatal:true}).decode(Buffer.from(c.afterText)),sha256:c.afterSha256,bytes:Buffer.byteLength(c.afterText)};
   }
   if(c.afterTreeSha256!==treeHash(expected))throw new Error('implementation_edit_receipt_changed');
  }
 };
 if(state.result?.validationCorrection){await replay(state.plan.operationRoot,state.validationFailure.nativeDirectory);await replay(join(state.plan.operationRoot,'validation-correction'),native);}
 else await replay(state.plan.operationRoot,native);
 if(treeHash(expected)!==(state.result.treeSha256??treeHash(await json(join(state.plan.operationRoot,'initial-tree.json')))))throw new Error('implementation_edit_receipt_changed');
}
