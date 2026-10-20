继续原 #5/#6/#9/#10 的本人边界、身份与有限委托缺口（G01），不新增产品版本或审批语言。固定前置 PR31 4f8092868262ec323bff6a5ee274fa6232d07f01；新分支 feat/w3-owner-authority，真实 target feat/w3-receiver-result-correction。既有影子调查、原操作回读及当前已明确授权的只读开发流程保留。

OA01 在原队列的 events/blobs 中保存“固定建议→真实来源观察→适用范围”引用；正式采用来源仍在原 Issue。分别表示本人采用S、逐次确认、有限委托、撤销与事实/建议；普通报告、自由文本source、模型PASS、关闭Issue或共用账号均不能成为本人批准。范围正文和约束固定hash，保留作者、来源、版本、有效期与原字节。团队r在既有S内更新不自动要求重批S，改S不能冒用旧采用。

OA02 可信启动配置固定仓库、Owner provider identity与执行身份、必要角色、允许的来源入口及读取期限。使用现有官方GitHub CLI的只读身份/准确原Issue评论作为一种实际可实现的来源适配；模型不获得Owner写入入口。Owner与执行者身份相同或隔离条件无法证实时保持未验证，不以配置里的true字段自证人类。生产身份的安装/账户隔离/真实采用是外部前置，本轮不新建身份、不迁移认证或安装App。

OA03 使用少量固定数据类型登记有明确来源的采用或授权；没有可执行表达式、任意shell/URL或余额账本。动作检查逐维核实际调用角色、repo/target/action、当前S、必要精确候选/组合、时效/撤销和已固定前置，模型传入role不能覆盖可信调用方角色。逐次确认只对应一个固定动作；有限委托只能用于已列范围。秘书没有签S、技术PASS、接收或merge权。

OA04 在产生后果前重读准确来源并核原动作；来源被编辑、删除、无法取得、身份错配或版本变化仅阻断受影响动作。登记后重启/重复观察不重复采用或耗用确认；已发未知保留原operation，不因撤销重发、回滚或返还资源。并发来源须按前一版本核对，不倒退或覆盖。

OA05 本人停止/恢复可从直接入口导入真实来源，秘书仅能提出/呈现请求。三类停止继续分开；旧影子入口或旧客户端不得把已验证本人停止悄悄打开。接入整体复盘的上一已接受基线时，必须引用准确已验证采用；缺来源仍显示missing/unverified，不通过改布尔值制造基线。

OA06 先用明确隔离身份和原生通道替身证明正常采用、逐次/委托、共享身份拒绝、角色/范围/目标错配、时效/撤销、并发版本、重复、来源不可得、r更新和S变动、秘书诱导、未知操作保留及停止恢复。测试身份绝不记作真实Owner。本机现有共享GitHub身份可只读核实，但不能用它生成自批。构建、定向测试、独立审核和Draft交付后继续G02/G03/G11/G13消费者接入；未接的实际生产动作保持不可用。

本子范围实现来源核对和受限检查能力，不执行主干合并、保护设置、部署、新增费用或SEC_metrics业务。具体生产采用、委托和身份配置仍留给有权者，不要求用户为软件实现先作这些决定；其它可自主部分继续。

## 实现与入口

固定建议、来源、采用、撤销和动作预留都存入原 `queue.sqlite` 的 `events` / `blobs`。显式启用格式 12，要求格式 11 且接收、修复、整体复盘、发布没有活动或未知操作。配置只固定预期身份与读取工具，不产生采用或授权。未启用本功能的原队列按既有流程工作；已启用的队列要求新消费者明确绑定，旧接收/修复/发布/整体复盘发送入口由 SQL 拒绝。原报告仍可回读，不把“软件检查通过”说成已经发起生产动作。

`authority-cli` 是本机负责人入口，不作为模型的 shell 工具。秘书或协调角色只能通过其固定角色的受限端点提出建议或调用同一后端；请求 JSON 和 CLI 都没有 `--role` 升权选项。生产配置的 Owner 身份、执行身份与可信 `gh` 路径/哈希属于部署者信任边界，角色不能修改此配置。软件不声称能防止拥有同一操作系统账号任意文件写权的操作者替换可信程序或直接改数据库。

```text
node dist/src/authority-cli.js configure --store ABS_QUEUE --profile ABS_PROFILE
node dist/src/authority-cli.js prepare --store ABS_QUEUE --id REQUEST_ID --proposal ABS_PROPOSAL
node dist/src/authority-cli.js apply --store ABS_QUEUE --proposal-sha FIXED_SHA256 --comment ORIGINAL_COMMENT_ID --evidence NEW_ABS_DIRECTORY
node dist/src/authority-cli.js check --store ABS_QUEUE --authorization DECISION_SHA256 --request ABS_ACTION --evidence NEW_ABS_DIRECTORY
node dist/src/authority-cli.js reserve --store ABS_QUEUE --id ACTION_ID --authorization DECISION_SHA256 --request ABS_ACTION --evidence NEW_ABS_DIRECTORY
node dist/src/authority-cli.js status --store ABS_QUEUE
```

