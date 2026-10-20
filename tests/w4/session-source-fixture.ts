import type test from 'node:test';
import { mkdtemp,realpath,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../../src/snapshot.js';
import { disabledFeatures } from '../../src/live-codex.js';
import type { SessionReadSpec } from '../../src/session-source.js';
export async function fixture(t:test.TestContext,mode='complete'){
  const root=await mkdtemp(join(await realpath(tmpdir()),'tongxu-session-source-'));t.after(()=>rm(root,{recursive:true,force:true}));const executable=join(root,'codex-reader-fixture.mjs'),workspace=join(root,'original-workspace');
  const config={features:Object.fromEntries(disabledFeatures.map(n=>[n,false])),mcp_servers:{},web_search:'disabled',model_provider:'openai',service_tier:'default'};
  const script=`#!${process.execPath}\nimport readline from'node:readline';if(process.argv.includes('--version')){console.log('codex-cli 0.163.0-alpha.10.2');process.exit(0)}const config=${JSON.stringify(config)},mode=${JSON.stringify(mode)};const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;let result;if(q.method==='initialize')result={userAgent:'explicit-session-reader-fixture'};else if(q.method==='config/read')result={config};else if(q.method==='thread/read'){if(mode==='missing'){console.log(JSON.stringify({id:q.id,error:{code:-32600,message:'explicit fixture: original ephemeral thread unavailable'}}));return;}result={thread:{id:mode==='wrong-thread'?'another-thread':q.params.threadId,sessionId:'fixture-session',cwd:${JSON.stringify(workspace)},cliVersion:'0.134.0',ephemeral:false,status:{type:'idle'},parentThreadId:null,forkedFromId:null}};}else throw new Error('Fixture forbids mutation or model method: '+q.method);console.log(JSON.stringify({id:q.id,result}));});`;
  await writeFile(executable,script,{mode:0o700});const spec:SessionReadSpec={schemaVersion:1,kind:'tongxu-exact-codex-session-read',executable,executableSha256:hash(script),threadId:'fixture-thread',sessionId:'fixture-session',workspace,disabledMcpServers:[],executionKind:'fixture'};
  return {root,spec};
}
