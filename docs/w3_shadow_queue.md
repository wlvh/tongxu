# W3 本地影子接收 CLI

W3 将一个固定候选的 W1 原始包和 W2 隔离验证结果导入私有 SQLite，保存材料、精确前置、三类控制及可恢复的本地评估。Node 24 内置 SQLite 是唯一新增运行能力，无数据库服务。当前只有 `shadow`；不是完整 G1 受管接收，不能批准、发布检查、合并、调用模型或接管外部运行。

先按 [W1](w1_cli.md) 采集、按 [W2](w2_verification.md) 验证**同一固定候选**。不能用更新后的 PR 采集包配旧验证报告。构建 `npm install --ignore-scripts --package-lock=false && npm run build` 后执行：

```bash
node dist/src/cli.js queue init --store /absolute/private/tongxu-queue-new --repo OWNER/REPO --seats 2
node dist/src/cli.js queue add --store /absolute/private/tongxu-queue-new --snapshot /absolute/private/w1-bundle --verification /absolute/private/w2-result --context /absolute/private/queue-context.json
node dist/src/cli.js queue status --store /absolute/private/tongxu-queue-new
```

命令中的 `/absolute/private` 是占位路径，必须替换为已存在、仓库外的真实私有父目录；新建的 store 子目录必须尚不存在。macOS `/tmp` 是系统别名，不能直接用作显式输出。将 `add` 返回的 64 位 `item` 填入后续命令。所有路径为仓库外规范绝对路径，目录须私有，不穿透符号链接。新库不覆盖现有目录；当前 SQLite schema 为 3，早期 schema 1/2 及其他版本报错，不清空逻辑记录或自动迁移。需从未变的 W1/W2 输入创建新库，旧操作仍留原库待核，不自动转移占用。SQLite 的任何打开/关闭（包括查询）都可能正常 checkpoint WAL，改变 DB/WAL/SHM 物理布局，逻辑记录、证据 blob、原 operation/claim 保留；若需文件级取证，先确认原写者已停并复制完整 DB/WAL/SHM，再对副本检查。原输入只读，导入的原字节按 SHA-256 进入库。CLI 输出含来源引用，视为私人材料，不直接粘贴至公共 Issue。

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
node dist/src/cli.js queue begin --store /absolute/private/tongxu-queue-new --item ITEM_ID --run LOCAL_RUN_REFERENCE
node dist/src/cli.js queue evaluate --store /absolute/private/tongxu-queue-new --operation OPERATION_ID
```

`begin` 先原子登记 operation、代次与目标占用，再返回；尚未评估时状态为 running/unknown。`evaluate` 只核固定本地材料、前置和控制，保存缺口与下一步。两个命令可以跨进程和主机重启接续；用原 operation ID，不新建替身。同 repo/真实 target 最多一个占用，全部目标默认 2 席，可在建库时设 1—8。等待或未知占用没有超时夺取。旧代次的重复完成不会释放新占用。库损坏导致原操作保留未知，先恢复对应原件，不能直接删 claim 当作成功。

同候选的新实质材料产生新 packet；与**当前**材料相同，仅重收时间/运行编号改变时只存观察、推进观察水位、不重派。判断依据变化、样本失败、运行器变化会形成新材料；失败后新的成功即使与历史成功同语义，也产生新 packet 和评估资格。去重依据明确结果，不能理解任意日志语义；普通日志变化可归档而不触发评估，需把有意义的反例作为新来源或结构化结果导入。旧观察保留但不倒退当前 packet，状态分别显示 packet 原观察与最新水位。候选 H/B/target/S/r 改变产生新 item，不复用旧结论。

采集观察与执行观察分别维护水位。一新一旧、缺少顺序或同一时刻的矛盾实质材料进入 `observationConflict` 待核，状态保留各原包，当前证据不再宣称完整，相关前置不能放行；不会因采集包较旧而吞掉较新的测试失败。只有严格超过两个已知水位的新联合观察才能解除，解除产生新的评估资格；等水位、单维推进、JSON 重编码、新运行编号或旧原件重放都不能解除。需重新采集并产生新的执行观察；原字节 hash 只标识材料，不证明新鲜性。原操作仍可按 ID 核查，无关目标继续。

```bash
node dist/src/cli.js queue control --store /absolute/private/tongxu-queue-new --scope project-g1 --kind investment --state stopped --source OPERATOR_REFERENCE
node dist/src/cli.js queue control --store /absolute/private/tongxu-queue-new --scope project-g1 --kind investment --state open --source RESUME_REFERENCE
```

`implementation`、`investment`、`merge` 各自保存请求来源、本地生效时间及版本，重启后保留；恢复一类不清其他限制。本子版只执行本地评估，因此 investment 停止新的 `begin`，原操作核查和读取仍可继续。implementation/merge 保留状态供查看，没有相应外部执行器，输出明确 `externalControl=unverified`，不能声称外部已停止。

退出 0 表示本地记录/评估成功，退出 2 表示开始评估被前置、停止或占用阻塞，退出 1 表示输入/存储错误。结果始终 `productionActionAllowed=false`、`independentReception=pending`、`pending_publish`；测试完成、hash 绑定和本地返回 0 都不是技术接收或合并权限。W2 未结束工具仅保留 report/stage/tool 引用，不重跑或杀进程。

真实能力与限制记录在 [W3 验证记录](../verification/W3_SHADOW_QUEUE.md)。完整 W3/G1 还需独立接收执行器、有效身份/授权来源、真实发布能力、唯一生产写责任交接及条件合入回读；均不能由本地输入补齐。持续开发在可用前置与既有授权内推进。


## 本机接收核实补充

队列的 SQLite、导入和评估逻辑可在 Node 24 的 Mac 上运行；生成新的 W2 隔离报告仍要求可用的 Linux/bubblewrap。队列读取一份历史 Linux 报告，不等于本机重新执行了其中的工具。生产 `npm test` 包含 W2，因此不将 Mac 的队列专项结果写成整套 Linux 验收通过。

当前采集观察取 `candidate.observedAt`（首次固定候选时间）。`collect --resume` 用于续采同一候选，不推进这个时间；只重跑 W2 或重编码报告不能解除已有双水位冲突。需要新联合观察时，先核清原操作、保留旧材料，再进行新的 W1 采集与 W2 执行；新目录本身不证明新鲜性，也不转移原 operation/claim。改变精确 `requires` 应有对应安排版本与来源；新版本形成新 item，旧未知占用仍需按原 ID 处理。

导入拒绝带 `lock.json` 的源包，先走 W1 的原恢复路径。引用文件须为独占 inode 的普通文件（`nlink=1`），使用不穿越符号链接的规范绝对路径；单个证据引用最多 64 MiB，去重后的导入字节合计最多 128 MiB。`evidenceComplete` 描述本项材料，依赖与占用另在 `begin/evaluate` 检查，不能用它代替完整接收结论。

不完整的结构化样本登记 `sample_result_incomplete`，仍阻止依赖。只有从原样本重算的内容、完整状态或缺项原因与报告不一致时，才额外登记 `sample_result_evidence_mismatch`。样本产生的缺项不会被重放成另一个执行失败；未知工具错误仍保留，所有原始 gap 与报告字节仍保存。没有放宽缺样本、伪造摘要、错误终态或生产权限的判断。
