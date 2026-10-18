#!/usr/bin/env python3
"""Build one offline v2.2 workspace. The frozen v2.1 transform is build-only.
No runtime loader, model call or extra state store. W7 replaces the prototype.
"""
from pathlib import Path
import argparse
import importlib.util
ROOT = Path(__file__).resolve().parent

def extend(text: str) -> str:
    def once(old: str, new: str) -> None:
        nonlocal text
        if text.count(old) != 1:
            raise ValueError('Expected one reviewed anchor: ' + old[:80])
        text = text.replace(old, new, 1)
    once('<title>同序 · 工作台 v2.1</title>', '<title>同序 · 工作秘书与协作工作台 v2.2</title>')
    once("const STORE='tongxu-product-ui-20261017-v21';", "const STORE='tongxu-product-ui-v22';")
    once("schema:4,page:'overview'", "schema:5,coord:coordSeed(),page:'secretary'")
    once('raw?.schema===4', 'raw?.schema===5&&raw.coord')
    once("const titles={overview:", "const titles={secretary:'工作秘书',coordination:'接入协调与共同交付',overview:")
    once('({overview:renderOverview,work:renderWork,comms:renderComms}', '({secretary:renderSecretary,coordination:renderCoordination,overview:renderOverview,work:renderWork,comms:renderComms}')
    once('const actions={', (ROOT/'workspace_v22.js').read_text(encoding='utf-8')+'\nconst actions={\n ...coordActions,')
    once('</style>', (ROOT/'workspace_v22.css').read_text(encoding='utf-8')+'\n</style>')
    anchor='<button class="navbtn active" data-action="navigate" data-id="overview" data-nav="overview">'
    once(anchor, '<button class="navbtn" data-action="navigate" data-id="secretary" data-nav="secretary"><span data-icon="user"></span>工作秘书</button>'+anchor)
    # Extend the existing checks and dispatch rather than maintaining a parallel gate.
    marker='window.__tongxuUI='
    wrapper="""const v21Requirements=requirements;requirements=function(p){const rows=v21Requirements(p),extra=coordRequirement(p);return extra?[extra,...rows]:rows;};
const v21Dispatch=dispatch;dispatch=function(id,mode,workspace){if(+id===70&&!coordWriteAllowed()){toast('当前协调未齐或新实施已暂停；不开始共享写入。','alert');return false;}return v21Dispatch(id,mode,workspace);};
document.addEventListener('keydown',e=>{if(e.target?.id==='secretary-input'&&(e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();secretarySend(e.target.value);}});
"""
    once(marker, wrapper+marker)
    once('snapshot:()=>clone(s),reset:resetState', 'snapshot:()=>clone(s),secretaryAllowed,secretarySend,coordAck,coordWriteAllowed,reset:resetState')
    return text

def build() -> str:
    spec=importlib.util.spec_from_file_location('frozen_v21',ROOT/'archive/build_v21.py')
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SOURCE=ROOT/'archive/product_ui_v2.html'
    return extend(module.build())

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,default=ROOT/'product_ui_prototype.html')
    args=parser.parse_args()
    if args.output.resolve().parent == (ROOT/'archive').resolve():
        parser.error('Cannot overwrite frozen archive')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(build(),encoding='utf-8')
    print(args.output)
