# W4 无模型调用的原生隔离自检验证

真实 base/target 为 `feat/w1-readonly-cli` @ `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`；main 参照 `1ba5ae893b49e5856a4e8d682139f70e5c907f5f`。相对 main 额外只有 W1 三个未合提交；本子版独立于 W2/W3 代码，没有继续堆叠待审 W3。#6 自足条款已发布并逐字读回 `2026-10-18T16:30:48Z`。首审发现版本留证缺陷并修补后，独立复审 `TX-W4-NATIVE-REVIEW-20261018-02` 为技术范围 PASS，具体对象与证据见文末；Claude 影响核实由用户本机执行并单独记录。

## 实际软件 smoke

2026-10-18 16:54:23.991Z–16:54:26.273Z，初版候选 `664730b` 的 `native-cli.js inspect` 驱动本机已有 **codex-cli 0.159.2**，不是复用临时探针。Node 24.19.0、Linux x86_64、bubblewrap 0.12.0。原生二进制 SHA-256 `1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`，前后相同。

运行 ID `7ebb0110-ed1d-49da-a276-765b96a79a66`，报告 SHA-256 `6fd0cfb6528b40c4e5549bbdd920a884c3264303c34008cb3ab77f7e2cc31767`。真实请求：initialize、ephemeral thread/start、精确 thread/read、错误 expectedTurnId steer、再次精确 thread/read。原生明确回复 `no active turn to steer`，随后元数据仍报告 idle。read-only/networkAccess=false、approvalPolicy=never、工作区绑定均读回匹配；无 `turn/start`、无模型输出。退出 0，gaps 为空，仅 isolatedMetadata=observed；model/auth/cost/Claude/secretary/production 能力限制均保留。

原生 App Server 由本 CLI 新建，stdin 关闭后未自行结束，记录本地自有进程 SIGTERM；没有将这个信号称为外部模型/生产任务已停止。stdin/stdout/stderr、版本原输出、事件和逐项 hash 私下保存，原生 stderr 为 0 字节。没有连接宿主认证、现有会话或业务目录，没有新增费用、调用 SEC_metrics 或任何远端写入。

此前临时协议探查首次失败于 home 查找；引入私有 passwd 后，`includeTurns=true` 又收到 ephemeral 不支持历史的真实错误。保留这两次失败，最终只读取受支持元数据，未以探针通过替代本软件 smoke。read-only sandbox 不证明秘书无 shell，因此控制模式始终 disabled。

## 测试与限制

初版 `npm run test:native` **14/14**，W1 回归 **27/27**，0 跳过；修补后的 17 项及独立复审见后文。真实子进程协议夹具覆盖碎片/乱序/重复晚到/错 ID/错误类型/坏 JSON/含 result 与 error 的矛盾回复/断连/超时/输出上限；意外工具/批准请求被明确拒绝，未注册 turn/start 不发送。生产 CLI 夹具检验精确参数、宿主假凭据和私有文件不可见、宿主回环监听不可达、私有权限、所有原件 hash、摘要不含会话/路径。

真实 SIGKILL 中断生产 CLI 后，原运行/请求仍持久为 running/sent_or_unknown，重复输出目录被拒绝且原字节不变。原生断连保存 unknown；仅错误码 -32600 而原因不符不会假报负向测试成功。测试初版的并发前置断言误把“本请求尚未发送”写成“任何请求都未发送”，已改为按请求 ID 核查并重新执行全套，未改变客户端来迎合错误断言。

夹具原生标记 `0.0.0-fixture`，不能代表 Claude 或真实模型运行。未测试模型两轮、最终模型结果、实际认证/额度、真实 Claude、生产写责任/身份、发布/合并、macOS/Windows或其他原生版本。完整 W4/G2 的相关验收保持待验证。用户本机交接见 `docs/local_claude_verification.md`；有前置的后续阶段只细化真实可做部分。

## 独立审核及修复

