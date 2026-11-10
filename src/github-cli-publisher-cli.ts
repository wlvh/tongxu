import {readFile} from 'node:fs/promises';
import {prepareGitHubCliPublisher} from './github-cli-publisher-install.js';

export async function githubCliPublisherPrepare(args:string[]){
  if(args.length!==5||args[0]!=='prepare'||args[1]!=='--config'||args[3]!=='--directory'){
    throw new Error('github_cli_prepare_arguments_invalid');
  }
  const raw=await readFile(args[2]!);
  if(raw.length>32*1024)throw new Error('github_cli_configuration_limit');
  return prepareGitHubCliPublisher(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw)),args[4]!);
}
if(import.meta.url===new URL(process.argv[1]??'','file:').href){
  try{process.stdout.write(JSON.stringify(await githubCliPublisherPrepare(process.argv.slice(2)))+'\n');}
  catch{process.stderr.write('github_cli_publisher_preparation_failed\n');process.exitCode=1;}
}
