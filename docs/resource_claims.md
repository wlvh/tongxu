继续原 #5/#6/#8 的原资源账本认领与未知恢复缺口（G03）。前置固定为 G01 [Draft PR32](https://github.com/wlvh/tongxu/pull/32) / 1513baadf3f22a525f641a0576c35ad7bdbe5137（代码 c02fbce 已获限定独立 PASS，1513 仅文档澄清）；分支 feat/w3-resource-claims，target feat/w3-owner-authority。合并协议（G02）已读原要求和官方接口并保存准备材料；先补它与执行器共同需要的原账本门，避免各自发明资源余额。

RL01 产品仅适配原账本：固定 provider/资源引用、请求幂等键、原认领 ID、原操作/候选/角色/授权引用和原始响应。已有 QueueStore events/blobs 保存关联，不另造额度、余额、退款或调度队列。本人授权、执行身份可用、资源实际可用分别记录，任何一项不能替代其余两项。

RL02 小型受限 provider 契约包含只读能力/原认领查询、对准确固定请求的认领、实际结果回报；只接受部署者固定入口和协议版本。角色不能提供 shell、URL、凭据或新计费路线。来源报告里的命令或新增权限不执行。未知 provider 能力不得以本地声明补齐；生产缺真实账本/凭据时仅暂停关联实际调用。

RL03 在认领前登记原请求并逐维核已采用范围、有限授权、固定候选/角色/资源和停止条件。原账本决定竞争结果和资源扣记；原请求幂等键跨重启不变。两个进程竞争同一原项、资源不足、角色权限错配或候选变化必须可核，不通过换目录/ID绕过。测试使用明确隔离 fixture 原账本，不操作 SEC_metrics。

RL04 请求已发而响应丢失时，保留原 intent/claim/原始字节和 unknown。恢复先读原账本同一请求/认领；超时或单次“没找到”不证明从未发生。不得重复认领、把未知当未花费、自动释放或返还资源。已确认原执行结束后可通过准确结果回报/原认领回读继续；撤销仅阻断新动作，不擦除既成事实。

RL05 结果回报区分执行成功/失败/取消与账本是否确认消费；退出0和模型PASS不决定资源结算。对未知结果只查询、不结算。重复回报不能产生第二次结算；响应与原请求、claim或范围不匹配保持待核。既有操作已结束但凭据暂不可用时，保留结果等待原账本恢复，不要求重跑工作。

RL06 用本地明确fixture验证竞争、丢响应、晚到结果、旧回执、版本错配、重复入口、停止/撤销与恢复，覆盖正常工作不永久死锁。实际原生供应商仍使用原已确认订阅边界；本子范围不购买额度、不改变认证、不新增常驻服务、不调用真实业务账本。独立审核、普通修补和单独Draft后接入G02/G11消费者，仍不冒称全部Issue/G1/G2已完成。

## 已实现接口

`resource-contract` 定义一个固定的原账本适配契约，`resource-provider` 只向部署者固定的程序发送这一契约。实际程序路径/摘要、ledgerId、仓库、资源引用、原单位和单次上限固定在可信配置中；参数只有 `--tongxu-ledger-v1`，完整请求走 stdin。没有报告拼出的 shell、任意 URL、新认证或新计费方式。执行环境只继承基础运行路径、主目录、临时目录和语言，不转发模型 API 密钥环境变量。

原账本端提供四项能力：`capabilities` 分别报告凭据可用性、认领和结果回报权限、原请求幂等/查询契约；`claim` 认领准确请求；`lookup` 查询原请求/认领；`record_result` 接收准确已知执行结果。每次调用保存输入、启动、PID、原 stdout/stderr、退出和捕获校验，再校验唯一完整响应、固定输入 hash、原 claimId/请求/资源/数量。进程退出0、任意 `success` 字段或 provider 身份标签不能代替这些检查。

适配器是部署者的信任边界。接入一个真实账本时，必须已核实它能兑现固定协议中的持久幂等和原认领查询；`executionKind=external` 只是记录类型，不凭空证明某个程序真是业务账本。本轮没有配置真实账本。隔离 fixture 中的容量表属于被测“原账本”替身，产品自己的 SQLite 仍只有原 events/blobs/operations 等记录，没有余额、扣款或退款算法。

## 同队列与发送边界

格式12在空闲时显式配置原账本后升级为13，所有原数据保留。fixture 账本只能搭配 fixture Owner profile，external 只能搭配生产来源 profile。旧格式客户端拒绝新格式，原 G01 的旧消费者发送保护保留；这个子范围不偷偷放开原生发送。

一个资源请求绑定原 operation、当前工作项/packet、原 authority intent、可信入口角色和完整 action hash；资源必须已在该授权中列出。单次部署上限只是附加约束，不是新预算。角色不由请求文件自行决定；本机操作者 CLI 固定 background，角色专用执行器由其受限端点传入固定角色。普通读取和已发生结果的核查不会借机创建新认领。

