# 用户可观察行为与验收

## 0. Authority and Scope

来源按 [Authority Map](AGENTS.md#authority-map)核对；本页描述当前 UI/CLI 可观察行为，正式入口目录统一见[用户指南](docs/business_user_guide.md#0-documentation-and-interface-entrypoints)。[PRODUCT_GUIDE](docs/PRODUCT_GUIDE.md)及细分使用文档保留各自正文职责。实现观察不自动变成永久支持承诺，测试样例不表示已运行真实业务。

## 1. Audience and Granularity

面向项目负责人、使用者、调用 Agent 和审核者。按独立用户目标核对输入、动作、结果和失败；看到页面、报告或保存成功，不能推断执行、权限或接受。`capability_contract.json` 只登记其中有既有公开依据的选定承诺。

## 2. Current behavior

### A. 固定一个 PR 的原材料

<!-- capability-anchor: CAPABILITY.fixed_pr_evidence -->
- **User goal**：让后续讨论对应准确候选，保留原响应和缺口。
- **Required context**：仓库、PR、已有连接身份；保留包时需要仓库外的新规范绝对路径。
- **User action or request**：按 [w1_cli](docs/w1_cli.md)调用 `inspect` 或 `collect`；恢复用原目录。
- **Directly observable result**：`inspect` 返回摘要或 JSON；`collect` 返回输出目录、轮次与缺口，并保留交接包。
- **Failure / degradation / escalation**：非法参数在调用外部工具前拒绝；分页、读取或候选变化的缺口保留。恢复不另换范围覆盖原件。
- **Acceptance assertion**：检查包中候选、原始响应和报告一致；退出 0 不表示本人采用或可合并。
- **Evidence**：`src/cli.ts`、`src/snapshot.ts`、`src/collector.ts`；`tests/w1/cli.test.ts`、`tests/w1/collection.test.ts`。网络测试样例不等于当次真实 GitHub 采集。

### B. 选择项目并阅读完整资料

<!-- capability-anchor: CAPABILITY.project_browse -->
- **User goal**：只看到所选账号/仓库的 Issues、PR、任务和完整原报告。
- **Required context**：启用 `githubProjects` 的有效工作台计划、可用 gh 身份与本次查看标识；本地任务是可选的。
- **User action or request**：选择仓库、翻页、打开详情或任务报告。
- **Directly observable result**：列表与原文对应当前项目；没有本地任务也可浏览仓库。原报告按文本呈现，保留来源与不完整说明。
- **Failure / degradation / escalation**：无查看标识、跨站请求、未发现项目或无效分页被拒绝；账号变化使旧选择失效。来源未知时解释缺口，不用其他项目的数据补位。
- **Acceptance assertion**：切换项目后详情不串项目；部分上游错误不显示为空成功；看报告不会发送新模型问题。
- **Evidence**：`src/github-projects.ts`、`src/workbench.ts`、`web/workbench/app.js`；`tests/w7/github-projects.test.ts`、`tests/w7/project-workbench.test.ts`、`tests/w7/workbench.test.ts`。

### C. 向右侧项目秘书提问并追问

<!-- capability-anchor: CAPABILITY.project_secretary -->
- **User goal**：在当前项目内询问事实、限制和下一步，重开后可查完整历史。
- **Required context**：所选项目、已配置 `projectSecretary`、可用 Codex 受限工具路径；不要求先登记开发任务。
- **User action or request**：输入问题并发送；完成后继续追问，或停止当前持有的执行。
- **Directly observable result**：显示等待、完整回答及来源或明确失败。追问把已核历史交给新原生上下文；页面不是对旧会话的任意接管。相同请求的重复提交不重复发送。
- **Failure / degradation / escalation**：原执行待返回或未知时不并发重发；超时/停止保留原问题和未完成状态。捕获被改后答案不可用，也不能作为追问依据。登录/模型不可用只阻相应动作。
- **Acceptance assertion**：重开读取历史新增模型输入为零；已中断/部分输出不被标成完整回答；停止准确对应原请求。请求接收成功还不表示模型已完成。
- **Evidence**：`src/project-chat.ts`、`src/project-chat-contract.ts`；`tests/w7/project-chat.test.ts`、`tests/w7/project-chat-ui.test.ts`；正式说明见 [project_secretary_chat](docs/project_secretary_chat.md)。这些测试使用明确协议样例，不能代替真实模型验收。

### D. 保存角色选择并用于新执行

<!-- capability-anchor: BEHAVIOR.ai_selection -->
- **User goal**：为当前项目选择实际可用的程序、模型和推理选项，知道何时生效。
- **Required context**：启用 AI 设置、选中项目、检测所得目录；角色所需协议已适配。
- **User action or request**：检测本机 AI、查看角色提示、保存选择或恢复默认，再从对应业务入口明确运行。
- **Directly observable result**：显示已安装/缺失、可选组合、选择版本和默认来源。保存影响后续尚未固定的执行，旧运行保持原参数；检测和保存不发送模型问题。
- **Failure / degradation / escalation**：不支持组合、未知模型/强度或配置版本冲突明确拒绝，不静默换程序或删工具。未编辑卡片可刷新，已编辑旧草稿提示冲突。
- **Acceptance assertion**：设置保存不等于执行；实际新运行捕获应包含所选参数，旧结果读回仍对应旧参数。一次目录检测不证明真实请求认证有效。
- **Evidence**：`src/ai-settings.ts`、`src/ai-catalog.ts`、`src/ai-execution.ts`、`src/additional-cli.ts`；`tests/w7/ai-settings.test.ts`、`tests/w7/ai-settings-ui.test.ts`、`tests/w7/ai-workflow.test.ts`；支持组合由 [local_ai_roles](docs/local_ai_roles.md)维护。

### E. 原任务按需要联系一个预登记任务

<!-- capability-anchor: CAPABILITY.task_contact -->
- **User goal**：A 需要 B 的具体反馈时转交完整材料，回复回到原 A 的责任链。
- **Required context**：原任务与联系计划、允许联系人、固定输入、资源和有效授权；不能只凭保存了 AI 设置开始。
- **User action or request**：从原任务支持的联系入口启动，A 决定是否选择已登记联系人。
- **Directly observable result**：普通 A 报告直接结束该路径；合法选择才发送 B，再把 B 全文交 A。页面能查看各阶段原文、等待原因和是否完成。
- **Failure / degradation / escalation**：畸形/越界联系人、缺完整捕获或资源未处理时不推进后续发送；原操作未知不换 ID 重试。
- **Acceptance assertion**：A→B→A 的每步对应计划和准确原件；“已收到控制回执”与“完整回复已消费”分别判断。不能据此宣称任意在途会话实时插话均可用。
- **Evidence**：`src/task-contact-choice.ts`、`src/messages.ts`；`tests/w6/task-contact-choice.test.ts`、`tests/w6/message-continuation.test.ts`；[task_contact_choice](docs/task_contact_choice.md)。

### F. 来源变化后接收当前材料

<!-- capability-anchor: CAPABILITY.source_reception -->
- **User goal**：从所选项目的原任务补查新材料，进入准确的独立技术接收并查看完整原报告。
- **Required context**：已登记并验证的固定候选、来源配置、`receptionControls`、原接收模板、receive 权限与资源。安装者一次固定配置，用户无需逐轮写计划或搬报告。
- **User action or request**：任务页点击“补查来源”，核当前材料后点击“接收当前材料”；完成后“查看原接收全文”。
- **Directly observable result**：来源补查零模型输入；新材料进入原 packet，旧输入/报告保持不变。明确接收为当前操作准备授权和资源，复用原接收执行器，页面分别显示未开始、在处理、原接收状态、返回和等待原因。完整报告仍由原捕获校验后提供。
- **Failure / degradation / escalation**：旧一次确认不能复用到新操作；缺资源、停止、撤销或来源失效时拒绝新增输入。H/B/目标变化等待重新固定候选。未知或已发操作沿原 operation 查回，不换 ID、不自动退款。
- **Acceptance assertion**：重复点击、仅 checks 更新、刷新或重开不新增模型输入，结束后读回同一操作的全文；技术接收不是正式 PR PASS 或本人接受。
- **Evidence**：`tests/events/normal-entry.test.ts` 与既有 `tests/w3/receiver-authority.test.ts`。新入口目前以明确协议样例验证，真实原生正常用户路径待验；[使用说明](docs/source_reception_entry.md)。

## 3. Cross-cutting User-visible Invariants

<!-- capability-anchor: BOUNDARY.unknown_no_resend -->
完成、未完成、未知和历史不适用不能互换。来源变了，旧报告仍可读但不能自动变为新材料许可；原执行未知时先核原状态，不靠刷新、换项目或改编号重发。证据见上述 C/E 及 `tests/merge/managed.test.ts` 的失回执样例。

<!-- capability-anchor: RESPONSIBILITY.owner_decision -->
临时查看标识、模型报告、技术接收和发布读回均不代替本人接受或新的执行授权。本人来源及停止边界由 `tests/authority/authority.test.ts`、`tests/w7/owner-controls.test.ts` 验证；其样例结果不证明当前用户已作决定。

各来源有各自的观察时间；工作台展示历史发布状态时不冒称本次刷新重新核过 GitHub。完整报告按原文文本显示，不执行报告中的 HTML/命令。相关证据：`tests/w7/workbench.test.ts`、`tests/w7/collaboration.test.ts`。

## 4. Known Limits and Human Escalation

<!-- capability-anchor: BOUNDARY.secretary_scope -->
已有政策要求秘书不做技术任务；当前右侧秘书更具体地只开放六种项目查询工具，没有通用开发派发。旧任务秘书可有已登记联系动作，不能把两者功能互相挪用。工具来源见 `project-chat-contract.ts` 和 `secretary-tools.ts`。

<!-- capability-anchor: BOUNDARY.runtime_minimum -->
Node 最低要求与实际能力核查见运行环境规范；版本满足不表示所有外部 CLI、Docker 或提供程序均已配置。没有真实隔离配置时暂停验证动作；没有本人来源时暂停依赖授权的控制。更换工具、补费用或扩大范围由当前有权决定的人处理，不通过页面标识绕过。

当前实现包含有限控制、修复、接收和成果流程，但不承诺任意新项目的自动全链交付或全部产品验收。安装运行清单、真实模型凭据及私人验收材料不在本源码仓库内；缺这些条件时不能用测试样例补造成功。

## 5. Combination Behavior

| 同一用户结果涉及的组合 | 现有规则确定的行为与证据 |
| --- | --- |
| 更换项目 + 历史秘书对话 | 对话绑定账号、仓库 ID/node ID；其他项目不能读或续接。`tests/w7/project-chat.test.ts`、`tests/w7/github-projects.test.ts`。 |
| 保存新模型 + 已开始/已准备执行 | 新设置只进入后续未固定输入；旧执行及读回复用原选择。`tests/w7/ai-workflow.test.ts`、`tests/w7/ai-settings.test.ts`。 |
| 阶段协调 + 新停止条件 | 下一受影响动作核准确材料/消费和停止状态；独立调查不自动随依赖阶段一起停止，已发操作继续核原结果。`tests/coordination/feedback.test.ts`、`tests/w7/scope-controls.test.ts`。 |
| 合并响应丢失 + 用户重入 | 查原请求及实际目标，不重复发送合并；真实版本验证消费对应新证据。`tests/merge/managed.test.ts`；这是提供程序样例，非生产合并证明。 |

## 6. Open questions

本轮检查了上述入口、代码、测试、产品基线和明确替代的依赖规则，未发现必须由本次文档工作新增决定的公共语义分歧。尚未接通的广泛能力和外部验收条件沿 [PRODUCT_GUIDE](docs/PRODUCT_GUIDE.md#unfinished-work) 的原记录维护，不因缺实现或缺验证自动登记新政策问题。

后续若出现确需新决定的分歧，在此记录 Current evidence、Current behavior / safe boundary、Decision、Close when；决定落地后改为当前行为并补相应测试，不把“尚未找到决定”写成“从未决定”。

## 7. Interface Entrypoints

公开使用入口和正式参考统一见[用户指南的接口目录](docs/business_user_guide.md#0-documentation-and-interface-entrypoints)。本页展开结果与失败语义，不另建接口目录。
