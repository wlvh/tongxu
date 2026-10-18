# W3 本地影子接收验证记录

本子版基于 W2 Draft PR #14 @ `c73c0bf45d40b9560a66baa8186ca4b41d291800`，真实 base/target 为 `feat/w2-isolated-evidence`。相对 main `1ba5ae893b49e5856a4e8d682139f70e5c907f5f` 另含 W1 三个、W2 三个提交；前置均未合并。W2 独立 R2 及 c73 追加适用性复核为 Codex 技术范围 PASS。W3 经三批修复后，独立判断 `W3-INDEPENDENT-TRANSITION-20261018-Hd195b64` 为技术范围 PASS，具体对象和证据见文末。Claude 影响核实仍待用户本机执行。本记录不是作者自批或完整 G1 通过，本环境继续无新增认证/费用的开发验证。

原 #5 自足条款已发布并逐字读回（`2026-10-18T16:13:18Z`），范围是本地影子现场，保留完整 W3/G1 未来要求。没有将未知身份、缺 Claude 接收者或未授权生产交接降格为通过。

## 已执行

Node 24.19.0，内置 SQLite；`npm test` **56/56 通过、0 跳过**（W1 27、W2 17、W3 12）。W3 使用真实 SQLite、真实 CLI 子进程与本地标注夹具：

- 两个 CLI 同时争同 repo/target，只登记一个占用；两席限制独立生效，缺前置不占席位。
- 精确版本前置、循环、未核 merge/enablement；前置原件损坏阻塞依赖者，无关候选仍可评估。
- 三类控制分别停止/恢复，跨进程保留；停止新投入时原操作仍可核查，未声称外部已停。
- begin 登记后真实 SIGKILL，重启保留原 ID 与 unknown 状态；原 evaluate 完成才释放对应代次，旧完成不能清新占用。
- 重复收件、运行编号/时间不重派；新来源、失败结果、运行器变化产生新 packet，旧重放不倒退当前材料。
- 坏 hash 拒收，已存材料损坏保留原操作；伪造 PASS、授权字段、错误候选及业务正确声明不能产生生产能力。
- W2 running/unknown 仅留原 report/stage/tool 引用；不支持 mode=delegated、merge 或其他远端动作入口。

其中 2 项回归是在提交前自查补充：去重须纳入派生缺口、失败摘要与运行器；读取前置须重新核其材料 hash。没有新增模型、业务、费用、权限或 SEC_metrics 调用。没有压测跨千级候选、磁盘写满或整机断电；SQLite 事务覆盖进程退出/并发，不声称完整灾备。

## 同一真实 PR #14 的生产 CLI smoke

使用 W2 已保存、来自实时只读 GET/Git 的配对材料，不生成假报告。它固定 H `792cdfd3dafba7af15bfb058bf5ac75e77e689b1`、B `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`、target `feat/w1-readonly-cli`；不把 PR 后续 c73 冒充本次输入。

| 固定原件 | SHA-256 / ID |
|---|---|
| W1 manifest | `0fa4544a1a32224da06e3b058c57695725d6beb63646863809cefb9fda62e43c` |
| W2 report | `000c91ac0b2e6c8cfdcb8e1add6ee7ac00f59835aa92140e9398076e2eaa8bbe` |
| W2 原运行 | `d6469b55-d87c-45f1-b16d-422b409bfb85`，基线 27/27、候选 44/44 |
| W3 item | `efc558fd5670db09204923079c6ee2ba4c40d045c555f1900b7ba7f45e20ed8c` |
| W3 operation | `ab9bf827-1f5f-423d-a8c7-37f6f3963b4d` |
| 私人 smoke 索引 | `0b68e2f1bfe3ac46f1a0e1d95b5a6f84adbd2a3525de37f64a0fb676056f6aff` |

14 次独立生产 CLI 进程：建库、导入、重启读取，分别停止三类控制；begin 退出 2 且没有占用；只恢复 investment，再 begin、重启查询原 operation、evaluate；重复 add/begin 不产生替身，最后仅一个完成操作且无占用。implementation/merge 仍保持停止，没有被恢复 investment 清除。context 的 #2/#5 来源引用明确是 proposal，不伪造本人签署。

源 W1/W2 目录全部原文件 SHA-256 前后逐项相同；完整 stdout/stderr、库和索引私下保留，未公开原路径/任意材料。评估仍固定 T `1ceafb5a152bbd27758b0bbd6422c936a45573d2`，`evidenceComplete=true` 只说明导入的执行报告/引用完整，**productionActionAllowed=false**、`externalActionSent=false`，缺口：

- independent_receiver_unavailable
- production_authorization_unverified
- pending_publish
- live_candidate_and_rules_not_rechecked

`comparisonComplete=null` 和 businessCorrectness=unverified 保留；没有新增结构化业务样本或独立接收结论。只验证 T07/T18/T19/T37/T39/T41/T45/T48 的本地影子部分，不整体更新产品验收 PASS。

