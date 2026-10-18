#!/usr/bin/env python3
"""Offline v2.4 candidate. Default builds the retained v2.3 sources.
--base-v23 accepts only the exact published artifact; no network or live effects.
"""
from pathlib import Path
import argparse,hashlib,importlib.util
ROOT=Path(__file__).resolve().parent
BASE='d5dd927f291400fe43bee1811fdf4f6b95ab48f834244876cb51b630997b9023'
def extend(text:str)->str:
 def once(old,new):
  nonlocal text
  if text.count(old)!=1:raise ValueError('Expected exactly one reviewed anchor: '+old[:80])
  text=text.replace(old,new,1)
 once('<title>同序 · 人掌控目标，Agent 交付 · v2.3</title>','<title>同序 · 治理与后果预览 · v2.4 候选</title>')
 once("const STORE='tongxu-product-ui-v23';","const STORE='tongxu-product-ui-v24-candidate';")
 once("({'control-review':controlReviewPage,","({governance:govPage,'control-review':controlReviewPage,")
 once("const titles={'control-review':","const titles={governance:'治理与有限复用','control-review':")
 once('window.__tongxuUI=',(ROOT/'governance_v24.js').read_text(encoding='utf-8')+'\nwindow.__tongxuUI=')
 once('snapshot:()=>clone(s),controlOwner','snapshot:()=>clone(s),govPreview,govApply,govDraw,govEffect,govPrecedent,govGovernanceState,controlOwner')
 # Existing form collects inputs; this button now opens the ONE final confirmation.
 text=text.replace("btn('确认本次控制','control-confirm'","btn('预览变更','control-confirm'")
 return text

def build(base=None):
 if base:
  data=Path(base).read_bytes()
  if hashlib.sha256(data).hexdigest()!=BASE:raise ValueError('Unexpected v2.3 artifact; do not bypass identity check')
  text=data.decode('utf-8')
 else:
  spec=importlib.util.spec_from_file_location('tongxu_v23',ROOT/'build_v23.py')
  module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  text=module.build()
 return extend(text)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--base-v23',type=Path);p.add_argument('--output',type=Path,default=ROOT/'product_ui_prototype.html');a=p.parse_args()
 if a.output.resolve().suffix!='.html' or 'archive' in a.output.resolve().parts:p.error('Use a generated HTML destination, not source/archive')
 a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(build(a.base_v23),encoding='utf-8');print(a.output)