新独立上下文对 H `664730b9d94d71f14c6f226d3a40d50a0750706f`、原 B/target 判断 `TX-W4-NATIVE-REVIEW-20261018-01 = REWORK_REQUIRED`。其独立 27/27、14/14 和真实原生 smoke 均通过，但确认一个 P1：版本查询用内存缓冲，父 CLI 在版本阶段被 SIGKILL，已输出并 flush 的原 stdout/stderr 全丢。报告 SHA-256 `07eb5c67651d41471ed1e60576a7d2904484c2970a988a0a4224c6df709ebf26`。真实成功 smoke 不抵销留证缺陷。

负责人用同一独立探针在新私有目录复跑旧/修补实现。旧实现确实只剩运行报告/私有 passwd；修补后版本原 stdout/stderr 均保留，状态仍 running/unknown。前后探针摘要 SHA-256 分别为 `0db6b2fc62e25ad3ce829a6ffb6086e2176d50aff2e829a2f499d53b4000ef00` / `0295a01c90c5a81ab2f676318ac2054c2670de47e64469aa77bb4161525c6d1b`。

已改为先创建私有版本原件文件、收到输出即有界落盘，再解析版本；保存版本进程原 ID、退出和缺口，超时/上限不覆写原字节。同时核实际 schema/原输出后，确认 thread 的有效 ephemeral 字段；非零原生退出及末尾不完整帧记录为局部缺口，未把它们说成此前已确认的 P1 或模型结果无效。独立探针这三项现为 partial，真实 app-server 中断仍保留原请求。

修补后 `npm run test:native` **17/17**，新增版本中断、上限/失败、有效 ephemeral、尾帧和非零退出覆盖；W1 代码未变，其 27 项先前回归适用。最终软件于 **17:07:52.714Z–17:07:54.943Z** 再运行真实 codex-cli 0.159.2，原 binary hash 不变；版本 exit 0、五请求与拒绝 steer/再次 idle 匹配、status complete，原生 stderr 仍空。运行 ID `dd990117-95fa-4b64-b3fa-af03d125e3dc`，报告 SHA-256 `d90034e8d5f956fd2a6861a07c053cfd36275a614d40927237b722a55aea269d`。该次复跑后已提交新鲜独立复审，结论见下节；原失败报告/现场保留，仍无模型、Claude、认证/费用或生产动作。

## 最终独立技术复审

新鲜独立上下文对 H `8b5122d8d4fe907bd2d0131a701ca846e456b27a`、原 B/target 判断 **PASS（仅技术范围）**，判断 ID `TX-W4-NATIVE-REVIEW-20261018-02`，无开放 P0/P1。报告 SHA-256 `ee36477a59b9e399e3ba7bc4195cf8e396fe58afdfc66cd3b900c613addda7f0`；索引 `cfa4938ca981098cb5f64df3b969c3a83e9cf8eed150094cfb775cb0d0d1f397`。本追加只记原证据和后续前置，不改变受测代码。

独立 archive 的 W1 27/27、native 17/17 均通过。自写故障探针确认版本输出 SIGKILL 后完整保留，实际默认 15 秒超时和 128 KiB 上限保留原字节；ephemeral 矛盾、非零退出、残帧均留下缺口，成功/失败/中断目录均拒绝覆写。实际 Codex0.159.2 软件入口独立通过，五个请求与原始响应准确匹配，错误 steer 被拒绝且再次 idle；独立实际报告 SHA-256 `6032ff4bf106e9e44197d21cfbfec9c7631242f827d99307e32fba7dcf6f86ac`。没有用作者的成功报告复制 PASS。

完整 W4/G2、Claude 影响核实、模型两轮/最终结果身份、有效角色工具限制和生产权限继续待验证；无合并/自批/认证迁移或新增费用。实际接续材料见 [W5 前置记录](../docs/baselines/W5_ENTRY_BRIDGE_2026-10-18.md)，不把元数据自检当作 W5 自动链的完整前置。
