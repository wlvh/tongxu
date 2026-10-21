import {join} from 'node:path';
import {readPacket,type Packet} from './queue-evidence.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';
import type {DeliveryValidationPlan} from './delivery-validation-contract.js';
import {retainW2TerminalCapture} from './w2-terminal-capture.js';

type Binding={id:string;planSha256:string;run:string;testPlanSha256:string};
export type DeliveryValidationCapture={packet:Packet;binding:Readonly<Binding>;packetDigest:string;terminalExecutionProven:true};
const issued=new WeakSet<object>();
export const managedDeliverySnapshots=(directory:string,p:DeliveryValidationPlan)=>p.snapshots.map((_,i)=>join(directory,'source-snapshot-'+i));
const digest=(p:Packet)=>hash(canonical({candidate:p.candidate,context:p.context,fingerprint:p.fingerprint,manifestHash:p.manifestHash,reportHash:p.reportHash,contextHash:p.contextHash,summary:p.summary,blobs:[...p.blobs].map(([sha,b])=>[sha,hash(b)]).sort((a,b)=>a[0]!.localeCompare(b[0]!))}));
/** Only the managed output location is read. This authenticates the original
 * local execution contract; it is not an independent semantic test judgment. */
export async function readDeliveryValidationCapture(directory:string,plan:DeliveryValidationPlan,binding:Binding){
  const producerBytes=await regular(join(directory,'producer.json')),producer=JSON.parse(producerBytes.toString());if(canonical(producer.binding)!==canonical(binding)||producer.kind!=='tongxu-managed-delivery-validation'||producer.executionMethod!=='existing-w2-verifier'||producer.newModelInputs!==0)throw new Error('delivery_validation_producer_changed');
  const snapshots=managedDeliverySnapshots(directory,plan),packet=await readPacket(snapshots.at(-1)!,join(directory,'verification'),join(directory,'context.json'),snapshots.length>1?snapshots:[]),report=JSON.parse(packet.blobs.get(packet.reportHash)!.toString());
  if(report.id!==binding.run||report.planHash!==binding.testPlanSha256)throw new Error('delivery_validation_capture_binding_mismatch');
  try{await retainW2TerminalCapture(packet,join(directory,'verification'));}catch(e){if(e instanceof Error&&e.message==='w2_original_execution_unknown')throw new Error('delivery_validation_original_execution_unknown');throw e;}
  packet.blobs.set(hash(producerBytes),producerBytes);const value=Object.freeze({packet,binding:Object.freeze({...binding}),packetDigest:digest(packet),terminalExecutionProven:true as const});issued.add(value);return value;
}
export function requireDeliveryValidationCapture(value:DeliveryValidationCapture){if(!issued.has(value)||digest(value.packet)!==value.packetDigest)throw new Error('delivery_validation_managed_capture_required');return value;}
