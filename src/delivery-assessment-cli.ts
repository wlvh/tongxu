#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {messagePath,messageId,checkMessageBilling} from './message-contract.js';
import {regular} from './repair-workspace.js';
import {QueueStore} from './queue-store.js';
import {runDeliveryAssessment} from './delivery-assessment.js';
export async function assessmentMain(args:string[]){
  const command=args[0],read=command==='state'||command==='report',keys=read?['store','id']:['run','prepare','reconcile','close-unstarted'].includes(command??'')?['store','request',...(command==='run'&&args.includes('--billing')?['billing']:[])]:null,values:Record<string,string>={};if(!keys||args.length!==1+keys.length*2)throw new Error('delivery_assessment_command_invalid');
  for(let i=1;i<args.length;i+=2){const flag=args[i]!,key=flag.slice(2),value=args[i+1];if(!flag.startsWith('--')||!keys.includes(key)||!value||value.startsWith('--')||Object.hasOwn(values,key))throw new Error('delivery_assessment_option_invalid');values[key]=value;}
  if(!messagePath(values.store)||read&&!messageId(values.id)||!read&&!messagePath(values.request)||values.billing&&!messagePath(values.billing))throw new Error('delivery_assessment_reference_invalid');
  if(read)return QueueStore.observeDeliveryAssessment(values.store!,values.id!,command==='report');let billing;if(values.billing){billing=JSON.parse((await regular(values.billing,128*1024)).toString());checkMessageBilling(billing);}return runDeliveryAssessment(values.store!,values.request!,command as 'run'|'prepare'|'reconcile'|'close-unstarted',billing);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await assessmentMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'delivery_assessment_failed',automaticResend:false})+'\n');process.exitCode=1;}}
