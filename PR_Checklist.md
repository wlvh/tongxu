# 交付与 PR 核对清单

只勾选有本次证据的项目，来源和适用范围见 [Authority Map](AGENTS.md#authority-map)。清单帮助交付，不增加权限；原 [CODEX_NEXT](docs/CODEX_NEXT.md) 将分支开发与主干合入分开。当前用户明确授权的具体动作按其范围执行，不推导永久权限。

## Scope and Git State

- [ ] 核当前任务、原负责人、已有结果、工作区和未提交修改，未覆盖别人现场或重复派发未知执行。
- [ ] 从真实仓库/任务解析目标 base、head 和准确提交；声明未合前置及额外内容，前置变动后重核。
- [ ] 检查工作树与暂存区 diff、最终相对 base 的文件范围；内容与交付说明一致。
- [ ] 没有私人路径、凭据、启动 URL 查看标识、数据库、模型原件、临时草稿、`dist/`、依赖或锁文件误入提交。
- [ ] 只执行当前授权覆盖的提交/推送/PR/主干动作；没有从开发许可推导合并、强推、保护设置、部署或费用许可。

## Tests and Evidence

- [ ] 从 [TESTING](TESTING.md#0-canonical-test-entrypoints) 和当前 package 脚本选择受影响入口，核 Node 最低要求与实际平台条件。
- [ ] 无 test diff 时说明具体已有覆盖和重跑证据；修复 bug 保留修复前反例或说明不能稳定复现的原因。
- [ ] 每次记录 exact command、scope、result、not-run reason、environment、side effects、cleanup。
- [ ] 清楚区分构建、协议样例、本机组件场景、真实隔离、真实模型/远端调用和用户验收；没有以 `npm test` 或单个绿色结果声称全仓通过。
- [ ] 受影响的恢复、旧原件、重复输入、越界/缺条件路径已有证据；未运行的相关环境及风险明确披露。

## Documentation and Contracts

- [ ] 按实际影响核架构、能力登记、可观察行为、使用导航、测试与流程；日常局部变更不机械修改全部文档。
- [ ] 既有正式文档保持原范围内权威；事实、政策、历史证据与待完成产品范围没有混写。
- [ ] 用户指南的正式入口与真实 CLI/UI 一致；计划、提示模板和内部函数未被包装成当前可用能力。
- [ ] `capability_contract.json` 合法，ID 唯一、注释引用有效、测试路径存在；缺测试条目说明原因和登记日期。未配置的自动 checker 不被写成现成门禁。
- [ ] 范围内没有模板填充残留，链接可达；`Not applicable`、`Not configured`、尚未确认各有依据。
- [ ] 共享约定的影响沿 [Change propagation](architecture.md#change-propagation) 调查；派生文档引用权威定义，未另造进度账本或重复规则。

## Review Closure

- [ ] 按 [SOP](SOP.md#开发同序)及固定采用流程第9步，由新 Codex 对话完整审核准确最新 head；开发自审和局部复核分别标明。
- [ ] 本轮全部 P0/P1 整批交新 Codex/Claude 验证，Codex综合；必要分歧交换最多三轮，证据不足保留 REWORK_REQUIRED 与补证动作。
- [ ] 按明确指令及有效授权在本批原 Codex 验证会话修复；每次推送新 head 后重新由新 Codex 对话完整审核，逐轮更新 PR Review / Fix Record。
- [ ] PASS / REWORK_REQUIRED / OWNER_DECISION_REQUIRED 与 waiting/unknown/interrupted 等执行事实分开；P2和实质 owner 决定及理由保留在原记录，实质决定回写同一 Issue。


- [ ] 按原开发/交付约定完成隔离作者上下文的独立审核；记录审阅对象、审核者、范围及限制。不能独立时如实待审，不自批。
- [ ] 已处理可执行问题并给关闭证据；候选语义变化后重核受影响内容，原审核结论不自动沿用。
- [ ] 新公共语义若超出授权，保留具体问题与安全边界；已解决的问题更新权威说明及必要行为测试。
- [ ] 最终文件、测试结果、独立判断与交付对象一致，未把测试通过推导成已合并或本人接受。

## PR Delivery

- [ ] 合并后第11步最终源码的离线 HTML 解释和用户/文档指引检查归档 PR 评论；第13步 GPT 网页版与 Claude Code 合意的用户验收计划先归档，再由 Codex 正常入口实际执行。尚未执行准确标注；第12步继续暂停。


- [ ] 需要 PR 时按[模板](.github/pull_request_template.md)写当前问题、结果、实际范围和证据；短改动可简写，没有适用内容的章节明确注明依据。
- [ ] 创建/更新前核标题、base、head、正文和实际 diff；正文临时文件在仓库外。
- [ ] 发布后读回远端 head、目标和实际文件，准确区分 Draft、已合并、安装启用及用户接受。
- [ ] 失败或未知保留可恢复结果，说明阻点和下一步；不靠重发、删除原件或强推抹平差异。

此清单不要求固定提交数量或替维护者选择合并策略；根配置未提供这类自动规则，按具体任务和仓库当前设置处理。


涉及正式 PR 外层入口时，核完整范围、新 reviewer/双验证批次身份、原 fact 修复、直接 PASS 零后续调用、准确远端新 head/修复记录、原采集验证材料、在途候选变化与未知不重发。记录协议样例、真实 Git/Docker、真实模型、独立审核和本人接受的实际范围；发布返工只用原实际发布记录。详见 [formal_pr_review](docs/formal_pr_review.md)。
