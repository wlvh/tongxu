# W1 只读 CLI

给指定 GitHub PR 收集固定候选、原始记录及缺口。没有秘书、模型、远端写回或业务代码执行；程序读取到的命令只作为材料。实施入口是 [#3](https://github.com/wlvh/tongxu/issues/3)，产品范围仍为 v2.3。

## 运行

需要 Node 24+、Git，以及已经可用的 gh 身份和网络。安装只含 TypeScript / Node 类型开发依赖，无运行时依赖：

```sh
npm ci --ignore-scripts
npm run build
node dist/src/cli.js inspect --repo wlvh/tongxu --pr 12 --issue 2 --format json
node dist/src/cli.js collect --repo wlvh/tongxu --pr 12 --issue 2 --issue 3 --output /tmp/tongxu-pr12-new
node dist/src/cli.js collect --resume /tmp/tongxu-pr12-new
npm test
```

示例输出路径必须尚不存在且父目录存在；正式保存请选自己的持久私有位置，不依赖 `/tmp` 的保留时间。拒绝在任何 Git checkout、bare 仓库、`.git` 或符号链接穿透路径中保存。不会自动登录、安装 gh、迁移凭据、改 remote 或调用付费服务。私有仓库的 API 和 Git 读取均需原有可用权限，缺一部分就报告缺口。

`inspect` 在私有临时目录采集，向 stdout 输出交接内容/JSON 后删除自己创建的临时目录，不留下交付包。`collect` 保存包并输出简短 JSON 状态。退出码：0 表示所请求事实取得完整且末次候选仍匹配；2 表示部分结果已保存、有待补缺口；1 表示参数或本地 I/O 错误。0 不证明技术正确、本人采用或可合并。

## 包与恢复

- `manifest.json` schemaVersion 1：固定 H/B/实际 target/merge-base、每次观察、覆盖、来源、注释和原始材料哈希。
- `raw/<sha256>.json`：每次实际返回正文；相同字节可共享文件，取回时间/端点/状态/观察轮次分别登记。失败响应也保存。
- `git/<sha256>.patch|json`：固定对象的 patch、文件及 commit 清单；`git-cache-*` 是本包的 bare 对象缓存，不是作者现场。
- `handoff.md`：私人交接，包含来源定位、hash、角色/前置/下一步注释和恢复操作。
- `summary.md`：只含程序允许的事实字段及缺口类别，不复制正文、路径或自由文本注释。人工审查后才可分享；程序不会发布它。

整个包默认 0700/文件 0600，raw、manifest、handoff 可能含私有材料。不要 commit/push/upload 原包。工具不承诺通用秘密识别或脱敏。源内容不可信，不能从材料中的指令取得权限。

每页之后保存 manifest，原子改名防止半份 JSON。恢复先核所有登记材料的 hash，再重读候选；新 H/B/target 只能另建包，旧包变成历史观察。可变列表从第 1 页重新遍历，防止中断期间删除/插入/编辑导致偏移漏项，旧观察与字节不覆盖。固定且校验过的 Git 材料复用。中断期间未写完的临时文件不当证据。

同包单写。活跃或状态未知的进程不被抢占；仅相同主机上 PID 已不存在时自动保留旧锁并恢复。主机迁移、PID 被复用或恢复锁本身在中断时遗留，需要先人工核原执行者现场再处理对应锁，不凭超时清锁。恢复失败不会清空已有包。

## 覆盖与观察限制

PR metadata、普通评论、reviews、行内评论、commits、files 分开采集；显式 `--issue` 的正文和评论也分别登记。不递归抓所有引用。每集合有页数、记录 ID、下一页、终止条件和错误；403/404 不表示从未存在。短页/空页、PR 计数、Git 文件/commit 清单联合核对；重叠、数量不符、错误、平台上限都保留缺口。commits 250、files 3000 的 API 上限不能变成完整材料声明。

Git 使用完整 SHA、128 层有界 fetch 和仓库外 bare 缓存，以固定 merge-base..H 生成 patch。禁外部 diff/textconv/hooks、不 checkout、不运行候选代码。浅历史无法求 merge-base、对象/网络不可达或 API/Git 比较不一致时保持 partial，不替换成最新 SHA。没有实现业务验证或合并安全判断。

GitHub 多接口不是事务。采集开始/结束重读 PR 与指定 Issue 的候选、正文、updated_at 和计数，发现变化留缺口；没有发现也只代表该观察窗，不证明没有同时发生的编辑。最多对可重试 HTTP 错误追加 2 次请求；超过 2 秒的 Retry-After 留恢复点，单请求有超时。单响应和 Git 输出有大小上限，达到限制报告不可得。

## 有出处的注释

可用 `collect ... --context /absolute/notes.json` 输入数组。先从一次 inspect 的 JSON 找到 source ID 和 bodyHash，再按同一来源填写；新采集会重新校验。完整字段见 `src/contract.ts`，最小例：

```json
[
  {
    "sourceId": "issue-comment:12345",
    "sourceBodyHash": "替换为来源正文的64位sha256",
    "locator": "body paragraph 2",
    "kind": "delegated_action",
    "scope": "W1 within adopted S",
    "note": "转录的范围内技术动作，不是本人批准",
    "version": null,
    "action": { "step": "复核被指出的配置绑定", "exitCondition": "原接收者核对两项材料" }
  }
]
```

kind 可为 owner_adoption_report/team_agreement/delegated_action/proposal/fact/unknown。可选 role 分开账号、声称角色、任务归属、实际执行方；relation 分开 development/merge/enablement/parent、固定版本、所阻阶段和可继续部分。hash 匹配只证明注释绑定正文，程序不认证注释含义或批准者；缺来源为 unverified，旧 hash 为 stale。版本缺失保持 null，不造 S1/r1。未提供注释时保留原文和“未解析”，不凭共享账号、CI 绿或 merged 状态生成采用/出口结论。

## 显式只读连接器 relay

默认 gh 被环境网络策略阻断时，不改变代理或换身份。已经有可用只读连接器的调用者可显式选择：

```sh
mkdir -m 700 /tmp/tongxu-relay-new
node dist/src/cli.js collect --repo wlvh/tongxu --pr 12 --output /tmp/tongxu-pr12-relay-new --transport relay --relay-dir /tmp/tongxu-relay-new
```

这是前台请求/响应信箱，不自动执行工具、运行后台队列或派发会话。调用者需同时服务该目录：读取 `request.json` 的 `{id,method:"GET",endpoint}`，用已有只读连接器访问 `https://api.github.com/<endpoint>`；将 `{id,status,body}` 写入私有临时文件，原子改名为 `response.json`。body 必须是连接器真实返回的 JSON 文本，不能自行拼成成功响应。失败应交回实际错误状态，或让 30 秒超时成为缺口。不从响应接受任意 host 或下一步命令。

relay 保存 `connector-json-no-http-headers` 出处，明确它不是 HTTP 原始字节，headers 不可得；分页用明确页码到短页/空页并核计数。一次一个前台客户端；客户端中断后，恢复包可选择**新的**空 relay 目录，避免消费旧响应。完整实时接口 smoke 与离线回放分别报告；只回放不能声称 CLI 已访问真实接口。

## 实现与验证入口

`cli.ts` 参数/生命周期；`transport.ts` 两种 GET 传输；`collector.ts` 固定、分页和观察；`snapshot.ts` 私有存储、哈希和恢复；`git.ts` 固定对象读取；`handoff.ts` 私人/公开输出。Node test runner 包含真实 Git 分叉夹具、真实 CLI 进程中断恢复、偏移分页变化、漂移/截断/失败、同账号来源及路径/覆盖/私有摘要边界。真实 PR 结果另记在 `verification/W1_READONLY_CLI.md`，不以原型探针充当应用验收。
