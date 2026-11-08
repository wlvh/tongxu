# 测试与证据范围

## 0. Canonical Test Entrypoints

命令来源是根目录 `package.json`；以下均在仓库根执行。先使用 **Node.js >=24.0.0** 且具备 `node:sqlite` 事务能力的环境。依赖安装为 `npm install --ignore-scripts --package-lock=false`；构建为 `npm run build`，编译源码和全部 TS 测试到 `dist/`。不要用旧文档中的锁文件安装方式覆盖 [runtime_compatibility](docs/runtime_compatibility.md) 的明确替代规则。

各 `test:*` 脚本先构建，再由 Node 自带 test runner 执行所列文件。当前没有统一覆盖全仓的 test-all 或 GitHub Actions 工作流，也没有单独配置 lint/formatter 门禁；不要临时新增入口以制造通过。

macOS 测试的临时目录也须是真实规范路径：若当前临时路径经过 `/tmp` 或 `/var` 符号链接，先把 `TMPDIR` 设为该目录的真实路径。例如本机存在 `/private/tmp` 时可用 `export TMPDIR=/private/tmp`，再运行下表命令。否则部分创建私人队列的测试会报 `output_symlink_or_non_directory`；修正测试环境，不修改产品路径校验来放行。

| 现有命令 | 实际范围与前提 |
| --- | --- |
| `npm test` | w1、w2、w3 的 `*.test.js`；包含真实 Linux/bubblewrap 隔离测试，不是全仓测试，不适合作为 macOS 无配置通用命令。 |
| `npm run test:mac` | w1、w3、w4 的 codex-results、w5；不包括真实 W2 隔离、全部 native、w6/w7 或其他领域。 |
| `npm run test:docker -- ABS_CONFIG` | 现有 `docker-suite`：w1 CLI/collection、docker.integration、verification、w3 queue。需已有本地 Docker/socket/镜像/配置；不拉取镜像替代条件。 |
| `npm run test:native` | w4 全部 `*.test.js`，含原生协议、结果、角色、秘书/会话。完整入口还需 Linux/bubblewrap：`native.test.ts` 中五项隔离自检/中断测试在 macOS 会失败；协议使用受控程序样例，不等于真实模型调用。 |
| `npm run test:relay`、`npm run test:repair` | w5 全部；后者只运行 repair 文件。测试中的本地执行和模型协议样例分开解释。 |
| `npm run test:receiver`、`npm run test:publication`、`npm run test:secretary` | 各自单个 receiver、publication、secretary 测试文件，不能代表相应整个目录或所有新消费者。 |
| `npm run test:pair`、`npm run test:messages`、`npm run test:tasks` | 分别是全部 w6、指定 messages/message-claude/message-continuation 文件、task-intake 单文件。 |
| `npm run test:workbench`、`npm run test:deliveries` | 分别是全部 w7、w7 的 delivery-* 子集。二者完整入口均需 `TONGXU_TEST_DOCKER_CONFIG`、可用 Docker 和已有本地镜像：相应成果执行/退回场景使用真实隔离测试。完整 `test:workbench` 还需 `/bin/zsh` 执行 `workbench-launch.test.ts`；这项启动器前提不属于仅运行 delivery-* 的 `test:deliveries`。其他本机 HTTP/协议样例不替代真实隔离或浏览器视觉验收。 |
| `npm run test:authority`、`npm run test:resources`、`npm run test:merge` | 对应 authority/resources/merge 目录；校验本人来源、资源及受管合并的样例，不能证明生产配置已启用。 |
| `npm run test:events`、`npm run test:coordination` | 对应 events/coordination 目录，校验来源、排序、阶段依赖、反馈与恢复。events 的 normal-entry 场景以原接收/来源/本人/资源协议样例走真实本机 HTTP/SQLite/子进程；不等于真实模型或浏览器验收。 |
| `npm run test:composition`、`npm run test:review-records`、`npm run test:project-repair` | 对应 composition/review-records/project-repair 目录，分别检查材料组合、判断原记录和受控修复接收。三者完整套件均需 `TONGXU_TEST_DOCKER_CONFIG`、可用 Docker 和已有本地镜像；composition、project-repair 的测试文件在加载阶段检查配置，review-records 的 queue-repair 测试也导入强制要求配置的准备文件。 |
| `npm run test:sessions` | w4 role-prompts 与 session-* 子集。 |
| `npm run test:integration`、`npm run test:integration-member` | 对应 integration/integration-member 目录；固定 Git 候选、接续、成员修复/重组/反证等。二者完整套件均需 `TONGXU_TEST_DOCKER_CONFIG`、可用 Docker 和已有本地镜像；integration 及成员修复都使用 `tests/integration/fixture.ts` 的共享准备流程，在进入该流程时强制检查配置并执行真实隔离验证，不能只按少数文件判断环境要求。 |
| `npm run test:delivery-validation`、`npm run test:delivery-assessment` | 对应 delivery-validation/delivery-assessment 目录，二者均导入真实 Docker 验证 fixture，需 `TONGXU_TEST_DOCKER_CONFIG`、已有镜像和可用引擎；模型判断另用明确样例，不能把它称为真实模型验收。 |

