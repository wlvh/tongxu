#!/usr/bin/env bash
# 语义冲突反例：两份改动不碰同一文件、无文本冲突、A 的 patch 在新旧 base 上字节相同，但合并后行为改变。
# 同时演示两道防线：import 闭包碰撞提示（仅提示，不免审），以及组合场景测试（真正拦截）。
set -euo pipefail
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; cd "$W"
git init -q -b main; git config user.email t@t; git config user.name t
printf 'def load():\n    return {"amount": 100, "unit": "yuan"}\n' > record.py
printf 'from record import load\ndef export():\n    r = load()\n    return {"amount": r["amount"], "unit": r["unit"]}\n' > exporter.py
git add -A; git commit -qm base; BASE=$(git rev-parse HEAD)
git checkout -qb task-A
printf 'from record import load\ndef export():\n    r = load()\n    return {"amount": r["amount"], "unit": r["unit"], "revenue_yuan": r["amount"]}\n' > exporter.py
git commit -qam "A: add revenue_yuan (reads amount directly)"; A_OLD=$(git rev-parse HEAD)
git checkout -q main; git checkout -qb task-B
printf 'def load():\n    return {"amount": 10000, "unit": "cent"}\n' > record.py
git commit -qam "B: amount now in cents"
git checkout -q main; git merge -q --no-edit task-B
git checkout -q task-A; git rebase -q main; A_NEW=$(git rev-parse HEAD)
git diff "$BASE" "$A_OLD" > pa_old.patch; git diff main "$A_NEW" > pa_new.patch
echo "rebase conflicts: none"
echo "A's patch byte-identical across bases: $([ "$(sha256sum < pa_old.patch)" = "$(sha256sum < pa_new.patch)" ] && echo yes || echo no)"
mkdir old new; git archive "$A_OLD" | tar -x -C old; git archive "$A_NEW" | tar -x -C new
for t in old new; do printf '%s base + A -> export(): ' "$t"; (cd "$t" && python3 -c 'import sys; sys.path.insert(0,"."); import exporter; print(exporter.export())'); done
echo "--- 提示信号：import 闭包碰撞 ---"
echo "A touches: $(git diff --name-only main "$A_NEW" | tr '\n' ' ')| base delta touches: $(git diff --name-only "$BASE" main | tr '\n' ' ')| A's files import: $(grep -ho '^from [a-z_]* import' new/exporter.py | awk '{print $2}' | tr '\n' ' ')"
echo "--- 真正的拦截：组合场景测试（断言 revenue_yuan 以元计） ---"
cat > test_combo.py <<'PY'
import sys, os; sys.path.insert(0, os.getcwd())
import exporter
r = exporter.export()
expected = r["amount"] if r["unit"] == "yuan" else r["amount"] / 100
assert r["revenue_yuan"] == expected, f"revenue_yuan={r['revenue_yuan']} expected={expected}"
print("OK")
PY
for t in old new; do printf '%s base + A -> combo test: ' "$t"; (cd "$t" && python3 ../test_combo.py 2>&1 | tail -1); done