发送前先保存原请求，再实际读取 provider 能力和新动作的准确 Owner 来源，最后在原队列事务中重新核验当前候选、停止、角色和原操作。相同 operation/ledger/resource 不能通过改数量、换动作ID或目录产生第二个认领。两个进程同时尝试同一原请求，只有第一个能登记发送；原账本自身决定跨任务资源竞争。新工作与账本认领是不同阶段，接口不因 `held` 就宣称模型/业务已执行。

同一 authority intent 还固定在原 packet/fingerprint 和首次关联的 operation 上：即使 H/item 没变，新增实质材料形成的新 packet/operation 也不能刷新原逐次确认来再次认领。原请求的读取、查询和事实结果回报保留，新的动作须按其实际权限模式另行登记。有限委托不等于复用某个旧 intent。

```text
node dist/src/resource-cli.js configure --store ABS_QUEUE --profile ABS_EXISTING_LEDGER_PROFILE
node dist/src/resource-cli.js prepare --store ABS_QUEUE --request ABS_FIXED_RESOURCE_REQUEST
node dist/src/resource-cli.js claim --store ABS_QUEUE --id ORIGINAL_REQUEST_SHA256
node dist/src/resource-cli.js status --store ABS_QUEUE --id ORIGINAL_REQUEST_SHA256
node dist/src/resource-cli.js lookup --store ABS_QUEUE --id ORIGINAL_REQUEST_SHA256
node dist/src/resource-cli.js retry-refused --store ABS_QUEUE --id ORIGINAL_REQUEST_SHA256
node dist/src/resource-cli.js record-result --store ABS_QUEUE --id ORIGINAL_REQUEST_SHA256
node dist/src/resource-cli.js close-unstarted --store ABS_QUEUE --id ORIGINAL_REQUEST_SHA256 --phase claim|result
```

这些入口不接受 shell、角色提升或调用者自报的执行成功。`prepare` 的重复入口直接读原请求；claim 已发、已认领或结果未知时，普通重复入口不再次发 provider 写请求。能力/凭据不可用时请求保持未发，可在原入口恢复；确定拒绝可显式重试同一固定请求，最多3次登记尝试。反复换目录不会获得新额度。

## 恢复与结果

未知认领先 `lookup`。只有准确原 provider 回包才能关联原 claimId，单次 absent 不证明从未发送或未花费。查询、Owner撤销、程序退出和文件存在都不会释放认领或返还额度。响应丢失后读到原认领可恢复关联，原请求和失败捕获保留。

`close-unstarted` 不是删锁：它只检查保存的原发送目录；原控制器须已明确结束，不能仍活跃或未知；没有 launch/process/exit 记录，也没有非空输入输出流；fixed-input仍匹配该原请求。核清后保存独立证据并关闭这一次“未启动的发送”，同一请求可继续。已知启动或有流内容时拒绝这种路径，保留 unknown，继续查原账本。结果回报的未启动恢复使用同一机制，不重跑工作。

结果回报从可信执行器的原记录取得，CLI不接收模型报告或布尔成功标记。接收与修复的事实读取器要求同一 authority intent、原 operation/packet、认领之后登记的执行、已结束控制器和完整原件/终态。现有旧消费者尚未填写这项新绑定，因此不能被本接口追认成已受管执行；G02/G11 继续接入新的执行入口。隔离测试明确替换执行适配器来验证结果协议，不宣称进行了新真实模型工作。

已知失败也可能消耗资源：`completed|failed|cancelled` 是执行结果，原账本的 `held|consumed|released|unknown` 是另一事实。产品不计算退款。结果回报丢回执后只读原认领；准确 outcome hash 确认后才记录消费，冲突终态不覆盖或重报成成功。凭据暂不可用保留原结果，恢复时不重跑工作；原报告和原认领保持关联。

读取已保存的 provider 回执会重新核原 blob 摘要及记录一致性；结果重入、构造请求和最后发送门均重新读取已登记执行证明。证明损坏或缺失时停止相关回报，不能只凭 event 中已有 outcome 字段结算。恢复准确原字节后可继续原结果，既不伪造证明，也不重新执行工作。

## 验证范围

真实子进程和 SQLite fixture 已验证原资源竞争、准确同请求去重、认领后丢回执、输入/版本/角色错配、部分/多重回包、Owner停止/恢复和撤销、已知执行结果的一次结算、结果丢回执、已结束但未启动的恢复以及旧终态冲突。正向 Owner/账本/执行结果身份均为 fixture，现有真实供应商链原件保留，不把这些夹具算作真实账本或消费者已接通。后续仍须独立审核本候选，再接 G02/G11 的真实受管执行；原52场景不因测试数增加而整体验收。