按变化风险选择已有入口，说明哪些覆盖重叠。本文不把所有命令设成每次文案修改必跑清单。运行环境不同的尝试分别记结果；macOS 套件通过不能覆盖 Linux/Docker 未运行或失败。尤其 `test:native` 名称不表示它全部跨平台；其完整隔离入口见 [w4_native_inspection](docs/w4_native_inspection.md)。

## 1. Testing Philosophy

条件交付入口沿 `test:coordination`、`test:integration` 和 `test:integration-member` 验证。`conditional-entry.test.ts` 覆盖正常 CLI、完整接收及下游实际消费、来源变化、原 W1/W2 保留和候选共用三批限额。`conditional-member-repair.test.ts` 覆盖原 RETURN 到成员 H1、真实隔离验证和重组、来源过期/失败/候选变化、正文更新后的组合复用与准确接收输入。`conditional-individual-repair.test.ts` 还覆盖准确 after.H 上的新 RETURN、同 H 新材料与任意外部 H 的当前等待、旧未知/损坏捕获/未核资源/工作区占用、原终态能力移除后查回及旧 task-only 记录。成员场景的 `current-parent` 覆盖成员H/manifest不变时父材料更新后的正常CLI修复、准确新父全文绑定、完整历史排除、未知/损坏拒绝、多当前父歧义，以及成员导入后按原修复绑定的精确历史终态查回。独立运输断言覆盖99前缀成员SHA与精确组合PR路径的区分。成员场景的 `second-round` 运行两轮真实修复、各自采集/自身 W2/重组/导入及组合自身接收，并断言新旧原操作和证据不串用。本人来源和账本由明确样例提供，运行报告分别记录实际 Git/Docker 与模型/远端样例范围。

`tests/coordination/receiver-currentness.test.ts` 复用原接收与消息 fixture，覆盖同一上游H的证据失效、登记未消费/已消费、旧式和命名阶段消费预备未发、runtime启动后的最后输入门、初次调查携历史未来产物、已发后的完整回复与原run零新增恢复，以及报告SHA不变时的声明依赖传播。断言实际协议输入数量、原产物与消费出处、历史全文和独立A3。Git、SQLite、CLI及子进程真实执行，验证材料和模型为明确协议样例。

`tests/integration/conditional-report-revisions.test.ts` 复用同一 integration/message fixture，验证正常 CLI 中 R1→R2→R3 的报告自身固定输入、新完整回复与原 output 版本、已消费旧报告的下游有限接续，以及旧准备未发的配额等待。分别核显式允许刷新后首次实际输入收到新报告、未允许刷新时具体等待、正常 ownerFeedback callback 发布新版本、历史全文、重复零新增与原三批接收限制。`receiver-currentness` 还核 `refreshUnsent` 下已发原 run 的源失效恢复、完整回复在源失效时不发布新报告，以及无关变化不替换独立未发选择。模型与外部服务为协议样例，Git/SQLite/CLI/子进程和所需 Docker 隔离真实执行。

行为、契约和失败边界优先于实现形状。固定输入减少外部数据漂移；真实外部调用需明确授权与条件。缺材料、未知、部分输出、拒绝和未运行不是通过。某个文件名带 native、integration 或 live，不足以判断它实际启动了什么，必须看 fixture 和执行器。

