const pendingReceptions=new Set();
const receptionReason=value=>({owner_action_stopped:'当前范围的原授权已停止新增动作；原工作与报告保留。',new_investment_stopped:'当前范围停止新增投入，原操作与报告保留。',target_occupied_or_unknown:'同一目标仍被原工作占用或结果未知；请先核原工作，不能另起竞争接收。',reception_seats_full:'已配置的接收席位仍被原工作占用；先等待或核对其真实状态。',reception_material_changed_refresh_required:'来源已形成另一份材料，请刷新后核对新的接收对象。',reception_control_template_binding_invalid:'本入口的接收配置与选定任务不一致，尚未执行。',reception_control_catalog_changed:'接收配置已变化，请沿原安装记录核对。',owner_confirmation_already_reserved:'原一次确认已经用于先前操作，不能沿用到这份新材料；需当前操作的准确授权。'}[value]||readableReason(value));
const receptionProject=()=>gh.selected?gh.account?.id+':'+gh.selected.id:'legacy';
async function receptionAction(entry,action,expectedProject=receptionProject()){
  if(expectedProject!==receptionProject())return;
  const identity=expectedProject+':'+entry.id,project=gh.selected?.id;if(pendingReceptions.has(identity))return;pendingReceptions.add(identity);render();
  try{const response=await workspaceFetch('/api/reception/'+encodeURIComponent(entry.id)+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(action==='start'?{expectedPacket:entry.packet}:{}),cache:'no-store'}),value=await response.json();if(!response.ok)throw new Error(value.error||'reception_unavailable');}
  catch(error){if(expectedProject===receptionProject())notify(receptionReason(error.message));}finally{pendingReceptions.delete(identity);if(expectedProject===receptionProject())await refresh();}
}
function receptionPanel(task){
  const entries=(state.receptions||[]).filter(e=>e.source===task.id);if(!entries.length)return null;
  const project=receptionProject(),panel=append(el('section',null,'collaboration'),el('h3','来源补查与独立技术接收'),el('p','先核来源，再按当前材料和准确授权进入既有接收。来源补查本身不启动模型；技术接收不等于正式 PR 审核或本人接受。','small'));
  for(const entry of entries){const current=entry.currentMaterialMatches!==false,phase=entry.phase==='returned'?(current?'当前材料已有独立技术判断':'旧判断属于历史材料，当前不适用'):entry.controllerActive?'正在处理原接收请求':entry.phase==='not_started'?'当前材料尚未接收':'原接收已登记或结果待核';
    panel.append(el('strong',entry.investmentStopped?'当前范围已停止新增投入，原接收继续保留。':phase),el('p',entry.executionKind==='fixture'?'明确模型协议样例；非真实模型验收。':'使用已配置的原生接收入口。','small'));if(entry.eventSource?.some(s=>s.current===false))panel.append(el('p','来源当前不可核对，或H/B/目标已变化；请重新补查，必要时固定并验证新候选。旧报告继续保留。','small'));if(entry.problem)panel.append(el('p',receptionReason(entry.problem),'small'));
    const actions=el('div',null,'actions'),check=el('button','补查来源','outline');check.disabled=pendingReceptions.has(project+':'+entry.id);check.onclick=()=>receptionAction(entry,'check',project);actions.append(check);
    const start=el('button',entry.phase==='returned'?'查回当前原接收':'接收当前材料');start.disabled=!entry.available||entry.investmentStopped||entry.controllerActive||pendingReceptions.has(project+':'+entry.id);start.onclick=()=>receptionAction(entry,'start',project);actions.append(start);
    if(entry.operation&&entry.phase==='returned'){const report=el('button','查看原接收全文','outline');report.onclick=()=>openReport(task,{id:entry.operation});actions.append(report);}
    panel.append(actions);
  }return panel;
}
