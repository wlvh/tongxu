import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import type {Packet} from './queue-evidence.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {parsePlan} from './verification.js';
import {dockerTerminalEvidence,dockerEvidenceState} from './docker-sandbox.js';

/** Check actual managed Docker terminal records before a consumer reports a
 * test outcome. A report's own executionComplete field is not this proof. */
export async function retainW2TerminalCapture(packet:Packet,root:string){
  const report=JSON.parse(packet.blobs.get(packet.reportHash)!.toString()),plan=parsePlan(JSON.parse(packet.blobs.get(report.planHash)!.toString()));
  if(!plan.executor||!report.finishedAt)throw new Error('w2_original_execution_unknown');
  const probe=join(root,'docker-runtime','probe'),proof=await regular(join(probe,'execution.json'),4*1024*1024);
  if(dockerTerminalEvidence(proof,plan.executor,probe)==='unknown')throw new Error('w2_original_execution_unknown');packet.blobs.set(hash(proof),proof);
  // Inspect the actual execution set, independently of report references.
  // Editing a tool to "blocked" cannot erase an existing unknown process.
  const shape=/^docker-tool-[0-9]+-[A-Za-z0-9_-]+-[a-f0-9-]{36}$/,actual=new Map<string,Buffer>();
  for(const entry of await readdir(root,{withFileTypes:true}))if(entry.name.startsWith('docker-tool-')){
    if(!entry.isDirectory()||!shape.test(entry.name))throw new Error('w2_original_execution_unknown');
    const path=join(root,entry.name),bytes=await regular(join(path,'execution.json'),4*1024*1024),record=JSON.parse(bytes.toString()),binding=record.binding;
    if(!binding||binding.run!==report.id||binding.planHash!==report.planHash||dockerTerminalEvidence(bytes,plan.executor,path,binding)==='unknown')throw new Error('w2_original_execution_unknown');actual.set(entry.name,bytes);
  }
  const referenced=new Set<string>();
  for(const stage of report.stages)for(const tool of stage.tools){
    if(tool.status==='blocked'&&!tool.dockerExecutionDirectory&&!tool.pid&&!tool.sandbox&&!tool.stdout&&!tool.stderr&&!tool.result&&!tool.finishedAt&&tool.exitCode===undefined)continue;
    const name=tool.dockerExecutionDirectory;if(typeof name!=='string'||!shape.test(name)||referenced.has(name)||!actual.has(name))throw new Error('w2_original_execution_unknown');referenced.add(name);
    const path=join(root,name),bytes=actual.get(name)!,binding={run:report.id,stage:stage.index,tool:tool.id,head:stage.head,tree:stage.tree,planHash:report.planHash};
    if(hash(bytes)!==tool.sandbox?.sha256||dockerTerminalEvidence(bytes,plan.executor,path,binding)==='unknown'||dockerEvidenceState(bytes,plan.executor,binding,tool,plan.tools.find(t=>t.id===tool.id)?.timeoutMs)==='mismatch')throw new Error('w2_original_execution_unknown');packet.blobs.set(hash(bytes),bytes);
  }
  const executionComplete=report.stages.length===report.inputs.length+1&&report.stages.every((s:any)=>s.tools.length===plan.tools.length&&s.tools.every((t:any)=>t.status==='completed'&&t.inputUnchanged===true&&t.dependenciesUnchanged===true));
  if(referenced.size!==actual.size||report.executionComplete!==executionComplete)throw new Error('w2_original_execution_unknown');
  return report;
}
