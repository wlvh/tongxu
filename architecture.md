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
| 查看权限与执行授权分开 | `workbench.ts` 的临时查看标识只保护本机入口；`authority-source.ts`、`authority-store.ts` 核本人来源、范围和委托。`AuthorityProfile`可显式登记共享账号模式，只条件化账号相等拒绝；旧profile/来源原件不改。共享保证由原profile投影到Owner/成果视图，不作为动作许可。复制报告或 owner JSON 不能产生授权。见 `tests/authority/authority.test.ts`及Owner/成果页面回归。 |
| 已发送或原进程未知时先查原执行，不自动重发 | `project-chat.ts`、`managed-merge.ts` 查原捕获、PID 与响应；缺失进程证明保留 `unknown`。失去回执、换页面或升级 CLI 不等于从未发送。见 `tests/w7/project-chat.test.ts`、`tests/merge/managed.test.ts`。 |
| 新动作重核阶段条件；新安排不追溯改变旧输入 | `coordination.ts`、`task-store.ts`、`scope-controls.ts` 和具体控制入口执行检查。生产者材料或停止条件不满足时暂停依赖动作。见 `tests/coordination/feedback.test.ts`、`tests/w7/scope-controls.test.ts`。 |
| 完全独立的旧只读结果保持原出处 | `coordination.ts` 在新选择前调用 `CoordinationRecords.independentHistory`，仅为两侧均无共享、登记产物和依赖的未变任务走原消息的 recoverOnly。实际程序、角色提示、源与完整捕获/资源仍核对；不写当前反馈或授予执行权。公开语义见 `docs/task_coordination.md`。 |
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

请求解析和核权后，原输入/输出保存为文件或数据库原件，派生报告用摘要引用。`task-contact-choice.ts` 只接受绑定计划摘要的预登记联系人：A 的完整回复及资源已处理后才选择 B，B 的完整回复再交回 A；普通报告或畸形选择不会触发任意联系。完整原文、材料消费确认、进程结束和资源状态分别核验。 `implementation-owner-feedback` 从原 Issue 实施结果核当前提交、完整捕获和原责任身份；`TaskInbox` 的原 B 事件保存等待、绑定与撤回，新的 A 只读请求及 B 后续仍进入原消息执行器。工作台只给联系入口识别同项目的动态实施收件人，原实施完成回调接续已收件的准确联系；冷读不发。H0/no_change 的消息资源阶段由原实施消费者明确准入，原结果和保护触发器保留，coordinate 与 implement/test 分别核权及结算。

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

项目秘书明确工作模式从原用户消息固定 `workTarget`，仅该次原生请求及宿主 gate 注册空参数协调工具。`ProjectChat` 的消息关联保存意图，`IssueImplementationControls` 复用原准备/开始与真实报告；完整 `origin` 随新实施请求进入原输入清单，旧输入不回填。原队列最后登记事务核当前采用与准确已有责任，取消意图在此复核；并发新聊天不能多建同一工作。原消息/TaskInbox 与成果/权限/资源事实没有迁到聊天表。

## Change propagation

