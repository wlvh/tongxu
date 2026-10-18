// Local UI assertions only. Does not prove real model behavior or authorization.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const load=require('./harness2');
const file=process.argv[2]||path.resolve(__dirname,'../../prototypes/product_ui_prototype.html');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tongxu23-')),script=path.join(temp,'ui.js');
let checks=0;const check=(v,name)=>{assert.ok(v,name);checks++;};
try{
 fs.writeFileSync(script,fs.readFileSync(file,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]);
 const expose=['s','P','S','T','hex','controlOwner','controlGate','controlTechnical','controlOutcome','controlHandoff','controlHome','controlReviewPage','controlDecisionPage','coordCreate','coordAck','coordWriteAllowed','dispatch','permission','requirements','secretaryAllowed','secretarySend','actions','applyMerge','render'];
 const fresh=()=>load(script,expose);
 const create=h=>{h.Q('#coord-title').value='指定公司与历史财年导出 CSV';h.Q('#coord-boundary').value='A公共接口，B消费，独立验证';h.coordCreate()();};
 const adopt=h=>h.controlOwner()('adopt',{revision:1,note:'采用X1；无新费用'},'owner-ui');
 {const h=fresh(),s=h.s(),v=s.control.controlRevision;
 check(!h.controlOwner()('adopt',{revision:1,note:'我同意'},'secretary').ok,'secretary cannot sign owner adoption');
 check(s.control.boundary.state==='draft'&&s.control.controlRevision===v,'denied request leaves adoption and version untouched');
 check(!h.controlOwner()('adopt',{revision:9,note:'old'},'owner-ui').ok,'stale boundary rejected');
 check(!h.controlOwner()('adopt',{revision:1,note:''},'owner-ui').ok,'missing scope description rejected');
 check(adopt(h).ok,'owner adopts boundary');
 const source=s.control.boundary.source;
 check(h.controlTechnical()('只更新兼容的技术步骤'),'technical plan within boundary recorded');
 check(s.control.boundary.source===source&&s.control.boundary.revision===1,'technical update not another owner signature');
 check(s.control.decisions.some(x=>x.origin.startsWith('团队'))&&s.control.decisions.some(x=>x.origin.startsWith('本人')),'origins separately visible');
 check(!h.secretaryAllowed()('merge')&&!h.secretaryAllowed()('approve'),'secretary no technical or owner authority');}
 {const h=fresh(),s=h.s();create(h);['A','B','receiver'].forEach(k=>h.coordAck()(k));
 check(!h.coordWriteAllowed()(),'technical acknowledgements do not adopt new outcome');adopt(h);
 check(h.coordWriteAllowed()(),'adopted scope and technical plan permit dispatch evaluation');
 h.controlOwner()('organization',{mode:'serial',note:'B共享实施等A1'});
 check(!h.controlGate()(70).ok&&h.controlGate()(70,'investigation').ok,'serial gates shared work, independent investigation proceeds');
 const a=h.P()(201);a.merged={target:'main',sha:h.hex()('abcd')};a.incident=false;
 check(h.controlGate()(70).ok,'exact A1 dependency suffices without whole Issue closure');a.incident=true;
 check(!h.controlGate()(70).ok,'unresolved merge evidence still blocks serial gate');}
 {const h=fresh(),s=h.s();adopt(h);create(h);['A','B','receiver'].forEach(k=>h.coordAck()(k));
 h.controlOwner()('organization',{mode:'unified',note:'统一到A，先交接'});
 check(!h.dispatch()(70,'same','/demo/new'),'unified owner cannot bypass handoff');
 h.T()(70).owner='cc-B';h.S()('cc-B').state='unknown';
 check(!h.controlHandoff()('proof'),'unknown old writer cannot be taken over');h.S()('cc-B').state='idle';
 check(h.controlHandoff()('demo/run-and-remote-checked'),'explicit safe handoff evidence accepted in fixture');
 const count=Object.keys(s.sessions).length;
 check(h.dispatch()(70,'same','/demo/new')===true,'unified work joins A queue');
 check(h.T()(70).owner==='cx-A'&&Object.keys(s.sessions).length===count,'no new session for unified queue');}
 {const h=fresh(),s=h.s(),state=h.S()('cx-A').state;
 h.controlOwner()('stop-new',{note:'只停新实施'});
 check(!h.dispatch()(52,'same','/demo/new52'),'new dispatch truly blocked');check(h.S()('cx-A').state===state,'running work not killed');
 h.controlOwner()('revoke-merge',{note:'只撤新合并'});h.controlOwner()('resume-new',{note:'恢复实施，不还合并权'});
 check(h.controlGate()(52).ok&&!h.permission()(h.P()(102)).ok,'resume execution does not restore merge');
 const op={id:'already-sent',target:102,candidate:{target:'main',tree:h.P()(102).tests.tree},remoteResult:{sha:h.hex()('abc'),tree:h.P()(102).tests.tree,target:'main'}};
 h.applyMerge()(op);check(!!h.P()(102).merged,'already sent merge can be reconciled after revocation');
 check(s.control.stopMerge,'reconciliation does not reauthorize future merges');
 h.controlOwner()('restore-merge',{note:'明确恢复原示例委托'});check(!s.control.stopMerge,'explicit restore allowed without scope expansion');}
 {const h=fresh(),s=h.s();adopt(h);h.controlOwner()('stop-batch',{note:'停止X1新投入'});
 check(!h.controlGate()(70).ok&&h.controlGate()(52).ok,'batch stop is scoped');
 check(h.controlGate()(70,'investigation').ok,'inspection of stopped result still available');
 h.controlOwner()('resume-batch',{note:'恢复原范围'});check(h.controlGate()(70).ok,'batch can resume within original boundary');}
 {const h=fresh(),s=h.s(),grant=JSON.stringify(s.grant),rev=s.control.controlRevision;
 const row={id:'J1',candidate:'H1B1',judgment:'PASS',evidence:'original-run',taskClass:'shared-interface',modelVersion:'fixture-v1',promptVersion:'review@1',observedAt:'sample-window',result:'escaped'};
 check(!h.controlOutcome()({...row,evidence:''}),'outcome missing original evidence rejected');
 check(h.controlOutcome()(row)&&!h.controlOutcome()(row),'duplicate observations not double counted');
 check(h.controlOutcome()({...row,id:'J2',result:'unknown'}),'unobserved outcome retained');
 check(JSON.stringify(s.grant)===grant&&s.control.controlRevision===rev,'score does not grant authority');
 check(h.controlReviewPage()().includes('不支持估计长期准确率'),'small samples not a precise accuracy score');}
 {const h=fresh(),s=h.s();s.coord.secretaryOnline=false;
 check(h.controlOwner()('stop-new',{note:'直接按钮生效'}).ok,'owner control works with secretary offline');
 const n=s.control.decisions.length;h.secretarySend()('收回控制');check(s.control.decisions.length===n,'offline secretary does not act');
 check(h.controlHome()().includes('团队可调整的技术约定'),'home separates human boundary and technical plan');
 check(h.controlDecisionPage()().includes('本人明确决定'),'decision provenance exposed');
 h.actions()['control-drift']();h.actions()['control-drift']();check(s.control.drift.length===1,'repeat drift request deduplicated');
 check(h.controlReviewPage()().includes('尚无本轮已接受成果'),'missing historical baseline not invented');}
 console.log(JSON.stringify({status:'PASS',assertions:checks,scope:'offline v2.3 UI; DOM/timer fixtures; no live authorization, agents or GitHub'},null,2));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
