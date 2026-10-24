import type test from 'node:test';
import { mkdtemp,realpath,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../../src/snapshot.js';
import type { EventProfile } from '../../src/event-contract.js';

export async function sourceFixture(t:test.TestContext,repository='fixture/events'){
  const root=await mkdtemp(join(await realpath(tmpdir()),'tongxu-event-source-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));const statePath=join(root,'source.json'),exe=join(root,'gh-source.mjs');
  const state={H:'a'.repeat(40),B:'b'.repeat(40),target:'main',body:null,updatedAt:'2026-10-20T00:00:00Z',comments:[],inline:[],reviews:[],checks:[],statuses:[],mode:'normal',prReads:0,requests:[]};await writeFile(statePath,JSON.stringify(state),{mode:0o600});
  const source=`#!${process.execPath}\nimport fs from 'node:fs';const file=${JSON.stringify(statePath)},s=JSON.parse(fs.readFileSync(file,'utf8')),args=process.argv.slice(2),path=args.at(-1),method=args[args.indexOf('--method')+1];s.requests.push({path,method,env:Object.keys(process.env)});const prefix=${JSON.stringify('repos/'+repository)};let status=200,value,link='';
if(method!=='GET')throw new Error('fixture mutation forbidden');
if(path===prefix+'/pulls/1'){s.prReads++;value={number:1,body:s.body,state:s.prState??'open',draft:false,comments:s.comments.length,review_comments:s.inline.length,updated_at:s.updatedAt,head:{sha:s.H,repo:{id:12}},base:{sha:'0'.repeat(40),ref:s.target,repo:{id:12,full_name:${JSON.stringify(repository)}}}};if(s.mode==='move-during-read'&&s.prReads%2===1)s.H='c'.repeat(40);}
else if(s.related&&s.related[path])value=s.related[path];
else if(path===prefix+'/git/ref/heads/'+encodeURIComponent(s.target))value={ref:'refs/heads/'+s.target,object:{type:'commit',sha:s.B}};
else {const url=new URL('https://api.github.com/'+path),page=Number(url.searchParams.get('page')),kind=path.includes('/check-runs?')?'checks':path.includes('/statuses?')?'statuses':path.includes('/reviews?')?'reviews':path.includes('/pulls/1/comments?')?'inline':path.includes('/issues/1/comments?')?'comments':null;if(!kind){status=404;value={message:'fixture endpoint unavailable'};}else{const rows=s[kind],selected=rows.slice((page-1)*100,page*100);value=kind==='checks'?{total_count:rows.length,check_runs:selected}:selected;if(rows.length>page*100){url.searchParams.set('page',String(page+1));link='<'+url.href+'>; rel="next"';}if(s.mode==='forbidden-comments'&&kind==='comments'){status=403;value={message:'explicit fixture denied'};}if(s.mode==='bad-pagination'&&kind==='reviews')link='unparseable header';}}
fs.writeFileSync(file,JSON.stringify(s));process.stdout.write('HTTP/2 '+status+' Fixture\\r\\ncontent-type: application/json\\r\\n'+(link?'link: '+link+'\\r\\n':'')+'\\r\\n'+JSON.stringify(value));process.exitCode=status>=400?1:0;`;
  await writeFile(exe,source,{mode:0o700});
  const profile:EventProfile={schemaVersion:1,kind:'tongxu-bounded-event-source',repository,repositoryId:12,ghExecutable:exe,ghSha256:hash(source),executionKind:'fixture',prs:[1],pollIntervalMs:10,maxSubjectsPerTick:1};
  const get=async()=>JSON.parse((await readFile(statePath)).toString());const change=async(value:Record<string,unknown>)=>writeFile(statePath,JSON.stringify({...await get(),...value}),{mode:0o600});
  return {root,profile,get,change,statePath};
}
