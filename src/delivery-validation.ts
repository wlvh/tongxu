import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from './queue-store.js';
import {parseDeliveryValidation,deliveryValidationSha} from './delivery-validation-contract.js';
import {readDeliveryValidationCapture,managedDeliverySnapshots} from './delivery-validation-capture.js';
import {regular,exists} from './repair-workspace.js';
import {hash,privateDirectory} from './snapshot.js';
import {canonical} from './comparison.js';
import {verify,loadBundle} from './verification.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';

const code=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]{1,160}$/.test(e.message)?e.message:'delivery_validation_failed';
async function fixedFile(path:string,bytes:Buffer){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await regular(path,64*1024*1024)).equals(bytes))throw new Error('delivery_validation_frozen_file_changed');}}

/** One operator entry owns registration, execution, capture and replay. No
 * model-authored command or report is accepted as a new executable action. */
export async function runDeliveryValidation(store:string,planPath:string,action:'run'|'reconcile'|'close-unstarted'='run'){
  const raw=await regular(planPath,64*1024),p=parseDeliveryValidation(raw),planSha256=deliveryValidationSha(p),q=await QueueStore.open(store),directory=join(store,'delivery-validation-'+planSha256);
  let lock:DatabaseSync|undefined,observations:OwnerObservation[]=[],registered=false;
  try{
    q.deliveryValidations().protect();
    if(!await exists(directory))await privateDirectory(directory,true);else await privateDirectory(directory,false);
    await fixedFile(join(directory,'plan.json'),raw);const path=join(directory,'controller.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await regular(path);lock=new DatabaseSync(path);try{lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}catch{throw new Error('delivery_validation_controller_active');}
    const records=q.deliveryValidations();let prior:ReturnType<typeof records.state>|undefined;
    const snapshotPaths=managedDeliverySnapshots(directory,p),freezeSources=async()=>{for(const [i,snapshot] of records.snapshotContents(p.id).entries()){const root=snapshotPaths[i]!;if(!await exists(root))await privateDirectory(root,true);else await privateDirectory(root,false);for(const name of ['raw','git']){const child=join(root,name);if(!await exists(child))await privateDirectory(child,true);else await privateDirectory(child,false);}await fixedFile(join(root,'manifest.json'),snapshot.manifest);for(const a of snapshot.artifacts){const folder=dirname(join(root,a.path));if(!await exists(folder))await privateDirectory(folder,true);else await privateDirectory(folder,false);await fixedFile(join(root,a.path),a.bytes);}}};
    try{prior=records.state(p.id);registered=true;}catch(e){if(code(e)!=='delivery_validation_not_registered')throw e;}
    if(prior&&prior.planSha256!==planSha256)throw new Error('delivery_validation_id_changed');
    if(prior?.phase==='closed_unstarted')return {...prior,duplicate:true,newModelInputs:0,newVerificationRuns:0};
    const refresh=async()=>{observations=[];if(p.authorityIntent){const a=q.authority(),reserved=a.reservedAction(p.authorityIntent),{profile}=a.configuration(),root=join(directory,'owner-source-'+randomUUID());await mkdir(root,{mode:0o700});for(const [i,ref] of a.sourceRequests(reserved.authorization).entries())observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,String(i))));}};
    if(prior&&!prior.run){
      if(await exists(join(directory,'verification'))||await exists(join(directory,'producer.json')))throw new Error('delivery_validation_original_start_unknown');
      if(action==='close-unstarted')return {...records.closeUnstarted(p.id,Buffer.from(canonical({planSha256,checkedAt:new Date().toISOString(),exclusiveControllerLockHeld:true,verificationDirectoryAbsent:true,producerAbsent:true,originalRunNotRegistered:true}))),newModelInputs:0,newVerificationRuns:0};
      if(action==='reconcile')return {...prior,knownNotStarted:true,newModelInputs:0,newVerificationRuns:0};
    }
    if(prior?.run){
      // An interrupted caller may have completed the original verifier. Read
      // only that managed output; neither a new directory nor ID resends it.
      if(action==='close-unstarted')throw new Error('delivery_validation_started_or_unknown');
      if(!await exists(join(directory,'producer.json')))throw new Error('delivery_validation_original_producer_missing');
      await freezeSources();
      const capture=await readDeliveryValidationCapture(directory,p,{id:p.id,planSha256,run:prior.run,testPlanSha256:p.testPlan.sha256},records.executions(p.id)),result=records.complete(p.id,capture);return {...records.state(p.id),result,duplicate:true,newModelInputs:0,newVerificationRuns:0};
    }
    if(action!=='run')return {id:p.id,phase:'not_registered',newModelInputs:0,newVerificationRuns:0,userOutcomeAccepted:false};
    const testPlan=await regular(p.testPlan.path,64*1024),snapshots:Buffer[]=[];if(hash(testPlan)!==p.testPlan.sha256)throw new Error('delivery_validation_test_plan_changed');for(const ref of p.snapshots){const bundle=await loadBundle(ref.path);if(hash(bundle.bytes)!==ref.sha256)throw new Error('delivery_validation_snapshot_changed');snapshots.push(bundle.bytes);}
    await refresh();records.register(raw,testPlan,snapshots,observations);registered=true;records.check(p.id,observations);
    await fixedFile(join(directory,'context.json'),records.context(p.id));await fixedFile(join(directory,'test-plan.json'),records.testPlan(p.id));
    await freezeSources();
    const output=join(directory,'verification');if(await exists(output))throw new Error('delivery_validation_original_output_exists');
    const runtimeModules=Object.fromEntries(await Promise.all(['delivery-validation','delivery-validation-store','delivery-validation-capture','delivery-validation-contract','delivery-store','queue-store','authority-store','authority-source','verification','docker-sandbox'].map(async name=>[name,hash(await readFile(new URL('./'+name+'.js',import.meta.url)))])));
    await verify({snapshots:snapshotPaths,objects:p.objects,plan:join(directory,'test-plan.json'),output},{
      registered:(run,testPlanSha256,inputManifests)=>{if(canonical(inputManifests)!==canonical(p.snapshots.map(s=>s.sha256)))throw new Error('delivery_validation_snapshot_changed');records.markStarted(p.id,run,testPlanSha256);writeFileSync(join(directory,'producer.json'),canonical({kind:'tongxu-managed-delivery-validation',executionMethod:'existing-w2-verifier',binding:{id:p.id,planSha256,run,testPlanSha256},controllerPid:process.pid,node:{executable:process.execPath,version:process.version},runtimeModules,newModelInputs:0,registeredAt:new Date().toISOString()}),{flag:'wx',mode:0o600});},
      executionRegistered:async intent=>{await refresh();records.registerExecution(p.id,intent,observations);},
      startGate:{refresh:async()=>{await refresh();records.check(p.id,observations);},start:effect=>records.startEffect(p.id,observations,effect)}
    });
    const state=records.state(p.id);if(!state.run)throw new Error('delivery_validation_original_run_missing');const capture=await readDeliveryValidationCapture(directory,p,{id:p.id,planSha256,run:state.run,testPlanSha256:p.testPlan.sha256},records.executions(p.id)),result=records.complete(p.id,capture);return {...records.state(p.id),result,duplicate:false,newModelInputs:0,newVerificationRuns:1};
  }catch(e){const reason=code(e);if(registered)try{q.deliveryValidations().problem(p.id,reason);}catch{}await fixedFile(join(directory,'problem-'+randomUUID()+'.json'),Buffer.from(canonical({reason,detail:e instanceof Error?e.stack??e.message:String(e),automaticResend:false}))).catch(()=>{});throw e;}
  finally{if(lock?.isTransaction)lock.exec('ROLLBACK');lock?.close();q.close();}
}
