import {pathToFileURL} from 'node:url';
import {publicationReturn} from './publication-return.js';
import {messagePath,checkMessageBilling} from './message-contract.js';
import {regular} from './repair-workspace.js';
export async function publicationReturnMain(args:string[]){
  const action=args[0],keys=['prepare','deliver'].includes(action??'')?['plan',...(action==='deliver'&&args.includes('--billing')?['billing']:[])]:null,values:Record<string,string>={};
  if(!keys||args.length!==1+2*keys.length)throw new Error('publication_return_command_invalid');
  for(let i=1;i<args.length;i+=2){const key=args[i]!.slice(2),value=args[i+1];if(!args[i]!.startsWith('--')||!keys.includes(key)||!value||value.startsWith('--')||Object.hasOwn(values,key))throw new Error('publication_return_option_invalid');values[key]=value;}
  if(!messagePath(values.plan)||values.billing&&!messagePath(values.billing))throw new Error('publication_return_path_invalid');
  let billing;if(values.billing){billing=JSON.parse((await regular(values.billing,128*1024)).toString());checkMessageBilling(billing);}
  return publicationReturn(values.plan!,action as 'prepare'|'deliver',billing);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await publicationReturnMain(process.argv.slice(2)))+'\n');}catch(error){process.stderr.write(JSON.stringify({error:error instanceof Error?error.message:'publication_return_failed'})+'\n');process.exitCode=1;}}
