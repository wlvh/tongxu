const load=require('./harness2.js');const fs=require('fs');
const D=load('./69b0636d.js',['d','facts','authorization','eligible','demoAct','completeRemote'],{'#test-data':fs.readFileSync('test-data.json','utf8'),'#work-data':fs.readFileSync('work-data.json','utf8')});
const d=()=>D.d(),act=D.demoAct(),auth=D.authorization(),facts=D.facts();
const out=(k,v)=>console.log(k.padEnd(4),v);
{d().mode='delegated';d().grant=true;out('D1','delegated+grant: #701(main,S1) ok='+auth(d().prs[701]).ok+' #703(integration/70) ok='+auth(d().prs[703]).ok+' ; #701 with scope S2 ok='+(()=>{const p={...d().prs[701],scope:2};return auth(p).ok;})());}
{d().selected=701;act('merge');const op=d().prs[701].op;act('base');act('success');const p=d().prs[701];out('D2','merge sent, base advanced before receipt: merged='+p.merged+' incident='+p.incident+' op='+op.state);}
{d().selected=703;const p=d().prs[703];d().mode='manual';act('confirm');act('head');const f1=facts(p).find(x=>x.title.startsWith('已确认决定')).ok;act('apply');out('D3','decision after newHead ok='+f1+' -> after apply ok='+facts(p).find(x=>x.title.startsWith('已确认决定')).ok+' ; confirm cleared by head='+(p.confirm===null));}
{const p=d().prs[703];act('check');const r0=facts(p).find(x=>x.title.startsWith('当前候选接收')).ok;act('base');out('D4','receive judgment bound to base: before='+r0+' after base advance='+facts(p).find(x=>x.title.startsWith('当前候选接收')).ok+' ; test row='+facts(p).find(x=>x.title.startsWith('组合检查')).ok);}
{d().view='comms';act('resend');const m0={...d().message};act('message-query');out('D5','resend sentCount='+d().message.sentCount+' ; after query: message='+d().message.state+' operation='+d().message.operation);}
{const tests=JSON.parse(fs.readFileSync('test-data.json','utf8'));out('T','acceptance JSON: '+tests.length+' cases; ids '+tests[0].id+'..'+tests[tests.length-1].id+'; fields='+Object.keys(tests[0]).join(','));}
