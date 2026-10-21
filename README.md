# 同序｜人掌控目标，Agent 协作交付

**v2.3 产品范围；本分支包含只读采集、隔离验证、原队列独立接收、受控修复与再审、最小集成候选、任务联络与阶段协调，以及能读取真实记录并执行已配置有限控制的本机工作台。** 成果批次、场景验证、独立成果判断和有来源的接受决定也已接入。各项软件、隔离样例、真实模型执行与生产启用分别记录；完整 G1/G2/G3 和全部产品验收尚未完成。

目标体验是：你主要对工作秘书说目标、顺序和边界。秘书联络和跟进，不做技术任务；开发者协调实现，独立审核者检查，PR 接收者判断最小安全合入，普通后台核权执行。任务自主联系、后台中转，GitHub保存正式记录，不让秘书成为消息或撤权瓶颈。下方状态表区分现有能力与尚待实现的部分。

## 从哪里开始

- [产品说明：有什么、怎么用](docs/PRODUCT_GUIDE.md)
- [现行完整设计与实施基线](docs/tongxu_v2_plan.md)
- [发给 Codex 的持续开发指令](docs/CODEX_NEXT.md)
- [只读 CLI：安装、采集、缺口与恢复](docs/w1_cli.md)
- [隔离验证：固定树、逐前缀测试与结果对照](docs/w2_verification.md)
- [影子接收：持久材料、控制、前置与原操作恢复](docs/w3_shadow_queue.md)
- [已有 Codex 的无模型隔离自检](docs/w4_native_inspection.md)
- [Codex 原结果：导入、追加、重放和交接输入](docs/codex_result_adapter.md)
- [真实只读协作：两轮、Claude 接收与 Codex 综合](docs/local_readonly_relay.md)
- [受控修复：限定写权、固定测试和新候选再审](docs/controlled_repair.md)
- [本机组合：固定来源、统一入口与接收前边界](docs/local_reception_integration.md)
- [独立接收：从原队列实际派发、回读和恢复](docs/native_reception.md)
- [证据补充：保留首次判断，在原任务登记新增原件后补核](docs/reception_supplement.md)
- [结果发布：固定公开摘要、提交状态、读回与中断恢复](docs/result_publication.md)
- [受限秘书：查询原任务的实际状态并保留回答依据](docs/readonly_secretary.md)
- [角色 prompt 装配及工具权限](prompts/README.md)
- [无 PR 任务与原负责人待办](docs/task_intake.md)、[准确候选关联](docs/task_candidate_link.md)
- [任务协调与共同部分](docs/task_coordination.md)、[工作台／秘书的受管联系](docs/task_controls.md)
- [受治理的新独立接收](docs/governed_reception.md)
- [本人来源与委托](docs/owner_authority.md)、[原资源认领](docs/resource_claims.md)、[三类停止控制](docs/scope_controls.md)
- [成果批次与本人决定](docs/delivery_outcomes.md)、[实际场景后的独立判断](docs/delivery_assessment.md)
- [最小集成候选](docs/minimal_integration.md)、[成员修复与反证后新接收](docs/integration_member_repair.md)、[已结束部分构造接续](docs/integration_continuation.md)

目标界面覆盖本批目标、组织方式、委托与停止、成果验收、复盘抽查五项控制；秘书对话与原三工作区保留。当前直接入口已覆盖受管联系、有限撤回、停止和成果决定；目标／组织变更、委托准备及复盘的完整界面连接仍待补齐。人的采用、技术判断与依据委托作出的处置分别记录。

## 只读 PR 交接

```bash
npm ci --ignore-scripts
npm run build
node dist/src/cli.js collect --repo wlvh/tongxu --pr 12 --output /absolute/private/tongxu-pr12-new
```

请将 `/absolute/private` 换成仓库外、已存在的真实私有父目录，新输出目录必须不存在；macOS `/tmp` 别名不适合作为显式输出。

输出目录须为仓库外的新绝对路径。默认使用已有 Git/gh 身份，只读固定候选和原记录，生成私人交接包与单独摘要；部分失败可 `collect --resume`。退出 0 不表示本人采用、业务 PASS 或可合并。完整命令与显式连接器传输见 [CLI 文档](docs/w1_cli.md)。

`verify` 可选原 Linux/bubblewrap 或 [现有 Docker 的隔离执行器](docs/docker_verification.md)，读取已有包，在断网的新现场运行显式登记的现成测试，并保留基线和每个组合前缀的固定树、实际 HEAD、原输出与缺口。命令和测试计划见 [隔离验证文档](docs/w2_verification.md)。它不写远端，不自动安装依赖，也不执行 SEC_metrics。

`queue` 子命令把配对 W1/W2 材料导入私有 SQLite，保存精确前置、停止控制、同目标占用和可恢复的影子评估。用法见 [影子接收文档](docs/w3_shadow_queue.md)。独立接收、结果发布、受管修复和受管合并使用各自入口，消费同一队列的原操作、授权和资源记录；普通导入或影子评估不会自动触发这些动作。

## 在同一目录使用本机协作能力

本分支已将固定 W1 Mac 修补、W2 Docker/W3 和 W4/W5 源码组合到一个目录。使用现有 Node24 和依赖构建后，Mac 的适用验证为：

```bash
npm run test:docker -- /absolute/private/docker-config.json
node --test dist/tests/w4/codex-results.test.js dist/tests/w5/*.test.js
```

配置必须指向已核的本地 Docker socket、现有程序和固定镜像 ID，完整格式见 [Docker 入口](docs/docker_verification.md)。无需再建虚拟机，也不嵌套 bubblewrap。`npm test` 继续保留原 Linux/bubblewrap 专属路线；`npm run test:mac` 提供不含 Docker 的 Mac 适用检查。