| 变更类型 | 需要继续调查的影响面 | 相应验证 |
| --- | --- | --- |
| 条件交付的相关材料与安排 | conditional-entry 的固定配置和派生动作 → 原 Coordination / Messages / Queue / Integration / CandidateValidation / MemberSource / Authority / Resources。当前材料单独关联原物理组合，原生输入固定当前关联与相关安排摘要；旧输入按历史关联读取。报告按自身固定输入核生产阶段必需版本，完整后续消费可沿原 output events 追加有界新报告，下游实际消费另记；未发选择仅按原刷新与资源规则更新。后续 RETURN 以准确来源恢复或派生，合法 after.H 续接沿原受管捕获/唯一后继/责任事务门生成实际工作区，成员链按准确 repair 贯通生产者和消费者，旧原件独立可读 | `tests/coordination/conditional-refresh.test.ts`、`receiver-currentness.test.ts`、`early-consumption.test.ts`、`early-receiver.test.ts`，`tests/integration/conditional-entry.test.ts`、`conditional-report-revisions.test.ts`、`conditional-member-repair.test.ts`、`conditional-individual-repair.test.ts`、`candidate-validation-authority.test.ts`，以及原成员重组/权限/资源消费者 |
| 原生完成/报告格式 | `codex-results`、消息消费、秘书历史与页面全文；退出/ack 不能替代完整结果 | `tests/w4/codex-results.test.ts`、`tests/w6/messages.test.ts`、`tests/w7/project-chat.test.ts` |
| 角色选择/程序能力 | `ai-settings`、消息/修复 worker 的固定输入、适配器和旧运行读回 | `tests/w7/ai-workflow.test.ts`、`tests/w7/additional-cli.test.ts`、`tests/w7/ai-settings.test.ts` |
| 队列格式/授权/停止条件 | 预开连接、任务阶段、接收/合并、页面控制和原资源占用 | `tests/authority/authority.test.ts`、`tests/merge/managed.test.ts`、`tests/w7/scope-controls.test.ts` |
| 受管发布配置与保护读取 | `merge-store`按新profile的sharedAccountPublisher核Owner／执行／发布账号重合及固定配置，仅新状态派生共享保证；`merge-provider`和preflight核account_publisher／旧isolated_publisher／fixture的当前能力配对，旧捕获不添字段。`merge-request`生成固定端点，merge-provider保留原公开导出与捕获。现有gh程序在内部固定每命令令牌、实际账号／repo scope／仓库admin与push，向固定GitHub API请求。可选凭据类别；`merge-preflight`以准确classic404及同次管理读取证明无classic，oauth_repo_admin另核本次准确repository的admin／push，原 managed-merge/queue记录与授权资源、结果回读继续消费原核查。merge-contract允许空资源数组，merge-store在prepare／dispatch共用的current中核无账本条件并复用原Owner资源矩阵；历史及已发查回沿原记录。部署类别声明不自证身份，classic缺项证明在旧配置/classic200路径零新增管理读取，未支持语义继续拒绝 | `tests/merge/contract.test.ts`、`tests/merge/policy.test.ts`、`tests/merge/managed.test.ts`及`github-cli-publisher.test.ts`；本地HTTP/Owner与资源样例，非生产身份证明 |
| 指定审核方规则 | `merge-provider` 按实际新审核要求生成固定只读GraphQL查询，`merge-preflight` 核原规则结构、准确候选与直接目标及服务端现行可合并状态。原普通审批、检查、Owner/资源、managed-merge发送登记和回读恢复继续，旧无新要求路径零新增query | `tests/merge/designated-reviewers.test.ts`、`contract.test.ts`、`policy.test.ts`及`managed.test.ts`；真实子进程/HTTP及明确规则样例，真实组织规则生效另核 |
| 原实施结果到秘书补充 | project-chat 只保存意图与原请求关联；issue-implementation-controls 从已核H1和原责任编译受控后续实施，复用原QueueStore/Authority/Resource，不新增发送事实账本 | `tests/project-repair/integration.test.ts`、`tests/w7/project-chat.test.ts`、`tests/w7/project-chat-ui.test.ts` |
| B 问题到原实施负责人再回 B | `implementation-owner-feedback` 核原完整结果/当前提交，TaskInbox 原事件与 TaskHistoryProjection 保存准确身份和单份全文；TaskControls/工作台精确唤醒已收件联系。`runMessages` 在原捕获恢复之后，从原 run→TaskInbox 请求识别 ownerContact，A及回B的新执行必须取得现有签发、匹配原目标的当前来源 proof；普通消息不新增此要求。宿主复用原 Issue reader，无 reader 的通用消费者明确拒绝新投入/输入；MessageResources 在实际领取前复核，发送前再读当前 Issue并保留本地同步门。已发捕获/资源清理不受新输入检查阻断；no_change 不造新提交 | `tests/project-repair/integration.test.ts` 原负责人联系组合、原秘书补充回归，`tests/w6/task-intake.test.ts`、`tests/w6/task-contact-choice.test.ts`、`tests/w6/message-resources.test.ts`、`tests/w7/github-projects-ui.test.ts` |
| 零输入消息的资源取消 | 原 `MessageResourceRecords` 统一判断取消阶段是否还有未清投资：精确从未领取的申请无供应方结算义务，held仍结原claim；此判定供消息包装层、旧阶段再准入与TaskInbox投影/未发关闭使用，不改变全局settledOutcome或执行held门。取消和原claim最后登记共享队列事务，普通coordinate也不能从已关闭阶段回落取得新claim；申请与原件保留 | `tests/w6/message-resources.test.ts` 的原资源竞争/已发/未知场景，`tests/project-repair/integration.test.ts` before-claim正常HTTP及before-send回归 |
| 秘书明确工作到原实施者 | project-chat-contract/repair-native 逐请求双层工具限制，ProjectChat 原意图/取消与 IssueImplementationControls 原输入/最后登记/直接控制；旧问答和补充保持 | `tests/project-repair/integration.test.ts` 秘书工作场景，`tests/w7/project-chat.test.ts`、`tests/w7/project-chat-ui.test.ts` |
| 工作台来源/项目选择 | GitHub 账号缓存、任务筛选、秘书来源、已配置控制与完整报告；普通评论从 `project-chat-contract` 经 `workbench` 固定项目分发到 `github-projects`，反向分页游标按账号／仓库／条目隔离，体积延后和正文缺项进入原哈希观察；`reception-controls` 仅桥接明确动作到原 sourceTick/Authority/Resource/receiver，不新增队列或自动派发 | `tests/w7/github-projects.test.ts`、`tests/w7/project-workbench.test.ts`、`tests/w7/project-chat.test.ts`、`tests/events/normal-entry.test.ts` |
| Node/启动/提示资产 | 构建输出、启动清单、校验前加载、历史原件、已结束组合接续 | `tests/w7/workbench-launch.test.ts`、`tests/w4/role-prompts.test.ts`、`tests/integration/node-continuation.test.ts` |

