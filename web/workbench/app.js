'use strict';
const key = location.hash.slice(1);
const $ = id => document.getElementById(id);
let state = null, view = 'overview', selected = null, reportNonce = 0;
const stages = { local_inspection_pending: ['本地材料待核', 'wait'], not_dispatched: ['尚未派发接收', 'neutral'], preparing: ['接收准备中', 'wait'], submitted_or_unknown: ['已登记发送，结果待核', 'wait'], historical_result: ['历史判断，当前不适用', 'neutral'], returned: ['报告已返回', ''], returned_invalid: ['执行已结束，判断无效', 'wait'], closed_unresolved: ['原结果未解决', 'wait'] };
const verdicts = { ACCEPT_WITHIN_SCOPE: '限定范围内接受', RETURN_FOR_WORK: '退回处理', INSUFFICIENT_EVIDENCE: '证据不足', INVALID_RESULT: '原输出无效，未形成接收判断' };
const eventNames = { receiver_reserved: '接收准备已登记', receiver_dispatch_registered: '原发送已登记', receiver_judgment_recorded: '完整接收判断已保存', receiver_closed_unresolved: '原操作保留未解决结果', receiver_invalid_result_recorded: '原执行已结束，完整输出无效', receiver_correction_registered: '一次有界结果纠正已登记', pair_registered: '两个任务与阶段安排已固定', pair_independent_inspection: '下游已核对独立本地材料', pair_shared_waiting: '共享接收等待上游判断', pair_shared_consumed: '下游已返回上游结果的消费引用' };
function el(tag, value, className) { const n = document.createElement(tag); if (value !== undefined && value !== null) n.textContent = String(value); if (className) n.className = className; return n; }
function append(parent, ...nodes) { nodes.filter(Boolean).forEach(n => parent.append(n)); return parent; }
function pill(text, kind = '') { return el('span', text, 'pill ' + kind); }
function subjectText(subject) { return '组合：' + subject.members.map(m => 'PR #' + m.candidate.pr + '@' + m.candidate.H.slice(0, 8)).join(' → '); }
function date(value) { if (!value || Number.isNaN(Date.parse(value))) return '未登记'; return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function statusOf(task) {
  if (!task.available) return ['来源无法读取', 'problem'];
  if (task.observationConflict) return ['材料观察有冲突', 'wait'];
  if (task.compositionCurrent === false) return ['组合成员状态待核实', 'wait'];
  if((task.collaboration?.messages||[]).some(r=>!r.available))return ['协作原件待核','wait'];
  const runs=(task.collaboration?.messages||[]).filter(r=>r.available&&r.current&&r.messages.length>0);
  if(runs.some(r=>r.messages.some(m=>m.sendRegistered&&m.state!=='Reply')))return ['协作已投入，结果待核','wait'];
  if(runs.some(r=>r.messages.some(m=>m.state!=='Reply')))return ['协作仍有待发送消息','wait'];
  if(runs.some(r=>r.resourcesSettled===false))return ['报告已返回，结算待核','wait'];
  if(runs.length)return ['协作报告已返回',''];
  const o = task.operations.filter(o => o.currentPacket).at(-1);
  if (!o) return ['尚未派发接收', 'neutral'];
  if (o.stage === 'returned') return [verdicts[o.judgment?.verdict] || '未知判断', o.judgment?.verdict === 'ACCEPT_WITHIN_SCOPE' ? '' : 'wait'];
  return stages[o.stage] || ['阶段待核', 'wait'];
}
async function api(path) {
  const response = await fetch(path, { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' });
  if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || '读取失败'); }
  return response.json();
}
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function intro(title, description, badge) { return append(el('section', null, 'intro'), append(el('div'), el('span', '同序 / 原始记录', 'eyebrow'), el('h1', title), el('p', description)), badge ? pill(badge, 'neutral') : null); }
function metric(number, label, note) { return append(el('div', null, 'metric'), el('strong', number), el('span', label), el('small', note)); }
function openTask(id) { selected = id; view = 'tasks'; render(); $('content').focus({ preventScroll: true }); }
function card(t) {
  const [label, kind] = statusOf(t), n = el('button', null, 'task-card'); n.type = 'button'; n.dataset.task = t.id; n.dataset.stage = label; n.onclick = () => openTask(t.id);
  const replies=(t.collaboration?.messages||[]).filter(r=>r.available&&r.current).flatMap(r=>r.messages).filter(m=>m.state==='Reply').length;
  append(n, append(el('div', null, 'card-top'), el('span', t.available ? t.composition ? '固定组合 · ' + t.composition.subject.members.length + ' 个成员' : 'PR #' + t.candidate.pr : '本地来源', 'pr'), pill(label, kind)), el('h3', t.title), el('p', t.available ? t.candidate.repository + ' · ' + t.candidate.targetRef : '当前来源不可用，未将空记录当作完成。', 'sub'), append(el('div', null, 'card-bottom'), el('span', t.available ? 'H ' + t.candidate.H.slice(0, 8) + ' · 接收判断 ' + t.operations.filter(o => o.judgment).length + ' · 协作回复 '+replies : t.error), el('span', '↗', 'arrow'))); return n;
}
function overview() {
  const valid = state.tasks.filter(t => t.available), allOps = valid.flatMap(t => t.operations), current = allOps.filter(o => o.currentPacket && o.stage === 'returned'), waiting = allOps.filter(o => !['returned', 'historical_result'].includes(o.stage) && (o.currentPacket || o.stage !== 'returned_invalid'));
  const messages=valid.flatMap(t=>(t.collaboration?.messages||[]).filter(r=>r.available&&r.current).flatMap(r=>r.messages)),replies=messages.filter(m=>m.state==='Reply').length,pending=messages.length-replies;
  const n = el('div'); append(n, intro(state.title, state.goal, '真实队列 · 只读'), append(el('section', null, 'metrics'), metric(state.tasks.length, '已连接任务', valid.length + ' 项当前可读取'), metric(current.length+replies, '已返回的报告', '接收 '+current.length+' · 协作回复 '+replies+'，不代表批准'), metric(waiting.length+pending, '待核 / 尚未完成', '接收 '+waiting.length+' · 消息 '+pending)), append(el('div', null, 'section-title'), el('h2', '当前任务'), el('span', '选择任务查看完整报告')));
  const cards = el('section', null, 'task-grid'); state.tasks.forEach(t => cards.append(card(t))); n.append(cards);
  append(n, append(el('section', null, 'note-card'), el('h3', '结论与限制，一起保留'), el('p', '每份报告对应原候选与原操作。旧判断、首次失败、等待和恢复不会因为后来通过而消失。发布记录中的 pending 也不自动表示仍有模型在运行。')));
  const recent = state.events.slice(-4).reverse(); if (recent.length) append(n, append(el('div', null, 'section-title'), el('h2', '最近协作'), el('span', '来自原队列事件')), timeline(recent));
  return n;
}
function fact(list, title, value, mono = false) { append(list, el('dt', title), el('dd', value, mono ? 'mono' : '')); }
function executionText(x) {
  if (!x || x.state === 'not_dispatched') return '原执行版本：尚无派发记录';
  const kind = x.executionKind === 'fixture' ? '测试夹具 · ' : '';
  return kind + (x.state === 'recorded' ? '原执行：' + x.tool + ' ' + x.version + ' · 模型 ' + x.model + ' · 会话 ' + x.session : '原执行版本：未知，原登记证据不可得或校验未通过');
}
function publicationText(p) {
  const phase = value => ({ verified: '已读回', problem: '待核 / 异常', pending: '尚无读回证明' }[value] || '未知');
  return '发布记录：评论 ' + phase(p.comment) + ' · 状态 ' + phase(p.status) + (p.status === 'verified' ? ' · 原读回值 ' + p.recordedGithubState + '（' + date(p.recordedAt) + '，本次未刷新远端）' : ' · 拟发布值 ' + p.plannedGithubState + '（不代表已发送）') + (p.materialDigest === 'historical_derived_digest_mismatch' ? ' · 保留历史摘要差异' : '');
}
function collaborationView(t) {
  const n=el('section',null,'collaboration'),c=t.collaboration;if(!c)return n;
  const total=c.coordination.length+c.messages.length+c.repairs.length;if(!total)return n;
  append(n,append(el('div',null,'section-title'),el('h3','任务协作与实际执行'),el('span','同一队列的原始记录')));
  c.coordination.slice().reverse().forEach(a=>{const box=el('div',null,'execution-card');if(!a.available){append(box,pill('安排原件待核','wait'),el('p',a.error,'small'));n.append(box);return;}
    append(box,append(el('div',null,'label-line'),el('strong','安排 '+a.revision),pill(a.current?'当前安排':'历史安排',a.current?'':'neutral')));
    a.tasks.forEach(task=>{append(box,el('p','任务 '+task.id+' · 执行角色 '+task.actor,'small'),el('p',task.dispatch==='owner_backlog'?'已按角色顺序安排；尚无联络外部原负责人的证明。':'使用独立受管上下文处理，不代表接管外部原会话。','small'));
      task.stages.forEach(s=>append(box,el('p',({investigate:'调查',implement:'实施',test:'测试',receive:'接收',merge:'合入'}[s.stage]||s.stage)+'：'+(a.current&&s.phasePrerequisitesMet?'已满足登记的技术前置':'等待前置或属于历史安排')+(s.blockers.length?' · '+s.blockers.join('；'):''),'small')));});
    a.shared.forEach(s=>append(box,el('p','共享部分 '+s.id+'：'+s.agreed+'/'+s.requiredFeedback+' 项反馈适用'+(s.conflict?' · 有分歧':'')+(s.unknown?' · 有缺失或待核反馈':''),'small')));n.append(box);
  });
  c.repairs.forEach(r=>{const box=el('div',null,'execution-card');if(!r.available){append(box,pill('修复原件待核','wait'),el('p',r.error,'small'));n.append(box);return;}
    append(box,append(el('div',null,'label-line'),el('strong','受管修复'),pill(r.phase==='returned'?'结果已返回':'原运行待核',r.phase==='returned'?'':'wait')),el('p','操作 '+r.operation.slice(0,8)+(r.currentMaterial?' · 当前材料':' · 历史材料'),'small'));
    if(r.result){const x=r.result;append(box,el('p',(x.demonstrationFixture?'明确测试场景 · ':'')+(x.actualRepairPerformed?'已发生代码修改':'未登记实际修改'),'small'),el('p',(x.beforeH||'未知').slice(0,12)+' → '+(x.afterH||'未知').slice(0,12),'mono'),el('p','实际测试：'+(x.testsPassed?'通过':'未通过或未知')+' · 独立审核：'+(x.reviewVerdict||'未取得'),'small'));}
    if(r.resources.length)append(box,el('p','原资源结果：'+(r.resources.every(x=>x.settled)?'结算凭据匹配':'仍有未结算或未知结果'),'small'));n.append(box);
  });
  c.messages.slice().reverse().forEach(run=>{const box=el('div',null,'execution-card');if(!run.available){append(box,pill('消息原件待核','wait'),el('p',run.error,'small'));n.append(box);return;}
    append(box,append(el('div',null,'label-line'),el('strong','消息运行 '+run.run.slice(0,8)),pill(run.executionKind==='fixture'?'测试夹具':'真实模型记录','neutral'),pill(run.current?'当前材料':'历史材料',run.current?'':'neutral')));
    if(run.resourcesSettled!==null)append(box,el('p','原资源结算：'+(run.resourcesSettled?'本次结果凭据匹配':'未完成，保留原认领'),'small'));
    if(!run.messages.length)append(box,el('p','尚无实际发给本任务的消息；其他任务的回复不计为本任务完成。','small'));
    run.participants.forEach(p=>append(box,el('p',p.tool+' · '+p.id+' · '+(p.started?(p.ended?(p.completeCapture?'完整捕获已核':'执行结束，捕获待核'):'执行中或结束状态未知'):'尚未启动')+(p.sessionId?' · 会话 '+p.sessionId:''),'small wrap')));
    run.messages.forEach(m=>{const row=el('div',null,'report-row'),left=el('div'),label={Held:'待发送',Unknown:'发送或结果未知',Delivered:'已送达，等待完整回复',Refused:'明确拒绝',Reply:'完整回复已登记'}[m.state]||'状态待核';append(left,el('strong',m.id+' → '+m.to),el('p',label+' · '+(m.consumptionConfirmed?'已确认消费指定材料':'消费尚未确认'),'small'));row.append(left);if(m.replyRecorded){const b=el('button','阅读完整消息','outline');b.type='button';b.onclick=()=>openMessageReport(t,run,m);row.append(b);}box.append(row);});
    if(run.continuation)append(box,el('p','另有新上下文接续记录；不能据此认定原会话已恢复。','small'));n.append(box);
  });return n;
}
function taskView() {
  if (!selected || !state.tasks.some(t => t.id === selected)) selected = state.tasks[0].id;
  const n = el('div'); n.append(intro('任务与完整报告', '查看准确候选、接收状态及报告原文。来源不可用时会明确显示缺口。'));
  const layout = el('div', null, 'task-layout'), picker = el('div', null, 'task-picker');
  state.tasks.forEach(t => { const b = el('button', t.title); b.type = 'button'; b.setAttribute('aria-pressed', String(t.id === selected)); b.append(el('small', t.available ? 'PR #' + t.candidate.pr + ' · ' + statusOf(t)[0] : '来源无法读取')); b.onclick = () => { selected = t.id; render(); }; picker.append(b); });
  const t = state.tasks.find(t => t.id === selected), panel = el('section', null, 'panel'); append(layout, picker, panel); n.append(layout);
  if (!t.available) { append(panel, el('h2', t.title), el('p', '当前来源无法读取：' + t.error, 'empty')); return n; }
  const [label, kind] = statusOf(t), head = append(el('div', null, 'panel-head'), append(el('div'), el('h2', t.title), el('p', t.candidate.repository + ' · PR #' + t.candidate.pr)), pill(label, kind)); panel.append(head);
  if (t.composition) append(panel, el('p', subjectText(t.composition.subject)), el('p', '判断对应整个固定组合；锚点 PR 用于定位，不表示任何成员单独放行。受测最终树：' + (t.composition.subject.testedTree || '未取得'), 'small'));
  const facts = el('dl', null, 'facts'); fact(facts, '登记候选 H', t.candidate.H, true); fact(facts, '固定基线 B', t.candidate.B, true); fact(facts, '真实目标', t.candidate.targetRef); fact(facts, '来源观察', date(t.sourceObservedAt)); fact(facts, '本次查看', date(t.observedAt)); fact(facts, '登记范围', t.scope.id + ' / ' + t.scope.version); panel.append(facts);
  if (/^[\w.-]+\/[\w.-]+$/.test(t.candidate.repository) && Number.isSafeInteger(t.candidate.pr)) { const a = el('a', '查看原 PR ↗'); a.href = 'https://github.com/' + t.candidate.repository + '/pull/' + t.candidate.pr; a.target = '_blank'; a.rel = 'noreferrer noopener'; panel.append(a); }
  panel.append(collaborationView(t));
  panel.append(append(el('div', null, 'section-title'), el('h3', '正式接收操作与报告'), el('span', t.operations.length + ' 条记录')));
  if (!t.operations.length) panel.append(el('p', '尚无正式接收操作记录。协作回复不自动成为接收判断。', 'small'));
  [...t.operations].reverse().forEach(o => {
    const stage = stages[o.stage] || ['阶段待核', 'wait'], text = o.judgment ? verdicts[o.judgment.verdict] || o.judgment.verdict : stage[0], row = el('div', null, 'report-row'), left = el('div');
    append(left, append(el('div', null, 'label-line'), el('strong', text), pill(o.currentPacket ? stage[0] : '历史材料', o.currentPacket ? stage[1] : 'neutral')), el('p', date(o.finishedAt || o.startedAt) + ' · 操作 ' + o.id.slice(0, 8) + ' · 材料包 ' + o.packet));
    if (o.consumedPrerequisite) left.append(el('p', '已返回准确上游报告的消费引用。', 'small'));
    left.append(el('p', executionText(o.nativeExecution), 'small'));
    if (o.subject) left.append(el('p', subjectText(o.subject) + ' · 组合判断，非逐成员放行', 'small'));
    if (o.publication) left.append(el('p', publicationText(o.publication), 'small'));
    if (o.correctionOf) left.append(el('p', '纠正原操作 ' + o.correctionOf + ' 的无效输出；原文保留。', 'small'));
    row.append(left); if (o.judgment || o.invalidOutput) { const b = el('button', o.invalidOutput ? '阅读无效原输出' : '阅读完整报告', 'outline'); b.type = 'button'; b.onclick = () => openReport(t, o); row.append(b); } panel.append(row);
  });
  const details = append(el('details'), el('summary', '已有停止状态与观察边界'));
  append(details, el('p', t.controls.length ? t.controls.map(c => ({ investment: '新增投入', implementation: '新增实施', merge: '新合并' }[c.kind] || c.kind) + '：' + (c.stopped ? '已登记停止' : '本机记录开放') + '（修订 ' + c.revision + '）').join('；') : '该任务范围没有登记停止条目。这不等于取得了额外权限。', 'small'), el('p', '本页没有改写控制或生产动作的接口。来源与测试观察来自不同时间，本次查看不刷新远端事实。', 'small')); panel.append(details); return n;
}
function timeline(events) {
  const list = el('div', null, 'timeline'); if (!events.length) return el('p', '尚无所选任务的协作记录。', 'empty');
  events.forEach(e => append(list, append(el('article', null, 'timeline-row'), el('time', date(e.observedAt)), el('span', null, 'timeline-line'), append(el('div'), el('strong', eventNames[e.kind] || '原操作事件'), el('p', e.title))))); return list;
}
function render() {
  if (!state) return;
  document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('content').replaceChildren(view === 'overview' ? overview() : view === 'tasks' ? taskView() : append(el('div'), intro('协作记录', '保留原阶段顺序。独立材料检查、等待、实际发送和返回分别登记。'), timeline([...state.events].reverse())));
}
async function refresh() {
  $('refresh').disabled = true;
  try {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('viewer_key_required');
    state = await api('/api/state'); const at = state.tasks.map(t => t.observedAt).sort().at(-1); $('observed').textContent = '本机读取 · ' + date(at);
    notice(state.tasks.some(t => !t.available) ? '部分来源无法读取；相关任务已明确标记，未用空数据或旧结论代替。' : ''); render();
  } catch (e) { notice((state ? '刷新失败，下面仍是上次读取的数据。' : '无法读取当前数据。') + (e.message === 'viewer_key_required' ? '请从本次启动生成的完整本机入口打开。' : '来源返回：' + e.message)); if (!state) $('content').replaceChildren(el('p', '尚未取得真实队列数据。', 'empty')); }
  finally { $('refresh').disabled = false; }
}
async function openReport(t, o) {
  const nonce = ++reportNonce; $('report-title').textContent = t.title + ' · 完整报告'; $('report-meta').textContent = '读取原操作…'; $('report-body').textContent = ''; $('report-raw').textContent='';$('report-original').hidden=true;$('report-original').open=false; $('report-dialog').showModal();
  try { const r = await api('/api/report/' + t.id + '/' + o.id); if (nonce !== reportNonce || !$('report-dialog').open) return; $('report-meta').textContent = (r.subject ? subjectText(r.subject) + ' · 非逐成员放行 · ' : '') + (verdicts[r.verdict] || r.verdict) + (r.judgmentId ? ' · 判断 ' + r.judgmentId : ' · 原操作 ' + r.operation) + ' · 原文 SHA256 ' + r.reportSha256 + ' · ' + executionText(r.nativeExecution); $('report-body').textContent = r.report; }
  catch (e) { if (nonce === reportNonce) $('report-body').textContent = '原报告无法读取：' + e.message; }
}
async function openMessageReport(t,run,m){
  const nonce=++reportNonce;$('report-title').textContent=t.title+' · 完整消息';$('report-meta').textContent='读取原消息…';$('report-body').textContent='';$('report-raw').textContent='';$('report-original').hidden=true;$('report-original').open=false;$('report-dialog').showModal();
  try{const r=await api('/api/message-report/'+t.id+'/'+run.run+'/'+encodeURIComponent(m.id));if(nonce!==reportNonce||!$('report-dialog').open)return;$('report-meta').textContent=(r.current?'当前材料':'历史材料')+' · '+(r.completeCapture?'完整捕获已核':'捕获尚未核实')+' · 会话 '+r.sessionId+' · 传输原文 SHA256 '+r.reportSha256;$('report-body').textContent=r.reportText;$('report-raw').textContent=r.report;$('report-original').hidden=false;}catch(e){if(nonce===reportNonce)$('report-body').textContent='原消息无法读取：'+e.message;}
}
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => { view = b.dataset.view; render(); }; });
$('close-report').onclick = () => $('report-dialog').close(); $('report-dialog').addEventListener('close', () => { reportNonce++; });
$('refresh').onclick = refresh;
document.querySelector('.skip').onclick = e => { e.preventDefault(); $('content').focus(); $('content').scrollIntoView(); };
let initial = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'; try { initial = localStorage.getItem('tongxu-view-theme') || initial; } catch {}; document.documentElement.dataset.theme = initial === 'dark' ? 'dark' : 'light';
$('theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('tongxu-view-theme', theme); } catch {} };
void refresh();