`relay-cli` 的一次入口可完成真实 Codex 两轮、程序交给 Claude 并返回 Codex 综合。受管工程修复、队列审核返工和成员修复已有后续入口，保存实际修改、固定测试、新候选与独立再审；最初的纯函数样例仍保留。已有完整操作优先回读，不为展示组合重复调用模型。受治理重新组合的新测试授权、已有工作区跨执行者交接、真实远端候选桥和完整会话控制仍有连接工作，不能将已有单条链扩称为全部验收。

## 本机工作台

使用 [本机工作台配置](docs/local_workbench.md) 选定已有队列、任务和成果批次后运行：

```bash
npm run workbench -- --plan /absolute/private/workbench-plan.json
```

打开终端返回的本机 URL。默认只读；有限控制模式须在配置中明确装配，[任务控制](docs/task_controls.md)、[停止](docs/scope_controls.md)和[成果决定](docs/delivery_outcomes.md)分别核对原来源与权限。临时浏览器钥匙不等于本人身份或写入授权。关闭工作台不终止原任务，刷新不启动模型。

## 离线 UI

```bash
python3 prototypes/build_product_ui.py
```

打开生成的 `prototypes/product_ui_prototype.html`。只使用虚构任务与固定演练，无模型／GitHub连接。生成器仅维护设计原型，最终W7由真实前后端替代；不要把它变成生产框架。详见 [验证边界](verification/REVISION_V23.md)。

## 开发顺序与 Issues

| Issue | 阶段 | 当前软件／限定交付 | 剩余验收或启用边界 |
|---|---|---|---|
| #1 | 材料修订记录 | 原修订与来源保留 | 关闭 Issue 不代表应用验收 |
| #2 | G0 / W0 | 基线及持续开发安排已保存 | 原52场景逐项收口，保留真实外部前置 |
| #3 | G1 / W1 | 固定真实 H/B/target 的只读 CLI、缺口和恢复 | 新远端候选须取得自己的观察，不能借旧快照 |
| #4 | G1 / W2 | Linux/bubblewrap 与现有 Docker 路线；固定树、前缀和原结果 | 新组合使用自己的测试计划、授权与证据 |
| #5 | G1 / W3 | 独立接收及准确授权／资源接入、结果发布、组合接收、最小集成、受管合并入口 | 受治理重组测试与后继授权、远端候选与正式退回通知；真实治理与发布身份另列 |
| #6 | G2 / W4 | 原生协议、完整角色提示、会话来源关联和受管消息 | 已有会话的继续／引导／中断须按实际能力验证，元数据不授予控制权 |
| #7 | G2 / W5 | 事实与影响核实、综合、工程修复再审、原判断补充和复盘记录 | 已有工作区准确责任接续、正式通知与组合旅程；真实后果只从原记录取得 |
| #8 | G3 / W6 | 无 PR 接入、原负责人待办、阶段协调、共同能力及修复产物消费 | 受管角色主动联络的余项、原现场交接与两条完整旅程 |
| #9 | G3 / W7 | 真实记录与全文、有限联系／停止／成果控制、X1/X2、场景验证和独立成果判断 | 五项控制余项、安装升级退出与窄屏键盘的组合验收；有权成果接受另列 |
| #10 | 治理设置 | 只读核查及可审阅配置差异已准备 | 实际应用、独立身份、正式采用与批准不由准备记录代替 |

阶段交付是检查点，不是停工点；按 [#2 持续开发安排](https://github.com/wlvh/tongxu/issues/2#issuecomment-6251133759) 逐包细化和推进，当前优先 G1。不重做 W0，不同时启动全部工作包。只读试点 SEC_metrics，不授予其写入、额度或生产接管权。分支开发与主干合并分开，未授权不合并。

## 记录与公开边界

`docs/issues/`是受控发布源，原GitHub Issue为实施入口；一个执笔者发布并读回，不两端独立生效。历史材料在archive及review中，不作并行现行规则。T01—T52保留原始验收条款；初始清单的未执行字段不是当前证据总表。当前交付与原失败由各固定 PR／私人证据清单逐项追踪，尚未声明全部通过。

本次材料整理是用户委托代理完成，不等于本人逐项签署全部技术选择；身份、决定类型与依据须分开。公开文件与提交不新增凭据、私人路径、私人会话链接或原件。未重写历史。


W6 两个固定接收任务的阶段协作入口：见 [paired_reception.md](docs/paired_reception.md)。B 可先完成独立材料检查，共享接收等待 A 的准确判断；一个入口自动转交完整结果并核消费，重复读取原运行。当前真实验收状态以该文档和原 #8 / 对应 PR 的固定记录为准。

本机工作台默认只读模式见 [local_workbench.md](docs/local_workbench.md)；后续有限控制与秘书联络见 [task_controls.md](docs/task_controls.md)。查看、请求准备、实际执行、本人采用与生产批准分别记录。

现有工程的受控修复入口：见 [project_repair.md](docs/project_repair.md)。固定已有Git候选、材料/可写路径和现有Docker测试计划，在受管副本内核实、修复、测试和独立再审，原作者现场保持。原clamp示例和历史记录仍可读取。

受管合并的独立入口：见 [managed_merge.md](docs/managed_merge.md)。在原队列后续阶段绑定 Owner 意图、已有资源、独立接收和唯一目标写者；有限发布协议先登记再发送，实际版本回读与失回执恢复分别记录。当前正向执行为明确本地 HTTP 假服务测试；真实发布身份、治理和合并未启用，组合锚点不会被当作完整集成候选。
