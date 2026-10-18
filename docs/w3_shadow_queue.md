# W3 本地影子接收 CLI

W3 将一个固定候选的 W1 原始包和 W2 隔离验证结果导入私有 SQLite，保存材料、精确前置、三类控制及可恢复的本地评估。Node 24 内置 SQLite 是唯一新增运行能力，无数据库服务。当前只有 `shadow`；不是完整 G1 受管接收，不能批准、发布检查、合并、调用模型或接管外部运行。

先按 [W1](w1_cli.md) 采集、按 [W2](w2_verification.md) 验证**同一固定候选**。不能用更新后的 PR 采集包配旧验证报告。构建 `npm ci --ignore-scripts && npm run build` 后执行：

```bash
node dist/src/cli.js queue init --store /tmp/tongxu-queue-new --repo OWNER/REPO --seats 2
node dist/src/cli.js queue add --store /tmp/tongxu-queue-new --snapshot /tmp/w1-bundle --verification /tmp/w2-result --context /tmp/queue-context.json
node dist/src/cli.js queue status --store /tmp/tongxu-queue-new
```

将 `add` 返回的 64 位 `item` 填入后续命令。所有路径为仓库外规范绝对路径，目录须私有，不穿透符号链接。新库不覆盖现有目录；未知 schema 保留原件并报错，不清空或自动迁移。原输入只读，导入的原字节按 SHA-256 进入库。CLI 输出含来源引用，视为私人材料，不直接粘贴至公共 Issue。

context 是操作方显式提供的来源报告，不是授权文件。最小例子：

```json
{
  "schemaVersion": 1,
  "scope": { "id": "project-g1", "version": "scope-1", "source": "https://github.com/OWNER/REPO/issues/2" },
  "arrangement": { "id": "delivery", "version": "arrangement-1", "source": "https://github.com/OWNER/REPO/issues/5" },
  "decisionKind": "proposal",
  "requires": []
}
```

scope/arrangement 的 id/version 各最多 128 字符，source 最多 2048 字符。`decisionKind` 可为 `owner_adoption_report`、`team_agreement`、`delegated_action`、`proposal`、`fact`、`unknown`；任何值、来源文本、`PASS` 或额外 JSON 字段都不证明本人采用或赋予能力。

精确前置 `requires` 最多 32 项，每项包括：

| 字段 | 含义 |
|---|---|
| item | 已知前置的 64 位候选键（可在其导入前由固定候选和 context 计算） |
| version | 前置候选精确 40 位 H，不接受分支名或整个 Issue 完成标记 |
| type | `development`、`parent`、`merge`、`enablement` |
| blocks | `shadow_review`、`merge`、`enablement` |
| source / canContinue | 依据引用 / 等待时可继续部分，各最多 2048 字符 |

只有 `blocks=shadow_review` 的前置约束本地评估。development/parent 需存在、版本匹配、原件完整、报告证据无缺口且无循环；这仍不等于已接收。merge/enablement 无远端回读，保持未核。等待不占席位。

```bash
node dist/src/cli.js queue begin --store /tmp/tongxu-queue-new --item ITEM_ID --run LOCAL_RUN_REFERENCE
node dist/src/cli.js queue evaluate --store /tmp/tongxu-queue-new --operation OPERATION_ID
```

`begin` 先原子登记 operation、代次与目标占用，再返回；尚未评估时状态为 running/unknown。`evaluate` 只核固定本地材料、前置和控制，保存缺口与下一步。两个命令可以跨进程和主机重启接续；用原 operation ID，不新建替身。同 repo/真实 target 最多一个占用，全部目标默认 2 席，可在建库时设 1—8。等待或未知占用没有超时夺取。旧代次的重复完成不会释放新占用。库损坏导致原操作保留未知，先恢复对应原件，不能直接删 claim 当作成功。

同候选的新实质材料产生新 packet；相同来源、结果和运行器仅重收时间/运行编号改变只存观察、不重派。判断依据变化、样本失败、运行器变化会形成新材料。去重依据明确结果，不能理解任意日志语义；普通日志变化可归档而不触发评估，需把有意义的反例作为新来源或结构化结果导入。旧观察保留但不倒退当前 packet。候选 H/B/target/S/r 改变产生新 item，不复用旧结论。

```bash
node dist/src/cli.js queue control --store /tmp/tongxu-queue-new --scope project-g1 --kind investment --state stopped --source OPERATOR_REFERENCE
node dist/src/cli.js queue control --store /tmp/tongxu-queue-new --scope project-g1 --kind investment --state open --source RESUME_REFERENCE
```

`implementation`、`investment`、`merge` 各自保存请求来源、本地生效时间及版本，重启后保留；恢复一类不清其他限制。本子版只执行本地评估，因此 investment 停止新的 `begin`，原操作核查和读取仍可继续。implementation/merge 保留状态供查看，没有相应外部执行器，输出明确 `externalControl=unverified`，不能声称外部已停止。

退出 0 表示本地记录/评估成功，退出 2 表示开始评估被前置、停止或占用阻塞，退出 1 表示输入/存储错误。结果始终 `productionActionAllowed=false`、`independentReception=pending`、`pending_publish`；测试完成、hash 绑定和本地返回 0 都不是技术接收或合并权限。W2 未结束工具仅保留 report/stage/tool 引用，不重跑或杀进程。

真实能力与限制记录在 [W3 验证记录](../verification/W3_SHADOW_QUEUE.md)。完整 W3/G1 还需独立接收执行器、有效身份/授权来源、真实发布能力、唯一生产写责任交接及条件合入回读；均不能由本地输入补齐。持续开发在可用前置与既有授权内推进。