## 下一步与边界

先对固定提交做隔离作者上下文的独立审核，普通缺陷自行修补。完整 W3/G1 仍需独立接收执行器、有效授权/身份源、真实发布能力、唯一生产写责任交接和条件合入回读。后续 W4 先依据真实可用原生接口细化，保留权限交集和真实两轮事件验收；无接口的部分标记待接通，不用模拟 JSON 冒充成功。阶段交付后继续已获准且前置可用的工作，未合并、未自批、未改保护或身份。

## Review / Fix Record

隔离作者上下文的首审判断 `W3-CODEX-INDEPENDENT-20261018-7c338392 = REWORK_REQUIRED（Codex 技术范围）`，绑定 H `7c338392ee938bab5b6193c31e1c1cc2e15d30a9`、上述 B/target。审核者独立运行 56/56、13 次真实配对 CLI smoke、额外并发/原恢复/未知 schema 检查，并核 268 个原文件 hash 未变；仍发现两项 P1，负责人均独立复现：

1. 缺原 stdout/stderr、漏掉计划工具或 stage 树与原 merge 输出矛盾，仍能标证据完整并解除子候选前置。已解析原计划，核齐工具/顺序/argv、必需原输出、阶段输入/parent/HEAD 链及 raw merge T；结构化结果从原 blob 重算样本/比较，与报告核对。保持原报告仅为执行事实报告，不是独立接收。
2. 对所有历史 fingerprint 一律去重，未推进重复观察水位，导致旧成功覆盖新失败；反方向又吞掉真正新的恢复成功。已持久化当前观察水位，只相对当前材料去重；同语义新观察推进水位，旧重放只归档，A→B→新 A 产生新 packet 和新评估。SQLite schema 改为 2，旧开发 schema 1 原库保留并拒绝自动迁移，不静默丢原占用。

首审报告 SHA-256 `992b7cf7af03d07798767c07536ad07ff3b1bd1e4740f0df273beb13bcab1f1e`，证据索引 `9462f2777541ca1710157aa4fc4f2c9c5d8e6eb23310ea3846e1e548abfd1d97`。原失败候选/材料保留，未覆写原 smoke。

修复后 `npm test` **62/62、0 跳过**（新增 6 项针对输出/计划/原树/结构化原件及失败恢复的回归）。审核者的三个真实 PR14 变体全部返回 evidenceComplete=false；重复失败的新水位能阻止旧成功与受影响子项，新的恢复成功可重新评估。原件 hash 完整只说明字节一致，不能证明报告作者真实或业务判断正确。

修复实现另以同一真实 PR14 的配对原件执行 13 次生产 CLI smoke（新 schema 2 库），建库/导入/三类停止/阻塞/只恢复 investment/原 operation 跨进程评估/重复收件均通过。固定 item、H/B/target/T 同前，operation `d48f8678-68ce-4f67-a2e5-cbd92e89c054`，私人索引 SHA-256 `3fa1bdcd4faaeef5526e92cd3b6271e9f9f4c285d18a4d56447ae76a28e5c732`。源 W1/W2 全文件 hash 未变；四项生产/接收缺口和禁止远端动作状态仍保留。修复候选交新的独立上下文复审，Claude 影响核实待执行。

### 第二轮及观察时序根因修复

新独立上下文对 H `6c42b1bf772b4aae787cbea78e26f0c0caabca8e`、原 B/target 判断 `W3-CODEX-INDEPENDENT-20261018-6c42b1bf = REWORK_REQUIRED（Codex 技术范围）`。旧 F1 三种变体、旧 F2 两条序列都实际关闭；62/62、真实 PR14 smoke、真实结构化跨模块验证、恢复和旧 schema 保全通过。尚有一项 P1：采集与执行观察一新一旧时，被错误地整体归旧，新的失败未阻止依赖。

审核者用同 H/B/target/plan 的两次真实 W2 运行复现，报告及样本未编辑：第一轮 ok/ok，第二轮基于较早 W1 包得到 ok/fail；第二轮被归档，旧成功错误解除子项前置。负责人用原始成功/失败包分别运行旧实现和修复实现，确认旧实现实际登记子 operation，修复后 `observationConflict=true`、有效 evidenceComplete=false，子项被明确阻塞。负责人复验索引 SHA-256 `8cdd0b5a9017242c979ab7474c079f8f7d8b28e70484fca8bcd0b92081f84b5f`。

已改为采集/执行两个维度的偏序：一新一旧、缺失顺序、同刻矛盾材料保留待核，各维水位分别更新；状态展示冲突原包，相关前置不能放行。仅同时覆盖两维的新联合观察可解除，且需新评估，不能复制历史成功；原 operation 仍可核查，无关目标继续。SQLite schema 3 保存冲突状态，旧 1/2 库原件保留，不自动迁移。相关 #5 条款已补充并逐字读回（`2026-10-18T16:36:46Z`）。这是按根因修正排序模型，不继续尝试同一单一“任一较旧即归档”策略。

