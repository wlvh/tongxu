# W5：现有工程的受控修复

来源：用户2026-10-20明确设置持续goal，完成全部原Issues中现有授权内可自主决定的部分。本条细化原#7的实际工程修复，不删除其判断反馈/整体复盘要求，不取代#5/#6/#8/#9完整范围。固定前置为PR26 `13d4e7774f6ec6db9ecc8ebd5c6219080cb0f342`，独立分支`feat/w5-project-repair`，真实target `feat/w7-local-readonly-workbench`。原W5示例与原证据保持可读。

EP01 由可信本机请求固定已有本地Git对象库、源候选H/B/真实目标、现有测试计划及hash、允许写的明确文件、只读材料、契约、问题与既有授权出处。只在新的受管副本修复；不写作者原分支/工作区，不把未提交内容混入固定H。原源候选与新本地候选分别记录，后者不伪造GitHub PR。未知活动写者不能接管。既有官方CLI、订阅、工具限制和最多三批边界保留。

EP02 将固定对象取到新私有Git目录，校验实际HEAD/文件和预备者结束，显式交接后才让事实核实角色写限定路径。材料和可写集合有界，受管工作区支持一般项目文件；配置、测试判定器、执行器、Git管理文件、凭据和记录不由报告赋权。模型仍只有注册读文件、精确hash替换获准文件、请求固定测试三种能力，无任意shell/网络/发布。跨角色输入只包含登记材料，保留未覆盖项。

EP03 复用W2可信参数数组计划、依赖摘要和现有Docker隔离执行器。每次测试在独立副本冻结真实Git候选/树后执行，禁止把业务代码直接在宿主执行。保留无网络、非root、只读系统、无宿主凭据、默认seccomp和零capability，不安装服务或拉新镜像。测试可生成登记构建产物，但源输入/Git/依赖变化、未知或不完整捕获不得成为成功；测试不能改原修复工作区、可信判定器或运行中的控制器。

EP04 原有项目测试通过只证明该测试范围，不自动反证所有finding。实际事实核实→独立Claude影响核实→原事实会话综合→明确写权交接→实际修改/测试→固定新候选→新鲜独立审核沿用原流程。无finding或事实反证可跳过修复；环境故障保留真实缺口，不为了维持运行重发付费任务。

EP05 复用原operation、写入意图、租约、停止、原捕获与恢复。项目测试的容器操作也要进入恢复检查：宿主控制器退出不等于容器已结束；仍活动/未知先核原容器，不删除或换目录绕过。核清已结束后可恢复准确原候选；原锁/旧判断/部分修改保留，重复入口不重派、不重复写或提交。

EP06 安全样例覆盖多文件工程、越界/测试文件保护、输入篡改、测试失败/环境失败、无授权/撤销、活动或未知写者/容器、部分修改/提交中断/重复恢复、绿测试仍有有效finding、新候选独立审核及原clamp契约回归。至少取得一次真实原生工程修复及原测试/独立再审，人工搬报告与手工修复为零。历史真实缺陷与明确测试仓库必须如实标记，禁止向正式候选故意加错。

EP07 所有修复留在独立受管候选，产物包含实际diff、新commit/树、原源候选、原测试/模型/权限/进程及独立报告，供既有接收流程消费。不会自动push、批准、merge、改保护、部署、增加费用或执行SEC_metrics。代码/样例/实跑/原Issue全量完成分别报告；本项完成后继续其余可自主工作。

## 已实现入口与明确限制

沿用原`RepairConfig`中的官方程序、完整角色提示、既有订阅证据及停止条件。工程请求是独立可信JSON，类型见`ProjectRequest`，包含本地`objects`、原`candidate`、`allowedPaths`、`materialPaths`、`protectedPaths`、问题和契约、W2 v2 Docker测试计划路径/hash及授权来源。源PR身份保存在`sourceCandidate`；受管副本的候选类型为`local-git`，目标为该副本的`project-base`，不伪造新远端PR或改变原target。

```sh
node dist/src/repair-cli.js project --config /private/existing-config.json --request /private/project-request.json --root /private/new-managed-project
node dist/src/repair-cli.js run --plan /private/new-managed-project/plan.json --output /private/new-managed-project/operation --reconcile-ended
```

首命令完成准备和执行；相同请求再次进入同一root复用原plan/operation。变更固定请求会拒绝，原执行未知时保留原件；不能换root重发来绕过。恢复须先确认原执行者、所有登记子进程以及测试容器已结束，原Docker记录缺失时继续未知。新原生模型仍要求未过期的现有用量证据，不更换计费方式。

本版允许明确列出的现有文本文件替换，最多32个可写、64个模型可读材料；工作区最多2048个普通UTF-8文件、每文件256KiB、完整快照16MiB，送模型的材料768KiB。拒绝symlink、submodule、路径跳转、改文件集合以及未列出的读取/写入；不会静默截掉这些材料。新文件/删除和二进制修改尚未开放。测试代码只能在隔离副本执行，依赖只读挂载且前后hash一致；已登记结构化覆盖缺失不能因退出0通过。

现有测试全绿时仍核实finding；按测试覆盖之外的事实形成修复或反证。测试结果保留`businessCorrectness=requires_independent_review`，新候选还须新鲜独立审核。模型报告、测试输出及当前页面不赋予权限。判断反馈、已发布返工批次的独立计数和按需整体复盘继续按原#7另行补齐，不因本子范围交付消失。

专项验证使用现成Docker配置，缺环境明确失败而不skip：

```sh
TONGXU_TEST_DOCKER_CONFIG=/private/existing-docker.json npm run test:project-repair
```

专项消息为明确本地模型夹具，Docker/文件/Git/测试/恢复为实际执行。真实供应商模型结果单独记录；测试数不能替代该实跑。
