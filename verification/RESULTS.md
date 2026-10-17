# 实测结果

环境：Node v22.22.0，Git 2.43.0，Python 3，Linux。日期 2026-10-16 至 2026-10-17。全部脚本可重跑。

## 1. 语义冲突反例（`semantic_conflict/repro.sh`）

```text
rebase conflicts: none
A's patch byte-identical across bases: yes
old base + A -> export(): {'amount': 100, 'unit': 'yuan', 'revenue_yuan': 100}
new base + A -> export(): {'amount': 10000, 'unit': 'cent', 'revenue_yuan': 10000}
--- 提示信号：import 闭包碰撞 ---
A touches: exporter.py | base delta touches: record.py | A's files import: record
--- 真正的拦截：组合场景测试（断言 revenue_yuan 以元计） ---
old base + A -> combo test: OK
new base + A -> combo test: AssertionError: revenue_yuan=10000 expected=100.0
```

结论：patch 相同只证明局部改动相同；闭包碰撞能提示但不能作为免审依据；组合场景测试能拦截。对应对齐结论 A11、A12。

## 2. `git merge-tree --write-tree`（`merge_tree/test.sh`）

```text
--- clean combination --- exit=0 tree=<oid>
--- worktree untouched? --- (clean)
--- checkout result tree into isolated worktree --- 文件内容为合并结果
--- conflicting combination --- 输出树 OID、三方 blob 清单与 CONFLICT 行，exit=1
```

结论：方案 §13.3 的基础能力成立；它向对象库写树，工作区与 index 不动。

## 3. HTML 状态机探针（`html_probes/run.sh`）

### v1 原型（七处缺陷，全部复现）

| 项 | 观察 |
|---|---|
| 用户验收格 | accept、reject、request_evidence 都显示 done |
| 技术解读 | 新 head 后仍显示 done |
| 返工计数 | 同 head 两次负面审核，rounds 1 → 3 |
| 查回送达 | message=delivered，原 intent 仍 unknown |
| 决定 D2 | 新 head 后无任何转移能重写 D2，PR #102 永久不可合并 |
| 新会话能力 | 派发即 cap=control |
| 工作区并发 | 三个会话可指向同一路径 |

### 产品原型

| 项 | 观察 | 判定 |
|---|---|---|
| 用户验收格 | accept=done，reject=now，request_evidence=now | 已修 |
| 技术解读 | 绑定版本；新 head 后变 todo | 已修 |
| 返工计数 | 两次负面审核 fixes 不变；修复批次后 fixes 加一 | 已修 |
| 写入责任移交 | 修复后作者会话 paused 并记录 transferredTo，任务负责人切到核实会话 | 已实现 |
| 查回送达 | message=delivered，operation=confirmed | 已修 |
| 决定 D2 | 新 head 后 apply-decision 可重绑 | 已修 |
| 工作区并发 | 占用路径与路径穿越变体均拒绝 | 已修 |
| 新会话能力 | 握手前 []，握手后一次授予 observe/send/pause/resume | 部分 |
| 委托范围 | 委托模式下 #151（目标 integration/50）与集成 PR #150 均 permission.ok=true | 未绑定 |
| 发出前主干前进 | submitMerge 拒绝 | 已实现 |
| 发出后主干前进 | 合入成功，历史固定写"受测树与本次示例合入树相同"，无待核标记 | 缺失 |
| 审核与 base | 仅主干前进时 reviewFresh=true，testFresh=false | 审核不绑 base，组合检查绑 base |
| 接收席位 | 第三个并发接收被拒 | 已实现 |
| 条件不满足接受 | verdict accept 被拒 | 已实现 |
| 决定改变范围 | D1 确认后 scope 变 r2，旧审核失效 | 已实现 |
| 只读模式 | 派发、合入、接收均拒绝 | 已实现 |
| 审核迟到 | 旧 head 的审核只归档 | 已实现 |

### v2 演练页

| 项 | 观察 |
|---|---|
| 委托范围 | #701(main,S1) ok；#703(integration/70) 拒；S2 拒 |
| 发出后主干前进 | merged=true，incident=true |
| 决定重绑 | 新 head 后 apply 可重绑；新 head 清除本人确认 |
| 判断绑定 base | 接收判断与组合检查在主干前进后都失效 |
| 消息去重 | resend 不递增；查回后消息与原操作一起恢复 |

结论：产品原型与 v2 演练页对委托范围、发出后主干前进、判断绑定 base 三条规则实现不一致，见 `docs/review/aligned_decisions.md` D1–D3。