## 2. Test Layers and What Each Proves

| 层级 | 本项目例子与证明范围 |
| --- | --- |
| 类型/构建 | TypeScript 编译全部 src/tests；证明可编译，不证明用户路径。 |
| 单元/契约 | `tests/coordination/contract.test.ts` 解析阶段与循环；`tests/w4/codex-results.test.ts` 验完整结果格式。 |
| 组件场景 | w7 启动真实本机 HTTP、SQLite 和子进程，但 GitHub/模型可为明确样例；只证明该组合边界。 |
| 真实隔离 | w2 sandbox 和显式 Docker 套件运行真实隔离进程，核主机文件、网络、环境、超时、输出限制及候选树。 |
| 外部模型/远端操作 | 需真实账号、程序、资源及输入/输出原件；协议样例和历史报告读回都不算本次真实调用。 |
| 用户成果验收 | 对准确版本从正常入口完成用户任务并记录本人结果；通过单个测试、生成报告、PR 合并不能替代。 |

## 3. Capability Contract Alignment

`capability_contract.json` 登记文档承诺，`test_anchor` 指向已有测试文件或场景。它不是测试发现入口，也不生成 CLI/模型工具。Markdown 使用契约 rules 指定的稳定 `capability-anchor` 注释；锚点存在只证明结构对应，不证明业务语义。

**Not configured**：仓库当前没有持续运行的九文档 anchor/alignment checker 或相应 package script。更新时核 JSON 可解析、ID 唯一、注释引用已登记 ID、路径存在；本次人工或临时机械检查不能宣称为已安装自动门禁。显式 `test_anchor: null` 必须同时给出具体 `untested_reason`、`pending_since`；有测试则指向实际文件，不从测试自动生成 statement/status。

## 4. Change Type to Required Evidence

