import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,cp,mkdir,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {coordinatedRepair} from '../review-records/queue-repair-fixture.js';
import {runQueueRepair} from '../../src/queue-repair.js';
import {withManagedRepairCapture,requireManagedRepairCapture,type ManagedRepairCapture} from '../../src/workspace-handoff-originals.js';
import {hash} from '../../src/snapshot.js';
import {spawnSync} from 'node:child_process';

test('original returned repair retains exclusive controller proof and actual ended children; source files stay immutable and an outliving capture cannot transfer',async t=>{
  const hooks:Array<()=>unknown>=[],f=await coordinatedRepair({after:(fn:()=>unknown)=>{hooks.push(fn);}} as unknown as test.TestContext);t.after(async()=>{if(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE){await mkdir(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE,{recursive:true});await cp(f.root,join(process.env.TONGXU_WORKSPACE_HANDOFF_TEST_EVIDENCE,basename(f.root)),{recursive:true});}for(const h of hooks.reverse())await h();});
  await runQueueRepair(f.planPath);const source=f.q.managedRepairOriginal(f.operation),ref={store:f.store,operation:f.operation,bindingHash:source.repair.bindingHash},read=()=>f.q.managedRepairOriginal(f.operation),trace=await readFile(f.model.trace),terminal=await readFile(join(f.request.executionRoot,'operation/terminal-record.json'));
  let retained:ManagedRepairCapture|undefined;
  await withManagedRepairCapture(ref,read,async c=>{retained=c;assert.equal(requireManagedRepairCapture(c),c);assert.ok(c.processes.length>=3);assert.ok(c.dockerExecutions.length>=2);assert.equal(c.workspace.H,source.repair.result.after.H);assert.equal(c.newPermissionGranted,false);const lock=new DatabaseSync(join(f.store,`repair-controller-${f.operation}.sqlite`));try{assert.throws(()=>lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE'),/locked/);}finally{lock.close();}await writeFile(join(f.root,'actual-original-handoff-capture.json'),JSON.stringify({...c,originals:[...c.originals.keys()]},null,2)+'\n');});
  assert.throws(()=>requireManagedRepairCapture(retained!),/actual_exclusive_original_repair_capture_required/);assert.ok((await readFile(f.model.trace)).equals(trace));assert.ok((await readFile(join(f.request.executionRoot,'operation/terminal-record.json'))).equals(terminal));
  const lock=new DatabaseSync(join(f.store,`repair-controller-${f.operation}.sqlite`));lock.exec('BEGIN IMMEDIATE');try{await assert.rejects(withManagedRepairCapture(ref,read,async()=>{}),/handoff_original_controller_active/);}finally{lock.exec('ROLLBACK');lock.close();}
  await assert.rejects(withManagedRepairCapture({...ref,bindingHash:'0'.repeat(64)},read,async()=>{}),/handoff_original_reconciliation_required/);
  const path=join(f.request.executionRoot,'operation/terminal-record.json');await writeFile(path,Buffer.concat([terminal,Buffer.from(' ')]));try{await assert.rejects(withManagedRepairCapture(ref,read,async()=>{}),/handoff_original_terminal_proof_required/);}finally{await writeFile(path,terminal);}
  // Explicitly synthetic producer variants: a directly launched child still
  // requires exit evidence; an observed helper cannot invent a native parent.
  // Do not alter the real queue or any real native original for these probes.
  const endedPid=spawnSync('/usr/bin/true').pid;
  for(const kind of ['direct','observed']){
    const relative=kind==='direct'?'unknown-direct':`attempt-1/fact-and-repair/tool-host-${endedPid}`,directory=join(f.request.executionRoot,'operation',relative);await mkdir(directory);
    const launch=Buffer.from(JSON.stringify(kind==='direct'?{command:'/usr/bin/true'}:{kind:'observed-official-child',command:'/not-an-official-host',parentPid:endedPid})),processBytes=Buffer.from(JSON.stringify({pid:endedPid}));await writeFile(join(directory,'launch.json'),launch);await writeFile(join(directory,'process.json'),processBytes);
    const altered=JSON.parse(terminal.toString());altered.files[relative+'/launch.json']=hash(launch);altered.files[relative+'/process.json']=hash(processBytes);const alteredBytes=Buffer.from(JSON.stringify(altered));await writeFile(path,alteredBytes);
    const evidence=Buffer.from(JSON.stringify({...JSON.parse(source.evidence.toString()),terminalRecordSha256:hash(alteredBytes)})),repair={...source.repair,evidenceSha256:hash(evidence)},op={...source.op,result:JSON.stringify({...JSON.parse(source.op.result),repair})};
    await writeFile(join(f.root,'negative-'+kind+'.json'),JSON.stringify({kind:'explicit_synthetic_producer_variant',relative,launch:JSON.parse(launch.toString()),process:JSON.parse(processBytes.toString()),terminalSha256:hash(alteredBytes),evidence:JSON.parse(evidence.toString()),expected:'refuse_without_new_model_or_permission'}));
    try{await assert.rejects(withManagedRepairCapture(ref,()=>({...source,op,repair,evidence}),async()=>{}),kind==='direct'?/ENOENT/:/handoff_observed_helper_parent_unverified/);}finally{await writeFile(path,terminal);await rm(directory,{recursive:true});}
  }
  assert.deepEqual(await readFile(path),terminal);assert.deepEqual(await readFile(f.model.trace),trace);
});
