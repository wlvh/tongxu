#!/usr/bin/env bash
# 验证 v2 方案第 13.3 节的基础能力：git merge-tree --write-tree 计算 固定目标 B + 候选 H 的组合树，
# 不改工作区与 index；有冲突时返回树与冲突清单并以 1 退出；结果树可读入隔离 worktree 运行测试。
set -uo pipefail
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; cd "$W"
git --version
git init -q -b main; git config user.email t@t; git config user.name t
printf 'a\n' > f.txt; git add -A; git commit -qm base
git checkout -qb cand; printf 'a\ncand\n' > f.txt; git commit -qam cand
git checkout -q main; printf 'main\na\n' > f.txt; git commit -qam main-advance
echo "--- clean combination (exit code, tree oid) ---"; T=$(git merge-tree --write-tree main cand); echo "exit=$? tree=$T"
echo "--- worktree untouched? ---"; git status --porcelain; echo "(clean)"
echo "--- checkout result tree into isolated worktree ---"
git worktree add -q --detach ../wt main; (cd ../wt && git read-tree -u -m "$T" && cat f.txt); git worktree remove --force ../wt
echo "--- conflicting combination ---"; git checkout -qb cand2 main~1; printf 'x\n' > f.txt; git commit -qam cand2
git merge-tree --write-tree main cand2; echo "exit=$?"
