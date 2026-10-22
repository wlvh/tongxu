import {pathToFileURL} from 'node:url';
import {publicationReturn} from './publication-return.js';
export async function publicationReturnMain(args:string[]){if(args.length!==3||!['prepare','deliver'].includes(args[0]!)||args[1]!=='--plan')throw new Error('publication_return_command_invalid');return publicationReturn(args[2]!,args[0] as 'prepare'|'deliver');}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await publicationReturnMain(process.argv.slice(2)))+'\n');}catch(error){process.stderr.write(JSON.stringify({error:error instanceof Error?error.message:'publication_return_failed'})+'\n');process.exitCode=1;}}
