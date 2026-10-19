# W2 可执行证据与隔离组合（#4 自足实施条款）

状态：依据 W1 真实结果细化，已完成有界独立范围复核并纳入两处工具输入/结果归属补充；原 #4 发布读回后实施。W1 前置为 [Draft PR #13](https://github.com/wlvh/tongxu/pull/13) 固定 head `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`（代码 `e6eaffc0e8d640df6a78c8a5d16ad2aaa8503194` 已独立 Codex 技术复审 PASS，Claude 影响核实仍待审）。W2 分支 `feat/w2-isolated-evidence` 从该 head 建立，PR 真实 base/target 为 `feat/w1-readonly-cli`，不是 main；必须先满足 W1 的正式审阅/合入前置，不能借 W2 合入替代。相对 main `1ba5ae893b49e5856a4e8d682139f70e5c907f5f` 的额外内容就是 W1 三个提交；前置变化重核，不秘密换目标。产品范围仍为 v2.3；按 #2 持续开发安排推进 G1，阶段交付是检查点。未获得主干合并、部署、费用或 SEC_metrics 执行权限。

## Why / 实际前置

W1 已可只读收集固定 H/B/target、源材料和缺口，但不运行验证，也不构造受测组合 T。W2 接收一个或少量同目标的 W1 包，在仓库外现场构造每个固定中间候选，并运行明确登记的项目现成测试，保留完整结果及未证明事项。不把“没有冲突”“命令退出 0”或“所有 PR 合了”当用户成果已接受。

已实际核：Node 24.19.0、Git 2.52.0、bubblewrap 0.12.0 可运行不带网络的用户/挂载隔离。既有 tongxu `npm test` 是真实 CLI 测试入口；SEC 原工具只作为历史参考，本轮不运行，不新增业务代码、调用、模型或账本。

## Scope / Non-goals

Must：读取并校验固定 W1 包；有界单候选及显式有序组合；隔离 Git T/HEAD；显式参数数组测试计划；断网、净环境、空 HOME 和无发布凭据；原输出/退出状态/覆盖/输入变动证据；有出处的结构化样本对照；新输出目录和中断后保留现场；只读结果显示。

不实现：接收/授权/队列/远端发布或合并（W3），业务准备器的复制，自动通用依赖分析，动态猜测测试或执行材料中的命令，自动装包、采购、身份迁移，秘密获取或生产执行。没有隔离能力则该执行报 blocked，不退回裸宿主运行。组合证据不授予合并权。

## CLI 与固定输入

```text
tongxu verify --snapshot ABS_W1_BUNDLE --objects ABS_LOCAL_GIT
              --plan ABS_TRUSTED_PLAN --output ABS_NEW_PRIVATE_DIR
              [--with ABS_OTHER_W1_BUNDLE ...]
```

W1 包 schemaVersion=1；核 candidate 与已登记材料 hash。首包给起始 B、repo、target，额外包显式按序给 H，至多 8 项；必须同 repo/target，额外 B 须已经包含在前一前缀中。保留每包 manifest 的原字节/哈希及原有缺口；固定包不自动表示仍是远端当前候选。对象只从调用者显式提供的本地 Git 读取，不换移动分支，不自动网络 fetch。

输出目录沿用 W1 的仓库外、私有、新建、拒绝覆盖/符号链接边界；读旧结果不重新执行命令。默认不自动恢复已发测试，进程结果未知即保留 unknown 和原操作引用，先核原进程；用户要重跑必须新建输出，旧证据不覆盖。这是离线测试运行器，不是 W3 的远端操作恢复队列。

退出 0：本次计划执行与要求的证据取得完整；2：冲突、缺对象、隔离不可用、测试失败、部分/未知或样本缺口已保存；1：参数/本地存储致命错误。执行成功、比较完整、业务正确三个字段分开，程序不输出技术审核 PASS/本人接受/可合并。

