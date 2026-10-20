# 有界事件补查与队列选择（G04）

本片段继续原 #5/#6/#8 的 EV01–EV05。从 `f4cec1625689a741f62244cb39088638db4488c2` 分出 `feat/w3-event-reconciliation`，target 为 `feat/w3-managed-merge`。原 QueueStore 是唯一任务、操作和占用来源。范围记录见 [#5 comment6292508866](https://github.com/wlvh/tongxu/issues/5#issuecomment-6292508866)。这里没有安装常驻进程、webhook 服务或新的计费入口。

## 通知、事实和固定材料

`event-cli configure --store /absolute/queue --profile /absolute/profile.json` 在无活跃或未知操作时固定来源配置。配置含仓库 ID、PR 列表（1–8）、官方只读 gh 的绝对规范路径与哈希、来源种类、补查间隔和每次最多读取几个 PR。真实 GitHub 的最短周期为 60 秒。测试来源与真实来源分开；测试进程不会继承个人 HOME、GitHub token、模型认证或 SSH 环境。真实来源只继承现有 GitHub 读取所需环境。

`hint --store ... --input /absolute/hint.json` 接收有限通知：`schemaVersion=1`、唯一 `id`、已登记 `pr` 和 `kind`。kind 可为 submitted、head_changed、checks_finished、prerequisite_changed、consumer_feedback、decision_changed。通知只是补查提示。重复 ID 同内容不再排入；同 ID 不同内容拒绝；提示风暴受到最短重读间隔限制。漏通知由到期补查发现。

`tick --store ...` 每次只做有限的来源读取、材料整理和至多一次原有本地评估。读取包括 PR 前后两次、真实 target ref 前后两次，以及完整分页的评论、行内评论、审核、check runs 和 statuses。PR REST 中可能滞后的 base 单独保留，不代替直接 target。失败、权限不足、分页缺口和读取中变化都保留为未知或不完整，不当作空集合。捕获目录、请求、退出结果、完整响应与原始正文保留；数据库只保存正文及小型引用索引，不把 Buffer 展开为数字键 JSON。每列表最多 10 页，每次观察正文合计最多 16 MiB。

同一通知和原读取序号都有幂等记录。旧序号晚到仅归档，不覆盖新观察。更新时间、传输格式和本程序已核对发布的原评论不会制造新任务；评论正文被他人改动仍算新材料。检查结果变化会重新检查条件，但不会仅因此重发审核。时钟只能使补查到期，不能使合并或授权条件成立。

相同 H/B/target 的新正文、评论或反例会生成原队列中的新 packet，即一批新的固定输入。原 W1/W2、原报告、补证、纠错历史及候选的调用次数保留。只有完整原 W1 分页确实与当前材料一致，才可直接绑定旧输入；缺页或原件损坏不能据此复用。新 H/B/target 等待对应固定源码与验证材料，不改旧候选来伪装更新。新的 W1 观察晚于事件来源时，要等来源重新读取。

目标仍有活跃或未知操作时只保存变化，不更换运行中输入或抢占写权。原操作结束后，下次 tick 接续材料整理。已有双任务安排固定的 packet 不会被暗中改绑，显示 `paired_arrangement_requires_new_material_binding`，交给后续安排消费者处理。

每个受监控成员都必须有完整、当前、未过期的来源，并绑定到实际 packet，才能开始新本地操作、接收、修复或合并阶段。有效期为观察时间加 `max(60 秒, 2 × 补查间隔)`，只是启动前事实新鲜度检查。新接收输入包含完整 `sourceEvents`，与原输入哈希一起绑定。SQL 规则同时拦住预先打开的旧客户端漏带材料、丢失历史或启动过期阶段。已经发出的原操作仍能记录实际结果；历史 PASS 不自动覆盖新材料。

## 排序和实际选择

`rank --store ...` 只读原队列事实并解释顺序；`select --store ... --run finite-request-id` 在同一 SQLite 事务里重查条件并占用原 operation/target。相同 run 返回同一选择；原本地评估未完成时返回原操作。`tick` 会完成这次有限本地评估，不启动模型、发布或合并。

排序考虑已采用的主干紧急偏好、具有原报告的退回/收尾、精确依赖的必要上游、有限优先级、等待时间和已有验证记录中的耗时。未知成本保留 unknown。Owner 标记的紧急事项显示为采用的偏好，不冒称已技术核实。必要上游可以继承紧急程度，被依赖阻住的下游不占席。连续三次实际自动紧急选择之后，给已等待至少 30 分钟的普通可执行任务一次机会；刷新页面或读取排序不累计次数，不打断在途操作。

开始时再次检查候选、材料、S/r、停止、席位和同目标占用。排序没有赋予模型、写入、资源或发布权限。此片段实际选择只启动既有本地评估；接收、修复、发布、合并等下一角色列为带具体原因的待办，继续由 G11/G12 的绑定消费者落实。操作完成、文件存在和角色真的收到材料是不同事实。

## 有来源的偏好

新增有限 `queue_preference`：schemaVersion、item、priority（-2 至 2）、mainIncident（布尔）、reason。它需要原 AuthorityRecords 中已登记的 coordinate intent，准确绑定 item/候选/S/正文哈希、正确角色、原确认或委托及未撤销的新鲜来源；请求的 paths/resourceRefs 必须为空。可选 `ActionRequest.payloadSha256` 仅用于 coordinate，其他动作拒绝该字段。协调可以处理前置尚未满足的任务；这个例外不开放实现、测试、接收或合并权限。

`preference --store ... --input /absolute/preference.json` 输入是 `{intentId, preference}`。正式 CLI 重新读取原 Owner 决策，不接受用户传来的认证 JSON 或 role 覆盖。应用后记录 `local_queue_preference_applied`，而非把原 reservation 冒充执行；同 intent 重复读取返回原结果，不重复应用，换正文拒绝。已应用的偏好是过去发生的本地效果，撤销旧授权会阻止后续动作，不擅自回滚先前偏好；需要调整时采用新的准确偏好。测试只使用明确标注的独立身份夹具，本机共享账户不会因此变成独立 Owner。

## 验证与边界

测试覆盖实际只读子进程、完整/缺失分页、通知丢失/重复/乱序、噪音、原件损坏、材料追加、旧输入保留、发送前变更、未知占用、旧客户端 SQL、跨进程选择、重启接续、偏好来源、必要上游、停止和有限等待提升。真实 GitHub 只读探针与夹具分别记录；没有为此新增真实模型请求或真实生产写入。

仍需后续原计划的角色发送、长会话管理、双任务新安排绑定与可操作界面。真实受控合并仍依赖既有独立身份、治理及具体授权；本片段不改变这些边界，也不表示全部 Issue 或 52 个完整场景已通过。
