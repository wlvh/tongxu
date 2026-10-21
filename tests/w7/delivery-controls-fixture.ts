import type test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {messageFixture} from '../w6/message-fixture.js';
import {messageAuthority} from '../w6/message-authority-fixture.js';
import {canonical} from '../../src/comparison.js';
import {parseDeliveryBatch} from '../../src/delivery-contract.js';
import {ownerDecisionText} from '../../src/authority-contract.js';
import {DeliveryControls} from '../../src/delivery-controls.js';
import {parseWorkbenchPlan} from '../../src/workbench.js';
const raw=(x:unknown)=>Buffer.from(canonical(x));
export async function deliveryControlsFixture(t:test.TestContext){
  const f=await messageFixture(t),a=await messageAuthority(f),item=f.q.status().items.find((x:any)=>x.id===f.item),event=f.q.status().events.filter((e:any)=>e.object===f.item&&e.kind==='material_changed').at(-1),adopted=a.a.proposal(a.scope.sha).proposal as any;
  const batch=parseDeliveryBatch(raw({schemaVersion:1,kind:'tongxu-delivery-batch',id:'X1',revision:1,previous:null,repository:'fixture/reception',issue:9,title:'固定成果与本人决定 · 隔离示例',source:'explicit durable UI fixture; no real Owner or model',target:'fixture',scope:{id:item.context.scope.id,version:item.context.scope.version,adoption:a.scope.sha},goals:adopted.body.goals,nonGoals:adopted.body.nonGoals,members:[{item:f.item,packet:item.currentPacket,fingerprint:JSON.parse(event.data).fingerprint}],scenarios:[{id:'integer',title:'固定模块导出有效整数',expected:'实际导入固定模块并检查整数，保存原输出与候选',members:[f.item]}],related:[]}));
  const registered=f.q.deliveries().register(raw(batch)),plan=parseWorkbenchPlan(raw({schemaVersion:1,kind:'tongxu-controlled-workbench',title:'同序成果验收 · 隔离示例',goal:'从固定批次核对场景、证据和本人决定，保留原失败与历史。',sources:[{id:'fixture',title:'固定整数契约',store:f.store,item:f.item}],deliveries:[{id:'x1',source:'fixture',batchSha256:registered.batchSha256}]})),workbenchPath=join(f.root,'delivery-workbench.json');await writeFile(workbenchPath,raw(plan));const controls=new DeliveryControls(plan.deliveries!,plan.sources,true);
  async function originalDecision(proposalSha256:string){const id=7400000000+Object.keys(a.records).length,at=new Date().toISOString(),node='IC_delivery_ui_'+id,url=`https://github.com/fixture/reception/issues/8#issuecomment-${id}`,text=ownerDecisionText(proposalSha256),comment={id,node_id:node,body:text,user:{id:101,type:'User'},created_at:at,updated_at:at,issue_url:'https://api.github.com/repos/fixture/reception/issues/8',html_url:url},graph={data:{viewer:{databaseId:202},node:{__typename:'IssueComment',id:node,fullDatabaseId:String(id),author:{__typename:'User',databaseId:101},editor:null,lastEditedAt:null,body:text,createdAt:at,updatedAt:at,url,issue:{number:8,repository:{nameWithOwner:'fixture/reception'}}}}};a.records[id]={comment,graph};await writeFile(a.sourcePath,raw(a.records));return id;}
  return {...f,a,batch,registered,workbenchPlan:plan,workbenchPath,controls,originalDecision};
}