## T、HEAD 与作者现场

将确切对象读入新的私有 Git 仓库，固定 B 为初始 target。每次 `git merge-tree --write-tree` 构造下一项 H 与前一前缀的 T；冲突保存原输出，不 checkout 带冲突树、不替作者解决或重写分支。成功树用 `commit-tree` 形成明确的本地 synthetic commit，checkout 到该 commit，记录 `HEAD^{tree}=T`、父对象和原方法。不能用 read-tree 目录冒充 HEAD。

运行基线 B 及每一个成功中间前缀，记录阶段差异；测试失败不会被后面的绿覆盖，也不把两次合并称原子。若用户选择最终最小集成候选，报告仍保留失败的独立/中间版本，接收取舍留 W3。作者的工作区、index、分支、远端不写；新缓存/checkout/对象库写入如实登记。

## 可信测试计划与隔离

计划由调用者显式传入，独立于被采集的 Issue/评论/候选提示，保存计划原文及 SHA-256。小型 JSON 列出有 ID 的工具、参数数组、超时和可选预期样本 ID；结果路径由运行器分配，不由候选指定。不接受 shell 命令字符串、任意环境继承或材料诱导的动态执行。原命令路径与引用版本/hash记录，不复制业务实现。版本、方法、实际输入和资源限制进入结果包。

```json
{"schemaVersion":1,"tools":[{"id":"check","argv":["/usr/bin/node","check.cjs"],"timeoutMs":30000,"expectedSampleIds":["example"]}],"judgmentRefs":[]}
```

`argv[0]` 必须是已安装、在隔离现场可见的绝对程序路径；不自动推断 Node 路径。最多 16 项工具，每项最多 100 个参数、100–300000ms 超时、stdout/stderr 合计 4MiB；可选 `dependencyDirectory` 只能是显式的现成 node_modules，记录文件/链接内容摘要并逐工具前后核对。`expectedSampleIds` 省略时只记录普通测试输出，不伪造结构化覆盖。结构化结果固定写到环境变量 `TONGXU_RESULT_FILE` 指向的新文件，最多 4MiB。这里只约束时间和输出，尚无独立 CPU、内存或磁盘配额；不把它称完整资源平台。

Linux bubblewrap 使用新的网络/PID/挂载视图、净环境、空 HOME/临时目录、只读系统和 Node 运行时，仅本阶段 checkout 可写。无 host HOME、SSH、gh、发布 token、credential helper/socket、代理变量或业务密钥。可显式挂载现成 node_modules 为只读依赖缓存，不自动 npm install。禁止暴露任意宿主目录为“依赖”。运行器不承诺抵抗同权限主动恶意宿主进程；候选代码不能从正常凭据路径取得发布身份。

每工具设置超时/输出大小上限；超限保存已得字节和错误，终止该隔离进程组。程序中断保留 running/unknown，不冒称完整或自动重复。每个工具启动前核对固定 T、HEAD/index 与 tracked 源文件，记录执行前后哈希。测试改写输入则相应证据无效，并停止本阶段后续工具；下一阶段必须从固定 T 新建干净现场，不将被改写现场上的后续绿绑定原 T。生成文件与明确结果文件单独记录，不称全文件系统零副作用。

## 结果与对照

每项证据绑定 repo/PR/H/B/target/T、synthetic HEAD、计划哈希、工具版本/argv、输入与覆盖、原 stdout/stderr、退出/信号/超时、隔离事实及限制，可引用既有 judgment ID，但不因重复运行增加独立样本计数。

