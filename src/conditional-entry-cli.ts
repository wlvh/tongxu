#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {messagePath,messageId} from './message-contract.js';
import {ConditionalDeliveryEntry} from './conditional-entry.js';

export async function conditionalEntryMain(args:string[]){
 const action=args[0],keys=action==='repair-member'||action==='reconcile-member'?['entry','task','finding']:['repair','reconcile-repair','collect-member','validate-member','recompose-member','reuse','reuse-publication'].includes(action??'')?['entry','task']:action==='collect'?['entry','pr']:action==='arrange'?['entry','choice']:['entry'],values:Record<string,string>={};
 if(!['state','prepare','refresh','arrange','advice','investigate','reuse','reuse-publication','repair','repair-member','reconcile-repair','reconcile-member','collect-member','validate-member','recompose-member','integrate','reconcile','collect','validate','attach','receive','report'].includes(action??'')||args.length!==keys.length*2+1)throw new Error('conditional_entry_command_invalid');
 for(let i=1;i<args.length;i+=2){const key=args[i]!.slice(2);if(!args[i]!.startsWith('--')||!keys.includes(key)||Object.hasOwn(values,key)||!args[i+1])throw new Error('conditional_entry_option_invalid');values[key]=args[i+1]!;}
 if(!messagePath(values.entry)||['repair','repair-member','reconcile-repair','reconcile-member','collect-member','validate-member','recompose-member','reuse','reuse-publication'].includes(action??'')&&!messageId(values.task))throw new Error('conditional_entry_reference_invalid');
 if(action==='arrange'&&!messageId(values.choice))throw new Error('conditional_entry_choice_invalid');
 if(action==='collect'&&(!/^[1-9][0-9]*$/.test(values.pr??'')||!Number.isSafeInteger(Number(values.pr))))throw new Error('conditional_entry_pr_invalid');
 if(['repair-member','reconcile-member'].includes(action??'')&&(!/^(0|[1-9][0-9]?)$/.test(values.finding??'')||Number(values.finding)>29))throw new Error('conditional_entry_finding_invalid');
 const entry=await ConditionalDeliveryEntry.load(values.entry,action==='state'||action==='report');
 if(['repair','repair-member','reconcile-repair','reconcile-member'].includes(action??''))return entry.repair(values.task!,values.finding===undefined?undefined:Number(values.finding),action==='reconcile-repair'||action==='reconcile-member');
 if(action==='collect-member')return entry.collectMember(values.task!);if(action==='validate-member')return entry.validateMember(values.task!);if(action==='recompose-member')return entry.recomposeMember(values.task!);
 if(action==='state')return entry.state();if(action==='report')return entry.report();if(action==='advice')return entry.advice();if(action==='investigate')return entry.investigate();if(action==='reuse')return entry.reuse(values.task!);if(action==='integrate'||action==='reconcile')return entry.integrate(action==='reconcile');if(action==='collect')return entry.collect(Number(values.pr));
 if(action==='validate')return entry.validate();
 if(action==='attach')return entry.attach();
 if(action==='receive')return entry.receive();
 if(action==='reuse-publication')return entry.reusePublication(values.task!);
 if(action==='refresh'||action==='arrange')return entry.refresh(action==='arrange'?values.choice:undefined);
 return entry.prepare();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await conditionalEntryMain(process.argv.slice(2)))+'\n');}catch(e){const reason=e instanceof Error&&/^[a-z0-9_:.-]+$/.test(e.message)?e.message:'conditional_entry_failed';process.stderr.write(JSON.stringify({reason,automaticResend:false,permissionGranted:false})+'\n');process.exitCode=1;}}
