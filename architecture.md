# 同序架构

## 0. Scope and Update Triggers

本文覆盖本仓库的 TypeScript CLI、本机工作台、原任务记录、模型适配和受管执行。事实与政策的适用范围见 [Authority Map](AGENTS.md#authority-map)。[产品指南](docs/PRODUCT_GUIDE.md)描述目标和协作机制；这里说明代码怎样实现其中的有限路径。仓库外的运行清单、私人队列、真实模型报告和生产配置不随源码分发，不能从它们曾存在推断本次 checkout 已配置。

入口、候选身份、授权检查、原件格式、恢复方式、模型工具或控制装配改变时，更新相关章节及测试映射。局部文案修改不要求重新审计所有子系统。

## 1. System Purpose

同序帮助项目负责人把 GitHub 候选、验证材料、独立判断和任务协作放在可核对的原记录上。用户能选择项目、查看 Issues/PR 与完整报告、询问受限秘书，并在已配置的任务和权限内启动有限动作。后台负责固定输入、检查前置、发送、保留原件与读回；模型负责其被授予角色的分析或判断。代码合入、软件启用、真实场景验证和本人接受是不同结果。当前不是任意新项目的一条全自动开发链。

## 2. Runtime Entrypoints and Main Flows

正式使用目录见[用户指南](docs/business_user_guide.md#0-documentation-and-interface-entrypoints)；构建与测试命令见 [TESTING](TESTING.md#0-canonical-test-entrypoints)。

| 入口 | 实际调用与输出 |
| --- | --- |
| `src/cli.ts` → `dist/src/cli.js` | `inspect`/`collect` 经 `collector.ts`、`transport.ts` 固定 GitHub 与 Git 材料；`Snapshot` 保存原始响应、候选与交接信息。`inspect` 输出后清理临时目录；`collect` 保留私人包。 |
| 同一 CLI 的 `verify` | `verification.ts` 用已有包、Git 对象与明确测试计划构造固定树；交给 `sandbox.ts` 或明确配置的 `docker-sandbox.ts` 执行，`comparison.ts` 对照样本。 |
| 同一 CLI 的 `queue` | `queue-cli.ts` → `QueueStore` 导入材料、维护原操作与停止状态；普通影子评估不自动派发模型或合并。 |
| `native-cli.ts inspect` | `native-inspection.ts` 在 Linux/bubblewrap 的断网私人现场检查已装 Codex 的元数据协议；不发送模型轮次，不是 macOS 项目秘书的启动入口。 |
| 专用任务与执行 CLI | `task-cli.ts`、`message-cli.ts`、`coordination-cli.ts`、`integration-cli.ts` 等消费各自计划和原记录；接收、修复、发布、合并各有独立入口与前置，不按报告文本执行任意命令。 |
| `workbench-cli.ts` | 读取 `--plan` 指定配置，经 `startWorkbench` 装配 GitHub、项目秘书和可选控制，启动回环 HTTP 服务，提供 `web/workbench/` 静态页面与 JSON 响应。 |
| `workbench-launch.ts` | `--runtime` 读取安装时生成的清单，核源码、构建、页面、提示与计划，再动态导入同一工作台；`--open` 在 macOS 打开浏览器。构建本身不生成或启用安装清单。 |

工作台主流程是：校验计划 → 选择当前 GitHub 账号/仓库 → 筛选该项目原任务 → 读取原记录或调用已装配控制 → 返回结果与缺口。右侧项目秘书走 `ProjectChat` → `BoundedCodexSession`，只在显式提问后发送；追问把已核历史传入新的原生上下文，不声称接管旧会话。旧任务秘书走 `SecretaryControls`/`runSecretary`，使用自己的已登记动作。配置的 `SourceTickLoop` 可在工作台生命周期做有次数上限的来源补查；启动无模型输入不等于没有后台活动或本地记录写入。

## 3. Architecture Invariants

| 约束及适用范围 | 实现、反例与后果 |
| --- | --- |
| 结果对应准确输入；旧结果不自动成为新候选证据 | `snapshot.ts`、`queue-evidence.ts`、`codex-results.ts`、`message-store.ts` 核原件与身份。改变候选或捕获字节应产生不适用/错误，而非本轮成功。见 `tests/w1/collection.test.ts`、`tests/w4/codex-results.test.ts`。 |
| 查看权限与执行授权分开 | `workbench.ts` 的临时查看标识只保护本机入口；`authority-source.ts`、`authority-store.ts` 核本人来源、范围和委托。复制报告或 owner JSON 不能产生授权。见 `tests/authority/authority.test.ts`。 |
| 已发送或原进程未知时先查原执行，不自动重发 | `project-chat.ts`、`managed-merge.ts` 查原捕获、PID 与响应；缺失进程证明保留 `unknown`。失去回执、换页面或升级 CLI 不等于从未发送。见 `tests/w7/project-chat.test.ts`、`tests/merge/managed.test.ts`。 |
| 新动作重核阶段条件；新安排不追溯改变旧输入 | `coordination.ts`、`task-store.ts`、`scope-controls.ts` 和具体控制入口执行检查。生产者材料或停止条件不满足时暂停依赖动作。见 `tests/coordination/feedback.test.ts`、`tests/w7/scope-controls.test.ts`。 |
| 模型偏好不增加权限，已固定运行不追溯换绑 | `ai-settings.ts` 的项目偏好经执行边界保存；`ai-execution.ts` 和适配器核支持能力。错误模型/强度或不支持组合应拒绝，不静默换程序。见 `tests/w7/ai-settings.test.ts`、`tests/w7/ai-workflow.test.ts`。 |

这些是有范围的实现与已有政策约束，不是对恶意宿主或全部未来 CLI 的保证。提示中的职责规则仍需执行层限制；`prompts/tool_policy.json` 自身标为设计约定，不能证明全部工具已经安装。

## 4. Module Responsibility Boundaries

| 模块组 | 责任和依赖边界 |
| --- | --- |
| 材料采集与对照 | `collector`、`git`、`transport`、`snapshot`、`handoff`、`verification` 保存事实与样本；不把命令成功解释为用户接受。 |
| 原队列及领域记录 | `queue-store` 与 `task-*`、`review-record-*`、`integration-*`、`delivery-*` 维护原任务状态和来源；页面派生视图，不另建批准账本。 |
| 授权、资源与执行 | `authority-*`、`resource-*`、`receiver`、`repair`、`publisher`、`managed-merge` 核原候选、本人来源、资源与真实结果；模型文字不能替代这些条件。 |
| 原生模型与消息 | `native-rpc`、`live-codex`、`live-claude`、`message-runtime`、`message-claude`、`additional-cli` 负责协议、完整输出和失败捕获；`role-prompts` 装配提示而不授予权限。 |
| 项目入口与工作台 | `github-projects`、`workbench`、各 `*-controls`、`project-chat`、`ai-settings` 组织资料和已登记动作；页面不是任意文件/SQL/shell 接口。 |

依赖方向以代码为准：UI → 工作台/具体控制 → 原记录及受管执行器 → 外部程序。记录模块存在跨域校验和 SQL 触发器，上表不表示完全独立服务。

## 5. Data Flow and Data Contracts

“候选”指准备检查的准确代码版本。`contract.ts`、`snapshot.ts`、`queue-evidence.ts` 保存仓库、PR、源提交 H、目标基线 B 等；验证层进一步记录实际树与 HEAD。测试结果与接收判断须对应相同材料，不能只按 PR 编号关联。

工作台计划使用 `schemaVersion: 1` 和 `kind` 区分本机/受控模式，`parseWorkbenchPlan` 核来源、路径、摘要和所选控制。任务、消息、授权、集成和成果各有 `*-contract.ts` 解析器，不能用一个领域的版本号解释全部对象。

请求解析和核权后，原输入/输出保存为文件或数据库原件，派生报告用摘要引用。`task-contact-choice.ts` 只接受绑定计划摘要的预登记联系人：A 的完整回复及资源已处理后才选择 B，B 的完整回复再交回 A；普通报告或畸形选择不会触发任意联系。完整原文、材料消费确认、进程结束和资源状态分别核验。

`capability_contract.json` 是文档承诺登记；当前代码没有从它生成 CLI、HTTP 路由、模型工具或运行授权。

## 6. State and Persistence Model

- `Snapshot.create/resume` 管理清单、原始页与锁。显式输出须是仓库外、绝对规范路径和新私人目录；恢复沿原范围与原件，不覆盖另一个采集包。
- 队列根目录保存 `queue.sqlite`，采用 SQLite WAL（将未归并事务写入旁边日志）、完整同步和事务检查。`QueueStore.observe` 使用只读连接；写入口及格式升级独立，活动/未知操作会限制升级。不能只复制主数据库就宣称得到一致备份。
- 项目秘书保存 `conversations.sqlite`、每次问题的原输入、原生捕获和答案；内存 `active` 只表示当前进程持有的执行。重开查原记录和进程，内存丢失不表示任务结束。
- AI 设置保存在 `settings.sqlite`，按账号、仓库数值 ID 及 node ID 隔离，保留选择版本和变更。保存偏好不是新任务调度。
- 工作台各队列分别读取并保留观察时间；没有跨库同时快照，展示历史发布记录也不表示重新查询了远端。

没有调查到通用自动备份、任意版本自动迁移或系统级断电恢复承诺；安装演练只证明其具体场景。恢复入口见 [SOP](SOP.md)。

## 7. Error and Failure Model

`cli.ts` 对采集/验证使用退出码 0（该请求完成）、2（已保存缺口或观测样本失败）、1（输入/本地错误）；专用 CLI 按其正式说明解释，不能推广统一成功语义。

工作台对未知来源、越界项目、无查看标识或缺配置给明确错误；来源不可用不伪造空成功。部分响应为 503 并带稳定错误名，不表示可以自动重试写动作。报告按文本展示，内容中的指令不变成控制调用。

`managedMergeAction` 的普通重入返回原操作；失去响应用 `reconcile` 查原发送和真实目标，仅确证拒绝后才允许专门的显式重试。撤销权限不抹去已发副作用。项目秘书超时/停止保存原问题与不完整状态；原件被改会显示不可用，不能继续作为追问依据。

## 8. External Dependencies, Authentication, and Configuration

Node 最低 24.0.0，启动还核 `node:sqlite` 严格表、写入和事务回滚；TypeScript/Node 类型、Acorn、smol-toml 最低范围以 `package.json` 为准。`.npmrc` 禁安装脚本及锁文件生成，`tsconfig.json` 定义 ES2023、NodeNext、strict 和 `noUncheckedIndexedAccess`。

Git/gh 使用已有本机身份；GitHub 项目入口只读查询实际账号可访问仓库，不内置登录或账号切换服务。Codex/Claude 和额外 CLI 由操作按实际协议能力核验；Kimi/Gemini/OpenCode 目前接无工具材料消息，不等于受控修复、正式审核或秘书工具都可用。适配矩阵由 [local_ai_roles](docs/local_ai_roles.md)维护。

隔离验证使用 Linux/bubblewrap 或显式选择的本地 Docker socket、已有镜像及配置，不关闭隔离来绕过依赖缺失。本人来源、资源与发布配置均由各自入口验证。[runtime_compatibility](docs/runtime_compatibility.md)规定最低要求和能力检查替代长期版本/路径白名单；一次执行的原始身份仍保留。

## 9. Artifacts and Side Effects

Git 跟踪源码、测试、角色提示、页面资产、规范和历史设计/验收材料。`dist/`、`node_modules/`、锁文件及测试失败目录由 `.gitignore` 排除；编译生成 JS 不等于运行验证。`prototypes/` 的设计原型不是实际 `web/workbench/` 页面。

采集有网络读取和私人文件写入；验证会建临时 Git 现场/隔离进程；秘书显式提问可产生模型费用；授权执行可能写受限工作区或远端 GitHub。刷新报告、保存设置和实际执行各有不同副作用。数据库和模型原件属于私人运行材料，不放入公开 PR。

## 10. Extension Points and Architecture Debt

扩展面是具体协议适配器、角色能力声明、带验证的计划解析与可选控制；添加适配器仍需补实际消费路径和恢复证据，不能只加检测名称就宣称角色可执行。

`queue-store.ts` 集成多领域状态与触发器，修改时容易漏掉预开连接、旧格式和原件消费者；`workbench.ts` 装配多个入口，须查配置关闭和跨项目边界。这里记录维护风险，不预设拆服务任务。通用新开发派发及未完成产品范围沿 [PRODUCT_GUIDE](docs/PRODUCT_GUIDE.md#unfinished-work)的原记录入口跟进，不另建进度账本。

## Change propagation

| 变更类型 | 需要继续调查的影响面 | 相应验证 |
| --- | --- | --- |
| 原生完成/报告格式 | `codex-results`、消息消费、秘书历史与页面全文；退出/ack 不能替代完整结果 | `tests/w4/codex-results.test.ts`、`tests/w6/messages.test.ts`、`tests/w7/project-chat.test.ts` |
| 角色选择/程序能力 | `ai-settings`、消息/修复 worker 的固定输入、适配器和旧运行读回 | `tests/w7/ai-workflow.test.ts`、`tests/w7/additional-cli.test.ts`、`tests/w7/ai-settings.test.ts` |
| 队列格式/授权/停止条件 | 预开连接、任务阶段、接收/合并、页面控制和原资源占用 | `tests/authority/authority.test.ts`、`tests/merge/managed.test.ts`、`tests/w7/scope-controls.test.ts` |
| 工作台来源/项目选择 | GitHub 账号缓存、任务筛选、秘书来源、已配置控制与完整报告 | `tests/w7/github-projects.test.ts`、`tests/w7/project-workbench.test.ts`、`tests/w7/project-chat.test.ts` |
| Node/启动/提示资产 | 构建输出、启动清单、校验前加载、历史原件、已结束组合接续 | `tests/w7/workbench-launch.test.ts`、`tests/w4/role-prompts.test.ts`、`tests/integration/node-continuation.test.ts` |

按实际影响选择调查和验证，不要求每次变更重跑整张表。


初次 Issue 实施沿 `workbench → issue-implementation-controls → 原 TaskRecords / IssueImplementations / authority / resources → issue-implementation`。固定工作区准备、`RepairTools` 的限定写入/预期树与共享宿主提交原语、注册 Docker 测试和原生捕获复用；执行角色是新的 implementer，不调用 finding/repair 循环。测试工具复用 `projectModelTestResult`，核执行健康后只传控制器事实，原日志不进入模型。取消及后续准入区分未来资源定义与实际登记：仅确证未派发的取消终态可无原申请，已有领取/未知/损坏仍沿原资源记录处理。状态与原件留在原队列 operations/events/blobs，没有新队列或批准账本。修改这些共享边界时，除原 repair / resources / authority 外，还核 `tests/project-repair/integration.test.ts` 的正常入口组合和 `tests/w7/github-projects-ui.test.ts` 的项目切换；真实原生验证边界见 [实施说明](docs/issue_implementation.md)。

确证未发的登记沿原固定请求补 bind；已有操作的纯输入准备在原 controller lock 内核原派发、输入、H0 文件/暂存和写者后继续首次发送。`IssueImplementations.unsent` 复用原权限/资源/取消/停止事务检查，dispatch 仍只准一次；原生/工具/修改或未知占用不进入该分支，不承担失败现场恢复。


### 正式 PR 外层流程的影响传播

`formal-review-controls` 是正常任务页的可信目录消费者，沿原 QueueStore operation/events/blobs 装配 `formal-review-material`、`formal-review` 和 `formal-review-host`。完整不可变 PR 材料及按需调用方读取与可写文件范围分开；新完整审核/整批独立验证使用原 native/Claude 捕获；综合及授权修复保持原事实会话。单轮原日志快照不替代进程退出证据。

原 AuthorityRecords/ResourceRecords 通过明确 opt-in 的正式消费者分支接入，`formalWorkSha256` 区分固定正式工作与普通接收；旧接收/repair/publication 拒绝挪用该绑定。原 ReviewRecords 共用发布返工事件及反思入口。`formal-candidate` 在发布核回后沿原 collect/verify/readPacket/import 生产新材料，用真实在运行报告绑定测试权限，并经 W2 原容器结束捕获后结算与导入。没有新余额、恢复队列或通用发布器。

改变这些共享点时核 authority/resources、普通 receiver/repair、发布批次、工作台项目隔离和启动器完整文件清单；具体测试见 TESTING 的 Issue #72 段。页面脚本和全部 dist/src 模块由原运行清单核对。
