# W5 首条真实只读链：2026-10-19

## 固定对象与依赖

链路审核对象为 PR #16，H `e42f257bbf6d1abb0fba8a431c4d915f6ddfcfb1`，B `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`，target `feat/w1-readonly-cli`。只核双版本适配涉及的结果识别、错误保留及交接边界，不重新审核四个 PR。

W5 实现独立分支 `feat/w5-local-relay` 从 e42f257 开始，真实 target 为 `feat/w4-native-inspection`。#14/#15 不因此包含于本分支。PR #16 仍 Draft，无合并/批准行为。

## 实际观察

1. 先由真实 Claude Code 2.1.233 在独立上下文核对固定增量。可用工具为 Read/Glob/Grep，越界读请求实际被拒绝；完整最终报告已保存。没有确认当前增量 P0/P1，非阻断建议和报告局限单独保留。
2. 一个 relay 命令启动官方 Codex 0.163.0-alpha.10.2，同根会话的两个不同 turn 分别审核源码和核对反例。两份最终报告来自实际 `final_answer` 与完成事件，未手写或修改日志。
3. 原捕获通过既有 import/handoff。程序随后启动独立 Claude，以 stdin 发送固定源码与两个完整报告；实际工具/MCP 为空，完整最终结果与 init 会话匹配，报告引用了准确来源 turn。
4. 程序再启动新的 Codex `verifier_fact` 上下文，自动交付同一材料、审核和影响报告。最终综合指出 Claude 对失败残留等描述过宽，核实后未确认需修复的 P0/P1，不制造空修复。
5. 两个 Codex 阶段的实际 completed item 只有 userMessage、reasoning、agentMessage，没有工具调用。原生线程/turn 为 readOnly、networkAccess=false、never；禁用能力与 MCP 的有效配置留存。普通用量获准，Claude Usage credits 为 off；未新增认证、API 计费、额外用量或额度。客户端 cost estimate 不作为实际扣费证明。

私有运行目录标识为 `w5-live-20261019T050102Z/chain-02`。本仓库只发布摘要与 hash，不发布私人账号、会话原始元数据、用户名路径或完整私人材料。

| 原始文件 | SHA256 |
|---|---|
| codex-review/stdout.ndjson | `21e4f50ad0350eb89b53815fc488630d2ddcb45b4421ce3c1198608ec21d092c` |
| claude-impact/stdout.ndjson | `000a67abf13a57a07f8fe652b3be3db4e00b60d102d4a99c739f9281f0152aaf` |
| codex-synthesis/stdout.ndjson | `b3d32d473d6f672203a6be23fd51151a4e07f5a194dc6a820c75e979e0cd9be4` |

哈希用于定位和核完整性，不证明内容正确、来源可信或用户验收。原始证据另含完整 stdin、CLI 入口/hash、原生配置/权限、退出状态和输入摘要。执行时的 TS/JS 原件已固定到 `chain-02-executor/`；后续增强恢复核对的源码不冒称参与了最初启动。

## 恢复与故障验证

最终源码对同一真实 operation 再次运行，三个模型阶段的全部文件 hash 和修改时间均未改变，没有新增模型请求。原件重算后恢复同一最终综合。私人记录为 `real-recovery-01.json`。

在**真实原日志的副本**上人为截断，结果 unknown 且不能 handoff；严格追加完整原字节，再 replay，恢复同一 capture 和两轮最终全文。此故障明确标为模拟，不声称真实模型曾中断，也不再次调用模型。

本机 Node 24、规范 TMPDIR 下，首轮现有双版本适配 25 项与新增 W5 5 项测试共 30/30；首次修复为 33/33，旧格式恢复追加请求的再修复为 34/34（W4 25 + W5 9），0 fail/skip。W5 合成进程测试覆盖重复入口零新调用、丢失派生文件重建、被改 handoff/checkpoint 拒绝、部分输出、错误会话/版本、非最终 phase、致命错误、等待/额度不足、未知启动、单写锁及 UTF-8 分块。夹具不作为真实执行证明。

前置启动曾因额外加载必要用户政策而停在 turn/start 之前，原失败保留；明确固定该政策路径/hash 后才开始上述真实链。未把前置失败删除或改写成成功。

## 独立复核与修复记录

新鲜独立 Codex 针对首个 W5 候选 `ffc16dc9b6b122c22fe16cac44ca497004a25ee9` 给出 REWORK_REQUIRED，复现三个 P1：

- Claude 2.1.233 可以同时输出 `subtype=success` 和中断终止原因；旧代码只检查前者，会交给综合角色。统一最终校验现在要求 completed/end_turn、无 aborted/子消息/API 错误。真实原报告具有 completed/end_turn，本次成功链不受反例影响。
- Codex 原流包含完整 final，但 stderr 超限后正常退出 0；首次被拒绝，内存中的捕获失败在重启后丢失，旧恢复路径会继续启动下游。现在立即持久记录失败，并在恢复时先核捕获状态与三个流的 hash；同一反例重复入口不产生下游模型输入。
- 只改保存的 Codex stdin，追加输入、修改每轮隔离权限或线程 developerInstructions，旧恢复仍可认为是同一固定输入。现在核 stdin 全流摘要，并严格核整个 thread/start、turn/start 请求形状、完整输入与权限。

同时核 run 归属。修复提交为 `99beb6c158f34527d358ed6936ba0992cb90f492`；没有改变模型输入/角色政策、原始输出、parser 真实性字段或 W4 源码。首轮报告 SHA256 为 `15b45566bc5ba2182aedf526f7ae376c243f7728b35fce0ef58c785c4247ef2f`。首轮报告与反例、作者修复和再审核分开保存，不以新 PASS 覆盖原失败。

再审确认前两项及新格式完整输入检查闭合，但 R3 在旧格式兼容分支仍能忽略额外插入的 `turn/steer`。第二次修复对完整 stdin 的请求集合、顺序、ID 及已核参数进行严格比较，任何额外请求都拒绝；正常旧格式仍可恢复。该反例与第二份 REWORK_REQUIRED 保留，不能写成首次修复已全部通过。

修复后的代码已重新消费同一真实原结果；模型阶段原件保持不变。最初原生启动使用的是已保存执行快照，最终修复以真实原件恢复及明确故障夹具验证，没有声称重新执行了一次付费模型链。

## 当前能力边界

首条只读链完成了发送、接收、处理、回传和事实综合；人工复制报告为零。自然语言综合只覆盖输入材料中的 W4 候选，不是 W5 执行代码的独立审核报告；W5 代码另行提交独立复核。

未完成自动修复/写权接续、部分原生会话自动恢复、强杀后锁所有权转移、完整 W5/G2、正式接收或生产合并。失败时优先保留 unknown，不能为展示恢复而重发付费任务。W2 Linux/bubblewrap、原 PR 依赖及原始包保持原安排。
