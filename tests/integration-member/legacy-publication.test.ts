import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {memberInputFixture} from './repair-fixture.js';
import {verify} from '../../src/verification.js';
import {readPacket} from '../../src/queue-evidence.js';
import {runReception} from '../../src/receiver.js';
import {hash} from '../../src/snapshot.js';
import {canonical} from '../../src/comparison.js';
import {pathToFileURL} from 'node:url';
const raw=(x:unknown)=>Buffer.from(canonical(x));

test('IMR-F02: an already opened actual 292 publisher cannot post an obsolete member PASS after the format upgrade', {skip:!process.env.TONGXU_LEGACY_INTEGRATION_SOURCE},async t=>{
 const {publication:oldPublication}=await import(pathToFileURL(join(process.env.TONGXU_LEGACY_INTEGRATION_SOURCE!,'dist/src/publisher.js')).href);
 const f=await memberInputFixture(t),docker=JSON.parse(await readFile(process.env.TONGXU_TEST_DOCKER_CONFIG!,'utf8')),positive=join(f.root,'old-positive-plan.json');await writeFile(positive,raw({schemaVersion:2,executor:docker,tools:[{id:'positive-unit',argv:[docker.node,'-e',"const fs=require('node:fs'),n=JSON.parse(fs.readFileSync('scale.json'));fs.writeFileSync(process.env.TONGXU_RESULT_FILE,JSON.stringify({samples:[{id:'positive',status:n>0?'ok':'fail',content:n,identity:'positive-unit',source:'actual scale.json',sideEffects:[]}]}));"],timeoutMs:10000,expectedSampleIds:['positive']}]}));
 const verification=join(f.root,'old-positive-verification');await verify({snapshots:[f.snapshots[0]!],objects:f.objects,plan:positive,output:verification});const packet=await readPacket(f.snapshots[0]!,verification,join(f.root,'integration-context.json')),member=f.q.import(packet);
 await writeFile(f.plan.claudeExecutable,(await readFile(f.plan.claudeExecutable,'utf8')).replace('mode="return"','mode="complete"'));const receiver=join(f.root,'native-shaped-member-fixture.json');
 // Explicit native-shaped local fixture, exactly as existing publication tests
 // require. The executable is the known local .mjs script, never official CLI.
 await writeFile(receiver,raw({...f.plan,item:member.item,objects:f.objects,sourcePaths:['src/normalize.mjs','scale.json'],executionKind:'native_capture'}));const accepted=await runReception(receiver);assert.equal(accepted.receiver.judgment.verdict,'ACCEPT_WITHIN_SCOPE');assert.equal(accepted.receiver.currentMaterialMatches,true);
 const selection={...f.association,member:{...f.association.member,packet:member.packet,fingerprint:packet.fingerprint}},selectionPath=join(f.root,'late-member-return.json');await writeFile(selectionPath,raw(selection));const remotePath=join(f.root,'explicit-fake-publication.json'),gh=join(f.root,'explicit-local-gh-fixture.mjs'),c=accepted.candidate,actor={id:72,login:'independent-local-publisher'};
 await writeFile(remotePath,raw({repository:c.repository,repositoryId:71,pr:c.pr,H:c.H,B:c.B,target:c.targetRef,actor,comments:[],statuses:[],requests:[],posts:[],hookApplied:false}));
 const code=`#!${process.execPath}
import fs from 'node:fs';
import {QueueStore} from ${JSON.stringify(new URL('../../src/queue-store.js',import.meta.url).href)};
const path=${JSON.stringify(remotePath)},store=${JSON.stringify(f.store)},selection=${JSON.stringify(selectionPath)},operation=${JSON.stringify(accepted.operation)},args=process.argv.slice(2),method=args[args.indexOf('--method')+1],endpoint=args.at(-1);let input='';for await(const b of process.stdin)input+=b;let r=JSON.parse(fs.readFileSync(path,'utf8'));r.requests.push({method,endpoint});const base='repos/'+r.repository,save=()=>fs.writeFileSync(path,JSON.stringify(r));function emit(status,value){save();process.stdout.write('HTTP/2.0 '+status+' Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(value));process.exitCode=status>=400?1:0;}
if(method==='GET'){
 if(endpoint==='user')emit(200,r.actor);
 else if(endpoint===base)emit(200,{id:r.repositoryId,full_name:r.repository,permissions:{push:true}});
 else if(endpoint===base+'/pulls/'+r.pr)emit(200,{number:r.pr,state:'open',head:{sha:r.H,repo:{id:r.repositoryId}},base:{sha:r.B,ref:r.target,repo:{id:r.repositoryId}}});
 else if(endpoint.startsWith(base+'/git/ref/heads/')){if(!r.hookApplied){const q=await QueueStore.open(store);try{const recorded=q.integrationMemberReturns().record(fs.readFileSync(selection));r.recordedReturn=recorded;r.newReaderCurrent=q.receiverState(operation).result.receiver.currentMaterialMatches;r.hookApplied=true;}finally{q.close();}}emit(200,{ref:'refs/heads/'+r.target,object:{type:'commit',sha:r.B}});}
 else if(endpoint.includes('/issues/'+r.pr+'/comments?')){const page=Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));emit(200,r.comments.slice((page-1)*100,page*100));}
 else if(endpoint.startsWith(base+'/issues/comments/')){const value=r.comments.find(x=>x.id===Number(endpoint.split('/').at(-1)));emit(value?200:404,value??{message:'missing'});}
 else if(endpoint.includes('/commits/')&&endpoint.includes('/statuses?')){const page=Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));emit(200,r.statuses.slice((page-1)*100,page*100));}
 else emit(404,{message:'explicit fixture endpoint absent'});
}else if(method==='POST'){
 const payload=JSON.parse(input),comment=endpoint===base+'/issues/'+r.pr+'/comments';r.posts.push({endpoint,payload});const value=comment?{id:100+r.comments.length,user:r.actor,body:payload.body,issue_url:'https://api.github.com/'+base+'/issues/'+r.pr,html_url:'https://github.com/'+r.repository+'/pull/'+r.pr+'#issuecomment-'+(100+r.comments.length)}:{id:200+r.statuses.length,creator:r.actor,...payload};if(comment)r.comments.push(value);else r.statuses.unshift(value);emit(201,value);
}else emit(405,{message:'fixture method refused'});
`;
 await writeFile(gh,code,{mode:0o700});const plan={schemaVersion:1,kind:'tongxu-reception-publication',store:f.store,operation:accepted.operation,channel:'commit-status',ghExecutable:gh,ghSha256:hash(await readFile(gh)),repositoryId:71,actor,source:'Explicit local stale-publication counterexample, no GitHub or supplier access'},path=join(f.root,'publication-plan.json');await writeFile(path,raw(plan));
 assert.equal((await oldPublication(path,'prepare')).status,'prepared_not_sent');await assert.rejects(oldPublication(path,'publish'),/member_publication_current_admission_required/);const remote=JSON.parse(await readFile(remotePath,'utf8')),current=f.q.receiverState(accepted.operation);assert.equal(remote.hookApplied,true);assert.equal(remote.newReaderCurrent,false);assert.equal(current.result.receiver.currentMaterialMatches,false);assert.equal(remote.posts.length,0);assert.equal(canonical(current.receiver.judgment),canonical(accepted.receiver.judgment));
 const db=new DatabaseSync(join(f.store,'queue.sqlite'),{readOnly:true});const version=(db.prepare('PRAGMA user_version').get() as any).user_version;db.close();assert.equal(version,20);assert.throws(()=>f.q.publicationEvent(accepted.operation,'intent','comment',{}),/publication_source_no_longer_current/);
});
