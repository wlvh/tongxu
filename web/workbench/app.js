'use strict';
function taskSourceLabel(t) { if(t.candidate.kind !== 'development-task')return 'PR #' + t.candidate.pr;const links=(t.developmentTask?.candidateLinks||[]).filter(l=>l.current);return links.length===1?'开发任务 · PR #'+links[0].pr:links.length>1?'开发任务 · 多个候选待选择':'开发任务 · 尚无当前 PR 关联'; }
const key = location.hash.slice(1);
const $ = id => document.getElementById(id);
let state = null, view = 'overview', selected = null, reportNonce = 0,controlRefresh=null;
const pendingControls=new Set();
const pendingScopeControls=new Set();
const pendingOutcomes=new Set(),outcomeDrafts=new Map(),outcomeComments=new Map();
const ownerDrafts=new Map(),ownerSources=new Map(),pendingOwner=new Set();
const pendingOrganization=new Set();
const pendingOverall=new Set();
const outcomeLabels={accepted:'接受成果',rejected:'退回处理',needs_evidence:'补充证据',stopped:'停止后续投入'};
const taskControlPhases={not_registered:'尚未登记',queued:'已登记，待处理',prepared:'已准备，待发送',waiting:'等待前置',active_or_unknown:'正在执行或状态待核',unresolved:'原结果待恢复',returned:'完整回复已保存',cancelled:'未发送请求已撤回',interrupted:'已观察到中断，原请求未完成',interrupted_closed:'中断结果已保留，原请求已结束'};
const readableReason=value=>({native_resume_scope_or_capture_changed:'原会话的范围或捕获引用不再匹配，本次未改用新会话。',native_resume_original_resources_unsettled:'原运行的资源结果仍待核实，暂不开始新输入。',native_resume_history_changed_or_active:'原生会话历史变化或仍在运行，不能据旧记录续接。',native_resume_original_process_or_binding_changed:'原进程或原会话绑定尚未核清，不能续接。',overall_native_execution_started_or_unknown:'已有模型输入或原捕获尚未核清，不能按未发送任务关闭。',overall_native_process_active_or_unknown:'原执行进程仍在运行或状态未知，先查原运行。',overall_exact_resource_set_required:'复盘的资源引用与原授权不一致，修正配置后可继续原请求。',overall_original_action_is_fixed:'该授权已绑定原复盘请求，不能换成另一份计划。',overall_selected_plan_changed:'启动时选定的复盘清单已变化，本次没有改用新清单。',coordination_exact_previous_revision_required:'组织安排已被另一入口更新，请刷新后核对。',coordination_task_candidate_or_material_changed:'任务候选或材料已更新，需要按当前证据重新登记安排。',local_scope_control_revision_changed:'控制状态已被其它入口更新，请核对刷新后的修订。',local_scope_control_scope_changed:'范围定义已改变，旧配置不能继续操作。',local_scope_control_adopted_version_changed:'本人已采用新的范围版本，旧范围记录不能继续操作。',verified_owner_stop_requires_verified_resume:'这是已验证的本人停止，必须按原来源恢复。',new_investment_stopped:'本范围已停止新增投入。',owner_action_stopped:'原本人控制已停止该动作。',task_controller_history_bound:'原诊断历史已达到上限，需保留历史后由负责人处理。',task_execution_incomplete:'原执行未取得完整结果，请核对原运行。',task_prepared_file_changed:'已准备的输入文件发生变化，原请求保留并等待核实。',task_or_candidate_packet_changed:'任务、候选或观察方式已更新，这条关联仅作历史保留。',task_link_staged_selected_changes:'选定文件的暂存内容已变化。',task_link_selected_mode_changed:'选定文件的所有者执行位已变化。',task_control_candidate_changed:'任务材料已变化，请核对后更新联系请求。',task_original_execution_active_or_unknown:'原执行已开始或尚未查清，不能当作未发送请求撤回。',task_original_resource_investment_must_be_resolved:'原资源投入仍须核实，不能直接撤回。',task_request_not_queued:'请求尚未登记，没有可撤回的待办。',task_request_cancelled:'该请求已撤回，原记录保留。',task_original_responsibility_pending:'原负责人还有未完成或未知的执行，后续请求等待。'}[value]||value);
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
  const closed=new Set((task.developmentTask?.inbox||[]).filter(r=>r.phase==='interrupted_closed').map(r=>r.run));
  const runs=(task.collaboration?.messages||[]).filter(r=>r.available&&r.current&&r.messages.length>0&&!closed.has(r.run));
  if(runs.some(r=>r.messages.some(m=>m.sendRegistered&&m.state!=='Reply')))return ['协作已投入，结果待核','wait'];
  if(runs.some(r=>r.messages.some(m=>m.state!=='Reply'&&!m.continuedIn)))return ['协作仍有待发送消息','wait'];
  if(runs.some(r=>r.resourcesSettled===false))return ['报告已返回，结算待核','wait'];
  const inboxPending=(task.developmentTask?.inbox||[]).filter(r=>!['returned','cancelled','interrupted_closed'].includes(r.phase));
  if(inboxPending.some(r=>['active_or_unknown','unresolved'].includes(r.phase)))return ['负责人原执行待核','wait'];
  if(inboxPending.length)return ['负责人待办尚未完成','wait'];
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
async function taskControl(id,action){
  if(pendingControls.has(id))return;pendingControls.add(id);render();
  try{const response=await fetch('/api/task-control/'+encodeURIComponent(id)+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}',cache:'no-store'}),result=await response.json();if(!response.ok){const message=readableReason(result.error||'操作未完成')+(result.diagnosticRecorded===false?' 本次诊断未保存：'+readableReason(result.diagnosticError)+'；历史记录不代表这次返回。':'');await refresh();throw new Error(message);}await refresh();notice(action==='start'?'已核对原请求；登记、实际送达和完整回复请以下方原记录为准。':action==='close-interrupted'?'原中断结果已保留；后续请求可由原负责人按原授权继续，当前请求仍未完成。':'未发送待办已撤回。原记录保留；这不表示终止了已执行进程。');}
  catch(e){notice('操作未完成：'+readableReason(e.message));}
  finally{pendingControls.delete(id);render();}
}
function contactControls(t){
  const list=(state.taskControls||[]).filter(c=>c.source===t.id);if(!list.length)return null;const investmentStopped=t.controls.some(c=>c.kind==='investment'&&c.stopped);const panel=el('section',null,'note-card');append(panel,el('h3','联系任务负责人'),el('p','只发送启动时已固定的联系材料。沿用原负责人待办、工具限制与授权；关闭页面不会停止已发出的任务。','small'));
  if(investmentStopped)panel.append(el('p','本范围已停止新增投入；恢复并满足原授权后才能联系。','small'));for(const c of list){const row=el('div',null,'report-row contact-row'),left=el('div');append(left,el('strong',c.title),el('p',c.available?(c.controllerActive?'本机正在处理 · ':'')+(taskControlPhases[c.phase]||'状态待核')+(c.executionKind==='fixture'?' · 明确测试夹具':''):'来源不可用','small'));if(c.nativeResumeRequested)left.append(el('p',c.nativeSessionResumed?'执行器已核对并接回原会话；问题是否完成以原消息记录为准。':'请求明确选择原会话；原进程、捕获或历史未核清时拒绝，不自动新建替代会话。','small'));if(c.reason)left.append(el('p',readableReason(c.reason),'small'));if(c.available&&!c.currentMaterial)left.append(el('p','对应材料已变化，原请求保留。','small'));const d=c.lastControllerReturn;if(d)append(left,el('p','最近入口记录 · '+date(d.recordedAt)+'：'+(d.completed?'执行器已返回'+(d.resourcesSettled===false?'，原资源结果待核':''):readableReason(d.reason||'task_execution_incomplete')),'small'),el('p','这条记录说明入口返回了什么；不替代上方原消息是否送达、完成或未知的状态。','small'));if(c.unsavedControllerReturn)append(left,el('p','最新入口诊断未保存：'+readableReason(c.unsavedControllerReturn.reason)+' '+readableReason(c.unsavedControllerReturn.diagnosticError)+' 此提示仅保留在当前服务中。','small'));row.append(left);const actions=el('div',null,'actions'),start=el('button',c.phase==='returned'?'已取得完整回复':c.nativeResumeRequested?'继续原会话':'联系负责人','outline');start.type='button';start.disabled=investmentStopped||!c.available||!c.currentMaterial||c.controllerActive||pendingControls.has(c.id)||['returned','cancelled','active_or_unknown','unresolved','interrupted','interrupted_closed'].includes(c.phase);start.onclick=()=>taskControl(c.id,'start');actions.append(start);if(c.available&&['queued','prepared','waiting'].includes(c.phase)){const cancel=el('button','撤回未发送请求','quiet');cancel.type='button';cancel.disabled=pendingControls.has(c.id);cancel.onclick=()=>taskControl(c.id,'cancel');actions.append(cancel);}if(c.available&&c.phase==='interrupted'&&!c.controllerActive){const close=el('button','保留中断结果并结束此请求','quiet');close.type='button';close.disabled=pendingControls.has(c.id);close.onclick=()=>taskControl(c.id,'close-interrupted');actions.append(close);}row.append(actions);panel.append(row);const native=nativeControlPanel(c,investmentStopped);if(native)panel.append(native);}
  return panel;
}
async function controlNative(c,option){
  const n=c.nativeControl;if(!n?.currentTurnActive||pendingControls.has(c.id))return;pendingControls.add(c.id);render();
  try{const response=await fetch('/api/task-control/'+encodeURIComponent(c.id)+'/native',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({option:option.id,threadId:n.threadId,sessionId:n.sessionId,turnId:n.turnId}),cache:'no-store'}),result=await response.json();if(!response.ok)throw new Error(result.error||'会话操作未完成');await refresh();notice(result.duplicate?'已读取原控制记录，没有再次发送。':option.action==='interrupt'?'中断请求已确认。是否终止和原结果以下方捕获记录为准。':'补充问题已发送到所示轮次；完整回复还须确认实际处理了该补充。');}
  catch(e){await refresh();notice('会话控制未完成：'+readableReason(e.message));}finally{pendingControls.delete(c.id);render();}
}
function nativeControlPanel(c,investmentStopped){
  if(!c.nativeControl&&!(c.nativeControlHistory||[]).length)return null;const box=el('div',null,'note-card'),n=c.nativeControl;
  append(box,el('h4','当前会话控制'),el('p','仅控制此入口实际拥有的轮次。补充内容由原任务固定；暂停和外部会话接管不可用。','small'));
  if(n?.currentTurnActive){append(box,el('p',(n.nativeSessionResumed?'实际续接原会话 ':'实际会话 ')+n.sessionId+' · 轮次 '+n.turnId,'small'));for(const option of n.options){const row=el('div',null,'report-row'),label=el('div');append(label,el('strong',option.title),option.text?el('p',option.text,'small'):el('p','只请求中断已有执行，不启动下一轮。','small'));const button=el('button',option.action==='interrupt'?'中断当前轮次':'发送补充问题','outline');button.type='button';button.disabled=pendingControls.has(c.id)||option.action==='steer'&&(investmentStopped||!c.currentMaterial);button.onclick=()=>controlNative(c,option);append(row,label,button);box.append(row);}}
  else box.append(el('p','当前页面没有可控制的活跃轮次。历史会话 ID 不授予控制权限。','small'));
  for(const h of c.nativeControlHistory||[])box.append(el('p',(h.request.action==='interrupt'?'中断':'补充')+' · '+(h.acknowledged?'执行器已确认':'发送已登记，回执待核')+' · '+(h.turnTerminationVerified?'该轮终态已核实':'终态尚未核实'),'small'));
  return box;
}
async function setScopeControl(c,value){if(pendingScopeControls.has(c.id))return;pendingScopeControls.add(c.id);render();try{const response=await fetch('/api/scope-control/'+encodeURIComponent(c.id)+'/'+value,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({revision:c.revision}),cache:'no-store'}),result=await response.json();if(!response.ok)throw new Error(result.error||'范围控制未完成');await refresh();notice(result.duplicate?'已读回原控制回执；当前状态以下方最新记录为准。':'本机控制已登记并读回。已发操作、权限与资源记录继续保留。');}catch(e){await refresh();notice('控制未改变：'+readableReason(e.message));}finally{pendingScopeControls.delete(c.id);render();}}
function scopeControlPanel(t){const entries=(state.scopeControls||[]).filter(c=>c.source===t.id);if(!entries.length)return null;const panel=el('section',null,'note-card');append(panel,el('h3','本范围的停止与恢复'),el('p','影响本范围的相关任务。恢复只解除本机停止，原授权、用量和资源仍逐项检查；不终止已经发出的执行。','small'));for(const c of entries){const row=el('div',null,'report-row'),left=el('div');append(left,el('strong',c.title),el('p',c.available?'范围 '+c.scopeId+' / '+c.scopeVersion+' · 修订 '+c.revision:'范围来源待核','small'));if(!c.available)left.append(el('p',readableReason(c.reason),'small'));else{append(left,el('p',c.verifiedOwnerStop?'原记录为已验证本人停止，需按原来源恢复。':c.recorded?(c.state==='stopped'?'本机已登记停止。':'本机已登记开放，原权限仍须成立。'):'尚未登记本机停止；不等于获得额外权限。','small'));const buttons=el('div',null,'actions'),stop=el('button','停止','outline'),resume=el('button','恢复','quiet');stop.type=resume.type='button';stop.disabled=c.state==='stopped'||pendingScopeControls.has(c.id);resume.disabled=c.state!=='stopped'||c.verifiedOwnerStop||pendingScopeControls.has(c.id);stop.onclick=()=>setScopeControl(c,'stopped');resume.onclick=()=>setScopeControl(c,'open');append(buttons,stop,resume);row.append(buttons);}row.prepend(left);panel.append(row);}return panel;}
function intro(title, description, badge) { return append(el('section', null, 'intro'), append(el('div'), el('span', '同序 / 原始记录', 'eyebrow'), el('h1', title), el('p', description)), badge ? pill(badge, 'neutral') : null); }
const organizationModes={parallel:'并行推进',stage_serial:'按阶段串行',unified_owner:'统一负责人'};
const organizationStages={investigate:'调查',implement:'实施',receive:'接收',publish:'发布',enable:'启用'};
async function applyOrganization(group,choice){
  if(pendingOrganization.has(group.id))return;pendingOrganization.add(group.id);render();
  try{const response=await fetch('/api/organization/'+encodeURIComponent(group.id)+'/apply',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({choice:choice.id,expectedPrevious:group.expectedPrevious}),cache:'no-store'}),result=await response.json();if(!response.ok)throw new Error(result.error||'组织安排未登记');await refresh();notice(result.duplicate?'已读回原安排；没有重新登记，也没有启动任务。':'安排已登记到原任务记录。实际派发、写权交接和共享前置仍须满足，不会因登记而自动获得权限。');}
  catch(e){await refresh();notice('组织安排未改变：'+readableReason(e.message));}finally{pendingOrganization.delete(group.id);render();}
}
function organizationView(){
  const page=append(el('div'),intro('组织方式','为明确选择的任务安排并行、阶段串行或统一负责人。复用原协调记录，保留旧安排和原执行。'));
  for(const g of state.organization||[]){const card=append(el('section',null,'note-card'),el('h2',g.title));page.append(card);
    if(!g.available){card.append(el('p','原安排来源不可用：'+readableReason(g.reason),'small'));continue;}
    append(card,el('p',g.current?'当前登记：'+organizationModes[g.current.mode]+' · '+g.current.revision:'尚未登记本组安排。','small'),el('p',g.ownerSourceConfigured?'登记时重新核对原范围委托；查看钥匙不能代签本人决定。':'本机固定安排。没有据此创建本人采用或新的写入权限。','small'));
    if(g.ownerSourceConfigured&&!g.delegationConfigured)card.append(el('p','尚未配置本组已有委托的准确引用，相关登记保持不可用。','small'));
    if(g.current&&!g.current.currentMaterials)card.append(el('p','任务材料已更新，旧安排的绑定已失效。可重新选择相同安排，核对后登记新的准确修订；旧记录仍保留。','small'));
    for(const c of g.choices){const box=append(el('div',null,'execution-card'),el('h3',c.title+' · '+organizationModes[c.mode]));card.append(box);
      for(const task of c.tasks)append(box,el('p',task.title+'：'+(task.actor===task.originActor?'原负责人 '+task.actor+' 继续':'拟交给 '+task.actor+'；原执行结束与责任交接须另行核实'),'small'),el('p','阶段：'+task.stages.map(s=>organizationStages[s]||s).join(' → '),'small'));
      const taskName=id=>c.tasks.find(t=>t.id===id)?.title||id;
      for(const d of c.dependencies)box.append(el('p',taskName(d.task)+'的'+(organizationStages[d.stage]||d.stage)+'等待'+taskName(d.producer)+'的准确产物 '+d.capability,'small'));
      for(const shared of c.shared){const details=append(el('details'),el('summary','共享部分 '+shared.id+' · '+shared.blockedStages.map(s=>organizationStages[s]||s).join(' / ')+' 前须核反馈'),el('p',shared.contract),el('p','范围：'+shared.paths.join('、'),'small'));box.append(details);}
      const button=el('button',g.currentChoice===c.id?'已登记此安排':'登记此安排','outline');button.type='button';button.disabled=pendingOrganization.has(g.id)||g.ownerSourceConfigured&&!g.delegationConfigured||g.currentChoice===c.id;button.onclick=()=>applyOrganization(g,c);box.append(button);
    }
    for(const task of g.current?.stages||[]){const title=g.current.tasks.find(t=>t.id===task.id)?.title||task.id;for(const stage of task.stages)card.append(el('p',title+' · '+(organizationStages[stage.stage]||stage.stage)+'：'+(stage.phasePrerequisitesMet?'技术前置已满足；仍需实际执行许可':stage.blockers.map(readableReason).join('；')),'small'));}
    card.append(el('p','新安排不会释放活跃或未知的原写者。实际写权、模型投入和成果接受继续使用各自的原记录。','small'));
  }
  return page;
}
const overallPhases={not_prepared:'尚未准备',prepared_not_sent:'材料已准备，尚未派发',submitted_or_unknown:'原发送已登记，执行或结果待核',confirmed_unstarted:'已核清未向模型发任务，原记录保留',review_recorded:'完整复盘已保存'};
const materialLabels={acceptedBaseline:'上一接受基线',cumulativeChanges:'累计变化',currentBehavior:'当前行为',currentDocuments:'当前文档'};
async function overallAction(entry,action){
  if(pendingOverall.has(entry.id))return;pendingOverall.add(entry.id);render();
  try{const response=await fetch('/api/overall-review/'+entry.id+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}',cache:'no-store'}),r=await response.json();if(!response.ok)throw new Error(r.error||'复盘操作未完成');await refresh();notice(action==='run'?'已交给原复盘执行器。请看实际进度和完整结果；请求被接收还不代表模型完成。':action==='prepare'?'正在核对四类材料；准备操作不会派发模型。':action==='reconcile'?'正在查原运行和原结果，不重发未知输入。':'正在检查原启动记录；只会关闭已证实没有向模型发出任务的那一次；初始化进程也必须已结束。');}
  catch(e){notice('复盘操作未完成：'+readableReason(e.message));}finally{pendingOverall.delete(entry.id);render();}
}
function retrospectiveView(){
  const page=append(el('div'),intro('整体复盘','按需比较上一接受基线、累计变化、当前行为与文档，复用独立审核角色。查看和恢复原结果不新建模型任务。'));
  for(const r of state.overallReviews||[]){const card=append(el('section',null,'note-card'),el('h2',r.title));page.append(card);if(!r.available){card.append(el('p','原复盘来源不可读：'+readableReason(r.reason),'small'));continue;}
    append(card,pill(r.active?'本进程正在处理原操作':overallPhases[r.phase],r.phase==='review_recorded'?'':'wait'),el('p',r.trigger.reason),el('p','准确候选：'+r.candidate.H+' · '+(r.current?'当前材料仍适用':'历史材料，不能启动新复盘'),'mono'),el('p',r.baselineStatus==='verified_owner_source'?'接受基线有本人来源，仍须按原哈希核对；不等于技术通过。':r.baselineStatus==='missing'?'缺少上一接受基线；本次不能得出没有整体漂移的结论。':'基线材料已提供，但本人采用来源未核实。','small'));
    for(const [kind,refs] of Object.entries(r.material)){const detail=append(el('details'),el('summary',materialLabels[kind]+' · '+refs.length+'份'));if(!refs.length)detail.append(el('p','本类别尚无材料。','small'));for(const ref of refs)append(detail,el('p',ref.name),el('p',ref.sha256,'mono'));card.append(detail);}
    if(r.lastProblem||r.currentControllerProblem)card.append(el('p','此前操作记录：'+readableReason(r.currentControllerProblem||r.lastProblem),'small'));
    for(const resource of r.resources)card.append(el('p','原资源：'+resource.state+' · '+(resource.settled?'结果已回读':'原结果尚待核实；不推断退款'),'small'));
    const actions=el('div',null,'actions'),busy=r.active||pendingOverall.has(r.id),needsAuthority=r.ownerSourceConfigured&&!r.governanceConfigured,investmentStopped=state.tasks.find(t=>t.id===r.source)?.controls?.some(c=>c.kind==='investment'&&c.stopped);
    if(needsAuthority)card.append(el('p','此队列已启用本人来源，尚未绑定本次复盘的准确授权；准备与原结果读取可用，派发不可用。','small'));
    if(investmentStopped)card.append(el('p','本范围仍停止新增投入。可查原结果或核清未发送任务；需先在原范围解除该停止，才可启动。','small'));
    for(const [action,label] of [['prepare','核对并准备材料'],['run','启动一次复盘'],['reconcile','查回原运行'],['close-unstarted','核清并关闭未发送任务']]){const button=el('button',label,'outline');button.type='button';button.disabled=busy||(action==='run'&&(!r.current||needsAuthority||investmentStopped||!['not_prepared','prepared_not_sent','confirmed_unstarted'].includes(r.phase)))||(action==='prepare'&&r.phase!=='not_prepared')||(action==='reconcile'&&r.phase==='not_prepared')||(action==='close-unstarted'&&r.phase!=='submitted_or_unknown');button.onclick=()=>overallAction(r,action);actions.append(button);}
    if(r.phase==='review_recorded'){const button=el('button','打开完整复盘报告','outline');button.type='button';button.onclick=()=>openOverallReport(r);actions.append(button);}
    append(card,actions,el('p','简化反思、技术复盘与本人接受成果分别保留。模型结论不会自动改目标、授予权限或合并。','small'));
  }return page;
}
async function openOverallReport(entry){
  const nonce=++reportNonce;$('report-title').textContent=entry.title+' · 完整复盘';$('report-meta').textContent='读取原报告…';$('report-body').textContent='';$('report-original').hidden=true;$('report-original').open=false;$('report-dialog').showModal();
  try{const r=await api('/api/overall-report/'+entry.id);if(nonce!==reportNonce||!$('report-dialog').open)return;$('report-meta').textContent=(r.executionKind==='fixture'?'明确测试输出':'原生执行捕获')+' · '+r.verdict+' · '+(r.current?'当前材料':'历史材料')+' · 原文 SHA256 '+r.reportSha256+' · 不代表本人接受成果';$('report-body').textContent=r.report;}catch(e){if(nonce===reportNonce)$('report-body').textContent='原复盘无法读取：'+readableReason(e.message);}
}
async function ownerAction(entry,action,body){
  if(pendingOwner.has(entry.source))return;pendingOwner.add(entry.source);
  try{const response=await fetch('/api/owner-control/'+entry.source+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'}),r=await response.json();if(!response.ok)throw new Error(r.error||'本人决定未完成');await refresh();notice(action==='prepare'?'请求已保存。核对完整内容后，仍需从原本人来源确认；没有自动授予权限。':r.duplicate?'已查回原决定，没有重复执行。':r.executionKind==='fixture'?'明确测试来源已记录，不能作为本人采用。':'原本人来源与准确请求已核对，决定已保存。');}
  catch(e){notice('操作未完成：'+readableReason(e.message));}finally{pendingOwner.delete(entry.source);render();}
}
function ownerRequests(entry,kind){
  const box=el('section');for(const r of [...entry.requests].reverse().filter(r=>kind==='goals'?r.proposal.kind==='adopt_scope':['delegate','confirm_action','revoke','control'].includes(r.proposal.kind))){
    const detail=append(el('details',null,'outcome-request'),el('summary',(r.applied?'已记录决定':'待本人确认')+' · '+date(r.createdAt)+(r.revoked?' · 已撤销':'')));
    const p=r.proposal;detail.append(el('p',r.appliesTo==='whole_scope'?'此决定适用于整个范围及其相关任务。':r.appliesTo==='selected_target'?'此委托适用于当前范围中所选目标分支。':'此请求只适用于准确选定的任务与候选。','small'));if(p.kind==='adopt_scope'){for(const [field,label] of [['goals','目标'],['nonGoals','不做的事'],['preserve','必须保留'],['acceptance','验收结果'],['constraints','限制']]){detail.append(el('h3',label));const list=el('ul');p.body[field].forEach(v=>list.append(el('li',v)));detail.append(list);}}else if(p.kind==='delegate'){append(detail,el('p','角色：'+p.roles.map(role=>({background:'后台执行',implementer:'实现者',receiver:'接收审核',secretary:'秘书',coordinator:'协调者'}[role]||role)).join('、')),el('p','动作：'+p.actions.map(a=>({implement:'修改',test:'测试',receive:'接收',publish:'发布',merge:'合入',coordinate:'协调'}[a]||a)).join('、')),el('p','目标分支：'+p.targets.join('、')),el('p','允许路径：'+(p.paths.join('、')||'未授予文件修改')),el('p','资源引用：'+(p.resourceRefs.join('、')||'无')),el('p','截止：'+p.expiresAt));}else if(p.kind==='control'){const action=({investment:'新增投入',implementation:'新增实施',merge:'新合入'}[p.control]||p.control);append(detail,el('h3',(p.state==='stopped'?'停止':'恢复')+action),el('p',p.state==='open'?'解除这一个范围停止项；不会恢复其他已撤销权限，也不会重发未知任务。':'停止后续对应动作；已发生执行和原结果继续保留。'));}else if(p.kind==='confirm_action'){const a=p.request;append(detail,el('h3','确认一次准确动作'),el('p','动作：'+({implement:'修改',test:'测试',receive:'接收',publish:'发布',merge:'合入',coordinate:'协调'}[a.action]||a.action)),el('p','角色：'+p.performerRole+' · 目标：'+a.target),el('p','允许路径：'+(a.paths.join('、')||'无')),el('p','资源引用：'+(a.resourceRefs.join('、')||'无')),el('p','截止：'+p.expiresAt));}else detail.append(el('p','撤销原委托或单次授权；原执行和结果仍保留。'));
    detail.append(append(el('details'),el('summary','核对完整固定请求'),el('pre',JSON.stringify(p,null,2),'outcome-original')));
    if(r.sourceUrl){const link=el('a','查看原决定 ↗');link.href=r.sourceUrl;link.target='_blank';link.rel='noreferrer noopener';detail.append(link);}
    if(r.applied&&['delegate','confirm_action'].includes(p.kind)&&!r.revoked){const button=el('button','准备撤销此委托','outline');button.type='button';button.disabled=pendingOwner.has(entry.source);button.onclick=()=>ownerAction(entry,'prepare',{kind:'revoke',decision:r.proposalSha256});detail.append(button);}
    if(!r.applied){append(detail,el('p','以下确认内容由程序生成，绑定上面的完整请求。页面访问钥匙不能代替本人签署。','small'),el('pre',r.ownerComment,'outcome-original'));const link=el('a','打开本人确认来源 ↗');link.href='https://github.com/'+entry.repository+'/issues/'+entry.issue;link.target='_blank';link.rel='noreferrer noopener';detail.append(link);const form=el('form',null,'outcome-source'),label=el('label','本人确认评论的完整链接'),input=el('input');input.type='url';input.required=true;input.value=ownerSources.get(r.proposalSha256)||'';input.oninput=()=>ownerSources.set(r.proposalSha256,input.value);label.append(input);const button=el('button','核对原来源并记录','outline');button.type='submit';button.disabled=pendingOwner.has(entry.source)||!entry.ownerDistinctFromExecutor;form.onsubmit=e=>{e.preventDefault();void ownerAction(entry,'apply',{proposalSha256:r.proposalSha256,sourceUrl:input.value.trim()});};append(form,label,button);detail.append(form);}
    box.append(detail);
  }return box;
}
function ownerView(kind){
  const page=append(el('div'),intro(kind==='goals'?'目标与边界':'委托与停止',kind==='goals'?'修改要达成的结果、验收方式与保留项。草稿、本人采用和技术验证分别记录。':'委托使用原权限记录。停止不会抹去已经发生的执行；恢复也不会自动增加权限。'));
  for(const entry of state.ownerControls||[]){const task=state.tasks.find(t=>t.id===entry.source),card=append(el('section',null,'panel delivery-card'),el('h2',task?.title||entry.source));page.append(card);if(!entry.available){card.append(el('p','尚不能读取该任务的本人来源配置：'+readableReason(entry.reason),'small'));continue;}
    if(entry.executionKind==='fixture')card.append(pill('隔离测试来源，不代表本人采用','neutral'));
    if(entry.currentScope&&entry.currentScope.scopeVersion!==entry.taskScope.version)card.append(el('p','已采用目标与任务当前范围版本不同；执行仍需按原后端核对安排与权限。','small'));
    if(!entry.ownerDistinctFromExecutor)card.append(el('p','当前执行身份与本人来源未分开，不能据此签署新权限；仍可准备请求和查看原结果。','small'));
    const draftKey=kind+':'+entry.source,draft=ownerDrafts.get(draftKey)||{body:structuredClone(entry.currentScope?.body||{goals:[],nonGoals:[],preserve:[],acceptance:[],constraints:[]}),scopeVersion:'S-'+Date.now(),basedOn:entry.currentAdoption,expiresAt:new Date(Date.now()+3600000).toISOString(),role:'implementer',actions:['test'],paths:'',resourceRefs:'',hours:1};ownerDrafts.set(draftKey,draft);const draftStale=draft.basedOn!==entry.currentAdoption;if(draftStale){const reload=el('button','载入当前目标后重新准备','outline');reload.type='button';reload.onclick=()=>{ownerDrafts.delete(draftKey);render();};append(card,el('p','目标已被另一决定更新，当前草稿暂不提交；原内容保留在本页。','small'),reload);}
    if(kind==='authority'){if(task?.available)card.append(scopeControlPanel(task)||el('p','此入口尚未配置本机停止操作；当前停止记录仍显示在任务页。','small'));if(!entry.currentAdoption){card.append(el('p','目标尚未采用；委托须等准确目标成立。','small'));card.append(ownerRequests(entry,kind));continue;}}
    const form=el('form',null,'outcome-form');form.setAttribute('aria-label',kind==='goals'?'目标请求':'委托请求');
    if(kind==='goals'){
      for(const [field,labelText] of [['goals','要完成什么（每行一项）'],['nonGoals','这次不做什么'],['preserve','必须保留什么'],['acceptance','怎样确认完成'],['constraints','费用、权限与其他限制']]){const label=el('label',labelText),input=el('textarea');input.rows=field==='goals'||field==='acceptance'?3:2;input.required=field==='goals'||field==='acceptance';input.value=draft.body[field].join('\n');input.oninput=()=>{draft.body[field]=input.value.split('\n').map(x=>x.trim()).filter(Boolean);};label.append(input);form.append(label);}
    }else{
      const roleLabel=el('label','执行角色'),roles=el('select');for(const [value,text] of [['implementer','实现者'],['receiver','接收审核者'],['secretary','秘书'],['coordinator','协调者'],['background','后台执行']]){const option=el('option',text);option.value=value;roles.append(option);}roles.value=draft.role;roles.onchange=()=>draft.role=roles.value;roleLabel.append(roles);form.append(roleLabel);
      const actions=append(el('fieldset'),el('legend','允许的动作'));for(const [value,text] of [['implement','修改限定文件'],['test','运行测试'],['receive','接收审核'],['publish','发布正式结果'],['merge','合入'],['coordinate','协调任务']]){const label=el('label'),input=el('input');input.type='checkbox';input.checked=draft.actions.includes(value);input.onchange=()=>{draft.actions=input.checked?[...draft.actions,value]:draft.actions.filter(a=>a!==value);};append(label,input,el('span',text));actions.append(label);}form.append(actions);
      for(const [field,labelText] of [['paths','允许修改的相对路径（每行一项）'],['resourceRefs','已登记资源引用（没有则留空）']]){const label=el('label',labelText),input=el('textarea');input.rows=2;input.value=draft[field];input.oninput=()=>draft[field]=input.value;label.append(input);form.append(label);}
      const label=el('label','有效小时数'),hours=el('input');hours.type='number';hours.min='1';hours.max='744';hours.value=draft.hours;hours.oninput=()=>{draft.hours=Number(hours.value);if(Number.isFinite(draft.hours)&&draft.hours>0)draft.expiresAt=new Date(Date.now()+draft.hours*3600000).toISOString();};label.append(hours);form.append(label);form.append(el('p','仅适用于当前目标分支 '+entry.target+'；准备请求不会启动模型或修改代码。','small'));
    }
    const button=el('button',kind==='goals'?'保存目标请求':'保存委托请求','outline');button.type='submit';button.disabled=pendingOwner.has(entry.source)||draftStale;form.append(button);
    form.onsubmit=e=>{e.preventDefault();const body=kind==='goals'?{kind:'goal',scopeVersion:draft.scopeVersion,body:draft.body,previousAdoption:draft.basedOn}:{kind:'delegate',adoption:draft.basedOn,roles:[draft.role],actions:draft.actions,paths:draft.paths.split('\n').map(x=>x.trim()).filter(Boolean),resourceRefs:draft.resourceRefs.split('\n').map(x=>x.trim()).filter(Boolean),expiresAt:draft.expiresAt};void ownerAction(entry,'prepare',body);};append(card,form,ownerRequests(entry,kind));
  }return page;
}
async function openAssessmentReport(entry,assessment){
  const nonce=++reportNonce;$('report-title').textContent=entry.batch.title+' · 独立领域判断';$('report-meta').textContent='读取准确原报告…';$('report-body').textContent='';$('report-raw').textContent='';$('report-original').hidden=true;$('report-original').open=false;$('report-dialog').showModal();
  try{const r=await api('/api/delivery-report/'+entry.id+'/'+encodeURIComponent(assessment.id));if(nonce!==reportNonce||!$('report-dialog').open)return;const result=r.result,j=result.report;$('report-meta').textContent=(result.executionKind==='fixture'?'明确进程夹具，非真实模型':'原模型捕获')+' · 会话 '+result.sessionId+' · 输入证据 '+r.inputEvidenceSha256+' · 判断不代表本人接受';$('report-body').textContent=j?[j.report,...j.coverage.map(c=>'场景 '+c.scenario+'：'+({pass:'判断通过',reject:'判断退回',needs_evidence:'判断需补证据'}[c.verdict]||c.verdict)+'\n方法：'+c.method+'\n依据：'+c.reason+'\n原件：'+c.evidence.join('、')),'限制：\n'+j.limitations.join('\n')].join('\n\n'):'原最终输出已保存，但格式无效，未形成可用领域判断。\n'+readableReason(result.invalidReason);$('report-raw').textContent=r.rawFinal;$('report-original').hidden=false;}catch(e){if(nonce===reportNonce)$('report-body').textContent='原判断无法读取：'+readableReason(e.message);}
}
async function deliveryAction(entry,action,body){
  if(pendingOutcomes.has(entry.id))return;pendingOutcomes.add(entry.id);render();
  try{const response=await fetch('/api/delivery/'+entry.id+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'}),result=await response.json();if(!response.ok)throw new Error(result.error||'成果决定未完成');await refresh();notice(action==='prepare'?'固定决定请求已保存；尚未代表本人采用。请核对下方的原来源确认内容。':result.duplicate?'已读回原决定，未再次读取远端来源。':result.executionKind==='fixture'?'隔离示例来源已核对并保存；不代表真实本人决定。':'本人原来源已核对，决定和原证据已保存。');}
  catch(e){await refresh();const text={delivery_outcome_evidence_changed:'证据已更新，请核对新的结果后重新准备决定。',delivery_outcome_previous_changed:'已有较新的决定，请先核对原记录。',delivery_outcome_current_batch_required:'本批版本、材料或采用范围已变化，旧请求不能继续。',shared_account_is_not_owner_confirmation:'当前来源与执行者是同一身份，不能作为独立本人确认。'}[e.message]||readableReason(e.message);notice('决定未改变：'+text);}finally{pendingOutcomes.delete(entry.id);render();}
}
function deliveryView(){
  const n=el('div');n.append(intro('成果与验收','每批成果保留明确目标、实际验证和本人决定。场景通过、成果接受与后续合入分别记录。'));
  for(const entry of state.deliveries||[]){const card=el('section',null,'panel delivery-card');n.append(card);if(!entry.available){append(card,el('h2','成果来源待核'),el('p',readableReason(entry.reason),'small'));continue;}const b=entry.batch,last=b.outcomes.at(-1);append(card,append(el('div',null,'panel-head'),append(el('div'),el('span',b.id+' · 第 '+b.revision+' 版','eyebrow'),el('h2',b.title)),pill(b.userOutcomeAccepted?'本人已接受':b.acceptedWithinRecordedSource?'示例来源已接受':'尚无当前本人接受',b.userOutcomeAccepted?'':'neutral')));
    if(!b.currentVersion||!b.currentMaterials||b.scope.adoption&&!b.scope.currentAdoption)card.append(el('p','本批材料或范围已变化，旧记录作为历史保留。','small'));
    const goals=el('ul',null,'delivery-goals');b.goals.forEach(g=>goals.append(el('li',g)));append(card,el('h3','本批要交付的成果'),goals);
    if(b.nonGoals.length){const d=append(el('details'),el('summary','本批不包含的内容')),list=el('ul');b.nonGoals.forEach(g=>list.append(el('li',g)));d.append(list);card.append(d);}
    append(card,append(el('div',null,'section-title delivery-section'),el('h3','场景验证'),pill(b.scenarioAssertionsPassed?'已记录的检查通过':'仍有未通过或待核项',b.scenarioAssertionsPassed?'':'wait')));
    for(const s of b.scenarios){const proof=b.scenarioEvidence.find(x=>x.scenario===s.id),label=proof.executionVerified?(proof.passed?'实际检查通过':'实际检查未通过'):proof.phase==='not_executed'?'尚未执行验证':'结果仍待核实',row=el('div',null,'report-row');append(row,append(el('div'),el('strong',s.title),el('p',s.expected),proof.demonstrationFixture?el('p','明确隔离示例；不作为真实业务场景完成。','small'):null),pill(label,proof.passed===true?'':'wait'));card.append(row);}
    if(b.assessments?.length){const judgments=append(el('section',null,'collaboration'),el('h3','独立领域判断'),el('p','判断者解释所选场景的原证据，不替代实际执行或本人接受。每份报告保留当时的准确输入。','small'));for(const a of b.assessments){const row=el('div',null,'report-row'),left=el('div'),label={recorded:'完整判断已保存',returned_invalid:'原输出无效',started_or_unknown:'原执行或结果待核',prepared_not_started:'已准备，尚未发送',known_unstarted:'已核实未发送，可继续或关闭原请求',closed_unstarted:'未发送请求已关闭'}[a.phase]||a.phase;append(left,el('strong',(a.executionKind==='fixture'?'示例 · ':'')+label),el('p','所选场景：'+a.requestedScenarios.join('、'),'small'),a.verdict?el('p','判断：'+({pass:'通过',reject:'退回',needs_evidence:'补证据'}[a.verdict]||a.verdict),'small'):null);row.append(left);if(a.finalSha256){const button=el('button','阅读完整判断','outline');button.type='button';button.onclick=()=>openAssessmentReport(entry,a);row.append(button);}judgments.append(row);}card.append(judgments);}
    const facts=el('dl',null,'facts');fact(facts,'固定批次',b.batchSha256,true);fact(facts,'本次证据集合',b.evidenceSha256,true);card.append(append(el('details'),el('summary','核对固定批次与证据摘要'),facts));
    if(last){const box=el('div',null,'note-card');append(box,el('h3',(last.executionKind==='fixture'?'示例来源 · ':'本人来源 · ')+(outcomeLabels[last.proposal.outcome]||last.proposal.outcome)),el('p',last.proposal.rationale),el('p',last.revoked?'该决定已撤销，历史保留。':!last.sourceOriginalsVerified?'原来源待核：'+readableReason(last.reason):b.currentOutcome?'对应当前批次与证据；本次查看未重新读取远端。':'该决定对应旧材料或旧证据，继续保留。','small'));card.append(box);}
    if(b.outcomes.length>1){const history=append(el('details'),el('summary','历史成果决定（'+b.outcomes.length+'）'));for(const o of [...b.outcomes].reverse())append(history,append(el('div',null,'report-row'),append(el('div'),el('strong',(o.executionKind==='fixture'?'示例 · ':'')+outcomeLabels[o.proposal.outcome]),el('p',o.proposal.rationale),el('p',date(o.recordedAt)+(o.revoked?' · 已撤销':'')+(!o.sourceOriginalsVerified?' · 原来源待核':''),'small'))));card.append(history);}
    if(entry.canPrepare){const draft=outcomeDrafts.get(entry.id)||{outcome:'needs_evidence',rationale:''};outcomeDrafts.set(entry.id,draft);const form=el('form',null,'outcome-form'),select=el('select'),reason=el('textarea'),submit=el('button','准备固定决定','outline');select.id='outcome-choice-'+entry.id;reason.id='outcome-reason-'+entry.id;for(const [v,label] of Object.entries(outcomeLabels)){const option=el('option',label);option.value=v;select.append(option);}select.value=draft.outcome;select.onchange=()=>draft.outcome=select.value;reason.value=draft.rationale;reason.rows=3;reason.maxLength=4096;reason.required=true;reason.oninput=()=>draft.rationale=reason.value;const choiceLabel=el('label','对本批成果的决定'),reasonLabel=el('label','理由与需要处理的事项');choiceLabel.htmlFor=select.id;reasonLabel.htmlFor=reason.id;submit.type='submit';submit.disabled=pendingOutcomes.has(entry.id);append(form,el('h3','准备本人决定'),choiceLabel,select,reasonLabel,reason,el('p','准备只保存请求。采用时另核本人原来源；“停止后续投入”影响本批所属范围。','small'),submit);form.onsubmit=e=>{e.preventDefault();void deliveryAction(entry,'prepare',{outcome:select.value,rationale:reason.value,evidenceSha256:b.evidenceSha256,previousOutcome:b.latestOutcomeDecision});};card.append(form);}
    else if(state.mode!=='read_only')card.append(el('p','需先具备当前批次材料和有效本人范围来源，才可准备成果决定。','small'));
    const pending=(entry.requests||[]).filter(r=>!r.applied);for(const r of pending){const box=el('div',null,'outcome-request');card.append(box);if(!r.available){append(box,el('h3','原决定请求待核'),el('p',readableReason(r.reason),'small'));continue;}append(box,el('h3','待确认 · '+outcomeLabels[r.proposal.outcome]),el('p',r.proposal.rationale,'small'));const details=append(el('details'),el('summary','核对本人原来源的确认内容'),el('pre',r.ownerComment,'outcome-original'));const link=el('a','打开本人决定所在 Issue ↗');link.href='https://github.com/'+r.repository+'/issues/'+r.issue;link.target='_blank';link.rel='noreferrer noopener';append(details,link,el('p','由配置的本人身份确认上述固定请求；页面不会代发。','small'));box.append(details);
      if(!r.current){box.append(el('p','批次、证据或前一决定已变化，此请求保留为历史。','small'));continue;}
      if(state.mode!=='read_only'){const form=el('form',null,'outcome-source'),input=el('input'),button=el('button','读取并核对本人决定','outline'),label=el('label','本人确认评论编号');input.id='outcome-comment-'+r.proposalSha256;label.htmlFor=input.id;input.type='text';input.inputMode='numeric';input.pattern='[1-9][0-9]*';input.required=true;input.value=outcomeComments.get(r.proposalSha256)||'';input.oninput=()=>outcomeComments.set(r.proposalSha256,input.value);button.type='submit';button.disabled=pendingOutcomes.has(entry.id);append(form,label,input,button);form.onsubmit=e=>{e.preventDefault();const commentId=Number(input.value);if(!Number.isSafeInteger(commentId)||commentId<=0){notice('请填写准确的本人评论编号。');return;}void deliveryAction(entry,'apply',{proposalSha256:r.proposalSha256,commentId});};box.append(form);}}
  }return n;
}
function metric(number, label, note) { return append(el('div', null, 'metric'), el('strong', number), el('span', label), el('small', note)); }
function openTask(id) { selected = id; view = 'tasks'; render(); $('content').focus({ preventScroll: true }); }
function card(t) {
  const [label, kind] = statusOf(t), n = el('button', null, 'task-card'); n.type = 'button'; n.dataset.task = t.id; n.dataset.stage = label; n.onclick = () => openTask(t.id);
  const replies=(t.collaboration?.messages||[]).filter(r=>r.available&&r.current).flatMap(r=>r.messages).filter(m=>m.state==='Reply').length;
  append(n, append(el('div', null, 'card-top'), el('span', t.available ? t.composition ? '固定组合 · ' + t.composition.subject.members.length + ' 个成员' : taskSourceLabel(t) : '本地来源', 'pr'), pill(label, kind)), el('h3', t.title), el('p', t.available ? t.candidate.repository + ' · ' + t.candidate.targetRef : '当前来源不可用，未将空记录当作完成。', 'sub'), append(el('div', null, 'card-bottom'), el('span', t.available ? 'H ' + t.candidate.H.slice(0, 8) + ' · 接收判断 ' + t.operations.filter(o => o.judgment).length + ' · 协作回复 '+replies : t.error), el('span', '↗', 'arrow'))); return n;
}
function overview() {
  const valid = state.tasks.filter(t => t.available), allOps = valid.flatMap(t => t.operations), current = allOps.filter(o => o.currentPacket && o.stage === 'returned'), waiting = allOps.filter(o => !['returned', 'historical_result'].includes(o.stage) && (o.currentPacket || o.stage !== 'returned_invalid'));
  const messages=valid.flatMap(t=>(t.collaboration?.messages||[]).filter(r=>r.available&&r.current&&!(t.developmentTask?.inbox||[]).some(i=>i.run===r.run&&i.phase==='interrupted_closed')).flatMap(r=>r.messages)),replies=messages.filter(m=>m.state==='Reply').length,pending=messages.filter(m=>m.state!=='Reply'&&!m.continuedIn).length;
  const inboxPending=valid.reduce((count,t)=>{const represented=new Set((t.collaboration?.messages||[]).filter(r=>r.available&&r.current).flatMap(r=>r.messages.map(m=>r.run+':'+m.id)));return count+(t.developmentTask?.inbox||[]).filter(r=>!['returned','cancelled','interrupted_closed'].includes(r.phase)&&!represented.has(r.run+':'+r.id)).length;},0);
  const overall=state.overallReviews||[],overallReturned=overall.filter(r=>r.available&&r.current&&r.phase==='review_recorded').length,overallPending=overall.filter(r=>!r.available||r.active||r.phase!=='review_recorded'||r.resources.some(x=>!x.settled)).length;
  const n = el('div'); append(n, intro(state.title, state.goal, state.mode==='read_only'?'所选原队列 · 只读':'所选原队列 · 受控入口'), append(el('section', null, 'metrics'), metric(state.tasks.length, '已连接任务', valid.length + ' 项当前可读取'), metric(current.length+replies+overallReturned, '已返回的报告', '接收 '+current.length+' · 协作回复 '+replies+' · 复盘 '+overallReturned+'，不代表批准'), metric(waiting.length+pending+inboxPending+overallPending, '待核 / 尚未完成', '接收 '+waiting.length+' · 消息 '+pending+' · 其他负责人待办 '+inboxPending+' · 复盘 '+overallPending)), append(el('div', null, 'section-title'), el('h2', '当前任务'), el('span', '选择任务查看完整报告')));
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
    if((t.developmentTask?.inbox||[]).some(i=>i.run===run.run&&i.phase==='interrupted_closed'))box.append(el('p','该请求已明确结束，中断原件仍保留；没有把它计为完整回复。','small'));
    if(run.resourcesSettled!==null)append(box,el('p','原资源结算：'+(run.resourcesSettled?'本次结果凭据匹配':'未完成，保留原认领'),'small'));
    if(!run.messages.length)append(box,el('p','尚无实际发给本任务的消息；其他任务的回复不计为本任务完成。','small'));
    run.participants.forEach(p=>append(box,el('p',p.tool+' · '+p.id+' · '+(p.started?(p.ended?(p.completeCapture?'完整捕获已核':'执行结束，捕获待核'):'执行中或结束状态未知'):'尚未启动')+(p.sessionId?' · 会话 '+p.sessionId:''),'small wrap')));
    run.messages.forEach(m=>{const row=el('div',null,'report-row'),left=el('div'),label=run.closedUnstarted?'未发送请求已关闭，原记录保留':m.continuedIn?'原消息未发送，已由新上下文补齐':{Held:'待发送',Unknown:'发送或结果未知',Delivered:'已送达，等待完整回复',Refused:'明确拒绝',Reply:'完整回复已登记',Interrupted:'已观察到中断，不是完整回复'}[m.state]||'状态待核';append(left,el('strong',m.id+' → '+m.to),el('p',label+' · '+(m.continuedIn?'接续运行 '+m.continuedIn.slice(0,8):m.consumptionConfirmed?'已确认消费指定材料':'消费尚未确认'),'small'));row.append(left);if(m.replyRecorded){const b=el('button','阅读完整消息','outline');b.type='button';b.onclick=()=>openMessageReport(t,run,m);row.append(b);}box.append(row);});
    if(run.continuation)append(box,el('p','另有新上下文接续记录；不能据此认定原会话已恢复。','small'));n.append(box);
  });return n;
}
function taskView() {
  if (!selected || !state.tasks.some(t => t.id === selected)) selected = state.tasks[0].id;
  const n = el('div'); n.append(intro('任务与完整报告', '查看准确候选、接收状态及报告原文。来源不可用时会明确显示缺口。'));
  const layout = el('div', null, 'task-layout'), picker = el('div', null, 'task-picker');
  state.tasks.forEach(t => { const b = el('button', t.title); b.type = 'button'; b.setAttribute('aria-pressed', String(t.id === selected)); b.append(el('small', t.available ? taskSourceLabel(t) + ' · ' + statusOf(t)[0] : '来源无法读取')); b.onclick = () => { selected = t.id; render(); }; picker.append(b); });
  const t = state.tasks.find(t => t.id === selected), panel = el('section', null, 'panel'); append(layout, picker, panel); n.append(layout);
  if (!t.available) { append(panel, el('h2', t.title), el('p', '当前来源无法读取：' + t.error, 'empty')); return n; }
  const [label, kind] = statusOf(t), head = append(el('div', null, 'panel-head'), append(el('div'), el('h2', t.title), el('p', t.candidate.repository + ' · ' + taskSourceLabel(t))), pill(label, kind)); panel.append(head);
  if (t.composition) append(panel, el('p', subjectText(t.composition.subject)), el('p', '判断对应整个固定组合；锚点 PR 用于定位，不表示任何成员单独放行。受测最终树：' + (t.composition.subject.testedTree || '未取得'), 'small'));
  const facts = el('dl', null, 'facts'); fact(facts, '登记候选 H', t.candidate.H, true); fact(facts, '固定基线 B', t.candidate.B, true); fact(facts, '真实目标', t.candidate.targetRef); fact(facts, '来源观察', date(t.sourceObservedAt)); fact(facts, '本次查看', date(t.observedAt)); fact(facts, '登记范围', t.scope.id + ' / ' + t.scope.version); panel.append(facts);
  if (/^[\w.-]+\/[\w.-]+$/.test(t.candidate.repository) && Number.isSafeInteger(t.candidate.pr)) { const a = el('a', '查看原 PR ↗'); a.href = 'https://github.com/' + t.candidate.repository + '/pull/' + t.candidate.pr; a.target = '_blank'; a.rel = 'noreferrer noopener'; panel.append(a); }
  if (t.developmentTask) {
    const d = t.developmentTask, phases = {queued:'待处理',prepared:'已装配，尚未发送',waiting:'等待前置',active_or_unknown:'执行中或状态待核',unresolved:'原结果待恢复',returned:'完整回复已保存',cancelled:'已撤销未发送待办',interrupted:'已中断，原请求未完成',interrupted_closed:'已保留中断结果并结束请求'};
    panel.append(el('p', '开发任务保持原身份。只观察了指定文件；关联候选、测试结果与正式接受分别记录。', 'small'));
    const links=d.candidateLinks||[];
    if(!links.length)panel.append(el('p','尚未关联真实 PR 候选材料。','small'));
    for(const linked of links){const row=el('div',null,'report-row'),left=el('div');left.append(el('strong','PR #'+linked.pr+' · '+(linked.current?'对应当前已记录材料':'历史关联')));left.append(el('p','H '+linked.H+' · B '+linked.B+' · '+linked.target,'small'));if(linked.reason)left.append(el('p',readableReason(linked.reason),'small'));left.append(el('p','关联不授予接收、写入或合并权限；当前性基于原队列最近观察。','small'));row.append(left);if(/^[\w.-]+\/[\w.-]+$/.test(linked.repository)&&Number.isSafeInteger(linked.pr)&&linked.pr>0){const a=el('a','打开关联 PR ↗');a.href='https://github.com/'+linked.repository+'/pull/'+linked.pr;a.target='_blank';a.rel='noreferrer noopener';row.append(a);}panel.append(row);}

    const inbox=el('section',null,'panel');inbox.append(el('h3','负责人待办'));
    if (!d.inbox.length) inbox.append(el('p','尚未安排负责人调查。','small'));
    for (const r of d.inbox) inbox.append(append(el('div',null,'report-row'),append(el('div'),el('strong',r.id+' · '+(phases[r.phase]||r.phase)),el('p',r.actor+' / '+r.tool+' · '+(r.currentMaterial?'对应当前材料':'历史材料'),'small'),r.reason?el('p',r.reason,'small'):null,r.sessionId?el('p','实际会话 '+r.sessionId+' · 新上下文，未接管外部会话','small'):null)));
    panel.append(inbox);
  }
  append(panel,scopeControlPanel(t),contactControls(t),collaborationView(t));
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
  append(details, el('p', t.controls.length ? t.controls.map(c => ({ investment: '新增投入', implementation: '新增实施', merge: '新合并' }[c.kind] || c.kind) + '：' + (c.stopped ? '已登记停止' : '本机记录开放') + '（修订 ' + c.revision + '）').join('；') : '该任务范围没有登记停止条目。这不等于取得了额外权限。', 'small'), el('p', (state.scopeControls?.length?'本页仅能改变已配置的本机停止状态；不签署本人决定或执行生产动作。':'本页没有改写范围控制或生产动作的接口。')+'来源与测试观察来自不同时间，本次查看不刷新远端事实。', 'small')); panel.append(details); return n;
}
function timeline(events) {
  const list = el('div', null, 'timeline'); if (!events.length) return el('p', '尚无所选任务的协作记录。', 'empty');
  events.forEach(e => append(list, append(el('article', null, 'timeline-row'), el('time', date(e.observedAt)), el('span', null, 'timeline-line'), append(el('div'), el('strong', eventNames[e.kind] || '原操作事件'), el('p', e.title))))); return list;
}
function render() {
  if (!state) return;
  $('runtime-version').hidden=!state.runtime;if(state.runtime)$('runtime-version').textContent='本次运行版本 '+state.runtime.sourceHead.slice(0,12)+' · 配置 '+state.runtime.planSha256.slice(0,12)+' · 已匹配固定源码、构建与配置记录';
  const abilities=[state.ownerControls?.length?'目标与委托':null,state.organization?.length?'组织方式':null,state.deliveries?.length?'成果决定':null,state.taskControls?.length?'任务联系':null,state.scopeControls?.length?'范围停止':null,state.overallReviews?.length?'整体复盘':null].filter(Boolean);
  $('access-mode').textContent=state.mode==='read_only'?'只读':'受控入口';$('access-description').textContent=state.mode==='read_only'?'当前页面提供查看与核对；没有批准、合并或派发入口。':'已配置：'+abilities.join('、')+'。实际动作按原范围、权限与资源执行；页面钥匙不代替本人签署。';
  document.querySelector('[data-view="deliveries"]').hidden=!state.deliveries?.length;
  document.querySelector('[data-view="organization"]').hidden=!state.organization?.length;
  document.querySelector('[data-view="retrospective"]').hidden=!state.overallReviews?.length;
  for(const name of ['goals','authority'])document.querySelector('[data-view="'+name+'"]').hidden=!state.ownerControls?.length;
  document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('content').replaceChildren(view === 'overview' ? overview() : view === 'tasks' ? taskView() : view==='deliveries'?deliveryView():view==='organization'?organizationView():view==='retrospective'?retrospectiveView():['goals','authority'].includes(view)?ownerView(view):append(el('div'), intro('协作记录', '保留原阶段顺序。独立材料检查、等待、实际发送和返回分别登记。'), timeline([...state.events].reverse())));
}
async function refresh() {
  if(controlRefresh!==null){clearTimeout(controlRefresh);controlRefresh=null;}
  $('refresh').disabled = true;
  try {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('viewer_key_required');
    state = await api('/api/state'); const at = state.tasks.map(t => t.observedAt).sort().at(-1); $('observed').textContent = '本机读取 · ' + date(at);
    notice(state.tasks.some(t => !t.available) ? '部分来源无法读取；相关任务已明确标记，未用空数据或旧结论代替。' : ''); render();
  } catch (e) { notice((state ? '刷新失败，下面仍是上次读取的数据。' : '无法读取当前数据。') + (e.message === 'viewer_key_required' ? '请从本次启动生成的完整本机入口打开。' : '来源返回：' + e.message)); if (!state) $('content').replaceChildren(el('p', '尚未取得真实队列数据。', 'empty')); }
  finally { $('refresh').disabled = false;if((state?.taskControls||[]).some(c=>c.controllerActive)||(state?.overallReviews||[]).some(c=>c.active))controlRefresh=setTimeout(refresh,2000); }
}
async function openReport(t, o) {
  const nonce = ++reportNonce; $('report-title').textContent = t.title + ' · 完整报告'; $('report-meta').textContent = '读取原操作…'; $('report-body').textContent = ''; $('report-raw').textContent='';$('report-original').hidden=true;$('report-original').open=false; $('report-dialog').showModal();
  try { const r = await api('/api/report/' + t.id + '/' + o.id); if (nonce !== reportNonce || !$('report-dialog').open) return; $('report-meta').textContent = (r.subject ? subjectText(r.subject) + ' · 非逐成员放行 · ' : '') + (verdicts[r.verdict] || r.verdict) + (r.judgmentId ? ' · 判断 ' + r.judgmentId : ' · 原操作 ' + r.operation) + ' · 原文 SHA256 ' + r.reportSha256 + ' · ' + executionText(r.nativeExecution); $('report-body').textContent = r.report; }
  catch (e) { if (nonce === reportNonce) $('report-body').textContent = '原报告无法读取：' + e.message; }
}
async function openMessageReport(t,run,m){
  const nonce=++reportNonce;$('report-title').textContent=t.title+' · 完整消息';$('report-meta').textContent='读取原消息…';$('report-body').textContent='';$('report-raw').textContent='';$('report-original').hidden=true;$('report-original').open=false;$('report-dialog').showModal();
  try{const r=await api('/api/message-report/'+t.id+'/'+run.run+'/'+encodeURIComponent(m.id));if(nonce!==reportNonce||!$('report-dialog').open)return;$('report-meta').textContent=(r.current?'当前材料':'历史材料')+' · '+(r.completeCapture?'完整捕获已核':'捕获尚未核实')+(r.consumptionConfirmed?' · 已确认消费指定材料':' · 材料消费未确认，以下保留原始输出')+(r.nativeSessionResumed?' · 准确续接原会话 ':' · 会话 ')+r.sessionId+' · 传输原文 SHA256 '+r.reportSha256;$('report-body').textContent=r.reportText;$('report-raw').textContent=r.report;$('report-original').hidden=false;}catch(e){if(nonce===reportNonce)$('report-body').textContent='原消息无法读取：'+e.message;}
}
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => { view = b.dataset.view; render(); }; });
$('close-report').onclick = () => $('report-dialog').close(); $('report-dialog').addEventListener('close', () => { reportNonce++; });
$('refresh').onclick = refresh;
document.querySelector('.skip').onclick = e => { e.preventDefault(); $('content').focus(); $('content').scrollIntoView(); };
let initial = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'; try { initial = localStorage.getItem('tongxu-view-theme') || initial; } catch {}; document.documentElement.dataset.theme = initial === 'dark' ? 'dark' : 'light';
$('theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('tongxu-view-theme', theme); } catch {} };
void refresh();
