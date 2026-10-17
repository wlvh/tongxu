#!/usr/bin/env bash
# Historical probes: frozen prototypes, not current product acceptance.
set -euo pipefail
cd "$(dirname "$0")"
P=../../prototypes
extract(){ awk '/<script>/{f=1;next}/<\/script>/{f=0}f' "$1"; }
extract "$P/v2_plan_and_acceptance.html" > 69b0636d.js
extract "$P/archive/product_ui_v2.html" > 115a12c3.js
python3 - <<'PY'
import re
h=open('../../prototypes/v2_plan_and_acceptance.html',encoding='utf-8').read()
for sid in ('test-data','work-data'):
    m=re.search(r'<script[^>]*id="%s"[^>]*>(.*?)</script>'%sid,h,re.S)
    open(sid+'.json','w',encoding='utf-8').write(m.group(1))
PY
echo "===== v1 原型（历史缺陷） ====="; node v1_probe.js "$P/v1_issue_workbench.html" | sed 's/（模拟）//g'
echo; echo "===== 历史产品原型 v2 ====="; node product_ui_probe.js | sed 's/（模拟）//g'; node product_ui_probe_stagebar.js
echo; echo "===== v2 历史演练页 ====="; node v2_demo_probe.js | sed 's/（模拟）//g'
rm -f 69b0636d.js 115a12c3.js test-data.json work-data.json
