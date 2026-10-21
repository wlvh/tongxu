import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {canonical} from '../../src/comparison.js';
import {hash} from '../../src/snapshot.js';
import {DockerRuntime,parseDockerConfig} from '../../src/docker-sandbox.js';
import {parseDeliveryBatch} from '../../src/delivery-contract.js';
import {parseDeliveryValidation} from '../../src/delivery-validation-contract.js';
import {runDeliveryValidation} from '../../src/delivery-validation.js';
import {deliveryMain} from '../../src/delivery-cli.js';
import {QueueStore} from '../../src/queue-store.js';
import type {DeliveryValidationCapture} from '../../src/delivery-validation-capture.js';
import {DeliveryValidationRecords} from '../../src/delivery-validation-store.js';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {fixtureOwnerObservation,type OwnerObservation} from '../../src/authority-source.js';
import {deliveryValidationSha} from '../../src/delivery-validation-contract.js';

const configPath=process.env.TONGXU_TEST_DOCKER_CONFIG;if(!configPath)throw new Error('TONGXU_TEST_DOCKER_CONFIG_required');
export const docker=parseDockerConfig(JSON.parse(await readFile(configPath,'utf8'))),raw=(x:unknown)=>Buffer.from(canonical(x));
const check=`import fs from 'node:fs';const m=await import('file:///work/sample.js');fs.writeFileSync(process.env.TONGXU_RESULT_FILE,JSON.stringify({samples:[{id:'integer-export',status:Number.isInteger(m.value)&&m.value>0?'ok':'fail',content:{value:m.value},identity:{file:'sample.js'},source:'actual isolated import of fixed sample.js',sideEffects:{output:'result.json'}}]}));`;
export async function deliveryFixture(t:test.TestContext,governed=false,mode='complete'){
  const hooks:Array<()=>unknown>=[],f=await messageFixture({after:(fn:()=>unknown)=>hooks.push(fn)} as unknown as test.TestContext,mode);t.after(async()=>{const evidence=process.env.TONGXU_DELIVERY_TEST_EVIDENCE;if(evidence){await mkdir(evidence,{recursive:true});await cp(f.root,join(evidence,basename(f.root)),{recursive:true});}for(const fn of hooks)await fn();});
  const a=governed?await messageAuthority(f):null,item=f.q.status().items.find((x:any)=>x.id===f.item),event=f.q.status().events.filter((e:any)=>e.object===f.item&&e.kind==='material_changed').at(-1),adoption=a?.a.proposal(a.scope.sha).proposal as any;
  const batch=parseDeliveryBatch(raw({schemaVersion:1,kind:'tongxu-delivery-batch',id:'fixture-X1',revision:1,previous:null,repository:'fixture/reception',issue:9,title:'实际隔离测试示例',source:'explicit Docker validation fixture',target:'fixture',scope:{id:item.context.scope.id,version:item.context.scope.version,adoption:a?.scope.sha??null},goals:adoption?.body.goals??['验证固定导出的整数能力'],nonGoals:adoption?.body.nonGoals??['无真实模型或生产采用'],members:[{item:f.item,packet:item.currentPacket,fingerprint:JSON.parse(event.data).fingerprint}],scenarios:[{id:'integer-scenario',title:'固定模块导出有效整数',expected:'实际导入模块并取得正整数value，保存准确来源与输出',members:[f.item]}],related:[]})),registered=f.q.deliveries().register(raw(batch));
  let authorityIntent:string|null=null;const validationObservations:OwnerObservation[]=[];if(a){const {payloadSha256:_payload,...base}=a.request,request={...base,action:'test' as const},c=await a.adopt({kind:'confirm_action',adoption:a.scope.sha,performerRole:'background',request,expiresAt:new Date(Date.now()+3600000).toISOString()});authorityIntent='validate-fixed-delivery';validationObservations.push(a.scope.observation,c.observation);a.a.reserveAction(authorityIntent,request,'background',c.sha,validationObservations);}
  const testPlan={schemaVersion:2,executor:docker,tools:[{id:'integer-check',argv:[docker.node,'--input-type=module','-e',check],timeoutMs:10000,expectedSampleIds:['integer-export']}]},testPath=join(f.root,'delivery-test-plan.json');await writeFile(testPath,raw(testPlan));const snapshot=join(f.root,'snapshot-1'),manifest=await readFile(join(snapshot,'manifest.json'));
  const plan=parseDeliveryValidation(raw({schemaVersion:1,kind:'tongxu-delivery-validation',id:'validate-integers',batchSha256:registered.batchSha256,member:f.item,source:'explicit bounded validation; real Docker and tests, no model',demonstrationFixture:true,authorityIntent,snapshots:[{path:snapshot,sha256:hash(manifest)}],objects:join(f.root,'objects'),testPlan:{path:testPath,sha256:hash(raw(testPlan))},scenarios:[{scenario:'integer-scenario',tool:'integer-check',samples:['integer-export']}]})),planPath=join(f.root,'delivery-validation.json');await writeFile(planPath,raw(plan));
  return {...f,batch,registered,plan,planPath,testPlan,testPath,manifest,a,validationObservations};
}
export function freshAuthority(f:Awaited<ReturnType<typeof deliveryFixture>>,intent:string){const a=f.a!,{profile}=a.a.configuration(),reserved=a.a.reservedAction(intent);return a.a.sourceRequests(reserved.authorization).map(ref=>{const r=a.records[ref.commentId];return fixtureOwnerObservation(profile,ref.proposalSha256,ref.commentId,raw(r.graph),raw(r.comment),new Date().toISOString());});}

