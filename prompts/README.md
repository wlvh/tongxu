# 同序角色指令 v2.2

这些是可装配的角色 prompt，不是已经运行的 Agent，也不授予工具权限。完整规则见 `../docs/tongxu_v2_plan.md`。真实执行器接入在 W4；前端离线演练不代表角色已接通。

## 装配顺序

运行器读取固定版本的 `runtime_contract.md`，再读取以下一个角色文件；适用时完整加载所采用的上游正式提示，最后附本轮可信输入包。不要把所有角色拼给同一个 Agent，不把秘书设为其他角色的技术上级。

| 角色 | 文件 | 默认引擎／上下文 |
|---|---|---|
| 工作秘书 | secretary.md | 独立 Codex App Server 会话，协调工具白名单 |
| Issue 交付负责人 | issue_owner.md | Codex 或 Claude Code，原任务连续上下文 |
| 子任务实现者 | implementer.md | 独立原生会话或原负责人顺序 Run |
| 正式独立审核 | reviewer.md | 新的独立 Codex 上下文 |
| 事实核实与综合 | verifier_fact.md | 新 Codex 核实上下文；修复须实际转交写权 |
| 影响面核实 | verifier_impact.md | 独立 Claude Code 上下文 |
| PR 接收／集成 | receiver.md | 独立 Claude Code CLI 会话，不与秘书／作者共用 |
| 外部技术解读／简化反思 | external_report.md | 已采用流程中的网页 GPT，平台准备固定材料 |
| 用户路径验收 | acceptance.md | 按项目已采用的计划与执行分工，不由秘书代替 |

`tool_policy.json` 是运行器必须落实的最小角色权限设计，名称是待注册的同序接口，不声称官方 CLI 原生存在这些工具。接口不支持禁用秘书的任意 shell／代码写入时，秘书控制模式不开放；仅贴提示不算权限隔离。

## 上游固定提示

参考工作流：`wlvh/coding-workflow@1772cd2c25bfc42b7a89cf38b35bf19d3dc22000`。Issue 固化时读取 `zh/prompts/issue_agent.md`；正式代码审核时读取完整 `zh/prompts/pr_review_system.md`；角色和循环读取 `zh/docs/development_workflow/README.md`。不得静默追随 main 或用原型缩写替代。目标项目已采用不同有效流程时按其范围配置，不由本目录自动覆盖。

上游材料读取失败：保留该阶段待核，报告缺少的具体提示与固定版本；可以继续独立调查，不能把本地摘要当正式审核 prompt。W0 本身仍不依赖角色运行器。

## 结果

保留自然语言正文与原始证据。机器结果仅做 role/run/candidate/scope/plan/evidence/verdict 的关联，不替语义判断。秘书输出已做／正在跟进／待决定／未知，不输出技术 PASS。作者输出交付建议，审核者输出正式审核，接收者输出有范围的接收判断，三者不混用。
