// Loaded with the workbench. Project context, access key and native boundaries
// are owned by the existing host; this page supplies only conversational input.
const projectChats=new Map();let chatRefresh=null;
const secretaryMedia=typeof matchMedia==='function'?matchMedia('(max-width:1120px)'):null;
let secretaryOpen=!secretaryMedia?.matches;
function setSecretaryOpen(open,focus=true){
  secretaryOpen=open;renderProjectChat();
  if(open){const data=chatData();if(data&&!data.ready&&!data.loading)void loadProjectChat();if(focus)$('project-chat-input')?.focus({preventScroll:true});}
  else if(focus)$('secretary-toggle').focus({preventScroll:true});
}
function secretaryChrome(){
  const enabled=!!entryInfo?.githubProjects,dock=$('secretary-dock'),toggle=$('secretary-toggle'),data=chatData();
  document.body.classList.toggle('with-secretary',enabled);document.body.classList.toggle('secretary-open',enabled&&secretaryOpen);
  dock.hidden=!enabled||!secretaryOpen;toggle.hidden=!enabled||secretaryOpen;toggle.setAttribute('aria-expanded',String(enabled&&secretaryOpen));
  toggle.textContent=data?.busy?.length?'秘书处理中…':'工作秘书';toggle.setAttribute('aria-label',data?.busy?.length?'展开工作秘书，查看正在处理的对话':'展开工作秘书');
  $('secretary-project').textContent=gh.selected?.fullName||'选择项目后开始对话';$('secretary-refresh').disabled=!data||data.loading;
  if(!dock.dataset.bound){dock.dataset.bound='true';toggle.onclick=()=>setSecretaryOpen(true);$('secretary-close').onclick=()=>setSecretaryOpen(false);$('secretary-refresh').onclick=()=>loadProjectChat();dock.onkeydown=e=>{if(e.key==='Escape'&&!e.isComposing&&secretaryMedia?.matches){setSecretaryOpen(false);e.preventDefault();}};secretaryMedia?.addEventListener('change',e=>setSecretaryOpen(!e.matches,false));}
  return enabled&&secretaryOpen;
}
const chatKey=()=>gh.account&&gh.selected?gh.account.id+':'+gh.selected.id:null;
function chatData(){const key=chatKey();if(!key)return null;if(!projectChats.has(key))projectChats.set(key,{conversationId:null,conversations:[],messages:[],busy:[],drafts:new Map(),loading:false,ready:false,available:false,error:null,submitting:false,version:0,selectionVersion:0,reloadRequested:false,initialLoaded:false,userSelected:false});return projectChats.get(key);}
function chatDraft(data){if(!data.conversationId)data.conversationId=crypto.randomUUID();if(!data.drafts.has(data.conversationId))data.drafts.set(data.conversationId,{question:'',requestId:crypto.randomUUID()});return data.drafts.get(data.conversationId);}
const chatError=e=>({native_turn_interrupted:'本轮已中断，未形成完整回答；原问题与原始记录保留。',executor_wait_timeout:'本轮达到等待上限，未取得完整回答；原问题和不完整输出已保留，不会自动重发。',executor_rpc_timeout:'与本机 AI 工具的通信等待超时，原请求保留；请核对原运行状态，不会自动重发。',project_chat_not_configured:'本机尚未配置项目秘书执行入口。已有项目与报告仍可查看。',project_chat_reply_pending:'本项目已有一轮在处理，请先查看其结果或停止该轮。',project_chat_parent_changed:'对话已有新记录，请刷新后继续。',project_chat_request_changed:'这条请求已经保存，不能换成另一个问题。',project_chat_context_limit:'这段对话已达到可完整传递的长度，请新开对话；原全文会保留。',project_chat_history_limit:'项目对话历史已达到当前容量，请继续已有对话。',ordinary_usage_unavailable:'当前订阅内可用限额不足，未切换付费渠道。请稍后再发起新问题。',included_subscription_not_confirmed:'当前Codex订阅登录未能确认，请先核对本机登录。',api_billing_override_present:'检测到API计费覆盖，当前入口已停止发送。请先核对运行配置。',project_chat_stopped:'本轮已停止，原问题和捕获记录保留。',project_chat_process_unknown:'原执行的进程记录尚未核清，保留等待；不会发起新一轮。',project_chat_controller_ended_before_launch:'原入口在发送前结束了；原问题保留，可明确发起新问题。',project_chat_original_incomplete:'原执行已结束，但没有取得完整回答；原记录保留，不会自动重发。',project_chat_material_limit:'本轮材料超过可完整读取的范围，请把问题限定到具体Issue、PR或报告。',project_chat_execution_incomplete:'本轮未取得完整回答，原记录已经保留。'}[e?.message??e]||githubErrors[e?.message??e]||readableReason(e?.message??e));
function chooseProjectConversation(id){const data=chatData();if(!data)return;data.userSelected=true;data.conversationId=id;data.selectionVersion++;data.messages=[];data.error=null;renderProjectChat();void loadProjectChat();}
async function loadProjectChat(){
  const data=chatData(),epoch=gh.epoch;if(!data)return;if(data.loading){data.reloadRequested=true;return;}const selection=data.selectionVersion;data.loading=true;data.reloadRequested=false;data.error=null;renderProjectChat();
  try{const result=await api('/api/project-secretary');if(epoch!==gh.epoch)return;Object.assign(data,{available:result.available,ready:true,conversations:result.conversations||[],busy:result.busy||[],executionKind:result.executionKind,aiChoice:result.aiChoice??null,aiDefault:result.aiDefault??null,timeoutMs:result.timeoutMs??null});if(!result.available){data.error=chatError(result.reason);return;}
    if(selection!==data.selectionVersion)return;
    if(!data.initialLoaded){if(!data.userSelected&&!data.composing&&!chatDraft(data).question)data.conversationId=data.conversations[0]?.id??data.conversationId;data.initialLoaded=true;}
    if(!data.conversationId)data.conversationId=crypto.randomUUID();
    if(data.conversations.some(c=>c.id===data.conversationId)){const requested=data.conversationId,conversation=await api('/api/project-secretary/conversations/'+requested);if(epoch!==gh.epoch||selection!==data.selectionVersion||data.conversationId!==requested)return;data.messages=conversation.messages;}else data.messages=[];
    const draft=chatDraft(data);if(data.messages.some(m=>m.id===draft.requestId&&m.question===draft.question)){draft.question='';draft.requestId=crypto.randomUUID();}
  }catch(e){if(epoch===gh.epoch&&selection===data.selectionVersion)data.error=chatError(e);}finally{data.loading=false;if(chatData()===data){renderProjectChat();if(chatRefresh!==null)clearTimeout(chatRefresh);chatRefresh=null;if(data.reloadRequested||epoch!==gh.epoch||selection!==data.selectionVersion){data.reloadRequested=false;void loadProjectChat();}else chatRefresh=data.busy.length?setTimeout(loadProjectChat,1500):null;}}
}
async function sendProjectChat(){
  const data=chatData(),draft=data&&chatDraft(data),epoch=gh.epoch;if(!data||!draft.question.trim()||data.submitting||data.loading||data.busy.length)return;
  const body={conversationId:data.conversationId,requestId:draft.requestId,parent:data.messages.at(-1)?.id??null,question:draft.question};data.submitting=true;data.error=null;renderProjectChat();
  try{const response=await workspaceFetch('/api/project-secretary/ask',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'}),result=await response.json();if(!response.ok)throw new Error(result.error||'project_chat_execution_incomplete');await loadProjectChat();}
  catch(e){if(epoch===gh.epoch){const problem=chatError(e);await loadProjectChat();if(epoch===gh.epoch)data.error=problem;}}
  finally{data.submitting=false;if(epoch===gh.epoch)renderProjectChat();}
}
async function stopProjectChat(id){const data=chatData(),epoch=gh.epoch;if(!data)return;try{const r=await workspaceFetch('/api/project-secretary/stop',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({requestId:id}),cache:'no-store'}),v=await r.json();if(!r.ok)throw new Error(v.error);await loadProjectChat();}catch(e){if(epoch===gh.epoch){data.error=chatError(e);renderProjectChat();}}}
function renderProjectChat(){
  if(!secretaryChrome())return;const host=$('secretary-dock-content'),data=chatData();if(!data){if(host.dataset.project!=='none'){host.replaceChildren(el('p','先选择一个 GitHub 项目，秘书会围绕该项目与你沟通。','empty'));host.dataset.project='none';}return;}
  const draft=chatDraft(data),identity=chatKey()+':'+data.conversationId;let root=$('project-chat-root');
  if(!root||root.dataset.chat!==identity){
    root=el('div',null,'project-chat');root.id='project-chat-root';root.dataset.chat=identity;
    const toolbar=el('div',null,'chat-toolbar'),label=el('label','对话历史'),select=el('select');select.id='project-chat-history';select.setAttribute('aria-label','对话历史');select.onchange=()=>chooseProjectConversation(select.value);label.append(select);
    const fresh=el('button','新对话','outline');fresh.type='button';fresh.onclick=()=>chooseProjectConversation(crypto.randomUUID());append(toolbar,label,fresh);root.append(toolbar);const modelRow=el('div',null,'chat-model-row'),selectedAI=el('p',null,'small');selectedAI.id='project-chat-ai';const settings=el('button','设置','quiet');settings.type='button';settings.setAttribute('aria-label','设置秘书的模型');settings.onclick=()=>enterView('ai-settings');append(modelRow,selectedAI,settings);root.append(modelRow);
    const info=el('p',null,'chat-notice');info.id='project-chat-notice';info.setAttribute('role','status');root.append(info);
    const lines=el('section',null,'chat-lines');lines.id='project-chat-lines';lines.setAttribute('aria-label','对话消息');lines.tabIndex=0;root.append(lines);
    const form=el('form',null,'chat-composer'),prompt=el('label','向项目秘书提问'),input=el('textarea');input.id='project-chat-input';input.rows=3;input.maxLength=8192;input.placeholder='边看边问，例如：这个项目下一步需要处理什么？';input.value=draft.question;prompt.htmlFor=input.id;
    input.oncompositionstart=()=>{data.composing=true;};input.oncompositionend=()=>{data.composing=false;};
    input.oninput=()=>{const d=chatDraft(data);d.question=input.value;d.requestId=crypto.randomUUID();};const send=el('button','发送','primary');send.id='project-chat-send';send.type='submit';form.onsubmit=e=>{e.preventDefault();void sendProjectChat();};const limit=el('p',null,'small');limit.id='project-chat-limit';append(form,prompt,input,append(el('div',null,'chat-send-row'),limit,send));root.append(form);
    const history=el('details',null,'panel');history.append(el('summary','原任务历史与跟进'));const open=el('button','读取原任务的历史与跟进','outline');open.type='button';open.onclick=async()=>{const epoch=gh.epoch;try{const snapshot=await api('/api/state');if(epoch!==gh.epoch)return;state=snapshot;const list=el('div');for(const s of snapshot.secretaries||[])for(const q of s.questions||[]){const row=append(el('div',null,'report-row'),el('strong',q.question));if(q.phase==='completed'){const read=el('button','查看完整回答','outline');read.type='button';read.onclick=()=>openSecretaryReport(s.source,q);row.append(read);}else row.append(el('p',questionPhases[q.phase]||q.phase,'small'));list.append(row);}if(!list.children.length)list.append(el('p','本项目尚无原任务秘书的历史回答。','empty'));appendSecretaryFollowups(list);history.replaceChildren(el('summary','原任务历史与跟进'),list);history.open=true;}catch(e){data.error=chatError(e);renderProjectChat();}};history.append(open);root.append(history);host.replaceChildren(root);host.dataset.project=chatKey();
  }
  const select=$('project-chat-history'),options=JSON.stringify([data.conversationId,data.conversations.map(c=>[c.id,c.title])]);if(select.dataset.options!==options){select.replaceChildren();if(!data.conversations.some(c=>c.id===data.conversationId)){const option=el('option','新对话');option.value=data.conversationId;select.append(option);}for(const c of data.conversations){const option=el('option',c.title);option.value=c.id;select.append(option);}select.value=data.conversationId;select.dataset.options=options;}
  const chatNotice=data.error||(!data.ready?'正在读取项目对话…':data.executionKind==='fixture'?'明确测试样例，不是真实模型回答。':data.busy.some(b=>b.status==='unknown')?'原执行状态尚未核清，保留等待；不会发起新的模型输入。':data.busy.length?'秘书正在处理，你可以继续查看左侧内容。':'可以继续追问。对话保存在当前项目中，刷新或重开不会重复发送。');if($('project-chat-notice').textContent!==chatNotice)$('project-chat-notice').textContent=chatNotice;
  const signature=JSON.stringify(data.messages.map(m=>[m.id,m.status,m.problem,m.receipt?.reportSha256,m.active,m.owned]));const lines=$('project-chat-lines');if(lines.dataset.messages!==signature){const followBottom=lines.scrollHeight-lines.scrollTop-lines.clientHeight<80;lines.replaceChildren();for(const m of data.messages){const user=append(el('article',null,'chat-message chat-user'),el('strong','你'),el('p',m.question,'chat-text'),el('small',date(m.createdAt)));lines.append(user);const answer=append(el('article',null,'chat-message chat-assistant'),el('strong','工作秘书'));
      if(m.status==='completed'){append(answer,el('div',m.answer,'chat-text'));const detail=append(el('details'),el('summary','查看来源与运行记录'),el('pre',JSON.stringify(m.receipt,null,2),'chat-evidence'));answer.append(detail);}
      else{answer.append(el('p',m.active?'正在读取资料并回答…':chatError(m.problem||'project_chat_execution_incomplete'),'small'));if(m.owned){const stop=el('button','停止本轮','outline');stop.type='button';stop.onclick=()=>stopProjectChat(m.id);answer.append(stop);}}
      lines.append(answer);
    }if(!data.messages.length)lines.append(el('p','可以直接提问，不需要先登记开发任务。','empty'));lines.dataset.messages=signature;if(followBottom)lines.scrollTop=lines.scrollHeight;}
  $('project-chat-ai').textContent=data.aiChoice?(data.aiChoice.tool==='claude'?'Claude':'Codex')+' · '+(data.aiChoice.resolvedModel||data.aiChoice.model)+' · '+(data.aiChoice.effort||'默认强度'):data.aiDefault?'默认：Codex · '+(data.aiDefault.observed?.model||'模型待检测')+' · '+(data.aiDefault.observed?.effort||'强度由程序决定'):'默认配置尚未读取';
  $('project-chat-ai').title=data.aiChoice?'本项目角色选择；实际运行各自保存原记录':'来源：本机项目秘书启动配置；显示最近检测结果，可在设置中重新检测。';
  $('project-chat-limit').textContent='订阅内限额'+(data.timeoutMs?' · 最长 '+Math.ceil(data.timeoutMs/60000)+' 分钟':'')+' · 只读';
  const input=$('project-chat-input');if(input.value!==draft.question&&document.activeElement!==input)input.value=draft.question;input.disabled=data.submitting||data.ready&&!data.available;$('project-chat-send').disabled=!data.ready||!data.available||data.loading||data.submitting||data.busy.length>0;$('project-chat-send').textContent=data.submitting?'正在提交…':'发送';
}
