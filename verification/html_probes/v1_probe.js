const H=require('./v1_harness.js');
const s=()=>H.s(), pr=H.pr(), flow=H.flow(), checks=H.checks(), mutate=H.mutate(), act=H.act(), dispatch=H.dispatchTask(), ses=H.ses();
function row(p,title){return checks(p).find(r=>r.title.startsWith(title));}
console.log('== 1. flow() user-acceptance cell vs result ==');
for(const r of ['accept','reject','request_evidence']){const p=pr(140);p.acceptance={sha:p.head,result:r};console.log(`  result=${r.padEnd(16)} cell=${flow(p)[6].c.padEnd(5)} mergeRowOk=${row(p,'父 Issue').ok}`);}
console.log('== 2. explanation flag survives a new head ==');
{const p=pr(101);p.merged=false;p.explanation=true;const before=flow(p)[5].c;mutate(p);console.log(`  before=${before} afterNewHead=${flow(p)[5].c} (explanation=${p.explanation})`);}
console.log('== 3. rounds increments per negative review without any fix ==');
{const p=pr(102);global.document.querySelector('#review-verdict').value='REWORK_REQUIRED';const r0=p.rounds;for(let i=0;i<2;i++){H.setModal({head:p.head});H.runReview()(102);H.flush();}console.log(`  rounds ${r0} -> ${p.rounds}, threads=${p.threads}, head unchanged, no fix between reviews`);}
console.log('== 4. delivery-confirm leaves the send intent unknown ==');
{const S=s();const m=S.messages.find(x=>x.id==='m3');S.sessions['cc-B'].state='unknown';H.deliver()('m3');H.flush();/* blocked: recipient unknown -> stays pending */ S.sessions['cc-B'].state='idle';H.deliver()('m3');H.flush();const it=S.intents.find(i=>i.target==='m3'&&i.kind==='发送消息');it.state='unknown';m.status='unknown';act('delivery-confirm','m3');console.log(`  message.status=${m.status} intent.state=${it.state}`);}
console.log('== 5. (new) D2 decision dead-end after a new head on PR #102 ==');
{const p=pr(102);const okBefore=row(p,'相关决定').ok;mutate(p);const after=row(p,'相关决定');const src=require('fs').readFileSync(process.argv[2]||'/root/.claude/uploads/7b539594-416e-556e-addf-e17f91fab87a/25f3c90e-tongxu_issue_workbench_complete_1.html','utf8');const d2writes=(src.match(/D2\.(record|confirmed|applied|head)\s*=/g)||[]).length;console.log(`  before=${okBefore} after=${after.ok} text="${after.text}" transitionsWritingD2=${d2writes}`);}
console.log('== 6. (new) newly dispatched session gets cap=control without verification ==');
{dispatch(52,'other');H.flush();const S=s();const t=S.tasks[52];const a=S.sessions[t.owner];console.log(`  owner=${t.owner} engine=${a.engine} cap=${a.cap} state=${a.state}`);}
console.log('== 7. (new) workspace-dimension dispatch check ==');
{const S=s();S.tasks[52].owner=null;S.sessions['ghost']={id:'ghost',engine:'Codex',parent:50,role:'x',state:'running',tasks:[],workspace:'/demo/52',native:'n',cap:'control',attempt:1,usage:0};const ok=dispatch(52,'same');H.flush();const dup=Object.values(S.sessions).filter(x=>x.workspace==='/demo/52').map(x=>x.id);console.log(`  dispatched=${ok} sessionsOn/demo/52=${JSON.stringify(dup)}`);}
