# 同序角色指令 v2.3

角色模板不是已经运行的Agent，不授予工具权力。装配：固定 `runtime_contract.md`＋一个角色文件＋适用的固定上游完整提示＋本轮可信输入。不要把所有角色拼给秘书。角色不要求常驻进程，整体复盘复用审核角色的按需模式，不新增管理层。

| 角色 | 文件 | 默认入口 |
|---|---|---|
| 工作秘书 | secretary.md | 独立Codex App Server；仅查询协调 |
| 交付负责人 | issue_owner.md | Codex或Claude Code |
| 子任务实现 | implementer.md | 独立会话或原负责人顺序Run |
| 正式审核／按需整体复盘 | reviewer.md | 新鲜独立Codex |
| 事实核实与综合 | verifier_fact.md | 独立Codex；修复须实际移交写权 |
| 影响核实 | verifier_impact.md | 独立Claude Code |
| PR接收／集成 | receiver.md | 独立Claude Code CLI |
| 外部技术解读／简化反思 | external_report.md | 已采用流程中的网页GPT |
| 用户路径验收 | acceptance.md | 已采用计划的执行分工 |

`tool_policy.json`里的接口名称是待实现的同序工具，不声称CLI自带。运行器实际落实角色、本人入口、停止／撤销、当前阶段门与原生权限的交集；不支持限制秘书shell时，不开放秘书控制模式。仅prompt自律不通过。

本轮公共新增：本人S、技术r、代理决定出处分开；按范围串行／停止；判断关联后果；文档三层与按需整体复盘。所有角色包括未改动的实现／核实／报告模板均加载本公共边界。

固定参考 `wlvh/coding-workflow@1772cd2c25bfc42b7a89cf38b35bf19d3dc22000`：Issue固化读 `zh/prompts/issue_agent.md`；正式审查读完整 `zh/prompts/pr_review_system.md`；循环读 `zh/docs/development_workflow/README.md`。不静默追随main，不以本地摘要替代失败的上游读取；目标有效政策按其范围优先核验。

结果保留自然语言与原证据；机器关联role/run/candidate/S/r/判断ID，不能代替语义正确。秘书只报操作与跟进；作者是交付建议，审核是代码判断，接收是当前组合判断，用户接受是成果选择。表现实测不自动扩大委托。
