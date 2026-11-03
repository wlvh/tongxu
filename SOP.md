# 稳定操作流程入口

## Purpose and Authority

本页只保留稳定动作、权威来源和完成判据；易漂移的命令、字段、测试清单和权限定义留在正式文档。来源遵循 [Authority Map](AGENTS.md#authority-map)。先确认任务、原执行者和当前授权，按实际影响选择相关流程。

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
