// Offline design only. No network, model, live authority or server setting writes.
function govFingerprint(){return JSON.stringify({repo:s.repo,b:s.control.boundary,organization:s.control.organization,control:s.control.controlRevision,r:s.coord.intake?.revision,grant:s.grant,active:s.grantActive,base:s.branches.main});}
function govPreview(action,payload={}){
 const c=s.control,names={adopt:'采用本批目标',organization:'改变组织方式','stop-new':'停止新实施','resume-new':'恢复新实施','revoke-merge':'收回新合并','restore-merge':'恢复原合并委托','stop-batch':'停止本批投入','resume-batch':'恢复本批投入'};
 if(!Object.hasOwn(names,action))return null;
 const labels={parallel:'并行实施',serial:'等待 PR #201（A1）实际合入且证据适用，再开始 B 共享实施',unified:'统一负责人，先安全交接'};
 const scope=action==='organization'?'B 的共享实施；独立调查继续':action.includes('merge')?'当前项目的新增合并请求':action.includes('batch')?c.boundary.id:'本轮明确实施范围';
 return {action,payload:{...payload},fingerprint:govFingerprint(),title:names[action],scope,from:action==='organization'?labels[c.organization.mode]:action==='adopt'?c.boundary.state:'当前限制与有效委托',to:action==='organization'?labels[payload.mode]:names[action],source:payload.note||'尚未说明',consequence:action.includes('merge')?'已发送合并继续核查；本次不部署、不回滚、不退还已花费用。':'正在运行的工作不被直接终止，已交付成果保留。'};
}
function govApply(preview,actor='owner-ui'){
 if(!preview||preview.fingerprint!==govFingerprint())return {ok:false,reason:'对象、规则、技术安排或权限已经变化，请重新预览。'};
 return controlOwner(preview.action,preview.payload,actor);
}
function govPrecedent(record,request){
 if(record.status!=='adopted'||!record.source)return {ok:false,reason:'没有已采用原始来源'};
 if(record.revoked)return {ok:false,reason:'原决定已撤销'};
 if(record.scope!==request.scope||record.effect!==request.effect)return {ok:false,reason:'范围或后果不同，需要核对差异'};
 return {ok:true,reason:'仅说明此示例适用条件相同，仍须核当前委托，不自动授权'};
}
function govEffect(action,facts){
 if(!facts.known)return {class:'unknown',mayDelegate:false,reason:'关键触发链未知，不自动记低风险'};
 if(facts.deploy||facts.paid||facts.external||facts.data)return {class:'external-consequence',mayDelegate:false,reason:'需匹配发布／费用／数据等后果边界'};
 return {class:'contained-change',mayDelegate:false,reason:action+' 仍须核角色、对象和有效委托；可回退不是授权'};
}
function govDraw(ledger,id,p,randomValue){
 if(Object.hasOwn(ledger,id))return ledger[id];
 if(!Number.isFinite(p)||p<0||p>1||!Number.isFinite(randomValue)||randomValue<0||randomValue>=1)throw Error('invalid sampling parameters');
 return ledger[id]={selected:randomValue<p,p,observation:'not-executed'};
}
function govGovernanceState(x){return x.fileInBase&&x.serverRule&&x.identitySeparated&&x.rejectionVerified?'verified':'unverified';}
function govPage(){return pageHead('GOVERNANCE / CANDIDATE','规则怎样改变，决定怎样复用。','v2.4 候选 · 本页只演练判断，不修改 GitHub 设置。',btn('返回工作秘书','navigate','secretary','ghost'))+`<div class="control-grid"><section class="card pad"><h2>真实治理状态 ${badge('尚未核验','amber')}</h2><p class="small sub space-top">保护分两步：先要求 PR（暂不要求批准），再分离身份并要求边界审核。第一步只能约束变更路径，不能证明合并由本人执行；两步都需实际核验。</p><dl class="kv space-top"><dt>本次候选</dt><dd>规则修改通过 Draft PR</dd><dt>真实 main</dt><dd>2026-10-18 tongxu 观测未保护；非实时，管理员读取 403</dd><dt>第一步</dt><dd>PR 路径约束待核验；不证明仅本人可合并</dd><dt>第二步</dt><dd>独立身份与边界批准待核验；作者不能自批</dd><dt>首次安装</dt><dd>本人核对最终候选并记录采用；不授予后续旁路</dd><dt>启用任务</dt><dd>tongxu #10；本原型不执行管理员动作</dd></dl><div class="notice amber space-top">本页未执行 GitHub 设置。只读 W0 可继续，不等待两步全部完成。</div></section><section class="card pad"><h2>本批与判例</h2><p class="small sub space-top">Milestone 分组 → 主 Issue 的本人采用与团队约定 → 原 PR 证据。改描述或关闭分组都不是批准。</p><p class="small sub space-top">TX-DEC-001 为 proposed／待采用，不是有效授权。历史决定先核适用条件、例外和撤销；一次许可不能变成永久委托。</p>${btn('演练同类决定的适用检查','gov-precedent','','soft space-top')}<div id="gov-precedent-result" class="notice space-top">尚未检查；没有捏造的有效判例。</div></section><section class="card pad"><h2>模型变化与回放</h2><p class="small sub space-top">可观测版本／提示／工具变化 → 固定历史候选的有限回放 → 按已有策略保持或限制该角色的新高后果动作。三五个哨兵不是完整标定。</p>${btn('模拟角色版本变化','gov-version','','soft space-top')}<div id="gov-version-result" class="notice space-top">未连接真实模型；没有运行回放或增加费用。</div></section><section class="card pad"><h2>盲随机底样本</h2><p class="small sub space-top">正常放行也能抽中；先独立判断，再揭示旧结论。重复事件不重抽，未执行不算通过，风险定向检查仍保留。</p>${btn('固定输入演练一次抽签','gov-sample','','soft space-top')}<div id="gov-sample-result" class="notice space-top">固定随机值仅用于 UI 演练，不是生产随机源。</div></section></div>`;}
const priorControlConfirm=actions['control-confirm'];
actions['control-confirm']=()=>{
 const m=modal;if(m?.kind!=='control')return;
 const choice=$('#control-choice').value,action=m.action==='organization'?'organization':choice;
 const payload={note:$('#control-note').value.trim(),revision:m.revision,...(action==='organization'?{mode:choice}:{})};
 if(!payload.note)return formError('请说明本次具体安排。');
 if(m.revision!==s.control.boundary.revision)return formError('目标版本已变化。');
 const preview=govPreview(action,payload);if(!preview)return formError('未支持的动作');
 openModal('核对这一个具体变化',`<dl class="kv"><dt>动作</dt><dd>${esc(preview.title)}</dd><dt>对象与范围</dt><dd>${esc(preview.scope)}</dd><dt>旧 → 新</dt><dd>${esc(preview.from)} → ${esc(preview.to)}</dd><dt>安排依据</dt><dd>${esc(preview.source)}</dd><dt>不会发生</dt><dd>${esc(preview.consequence)}</dd></dl><div class="notice amber space-top">本次确认只对应所见版本。此处是离线本人入口演练，不代表真实认证。</div>`,footerHint('确认之前若对象变化，旧确认不再适用。',btn('返回修改','control-open',m.action,'ghost')+btn('确认并执行此变更','gov-apply','','primary')),'本人控制 / 后果预览',false,{kind:'gov-preview',preview});
};
actions['gov-apply']=()=>{const r=govApply(modal?.preview);if(!r.ok)return formError(r.reason);closeModal();render();toast('此变更已在离线演练生效；没有远端操作。','check');};
actions['gov-precedent']=()=>{$('#gov-precedent-result').textContent=govPrecedent({status:'adopted',source:'固定示例，不是真实批准',scope:'X1',effect:'offline'}, {scope:'X2',effect:'paid'}).reason+'。未产生批准或修改预算。';};
actions['gov-version']=()=>{$('#gov-version-result').textContent='模拟：接收角色配置发生变化，回放待执行；原历史结果保留，其他角色不停，未扩大任何权限。';};
const govSampleLedger={};actions['gov-sample']=()=>{const x=govDraw(govSampleLedger,'demo-candidate-1',0.1,0.04);$('#gov-sample-result').textContent=(x.selected?'此固定样例被选中':'未选中')+'；复审未执行。再次点击使用原选择，不增加统计样本。';};
actions['gov-open']=()=>navigate('governance');
actions['gov-emergency']=()=>{const r=controlOwner('revoke-merge',{note:'本人明确收回新增合并；已发送／未知操作继续核查。'});if(!r.ok)return toast(r.reason,'alert');render();toast('演练：新合并已受限；没有声称取消已发请求。','check');};
const beforeGovHome=controlHome;controlHome=function(){return beforeGovHome()+`<div class="row wrap space-top" style="margin-bottom:20px">${btn('治理、判例与模型变化','gov-open','','soft')}${btn('立即收回新合并（演练）','gov-emergency','','ghost')}<span class="tiny sub">查询和低风险联系不重批；紧急限制不等待秘书。</span></div>`;};
