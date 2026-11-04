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
| `npm run test:events`、`npm run test:coordination` | 对应 events/coordination 目录，校验来源、排序、阶段依赖、反馈与恢复。 |
| `npm run test:composition`、`npm run test:review-records`、`npm run test:project-repair` | 对应 composition/review-records/project-repair 目录，分别检查材料组合、判断原记录和受控修复接收。三者完整套件均需 `TONGXU_TEST_DOCKER_CONFIG`、可用 Docker 和已有本地镜像；composition、project-repair 的测试文件在加载阶段检查配置，review-records 的 queue-repair 测试也导入强制要求配置的准备文件。 |
| `npm run test:sessions` | w4 role-prompts 与 session-* 子集。 |
| `npm run test:integration`、`npm run test:integration-member` | 对应 integration/integration-member 目录；固定 Git 候选、接续、成员修复/重组/反证等。二者完整套件均需 `TONGXU_TEST_DOCKER_CONFIG`、可用 Docker 和已有本地镜像；integration 及成员修复都使用 `tests/integration/fixture.ts` 的共享准备流程，在进入该流程时强制检查配置并执行真实隔离验证，不能只按少数文件判断环境要求。 |
| `npm run test:delivery-validation`、`npm run test:delivery-assessment` | 对应 delivery-validation/delivery-assessment 目录，二者均导入真实 Docker 验证 fixture，需 `TONGXU_TEST_DOCKER_CONFIG`、已有镜像和可用引擎；模型判断另用明确样例，不能把它称为真实模型验收。 |

按变化风险选择已有入口，说明哪些覆盖重叠。本文不把所有命令设成每次文案修改必跑清单。运行环境不同的尝试分别记结果；macOS 套件通过不能覆盖 Linux/Docker 未运行或失败。尤其 `test:native` 名称不表示它全部跨平台；其完整隔离入口见 [w4_native_inspection](docs/w4_native_inspection.md)。

## 1. Testing Philosophy

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
| 模型偏好进入执行 | 新选择随原 worker 输入固定，旧计划不改绑；不支持程序/模型拒绝 | `tests/w7/ai-workflow.test.ts`、`tests/w7/ai-settings.test.ts`、`tests/w7/additional-cli.test.ts` |
| 有限联系 | 普通报告不发 B，合法选择才 A→B→A；不完整结果不推进 | `tests/w6/task-contact-choice.test.ts`；见 test:pair |
| 本人决定和原操作 | 复制配置不能授权；过期来源/停止阻新动作；失回执后查原合并而非第二次 PUT | `tests/authority/authority.test.ts`、`tests/merge/managed.test.ts` |
| 阶段前置 | 精确生产者材料与消费证据齐备才开始依赖阶段；独立调查不被错误阻断 | `tests/coordination/contract.test.ts`、`tests/coordination/feedback.test.ts` |
| 启动与依赖 | 旧 Node/缺 SQLite 能力拒绝；程序升级不成为版本白名单；应用资产变化先于导入拒绝 | `tests/w7/workbench-launch.test.ts`、`tests/w4/external-dependencies.test.ts` |

可稳定复现的 bug 优先保留修复前失败输入，再修实现；无法自动复现时保存失败证据与原因。先复用或扩展现有测试，只有独立覆盖缺口才增加新测试。无 test diff 时说明具体既有覆盖及重跑结果；文档-only 检查不能冒充运行验证。跨模块变化要有实际组合场景，各层分别通过不够。

初次 Issue 实施的受影响组合沿 `tests/project-repair/integration.test.ts` 运行，需上表同一真实 Docker 配置/镜像；包含正常项目 HTTP 入口、原授权/资源、两次合法写入、实际注册测试和宿主 H1，模型为明确程序样例。页面脚本场景在 `tests/w7/github-projects-ui.test.ts`。真实浏览器与正常入口真实 Codex 分开留证，不能以这些组件场景代填。

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
