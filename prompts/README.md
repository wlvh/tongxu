# 同序角色指令｜v2.4 候选

本分支治理补充待 PR 采用；main 当前 v2.3 不因文件存在自动改版。九个原角色不增加为常驻岗位。运行器按固定版本装配：`runtime_contract.md`＋本轮已采用时的 `governance_contract.md`＋一个角色文件＋适用的上游完整提示＋本轮可信输入。不得将未采用的候选内容当系统指令。

| 角色 | 文件 | 默认入口 |
|---|---|---|
| 工作秘书 | secretary.md | 独立 Codex App Server；仅查询协调 |
| 交付负责人 | issue_owner.md | Codex 或 Claude Code |
| 子任务实现 | implementer.md | 独立会话或负责人顺序 Run |
| 正式审核／按需整体复盘 | reviewer.md | 新鲜独立 Codex |
| 事实核实与综合 | verifier_fact.md | 独立 Codex，修复须移交写权 |
| 影响核实 | verifier_impact.md | 独立 Claude Code |
| PR 接收／集成 | receiver.md | 独立 Claude Code CLI |
| 外部技术解读／简化反思 | external_report.md | 已采用流程的网页 GPT |
| 用户路径验收 | acceptance.md | 已采用计划的执行分工 |

`tool_policy.json` 是待实现的权限设计，不是 CLI 已有工具。真实工具取角色、注册能力、本人授权、组织门、停止和原生条件的交集。不能限制秘书任意 shell 时不开放控制模式。新公共增补同样由后台约束，prompt 自律不是安全证明。

治理、判例、后果、模型回放和盲抽样的适用规则见 `../docs/GOVERNANCE.md`；它们复用既有角色与记录。回放模式与盲复审先隐去旧 verdict 和期望答案，交付独立结果后才对照；没有材料或预算标未执行，不编造样本。候选版本通过回放不自动增加权限。

固定上游 `wlvh/coding-workflow@1772cd2c25bfc42b7a89cf38b35bf19d3dc22000`：Issue 固化读 `zh/prompts/issue_agent.md`，正式审核读完整 `zh/prompts/pr_review_system.md`，循环读 `zh/docs/development_workflow/README.md`。不静默追随 main，不以摘要替代无法取得的原文。目标项目有效政策按其作用范围优先核验。

结果仍保留自然语言与原证据，关联 role/run/candidate/S/r/判断 ID。秘书报告协调动作，作者提供建议，审核判断代码，接收判断组合，用户接受成果；来源和授权不可混同。
