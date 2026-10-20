import { join } from 'node:path';
import { canonical } from './comparison.js';
import { hash,privateDirectory } from './snapshot.js';
import { shaPattern } from './contract.js';
import { inspectMergedResult, type ManagedMergeBinding, type MergeWire } from './merge-contract.js';
import { callMergeProvider, mergeCommand, mergeWire, requireMergeObservation, type MergeProfile } from './merge-provider.js';
import type { MergeReadRecord } from './merge-preflight.js';

export type MergeReadback = { profileSha256:string; bindingSha256:string; records:MergeReadRecord[]; result:Record<string,any>; checkedAt:string };
const readbacks = new WeakSet<object>();
export function evaluateMergeReadback(p:MergeProfile,b:ManagedMergeBinding,records:MergeReadRecord[],response?:MergeWire):Record<string,any>{
  const by=(kind:string)=>records.filter(r=>r.command.command==='read'&&r.command.read?.kind===kind);
  const pr=by('pr'),refs=by('target'),commit=by('commit'),comparison=by('comparison');
  if(pr.length!==1||refs.length!==2||commit.length>1||comparison.length>1)return {state:'sent_unknown',reason:'merge_readback_source_coverage_invalid',productionActionAllowed:false};
  let expectedCommit:string|null=null,targetTip:string|null=null;
  try{expectedCommit=JSON.parse(mergeWire(pr[0]!.observation).body.toString()).merge_commit_sha;targetTip=JSON.parse(mergeWire(refs[1]!.observation).body.toString()).object?.sha;}catch{}
  if(commit.length&&commit[0]!.command.read!.commit!==expectedCommit||comparison.length&&(comparison[0]!.command.read!.commit!==expectedCommit||comparison[0]!.command.read!.tip!==targetTip))throw new Error('merge_readback_endpoint_binding_mismatch');
  const missing={status:0,body:Buffer.from('null')};
  return inspectMergedResult(b,{pr:mergeWire(pr[0]!.observation),commit:commit.length?mergeWire(commit[0]!.observation):missing,targetBefore:mergeWire(refs[0]!.observation),targetAfter:mergeWire(refs[1]!.observation),...(comparison.length?{comparison:mergeWire(comparison[0]!.observation)}:{}),response,expectedActorId:p.actorId});
}
export async function inspectMergeReadback(p:MergeProfile,b:ManagedMergeBinding,directory:string,response?:MergeWire):Promise<MergeReadback>{
  await privateDirectory(directory,true);
  const records:MergeReadRecord[]=[];
  const capture=async(c:ReturnType<typeof mergeCommand>)=>{const observation=await callMergeProvider(p,c,join(directory,String(records.length).padStart(3,'0')));records.push({command:c,observation});return observation;};
  await capture(mergeCommand(b,'read',{kind:'target'}));
  const pr=await capture(mergeCommand(b,'read',{kind:'pr'}));let commit:string|null=null;
  try{const w=mergeWire(pr),v=JSON.parse(w.body.toString());if(w.status===200&&v.merged===true&&shaPattern.test(v.merge_commit_sha??''))commit=v.merge_commit_sha;}catch{}
  if(commit)await capture(mergeCommand(b,'read',{kind:'commit',commit}));
  const after=await capture(mergeCommand(b,'read',{kind:'target'}));let tip:string|null=null;
  try{const w=mergeWire(after),v=JSON.parse(w.body.toString());if(w.status===200&&shaPattern.test(v.object?.sha??''))tip=v.object.sha;}catch{}
  if(commit&&tip&&commit!==tip)await capture(mergeCommand(b,'read',{kind:'comparison',commit,tip}));
  const value=Object.freeze({profileSha256:hash(canonical(p)),bindingSha256:hash(canonical(b)),records,result:evaluateMergeReadback(p,b,records,response),checkedAt:new Date().toISOString()});readbacks.add(value);return value;
}
export function requireMergeReadback(value:MergeReadback,p:MergeProfile,b:ManagedMergeBinding,response?:MergeWire){
  if(!readbacks.has(value)||value.profileSha256!==hash(canonical(p))||value.bindingSha256!==hash(canonical(b))||Date.now()-Date.parse(value.checkedAt)>60000)throw new Error('actual_merge_readback_required');
  for(const r of value.records)requireMergeObservation(r.observation,p,r.command);
  if(canonical(evaluateMergeReadback(p,b,value.records,response))!==canonical(value.result))throw new Error('merge_readback_original_changed');
}
