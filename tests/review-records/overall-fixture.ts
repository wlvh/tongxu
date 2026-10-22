import type test from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setup} from '../w3/receiver-fixture.js';
import {fixture} from '../w5/repair-fixture.js';
import {runReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';
import type {OverallPlan} from '../../src/overall-review.js';
export async function overallFixture(t:test.TestContext){
  const f=await setup(t),m=await fixture(t),received=await runReception(f.path);f.q.enableSupplements();f.q.reviewRecords().enable();
  const original=f.q.receiverState(received.operation),context=f.q.receiverEvidence(received.operation).context;
  const path=join(f.root,'evidence.txt'),body='Explicit four-category comparison fixture. No adopted baseline or actual supplier execution.';await writeFile(path,body);
  const material={name:'fixed fixture',path,sha256:hash(Buffer.from(body))};
  const plan:OverallPlan={schemaVersion:1,kind:'tongxu-overall-review',store:f.store,operation:received.operation,judgmentId:original.receiver.judgmentId,bindingHash:original.receiver.bindingHash,context,config:m.configPath,configSha256:hash(await readFile(m.configPath)),trigger:{kind:'owner_request',source:'fixture:request',reason:'bounded overall review'},material:{acceptedBaseline:[],cumulativeChanges:[material],currentBehavior:[material],currentDocuments:[material]},baselineAcceptance:{kind:'missing',source:null}};
  const planPath=join(f.root,'overall-plan.json');await writeFile(planPath,JSON.stringify(plan));return {...f,m,plan,planPath,path};
}
