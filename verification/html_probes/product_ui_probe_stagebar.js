const load=require('./harness2.js');
const H=load('./115a12c3.js',['s','P','stagebar','newHead','reviewFresh','testFresh','hex']);
const s=H.s(),P=H.P(),stage=H.stagebar(),hex=H.hex();
const cell=(p,i)=>{const m=[...stage(p).matchAll(/class="stage (done|now|)"/g)];return m[i][1]||'todo';};
console.log('P1   acceptance cell (merged #101): '+['accept','reject','request_evidence'].map(r=>{const p=P(101);p.acceptance={version:p.merged.sha,result:r};return r+'='+cell(p,6);}).join(' '));
{const p=P(102);p.report={version:p.head};const b=cell(p,5);H.newHead()(p);console.log('P2   report cell (#102): with report at head='+b+' ; after newHead='+cell(p,5));}
{const p=P(160);const b=s.branches.main;s.branches.main=hex('cafe0001');console.log('P10  base advance only (#160): reviewFresh='+!!H.reviewFresh()(p)+' testFresh='+!!H.testFresh()(p));s.branches.main=b;}
