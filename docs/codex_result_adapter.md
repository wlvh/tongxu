# Codex 原结果离线适配

这是 PR #16 在 #6/#7 已发布接续条款内的新增能力：读取已经保存的 Codex App Server 原 stdout，识别指定角色的结果，保存可恢复的私有证据，并准备下一位 `verifier_impact` 的输入。它不会启动执行器、发送消息、使用认证、运行仓库业务代码或合并 PR。原 `native-cli inspect` 的 Linux/bubblewrap 隔离策略保持原样。

协议依据是已有 **codex-cli 0.159.2** 和本机 **0.163.0-alpha.10.2** 二进制生成的 JSON Schema。[原版本来源索引](protocol/codex_0.159.2_source_index.json)与[本机版本来源索引](protocol/codex_0.163.0-alpha.10.2_source_index.json)固定二进制、文件与哈希；完整原 schema 保留在私有证据中。只支持这两个精确版本，binding 声明的协议必须与原通知中的 `cliVersion` 相符。当前只实现明确的通知子集，不是全部协议验证器；其他版本须先留存真实 version/help/schema 并核对差异，不改原始版本字符串来绕过检查。

两版六种通知的参数入口、根会话身份与 `agentMessage` 字段结构相同，但 0.163 的消息阶段新增了 `partial_answer`：它表示可能继续输出的部分回答，仍不能作为最终结果。新 `Turn.rootTurnId` 为可空的原始轮次来源，解析器保留已观察值并拒绝开始／结束间互相矛盾或类型错误的值；不凭这个字段推导 session、子代理身份或批准。新版错误类型允许未来的字符串／对象，原错误照实保留，仍由失败／等待／重试事件和明确的终态决定结果。这些兼容行为不放宽原来的准确 thread/turn、明确 `final_answer` 和终态一致性要求。

## 输入与识别

`binding.json` 是操作者声明，不是签署、执行器认证或权限证明。必需字段如下；具体值必须从该次原运行和正式任务取得，不能临时编一个 ID 来填空：

| 字段 | 来源与约束 |
|---|---|
| schemaVersion / protocol | `1` / `codex-app-server/0.159.2` 或 `codex-app-server/0.163.0-alpha.10.2`；必须对应实际捕获版本 |
| sourceKind / role | `fixture` 或 `native_capture`；`reviewer`、`verifier_fact` 或仅负向回放用的 `protocol_probe` |
| run / sessionId / threadId | 原运行、session 和准确根 thread；接受 schema 的 cli/vscode/exec/appServer 来源，拒绝 subAgent/unknown/custom 和非空 parent/fork；实际 App Server 元数据的来源是 vscode，来源枚举不是传输类型 |
| turnIds | 原始通知中的有序 turn ID，最多 8 个；通常登记这次小任务的两轮。只有元数据探针可空 |
| workspace | 原 `cwd`，绝对规范路径；可以与离线读取的电脑不同 |
| scopeSource / arrangementSource | 本轮有效范围、角色组织与停止条件的可核出处 |
| inputManifestSha256 / promptSha256 | 本轮输入清单及完整装配提示的 SHA-256；离线适配器只保存声明，不能证明执行器实际消费了它们 |
| candidate | `repository`、`pr`、固定 40 位 `H/B` 和真实 `target` |

只有同一绑定根 thread 的指定 turn 依次 `turn/started`，观察到 `item/completed` 的 `agentMessage.phase=final_answer`，且 `turn/completed.status=completed` 无矛盾，才有 `final_observed`。终态携带的最终 item 必须与流中原件一致；`itemsView=full` 时不能缺失。两轮各保留全文，不挑最后一条“看起来像 PASS”的文字。

其它 thread、RPC 回复、commentary/null/缺失 phase 均不能充当最终结果。根 thread 出现未登记 turn、版本/会话/工作区不符、错误在终态后出现、矛盾重复帧、多个最终 item、等待、失败、中断、坏 JSON/UTF-8 和残帧都会阻止交接。完全相同的重复帧可重放。输出保留错误和配额信息；`willRetry=true` 的原错误若随后正常完成，保留该错误而不擅自重试。

## 命令

需要 Node >=24；从核验过的源码安装锁定开发依赖并编译：

```bash
npm install --ignore-scripts --package-lock=false
npm run build
```

以下路径是模板，替换为本机现有的绝对规范路径。输入不能是符号链接，输出必须是仓库外、当前用户持有的全新私有目录。命令不会覆盖已有输出。

```bash
node dist/src/codex-result-cli.js import --binding /private/binding.json --input /private/codex.stdout.ndjson --output /private/result-01
node dist/src/codex-result-cli.js append --packet /private/result-01 --input /private/codex.stdout.extended.ndjson --output /private/result-02
node dist/src/codex-result-cli.js replay --packet /private/result-02 --output /private/result-03
node dist/src/codex-result-cli.js handoff --packet /private/result-03 --output /private/impact-input-01
```

`import/append/replay` 返回 0 表示离线观察到最终消息，2 表示仍有缺口/等待/失败/中断，1 表示输入或存储错误。退出 0 不解释报告结论，不表示审核 PASS、真实模型验收或有权行动。`handoff` 仅允许 reviewer 的完整结果；它重新校验 checkpoint 和原字节、重新解析，忽略可编辑的 `result.json`。产物含原 stdout、原 binding、两轮最终全文及哈希，`delivery=not_sent`。下一角色不必手工复制长报告，但**尚未由程序启动或送达下一执行器**。

输出始终注明 `realModelExecutionVerified=false`、`toolRestrictionsVerified=false`（解析结果）、`productionActionAllowed=false`；`native_capture` 也是来源声明而不是认证证明。来源文字仅作证据，不能覆盖下一角色的权限或完整提示。

## 中断与恢复

先写 `binding.json`、`raw.ndjson`、`capture.json`，再导出 `result.json`。checkpoint 完整时，丢失派生结果或进程被杀可用 `replay` 在新目录重建，保持原 capture/run 身份和前次 checkpoint 哈希。若中断早于完整 checkpoint，不猜补文件；保留现场，从原输入另建一次 import，注明旧残包，不能宣称同一完整 checkpoint 已恢复。本实现不承诺掉电后的 fsync 持久性。

`append` 接受完整的新日志文件，必须严格以旧原字节为前缀且更长；会话、候选和 binding 保持不变。日志截断、轮转或修改不能冒充原采集续接。新候选用全新 import/输出目录，不覆盖旧证据。所有恢复均为本地读写，没有模型重发或业务副作用。输入总量上限 16 MiB、单帧 1 MiB；超限不当作完整结果。

Mac 离线入口已在 macOS 27.0.1 / Node 24.19.0 验证：固定 `d93d791` 原套件 12/12；本机版本兼容候选把同一组场景按两个精确协议复用，并检查新版轮次来源与开放错误值，共 25/25。它们都是离线夹具及实际 Node CLI 测试，不是真实模型两轮结果。`native-cli inspect` 和 W2 的实际隔离执行仍依赖 Linux/bubblewrap，不能为了 Mac 使用而关掉隔离。实际环境分工与本机前置见 [接续说明](local_codex_handoff.md)。