按实际影响选择调查和验证，不要求每次变更重跑整张表。


初次 Issue 实施沿 `workbench → issue-implementation-controls → 原 TaskRecords / IssueImplementations / authority / resources → issue-implementation`。固定工作区准备、`RepairTools` 的限定写入/预期树与共享宿主提交原语、注册 Docker 测试和原生捕获复用；执行角色是新的 implementer，不调用 finding/repair 循环。测试工具复用 `projectModelTestResult`，核执行健康后只传控制器事实，原日志不进入模型。取消及后续准入区分未来资源定义与实际登记：仅确证未派发的取消终态可无原申请，已有领取/未知/损坏仍沿原资源记录处理。状态与原件留在原队列 operations/events/blobs，没有新队列或批准账本。修改这些共享边界时，除原 repair / resources / authority 外，还核 `tests/project-repair/integration.test.ts` 的正常入口组合和 `tests/w7/github-projects-ui.test.ts` 的项目切换；真实原生验证边界见 [实施说明](docs/issue_implementation.md)。

确证未发的登记沿原固定请求补 bind；已有操作的纯输入准备在原 controller lock 内核原派发、输入、H0 文件/暂存和写者后继续首次发送。`IssueImplementations.unsent` 复用原权限/资源/取消/停止事务检查，dispatch 仍只准一次；原生/工具/修改或未知占用不进入该分支，不承担失败现场恢复。


### 正式 PR 外层流程的影响传播

`formal-review-controls` 是正常任务页的可信目录消费者，沿原 QueueStore operation/events/blobs 装配 `formal-review-material`、`formal-review` 和 `formal-review-host`。完整不可变 PR 材料及按需调用方读取与可写文件范围分开；新完整审核/整批独立验证使用原 native/Claude 捕获；正式影响角色按冻结选择可由 `formal-kimi` 复用 `ExtraCliSession` 执行，核实际 profile、准确单次输入边界、完整 ACP 和进程退出后登记原阶段。最后异步 host 刷新后同步核档案/会话，再由原 effect 登记并立即写输入，不增加原队列或资源记录之外的执行通道；综合及授权修复保持原事实会话。单轮原日志快照不替代进程退出证据。

工作台向原正式控制器传入绑定已核项目身份的 AI 设置读取回调；新请求封存时读取当前 AISettings 快照，一次捕获三个角色，定时接续与手工准备使用同一来源。回调不缓存启动时选择，也不改写已有请求；保存选择不可用沿原等待记录处理。调整此装配时核 `tests/w7/formal-workbench.test.ts` 的真实定时器、手工核对、设置变化/默认/不可用和跨项目场景。

