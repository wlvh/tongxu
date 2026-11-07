import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from '../../src/snapshot.js';
import {git} from '../../src/repair-workspace.js';

/** Explicit local GitHub transport fixture. Publishing here changes only
 * scripted GET facts; it performs no real GitHub write. */
export async function memberSourceFixture(root:string,H:string,B:string,objects:string){
 const state=join(root,'member-remote-fixture.json'),trace=join(root,'member-remote-get-trace.jsonl'),executable=join(root,'member-remote-get-fixture.mjs');const publish=async(newH:string,source:string)=>writeFile(state,JSON.stringify({H:newH,B,commits:(await git(source,['rev-list','--reverse',B+'..'+newH])).split('\n').filter(Boolean),files:(await git(source,['diff','--name-only',B,newH])).split('\n').filter(Boolean)}));await publish(H,objects);
 const code=`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);if(args.includes('--version')){console.log('gh version 9.8.7 (explicit fixture)');process.exit(0);}if(args.includes('--help')){console.log('gh api --method --include --hostname');process.exit(0);}
const endpoint=args.at(-1),all=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')),pr=endpoint.includes('/99')||all.integration&&endpoint.includes('/commits/'+all.integration.H+'/')?99:10,s=pr===99?all.integration??{}:all;if(args[args.indexOf('--method')+1]!=='GET')process.exit(4);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({method:'GET',endpoint})+'\\n');
const repository={id:1,full_name:'fixture/reception'};let value,status=200;
if(pr===99&&!all.integration){status=404;value={message:'explicit integration fixture not published'};}
else if(endpoint==='repos/fixture/reception')value=repository;
else if(endpoint==='repos/fixture/reception/pulls/'+pr)value={id:pr,number:pr,state:s.closed?'closed':'open',merged:false,draft:false,head:{sha:s.H,ref:'member-a',repo:s.fork?{id:2,full_name:'fixture/foreign'}:repository},base:{sha:s.B,ref:'fixture',repo:repository},body:s.body??'Explicit new member source fixture, not actual GitHub publication.',html_url:'https://github.com/fixture/reception/pull/'+pr,updated_at:'2026-11-07T00:00:00Z',comments:0,review_comments:0,commits:s.commits.length,changed_files:s.files.length};
else if(endpoint==='repos/fixture/reception/git/ref/heads/fixture')value={ref:'refs/heads/fixture',object:{type:'commit',sha:s.B}};
else if(endpoint==='repos/fixture/reception/pulls/'+pr+'/commits?per_page=100&page=1')value=s.commits.map(sha=>({sha,commit:{message:'Actual Git lineage, explicit remote fixture'}}));
else if(endpoint==='repos/fixture/reception/pulls/'+pr+'/files?per_page=100&page=1')value=s.files.map(filename=>({filename}));
else if(endpoint==='repos/fixture/reception/commits/'+s.H+'/check-runs?filter=latest&per_page=100&page=1')value={total_count:0,check_runs:[]};
else if(endpoint==='repos/fixture/reception/commits/'+s.H+'/statuses?per_page=100&page=1')value=[];
else if(/^repos\\/fixture\\/reception\\/(?:issues\\/(?:10|99)\\/comments|pulls\\/(?:10|99)\\/(?:reviews|comments))\\?per_page=100&page=1$/.test(endpoint))value=[];
else {status=404;value={message:'explicit fixture route absent'};}
process.stdout.write('HTTP/1.1 '+status+' Fixture\\r\\nDate: Sat, 07 Nov 2026 00:00:00 GMT\\r\\n\\r\\n'+JSON.stringify(value));process.exitCode=s.exitCode??0;
`;
 await writeFile(executable,code,{mode:0o700});
 const publishIntegration=async(newH:string,source:string)=>{
  const current=JSON.parse(await readFile(state,'utf8'));
  const integration={
   H:newH,B,
   commits:(await git(source,['rev-list','--reverse',B+'..'+newH])).split('\n').filter(Boolean),
   files:(await git(source,['diff','--name-only',B,newH])).split('\n').filter(Boolean)
  };
  await writeFile(state,JSON.stringify({...current,integration}));
 };
 const reads=async()=>{
  try{return (await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}
  catch(e:any){if(e.code==='ENOENT')return [];throw e;}
 };
 return {executable,sha256:hash(code),trace,state,publish,publishIntegration,reads};
}
