# W4 无模型调用的原生隔离自检验证

真实 base/target 为 `feat/w1-readonly-cli` @ `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`；main 参照 `1ba5ae893b49e5856a4e8d682139f70e5c907f5f`。相对 main 额外只有 W1 三个未合提交；本子版独立于 W2/W3 代码，没有继续堆叠待审 W3。#6 自足条款已发布并逐字读回 `2026-10-18T16:30:48Z`。独立技术审核待执行，Claude 影响核实由用户本机执行并单独记录。

## 实际软件 smoke

2026-10-18 16:54:23.991Z–16:54:26.273Z，最终 `native-cli.js inspect` 驱动本机已有 **codex-cli 0.159.2**，不是复用临时探针。Node 24.19.0、Linux x86_64、bubblewrap 0.12.0。原生二进制 SHA-256 `1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`，前后相同。

运行 ID `7ebb0110-ed1d-49da-a276-765b96a79a66`，报告 SHA-256 `6fd0cfb6528b40c4e5549bbdd920a884c3264303c34008cb3ab77f7e2cc31767`。真实请求：initialize、ephemeral thread/start、精确 thread/read、错误 expectedTurnId steer、再次精确 thread/read。原生明确回复 `no active turn to steer`，随后元数据仍报告 idle。read-only/networkAccess=false、approvalPolicy=never、工作区绑定均读回匹配；无 `turn/start`、无模型输出。退出 0，gaps 为空，仅 isolatedMetadata=observed；model/auth/cost/Claude/secretary/production 能力限制均保留。

原生 App Server 由本 CLI 新建，stdin 关闭后未自行结束，记录本地自有进程 SIGTERM；没有将这个信号称为外部模型/生产任务已停止。stdin/stdout/stderr、版本原输出、事件和逐项 hash 私下保存，原生 stderr 为 0 字节。没有连接宿主认证、现有会话或业务目录，没有新增费用、调用 SEC_metrics 或任何远端写入。

此前临时协议探查首次失败于 home 查找；引入私有 passwd 后，`includeTurns=true` 又收到 ephemeral 不支持历史的真实错误。保留这两次失败，最终只读取受支持元数据，未以探针通过替代本软件 smoke。read-only sandbox 不证明秘书无 shell，因此控制模式始终 disabled。

## 测试与限制

`npm run test:native` **14/14**，W1 回归 **27/27**，0 跳过。真实子进程协议夹具覆盖碎片/乱序/重复晚到/错 ID/错误类型/坏 JSON/含 result 与 error 的矛盾回复/断连/超时/输出上限；意外工具/批准请求被明确拒绝，未注册 turn/start 不发送。生产 CLI 夹具检验精确参数、宿主假凭据和私有文件不可见、宿主回环监听不可达、私有权限、所有原件 hash、摘要不含会话/路径。

真实 SIGKILL 中断生产 CLI 后，原运行/请求仍持久为 running/sent_or_unknown，重复输出目录被拒绝且原字节不变。原生断连保存 unknown；仅错误码 -32600 而原因不符不会假报负向测试成功。测试初版的并发前置断言误把“本请求尚未发送”写成“任何请求都未发送”，已改为按请求 ID 核查并重新执行全套，未改变客户端来迎合错误断言。

夹具原生标记 `0.0.0-fixture`，不能代表 Claude 或真实模型运行。未测试模型两轮、最终模型结果、实际认证/额度、真实 Claude、生产写责任/身份、发布/合并、macOS/Windows或其他原生版本。完整 W4/G2 的相关验收保持待验证。用户本机交接见 `docs/local_claude_verification.md`；有前置的后续阶段只细化真实可做部分。
