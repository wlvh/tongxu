import {join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular} from './repair-workspace.js';
import {readPacket,type Packet} from './queue-evidence.js';
import {retainW2TerminalCapture} from './w2-terminal-capture.js';
import {w2ExecutionRegistrySha,type W2ExecutionIntent} from './w2-execution-contract.js';
import {candidateValidationProducerKind,type CandidateValidationPlan} from './candidate-validation-contract.js';

export type CandidateValidationBinding={id:string;requestSha256:string;run:string;manifestSha256:string;testPlanSha256:string;contextSha256:string;executionRegistryVersion:1};
export type CandidateValidationCapture={binding:CandidateValidationBinding;packet:Packet;executionRegistrySha256:string;packetDigest:string;terminalExecutionProven:true};
const issued=new WeakSet<object>();
const digest=(p:Packet)=>hash(canonical({candidate:p.candidate,context:p.context,fingerprint:p.fingerprint,manifestHash:p.manifestHash,reportHash:p.reportHash,contextHash:p.contextHash,summary:p.summary,blobs:[...p.blobs].map(([h,b])=>[h,hash(b)]).sort((a,b)=>a[0]!.localeCompare(b[0]!))}));
export async function readCandidateValidationCapture(p:CandidateValidationPlan,binding:CandidateValidationBinding,registry:W2ExecutionIntent[]){
 const producer=await regular(join(p.directory,'producer.json')),v=JSON.parse(producer.toString());if(v.kind!==candidateValidationProducerKind(p)||v.executionMethod!=='existing-w2-verifier'||v.newModelInputs!==0||canonical(v.binding)!==canonical(binding))throw new Error('candidate_validation_producer_changed');
 const packet=await readPacket(join(p.directory,'snapshot'),join(p.directory,'verification'),join(p.directory,'context.json')),report=JSON.parse(packet.blobs.get(packet.reportHash)!.toString());
 if(report.id!==binding.run||report.planHash!==binding.testPlanSha256||packet.manifestHash!==binding.manifestSha256||packet.contextHash!==binding.contextSha256||report.inputs.length!==1)throw new Error('candidate_validation_capture_binding_changed');
 await retainW2TerminalCapture(packet,join(p.directory,'verification'),registry);packet.blobs.set(hash(producer),producer);
 const capture=Object.freeze({binding:Object.freeze({...binding}),packet,executionRegistrySha256:w2ExecutionRegistrySha(registry)!,packetDigest:digest(packet),terminalExecutionProven:true as const});issued.add(capture);return capture;
}
export function requireCandidateValidationCapture(c:CandidateValidationCapture){if(!issued.has(c)||c.packetDigest!==digest(c.packet))throw new Error('candidate_validation_actual_capture_required');return c;}
