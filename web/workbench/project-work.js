// All three entry points open this same durable project work. These records
// describe preparation; actual execution and reports come from the old consumer.
const projectWorkProjects=new Map();
const projectWorkLabels={draft:'工作草案已保存',preparing:'同序正在调查并准备',prepared:'工程准备已完成，等待确认',authorizing:'正在核对本次批准',needs_input:'等待补齐条件',execution:'已交给原实施流程',waiting_return:'实施已有结果，等待接回项目',delivered:'完整成果已接回项目',no_change:'原核对未产生新提交'};
const projectWorkError=code=>({implementation_original_controller_active_or_unknown:'原控制程序仍在运行或状态未明，暂不发送实施任务。',implementation_first_send_baseline_not_unique:'原测试基线不能唯一核清，原件保留，暂不发送实施任务。',repair_index_file_type_unsupported:'原工作区的完整 Git 索引未通过检查；已有记录保留，不自动重新发送。','controlled_result_not_final:non_terminal_agent_message':'本次准备未通过严格的最终结果核验；原问题和捕获保留，不代表已形成可执行方案。',project_work_environment_changed_prepare_again:'登记的验证环境已变化，请沿原工作明确重新准备；原方案和捕获保留。',project_work_environment_probe_failed:'登记的隔离验证环境探测未完成，请先核对原环境；不会发送实施。',project_work_environment_original_unknown:'原验证环境探测是否结束尚未核清，保留原件，暂不新增准备。',project_work_stopped:'原工作已停止，原件保留。继续处理需明确重新核对这项工作。',project_work_repository_location_required:'先填写并保存这个项目的本机文件夹。草案已经保留。',project_work_repository_identity_mismatch:'这个文件夹的 GitHub 仓库与当前项目不符，请选择正确的项目文件夹。',project_work_repository_path_invalid:'没有找到有效的本机 Git 仓库，请核对文件夹位置。',project_work_source_fetch_failed:'尚未取得这次固定主干资料。请检查网络与现有 GitHub 登录后，继续准备同一工作。',project_work_repository_commit_required:'当前仓库没有可核对的固定提交，草案仍然保留。',project_work_local_owner_window_unavailable:'本机确认窗口未能打开，尚未批准或执行。请检查本机浏览器后重试。',project_work_source_changed_prepare_again:'Issue 或代码起点已变化，请重新准备这项工作。原材料和结果继续保留。',project_work_original_active_or_unknown:'原执行仍在处理或状态未明，先查看原执行；不会另发一次。',project_work_preparation_active_or_unknown:'原准备仍在运行或状态未明，请先刷新查回原记录。',project_work_preparation_interrupted:'前次准备没有完整结束，原件已保留。确认后可重新准备一个版本。',project_work_requirements_need_clarification:'准备发现尚待明确的事项，请看下方问题，补充目标后继续。',project_work_result_branch_changed:'成果分支已被其他操作移动，原成果仍保留；需要先核对该分支。',project_work_result_branch_in_use:'这条成果分支正在其他工作区使用，尚未改动它。',project_work_result_workspace_changed:'成果工作区有外部修改，已保留，尚未覆盖。',project_work_result_git_unknown:'上次成果接回是否结束仍未核清，原现场已保留，暂不新增接回动作。',project_work_owner_source_unknown:'批准评论发送结果尚未核清。继续只查回原评论，不会重复发布。',project_work_preparation_changed:'准备内容已变化，请刷新后核对当前版本。',project_work_owner_identity_not_configured:'当前账号与已登记的批准身份不符，尚未开始执行。',project_work_preparation_stopped:'已停止本次准备；原话与捕获保留。',project_work_previous_result_not_received:'请先接回原完整成果，再核对下一次准备。'}[code]||implementationReason(code));
function projectWorkKey(){return gh.account&&gh.selected?gh.account.id+':'+gh.selected.id+':'+gh.selected.nodeId:null;}
function projectWorkData(){const id=projectWorkKey();if(!id)return null;let d=projectWorkProjects.get(id);if(!d||d.epoch!==gh.epoch){d={epoch:gh.epoch,ready:false,loading:false,pending:false,works:[],settings:null,selected:null,detail:null,error:null,actionError:null,issue:'',goal:'',repositoryPath:'',createId:crypto.randomUUID(),newWork:false,requestedIssue:null,composing:false};projectWorkProjects.set(id,d);}return d;}
async function projectWorkPost(path,body){const r=await workspaceFetch('/api/project-work'+path,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||'project_work_unavailable');return j;}
async function loadProjectWorks(detail=false){
  const d=projectWorkData(),identity=projectWorkKey(),epoch=gh.epoch,current=()=>identity===projectWorkKey()&&epoch===gh.epoch;if(!d||d.loading)return;d.loading=true;
  try{const value=await api('/api/project-work');if(!current())return;Object.assign(d,value,{ready:true,error:null});
    if(!d.repositoryPath&&value.settings)d.repositoryPath=value.settings.repositoryPath;
    if(!d.selected&&!d.newWork){const conversation=chatData()?.conversationId;d.selected=d.requestedIssue!==null?value.works.find(w=>w.issue.number===d.requestedIssue)?.id??null:value.works.find(w=>w.conversationId===conversation)?.id??value.works[0]?.id??null;}
    const summary=value.works.find(w=>w.id===d.selected),signature=JSON.stringify([summary?.updatedAt,summary?.execution?.phase,summary?.execution?.status,summary?.execution?.H1]);
    if(d.selected&&(detail||signature!==d.detailSignature)){const result=await api('/api/project-work/'+d.selected);if(!current()||d.selected!==result.draft.id)return;d.detail=result;d.detailSignature=signature;if(!d.goalEdited)d.goal=result.draft.draftGoal??result.draft.goal;}
  }catch(e){if(current()){d.error=projectWorkError(e.message);d.ready=true;}}
  finally{d.loading=false;if(current()&&!d.composing)render();}
  if(current()&&(d.works.some(w=>w.active||w.execution?.controllerActive)||(d.ownerPending||[]).length))setTimeout(()=>{if(current())void loadProjectWorks();},1500);
}
async function projectWorkAction(action){
  const d=projectWorkData(),identity=projectWorkKey(),epoch=gh.epoch,current=()=>identity===projectWorkKey()&&epoch===gh.epoch;if(!d||d.pending)return;d.pending=true;d.actionError=null;render();
  try{await action(d,current);if(!current())return;await loadProjectWorks(true);if(current())void loadProjectChat();}
  catch(e){if(current())d.actionError=projectWorkError(e.message);}
  finally{d.pending=false;if(current())render();}
}
function openProjectWork(number=null,id=null){
  const d=projectWorkData();if(!d)return;if($('report-dialog').open)$('report-dialog').close();
  if(number!==null){d.issue=String(number);const existing=d.works.find(w=>w.issue.number===number);d.selected=existing?.id??null;d.detail=null;d.detailSignature=null;d.goal='';d.goalEdited=false;d.newWork=false;}
  if(id){d.selected=id;d.detail=null;d.detailSignature=null;d.goalEdited=false;d.newWork=false;}
  d.requestedIssue=id?null:number;view='project-work';render();void loadProjectWorks(true);
}
function projectWorkLauncher(){
  const panel=append(el('section',null,'panel'),el('h2','在这个项目中处理工作'),el('p','从一条 Issue 开始。同序调查材料、准备实施，并把完整成果接回这个项目。','small'));
  if(!entryInfo?.projectWork){panel.append(el('p','此设备尚未启用项目工作准备；已有任务与报告仍可查看。','small'));return panel;}
  const d=projectWorkData(),start=el('button','从 Issue 开始一项工作');start.onclick=()=>openProjectWork();panel.append(start);
  if(d&&!d.ready&&!d.loading)queueMicrotask(()=>loadProjectWorks());
  if(d?.error)panel.append(el('p',d.error,'github-error'));
  for(const w of d?.works.slice(0,5)||[]){const button=el('button','Issue #'+w.issue.number+' · '+projectWorkLabels[w.stage],'outline');button.onclick=()=>openProjectWork(null,w.id);panel.append(button);}return panel;
}
function renderProjectWork(){
  const d=projectWorkData();if(!d||d.composing)return;
  const focus=document.activeElement,caret=focus&&['work-goal','work-repository','work-issue'].includes(focus.id)?{id:focus.id,start:focus.selectionStart,end:focus.selectionEnd}:null;
  renderGithub();const page=append(el('div'),intro(gh.selected.fullName+' · 项目工作','保存准备、实际执行和完整成果分别保留；切换或刷新不会重复发送。'));
  const back=el('button','返回 Issues 与 PR','outline');back.onclick=()=>enterView('github');page.append(back);
  if(!d.ready){page.append(el('p','正在读取原工作…'));$('content').replaceChildren(page);if(!d.loading)queueMicrotask(()=>loadProjectWorks(true));return;}
  if(d.ownerPending?.length)page.append(el('p','已在本机浏览器打开本人确认窗口。请在那里核对并确认；这里会自动读取后续进度。','note-card'));
  if(d.actionError||d.error)page.append(el('p',d.actionError||d.error,'github-error'));
  const setup=append(el('section',null,'panel'),el('h2',d.settings?.verified===false?'项目位置已保存，等待核对':d.settings?'项目设置（已保存，可复用）':'首次设置：本机项目文件夹'),el('p','只需为这个项目设置一次。同序核对仓库身份，使用固定提交准备独立工作区，不覆盖你当前未提交的工作。','small'));
  const path=el('input');path.id='work-repository';path.value=d.repositoryPath;path.placeholder='填写本机 Git 项目文件夹的绝对路径';path.oninput=()=>{d.repositoryPath=path.value;};const save=el('button','保存并核对项目位置');save.disabled=d.pending;save.onclick=()=>projectWorkAction(x=>projectWorkPost('/settings',{repositoryPath:x.repositoryPath}));setup.append(append(el('label','本机项目文件夹'),path),save);if(d.settings?.problem)setup.append(el('p',projectWorkError(d.settings.problem),'github-error'));page.append(setup);
  const choose=append(el('section',null,'panel'),el('h2','选择一项 Issue 工作')),number=el('input');number.id='work-issue';number.type='number';number.min='1';number.value=d.issue;number.oninput=()=>{d.issue=number.value;};choose.append(append(el('label','Issue 编号'),number));
  const create=el('button',d.newWork?'保存一次新的工作':'保存或打开这项工作');create.disabled=d.pending;create.onclick=()=>projectWorkAction(async(x,current)=>{const chat=chatData(),conversationId=chat?.conversationId||crypto.randomUUID(),work=await projectWorkPost('/create',{requestId:x.createId,conversationId,issueNumber:Number(x.issue),goal:x.newWork?'':x.goal,newWork:x.newWork});if(!current())return;x.selected=work.id;x.newWork=false;x.createId=crypto.randomUUID();x.goalEdited=false;if(chat&&chat.conversationId!==work.conversationId)chooseProjectConversation(work.conversationId);});choose.append(create);
  for(const w of d.works){const open=el('button','打开 #'+w.issue.number+' '+w.issue.title,'quiet');open.onclick=()=>openProjectWork(null,w.id);choose.append(open);}page.append(choose);
  const item=d.detail?.draft;
  if(item&&item.id===d.selected){
    const current=d.works.find(w=>w.id===item.id),active=!!(current?.active||current?.execution?.controllerActive),section=append(el('section',null,'panel'),el('h2','Issue #'+item.issue.number+' · '+item.issue.title),el('p',projectWorkLabels[current?.stage||item.stage]||item.stage));
    if(current?.problem||item.problem)section.append(el('p',projectWorkError(current?.problem||item.problem),'github-error'));
    const goal=el('textarea');goal.id='work-goal';goal.rows=4;goal.maxLength=2048;goal.value=d.goal;goal.placeholder='补充希望得到的结果或必须保留的行为；无需列出工程文件和命令。';goal.oninput=()=>{d.goal=goal.value;d.goalEdited=true;};goal.oncompositionstart=()=>{d.composing=true;};goal.oncompositionend=()=>{d.composing=false;};section.append(append(el('label','本次目标与必要补充'),goal));if(item.draftGoal!=null)section.append(el('p','补充原话已保留为待准备草案；下方范围仍属于原版本，重新准备完成前不会采用这些补充。','small'));
    const prepare=el('button',item.preparation?'重新核对并准备':'让同序准备这项工作');prepare.disabled=d.pending||active;prepare.onclick=()=>projectWorkAction(x=>projectWorkPost('/'+item.id+'/prepare',{goal:x.goal}));section.append(prepare);
    const showDiagnostic=(diagnostic,label)=>{if(!diagnostic)return;const box=append(el('section',null,'note-card'),el('h3',label+' · 未接受的准备问题'),el('p','原准备未通过严格解析；以下仅为原过程提出的问题，不是已接受方案或批准。'));for(const q of diagnostic.questions)box.append(el('p',q,'github-error'));if(diagnostic.source)box.append(append(el('details'),el('summary','查看原问题来源（只读）'),el('p','原输入：'+diagnostic.source.inputSha256),el('p','原输出：'+diagnostic.source.stdoutSha256),el('p','原轮次：'+diagnostic.source.turnId)));box.append(el('p',diagnostic.nextStep,'small'));section.append(box);};
    showDiagnostic(d.detail.preparationDiagnostic,'本版本');for(const old of d.detail.history||[])showDiagnostic(old.preparationDiagnostic,'历史版本 '+old.version);
    const proposal=item.preparation?.proposal;
    if(proposal){section.append(el('h3','同序提出的工作范围'),el('p',proposal.goal),el('p','验证目标：'+proposal.validation.description));for(const line of proposal.acceptance)section.append(el('p','完成标准：'+line));for(const q of proposal.questions)section.append(el('p','需要明确：'+q,'github-error'));
      const details=append(el('details'),el('summary','查看文件范围、验证建议和准备依据'),el('p','拟修改：'+proposal.allowedPaths.join('、')),el('p','只读材料与测试：'+proposal.protectedPaths.join('、')),el('pre',proposal.validation.script),el('p',proposal.report));section.append(details);
      if(!item.catalog&&!item.stopRequested&&!proposal.questions.length&&['prepared','authorizing'].includes(item.stage)){section.append(el('p','确认后，程序将把本次范围及实施／测试批准记录到这条 Issue，核对来源后执行。使用现有订阅；不包含合并、部署或重置。','small'));const start=el('button',item.stage==='authorizing'?'核对原批准并继续原工作':'请本人确认范围并开始');start.disabled=d.pending||active;start.onclick=()=>projectWorkAction(()=>projectWorkPost('/'+item.id+'/start',{version:item.version,proposalSha256:item.preparation.proposalSha256||item.preparation.proposalDigest}));section.append(start);}
    }
    if(current?.execution?.reason&&!active)section.append(el('p',projectWorkError(current.execution.reason),'github-error'));
    if(item.catalog&&!item.stopRequested&&!active&&d.detail.firstInputContinuation?.eligible){const first=el('button','继续原工作的首次输入');first.disabled=d.pending;first.onclick=()=>projectWorkAction(()=>projectWorkPost('/'+item.id+'/continue-first-input',{}));section.append(first);}
    if(item.catalog&&!item.stopRequested&&!active&&['registered','prepared'].includes(current?.execution?.phase)){const resume=el('button','继续原工作');resume.onclick=()=>projectWorkAction(()=>projectWorkPost('/'+item.id+'/start',{version:item.version,proposalSha256:item.preparation.proposalSha256||item.preparation.proposalDigest}));section.append(resume);}
    if(active){const stop=el('button','停止这项工作的后续动作','outline');stop.onclick=()=>projectWorkAction(()=>projectWorkPost('/'+item.id+'/stop',{}));section.append(stop);}
    if((current?.stage||item.stage)==='waiting_return'){const receive=el('button','继续接回原成果');receive.disabled=d.pending;receive.onclick=()=>projectWorkAction(()=>projectWorkPost('/'+item.id+'/receive',{}));section.append(receive);}
    const delivery=current?.delivery||item.delivery;if(delivery){section.append(el('h3',delivery.status==='received'?'真实项目成果':'成果接回状态'),el('p','分支：'+delivery.branch),el('p','提交：'+delivery.H),el('p','成果工作区：'+delivery.workspace));if(delivery.status==='received')section.append(el('p','实现与测试结果已接回；正式审核、合并、启用和本人成果接受仍分别办理。','small'));}
    for(const result of d.detail.execution?.reports||[]){const report=append(el('details',null,'panel'),el('summary',(result.requestId===item.requestId?'原实施':'原任务补充')+' · 完整报告与实际改动'),el('div',result.report?.report||'','chat-text'),el('pre',result.diff||''),el('p',result.tests?'实际注册测试：'+(result.tests.passed?'通过':'未通过'):'本记录没有成功测试声明'));section.append(report);}
    if(d.detail.execution?.reports?.length){const supplement=el('button','在原对话中提出补充','outline');supplement.onclick=()=>openWorkSupplement(item);section.append(supplement);}
    const fresh=el('button','为这条 Issue 再新建一次工作','outline');fresh.disabled=d.pending||active;fresh.onclick=()=>{d.issue=String(item.issue.number);d.selected=null;d.detail=null;d.goal='';d.goalEdited=false;d.newWork=true;d.createId=crypto.randomUUID();render();};section.append(fresh);page.append(section);
  }
  const refresh=el('button','刷新原工作记录','outline');refresh.disabled=d.loading;refresh.onclick=()=>loadProjectWorks(true);page.append(refresh);$('content').replaceChildren(page);
  if(caret){const input=$(caret.id);if(input){input.focus({preventScroll:true});if(caret.start!==null&&input.type!=='number')input.setSelectionRange(caret.start,caret.end);}}
}

async function openWorkSupplement(item){
  const identity=projectWorkKey(),epoch=gh.epoch;
  try{const result=await api('/api/project-secretary');if(identity!==projectWorkKey()||epoch!==gh.epoch)return;
    const target=(result.supplementTargets||[]).find(t=>t.source===item.source&&t.requestId===item.requestId);if(!target)throw new Error('project_supplement_target_not_registered');
    chooseProjectConversation(item.conversationId);const data=chatData();data.supplementTargets=result.supplementTargets;const {title,...selected}=target,draft=chatDraft(data);draft.target=JSON.stringify(selected);draft.requestId=crypto.randomUUID();setSecretaryOpen(true);renderProjectChat();
  }catch(e){if(identity===projectWorkKey()&&epoch===gh.epoch){projectWorkData().actionError=projectWorkError(e.message);render();}}
}
