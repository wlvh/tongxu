// Assert behavior of the GENERATED current prototype; no live API or model.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const load=require('./harness2');
const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tongxu-v21-'));
let checks=0;
function check(value,note){assert.ok(value,note);checks++;}
try{
 const html=path.join(dir,'ui.html'),js=path.join(dir,'ui.js');
 cp.execFileSync('python3',[path.join(root,'prototypes/build_product_ui.py'),'--output',html]);
 fs.writeFileSync(js,fs.readFileSync(html,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]);
 const fresh=()=>load(js,['s','P','T','S','actions','permission','applyMerge','dispatch','requirements','baseAssessed','reviewFresh','testFresh','depOK','capabilitiesFor','stagebar','hex','newHead','runReview','submitMerge','pending','checkMessage']);
 {const h=fresh(),s=h.s(),p=h.P()(102),perm=h.permission();
  check(perm(p).ok,'seed scoped delegation allowed');
  check(!perm(h.P()(151)).ok,'integration excluded');check(!perm(h.P()(150)).ok,'history scope excluded despite main target');
  p.target='other';check(!perm(p).ok,'target mismatch');p.target='main';p.scope='other';check(!perm(p).ok,'scope mismatch');p.scope='scope-40-r1';
  s.actorRole='author';check(!perm(p).ok,'role mismatch');s.actorRole='receiver';s.repo='other/repo';check(!perm(p).ok,'repo mismatch');s.repo='example/data-pipeline';
  check(!perm(p,'deploy').ok,'action mismatch');s.grant.expiresAt='2000-01-01';check(!perm(p).ok,'expired');s.grant.expiresAt='invalid';check(!perm(p).ok,'unparseable expiry');s.grant.expiresAt=null;s.grantActive=false;check(!perm(p).ok,'revoked');s.mode='confirm';check(perm(p).manual,'per-action mode independent of grant');s.mode='readonly';check(!perm(p).ok,'read only');}
 {const h=fresh(),p=h.P()(102),s=h.s();
  check(h.baseAssessed()(p),'seed review base applies');s.branches.main=h.hex()('bbbb');
  check(h.reviewFresh()(p)&&!h.baseAssessed()(p),'historical review retained, applicability not automatic');
  p.tests.base=s.branches.main;check(!h.requirements()(p).every(x=>x.ok),'rerun CI alone does not restore applicability');
  h.actions()['assess-base'](102);h.Q('#base-note').value='Checked base delta: documentation only; raw consumer evidence retained.';h.Q('#base-result').value='reuse';h.actions()['assess-base-confirm'](102);
  check(h.baseAssessed()(p),'explicit incremental decision restores applicability');
  s.branches.main=h.hex()('cccc');h.actions()['assess-base'](102);s.branches.main=h.hex()('dddd');h.actions()['assess-base-confirm'](102);check(!h.baseAssessed()(p),'stale decision dialog cannot apply');}
 {const h=fresh(),p=h.P()(102),s=h.s(),op={id:'M',target:102,candidate:{head:p.head,target:'main',tree:p.tests.tree},remoteResult:{sha:h.hex()('eeee'),tree:h.hex()('ffff'),target:'main'}};
  h.applyMerge()(op);check(!!p.merged&&p.incident,'real merge remains with evidence pending');check(!h.depOK()({type:'pr',id:102,target:'main'}),'dependent blocked');
  check(!p.history[0].text.includes('内容相同'),'mismatch not claimed equal');
  h.actions()['reconcile-evidence'](102);h.Q('#merged-result').value='verified';h.actions()['reconcile-evidence-confirm'](102);check(p.incident,'no evidence cannot clear');
  h.Q('#merged-proof').value='run/actual-tree-checked';h.Q('#merged-note').value='Checked real merged version and consumers, no adoption claimed.';h.actions()['reconcile-evidence-confirm'](102);
  check(!p.incident&&p.evidenceState==='verified-after-merge','recovery from actual evidence');check(h.depOK()({type:'pr',id:102,target:'main'}),'dependent resumes');
  check(p.mergeEvidence.expectedTree!==p.mergeEvidence.actualTree,'historical mismatch preserved');}
 {const h=fresh(),p=h.P()(102),op={id:'M',target:102,candidate:{target:'main',tree:p.tests.tree},remoteResult:{sha:h.hex()('eeee'),tree:p.tests.tree,target:'wrong'}};h.applyMerge()(op);h.actions()['reconcile-evidence'](102);h.Q('#merged-proof').value='run';h.Q('#merged-note').value='note';h.Q('#merged-result').value='verified';h.actions()['reconcile-evidence-confirm'](102);check(p.incident,'wrong target not retrospectively authorized');}
 {const h=fresh(),p=h.P()(102),op={id:'M',target:102,candidate:{target:'main',tree:p.tests.tree},remoteResult:{sha:h.hex()('eeee'),tree:p.tests.tree,target:'main'}};h.applyMerge()(op);check(!p.incident&&p.evidenceState==='matched','equal target and tree path');}
 {const h=fresh(),s=h.s(),p=h.P()(102);p.phase='accepted';s.prototype.nextMerge='advanced';h.__set('modal',{kind:'merge',id:102,head:p.head,target:p.target,scope:p.scope,base:s.branches.main,tree:p.tests.tree,manual:false});h.submitMerge()(p);h.flush();check(p.merged&&p.incident,'post-send base advance has an actual recovery path');}
 {const h=fresh(),s=h.s();h.dispatch()(52,'other','/demo/worktrees/new52');const a=h.S()(h.T()(52).owner);check(a.caps.length===0,'pre-handshake no control');h.flush();check(a.caps.includes('send')&&!a.caps.includes('pause'),'intersection of verified operations, not all capabilities');
  check(h.capabilitiesFor()('Codex',{identityVerified:true,version:'unknown',operations:['observe','send']}).length===0,'unknown version no capability');
  check(h.capabilitiesFor()('Codex',{identityVerified:false,version:'demo-codex-v1',operations:['observe']}).length===0,'unverified identity no capability');}
 {const h=fresh();check(h.dispatch()(52,'same','/demo/worktrees/../worktrees/history-source/')===false,'occupied normalized path rejected');h.checkMessage()('M2');h.flush();check(h.s().messages.find(x=>x.id==='M2').status==='delivered'&&h.s().ops.find(x=>x.id==='OP-DEMO-01').state==='confirmed','message recovery updates original operation');}
 {const h=fresh(),p=h.P()(102);h.newHead()(p);check(!h.requirements()(p).find(x=>x.id==='decisions').ok,'decision implementation expires');h.actions()['apply-decision'](102);h.flush();check(h.requirements()(p).find(x=>x.id==='decisions').ok,'decision can be revalidated without reauthorizing');}
 console.log(JSON.stringify({status:'PASS',assertions:checks,scope:'generated offline UI; DOM/timer stubs; no live system'},null,2));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
