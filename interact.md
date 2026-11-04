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


### 从已审定 Issue 新建一次实施

<!-- capability-anchor: CAPABILITY.issue_implementation -->
- **User goal**：在已配置项目中把一项已审定工作交给实际实施者，直接查看测试过的新提交与全文。
- **Required context**：固定提交、采用的 Issue 正文、已有准确实施/测试权限、资源、Codex 和注册 Docker 测试配置；正常入口真实 Codex 路径仍待准确环境验证，当前能力登记为 pending_validation。
- **User action or request**：项目页选择“已审定 Issue 的受控实现”，核对目标及获准文件，点击“新建本次工作”；缺条件时沿原 ID 的“继续原请求”补准备或首次发送，也可查看、撤回未发请求或停止本次实施。
- **Directly observable result**：登记/准备、正在处理、完整返回、H0→H1、待核和保留差异分别显示。成功报告、diff、测试输出和提交绑定从同一原请求读取；无变更不制造提交。
- **Failure / degradation / escalation**：缺审定、准确权限/资源、队列席位或真实环境时保留具体等待原因。条件恢复后，仅完整不变且确证未派发、无执行证据/修改/竞争写者的原准备可以继续首次发送；来源改变、停止、取消或资源未知仍拒绝。已发送未知不另发，已有修改的失败现场不自动接续。部分现场不是完整报告或已结束证明。
- **Acceptance assertion**：重复点击/冷重开只回原请求；同 ID 改目标拒绝；正确 H1 对应实际测试树和完整捕获，源仓库保持只读；原件损坏拒绝完整回读。普通消息仍只读，实施不授予发布、合并或本人接受。
- **Evidence**：`src/issue-implementation*.ts`、工作台真实入口和 `tests/project-repair/integration.test.ts`、`tests/w7/github-projects-ui.test.ts`；模型协议样例与真实模型证据分开。详见 [issue_implementation](docs/issue_implementation.md)。


### 从单张 PR 启动正式完整审核

<!-- capability-anchor: CAPABILITY.formal_pr_review -->
- **User goal**：对关联已采用 Issue 的 PR 得到准确版本的正式结论，必要时经过整批验证和授权修复，再审已发布的新版本。
- **Required context**：私人项目目录、准确候选、采用 Issue/范围、固定完整角色提示、原接收/实施/测试权限及分析/修复/新候选测试资源、真实 CLI 和注册 Docker 配置；当前为 pending_validation，真实外层模型演练与本人接受分别待核。
- **User action or request**：正常“任务与完整报告”选择 PR，点击“正式 PR 审核”；查看完整报告，按需要停止后续动作或核对发布。
- **Directly observable result**：新完整 reviewer、同批新 fact/impact、原 fact 综合/有界证据交换、同会话授权修复、本地提交、待发布、新候选采集/验证、新完整审核分别保留。完整 PASS 无 P0/P1 或仅 P2 时直接结束；全批反证在未变候选上追加正式 reviewer 结论，不制造修改。原报告可全文回读。
- **Failure / degradation / escalation**：空 finding 但覆盖不足仍待补证；三轮分歧后不强行投票；停止、权限或资源不足时不启动后续动作。H/B/target/采用要求改变后旧报告不放行当前 PR；已发未知和失去持有权的原事实会话不换 ID 重发。真正业务取舍沿原 Issue 保存问题和答复，没有获准写入路径时明确待记录。
- **Acceptance assertion**：本地 H2 不等于远端发布；准确远端 head、对应 PR 修复记录和当前新材料核清后才新审。每轮新 reviewer/new batch 独立，修复确属本批原 fact session/thread；单轮完整捕获不冒称原生进程已经退出。发布返工使用原记录并按同 head 去重；查看、重开和直接 PASS 后新增模型输入为零。
- **Evidence**：`tests/w5/formal-*.test.ts`、`tests/w7/formal-workbench.test.ts` 及共享领域回归；[正式入口、安装条件与证据范围](docs/formal_pr_review.md)。协议样例、真实 Docker、真实模型和本人接受分别报告。
