import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const exec=promisify(execFile),sourceDirectory=await realpath(fileURLToPath(new URL('../',import.meta.url)));
let temporary;
try{
  if(process.argv.length!==3)throw new Error('usage: node scripts/prepare-workbench-runtime.mjs ABS_PLAN');
  const plan=resolve(process.argv[2]);
  const git=(args,options={})=>exec('/usr/bin/git',['--no-replace-objects','-C',sourceDirectory,...args],
    {timeout:120000,maxBuffer:32*1024*1024,...options});
  const head=(await git(['rev-parse','--verify','HEAD'])).stdout.trim();
  const source=await git(['show',head+':scripts/prepare-workbench-runtime.mjs'],{encoding:'buffer'});
  if(!(await readFile(fileURLToPath(import.meta.url))).equals(source.stdout))throw new Error('workbench_runtime_source_changed');
  temporary=await realpath(await mkdtemp(join(tmpdir(),'tongxu-install-preparation-')));
  const snapshot=join(temporary,'source'),dist=join(snapshot,'dist'),archive=join(temporary,'source.tar');
  await mkdir(snapshot,{mode:0o700});
  const files=await git(['archive',head,'src','tests','package.json','tsconfig.json'],{encoding:'buffer'});
  await writeFile(archive,files.stdout,{flag:'wx',mode:0o600});
  await exec('/usr/bin/tar',['-xf',archive,'-C',snapshot],{timeout:120000});
  const dependencies=await realpath(join(sourceDirectory,'node_modules'));
  await symlink(dependencies,join(snapshot,'node_modules'),'dir');
  const compiler=await realpath(join(dependencies,'typescript','lib','tsc.js'));
  await exec(process.execPath,[compiler,'--project',join(snapshot,'tsconfig.json'),'--outDir',dist],
    {cwd:snapshot,timeout:120000,maxBuffer:2*1024*1024});
  const {prepareWorkbenchRuntime}=await import(pathToFileURL(join(dist,'src','workbench-launch.js')).href);
  const runtime=await prepareWorkbenchRuntime(sourceDirectory,plan);
  if(runtime.sourceHead!==head||runtime.buildProof?.kind!=='tsc-complete-modules-v2')throw new Error('workbench_runtime_build_proof_changed');
  process.stdout.write(JSON.stringify(runtime,null,2)+'\n');
}catch(error){
  process.stderr.write(JSON.stringify({error:error instanceof Error?error.message:'workbench_install_preparation_failed'})+'\n');
  process.exitCode=1;
}finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
