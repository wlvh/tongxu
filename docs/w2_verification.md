# 固定候选的隔离验证

`verify` 接收 W1 采集包，在私有的新 Git 仓库和断网现场运行明确登记的现成测试。它记录基线 B、每个有序组合的 T 和实际 HEAD，并保留失败的中间结果。执行完整不代表业务正确、独立审核通过或可以合并。

需要 Linux、支持用户/挂载/网络隔离的 bubblewrap、Git（支持 `merge-tree --write-tree`）、Node 24。本机验证版本为 Git 2.52.0、bubblewrap 0.12.0、Node 24.19.0。依赖安装由操作者在运行前完成；运行器不装包、不联网，没有隔离能力则保存缺口。

## 运行

先按 [W1 CLI](w1_cli.md) 收集 PR；已有 Git 本地仓库必须包含包中固定的 B/H。用绝对路径保存可信计划，例如：

```json
{
  "schemaVersion": 1,
  "tools": [{
    "id": "project_test",
    "argv": ["/usr/bin/node", "test.cjs"],
    "timeoutMs": 30000
  }]
}
```

把程序路径换为本机真实可用路径；参数是数组，不能传 shell 字符串。调用者选择测试；程序不从 Issue、评论或候选文字推断命令。

```text
node dist/src/cli.js verify --snapshot ABS_W1_BUNDLE --objects ABS_LOCAL_GIT
  --plan ABS_PLAN_JSON --output ABS_NEW_PRIVATE_DIRECTORY
  [--with ABS_OTHER_W1_BUNDLE ...]
```

上述命令需写成一行，或按所用 shell 加续行符。所有参数路径是规范绝对路径；输出必须在 Git 仓库外、不存在且不穿过符号链接。至多 8 个同仓库/同真实目标的候选，按 `--with` 顺序组合，后项 B 必须已包含于前一前缀。缺对象时保留错误，不自动获取其他版本或切换移动分支。

运行 tongxu 自身的测试时，计划可用实际 Node 路径和该安装的 npm CLI 路径组成 `argv: [NODE_PATH, NPM_CLI_PATH, "test"]`，并显式设置 `dependencyDirectory` 为本机现成 `node_modules` 的绝对路径。该目录只读挂载，内容摘要在各工具前后核对。不得把任意宿主目录当依赖缓存。

## 结果和退出码

- `verification.json`：固定输入 manifest 原字节/哈希、计划、版本、每阶段树/HEAD、命令及 PID/进程组、退出/信号、输入前后哈希、缺口和限制。
- `raw/`：内容寻址的原 stdout/stderr、结构化结果、Git 合成输出及原输入记录；仅私有保存。
- `summary.md`：允许字段摘要，含候选哈希、阶段与缺口，不复制原命令参数或测试原文；发布前仍需人工审查。
- `stage-*`、`objects`、`result-*`：隔离执行现场、对象缓存与本轮工具的新结果目录。作者仓库不 checkout、不改 index/refs；这些新现场的写入是明确的本地副作用。

退出 0 表示要求的执行/证据完整且未观察到声明样本失败；2 表示已保存的冲突、测试失败、隔离不可用或缺口；1 表示参数/存储错误。`executionComplete`、`comparisonComplete` 和 `businessCorrectness` 分开，最后一项始终为 `unverified`。普通测试没有样本协议时，`comparisonComplete=null`，不会凭退出 0 推断业务覆盖。完整采样也可能观察到失败，因此 `status=complete` 与退出 2 可以同时成立。

每阶段先核真实 `HEAD^{tree}=T`；每个工具前后核 tracked 文件及整个私有 Git 状态，包含 HEAD/index/config、refs/replace、objects 和辅助文件。工具后只读文件字节，不在候选可改的 Git 配置下再运行宿主 Git；Git 状态摘要最多 50000 项/512MiB。输入或依赖变动会使证据无效，并停止该阶段其余工具。下一阶段从新的固定现场开始，后面的成功不抹掉前面的失败。文本冲突停止组合，不制造“受测树”。同一次证据重复使用不增加独立样本数。

## 可选结构化对照

工具声明非空且不重复的 `expectedSampleIds` 后，必须在本次 `TONGXU_RESULT_FILE` 指向的位置新写 JSON，例如：

```json
{"samples":[{"id":"example","status":"ok","content":{"value":1},"identity":"fixture-v1","source":"fixture:example","sideEffects":[]}]}
```

不声明样本协议的既有测试可直接使用。声明后，缺项、额外项、重复 ID、空来源、坏 JSON、缺文件、工具失败或输入变化均产生不完整证据；仓库预存或前次结果不能复用为本轮输出。程序比较状态、规范化内容、身份、来源和副作用，输出 SAME_OK、CHANGED_OK、FAIL_TO_OK、OK_TO_FAIL、SAME_FAIL、CHANGED_FAIL 或 NOT_COMPARED。它记录变化，不自动判断某种拒绝是不是业务退步。

## 隔离、边界与中断

工具有独立网络/PID/挂载视图、净环境和空 HOME；系统只读，Node 仅挂载真实可执行文件及已确认的 npm 资源目录，不按安装路径猜测和挂载祖父目录。只有本阶段 checkout、新结果和临时目录可写。没有宿主 HOME、代理、SSH、gh 或发布 token 的正常访问路径。每项最多 300 秒、4MiB 合计输出，超限终止进程组并保留已得字节；最多 16 项工具、每项 100 个参数。结构化文件最多 4MiB。没有独立 CPU、内存或磁盘配额，也不声称抵抗主动恶意的同权限宿主进程。

固定 runner 文件、计划、依赖摘要和工具版本可核。`toolVersions.host_git` 仅是宿主构树/导入对象用的 Git，不能代替测试子进程的工具版本；本机宿主为 2.52.0，隔离 PATH 的 `/usr/bin/git` 为 2.47.3。具体测试工具的版本应由登记测试报告；运行器不穷举子进程。系统运行库未全量 hash，宿主依赖前后观察非原子，限制如实记录。固定 W1 包不证明远端当前仍是同一候选；原采集缺口继续保存在输入记录中。

运行前即写入阶段/工具状态和操作引用。中断时保留 `running`/结果未知，先核原 PID/进程组及现场，不自动再派一次；没有自动恢复执行或覆盖输出入口。确需重跑须用新目录，保留旧包。程序没有接收队列、远端发布或合并权限，SEC_metrics 仍只读。
