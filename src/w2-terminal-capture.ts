import {join} from 'node:path';
import type {Packet} from './queue-evidence.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {parsePlan} from './verification.js';
import {dockerTerminalEvidence} from './docker-sandbox.js';

/** Check actual managed Docker terminal records before a consumer reports a
 * test outcome. A report's own executionComplete field is not this proof. */
export async function retainW2TerminalCapture(packet:Packet,root:string){
  const report=JSON.parse(packet.blobs.get(packet.reportHash)!.toString()),plan=parsePlan(JSON.parse(packet.blobs.get(report.planHash)!.toString()));
  if(!plan.executor||!report.finishedAt)throw new Error('w2_original_execution_unknown');
  const probe=join(root,'docker-runtime','probe'),proof=await regular(join(probe,'execution.json'),4*1024*1024);
  if(dockerTerminalEvidence(proof,plan.executor,probe)==='unknown')throw new Error('w2_original_execution_unknown');packet.blobs.set(hash(proof),proof);
  for(const stage of report.stages)for(const tool of stage.tools){
    if(tool.status==='blocked'&&!tool.dockerExecutionDirectory&&!tool.pid)continue;
    if(typeof tool.dockerExecutionDirectory!=='string'||!/^docker-tool-[0-9]+-[A-Za-z0-9_-]+-[a-f0-9-]{36}$/.test(tool.dockerExecutionDirectory))throw new Error('w2_original_execution_unknown');
    const path=join(root,tool.dockerExecutionDirectory),bytes=await regular(join(path,'execution.json'),4*1024*1024);
    if(dockerTerminalEvidence(bytes,plan.executor,path,{run:report.id,stage:stage.index,tool:tool.id,head:stage.head,tree:stage.tree,planHash:report.planHash})==='unknown')throw new Error('w2_original_execution_unknown');packet.blobs.set(hash(bytes),bytes);
  }
  return report;
}
