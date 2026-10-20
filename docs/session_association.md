# 会话只读关联、能力记录与完整角色提示（G06）

继续原 #6/#7/#8 的 T22/T26/T27/T44。固定前置为 PR35 当前修复候选 `90a54c251fd800ff15569fac759ef46d1f78fe45`（独立复验中），分支 `feat/w4-session-association`，真实 target `feat/w3-event-reconciliation`。保留 G04 原失败及普通后续修补，不改原分支目标。本片段为后续准确角色投递和写责任交接提供共同前置，不代替 G05 集成候选、G11 组织或 G12 发送消费。

SN01 在原 QueueStore 记录准确工作项、角色、候选/S/r、工具版本、session/thread/已知turn与来源引用。原捕获关联、实际当前元数据和受控执行能力分别记录。关联不接管会话、不授予工具权，也不把别人贴的 JSON 当真实执行认证；保留原字节、哈希、读取覆盖及能力未知原因。

SN02 对明确指定的 Codex 会话提供有界只读读取，固定本机实际可执行文件/版本/协议，保存 initialize 与 thread/read 等真实请求/响应。默认不列举无关会话，不 resume/steer/interrupt、不发模型 turn，不读取或迁移认证。读取失败保留原 ID 与 unknown，不新建替身。当前执行器明确使用 ephemeral 会话；退出后的历史原件不冒充可继续的活会话。新进程观察到 idle 也不能证明其他执行者已结束写入。控制能力必须有准确执行实例和实际能力证明，再由后续消费者核授权/占用；本阶段不会仅凭版本或 schema 开放控制。

SN03 统一角色提示装配清单：公共 runtime_contract、一个准确角色、该角色适用的固定上游完整原文、本轮可信输入各自有身份/来源/hash。沿用 coding-workflow 固定提交 `1772cd2c25bfc42b7a89cf38b35bf19d3dc22000`，不追随 main；正式审核包含完整 pr_review_system，Issue 负责人包含完整 issue_agent，审核/核实循环包含完整 development_workflow/README。缺必须材料、错误角色、错误固定版本或 hash 不符时在新模型发送前拒绝，不能用摘要替代。秘书只装配公共边界和秘书角色；报告正文仍只是数据。

SN04 对已有 relay、repair、receiver、secretary 等入口逐个接入组成记录和实际发送绑定，保留已结束原运行及恢复所需的旧冻结输入。新增执行必须使用新的完整装配；不重写历史日志来迎合新校验。完整上游提示是语义输入，实际工具边界仍由原生执行器和后台共同落实，不以 prompt 自律代替。

SN05 验证真实原始捕获关联、准确/错误会话、旧会话不可继续、缺能力、缺必须上游、角色混用、原件损坏、重复关联和跨进程竞争；使用明确测试实例做安全协议反例。若现有环境可用，做一次无模型调用的真实精确元数据读取；不为故障样例消耗真实模型额度。独立审核完成后发布 Draft，原件留本机。后续受控会话续接、准确消息送达/处理/消费与完整用户旅程仍按原范围继续，不把只读关联标成控制闭环。

## 已实现入口与实际边界

`node dist/src/session-cli.js associate --store /绝对/queue --request 稳定请求ID --input /绝对/plan.json` 在原 events/blobs 中登记只读关联，保存读取意图后启动一个只负责元数据的子进程。plan 为 schemaVersion=1、kind=tongxu-session-association、item、role、source；source 使用 tongxu-exact-codex-session-read，固定 executable/executableSha256、threadId、sessionId、workspace、disabledMcpServers 与 executionKind。它没有模型轮次、接管或变更权限选项。

`status --store ... --request ...` 读取原状态。`reconcile --store ... --request ...` 只消费已经结束的完整原读取：检查准确命令、请求序列、响应、退出与哈希，保留原观察时间，不重启程序。已开始或未知的同一请求不会因重入另读一次；不同 request 内容不能复用同一个 ID。原程序已经删除也可读取完整原捕获；缺失/损坏的原件仍是未知，恢复准确原件后才可继续。跨进程控制器锁和登记都在原队列目录内，没有新的任务队列。

`link --store ... --request ... --input ...` 的 plan 为 `{item, role, format, directory}`。format 限于 codex-readonly、codex-controlled、claude-readonly；通过原验证器核已有最终原文和准确 native ID。source 的完整原字节及小型引用索引留在同一队列，源目录不写。捕获角色已知且不符时拒绝；没有角色信息的原捕获保留“操作者关联、行为未验证”。代码修复前后或其他历史参考可只读关联，但 `capturedCandidateMatches=false` 明确不代表本任务当前结果。最终报告存在不证明仍有活会话，归档验证也不认证外部日志的生产者，控制/写责任始终另核。

元数据读取得到的 `reportedStatus` 只属于那次读取。`recentMetadataRead` 只说明是否刚读过；`currentNativeStateVerified`、`writerOwnershipVerified` 与 `controlPermissionGranted` 不会因此变为 true。代码不提供 resume、steer、interrupt、发送消息或写代码入口；这些要与后续准确执行实例、权限、组织和原操作一起实现。

## 完整角色装配

`role-prompts.ts` 按固定角色加载完整公共边界、唯一角色、规定的完整上游原文和操作者提供的补充政策。上游三份原文已按固定 Git blob 与 SHA-256 校验，随程序保存；实际调用前无需联网下载。输入清单记录各部分内容、来源、字节数和哈希，最终 system 按同一份内容装配。上游缺失/改写或超过输入上限直接拒绝，不截断或以摘要替换。

relay、repair、receiver、secretary 和整体复盘入口都记录并使用实际装配。Codex 的 thread/start baseInstructions、Claude 的 system-prompt、原生捕获和固定输入哈希保持对应。原有配置提供的补充政策作为 task_policy 单独登记，不替代公共、角色或必需上游。它来自可信运行器配置，不能从报告或模型工具参数拼成新权限。角色提示不授予工具权；原有只读/受控工具、停止和写责任检查仍适用。

旧已完成 relay/repair/receiver 的冻结输入和原捕获继续按旧契约核对，不重写原件或再启动原生程序。无组成清单的旧未完成运行只能先核原捕获；若确实需要新的模型阶段，入口拒绝使用无法证明完整的旧短提示。它不会换目录、改原结果或自动重发未知任务来绕过这个限制。其他角色和统一派发后的受控接续仍由后续工作补齐。

## 已取得证据与未取得事项

当前定向证据包括：实际 CLI 跨进程一次登记、精确会话错误与捕获中断恢复；已有完整 Claude 接收原文和 Codex 两轮原文的只读再消费；旧版本真正产生的 relay、repair、receiver 完成记录在新版本中恢复，进程 trace 没有新增行；完整上游缺失/被摘要替换时，打包副本的接收入口零模型调用，恢复准确原文后沿同一本地 operation 继续。正向新模型消息是明确替身，不能与历史真实捕获相加冒充新真实执行。

本机官方 0.163.0-alpha.10.2 的元数据探针实际请求一个已结束的本项目临时会话，返回 `thread not loaded`。最终读取器仅发送 initialize、initialized 和 thread/read，不导出全局配置。早期包含 config/read 的准确旧捕获仍可按其原契约回放；两次原错误、完整请求和退出都保留，没有创建替身或发送模型轮次。历史真实捕获可读取，不意味着原临时会话可以恢复。

官方接口参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。实现同时核本机实际版本/schema；文档中的可用接口不被当作本机已试验的控制能力。完整 W4、G2/G3、双任务派发和全部 52 场景没有因本片段通过而自动完成。
