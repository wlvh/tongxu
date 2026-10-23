import type test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,realpath,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../../src/snapshot.js';
import { mergePayload,type ManagedMergeBinding } from '../../src/merge-contract.js';
import type { MergeProfile } from '../../src/merge-provider.js';

/** Real child process + HTTP requests to an explicit local fake provider.
 * No supplier, GitHub mutation, credential or real merge. */
export async function publisherFixture(t:test.TestContext,b:ManagedMergeBinding,initialMode='normal',actualFixtureMerge?:()=>Promise<string>){
  const root=await mkdtemp(join(await realpath(tmpdir()),'tongxu-merge-http-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const requests:Array<{method:string;path:string;body:string;headers:Record<string,unknown>}>=[];
  const overrides=new Map<string,{value:unknown;status:number;nextPage:boolean}>();
  let mode=initialMode,merged=false,merges=0,actualBase=b.B,actualTree=b.T,target=b.targetRef;
  let M='d'.repeat(40);const later='e'.repeat(40),repoRoot=`/repos/${b.repository}`;
  const pr=()=>({number:b.pr,state:merged?'closed':'open',draft:mode==='draft',merged,mergeable:true,mergeable_state:'clean',merge_commit_sha:merged?M:null,merged_by:merged?{id:33}:null,user:{id:44},head:{sha:mode==='head-changed'?later:b.H,repo:{id:b.repositoryId}},base:{sha:'0'.repeat(40),ref:target,repo:{id:b.repositoryId,full_name:b.repository}}});
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk.toString();const path=req.url!;requests.push({method:req.method!,path,body,headers:req.headers});
    let status=200,value:any,headers:Record<string,string>={};
    const override=req.method==='GET'?overrides.get(path):undefined;
    if(override){status=override.status;value=override.value;if(override.nextPage)headers.link='<http://127.0.0.1/explicit-fixture-next>; rel="next"';}
    else if(path==='/capabilities')value={kind:'capabilities',credentialState:mode==='credential-missing'?'unavailable':'available',actorId:33,identity:'fixture',repositoryIds:[b.repositoryId],targetRefs:[b.targetRef],merge:true,bypass:false,synchronousHeadCondition:true,sourceReference:'explicit-local-fixture-identity'};
    else if(req.method==='PUT'&&path===`${repoRoot}/pulls/${b.pr}/merge`){
      if(mode==='refused'){status=409;value={message:'explicit fixture head precondition refusal',merged:false};}
      else{
        const payload=JSON.parse(body);if(payload.sha!==b.H||payload.merge_method!=='merge'||JSON.stringify(payload)!==JSON.stringify(JSON.parse(JSON.stringify(payload)))){status=409;value={message:'fixture invalid request'};}
        else{if(actualFixtureMerge)M=await actualFixtureMerge();merged=true;merges++;if(mode==='base-race')actualBase=later;if(mode==='tree-race')actualTree=later;if(mode==='wrong-target')target='other';value={merged:true,sha:M};if(mode==='lost-after-merge'){res.destroy();return;}}
      }
    }else if(req.method!=='GET'){status=405;value={message:'fixture disallowed mutation'};}
    else if(path===repoRoot)value={id:b.repositoryId,full_name:b.repository,archived:false,disabled:false,allow_merge_commit:true};
    else if(path===`${repoRoot}/pulls/${b.pr}`)value=pr();
    else if(path===`${repoRoot}/git/ref/heads/${encodeURIComponent(b.targetRef)}`)value={ref:`refs/heads/${b.targetRef}`,object:{type:'commit',sha:merged?M:b.B}};
    else if(path===`${repoRoot}/branches/${encodeURIComponent(b.targetRef)}`)value={name:b.targetRef,commit:{sha:b.B},protected:true};
    else if(path===`${repoRoot}/branches/${encodeURIComponent(b.targetRef)}/protection`)value={required_pull_request_reviews:{required_approving_review_count:0},required_status_checks:{contexts:[],checks:[]},enforce_admins:{enabled:true}};
    else if(path.startsWith(`${repoRoot}/rules/branches/`))value=mode==='unknown-rule'?[{type:'merge_queue',ruleset_id:1}]:[];
    else if(path.startsWith(`${repoRoot}/commits/${b.H}/check-runs`))value={total_count:mode==='missing-check-page'?1:0,check_runs:[]};
    else if(path.startsWith(`${repoRoot}/commits/${b.H}/statuses`))value=[];
    else if(path.startsWith(`${repoRoot}/pulls/${b.pr}/reviews`))value=[];
    else if(path===`${repoRoot}/git/commits/${M}`)value={sha:M,tree:{sha:actualTree},parents:[{sha:actualBase},{sha:b.H}],message:`tongxu: receive PR #${b.pr}\n\n${mergePayload(b).commit_message}`};
    else{status=404;value={message:'fixture missing exact endpoint'};}
    res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const address=server.address() as {port:number},origin=`http://127.0.0.1:${address.port}`,executable=join(root,'publisher.mjs'),envPath=join(root,'observed-env.json');
  const source=`#!${process.execPath}\nimport fs from 'node:fs';import {mergeHttpRequest} from ${JSON.stringify(new URL('../../src/merge-provider.js',import.meta.url).href)};import {canonical} from ${JSON.stringify(new URL('../../src/comparison.js',import.meta.url).href)};import {hash} from ${JSON.stringify(new URL('../../src/snapshot.js',import.meta.url).href)};
if(process.argv.slice(2).join()!=='--tongxu-managed-merge-v1')process.exit(5);fs.writeFileSync(${JSON.stringify(envPath)},JSON.stringify(Object.keys(process.env)));
let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',async()=>{try{const c=JSON.parse(text);let result;
if(c.command==='capabilities'){result=await (await fetch(${JSON.stringify(origin+'/capabilities')})).json();}else{const q=mergeHttpRequest(c),r=await fetch(${JSON.stringify(origin)}+q.path,{method:q.method,...(q.body?{body:q.body}:{}),redirect:'error'});result={kind:'http',status:r.status,body:await r.text(),nextPage:Boolean(r.headers.get('link')?.includes('rel="next"'))};}
console.log(JSON.stringify({protocol:c.protocol,inputSha256:hash(canonical(c)),result}));}catch(e){console.error('explicit fixture transport failed');process.exitCode=1;}});`;
  await writeFile(executable,source,{mode:0o700});
  const profile:MergeProfile={schemaVersion:1,kind:'tongxu-managed-publisher',repository:b.repository,repositoryId:b.repositoryId,targets:[b.targetRef],actorId:33,executable,executableSha256:hash(source),executionKind:'fixture',timeoutMs:5000};
  return {root,profile,requests,state:()=>({mode,merged,merges,actualBase,actualTree,target,M}),setMode:(value:string)=>{mode=value;},setReply:(path:string,value:unknown,status=200,nextPage=false)=>overrides.set(path,{value,status,nextPage}),env:async()=>JSON.parse((await readFile(envPath)).toString())};
}