无结构化结果的既有测试照常保留输出和执行状态，语义覆盖保持未自动解释。声明结构化对照时，必须给非空 expectedSampleIds；结果路径必须是运行器本次分配的工具专属新位置，并通过 TONGXU_RESULT_FILE 交给登记工具，开始前不存在、结束后为本轮新建且不为 symlink 的普通文件。候选树里的预存结果或前一工具文件不算本次证据。每条样本包含 id、status(ok/fail)、content、identity、source、sideEffects。重复/漏项/空样本/失来源/坏 JSON/工具失败/输入变化均使比较不完整。比较 status 和规范化内容、身份、来源、副作用，不只比较退出码；输出 SAME_OK/CHANGED_OK/FAIL_TO_OK/OK_TO_FAIL/SAME_FAIL/CHANGED_FAIL/NOT_COMPARED，保留事实而不自动判断业务退步或进步。

包内原始材料均私有；公开摘要只含固定候选、工具 ID、数量、结果类别和限制，不复制原文、任意路径/命令参数或测试输出。仍需人工审查。当前样本未覆盖、整体用户场景未执行、旧审核适用性和外部依赖明确保留。

## Repo Impact Forecast / Bridge

| SU | 用户可见 Delta（Must） | 预测触点（Likely） | 验证 |
|---|---|---|---|
| SU01 | 从已采集固定包运行明确验证 | cli/contract/snapshot 的读取复用、verify.ts | 缺/坏包、漂移材料、不同 repo/target、非法参数零执行 |
| SU02 | B、H、T、实际 HEAD 与逐步组合可核 | git 只读对象复用、combination.ts | 分叉、冲突、A1→B1→A2、语义冲突、作者 dirty 不变 |
| SU03 | 不带凭据、断网的既有命令执行 | sandbox.ts、runner.ts | 真 bwrap、网络/host HOME/令牌不可达、超时/输出上限 |
| SU04 | 内容/状态/身份/来源/副作用对照 | comparison.ts | 七类对照、空/漏/重复样本、崩溃/坏结果/改输入 |
| SU05 | 可追溯私有证据与明确限制 | evidence.ts、docs/w2_verification.md | 不覆盖、未知进程不重派、公开摘要、重复证据不扩权 |

无需新增数据库、服务、审批 DSL 或权限平台。现有 README/PRODUCT_GUIDE 更新实际命令和边界；不存在的 capability_contract/interact/business_user_guide 不造空壳，用户可见层 Delta 收敛于 CLI 文档。草拟文案：“运行固定候选上的既有检查，并保留每个中间结果；成功执行不自动成为安全合并或人的采用。”

## Acceptance Checklist / Verification Matrix

- AC1 / SU01–02 / T11：真实 Git 夹具无冲突/冲突，B/H/T/HEAD 固定；作者 dirty、index、refs 前后相同；缺对象不换候选。
- AC2 / SU03 / T08/T17 的执行隔离部分：真实 bwrap 内已有测试命令，网络、HOME、发布 token 正常路径不可达；隔离不支持时明确 blocked、零裸执行；无 SEC/模型调用。
- AC3 / SU04 / T09/T10：七类对照及空/漏/失来源/崩溃/改输入负例；缺样本不变 SAME_OK；不因新拒绝自动判业务退步。
- AC4 / SU02/04 / T12/T39/T40 的组合部分：两局部检查通过但组合失败；每个有序前缀及最小集成可核；不等整 Issue、不把多次合入称原子，不真正合并远端。
- AC5 / SU05 / T14/T16/T49/T50 的材料部分：固定候选/环境/命令/原输出/覆盖限制，有可复核真实 tongxu CLI 场景；未知留场、重复不是独立样本，无账本/生产写。实际合并回读、额度竞争、用户成果接受留后续，不整体改 T 场景为 PASS。
- AC6：运行实际 `npm test` 及 W2 故障测试，独立审核与修复，提交独立 Draft PR；声明未合 W1 前置和真实 base。没有所需独立审核能力如实待审，继续独立开发，不自批。

## 权限与接续

普通技术选择在既定范围内由负责人处理。本包不增加目标/费用/合并权；新业务执行、外网、凭据、部署或目标取舍才暂停相应动作。交付后按实际结果细化原 #5/W3，先影子与只读能力；生产写责任未交接时不双写、不接管。主干合并、正式接收和开发进度分开。