`reception-controls` 对正常新接收使用同一项目设置回调，仅固定专用 receiver 角色；旧 receiver 以及已保存而未发送的原计划先复用原绑定，不读取新偏好。`receiver` 保留 Claude 默认/旧捕获，并可沿同一生命周期使用 Kimi。`formal-kimi` 仅以两个固定角色身份共享无工具 ACP 检查，formal 旧请求/完成格式不变；Kimi receiver 完成件另保留准确全文供原无效结果纠正和发布回流。`LiveProcess.request` 的可选同步 effect 将 Kimi 实际问题写入包在原 receiver 事务中；原调用未传 effect 时保持原行为。`receiver-metadata` 只从注册计划/捕获 blobs 投影真实程序、模型与会话，供队列页面和 ReviewRecords 共用，不探测当前安装。传播验证见 `tests/w3/receiver-kimi.test.ts`、原 receiver/治理/纠正、判断记录、AI设置/正常入口及 formal Kimi 测试。

正式当前性检查把冻结 Issue/采用范围与要求摘要及原 AuthorityRecords 当前采用绑定，host 刷新后消费实际采用来源，PASS 终结事务再次核对。此检查不依赖已返回阶段的执行权或已结算资源；采用改变时保留旧报告并等待新准入，不修改原输入。正式后继登记和中央 check/effect 事务沿固定 previousOperation 核父祖先停止，公开状态继承同一停止；正常已完成但未停止的父轮不需保留旧运行 claim，已发结果仍可保存。反证正式结论复用原 owner/PASS 判定，修复 needs_owner 也消费既有 owner 出口。

原 AuthorityRecords/ResourceRecords 通过明确 opt-in 的正式消费者分支接入，`formalWorkSha256` 区分固定正式工作与普通接收；旧接收/repair/publication 拒绝挪用该绑定。原 ReviewRecords 共用发布返工事件及反思入口。`formal-candidate` 在发布核回后沿原 collect/verify/readPacket/import 生产新材料，用真实在运行报告绑定测试权限，并经 W2 原容器结束捕获后结算与导入。没有新余额、恢复队列或通用发布器。项目准备保留固定 H/B 的独立历史和共同祖先供后继完整读取，checkout 仍是 H。正式停止在远端项目确认前消费原请求中的项目身份；旧无绑定请求只接受已发现的本地项目映射，不改写旧输入。

新候选材料通过 `FormalReviewControls.prepare` 共用检查，自动接续与手动新请求均核完整材料或原受管验证终态。`formal-candidate` 复用 EventRecords 的显式来源读取，原未登记准备只有在手动核清 Docker 零执行原件后才进入保留关联的新目录。`repair-native.readRejectedFormalReview` 只读核验原单轮正式 reviewer 的完整拒绝捕获，`QueueFormalRoundHost.settleRejectedReview` 再核原测试和未变工作区，沿原资源及操作记录结束为待补证。原报告、判断拒绝和进程结束分别保存，正常报告读取与未知执行规则继续沿原入口。传播测试包括 `formal-candidate-live`、`formal-review-rejection`、既有 formal/native、资源和工作台场景。

改变这些共享点时核 authority/resources、普通 receiver/repair、发布批次、工作台项目隔离和启动器完整文件清单；具体测试见 TESTING 的 Issue #72 段。页面脚本和全部 dist/src 模块由原运行清单核对。

### 项目首次准备的直接影响面

`workbench → project-work → project-work-preparation → BoundedCodexSession` 只读调查固定 Git 材料；`project-work-store` 保存设置／草案／版本及原请求引用。查看钥匙只请求宿主打开短期 `project-work-owner` 窗口，准确确认后由 `project-work-runtime` 发布并读回真实批准，再编译不可变单条目录交原 `issue-implementation-controls → issue-implementation`。后者及原 QueueStore 仍是派发／权限／资源／报告事实来源。完成回调把完整提交接回真实项目独立分支与成果目录，补充复用原责任，历史仍从原消费者读取。

共享变动为 selected_files 的完整 Git 稀疏工作树、Docker材料副本与测试树核验、原实施发送前的基线测试、生成目录的当前版本准入以及工作台启动器资源清单。必须回归原 repair/native/authority/resources、project-repair integration、w7 项目切换／秘书／启动器；新增单元／页面测试见 project-work*.test.ts。无第二套执行器或批准账本。能力和部署边界见[首次工作](docs/project_first_use.md)。
