# 验证脚本

每个脚本都能独立重跑，不依赖网络。实测输出记录在 `RESULTS.md`。

| 脚本 | 证明什么 | 对应方案位置 |
|---|---|---|
| `semantic_conflict/repro.sh` | 两份改动不碰同一文件、无文本冲突、候选 patch 在新旧 base 上字节相同，合并后行为仍改变；import 闭包碰撞只能提示；组合场景测试才能拦截 | §7、§8.3、§13.4、T12 |
| `merge_tree/test.sh` | `git merge-tree --write-tree` 不改工作区与 index，有冲突时返回树与冲突清单并退出 1，结果树可读入隔离 worktree | §13.3、T11 |
| `html_probes/run.sh` | 在 Node 中加载三份 HTML 的脚本，验证状态机：七处 v1 缺陷、v2 与产品原型的修复情况，以及两者之间的三处规则不一致 | §21.1、T07/T14/T15/T24–T26/T30/T31 |

探针用 DOM 与 localStorage 替身加载原始脚本，`setTimeout` 改为队列，由 `flush()` 推进。它们证明的是页面脚本的状态逻辑，不是浏览器端到端行为，也不是未来后端的正确性。

运行要求：Node 20 以上，Git 2.38 以上（`merge-tree --write-tree`），Python 3。
