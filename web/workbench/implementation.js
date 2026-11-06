// The normal project page supplies an adopted option and request identity.
// Paths, commands, permissions and native role remain with the trusted host.
const implementationProjects=new Map();
const implementationReason=value=>({reception_seats_full:'原队列席位正在占用；原请求已保留，席位释放后可继续原请求。',implementation_original_plan_changed:'原准备计划与固定输入不同，已保留原件并暂停。',implementation_original_input_changed:'原输入清单或初始文件树改变，不能继续发送。',implementation_initial_tree_changed:'原工作区或暂存内容已经改变，不能作为未发准备继续。',implementation_original_operation_must_be_read:'原操作含有准备之外的执行证据，请先核对原执行，不会重发。',writer_active_or_unknown:'工作区仍有写者占用或状态未知，不能开始新的写入。',fresh_original_held_resource_claim_required:'原资源领取未能确认为当前有效，等待原提供者核实。',implementation_issue_source_changed:'Issue 正文与审定版本不同，已暂停发送。请先核对采用的要求。',implementation_issue_not_adopted:'这张 Issue 还没有本入口可核对的审定依据。',implementation_original_responsibility_pending:'已有同一入口的任务尚未结束；请查看原请求。',implementation_original_resources_unresolved:'原执行的资源结果仍未核清，暂不启动下一项工作。',implementation_sent_or_unknown_never_resend:'原输入已发送或仍待核实；请查看原运行，不会另发一次。',implementation_stopped:'本次实施已请求停止，已有文件和原记录保留。',implementation_resource_binding_required:'当前资源账本还没有绑定这次实施，尚未启动。',implementation_original_catalog_changed:'本次请求采用的配置已经改变，原请求保留，不能静默换绑。',implementation_original_capture_changed:'原始捕获未能通过完整性核对，不能显示为完整成果。'}[value]||readableReason(value));
function implementationKey(){return gh.account&&gh.selected?gh.account.id+':'+gh.selected.id:null;}
function implementationData(){const key=implementationKey();if(!key)return null;if(!implementationProjects.has(key))implementationProjects.set(key,{loaded:false,loading:false,pending:false,error:null,options:[],entries:[]});return implementationProjects.get(key);}
async function loadImplementations(){
  const data=implementationData(),key=implementationKey();if(!data||data.loading)return;data.loading=true;
  try{const result=await api('/api/implementation');if(key!==implementationKey())return;Object.assign(data,result,{loaded:true,error:null});}
  catch(error){data.error=implementationReason(error.message);data.loaded=true;}
  finally{data.loading=false;if(key===implementationKey()&&view==='github')render();}
  if(key===implementationKey()&&data.entries.some(e=>e.requests.some(r=>r.controllerActive)))setTimeout(()=>{if(key===implementationKey())void loadImplementations();},1500);
}
async function implementationAction(entry,action,body){
  const response=await workspaceFetch('/api/implementation/'+encodeURIComponent(entry)+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'}),result=await response.json();
  if(!response.ok)throw new Error(result.error||'implementation_unavailable');return result;
}
async function startIssueWork(option,issue,expectedProject=implementationKey()){
  if(expectedProject!==implementationKey())return;
  const data=implementationData(),selected=implementationKey();if(!data||data.pending)return;data.pending=true;data.error=null;render();
  const requestId=crypto.randomUUID();
  try{await implementationAction(option.id,'prepare',{requestId,issueNumber:issue.number});if(selected!==implementationKey())return;await implementationAction(option.id,'start',{requestId});}
  catch(error){data.error=implementationReason(error.message);}
  finally{data.pending=false;if(selected===implementationKey())await loadImplementations();}
}
async function continueIssueWork(entry,request,action,expectedProject=implementationKey()){
  if(expectedProject!==implementationKey())return;
  const data=implementationData();if(!data||data.pending)return;data.pending=true;data.error=null;render();
  const selected=implementationKey();
  try{if(action==='prepare'){const prepared=await implementationAction(entry,'prepare',{requestId:request.id,issueNumber:request.issue});if(selected!==implementationKey()||prepared.phase!=='prepared'||prepared.stopped)return;await implementationAction(entry,'start',{requestId:request.id});}else await implementationAction(entry,action,{requestId:request.id});}catch(error){data.error=implementationReason(error.message);}finally{data.pending=false;if(selected===implementationKey())await loadImplementations();}
}
async function openImplementationReport(entry,request,expectedProject=implementationKey()){
  if(expectedProject!==implementationKey())return;
  const nonce=++reportNonce,project=implementationKey();$('report-title').textContent='Issue #'+request.issue+' · 实施成果';$('report-meta').textContent='读取原执行和完整成果…';$('report-body').textContent='';$('report-original').hidden=true;showWorkbenchReport();
  try{const result=await api('/api/implementation-report/'+encodeURIComponent(entry)+'/'+encodeURIComponent(request.id));if(nonce!==reportNonce||project!==implementationKey())return;
    $('report-meta').textContent=(result.status==='completed'?'实现与注册测试完成；尚未正式审核、发布或本人验收。':'原执行结果：'+(result.status==='no_change'?'核对完成，无需修改':result.status==='owner_decision_required'?'需要本人决定':result.status))+' 原提交 '+result.H0.slice(0,12)+(result.H1?' → 成果提交 '+result.H1.slice(0,12):'');
    $('report-body').textContent=result.report?.report||(result.observationOnly?'尚无可核对的完整报告；以下是保留工作区的只读差异观察，不表示原执行已结束。':'本请求在发送前撤回，未产生模型报告。');
    if(result.diff)$('report-body').textContent+='\n\n本次代码差异\n'+result.diff;
    if(result.tests){$('report-body').textContent+='\n\n注册测试：'+(result.tests.passed?'通过':'未通过')+'。'+(result.testCandidateBinding?'运行测试的文件内容及可执行标记已与成果提交核对；未推定不同提交的元信息等价。':'尚无成果提交与测试的完整绑定。');for(const tool of result.tests.tools||[])$('report-body').textContent+='\n\n'+tool.id+'\n'+(tool.stdout||'')+(tool.stderr?'\n错误输出\n'+tool.stderr:'');}
    $('report-raw').textContent=JSON.stringify(result,null,2);document.querySelector('#report-original summary').textContent='核对本次原结果、测试与提交绑定';$('report-original').hidden=false;
  }catch(error){if(nonce===reportNonce)$('report-body').textContent=readableReason(error.message);}
}
function implementationPanel(){
  const project=implementationKey(),data=implementationData(),panel=append(el('section',null,'panel'),el('h2','已审定 Issue 的受控实现'));
  if(!data)return panel;
  if(!data.loaded){panel.append(el('p','正在读取本项目已配置的实施范围…','small'));if(!data.loading)queueMicrotask(loadImplementations);return panel;}
  if(!data.available){panel.append(el('p','此项目尚未配置受控实施入口。现有任务和报告仍从原入口查看。','small'));return panel;}
  panel.append(el('p','选择一项已审定工作，从固定提交新建本次任务。程序在准确实施、测试权限和资源具备后执行；登记不表示已经发送。','small'));
  if(data.error)panel.append(el('p',data.error,'github-error'));
  for(const option of data.options){
    const entries=data.entries.find(e=>e.id===option.id)?.requests||[],unfinished=entries.some(r=>r.phase!=='returned');
    for(const issue of option.issues){const row=append(el('div',null,'report-row'),append(el('div'),el('strong','Issue #'+issue.number+' · '+issue.goal),el('p','从 '+option.H0.slice(0,12)+' 开始 · 获准修改：'+option.allowedPaths.join('、')+(option.executionKind==='fixture'?' · 明确模型协议样例':option.demonstrationFixture?' · Codex 实施，演练源项目':' · Codex 实施'),'small'))),button=el('button','新建本次工作');
      button.disabled=data.pending||unfinished;button.onclick=()=>startIssueWork(option,issue,project);row.append(button);panel.append(row);
    }
    for(const request of entries){const label=request.status==='completed'?'实现完成，待正式审核':request.status==='no_change'?'核对完成，无需修改':request.status==='owner_decision_required'?'需要本人决定':request.status==='cancelled_unstarted'?'已撤回，未发送':request.stopped?'已请求停止，沿原执行核对':request.controllerActive?'正在处理':request.phase==='active_or_unknown'?'原执行待核，不自动重发':request.phase==='prepared'?'已准备，待执行':'已登记，待补准备';
      const row=append(el('div',null,'report-row'),append(el('div'),el('strong',(request.supplement?'原任务补充 · Issue #':'Issue #')+request.issue+' · '+label),el('p',request.reason?implementationReason(request.reason):request.H1?'成果提交 '+request.H1.slice(0,12):'原材料和请求会保留。','small'))),actions=el('div',null,'actions');
      if(['registered','prepared'].includes(request.phase)&&!request.controllerActive&&!request.stopped){const start=el('button','继续原请求');start.disabled=data.pending;start.onclick=()=>continueIssueWork(option.id,request,request.phase==='registered'?'prepare':'start',project);actions.append(start);}
      if(['registered','prepared'].includes(request.phase)&&!request.controllerActive){const cancel=el('button','撤回未发请求','outline');cancel.disabled=data.pending;cancel.onclick=()=>continueIssueWork(option.id,request,'cancel',project);actions.append(cancel);}
      if(request.phase!=='returned'&&!request.stopped){const stop=el('button','停止本次实施','outline');stop.disabled=data.pending;stop.onclick=()=>continueIssueWork(option.id,request,'stop',project);actions.append(stop);}
      if(request.phase==='returned'||request.phase==='active_or_unknown'){const report=el('button',request.phase==='returned'?'查看原成果与全文':'查看保留现场','outline');report.onclick=()=>openImplementationReport(option.id,request,project);actions.append(report);}
      row.append(actions);panel.append(row);
    }
  }
  const refresh=el('button','刷新实施记录','outline');refresh.disabled=data.loading;refresh.onclick=()=>loadImplementations();panel.append(refresh);return panel;
}
