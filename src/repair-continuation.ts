import {QueueStore} from './queue-store.js';
import {withManagedRepairCapture} from './workspace-handoff-originals.js';
import {parseRepairContinuation} from './repair-continuation-contract.js';

/** Bounded read-only preparation. runQueueRepair rechecks the original
 * execution under its mutex before it may register the actual successor. */
export async function inspectRepairContinuation(store:string,operation:string,mode:string,source:string){
  const q=await QueueStore.open(store);
  try{
    const original=q.managedRepairOriginal(operation),r=original.repair;
    return await withManagedRepairCapture({store,operation,bindingHash:r.bindingHash},()=>q.managedRepairOriginal(operation),async capture=>{
      const reference=parseRepairContinuation({operation,bindingHash:r.bindingHash,resultSha256:r.resultSha256,evidenceSha256:r.evidenceSha256,workspaceStateSha256:capture.workspaceStateSha256,mode,adoption:'committed_candidate',source});
      return {continuation:reference,H:capture.workspace.H,workspace:capture.workspace.workspace,stagedPaths:capture.workspace.stagedPaths,workingPaths:capture.workspace.workingPaths,untrackedPaths:capture.workspace.untrackedPaths,registeredExecutionsEnded:true,uncommittedPolicy:'preserve separately; do not silently apply',next:'Select this continuation on the exact successor queue repair plan with current permission and task arrangement. Execution rechecks originals.',writePermissionGranted:false,newModelInputs:0};
    });
  }finally{q.close();}
}
