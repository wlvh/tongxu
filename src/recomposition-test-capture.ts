import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular} from './repair-workspace.js';
import {readPacket,type Packet} from './queue-evidence.js';
import {retainW2TerminalCapture} from './w2-terminal-capture.js';
import {w2ExecutionRegistrySha,type W2ExecutionIntent} from './w2-execution-contract.js';

export type RecompositionTestBinding={id:string;planSha256:string;sourceSha256:string;run:string;testPlanSha256:string;inputManifests:string[];contextSha256:string;executionRegistryVersion?:1};
export type RecompositionTestCapture={directory:string;packet:Packet;binding:RecompositionTestBinding;packetDigest:string;terminalExecutionProven:true;executionRegistrySha256:string|null};
const issued=new WeakSet<object>();
const digest=(p:Packet)=>hash(canonical({candidate:p.candidate,context:p.context,fingerprint:p.fingerprint,manifestHash:p.manifestHash,reportHash:p.reportHash,contextHash:p.contextHash,summary:p.summary,blobs:[...p.blobs].map(([sha,b])=>[sha,hash(b)]).sort((a,b)=>a[0]!.localeCompare(b[0]!))}));

export async function readRecompositionTestCapture(directory:string,binding:RecompositionTestBinding,registry?:W2ExecutionIntent[]){
  const producerBytes=await regular(join(directory,'test-producer.json')),producer=JSON.parse(producerBytes.toString());
  if(producer.kind!=='tongxu-managed-recomposition-test'||producer.executionMethod!=='existing-w2-verifier'||producer.newModelInputs!==0||canonical(producer.binding)!==canonical(binding))throw new Error('recomposition_test_producer_changed');
  if(binding.inputManifests.length<2||binding.inputManifests.length>8)throw new Error('recomposition_test_input_count_changed');
  const snapshots=binding.inputManifests.map((_,i)=>join(directory,'snapshot-'+i)),packet=await readPacket(snapshots.at(-1)!,join(directory,'verification'),join(directory,'context.json'),snapshots),report=JSON.parse(packet.blobs.get(packet.reportHash)!.toString());
  if(report.id!==binding.run||report.planHash!==binding.testPlanSha256||packet.contextHash!==binding.contextSha256||canonical(report.inputs.map((x:any)=>x.manifestHash))!==canonical(binding.inputManifests))throw new Error('recomposition_test_capture_binding_mismatch');
  if(binding.executionRegistryVersion===1&&registry===undefined)throw new Error('recomposition_test_execution_registry_required');await retainW2TerminalCapture(packet,join(directory,'verification'),registry);packet.blobs.set(hash(producerBytes),producerBytes);
  const value=Object.freeze({directory,packet,binding:Object.freeze({...binding,inputManifests:Object.freeze([...binding.inputManifests]) as unknown as string[]}),packetDigest:digest(packet),terminalExecutionProven:true as const,executionRegistrySha256:w2ExecutionRegistrySha(registry)});issued.add(value);return value;
}
export function requireRecompositionTestCapture(value:RecompositionTestCapture){if(!issued.has(value)||digest(value.packet)!==value.packetDigest)throw new Error('recomposition_managed_test_capture_required');return value;}
