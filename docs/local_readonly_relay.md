# 本机只读审核链

本入口把固定材料送给两轮 Codex 审核，再自动送给 Claude 做影响核实，最后交给新的 Codex `verifier_fact` 会话核对事实并综合。用户运行一次入口；中间报告由程序传递，不需要复制粘贴。

这是一条有界、串行、只读的 W5 子链。它不接管生产会话，不自动修改源文件，不代替正式审核、写权移交、接收执行、合并批准或完整 G2。真实运行记录见 [验证说明](../verification/W5_READONLY_RELAY.md)。

## 使用已有入口

要求 Node 24；已有官方 Codex `0.163.0-alpha.10.2` 和 Claude Code `2.1.233`。精确版本不符会拒绝，不能改版本字符串代替适配。构建后执行：

```sh
node dist/src/relay-cli.js run --plan /absolute/private/plan.json --output /absolute/private/operation
```

同一条命令、同一个 output 表示继续同一 operation。不要换一个输出目录来重试结果未知的任务：新目录表示新任务，可能再次消耗额度。

`RelayPlan` 的完整类型在 `src/relay.ts`。它是负责人固定的可信配置，不由模型报告生成。主要输入如下。

| 字段 | 必须说明的事实 |
|---|---|
| candidate | repository、PR、准确 H、B、真实 target |
| scopeSource / arrangementSource | 本人采用范围和本轮分工的可信来源 |
| codexExecutable / claudeExecutable | 已安装程序的绝对路径；不使用 PATH 猜版本 |
| material | 至多 30 个规范绝对路径及 SHA256，正文合计至多 1 MiB |
| prompts | reviewer、verifierImpact、verifierFact 三份完整单角色提示文件，分别加载公共边界和固定上游政策 |
| reviewInputs | 两个有意义的审核、补查输入；第二轮沿用同一线程的固定材料 |
| disabledMcpServers | 现有配置中须禁用的 MCP 名称；启动后核有效配置，出现未禁用的服务器即停止 |
| allowedInstructionSources | 允许保留的必要政策文件及 SHA256；原生线程额外加载未知政策时停止 |
| billing | existing_subscription_only、已核用量证据路径/hash/时间、usageCreditsEnabled=false；新阶段前证据不得超过 24 小时 |
| timeoutMs | 每轮有界等待，1000 至 900000 毫秒；不是后台无限循环 |
| executionKind | 正常为 native_capture；测试必须标为 fixture，不能当真实模型证据 |

材料、提示和用量文件保存在私人目录，使用规范路径（macOS `/tmp` 等别名需先解析实际路径）。程序固定输入副本及摘要；恢复时输入变化会拒绝。凭据由原官方 CLI 使用，不复制到 plan 或证据包。

## 实际权限和结果边界

Codex 使用已有 ChatGPT 认证；每个 turn 前检查普通用量可用。启动参数关闭 shell、浏览器、插件、MCP、自动记忆、子代理等能力，并核对有效配置。新线程和每个 turn 明确指定只读、禁止网络、never 审批。全局配置可能有不同默认值；判断依据是本线程返回的权限及实际 turn 请求。任何服务器批准/外部工具请求均拒绝。

Claude 使用已有 claude.ai Max 认证，无 API key/token/base URL 覆盖。传入 `--safe-mode --tools '' --permission-mode dontAsk`，严格空 MCP、无 Chrome、无会话持久化。所有所需正文通过 stdin 传入；实际 init 的工具/MCP 必须为空，版本、身份、权限和最终 result 必须匹配。`success` 本身不够，必须同时是 `terminal_reason=completed`、`stop_reason=end_turn`，没有 aborted 消息或 API 错误。这里是原生工具能力限制，不宣称为 Linux/bubblewrap 的替代隔离。

程序分别保存 CLI 版本/入口 hash、启动参数、输入、原始 stdout/stderr、退出状态、原生会话/turn、权限响应及最终收据。stdout 按原字节保存，再解释 JSON。单条模型报告不能选择下一条命令、角色、权限或输入范围。

离线适配器的 `realModelExecutionVerified` 和 `toolRestrictionsVerified` 保持 false。执行记录在外层，不能用修改两个字段冒充来源认证。`handoff/input.json` 仍描述“准备好的未发送输入”；真实投递记录在 `delivery.json`，包括输入摘要、来源 capture、接收会话和最终报告摘要。

## 查看结果和恢复

| 文件 | 用途 |
|---|---|
| status.json | 当前阶段、waiting 或 blocked_or_unknown、具体原因 |
| operation.json / inputs.json | 原操作与固定输入，不以派生 PASS 授权 |
| codex-review/ | 原根会话的两个真实输入、turn 和最终回答 |
| packet/ / handoff/ | 原捕获的 import、检查点、全文交接输入 |
| claude-impact/ / delivery.json | 实际发送、匹配会话的完整影响报告与关联 |
| codex-synthesis/ / result.json | 新的事实核实会话和完整综合原文 |

重复入口先重读原 stdout、stderr、stdin、身份、整个请求/权限和终态；校验 packet 检查点和完整 handoff，不重新请求已完成模型。捕获异常立即写入 `capture-failure.json`，进程结束时记录 `capture-status.json` 与三个流的摘要；超限/拒绝等失败不会因重新启动而遗忘。缺少派生收据/交接文件但原件完整时可以重建；已有文件内容变化会拒绝，不覆盖。没有新捕获状态的旧执行，只能在原完整 completed 收据有效时读取，不能推断丢失收据的旧捕获曾成功。模型 PASS、退出 0、文件存在、实际收到完整结果是不同记录。

部分消息、等待、额度不足、错误版本/会话、矛盾终态不能交给下一角色。已有启动而缺少可验证终态时保存 unknown，绝不自动重发。仍活动的进程不能由第二个入口接管。进程被强杀可能留下 `active.lock`；当前版本不凭时间超时释放锁，也不自动恢复未完成的原生会话。负责人须先核原进程、原日志和是否已执行；无法确认就保留 unknown。这是当前明确缺口，不算完整中断续跑。

本地故障测试使用独立合成执行器，不加载供应商 CLI、凭据或网络：

```sh
npm run test:relay
```

现有 W4 适配测试另行运行 `npm run test:native`。Linux 专用测试仍按其平台条件执行，不以 Mac 子链成功替代。