第二轮报告 SHA-256 `8918f5aa6d89ed58a10b5e5db34081f6388a5b59a442a83f0dd623dd11eb8a11`，索引 `d96d7228b63d2884b899c9323a4abb925dd4c4b11fb172f01a25dff6c001a75a`。修复后 **64/64、0 跳过**，新增 9 种时间关系矩阵，以及冲突跨重启、阻塞精确依赖、恢复原操作、无关候选推进、旧包不能解除、新联合材料重新评估的端到端回归。

schema 3 最终实现另以同一真实 PR14 包跑 14 次 CLI：既有正向操作通过，并验证旧 schema 2 被拒绝而数据库 hash 不变。operation `555a842d-d6a7-4d06-963c-1378cd92bd64`，私人索引 SHA-256 `bb0c2767c040c1e1f5c4b47dacee0b881c2c605b33ac5f3143b08c1bf95337ba`；源 W1/W2 原文件 hash 未变。原审核、旧失败现场和旧库均保留。仍只满足本地影子范围，最终独立复审及用户本机 Claude 影响核实保持分别记录。

### 第三轮及冲突解除转换修复

独立判断 `W3-INDEPENDENT-RECONCILIATION-20261018-H0015e39 = REWORK_REQUIRED`，绑定 H `0015e39e1b58ef3e20a7c44e58530295ba1b8214`。旧真实混合时序反例已关闭；64/64、真实 PR14、跨模块验证和旧库保全通过。新增 P1：已有冲突时，只重编码旧成功 context JSON 即能绕过原件去重、清除冲突并放行精确子项。原始 W1/W2、语义指纹、两个水位均未更新。报告 SHA-256 `3e593ad788b3ea4dbe718eab93855f27b2464bf8e3d574d393169435a6a6b318`。

负责人在独立新私有目录重跑反例：旧 H 实际放行子 operation；修复后冲突仍在、证据不完整、子项阻塞。前后证据 SHA-256 分别为 `cd442bdabf800bb687708cc4ff6812dde80e549de5bd1fa491f40c587149e240` / `ab8236594681521ddb4b2a56757a261115ec0c4882136896e8f4be1c58fcf27f`。使用原真实混合包以及明确标注的缺时间/矛盾 context 夹具，不编辑原输入。

修复把冲突作为持续状态：只有两维严格超过已知水位的新联合观察能解除。判定不依赖字节去重是否命中；原件 hash 仍表达原字节，schema 3 不变。新增冲突后的第三次导入矩阵、跨重启的 JSON 格式/报告编号重放、精确子项阻塞和真正新联合观察恢复测试。`npm test` **66/66、0 跳过**。#5 同步严格水位条款并逐字读回（`2026-10-18T16:51:24Z`）。这是第三个实际修复批次；若后续仍需超过三次返工，按现有流程登记网页 GPT 简化反思待办，不无限叠补同类策略。

### 最终独立技术复审

新独立上下文对固定 H `d195b64fb854f50c1cee85c9f6a195fac9eef271`、原 B/target 判断 **PASS（仅 Codex 技术范围）**，无开放 P0/P1。判断 ID `W3-INDEPENDENT-TRANSITION-20261018-Hd195b64`；报告 SHA-256 `9b5676f7ab2bc6dd4e99dfd6fe6a07969e4cf72d3d0730f58a5b3640b9cd5634`，证据索引 `38d3f06194f07eef2fc2dc8dad9ef178707f0e001b75f1b30ec829ee6c8a9bd7`。本提交仅同步该结论和存储限制，不变更受测代码。

独立 archive 66/66；另有 144 次真实 CLI 转换检查，覆盖四种重放、九种顺序、多次单维推进后的累计水位及联合恢复。真实 PR14 配对、材料完整性、并发、原恢复、三类停止及新鲜跨模块 W2→W3 均通过。审核者重新实际观察并运行一次 W2，未改旧材料或择优重试；新采集/执行均超过原水位，该次 ok/ok 正常解除冲突并生成第二代操作。994 个提供原文件 hash 不变。

新增存储观察：schema 1/2 关闭完整样例原字节未变；崩溃遗留 WAL 的样例在拒绝打开时会被 SQLite 正常 checkpoint，主库布局变化且 WAL/SHM 消失。独立逐表比较证明 schema、所有行、证据 blob hash、原 operation/claim 均保留，无迁移/清空/重复执行，未判为数据丢失或 P1。此前“旧库 hash 不变”不扩大适用到所有崩溃现场；CLI 文档与原 #5 已准确说明逻辑保全和必要文件级副本，并于 `2026-10-18T17:07:14Z` 发布读回。没有新增第四批代码返工或虚构另一审核引擎。完整 G1、Claude 影响核实、生产接收与授权/发布/合并继续分别待核。
