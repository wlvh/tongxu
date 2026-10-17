#!/usr/bin/env python3
"""Build the current standalone prototype from the frozen visual template.

No network, runtime loader, or production service. Exact replacements fail if
this reviewed template changes. W7 retires this prototype builder, not the
behavioral acceptance requirements. Output is generated, not a second source.
"""
from pathlib import Path
import argparse
import hashlib

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'archive/product_ui_v2.html'
SOURCE_BLOB = 'f1c49f7c663b845c9dc59deb5b8a16a01904f467'


def build() -> str:
    data = SOURCE.read_bytes()
    blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if blob != SOURCE_BLOB:
        raise ValueError('Frozen prototype changed: inspect before rebuilding')
    text = data.decode('utf-8')

    def once(old: str, new: str) -> None:
        nonlocal text
        if text.count(old) != 1:
            raise ValueError('Replacement must match exactly once: ' + old[:90])
        text = text.replace(old, new, 1)

    def function(name: str, new: str) -> None:
        nonlocal text
        start = text.index('function ' + name + '(')
        end = text.index('\nfunction ', start + 1)
        text = text[:start] + new.strip() + '\n' + text[end:]

    once("const STORE='tongxu-product-ui-20261017-v3-01';", "const STORE='tongxu-product-ui-20261017-v21';")
    once('schema:3,page:', 'schema:4,page:')
    once('raw?.schema===3', 'raw?.schema===4')
    once('grantActive:true,slots:2,', """grantActive:true,repo:'example/data-pipeline',actorRole:'receiver',
 grant:{id:'TX-AUTH-01',source:'示例 Issue #40 / 技术接收委托',verified:true,repo:'example/data-pipeline',role:'receiver',targets:['main'],scopes:['scope-40-r1','scope-60-r1'],actions:['merge'],expiresAt:null,limits:'无新增调用、费用、部署、采纳或清理'},
 capabilityProfiles:{'Codex':{version:'demo-codex-v1',operations:['observe','send','resume']},'Claude Code':{version:'demo-claude-v1',operations:['observe','send']}},slots:2,""")
    once("review:{head,scope,verdict:'PASS'", "review:{id:'SEED-REVIEW-'+id,head,scope,target,base:branches[target],verdict:'PASS'")
    once("scope:'scope-50-r1',verdict:'OWNER_DECISION_REQUIRED'", "scope:'scope-50-r1',id:'SEED-REVIEW-151',target:'integration/50',base:branches['integration/50'],verdict:'OWNER_DECISION_REQUIRED'")
    once("scope:'scope-60-r1',verdict:'REWORK_REQUIRED'", "scope:'scope-60-r1',id:'SEED-REVIEW-160',target:'main',base:branches.main,verdict:'REWORK_REQUIRED'")
    function('permission', """
function permission(p,action='merge'){
 if(s.mode==='readonly')return {ok:false,label:'只读模式',detail:'只查看材料，不执行发布或合入。'};
 if(s.mode==='confirm')return {ok:true,manual:true,label:'逐次确认',detail:'在本人入口确认候选、目标与方法；正式记录可恢复，不限定 GitHub approval。'};
 const g=s.grant,deny=detail=>({ok:false,label:'不在有效委托内',detail});
 if(s.mode!=='delegated')return deny('未知授权模式，不发送新动作。');
 if(!s.grantActive)return deny('委托已撤销；已发送请求仍须核查。');
 if(!g?.verified||!g.id||!g.source)return deny('委托来源尚未核实。');
 if(g.repo!==s.repo||g.role!==s.actorRole)return deny('仓库或执行角色与委托不一致。');
 if(!g.actions?.includes(action)||!g.targets?.includes(p.target)||!g.scopes?.includes(p.scope))return deny('本次动作、目标或采用范围没有被 TX-AUTH-01 覆盖。可查看边界或采用本人逐次确认，不能扩大旧委托。');
 if(g.expiresAt!==null&&(!Number.isFinite(Date.parse(g.expiresAt))||Date.parse(g.expiresAt)<=Date.now()))return deny('委托已到期或时效无法确认。');
 return {ok:true,manual:false,label:'有限委托',detail:g.id+' · '+p.scope+' → '+p.target+'；'+g.limits};
}
function baseAssessed(p){
 if(!reviewFresh(p))return false;
 if(p.review.target!==p.target)return false;
 if(p.review.base===s.branches[p.target])return true;
 const b=p.baseAssessment;
 return !!b&&b.result==='reuse'&&b.head===p.head&&b.scope===p.scope&&b.target===p.target&&b.base===s.branches[p.target]&&b.reviewId===p.review.id;
}
function capabilitiesFor(engine,receipt){
 const profile=s.capabilityProfiles?.[engine];
 if(!receipt?.identityVerified||!profile||receipt.version!==profile.version)return [];
 return profile.operations.filter(op=>receipt.operations.includes(op));
}
""")
    once("p.review.scope===p.scope;}", "p.review.scope===p.scope&&p.review.target===p.target;}")
    once("return !!q?.merged&&q.merged.target===dep.target;", "return !!q?.merged&&!q.incident&&q.merged.target===dep.target;")
    once("return !!t?.pr&&!!P(t.pr)?.merged;", "return !!t?.pr&&!!P(t.pr)?.merged&&!P(t.pr).incident;")
    once("const checks=[\n {id:'target'", "const checks=[\n {id:'base-impact',title:'当前目标增量已经判断',ok:baseAssessed(p),detail:baseAssessed(p)?'原审核对应当前目标，或已记录增量复核及证据复用理由':'原审核作为历史保留；接收者需判断目标增量，不自动重审所有 PR，也不只靠 CI 变绿放行'},\n {id:'target'")
    once("function checkAction(p,c){", "function checkAction(p,c){if(c.id==='base-impact')return btn('核对增量','assess-base',p.id,'ghost sm');")
    once("function labelFor(p){if(p.merged)", "function labelFor(p){if(p.merged&&p.incident)return ['已合入，证据待核','amber'];if(p.merged)")
    once("function nextStep(p){if(p.merged)", "function nextStep(p){if(p.merged&&p.incident)return '接收者核对实际合入对象并补实际树证据；仅暂停依赖该证据的推进，不再次合并或自动回滚';if(p.merged)")
    once("if(p.merged)actions=btn('技术解读','report',p.id)+btn('用户验收','acceptance',p.id,'primary');", "if(p.merged)actions=p.incident?btn('核对实际合入证据','reconcile-evidence',p.id,'primary'):btn('技术解读','report',p.id)+btn('用户验收','acceptance',p.id,'primary');")
    once("<h3>${p.merged?'本次合入已确认':esc(labelFor(p)[0])}</h3>", "<h3>${esc(labelFor(p)[0])}</h3>")
    once("p.acceptance?.version===version&&p.acceptance.result==='accept'];", "!p.incident&&p.acceptance?.version===version&&p.acceptance.result==='accept'];")
    once("op.head=p.head;op.scope=p.scope;op.result=", "op.head=p.head;op.scope=p.scope;op.base=s.branches[p.target];op.targetRef=p.target;op.result=")
    once("const review={head:op.head,scope:op.scope,verdict:", "const review={id:op.id,head:op.head,scope:op.scope,base:op.base,target:op.targetRef,verdict:")
    once("if(p.head===op.head&&p.scope===op.scope){p.review=review;", "if(p.head===op.head&&p.scope===op.scope&&p.target===op.targetRef){p.review=review;")
    once("a.caps=['observe','send','pause','resume'];a.event=", "a.handshake={identityVerified:true,version:en==='Codex'?'demo-codex-v1':'demo-claude-v1',operations:['observe','send','pause','resume']};a.caps=capabilitiesFor(en,a.handshake);a.event=")
    once("const lost=s.prototype.nextMerge==='lost';", "const lost=s.prototype.nextMerge==='lost',advanced=s.prototype.nextMerge==='advanced';")
    once("op.remoteResult={sha:hex('f'+p.id.toString(16)+(++s.seq).toString(16)),tree:op.candidate.tree,target:op.candidate.target,at:time()};", "if(advanced)s.branches[op.candidate.target]=hex('ba5e'+(++s.seq).toString(16));const actualBase=s.branches[op.candidate.target];op.remoteResult={sha:hex('f'+p.id.toString(16)+(++s.seq).toString(16)),base:actualBase,tree:actualBase===op.candidate.base?op.candidate.tree:hex('ac7'+(++s.seq).toString(16)),target:op.candidate.target,at:time()};")
    function('applyMerge', """
function applyMerge(op){
 const p=P(op.target),r=op.remoteResult;
 if(!r?.sha||!r.target){finish(op,'原合入结果还不足以确认，保留未知。','unknown');return;}
 if(p.merged){finish(op,'已核对同一原合入事实，未再次发送。');return;}
 p.merged={...r};p.phase='merged';p.draft=false;
 p.mergeEvidence={expectedTree:op.candidate.tree,actualTree:r.tree||null,expectedTarget:op.candidate.target,actualTarget:r.target,operation:op.id};
 p.incident=!r.tree||r.tree!==op.candidate.tree||r.target!==op.candidate.target;
 p.evidenceState=p.incident?'pending':'matched';
 s.branches[r.target]=r.sha;
 for(const q of Object.values(s.prs))if(q.source===r.target&&!q.merged){q.head=r.sha;q.recordHead=null;history(q,'集成分支有新内容','收到 PR #'+p.id+'；父候选需重新核对。','version');}
 finish(op,'已读回 PR #'+p.id+' 合入 '+r.target+'@'+short(r.sha)+'；这是远端结果，不代表证据必然适用。');
 history(p,p.incident?'已合入，证据待核':'实际合入结果已确认',p.incident?'受测树 '+short(op.candidate.tree)+' 与实际树 '+short(r.tree)+' 或目标不一致；保留已合入事实，暂停依赖证据的推进。':'已比较受测树与实际树，内容相同；仍不证明业务采纳。','merge');
 toast(p.incident?'已合入，但证据待核；没有自动回滚。':'已确认实际内容；用户验收仍独立。',p.incident?'alert':'check');
}
""")
    once("<p>对象：本项目明确范围的技术交付；目标：已采用的 main 或指定集成分支。</p>", "<p>仓库：${esc(s.grant.repo)} · 角色：${esc(s.grant.role)}<br>目标：${esc(s.grant.targets.join('、'))}<br>范围：${esc(s.grant.scopes.join('、'))}<br>来源：${esc(s.grant.source)}<br>到期：${esc(s.grant.expiresAt||'无固定到期；可随时撤销')}</p><p>历史 integration/50 和 scope-50 不在该示例委托内。逐次确认可保留在同序本人入口，不强制跳到 GitHub review。</p>")
    once("</option></select></label><label class=\"field\"><span>下一次验证结果", "</option><option value=\"advanced\" ${s.prototype.nextMerge==='advanced'?'selected':''}>发出后目标前进 · 合入证据待核</option></select></label><label class=\"field\"><span>下一次验证结果")
    once("const actions={", """const actions={
 'assess-base':id=>{const p=P(+id);if(!reviewFresh(p))return toast('先取得当前 head、范围和目标的审核。','alert');openModal('核对当前目标增量',`<div class="notice amber">历史审核不丢弃；本次只记录实际判断，不按 patch 或 CI 自动免审。</div><p class="small sub space-top">原目标 ${short(p.review.base)} → 当前 ${short(s.branches[p.target])}</p><label class="field space-top"><span>判断</span><select id="base-result"><option value="reuse">差异已核对，原调查仍适用</option><option value="recheck">影响尚未排除，补受影响检查</option></select></label><label class="field"><span>检查了哪些变化，复用或补查什么证据</span><textarea id="base-note"></textarea></label>`,footerHint('这是接收者的有范围判断，不是 Owner 重新批准。',btn('记录增量判断','assess-base-confirm',p.id,'primary')),'证据 / 适用性',false,{kind:'base-assessment',id:p.id,head:p.head,scope:p.scope,target:p.target,base:s.branches[p.target],reviewId:p.review.id});},
 'assess-base-confirm':id=>{const p=P(+id),m=modal;if(!canRecord())return;if(m?.kind!=='base-assessment'||m.id!==p.id||m.head!==p.head||m.scope!==p.scope||m.target!==p.target||m.base!==s.branches[p.target]||m.reviewId!==p.review?.id)return formError('候选或原审核已变化，请核对新对象。');const note=$('#base-note').value.trim();if(!note)return formError('必须说明差异与证据，不能只选通过。');p.baseAssessment={...m,result:$('#base-result').value,note,at:time()};if(p.baseAssessment.result==='recheck')p.phase='receiving';history(p,'目标增量判断',p.baseAssessment.result+' · '+note,'evidence');closeModal();render();},
 'reconcile-evidence':id=>{const p=P(+id);if(!p.merged||!p.incident)return;openModal('核对实际合入版本的证据',`<div class="notice amber">已合入事实保留；不再次合并、不自动回滚。原受测树 ${short(p.mergeEvidence.expectedTree)}，实际树 ${short(p.merged.tree)}。</div><p class="small sub space-top">${esc(p.merged.target)}@${short(p.merged.sha)}</p><label class="field space-top"><span>实际版本上的原始证据引用（示例）</span><input id="merged-proof" placeholder="固定报告／运行记录"></label><label class="field"><span>核对范围、实际结果和剩余限制</span><textarea id="merged-note"></textarea></label><label class="field"><span>结果</span><select id="merged-result"><option value="pending">仍待核对</option><option value="verified">实际树的必要检查已通过</option></select></label>`,footerHint('错误目标不由补测试追认，需责任人另行处置。',btn('记录核对结果','reconcile-evidence-confirm',p.id,'primary')),'合入结果 / 恢复',false,{kind:'merged-evidence',id:p.id,sha:p.merged.sha,tree:p.merged.tree,target:p.merged.target});},
 'reconcile-evidence-confirm':id=>{const p=P(+id),m=modal;if(!canRecord())return;if(m?.kind!=='merged-evidence'||m.id!==p.id||m.sha!==p.merged?.sha||m.tree!==p.merged?.tree||m.target!==p.merged?.target)return formError('实际版本已变化。');const proof=$('#merged-proof').value.trim(),note=$('#merged-note').value.trim(),result=$('#merged-result').value;if(result==='verified'&&(!proof||!note||!p.merged.tree))return formError('缺少实际树的证据或核对说明。');if(result==='verified'&&p.merged.target!==p.mergeEvidence.expectedTarget)return formError('实际目标不符，不能用补测试追认目标。');p.evidenceResolution={...m,proof,note,result,at:time()};p.incident=result!=='verified';p.evidenceState=p.incident?'pending':'verified-after-merge';history(p,p.incident?'实际合入证据仍待核':'实际合入版本已补证据',proof+' · '+note,'evidence');closeModal();render();},
""")
    once("'acceptance-confirm':id=>{const p=P(+id),version=", "'acceptance-confirm':id=>{const p=P(+id);if(p.incident)return formError('先核对实际合入证据，再登记通过。');const version=")
    once('function nextOwner(p){', "function nextOwner(p){if(p.merged&&p.incident)return ['接收角色','核对实际合入证据'];")
    once('<section class="next-step"><div class="up">NEXT /', """<section class="next-step" style="${p.incident?'background:var(--amber-soft)':''}"><div class="up">NEXT /""")
    once('合入前需要成立的事实</h3>', "${p.merged?'合入前证据（历史快照）':'合入前需要成立的事实'}</h3>")
    once("function checkAction(p,c){if(c.id==='base-impact')", "function checkAction(p,c){if(p.merged)return '';if(c.id==='base-impact')")
    # A stale open reception dialog must not accept a new base/scope silently.
    once("{kind:'verdict',id:p.id,head:p.head}", "{kind:'verdict',id:p.id,head:p.head,scope:p.scope,target:p.target,base:s.branches[p.target]}")
    once("if(!modal||modal.head!==p.head)return formError('当前候选已变化，原结论不能直接覆盖。');", "if(!modal||modal.head!==p.head||modal.scope!==p.scope||modal.target!==p.target||modal.base!==s.branches[p.target])return formError('当前候选已变化，原结论不能直接覆盖。');")
    once("p.reception={head:p.head,scope:p.scope,result:v", "p.reception={head:p.head,scope:p.scope,target:p.target,base:s.branches[p.target],reviewId:p.review?.id,result:v")
    once('<title>同序 · 工作台</title>', '<title>同序 · 工作台 v2.1</title>')
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'product_ui_prototype.html')
    args = parser.parse_args()
    if args.output.resolve() == SOURCE.resolve():
        parser.error('Cannot overwrite frozen template')
    output = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output, encoding='utf-8')
    print(f'{args.output} ({len(output.encode("utf-8"))} bytes)')


if __name__ == '__main__':
    main()
