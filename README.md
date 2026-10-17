# 同序（tongxu）

交付优先的多 Issue、多 Agent 协作台。**当前是 v2.1 设计基线、可构建离线产品 UI、验证脚本和规划 Issue；尚无真实接入的同序应用。**

先让成果准确接收、复验、排队并进入正确目标，再自动接续原生 Agent。不是第三个编码客户端，不重建聊天。**不无条件自动合并；受管写入只依据已核验的逐次确认或有限委托。**

## 现在怎么推进

产品仓库已确定为本仓库，首个只读调查对象为 `wlvh/SEC_metrics`。先执行 [#2 / W0](https://github.com/wlvh/tongxu/issues/2)，按 [Codex 起步指令](docs/CODEX_W0.md) 产出事实基线、W1 Bridge 和细化后的 #3 草稿。

#1 的十项规则已归并，不再是开工前逐项批准表；**W0 不等待 D5、Checks 写权、merge queue 或原生执行器**。未知只限制它实际影响的动作。此安排不授权 SEC_metrics 写入、合并、调用、费用或接管。

## 现行入口

| 入口 | 用途 |
|---|---|
| [完整规范](docs/tongxu_v2_plan.md) | 已整合的 v2.1，唯一当前产品基线；保留 24 章结构 |
| [变更索引](docs/review/aligned_decisions.md) | D1—D10 的结论、理由及落实位置，不重复定义政策 |
| [Issue 发布源](docs/issues/) | 一个执笔者更新并发布，读回核对；当前编码依据是已发布 Issue |
| [32 项验收](docs/acceptance/T01-T32.json) | 覆盖清单，不是已通过记录 |
| [当前 UI 构建源](prototypes/build_product_ui.py) | 保留原布局，生成单文件离线界面；不加载外部服务 |
| [本轮验证](verification/REVISION_V21.md) | 确切运行范围、原型断言和限制 |

## 打开当前产品 UI

```bash
python3 prototypes/build_product_ui.py
# 浏览器打开 prototypes/product_ui_prototype.html
node verification/html_probes/current_v21.js
```

构建只从 `prototypes/archive/product_ui_v2.html` 的固定模板生成，替换点不匹配就失败；输出无运行时加载层、无外部依赖。生成的 HTML 不作为另一份手改源码，也不进入 commit。当前源码是生成器与固定模板；W7 交付真实 UI 后退役这段原型构建机制。旧模板不能作为当前交互入口。

主界面是**项目总览、任务／会话／PR、通信与交付**，不是方案阅读器。委托范围、目标增量判断、实际合入证据待核与恢复、逐操作能力均可演练。所有版本、回执和身份为虚构数据，点击不访问 GitHub、Codex 或 Claude Code。

## 工作包

| Issue | 工作包 | 状态边界 |
|---|---|---|
| [#1](https://github.com/wlvh/tongxu/issues/1) | v2.1 规则归并 | 设计收口，不是产品验收 |
| [#2](https://github.com/wlvh/tongxu/issues/2) | W0 基线与 W1 Bridge | **现在执行** |
| [#3](https://github.com/wlvh/tongxu/issues/3) | W1 事实与原 PR 交接 | W0 后细化，规划级 |
| [#4](https://github.com/wlvh/tongxu/issues/4) | W2 证据与临时组合 | W1 后细化，规划级 |
| [#5](https://github.com/wlvh/tongxu/issues/5) | W3 队列／授权／可靠操作 | G1 受管接收版发布点，规划级 |
| [#6](https://github.com/wlvh/tongxu/issues/6) | W4 真实执行器 | G2，规划级 |
| [#7](https://github.com/wlvh/tongxu/issues/7) | W5 审核循环转接 | G2，规划级 |
| [#8](https://github.com/wlvh/tongxu/issues/8) | W6 分配与通信 | G3，规划级 |
| [#9](https://github.com/wlvh/tongxu/issues/9) | W7 三视图与完整交付 | G3，规划级 |

不同时派出八个工作包。W0 只细化 W1；未知写入方式不阻塞只读采集。后续受管写权和正式验收根据真实对象另核。

## 历史与同步

`docs/archive/tongxu_v2_plan.md`、`docs/review/01`—`06`、`prototypes/v1_issue_workbench.html`、`prototypes/v2_plan_and_acceptance.html` 和冻结产品模板保留历史。旧缺陷探针仍可用于重演，不证明当前产品状态，不要求三套 HTML 同时迭代。

每轮先读取远端 Issue 和新评论，再更新对应 `docs/issues/`；发布后读回核对。缺少发布权限时明确“草稿待发布”。禁止用旧文件覆盖新的有效决定，也不新增永久同步服务。评审对话、变更索引不成为另一套实施入口。

本轮没有清洗历史 commit 身份、删除材料、强推或修改分支保护。公开材料包含历史转述；试点仓库事实由 W0 再核，不能据旧 PR 说明声明当前已上线。
