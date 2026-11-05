# 稳定操作流程入口

## Purpose and Authority

本页只保留稳定动作、权威来源和完成判据；易漂移的命令、字段、测试清单和权限定义留在正式文档。来源遵循 [Authority Map](AGENTS.md#authority-map)。先确认任务、原执行者和当前授权，按实际影响选择相关流程。

## 开发同序

本仓开发采用 [coding-workflow 固定版本 84a7ccd](https://github.com/wlvh/coding-workflow/blob/84a7ccdb7e08e9f87ddfb4eaff8b2c322330a3d9/zh/docs/development_workflow/README.md)及 [DEC-008](https://github.com/wlvh/coding-workflow/blob/84a7ccdb7e08e9f87ddfb4eaff8b2c322330a3d9/zh/docs/development_workflow/decisions.md#dec-008开发工作流采用复杂度守恒与可退役实验机制)。[AGENTS](AGENTS.md#authority-map)说明权威关系；当前工作以唯一实施 Issue 为准，例如本次接入的 [#69](https://github.com/wlvh/tongxu/issues/69)。以下是项目化导航，完整提示和规则只在采用的固定上游维护。

| 阶段与指定角色 | 输入、动作和产物 | 下一步与完成条件 |
| --- | --- | --- |
| 1—4 需求成文 | 网页端 Pro 模型先写只描述用户可观察结果的 FSD；Bridge Agent 对照当前源码及权威文档，给出影响预测和目标状态；Issue Agent 汇入同一 Issue | FSD 不预设实现，Bridge 的触点预测不冒充承诺；实质范围、权限、成本和失败取舍留在 Issue。PR、评论、交接引用它。 |
| 5—6 编码前审定 | Codex 核需求闭合/验收可判定，Claude Code 核工程量/最小充分；Issue Agent 综合更新正文。高风险时做 Tech Lead Readback，解释正常与失败例子及简化方案 | 两个镜头形成合意 Issue 后开始编码；必要 Readback 帮助理解，不增设签字或第二权威。用户明确的本轮角色调整记回原 Issue。 |
| 7—8 开发和 Draft | Coding Agent 按 Issue 提取 SU→代码→复用/扩展测试→文档的任务，开发、自审，更新仓库外 PR body 并发布/更新 Draft PR | 真实 base/head、差异、测试与限制对应本次交付；自审不代替正式审核。 |
| 9 正式完整审核 | 新 Codex 对话隔离作者上下文，对最新准确 head 和完整 PR、Issue及必要上下游材料执行正式审核 | 只给 PASS、REWORK_REQUIRED、OWNER_DECISION_REQUIRED。PASS 结束本轮问题循环，P2记录；空问题列表或局部 PASS 不自动放行。 |
| 10 整批问题核实与修复 | 本轮全部 P0/P1 一批交新的 Codex 事实验证和新的 Claude Code 影响验证；Claude 意见交本批 Codex 综合，分歧只交换代码、测试、复现和 Issue，最多三轮 | 证据不足保持 REWORK_REQUIRED 并列补证动作。仍需修复时，有明确指令及有效授权后在本批原 Codex 验证会话修复；更新代码/测试/文档/PR记录并推送新 head，每次修复后重新开 Codex 对话回第9步完整审核。 |
| 11、13 合并后交付与用户验收 | 第11步由网页端 GPT apps 基于最终源码和记录制作可离线 HTML 机制解释，并检查用户可感知变化与文档指引，归档 PR 评论；第13步 GPT 网页版与 Claude Code 对用户验收计划形成合意、归档 PR 评论，再交 Codex 从正常入口实际执行 | 测试、正式审阅、合并、安装、真实路径和本人接受分别留证。第12步继续暂停，不增加关闭前倒查 FSD 环节。真实成果确认仍归 #9。 |

普通原任务连续接续沿 [CODEX_NEXT](docs/CODEX_NEXT.md)；第10步的修复责任按本批原事实验证会话解释，不是全局更换负责人。产品 AI 偏好按已采用角色边界执行；Issue #72 的 KI01—05 明确允许软件正式影响核实选择 Kimi，未设置时仍为 Claude，其他正式角色不随之替换；未能执行的角色如实待核，只暂停依赖其结论的动作。

事实已查清后仍有实质业务取舍，才将具体事项及影响补回原 Issue，请 owner 决定，保留答复和理由；其他工作继续。owner 决定后更新 PR 并回第9步。P2 可接受并记录，不因此启动无必要修复。证据交换、模型尝试、写权交接与实际发布返工分开；返工按 [#7 原发布批次口径](https://github.com/wlvh/tongxu/issues/7#issuecomment-6355784555)计，同 head 去重，实际发布返工超过三次时沿原反思入口审视能否简化，不新增计数器。Readback/Owner Decision 是 DEC-008 的实验机制，约三次使用只作复盘提醒，不是新增门槛。

## Available SOPs

| 流程 | Action：稳定动作 | Authority / Source：入口 | Acceptance：完成判据 |
| --- | --- | --- | --- |
| 开发接续 | 核原任务、代码与已有证据，处理确实未完或失效部分 | [CODEX_NEXT](docs/CODEX_NEXT.md)、[产品指南](docs/PRODUCT_GUIDE.md) | 准确前置、原负责人、工作区和可做范围明确，无重复派发/覆盖。 |
| 环境与构建 | 核最低要求，按当前依赖规则安装和构建 | [运行环境](docs/runtime_compatibility.md)、[TESTING](TESTING.md#0-canonical-test-entrypoints) | 实际环境满足能力要求，构建通过；不宣称运行或验收已通过。 |
| PR 材料采集 | 固定候选，保留原响应及缺口，必要时沿原包恢复 | [w1_cli](docs/w1_cli.md) | 候选、原件、交接报告可对应，缺口明确。 |
| 隔离验证 | 对固定树执行已登记测试，对照样本与组合前缀 | [w2_verification](docs/w2_verification.md)、[Docker](docs/docker_verification.md) | 实际树、HEAD、命令、原输出及环境一致；失败中间前缀未丢。 |
| 原队列接收 | 导入原材料，满足前置后执行已登记独立接收 | [shadow queue](docs/w3_shadow_queue.md)、[native reception](docs/native_reception.md)、[governed reception](docs/governed_reception.md) | 准确材料、实际派发、完整判断和资源/许可分别核清；影子完成不代替模型判断。 |
| 退回与修复 | 回原负责人核问题，按获准路径修复或给反证，新候选另审 | [RETURN](docs/return_workbench.md)、[controlled repair](docs/controlled_repair.md)、[workspace handoff](docs/managed_workspace_handoff.md) | 原修改保留、唯一写者成立、测试及新独立结论对应新候选。 |
| 任务联系与阶段协调 | 使用预登记联系人和准确阶段产物传递完整材料 | [task contact](docs/task_contact_choice.md)、[coordination](docs/task_coordination.md) | 原输入/回复及消费可核；下一依赖动作重核条件，未知执行不重派。 |
| 工作台与项目秘书 | 用有效安装计划启动，选项目，查询或明确运行已装配动作 | [使用导航](docs/business_user_guide.md#0-documentation-and-interface-entrypoints) | 实际版本/来源清楚，完整报告可读；历史读取不新增模型输入。 |
| 结果发布与受管合入 | 检查当次授权、候选和远端前置，执行并查真实结果 | [publication](docs/result_publication.md)、[managed merge](docs/managed_merge.md) | 原发送与远端读回一致；实际合入版本另有对应验证，不沿用旧候选通过。 |
| 成果与本人决定 | 核准确批次、实际场景、独立解释与本人来源 | [delivery outcomes](docs/delivery_outcomes.md)、[delivery assessment](docs/delivery_assessment.md) | 技术判断、实际采用和后续结果分开保存，不由模型代签。 |
| 文档与交付 | 按范围更新权威说明，验证并独立复核，再执行授权交付 | [PR_Checklist](PR_Checklist.md)、[PR 模板](.github/pull_request_template.md) | 最终对象、证据、限制和远端读回相符。 |

## SOP Entry Structure

新增稳定流程沿用 Action、Authority / Source、Acceptance 三项，不在本页复制参数表或另建操作状态。只有实际实现/已接受流程才进入目录；未来设想留在原需求处。

## Failure, Rollback, and Escalation

来源、授权、隔离或原执行状态不足时，只暂停依赖它的动作，继续不受影响的已授权工作。保留准确错误、输入与原捕获；记录不完整应说明未知，不从进程退出或页面关闭推断远端未执行。

采集沿原包恢复；模型及消息沿原任务/捕获核对；受管合并沿原操作读回。适用的 `cancel-unstarted` 需要确证未发送，显式重试需要入口要求的证据。不能通过删数据库、释放未知占用、换任务编号或回滚 UI 文案抹去实际副作用。

代码/文档交付回退按真实 Git 差异做有授权的反向提交；已写远端、运行库和模型费用须各自核对，Git 回退不能撤销这些事实。通用自动备份/任意版本迁移未配置，不凭历史演练承诺可恢复。未经核实的私人状态不改写。

需要新目标决定、额外费用/权限或不可替代外部条件时，把准确对象、已查事实、可继续部分和待决定点交有权决定的人；不额外发明审批角色或逐步确认流程。


正式 PR 外层按 [formal_pr_review](docs/formal_pr_review.md) 使用完整 PR 材料、新 reviewer/整批双验证及原事实会话授权修复；直接 PASS 不额外派发，实际发布后的新 head 沿原采集验证后重新完整审核。原局部链、技术接收和正式 PASS 各自保留，均不授予合并或本人接受。
