# W3 持久影子接收现场（#5 自足实施条款）

状态：依据真实 W1/W2 软件细化的 W3 首个可用子版；条款范围已经独立只读复核。本轮执行固定为 shadow，生产受管接收和完整 G1 尚待后述前置。W1 为 [Draft PR #13](https://github.com/wlvh/tongxu/pull/13) @ `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`；W2 为 [Draft PR #14](https://github.com/wlvh/tongxu/pull/14) @ `c73c0bf45d40b9560a66baa8186ca4b41d291800`（代码 `792cdfd3dafba7af15bfb058bf5ac75e77e689b1` 已独立 Codex 技术复审 PASS、44 项测试通过；追加仅区分宿主 Git 版本字段并记录验证，Claude 影响核实待审）。W3 分支 `feat/w3-shadow-reception` 从该固定 W2 建立，真实 base/target 为 `feat/w2-isolated-evidence`；相对 main `1ba5ae893b49e5856a4e8d682139f70e5c907f5f` 额外含 W1 三个、W2 三个提交。正式合入前置保留；前置变化须重新核对，不秘密改目标。沿 #2 持续开发安排推进；不重开全局设计，不新增秘书、治理平台、审批 DSL 或后台模型循环。

## Why / 已有事实

W1 能固定 PR/目标与原记录；W2 能在新断网现场验证固定树并保留逐前缀结果。仍缺跨 CLI 进程重启后可接手的候选、精确前置、停止控制和原操作状态。W3 先把这些做成真实本地软件，不把预演记录当实际发布或合并。

当前 Node 24 的内置 SQLite 已实际可用；独立 Claude 接收执行器不可用，主干合并、生产写责任及新增身份/费用均未授权。原 #5 允许只读子版，不能把它命名为完整 G1 通过。只读/影子、逐次确认、有限委托三种模式的要求均保留，但本子版只有影子执行路径；传入模式或授权 JSON 不能打开远端写能力。

## 最小真实能力

1. `queue init/add/status`：私有仓库外 SQLite 状态；只读导入 W1 包和 W2 报告/原始材料，保存不可变原字节和 hash；明确候选匹配、来源/样本/执行缺口，记录 S/r 的来源引用与精确前置。输入只作为事实报告或建议，不生成本人采用、独立接收或生产委托。
2. `queue control`：分别保存停止新实施、停止新增投入、撤销新合并的请求来源、范围及本地生效版本。恢复一种不清其他限制；读取及原操作恢复继续可用。不会声称已停止外部运行、释放业务额度或回滚成果。
3. `queue begin/evaluate`：开始一次有界本地影子评估，事务内核控制/前置/席位并保存原操作与目标占用；席位默认 2，同规范化 repo/target 最多一个。评估只读取导入材料并产出等待原因/可继续部分/下一步，不调用模型、测试、发布或合并。等待前置不占席位。
4. 中断恢复：已登记操作保留原 ID/代次；重启先显示原操作，`evaluate --operation ID` 继续它，不创建替身。无心跳/超时抢占；旧代次完成不得释放新占用，矛盾观察保留待核。

CLI 形式：

```text
tongxu queue init --store ABS_NEW_DIR --repo OWNER/REPO [--seats 2]
tongxu queue add --store ABS_DIR --snapshot ABS_W1_BUNDLE --verification ABS_W2_DIR --context ABS_JSON
tongxu queue status --store ABS_DIR
tongxu queue control --store ABS_DIR --scope S_ID --kind implementation|investment|merge --state stopped|open --source REFERENCE
tongxu queue begin --store ABS_DIR --item ITEM_ID --run RUN_REFERENCE
tongxu queue evaluate --store ABS_DIR --operation OPERATION_ID
```

路径和材料沿用私有、仓库外、不穿透符号链接的边界。新状态目录拒绝覆盖；既有库 schema 不支持时退出并保留原文件，不自动清空迁移。没有 daemon、计划轮询或订阅；操作者显式导入新观察，空操作不会唤醒模型。

## 候选、来源与去重

候选键固定 repo/PR/H/B/真实 target/S 版本/r 版本。H、B、目标或 S/r 改变形成新候选，旧证据保留。同候选的新实质材料触发一次新影子评估；重复包、接收时间、摘要重生成、重复运行计数不触发重复工作，也不增加独立样本数。有限去重依据记录在结果中，不声称理解任意日志语义。

采集与执行观察分别维护水位；一新一旧、顺序缺失或同一时刻的矛盾材料保留为待核，不能把较新的执行反证整体归旧。冲突状态须跨重启保留，阻止相关前置；新联合观察同时覆盖两维后才可解除并重新评估。旧原件重放不能清除冲突，原操作恢复和无关工作仍可继续。

W2 的 inputs[].manifestHash、候选、各阶段 T/HEAD、计划及原输出必须与导入材料对应；缺失/不匹配和字节损坏分别处理，不能为演示拼接材料。校验原件后复制至私有内容寻址材料区，状态引用固定 hash；不能写源包，不能用带写锁/恢复副作用的 Snapshot.resume 代替只读读取。

W1 binding=verified 只证明正文 hash 绑定；W2 executionComplete、judgmentRefs、测试退出 0 都不是独立接收 PASS。comparisonComplete=null 和 businessCorrectness=unverified 保留。新 base/S/r 不复制旧 PASS。组合报告保留成员清单，不把额外成员悄悄当成单 PR 授权。

context 使用小型固定 JSON：scope 和 arrangement 各有 id/version/source，decisionKind 为原 W1 分类，requires 为有限精确对象列表（候选键、development/merge/enablement/parent 类型、固定版本、阻塞阶段、依据、可继续部分）。只有明确可由导入证据核对的本地证据前置用于影子排队；真实合并/采用前置仍待核。仅有“整个 Issue 已完成”或缺版本不推断满足。检查直接依赖和环，不构建通用依赖语言。

`schemaVersion` 固定为 1；scope/arrangement 的 id/version 最多 128 字符，source 最多 2048 字符。decisionKind 为 `owner_adoption_report|team_agreement|delegated_action|proposal|fact|unknown`，所有类别都只保留来源报告。requires 最多 32 项，item 为 64 位候选键，version 为精确 40 位 H，blocks 为 `shadow_review|merge|enablement`；source/canContinue 各最多 2048 字符。完整示例和字段含义随 CLI 文档交付。控制的 scope 使用相同的 scope.id。

## 事务与操作恢复

本地 SQLite 事务保护控制检查、席位和目标占用登记；先持久化 operation 再执行本地读取评估。每次占用绑定 operation ID 和代次，完成时只释放匹配代次。一次评估被中断，结果保持 running/unknown；重启不自行重派，不以 PID 存活/超时单独断定任务完成。

W2 运行中的工具可通过原 report.id + stage.index + tool.id 引用，显示原证据哈希与未完成状态；W3 不接管它、不再发测试。旧观察不能让新操作倒退或替新候选放行。控制和原记录可以在秘书不存在时通过 CLI 读取和修改本地影子范围。

## 输出及真实限制

状态显示实际能力、候选/来源、等待原因、三类控制、席位/目标占用、原操作及下一步。原件和 CLI 详细 JSON 私有，不提供自动发布入口；交付记录只摘取固定 ID、hash、类别和缺口，不复制私人路径/任意来源文本。CLI 的本地操作成功不意味着生产控制已生效。

机器结果 check run + 固定详情优先的原要求保留；本子版明确 `pending_publish`，不调用写 API、不自动改为 commit status 或同时双写。正式接收、有效身份/权限源、GitHub 规则检查、条件 merge 和实际目标/树回读都未验证。不能由作者或本地 JSON 补齐，不改变保护/认证/费用，不修改 SEC_metrics。

## Bridge / Acceptance

| SU | 实际 Delta | 触点 | 必须观察 |
|---|---|---|---|
| SU01 | 真实包进入持久接收现场 | 纯读取器、queue-store、CLI | 固定源/hash 匹配，坏包拒绝，源包不变 |
| SU02 | 明确前置和待审原因 | 影子评估器 | 精确 A1 等证据，等待不占席位，循环可见 |
| SU03 | 三类停止可重启恢复 | SQLite 控制事务 | 独立停止/恢复，读取和原操作核查不被误停 |
| SU04 | 同目标单推进与去重 | operation/claim 事务 | 两真实 CLI 竞争最多一占用，无超时抢占 |
| SU05 | 中断可接续 | begin/evaluate/status | 登记后退出保原 ID，旧完成不清新代次 |
| SU06 | 授权/发布缺口不伪装通过 | 状态与 CLI 文档 | 假批准/PASS、样本失败、缺接收者都不能产生远端写 |

故障夹具与真实输入分开：并发 CLI、数据库重启、原操作恢复、重复事件/新证据、旧回执、三种控制、篡改材料/错误候选必须可复现；断言没有远端写调用。真实 smoke 用同一固定 PR 对应的 W1/W2 包导入、查看、控制、重启及影子评估，保存原输入 hash 和完整限制。只覆盖 T07/T18/T19/T37/T39/T41/T45/T48 的本地影子部分，不整体改产品场景 PASS。

独立审核修复后提交单独 Draft PR，明确未合前置、真实 base 和额外内容。完整 W3/G1 仍等待独立接收能力、有效授权/身份入口、发布能力核验、原生产写责任显式交接和真实条件合入回读。只有相关放行等待；继续已获准的独立开发和测试，不自动合并或部署。

## 完整 W3/G1 仍保留的发布要求

本子版不删除原 #5 的完整要求：接收判断须独立，作者只能建议；后续有效执行须逐维核来源、角色、repo/target/action、S/r、必要门槛、原账本资源、时效和撤销。本人采用、代理委托处置、技术约定和事实更新分别留源；同账号不证明本人批准，GitHub approval 只是可选来源。秘书无签 S、技术 PASS、接收或直接 merge 权。

发送前重新核当前候选、授权和组织门。服务端 head 条件不锁 base；实际 merge commit、target、tree 必须回读，缺失/不符保留已合入待核，补实际版本验证可以恢复；错误目标不能用补测试追认。已发未知先查原对象，不重复合并、不强杀、不自动回滚、不还未知额度。机器结果验证真实发布能力后才可使用 check run + 固定详情；无能力保持待发布或明确选 status 替代，不提权/双写。

优先兼容 A1→B1→A2 或经证明的最小集成，不等整个 Issue，不把多次合并称原子，所有 PR 合入也不等于用户成果被接受。原验收 T07、T13–T21、T23/T24/T32、T37/T39–T43、T45/T48/T52 的非影子部分仍待真实证据。生产先影子对照，再显式交接唯一写责任；本地子版不接管原生生产流程。
