#!/usr/bin/env python3
"""Build the offline v2.3 UI. The base remains the reviewed v2.2 prototype.
Default builds from repository sources. --base-v22 verifies the exact previously
published standalone file, for a runtime without network/clone access.
No model, server, credentials or production actions are included.
"""
from pathlib import Path
import argparse, hashlib, importlib.util
ROOT=Path(__file__).resolve().parent
BASE_SHA256='9a65058a827a8d34c038befe53e4a6caca41cb53bcbb58b65539097e729001e7'

def extend(text: str) -> str:
    def once(old: str, new: str):
        nonlocal text
        if text.count(old)!=1: raise ValueError('Expected exactly one reviewed anchor: '+old[:70])
        text=text.replace(old,new,1)
    once("const STORE='tongxu-product-ui-v22';", "const STORE='tongxu-product-ui-v23';")
    once('schema:5,coord:coordSeed()', 'schema:6,control:controlSeed(),coord:coordSeed()')
    once('raw?.schema===5&&raw.coord','raw?.schema===6&&raw.control&&raw.coord')
    once('<title>同序 · 工作秘书与协作工作台 v2.2</title>','<title>同序 · 人掌控目标，Agent 交付 · v2.3</title>')
    once("const titles={secretary:","const titles={'control-review':'复盘与抽查','control-decisions':'决定与委托依据',secretary:")
    once('({secretary:renderSecretary,',"({'control-review':controlReviewPage,'control-decisions':controlDecisionPage,secretary:renderSecretary,")
    once('const actions={', (ROOT/'control_v23.js').read_text()+'\nconst actions={\n ...governanceActions,')
    once("['总览进度','新增历史导出','优先收尾','催接收']", "['总览进度','新增历史导出','串行推进','收回控制','复盘抽查','优先收尾','催接收']")
    once('</style>',(ROOT/'control_v23.css').read_text()+'\n</style>')
    once('window.__tongxuUI=',r"""
const v22Secretary=renderSecretary;renderSecretary=function(){return controlHome()+'<div class="control-secretary">'+v22Secretary()+'</div>';};
const v22SecretarySend=secretarySend;secretarySend=function(text){
 const v=String(text||'').trim(),fixed={'本批目标':'boundary','串行推进':'organization','收回控制':'limits','成果验收':'delivery','复盘抽查':'review'};
 if(!s.coord.secretaryOnline)return toast('秘书离线；你仍可直接使用五项控制。','alert');
 if(fixed[v]){secretarySay('user',v);secretarySay('secretary','我已打开对应控制，尚未替你作出决定。本人确认与代理转录分开。');render();return governanceActions['control-open'](fixed[v]);}
 if(/^(总览进度|项目状态)$/.test(v)){secretarySay('user',v);secretarySay('secretary','本批 '+s.control.boundary.id+'：'+(s.control.boundary.state==='adopted'?'边界已采用（模拟）':'等待你采用目标')+'。'+(s.coord.delivery?.accepted?'用户场景已登记通过，启用仍独立。':'还没有当前用户场景通过的证据。')+' 技术缺陷与补证据由负责人处理；需要你的是越界取舍，不是所有 PR 待办。');return render();}
 return v22SecretarySend(v);
};
const v22CoordWriteAllowed=coordWriteAllowed;coordWriteAllowed=function(){return v22CoordWriteAllowed()&&controlGate(70).ok;};
const v22Dispatch=dispatch;dispatch=function(id,mode,workspace){const g=controlGate(id);if(!g.ok){toast(g.reason,'alert');return false;}if(+id===70&&s.control.organization.mode==='unified'){if(!v22CoordWriteAllowed())return false;const t=T(70),a=S('cx-A');if(t.owner||t.pending||pending('dispatch',70)||!a||['unknown','terminated'].includes(a.state))return false;t.owner=a.id;t.mode='joined';if(!a.tasks.includes(70))a.tasks.push(70);a.todos.push('X1／70：按采用边界顺序实施');const op=operation('dispatch',70,'统一到已有 A；仅排入待办');finish(op,'已加入原负责人待办（模拟），没有创建会话或声称开始运行');render();return true;}return v22Dispatch(id,mode,workspace);};
const v22Permission=permission;permission=function(p,action='merge'){if(action==='merge'&&s.control.stopMerge)return {ok:false,label:'新合并已停止',detail:'本人已收回新合并；已发送操作继续核查。'};if(action==='merge'&&s.coord.delivery?.members.includes(p.id)&&s.control.stoppedBatches.includes('X1'))return {ok:false,label:'本批已停止投入',detail:'保留已发生结果，不开始本批新合入。'};return v22Permission(p,action);};
const v22Requirements=requirements;requirements=function(p){const list=v22Requirements(p);if(s.coord.delivery?.members.includes(p.id))list.unshift({id:'owner-boundary',title:'本批目标已由本人采用',ok:s.control.boundary.state==='adopted',detail:'技术反馈不能代替成果／费用／权限边界的采用。'});return list;};
const v22CheckAction=checkAction;checkAction=function(p,c){if(c.id==='owner-boundary')return btn('查看本批目标','control-open','boundary','ghost sm');return v22CheckAction(p,c);};
const v22CoordRender=renderCoordination;renderCoordination=function(){return '<div class="row wrap" style="margin-bottom:16px">'+btn('本批目标与技术约定','control-open','boundary','soft')+btn('并行／串行／统一负责人','control-open','organization')+btn('记录范围内技术约定（模拟）','control-tech','','ghost sm')+'</div>'+v22CoordRender();};
const v22Fix=fixModal;fixModal=function(p){const g=controlGate(p.issue);if(!g.ok)return toast(g.reason,'alert');return v22Fix(p);};
const v22FixConfirm=actions['fix-confirm'];actions['fix-confirm']=id=>{const p=P(+id),g=controlGate(p.issue);if(!g.ok)return formError(g.reason);return v22FixConfirm(id);};
const v22Resume=actions['sec-resume-work'];actions['sec-resume-work']=()=>{if(s.control.stopNew)return toast('这是本人停止的新实施；请从本人控制入口恢复。','alert');return v22Resume();};
window.__tongxuUI=""")
    once('snapshot:()=>clone(s),secretaryAllowed,', 'snapshot:()=>clone(s),controlOwner,controlGate,controlTechnical,controlOutcome,secretaryAllowed,')
    return text

def build(base_v22: Path|None=None) -> str:
    if base_v22:
        data=base_v22.read_bytes()
        if hashlib.sha256(data).hexdigest()!=BASE_SHA256: raise ValueError('Base v2.2 identity mismatch')
        base=data.decode('utf-8')
    else:
        spec=importlib.util.spec_from_file_location('tongxu_v22_source',ROOT/'build_v22.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);base=module.build()
    return extend(base)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,default=ROOT/'product_ui_prototype.html')
    p.add_argument('--base-v22',type=Path)
    a=p.parse_args()
    if a.output.resolve().parent==(ROOT/'archive').resolve():p.error('Cannot overwrite archive')
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(build(a.base_v22),encoding='utf-8');print(a.output)
