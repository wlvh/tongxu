# 同序使用导航

同序把项目目标、代码候选、验证、独立判断和协作跟进连到原记录。本页是短导航；[项目机制总览](PRODUCT_GUIDE.md)及下列细分文档在原范围内仍是正文权威。来源与冲突处理见 [Authority Map](../AGENTS.md#authority-map)。

## 0. Documentation and Interface Entrypoints

| 要做什么 | 正式入口与文档 |
| --- | --- |
| 理解协作、应有能力与当前余项 | [PRODUCT_GUIDE](PRODUCT_GUIDE.md)、[产品基线](tongxu_v2_plan.md)；流程图不表示每条路径已自动执行。 |
| 安装依赖/判断环境 | [runtime_compatibility](runtime_compatibility.md)、[TESTING](../TESTING.md#0-canonical-test-entrypoints)；Node 最低 24.0.0，并需实际 SQLite 事务能力。 |
| 只读检查/采集 PR | `node dist/src/cli.js inspect/collect`；参数、输出、relay 和恢复见 [w1_cli](w1_cli.md)。 |
| 验证固定候选和组合 | `node dist/src/cli.js verify`；[w2_verification](w2_verification.md)、[docker_verification](docker_verification.md)。 |
| 导入与查看队列 | `node dist/src/cli.js queue`；[w3_shadow_queue](w3_shadow_queue.md)。普通影子评估不等于独立模型接收。 |
| 原生元数据隔离自检 | `node dist/src/native-cli.js inspect`；[w4_native_inspection](w4_native_inspection.md)。此专用入口要求 Linux/bubblewrap，不调用模型；它与正常项目秘书/消息入口分开。 |
| 启动本机工作台 | `npm run workbench -- --plan ABS_PLAN`；[local_workbench](local_workbench.md)、[github_project_entry](github_project_entry.md)。安装清单入口为 `node dist/src/workbench-launch.js --runtime ABS_RUNTIME [--open]`。 |
| 按项目提问/读取历史 | 工作台右侧秘书；选择“发送给”可保存已登记原任务的补充，参见 [project_task_supplements](project_task_supplements.md)；[project_secretary_chat](project_secretary_chat.md)。旧任务查询/跟进另见 [readonly_secretary](readonly_secretary.md)、[secretary_original_reports](secretary_original_reports.md)。 |
| 选择本机程序、模型和角色 | “AI 与角色设置”；[local_ai_roles](local_ai_roles.md)、[cli_capabilities](cli_capabilities.md)。 |
| 从已审定 Issue 新建一次受控实现 | 项目页“已审定 Issue 的受控实现”；[操作、安装前置与待验边界](issue_implementation.md)。登记不表示已发，成功H1不表示正式审核/发布；真实Codex路径仍待准确环境核验。 |
| 登记/联系原任务与阶段协调 | `tasks`、`messages`、`coordination` 的 package 脚本及工作台已登记入口；[task_intake](task_intake.md)、[task_contact_choice](task_contact_choice.md)、[task_coordination](task_coordination.md)。 |
| 来源补查后独立接收 | 选择项目 → 原任务 → “来源补查与独立技术接收”；[source_reception_entry](source_reception_entry.md)。安装者须先固定候选、来源、接收权限与资源；真实原生正常入口待验。 |
| 单张 PR 的正式完整审核 | 任务页“正式 PR 审核”；[formal_pr_review](formal_pr_review.md)。完整审核、批次验证、原会话修复、实际发布和新候选完整复审分别可见；真实模型外层演练仍待配置验证。 |
| 接收、退回、修复或集成 | [native_reception](native_reception.md)、[return_workbench](return_workbench.md)、[controlled_repair](controlled_repair.md)、[minimal_integration](minimal_integration.md)、[managed_workspace_handoff](managed_workspace_handoff.md)；按各规范的专用 CLI/计划进入。 |
| 授权、停止、发布、合入与成果 | [owner_authority](owner_authority.md)、[scope_controls](scope_controls.md)、[result_publication](result_publication.md)、[managed_merge](managed_merge.md)、[delivery_outcomes](delivery_outcomes.md)、[delivery_assessment](delivery_assessment.md)；需要各自配置和权限。 |

工作台是受本机查看标识保护的 UI 后端；没有已配置的通用远程 SaaS、公共 OpenAPI 或 MCP 服务契约。内部 `/api/` 路由不是能力登记表生成的外部稳定接口；程序接入优先用已有 CLI 和正式规范。

## 1. Value

适合需要知道“结论针对哪版代码、谁实际执行过、还有什么未知”的项目负责人和协作者。输入可以是 GitHub 仓库/PR、已采集材料或安装者配置好的原任务；输出是原件、缺口、完整报告和有范围的状态。只读查询本身可完成一次使用，不必进入开发、合入或成果接受。

## 2. Typical Uses

选择当前项目后查看 Issues、PR、任务和报告；向秘书询问材料显示什么并核回答来源。已有授权任务需补查或处理 RETURN 时，从原任务已登记入口推进。已配置的 PR 可从任务页启动正式审核：整批问题和完整报告由程序转交；查看具体缺口或业务取舍，并可停止。局部修复、待发布、待正式结论与正式 PASS 含义不同；成果仍沿 #9 确认真实使用结果。可观察行为和失败断言见 [interact](../interact.md)。

源码使用者先满足环境要求、安装依赖并构建，再运行 CLI 帮助或正式命令。工作台需要有效的私人计划；`ABS_PLAN`/`ABS_RUNTIME` 是占位路径，不是附带文件。正常安装入口由安装者交付，源码 checkout 不含所有人可直接运行的桌面启动文件。

## 3. Capability and Responsibility Boundaries

<!-- capability-anchor: BOUNDARY.secretary_scope -->
秘书负责查询、解释和明确装配过的跟进；当前右侧项目秘书模型没有通用新开发派发、写代码、测试或合并工具。页面可为已登记任务保存补充，成功结束后的处理由原有权限与资源约束的实施消费者负责，不给秘书写权。AI 设置只决定新执行的偏好，不增加任务、文件、费用或合并权限。当前秘书使用 Codex 受限工具路径；其他程序能处理材料消息不等于支持全部角色。

<!-- capability-anchor: RESPONSIBILITY.owner_decision -->
技术判断、发布状态、实际合并和用户接受分开。本人来源或委托未配置时限制相应动作，仍可使用适用查询。未完成的广泛验收沿 [PRODUCT_GUIDE 原记录入口](PRODUCT_GUIDE.md#unfinished-work)查证，页面可用不表示全部完成。

## 4. Context to Provide

| 场景 | 需要提供的内容 |
| --- | --- |
| PR 采集 | `OWNER/REPO`、正整数 PR 编号、按需 Issue/上下文、仓库外不存在的新私人输出目录；使用已有 Git/gh 身份。 |
| 候选验证 | 已有 W1 包、准确 Git 对象、明确命令/样本计划、新输出目录和隔离环境；不会自动安装项目依赖。 |
| 项目秘书 | 当前所选项目和具体问题；历史问题给出准确任务/报告，不混入其他项目或旧候选。 |
| 有副作用动作 | 原任务、准确候选/输入、资源和有效授权；聊天文字不能替代执行器所需本人来源。 |

公开 Issue/PR 不粘贴私人报告、启动 URL 查看标识、令牌或本机绝对路径。

## 5. Representative Real Cases

以下案例有现有实现和测试覆盖，模拟程序结果不称为真实模型运行。

1. **查看新项目资料**：选择可访问仓库，读 Issue/PR 全文；没有本地任务也能浏览。账号变化后旧选择失效，网络/权限错误明确显示。证据：`tests/w7/github-projects.test.ts`。
2. **秘书连续提问**：问“原报告有哪些限制”，完成后追问；页面显示全文和来源，重开不重复发问。中断保留不完整状态。证据：`tests/w7/project-chat.test.ts` 的本机 HTTP/协议样例。
3. **原任务联系其他负责人**：在预登记计划中，A 可选择允许的 B，B 全文交回 A；普通 A 报告不触发联系。缺原件/资源未处理时保留等待原因。证据：`tests/w6/task-contact-choice.test.ts`。

<!-- capability-anchor: CAPABILITY.source_reception -->
4. **来源出现新反例**：原候选评论新增“空输入仍会出错”，打开原任务并补查来源。新评论进入当前材料，旧接收只针对历史材料；点击接收后按当前授权和资源处理，完成后打开原报告全文。重复打开不重发；原接收已登记但结果待核时，使用“查回当前原接收”，停止新增投入后仍可核原结果。仅 checks 变化不会新建不必要的接收；候选 H/B/目标变了要先重新固定候选。此入口的自动场景使用明确模型/来源/账本样例，真实模型正常路径仍待验，不能代填本人验收。

## 6. Reading Results

看到完成先看是哪一步：采集、模型完整返回、材料消费确认、技术判断、远端读回和本人接受各有证据。历史结论可读，但来源改变后不能充当当前候选许可。工作台显示各来源观察时间，不保证跨库同时或本次刷新已查远端。

缺数据、未配置、尚未验证和明确拒绝含义不同。CLI 退出码按具体命令解释；采集/验证退出 0 不授予合并或业务通过。报告作为文本供人阅读，不因包含命令就自动执行。

## 7. Human Escalation

认证失效、缺计划/隔离工具/本人来源时，由安装者或项目负责人补齐该动作所需条件。原执行未知时保留记录，按对应恢复入口核查，不换编号重发。目标、费用或公共语义需新增决定时，带准确项目、候选、错误和证据交有权决定的人。

## 8. Feedback and Ownership

反馈沿本仓库[原 Issue 或新 Issue](https://github.com/wlvh/tongxu/issues)关联入口、预期与实际，删除私人材料。没有单独配置文档值班负责人或紧急响应时限，GitHub 留言不表示已有人接手。本机安装与私人记录由实际操作者管理，本页不承诺远程代管。
