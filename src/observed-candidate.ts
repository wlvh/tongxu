import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {QueueStore} from './queue-store.js';
import {ordinaryFile} from './publication-http.js';
import {parseObservedCandidateRequest} from './observed-candidate-contract.js';
import {observeRemoteCandidate} from './observed-candidate-source.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';

/** A repeated entry only repeats GET observations. W1/W2 originals, model
 * runs and remote branches are never recreated by this consumer. */
export async function runObservedCandidate(store:string,requestPath:string){
  const raw=await ordinaryFile(requestPath,32*1024),p=parseObservedCandidateRequest(raw),q=await QueueStore.open(store);
  try{
    const binding=q.observedCandidateSource(raw),directory=join(store,'candidate-observation-'+hash(canonical(p))+'-'+randomUUID());await privateDirectory(directory,true);await writeFile(join(directory,'request.json'),raw,{flag:'wx',mode:0o600});
    try{
      const capture=await observeRemoteCandidate(p,binding,directory);await writeFile(join(directory,'capture.json'),canonical(capture),{flag:'wx',mode:0o600});
      const association=q.attachObservedCandidate(raw,capture),result={...association,directory,observedAt:capture.observedAt,remoteMatchedAtObservation:true,nonAtomicRemoteObservation:true,associationIsHistoricalEvidence:true,remoteWritePerformed:false,newModelInputs:0,testsStarted:0,independentReceptionGranted:false,permissionGranted:false};
      await writeFile(join(directory,'result.json'),canonical(result),{flag:'wx',mode:0o600});return result;
    }catch(e){const reason=e instanceof Error?e.message:'candidate_observation_failed';await writeFile(join(directory,'failure.json'),canonical({reason,binding,remoteWritePerformed:false,newModelInputs:0,testsStarted:0,automaticResend:false}),{flag:'wx',mode:0o600});try{q.observedCandidateProblem(raw,reason,binding);}catch{/* A newer observation or source now exists. Preserve this attempt locally without replacing that newer state. */}throw e;}
  }finally{q.close();}
}