这里只读准确原 Issue 评论以及固定 GraphQL 查询中的 viewer、同一评论作者和最后编辑者。没有任意 URL、任意查询、mutation、登录、写评论或账号管理工具。保留 REST、GraphQL、命令、退出记录；两份来源须一致。评论标识使用 `fullDatabaseId`，兼容超过 32 位的真实评论 ID。共用账号、另一身份编辑、编辑归属不可得、读到不一致版本、删除/网络错误、超时或部分响应不能产生已验证决定。

建议的内容哈希固定后，本人原评论必须是唯一的 `tongxu-owner-decision` JSON（可有一层完整代码围栏），准确引用 `proposalSha256`；叙述中的“批准”、模型报告、关闭状态或 `source` 字符串不能替代它。`prepare` 返回可审阅建议和对应原评论内容，但不会代替本人发布。该机制证明独立 provider 身份作出了这项决定，不证明该身份背后一定是自然人；部署时仍须隔离本人凭据和执行者工具。

## 可表达的决定

- `adopt_scope` 固定 S 的目标、非目标、保留内容、验收和约束，并引用前一采用。并发旧版本不能覆盖新版本；已用过的 S 版本号不可复用。团队 r 变化不是 S 变化。
- `confirm_action` 对应一个完整动作：S/正文 hash、固定执行角色、仓库/目标、候选 H/B、必要组合 hash、工作项、路径、资源引用和到期时间。只能预留给一个动作 ID。建议中的执行角色须与可信调用端一致，不能靠请求 JSON 自称为该角色。
- `delegate` 仅列出允许角色、目标、动作、路径与已有资源引用，期限最多 31 天。路径按完整相对路径匹配，没有通配符或隐式递归。它不创造额度、工具写权或合并权限。
- `revoke` 撤销准确已登记决定。原操作和未知状态不删除、不重发，也不推定返还资源。
- `control` 通过同一 `controls` 表登记实现、投入或合并的停止/恢复。旧入口不能恢复已验证本人停止；恢复需新的、时间顺序可确认的本人来源。重放旧停止不会重新盖过新恢复。
- `accept_baseline` 单独引用准确 S，以及目标、规则、能力三个材料的名称与哈希。采用 S 本身不代表接受某批能力。`OverallPlan.baselineAcceptance.kind=verified_owner_source` 必须引用此决定；整体复盘入口重读原来源并核三份实际材料，不能用调用者布尔值升格。历史已接受 S 可作对比基线；撤销的来源不再当作有效接受。

每次新动作检查重读采用和授权的准确原评论，最长可复用 5 分钟内的一次读取；实际消费者还须在产生后果前重核候选、工具、资源和写入责任。软件尚未收到的新撤销评论不会凭空被感知：当前支持显式导入撤销，或编辑/删除原授权后由下次准确来源读取阻断；全量事件/轮询接续属于 G04。不能把本模块说成已完成所有消费者或后台监视。

“编辑后阻断”针对批准对象、决定含义或可归属身份的变化。同一 Owner 的合法 JSON 重编码或排版，若仍准确 `approve` 同一固定 proposal、最后编辑者可核且来源顺序未倒退，不产生新权限，也不自动撤销原决定。程序保留旧字节并追加新观察；不会把排版刷新当作新的采用、延长期限或重新释放一次性确认。

`reserve` 只保存 `reserved_execution_unproven`，不执行动作。重复同一动作 ID 仅返回原记录，即使来源后来撤销或暂时不可达，也不会再次预留或推定动作没执行。后续 G02/G03/G11 消费者须绑定原 operation，并核实实际执行/未知结果；本模块不另设操作队列或余额。`check` 的 `authorityCheck=passed` 与 `consumerActionAvailable=false` 分别表示来源/边界检查通过和执行尚未接入。

## 当前证据与明确限制

正向采用和有限委托全部是隔离 fixture 身份，`executionKind=fixture` 贯穿记录；不能向已有原生执行历史的队列配置 fixture 身份，启用后也不能从旧发送入口启动原生调用。实际 GitHub 探针只读取现有 #5 接续评论，确认本机共用身份被拒绝，没有创建 Owner 采用。

验证包括：来源作者/编辑者、固定原件与乱码/部分响应、角色注入、完整动作和越界路径、到期与撤销、r/S 更新、并发采用、一次性确认重复、SQL 停止保护、旧消费者拒绝、基线材料替换和原有接收/修复/组合/工作台回归。测试失败和原始日志保存在私人接续目录；真实 GitHub 探针与 fixture 结果分开。没有把这些结果当作主干合并、产品全部验收、真实 Owner 接受或完整 G1/G2 完成。
