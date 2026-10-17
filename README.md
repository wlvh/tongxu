# 同序（tongxu）

交付优先的多 Issue、多 Agent 协作台。本仓库目前只有**设计材料、交互原型、评审记录、验证脚本和实施 Issue**，没有可运行的软件。

状态：2026-10-17。方案版本 v2.0 加三轮评审形成的 v2.1 修订项。工作流参考固定在
[wlvh/coding-workflow@1772cd2c](https://github.com/wlvh/coding-workflow/tree/1772cd2c25bfc42b7a89cf38b35bf19d3dc22000)。

## 这是什么

同序要解决的不是"缺一个看板"，而是多个 Issue、多个执行者（Codex、Claude Code）同时交付时，
"工作分给谁；信息送到哪里；产物是否被接收；哪个 PR 还差什么；现在需要人处理哪件事"这些机械协调动作。
它不是第三个编码客户端，不自动合并，不把模型的一句"完成了"当成事实。

完整方案见 [docs/tongxu_v2_plan.md](docs/tongxu_v2_plan.md)。方案由 GPT 6 Pro 起草，经 Claude 三轮评审对照
coding-workflow 原文、Node 探针和 Git 实验后修订；对齐结论与未决项见
[docs/review/aligned_decisions.md](docs/review/aligned_decisions.md)。

## 目录地图

| 路径 | 内容 | 来源与状态 |
|---|---|---|
| `docs/tongxu_v2_plan.md` | v2.0 完整方案：24 章、W0–W7 工作包、T01–T32 验收场景 | GPT 6 Pro 起草，原文未改 |
| `docs/acceptance/T01-T32.json` | 32 项验收场景的结构化数据 | 从 v2 HTML 内嵌 JSON 抽出 |
| `docs/acceptance/work_packages_W0-W7.json` | 8 个工作包的结构化数据 | 同上 |
| `docs/review/` | 三轮评审全文（GPT 与 Claude 各三份）与对齐结论 | 对话原文转录 |
| `docs/issues/` | 实施 Issue 正文（与 GitHub Issue 同步） | Claude 按 v2 §19 与评审结论编写 |
| `prototypes/v1_issue_workbench.html` | v1 交互原型，历史保留 | 虚构数据，七处状态缺陷已登记 |
| `prototypes/v2_plan_and_acceptance.html` | v2 方案同源 HTML：方案、开发、验收工作表、演练 | 虚构数据 |
| `prototypes/product_ui_prototype.html` | 产品界面交互原型 | 虚构数据，三处规则与方案不一致，见 Issue |
| `verification/` | 可重跑的验证脚本与实测结果 | Claude 编写并在 Node 22、Git 2.43 下运行 |

## 阅读顺序

1. 产品负责人：方案第 02、03、12、20、22 节，然后 `docs/review/aligned_decisions.md`。
2. 开发者：方案第 04–19、21、23 节，然后 `docs/issues/` 按编号读。
3. 审核者：方案第 21–23 节，`verification/RESULTS.md`。

## Issue 索引

| Issue | 文件 | 阶段 |
|---|---|---|
| [#1 设计修订 v2.1：开工前需要确认的十项规则](https://github.com/wlvh/tongxu/issues/1) | `docs/issues/00_design_revision_v2.1.md` | 设计 |
| [#2 W0 现有交付与政策基线](https://github.com/wlvh/tongxu/issues/2) | `docs/issues/01_W0_baseline.md` | G0 |
| [#3 W1 事实采集与原 PR 交接](https://github.com/wlvh/tongxu/issues/3) | `docs/issues/02_W1_facts_and_pr_handoff.md` | G1 |
| [#4 W2 可执行证据与临时组合](https://github.com/wlvh/tongxu/issues/4) | `docs/issues/03_W2_evidence_and_combination.md` | G1 |
| [#5 W3 接收队列、有限授权与可靠操作](https://github.com/wlvh/tongxu/issues/5) | `docs/issues/04_W3_queue_authorization_operations.md` | G1 |
| [#6 W4 两种执行器与准确结果](https://github.com/wlvh/tongxu/issues/6) | `docs/issues/05_W4_executor_adapters.md` | G2 |
| [#7 W5 按项目流程自动转接审核循环](https://github.com/wlvh/tongxu/issues/7) | `docs/issues/06_W5_review_loop_relay.md` | G2 |
| [#8 W6 多任务分配与实际交付通信](https://github.com/wlvh/tongxu/issues/8) | `docs/issues/07_W6_dispatch_and_delivery.md` | G3 |
| [#9 W7 完整三视图、外部步骤与交付](https://github.com/wlvh/tongxu/issues/9) | `docs/issues/08_W7_three_views_and_release.md` | G3 |

GitHub Issue 正文与 `docs/issues/` 同步；改动先改文件再更新 Issue。按 v2 §23.1，先只做 #2（W0）；#3 以后的 Issue 在 W0 的 Bridge 产出后按 Issue Agent 规则细化为可编码 Issue。#1 的十项决定是 #3 以后的前置。

## 验证脚本

```bash
bash verification/semantic_conflict/repro.sh   # patch 字节不变、无冲突、行为改变的反例
bash verification/merge_tree/test.sh           # git merge-tree --write-tree 的组合与冲突行为
bash verification/html_probes/run.sh           # 三份 HTML 状态机的 Node 探针
```

实测输出见 [verification/RESULTS.md](verification/RESULTS.md)。

## 边界

- 原型中的仓库、会话、版本、回执全部是虚构示例，按钮只改本地状态，不连接 GitHub、Codex 或 Claude Code。
- 方案引用的 SEC_metrics Issue 与 PR（#153、#264、#287、#293）未在本仓库核验，按 GPT 的转述对待。
- GPT 交付包中的 `W0_开发起步.md`、`artifact_validation.md` 等文件未提供给本仓库；T01–T32 数据从 HTML 内嵌 JSON 抽出。
