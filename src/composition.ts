import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { repoPattern, shaPattern } from './contract.js';
import type { Candidate } from './contract.js';

export type Composition = {
  key: string; sha256: string;
  subject: { kind: 'ordered-verification-composition'; repository:string; B:string; targetRef:string;
    members:Array<{index:number;candidate:Candidate;manifestHash:string;sourceGaps:string[]}>;
    testedHead:string|null;testedTree:string|null;individualAcceptanceInferred:false };
};
export function composeSubject(report:any, blob:(sha256:string)=>Buffer):Composition {
  if(!Array.isArray(report.inputs)||report.inputs.length<2||report.inputs.length>8)throw new Error('invalid_composition_members');
  const members=report.inputs.map((i:any,index:number)=>{
    const bytes=blob(i.manifestHash),m=JSON.parse(bytes.toString()),c=m.candidate;
    if(hash(bytes)!==i.manifestHash||i.manifest.sha256!==i.manifestHash||m.schemaVersion!==1||!c||!repoPattern.test(c.repository)||!shaPattern.test(c.H)||!shaPattern.test(c.B)||!Number.isSafeInteger(c.pr)||c.pr<1||m.repository!==c.repository||m.pr!==c.pr||typeof c.targetRef!=='string'||!c.targetRef||/[\x00-\x20\x7f]/.test(c.targetRef)||canonical(c)!==canonical(i.candidate)||!Array.isArray(m.artifacts)||!Array.isArray(m.rounds))throw new Error('composition_member_binding_mismatch');
    for(const ref of m.artifacts)if(hash(blob(ref.sha256))!==ref.sha256)throw new Error('composition_member_artifact_changed');
    const sourceGaps=m.rounds.at(-1)?.gaps??['source_observation_unavailable'];
    if(!Array.isArray(sourceGaps)||canonical(sourceGaps)!==canonical(i.sourceGaps))throw new Error('composition_source_coverage_changed');
    return {index,candidate:c as Candidate,manifestHash:i.manifestHash,sourceGaps};
  });
  const first=members[0]!.candidate;
  if(members.some((m:any)=>m.candidate.repository!==first.repository||m.candidate.B!==first.B||m.candidate.targetRef!==first.targetRef))throw new Error('composition_requires_one_repository_base_target');
  const identities=members.map((m:any)=>[m.candidate.repository,m.candidate.pr,m.candidate.H,m.candidate.B,m.candidate.targetRef]);
  if(new Set(identities.map((x:any)=>canonical(x))).size!==members.length)throw new Error('duplicate_composition_member');
  const final=report.stages.at(-1),subject:Composition['subject']={kind:'ordered-verification-composition',repository:first.repository,B:first.B,targetRef:first.targetRef,members,testedHead:shaPattern.test(final?.head??'')?final.head:null,testedTree:shaPattern.test(final?.tree??'')?final.tree:null,individualAcceptanceInferred:false};
  return {key:hash(canonical(identities)),sha256:hash(canonical(subject)),subject};
}

/** Earlier versions of a PR remain historical members; only its final member
 * is a claim about that PR's current source. No member becomes a separate PASS. */
export function currentMembers(composition:Composition):Candidate[]{
  const latest=new Map<number,Candidate>();for(const m of composition.subject.members)latest.set(m.candidate.pr,m.candidate);return [...latest.values()];
}
