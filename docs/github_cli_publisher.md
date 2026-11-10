# 使用现有 GitHub 登录的受限发布程序

<!-- capability-anchor: CAPABILITY.github_cli_publisher -->

部署者可以使用现有 `gh` 登录，为同一 GitHub 账号配置受管发布。程序固定仓库、目标分支和预期账号，原合并队列继续核准确本人批准、候选、资源、停止与实际结果。使用范围采用 Issue10 的 GP01—GP06。

## 准备与登记

当前适配使用具有完整 `repo` 范围的用户登录，实际用户须有选定仓库的管理员及写入权限。部署者提供公开配置，其中 `decisionReference` 使用本人已给出的共享账号模式决定摘要。配置目录是 `gh` 正在使用的原目录，程序核规范路径、属主及组和其他用户的写权限。

```json
{
  "schemaVersion": 1,
  "kind": "tongxu-github-cli-publisher",
  "repository": "owner/repository",
  "repositoryId": 84,
  "targets": ["approved-target"],
  "actorId": 83,
  "ghExecutable": "/absolute/stable-gh-entry",
  "ghConfigDir": "/absolute/operator-gh-config",
  "timeoutMs": 30000,
  "decisionReference": {
    "kind": "recorded_user_decision",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

构建后执行准备命令，目标为新目录。

```sh
node dist/src/github-cli-publisher-cli.js prepare \
  --config /absolute/public-config.json \
  --directory /absolute/private-publisher
```

准备入口读取公开配置与有限构建模块，产生 `publisher.command`、`publisher-profile.json` 和部署说明。启动器在加载模块之前核配置及各模块字节。凭据由随后执行的 `gh` 从原登录来源读取。发布 profile 使用 `sharedAccountPublisher` 和 `credentialKind:oauth_repo_admin`，沿原 `merge-cli configure` 登记。共享配置的保证及具体动作批准见受管合并说明。 [受管合并](managed_merge.md#共享发布账号)

## 一条命令如何执行

程序以固定参数 `gh auth token --hostname github.com` 读取本次令牌，在内存中供整条命令使用。它向子进程提供显式 `GH_CONFIG_DIR` 和有限环境，内部消费有界输出，公共诊断使用固定说明。程序选择与实际使用之间核当前 `gh` 入口，兼容升级按运行规则处理。 [GitHub CLI 令牌入口](https://cli.github.com/manual/gh_auth_token)、[环境设置](https://cli.github.com/manual/gh_help_environment)、[运行规则](runtime_compatibility.md)

同一令牌先读取 `/user` 的数字账号和类型，从响应头精确核完整 `repo` 范围，再读取固定仓库的 ID、名称、管理／写入权限和合并能力。能力回复据此给出 `account_publisher`。普通读取复用原固定请求生成，包含指定审核方需要的只读 GraphQL。仓库读取直接消费该命令刚取得的仓库响应。

发送合并前，程序额外核原 PR 的两个仓库、H、目标、开放且 Ready 的状态，以及直接目标分支 B。随后以单次 Node HTTPS 请求至多发送一次固定 PR／H 的同步 PUT，HTTP421也直接交回原响应判断，进入未知查回。整个命令共用一个期限，HTTP 消费有响应上限，重定向导致该请求失败。新请求使用服务器当前默认API日期，兼容升级沿运行规则核实际字段。GitHub 的同步 H 条件及 B／目标的观察边界继续由原结果回读处理。

令牌读取或认证失败可产生 unavailable 能力。合并请求执行期间发生超时、断连、响应超限或不完整回执时，原队列保留已登记操作，沿 `reconcile` 查询实际 PR、commit、parents、tree 和目标。明确的服务端拒绝沿原 `retry-refused` 核条件后处理。 [合并与恢复入口](managed_merge.md)

## OAuth 管理权限与旧版保护缺项

`oauth_repo_admin` 采用一组共同证据。适配器从本次令牌的 `/user` 响应核完整 `repo` 范围及预期账号，从选定仓库核实际 admin／push。预检继续要求同一组记录中的准确仓库响应、精确 classic404／`Branch not protected`，以及唯一完整 administration200／`enabled` 布尔。任一证据缺失均保留保护缺项。

这组判断根据 GitHub 对 scope、用户权限与隐藏 404 的说明，以及同仓库的实际管理权限观察形成。Actions200 对 OAuth 只要求 `repo`，因此它单独不足以证明管理员权限。原 App／fine-grained 三类证明、旧省略配置和 classic200 仍按各自原条件消费。 [Scope 与用户权限](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)、[Actions 权限 API](https://docs.github.com/en/rest/actions/permissions#get-github-actions-permissions-for-a-repository)、[权限相关的 404](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource)

## 验证范围

`tests/merge/github-cli-publisher.test.ts` 通过实际子进程、本地 HTTP、原 SQLite 队列和明确的凭据／GitHub 来源样例，核认证与候选拒绝、单令牌、固定 API、发送前后故障、原一次发送和未知查回、封装漂移及捕获中的凭据边界。生产传输与原消费者的421场景按服务器实际收到的PUT计数，并核持续421、后续重复执行／查回零补发及实际请求头无固定API日期。旧保护证明与新增 OAuth 组合的消费者验证沿原 contract／policy／managed 测试执行。真实读取、准确测试合并、安装启用及本人结果在 Issue10 的对应候选记录。
