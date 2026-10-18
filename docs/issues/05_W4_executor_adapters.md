# W4 原生执行器：依据真实能力逐步接入（#6 自足条款）

现行范围仍为 v2.3 和 [#2 持续开发安排](https://github.com/wlvh/tongxu/issues/2#issuecomment-6251133759)。本轮先交付无模型调用的原生隔离自检软件，完整 W4/G2 保留下述双引擎、两轮与角色边界验收；不把自检命名为已接通秘书或独立接收者。

## 实际基线与 Bridge

W1 Draft PR #13 @ `6c6640eebbcedcf19d8444c4a39c3843b3304cb2` 已有私有证据输出公共模块。W2 Draft PR #14 与 W3 的本地影子接收继续各自审核/交付；W4 这个子版不依赖它们的执行代码。分支 `feat/w4-native-inspection` 直接从固定 W1 建立，真实 base/target 为 `feat/w1-readonly-cli`，相对 main `1ba5ae893b49e5856a4e8d682139f70e5c907f5f` 额外只有 W1 三个提交。前置变动重新核对，不秘密改目标，不继续堆叠尚待审核的 W3。

本主机已有 Codex CLI 0.159.2，未找到 Claude Code。已在断网、无宿主认证/配置的隔离现场运行真实协议：initialize、ephemeral thread/start、精确 thread/read 元数据成功；错误 expectedTurnId 的 steer 被拒绝。首次 includeTurns=true 真实失败（该版本 ephemeral 不支持历史），保留原错误，改用 metadata-only 后通过。没有 turn/start 或模型输出；版本/协议可用不代表已有认证、费用许可或角色工具限制。

| 当前缺口 | 本轮 Delta | 真实验收 |
|---|---|---|
| 只有临时探查，缺可复用的现场记录 | 独立 native inspection CLI，显式现有 Codex 路径、仓库外新私有输出 | 真实 native 版本、初始化和准确 session/workspace 记录 |
| 中断/异常可能被当成功 | 有界 JSON-RPC 原字节、请求 ID/结果绑定，运行前登记、部分失败保留 | 错 ID、坏 JSON、超时、断连、意外原生请求等故障夹具 |
| 只读 sandbox 易被误当无 shell 的秘书 | 能力状态逐项区分实测/未测；没有角色控制或模型启动入口 | 任意批准请求不自动接受，secretary/receiver/model capabilities 均未启用 |

## 自检子版实施范围

命令独立为 `node dist/src/native-cli.js inspect --codex ABS_EXISTING_EXECUTABLE --output ABS_NEW_PRIVATE_DIR`，避免为这一独立包改写 W2/W3 调度入口。输入的可执行文件由操作者明确指定，校验真实绝对路径、普通可执行文件和 hash；不会安装/更新 CLI、登录、读取宿主认证、启动 daemon、连接生产会话或调用任意 URL。

Linux/bubblewrap 创建断网、干净环境、临时 home/workspace，只挂系统运行库与精确原生可执行文件。原生操作只用于临时本地协议自检：初始化；新 ephemeral、read-only、never-approval 会话；按返回 ID 读元数据；负向测试错误活动 turn。没有 turn/start，没有现有会话接管/恢复或后台任务。宿主主目录/配置/凭据与业务工作区不可见；不可限制时保留失败，不降低隔离。

每项能力分别记录请求、回复、原字节 hash、实际版本/二进制 hash、时间、退出/中断和限制。未知/晚到/错误 ID 的回复不能完成另一请求；不使用“最近会话”，不因 steer 失败启动替身。意外审批/工具请求一律拒绝并标缺口，不执行其 shell/URL/指令。过程/最终文件私有，发布摘要只取版本、hash、能力类别和缺口。

输出成功只表示自检范围完成。model/authentication/cost/secretary tool restrictions/Claude receiver/two-turn interaction 等保持未验证或不可用。断连/超时保留原 operation/request 及未知结果；当前只创建过隔离临时会话，可以终止自己启动的本地自检进程，但不以此声称外部任务被取消。重新自检必须用新目录，旧字节不覆写。

## 验证与交付

夹具只验证客户端拒绝异常与保留现场，不能算两引擎接通。真实 smoke 必须运行最终 CLI 驱动实际安装的 Codex；版本 help 或一次原型探针不能替代。记录故障、修复和真实范围，独立隔离审核后提交单独 Draft PR，引用 #2/#6。已有 W1/W2/W3 交付保留，不合并/自批/修改保护或身份，不新增费用与 SEC_metrics 调用。

## 完整 W4/G2 仍保留的范围

秘书默认独立 Codex App Server，接收者独立 Claude Code CLI；已有开发/审核原生会话精确绑定、不共上下文。实测准确 session/turn/workspace、两轮输入、顶层最终结果、等待/失败、批准与核实到授权修复交接。创建能力不能推出暂停/恢复/投递；错误 steer 不新建替身。

按 prompts/README.md 加载公共、单角色、固定完整上游提示与可信输入；记录模型/提示/工具版本及判断 ID。实际有效工具是角色、注册、授权、组织门、停止和原生会话能力的交集。秘书没有任意 shell、业务写入、测试、review/accept/merge 或本人签署；原生无法限制时不开控制模式，不能只靠 prompt。本人入口与 Agent 调用隔离；秘书离线时直接控制继续可用。停止新动作不伪称已终止运行，旧长期现场先关联观察、不抢占或迁移。

认证/订阅/API 费用须有现成明确边界，不自动采购或迁移身份。用户最新明确：本环境继续无需新增认证或费用的开发与验证，需要 Claude Code CLI 的场合由用户在自己电脑进行。相关实跑整理本地命令与证据入口，结果返回前保持待验证；可独立的代码与测试继续。完整运行中跨工具通信留 W6。原验收 T17/T19/T22/T26/T27、T33–T35/T44/T48/T52 保留，离线 JSON/本自检不能改整体 PASS。