先用 [Change propagation](architecture.md#change-propagation) 找受影响路径，再把风险落为具体输入和预期，传播关系不在本页复制。

| 需核验的声明/风险 | 输入、入口与期望 | 已有证据 |
| --- | --- | --- |
| 固定 PR 原件 | 非法 scope 不调用外部工具；候选变动保留缺口；恢复不覆盖旧页 | `tests/w1/cli.test.ts`、`tests/w1/collection.test.ts`；见 test:mac |
| 完整结果与旧原件 | 截断、错误身份或矛盾回执不能成为成功；旧日志按原格式读取 | `tests/w4/codex-results.test.ts`、`tests/w4/native.test.ts`；见 test:native |
| 项目补充与原实施 | A运行时收件，成功H1/资源后以新上下文消费并回原会话；取消/停止不续写，冷重开零输入 | `tests/project-repair/integration.test.ts` 新补充场景（真实Docker、协议模型），`tests/w7/project-chat-ui.test.ts` |
| 项目入口及秘书 | 切账号、错项目、重复请求、超时与损坏原件应明确拒绝/保留未知；历史读取无新输入 | `tests/w7/github-projects.test.ts`、`tests/w7/project-chat.test.ts`；见 test:workbench |
| 秘书办理已审定工作 | 实际受限工具调用、完整origin输入、H1/同源报告、新聊天准确责任复用、并发登记、普通模式/参数拒绝、错来源、取消登记竞争/登记后关联保存中断、忙席位、旧取消项不改绑、同名目标/origin不符的读控拒绝、晚取消拒绝后的持续回流及冷重开零输入 | `tests/project-repair/integration.test.ts` 的 secretary work 场景（真实Docker、协议模型），`tests/w7/project-chat-ui.test.ts` |
| 来源变化到正常接收 | 原项目任务页补查零模型；新材料使用新 operation 的权限/资源，重复/来源失效/停止不重发，原报告不改写；同项目拒绝经刷新仍可见，停止后从原按钮零输入查回同操作 | `tests/events/normal-entry.test.ts`、`tests/w3/receiver-authority.test.ts`；页面同项目失败/跨项目迟到回复和停止准入见 `tests/w7/github-projects-ui.test.ts`，两组复用原页面 fixture |
| 可选 Kimi 技术接收 | 正常项目设置到新 packet 固定选择、完整原件/真实程序信息、原队列写入事务、费用适用、完整无效判断纠正、已固定未发计划及403原请求遇到新设置失效仍零重发 | `tests/w3/receiver-kimi.test.ts` 复用原 receiver/治理、normal-entry 和 ACP fixture；真实本地Git/HTTP/SQLite/子进程，模型、Owner和账本为明确协议样例。真实Kimi正常路径另记；共享ACP还回归 `tests/w5/formal-kimi.test.ts` 及原消息/角色设置消费者 |
| 模型偏好进入执行 | 新选择随原 worker 输入固定，旧计划不改绑；不支持程序/模型拒绝 | `tests/w7/ai-workflow.test.ts`、`tests/w7/ai-settings.test.ts`、`tests/w7/additional-cli.test.ts` |
| 有限联系 | 普通报告不发 B，合法选择才 A→B→A；不完整结果不推进 | `tests/w6/task-contact-choice.test.ts`；见 test:pair |
| 联系原实施负责人 | A 实际在途时收 B 问题，完成 H1 或证明未变 H0 后只读回答并由原 B 消费；正常页面自动接续、撤回、自然费用等待后冷读零输入与显式继续；绑定后、领取前/发送前需求变化及已发后原捕获恢复；已排队A/回B经tasks或messages CLI、空/伪造checker在来源变化/未变时均零新增，正常宿主与CLI竞争仍只消费一次；来源/暂存/捕获变化拒绝 | `tests/project-repair/integration.test.ts` 的 original owner feedback 场景（真实 Docker、协议模型），`tests/w6/message-resources.test.ts` 的旧运行/待结资源不受新输入门槛阻断，`tests/w7/github-projects-ui.test.ts` |
| 已登记但从未领取的未发撤回 | before-claim需求变化后正常HTTP撤回、重复/冷开/继续零新增，原申请保留、阶段/待办结束、后续同责任可准备；取消先于claim最后登记时普通coordinate也拒绝领取，旧取消阶段不挡新合法消息；曾派发但证明未启动/失claim回执仍核原事实，held只结原claim | 扩展同一 `tests/project-repair/integration.test.ts` before-claim场景及 `tests/w6/message-resources.test.ts` 原provider/消息fixture，不新增测试平台 |
| 本人决定和原操作 | 复制配置不能授权；过期来源/停止阻新动作；失回执后查原合并而非第二次 PUT | `tests/authority/authority.test.ts`、`tests/merge/managed.test.ts` |
| 显式共享账号来源 | 新profile严格引用与同ID、精确来源/提案和原动作门、旧字节及profile不可变、正常Owner提交/共享说明和历史成果限定、publisher仍须分离 | 复用`tests/authority/authority.test.ts`、`tests/w7/owner-controls.test.ts`、`delivery-outcomes.test.ts`、`owner-control-journey.test.ts`及原页面fixture；来源/身份为明确协议样例，不证明生产批准 |
| 规则集与旧版保护缺项 | 仅已核凭据类别、准确classic404和本次固定管理读取200共同证明无classic；Actions关闭有效，旧配置/classic200零新增读取，错误或残缺证明及其他规则仍拒绝 | `tests/merge/contract.test.ts`、`tests/merge/policy.test.ts`、`tests/merge/managed.test.ts`；见 test:merge，仅本地HTTP/身份与资源样例 |
| 指定审核方 | 负责人/多个团队/零门槛规则的服务端CLEAN/UNSTABLE及可空审核状态、准确仓库/PR/H/B/目标、错误/部分/矛盾来源、原普通审批/检查及未知规则、一次PUT与原恢复、旧无新增要求零query | `tests/merge/designated-reviewers.test.ts`及原merge三文件，真实子进程/HTTP，GitHub策略、身份与资源为明确样例；组织实际生效单独验证 |
| 阶段前置 | 精确生产者材料与消费证据齐备才开始依赖阶段；独立调查不被错误阻断 | `tests/coordination/contract.test.ts`、`tests/coordination/feedback.test.ts` |
| 启动与依赖 | 旧 Node/缺 SQLite 能力拒绝；程序升级不成为版本白名单；应用资产变化先于导入拒绝 | `tests/w7/workbench-launch.test.ts`、`tests/w4/external-dependencies.test.ts` |

可稳定复现的 bug 优先保留修复前失败输入，再修实现；无法自动复现时保存失败证据与原因。先复用或扩展现有测试，只有独立覆盖缺口才增加新测试。无 test diff 时说明具体既有覆盖及重跑结果；文档-only 检查不能冒充运行验证。跨模块变化要有实际组合场景，各层分别通过不够。

初次 Issue 实施的受影响组合沿 `tests/project-repair/integration.test.ts` 运行，需上表同一真实 Docker 配置/镜像；包含正常项目 HTTP 入口、原授权/资源、两次合法写入、实际注册测试和宿主 H1，模型为明确程序样例。页面脚本场景在 `tests/w7/github-projects-ui.test.ts`。真实浏览器与正常入口真实 Codex 分开留证，不能以这些组件场景代填。

实施报告的 `candidateH` 固定最初 H0，临时受测提交与宿主 H1 分开。`tests/w5/implementation-native-profile.test.ts` 核单值输出约束、旧捕获兼容，以及错误角色/H0、额外字段和扩大决定范围在发送前拒绝；真实实施/测试/提交和秘书、原负责人组合继续沿 `tests/project-repair/integration.test.ts`，不以该协议组代替真实模型结果。

该组合还覆盖两处确证未发等待：席位忙登记后释放、最终来源刷新失败只留下原输入；热重试/冷重开均沿原 ID、任务和材料到 H1，原资源只领取/结算一次。补准备前取消/停止、输入或文件/暂存变化、原生启动证据和竞争写者仍须零派发；已发未知继续只查原现场。页面脚本核 registered 的同 ID 补准备、重复点击和项目切换。扩展原 fixture，不另建恢复测试框架。 同一忙席位场景参数化普通请求/补充请求，核 H1/原责任/补充原文、热/新服务实例补准备和原会话完整回流；同名普通请求碰撞时开始与取消均拒绝、原请求与输入计数不变。正确绑定读回及同 ID 改目标/原文的拒绝沿该场景验证。

同一场景覆盖配置资源但尚未 start 即取消，热/新服务实例的新请求可至 H1，原项保持零资源登记/领取/模型输入；已领取取消沿原结果结算，未知及损坏资源原件仍阻下一项。新消费者的两次写入/H1 场景参数化测试打印未选定文件：原日志保留全文，工具回复与全部模型输入均不含原文；旧 project repair 的同类隐私场景继续回归。

## 5. Side Effects and Isolation

构建写 `dist/`；安装写忽略的依赖目录。多数测试在 `mkdtemp` 创建临时 Git、SQLite、计划和模拟程序，用 `t.after` 清理，并可能启动本机监听/子进程；失败时仍须检查测试退出与残留。不要让测试使用正在运行的私人队列或真实成果库。

W2 需真实隔离设施；macOS 显式输出路径应使用真实规范路径，不能把 `/tmp` 别名强行放行。Docker 配置须对应现有授权环境，不能把不受隔离的宿主执行称为等价通过。专用样例 provider 可能真实执行本地 HTTP/Git，但不应接真实生产凭据。

每次证据记录 exact command、scope、result、not-run reason、environment、side effects、cleanup。真实模型和远端写操作另外记录当次授权、候选、原输入/输出与读回；不为文档同步隐式启动这类操作。

## 6. Test Suite Overview

`tests/w1`—`tests/w7` 覆盖从采集到工作台的历史工作包；新增领域目录补充授权、资源、事件、协调、集成、审核原记录和成果。每个目录的 fixture 提供测试专用 Git/数据库/程序/来源，不是可部署的默认生产配置。`verification/` 保存历史演练与 HTML probe；其报告里的旧通过只对应原版本和环境，不能当作本次结果。

## 7. Known Gaps and Untested Reasons

- 没有统一全仓 runner、持续文档 alignment 或 CI workflow；已检查 `package.json` 与跟踪文件，不称为不适用。
- Linux/bubblewrap、真实 Docker、浏览器视觉、真实模型与生产治理验证均需各自环境/范围；本机协议套件不能覆盖它们。
- [PRODUCT_GUIDE](docs/PRODUCT_GUIDE.md#unfinished-work)保留未完成产品/外部条件的原记录入口；本页不复制当前欠账状态或从测试数量宣布全部验收。
- 最低依赖约束不保证未来任意版本都已经测过。若测试当前升级组合，记录实际 Node、依赖和平台；不用单次版本当永久白名单。

## 8. Lessons Learned

测试曾专门固化以下反例：彼此文件不冲突仍可在组合后失败（`tests/w2/verification.test.ts`）；初始化/控制回执并非最终报告（w4/w6 原生与消息测试）；损坏捕获和原进程未知不能用重发恢复（w7 project-chat）；启动器静态导入可先于完整性检查执行代码（w7 workbench-launch）。维护这些最小反例及其用户路径，避免仅增加更多成功样例而丢掉边界。


## 正式 PR 外层流程（Issue #72）

`formal-kimi.test.ts` 复用实际项目设置/正式控制器及已有 ACP fixture，检查能力检测零模型输入、角色保存与请求冻结、完整同批原文回同一 fact、旧请求不改绑、原资源领取与结算，以及最后异步边界的来源/配置/停止/资源变化。错误会话/模型、工具、部分回复、缺 finding 和损坏捕获不能完成或冷重发；首次实际 profile 延迟仅有界等待。该文件的整轮正例仍需要下述 Docker 配置。样例 CLI 均明确为样例；真实 Kimi 影响消费者捕获、整轮其他真实角色和本人接受分别记录，不把 ACP 样例或外部工程审定当作真实软件调用。

构建后可单独运行 `node --test dist/tests/w5/formal-*.test.js dist/tests/w7/formal-workbench.test.js`。包含同会话写入、发布后新候选自动验证的场景需要已有 `TONGXU_TEST_DOCKER_CONFIG` 和可用 Docker；模型是明确的协议样例。验证内容包括完整 PR/额外调用方、直接 PASS 与仅 P2 的零额外输入、空 finding 缺证据、整批双验证、三轮分歧、未变候选反证回流、同 fact session/thread 修复、实际 Git/测试树、准确发布记录、祖先/分叉 B 下的自动新候选采集及已有材料完整再审、项目查询失效时本地停止、离线冷重开与错误账号/项目/入口拒绝、旧无绑定原请求的明确退化和零新增输入、停止与冷读不重发、在途 H/B/target 变化及原容器结束证据。新候选材料沿原 collect/verify/readPacket/import，不伪造 W2。

共享边界按改动选 authority/resources、w3 receiver、w5、review-records/counters、w7 正常页面与启动器回归。原生协议样例不能称真实 Codex/Claude 演练，HTTP 测试不能称浏览器验收；独立审核、合入、启用和本人接受另记。配置与边界见 [formal_pr_review](docs/formal_pr_review.md)。

`formal-workbench` 的新候选场景从正常项目 HTTP 入口保存 AI 选择，启动原生产10秒定时器并与手工核对对照；检查新轮三个角色使用当时项目设置，覆盖控制器启动后保存、准备前变更、合法默认、不可用等待及其他项目设置不串用。reviewer/fact 的模型与强度核实际原生请求；impact 核新轮冻结选择，旧影响协议样例没有 live 模型目录，不称已验证所选 Claude 模型执行。旧轮请求保持原字节，查看完整报告不新增模型输入。

同一 formal-round 场景还覆盖真实 AuthorityRecords 在途采用变化：直接 PASS、P2-only、全批反证后新正式 reviewer 三个出口均保留旧报告并等待，重复/冷读不多发；未采用提案及采用不变仍正常结束，发送前采用变化为零输入。formal-review-store 用真实冻结采用材料核新请求，并在已结束阶段/原资源结算后改变采用记录，验证较早的有效检查不能代替最终 PASS 事务的当前性复核；普通 receiver 共存与新候选采集/导入仍沿原场景回归。

同一发布后完整再审场景还参数化覆盖父轮在接续前、异步材料准备中、子轮已登记未派发及 reviewer 已发时停止；停止后不新增角色，已发报告保留，冷读不重发。原 store 场景沿两代 previousOperation 验证停止祖先在原效果事务阻回调且不登记派发，未停止的已完成父轮仍合法。反证回流参数化 PASS、合法 owner 和真实覆盖缺口；同会话修复的 needs_owner/no_change 分别保留业务决定/待补证，页面脚本核原问题与原 Issue 交接提示。
