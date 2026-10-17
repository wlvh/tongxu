#!/usr/bin/env bash
# 对三份 HTML 原型的脚本跑状态机探针。需要 node。
set -euo pipefail
cd "$(dirname "$0")"
P=../../prototypes
extract(){ awk '/<script>/{f=1;next}/<\/script>/{f=0}f' "$1"; }
extract "$P/v2_plan_and_acceptance.html" > 69b0636d.js
extract "$P/product_ui_prototype.html"   > 115a12c3.js
python3 - <<'PY'
import re
h=open('../../prototypes/v2_plan_and_acceptance.html',encoding='utf-8').read()
for sid in ('test-data','work-data'):
    m=re.search(r'<script[^>]*id="%s"[^>]*>(.*?)</script>'%sid,h,re.S)
    open(sid+'.json','w',encoding='utf-8').write(m.group(1))
PY
echo "===== v1 原型（七处缺陷） ====="; node v1_probe.js "$P/v1_issue_workbench.html" | sed 's/（模拟）//g'
echo; echo "===== 产品原型 ====="; node product_ui_probe.js | sed 's/（模拟）//g'; node product_ui_probe_stagebar.js
echo; echo "===== v2 演练页 ====="; node v2_demo_probe.js | sed 's/（模拟）//g'
rm -f 69b0636d.js 115a12c3.js test-data.json work-data.json