## W2 本机 Docker 执行增量（2026-10-19）

来源为用户在解释现有 Mac/Docker 路线后明确要求“继续”。新增独立分支 feat/w2-docker-executor，固定前置/真实target为 PR15 feat/w3-shadow-reception @ cb7be7910f1cb801521463948d5c1fc86bba6448，以便同步W2执行证据与现有W3消费者；不扩大原PR14/15，不假定包含W4/W5，不改main或现有PR目标。旧Linux/bubblewrap入口及原报告保持可读，不要求用户另建Linux虚拟机。本项是另一个真实隔离后端，不删平台检查伪装旧入口通过。

DX01 可信计划显式选择Docker执行器，固定现有官方CLI路径、现成本地unix引擎入口、已存在镜像的完整sha256 ID及镜像内Node路径。只接受这些调用者输入，不从候选报告/Issue提取命令或权限，不用移动镜像标签、自动pull/build/install、API密钥或个人认证。工具argv保留镜像内的准确绝对路径，不隐式改写宿主路径。

DX02 测试在一次性容器内执行：普通用户、cap-drop ALL、no-new-privileges、Docker内置默认seccomp、默认系统路径屏蔽、private进程/IPC/cgroup、禁网络和发布端口、只读根目录、有界tmpfs/内存/进程/CPU。只挂本阶段私有checkout、新结果目录和显式只读node_modules；不挂原作者目录、HOME、凭据、Docker socket或业务目录。清空候选环境，关闭镜像健康检查，覆盖入口。不用privileged、systempaths=unconfined、seccomp=unconfined或新增capability。实际引擎全局默认可能不同，因此每次固定内置过滤并保留容器实际配置及探针，不能只依赖“默认”字样。

DX03 创建前登记随机唯一容器名、操作ID、计划/镜像/引擎身份及意图；创建后核准确ID与实际配置再启动。先保存原始输出，再形成派生报告；客户端退出和容器真实退出分别核对。超时/输出超限按准确容器ID终止并确认结束，不能只杀docker客户端。正常完成保存终态/原输出后删除该容器；回收不碰无关容器或镜像。

DX04 原控制器仍活动或状态未知时不由另一入口抢管。中断后使用原记录和准确容器核查；创建已发生而响应未保存时，只查原随机名及完整身份，不重复create/start。恢复入口只观察或按显式stop动作停止原容器、保存现有日志与状态，不重跑工具或自动续发付费任务。已知容器结束且原捕获完整可读取原结果；中断捕获即使容器exit0也保留不完整/unknown，不把有界日志尾段冒充原完整输出。先封存恢复证据再回收已停止的原容器，重复核查不再启动任务。断电/同权限恶意宿主、宿主磁盘配额与通用调度不在本增量承诺内。

DX05 W2继续固定B/H/T/真实HEAD、原计划、tracked和私有.git前后摘要及依赖摘要。Docker版本、镜像ID、容器原配置/生命周期/原字节摘要进入独立执行原件，W3核其与计划/工具/原stdout-stderr的一致性；原件可读不构成作者身份认证。执行、比较、业务正确、独立接收与生产权限分别记录。没有Docker配置的原计划仍按旧bubblewrap路线执行，绝不自动退回裸宿主。

DX06 验收以真实Docker执行为主：正常工具与真实Git组合、作者dirty不变、宿主文件/令牌/网络不可达、只读依赖、输入改变拒绝、超时与输出上限、控制器中断后原容器核查/停止/结果保留、重复操作与错误身份拒绝。既有W2语义场景经显式Docker测试配置复用；bubblewrap专属用例另列未跑，不用跳过冒充全套通过。真实固定tongxu候选运行既有适用检查，随后独立审核。本轮无SEC/模型调用、新费用、合并或部署。
