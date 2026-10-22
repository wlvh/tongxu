#5 / R2 接续：正式 RETURN 回执交给原任务负责人

本分支已明确采用发布修补候选 `cfd8be5af8128d1de565d863d154d3c501b95009`，target `feat/w3-governed-publication`；原父候选 `6fe2ac8`、`67064fc` 的 REWORK、反例和本分支采用前源码bundle均保留。父候选当前独立窄复核封存另记。本子范围用独立 `feat/w3-publication-return` 分支；前置若需普通修补，明确采用并核对，不覆盖历史。

1. 继续原 TaskInbox、task-candidate link、MessageRecords 和 Authority/Resource。以原接收 operation、完整最终原文、两项已核发布回执、准确 task/PR packet/H/B/target 和原负责人绑定生成通知。已有合法无治理发布可核其原请求、真实终态和回读复用；不因为缺新 marker 就伪造新发布或重发，也不改称受治理运行。
2. 通知是正式结果材料，不冒充另一个模型已发来的消息。收件角色和执行文件取自该任务先前固定的原责任记录；缺原责任、错候选、部分／未知发布均留下具体前置，不凭一个新 actor 字段代替。新角色输入需要独立准确 coordinate 授权、原资源和既有费用边界；原 publish 权限和模型报告不授予新执行或写权。
3. 一个有限入口装配、排队、由程序发送并消费原负责人回复。材料包含完整接收原文及已有完整历史，超过现有明确上限则报缺项，不截断成摘要。角色为只读处理；新原生上下文如实记录，不能冒称恢复旧会话。
4. 原 inbox 顺序和运行身份负责去重及恢复。活跃／未知旧角色阻止竞争替代；重复入口查原运行，不改 id、换目录或重发。正式发布已核、实际送达、完整材料被声明消费、最终回复、资源结算和当前适用性分别报告。
5. 用明确本地进程／Owner／provider／远端协议夹具覆盖成功、旧发布复用、错关联、假收件人、变化材料、未知运行、撤销／停止和重复。该证据不称真实 Owner 或业务接收。保留既有真实原生链原件，不为了回归重复收费模型任务。独立审核后单独 Draft；实际远端候选桥接、R1 已知失败重试、R3–R6 和原52验收继续推进。

## 入口与材料

`node dist/src/publication-return-cli.js prepare --plan /绝对路径/return.json` 固定原回执、登记通知和完整上下文。`deliver --plan 同一路径` 由程序调用原只读消息执行器，保存准确输入、会话、完整回复与资源结果；用户无需复制报告。该入口消费已核发布结果，不会自动新增发布或合并请求。

计划类型为 `tongxu-publication-return`，schemaVersion 为1。字段为 `store`、原接收 `operation`、原 `task`、准确 `taskLink`、固定通知 `id`、`source`、只读 `question`、独立 `authorityIntent`、可选 `resourceBudget`、原有 `billing` 和 `timeoutMs`。计划不接受 recipient／participant／执行文件；这些从该任务第一份责任记录取得。`prepare` 的原消息计划摘要供原 coordinate 许可绑定，不借用 publish 许可。没有原负责人时直接报告缺项。

原任务上下文增加 `publicationReturn`：包含不可变回执、完整最终原文、结构化判断、准确公开回读对象和任务关联。它明确是正式结果来源，`sender` 仍为空；没有伪造另外一个模型会话。完整材料沿原 `consumeMaterial` 契约要求回复声明消费，部分回答或漏消费不会成为完成。公开投影继续不含私人全文，原报告只进入同一授权范围内的私有角色输入。

同一通知重复调用读取原运行，已经执行后再次 `prepare` 返回 `prepared_original_run_exists`。换通知ID也不能再次投递同一任务的同一正式RETURN；只有已经准确取消的未发请求允许另行准备，原取消记录仍保留。普通后续讨论继续原TaskInbox，不靠重复正式通知实现。原任务仍有未结束／未知请求时返回 waiting；停止解除后沿原准备继续。

通知结果分别给出原正式发布证据、实际输入是否提交、完整材料消费声明、完整最终回复、原资源结算和当前材料适用性。发布材料中的 `remoteSource=original_verified_readback` 与 `liveRemoteAtRoleSend=false` 说明它是原回读事实，不能声称角色发送瞬间又检查了远端。新原生上下文仍标记 `nativeSessionResumed=false`；精确原生resume能力属于其它接续范围。

作者 build04 的8条实际本地进程场景通过：完整报告/原责任/同run重复，部分回答与漏消费保持原运行，停止及同计划接续，缺负责人/部分发布/非RETURN拒绝，错关联/原角色未知等待，材料变化在发送前拒绝，独立准确coordinate授权/原资源及撤销后旧回复复用。首轮4通过1失败源于夹具把纯fixture授权配置到原生形状接收队列，原失败保留；修正为明确本地github/external协议形状后准确授权路径通过，不扩大为官方模型或真实Owner。后续更名重复保护另作验证。

输入登记与送达分别报告：`inputRegistered` 仅表示原发送意图已经保存；`deliveryObserved` 取自真实协议回执，没有回执时 `inputSubmitted` 为 null（未登记则 false），不把已登记冒充已送达。最终捕获是否完整另有 `runtimeCaptureComplete`。

采用准确父修补cfd后，build08与当前完整9条返回通知场景通过／0skip，包括明确协议拒绝有登记但没有送达回执，以及改通知ID不重复投递。此前原任务接入／候选关联35条回归通过／0skip，原范围保留；新的原资源出口在父分支28条与本分支准确coordinate场景中另行验证。采用前源码bundle保留。自动接入父修补曾保留两个同名import，build07失败且未运行测试；删除重复import后重新构建和验证，原日志保留。
