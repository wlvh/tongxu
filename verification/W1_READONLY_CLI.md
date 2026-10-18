# W1 真实 CLI 验证记录

代码候选：`be2e0e2b9fbf6b136bc55b32e112d1d1cd4ba4f0`；真实分支 base/main：`1ba5ae893b49e5856a4e8d682139f70e5c907f5f`。W0 文档 PR #12 未合并，W1 仅引用其固定材料，不继承 #11 未采用治理。实施条款已发布并读回 [#3](https://github.com/wlvh/tongxu/issues/3)。本记录是技术验证，独立审核结论另列；不代表主干合并或完整 G1 验收。

## 故障与模块验证

环境 Node 24.19.0、npm 11.9.0、Git 2.52.0；`npm ci --ignore-scripts` / `npm run build` / `npm test`。24 个 Node 测试通过，涵盖：

- 真正的 CLI 子进程在第二页请求时 SIGKILL，恢复使用新 relay 会话，旧页哈希不变；失败期间删除/编辑评论后重新遍历，不拼接旧偏移页。
- 固定 H/B/真实叠放目标，H/B/target 漂移分别拒绝复用；真实 Git 分叉夹具只读生成 merge-base diff，作者 dirty 工作区、index 和 HEAD 前后相同。
- 三类讨论、来源 hash、行内回复、显式 Issue；403/404、限流/重试上限、坏 JSON、重叠、计数不符、伪外站 next link、平台截断均留下缺口。
- 路径、覆盖、私有权限、活跃锁、可证已死本机 PID、坏哈希、固定 Git 缺失/清单不符；同账号与代理报告不升级批准，旧注释为 stale，私人文本不进入 summary。

CLI 进程测试的 Git 传输是夹具，固定 Git 计算另有真实本地仓库测试；两者不冒充 GitHub smoke。测试未运行业务代码或模型。

## 指定真实 PR 的实时 smoke

对象：[tongxu PR #12](https://github.com/wlvh/tongxu/pull/12)，显式附带 Issue #2/#3。命令形态：

```sh
node dist/src/cli.js collect --repo wlvh/tongxu --pr 12 --issue 2 --issue 3 --output ABSOLUTE_NEW_PRIVATE_DIR --transport relay --relay-dir ABSOLUTE_PRIVATE_RELAY
node dist/src/cli.js collect --resume ABSOLUTE_EXISTING_PRIVATE_DIR --transport relay --relay-dir ANOTHER_PRIVATE_RELAY
```

初次观察窗 `2026-10-18T14:58:09.743Z` 至 `14:58:49.882Z`；候选代码固定后恢复观察窗 `2026-10-18T15:00:32.424Z` 至 `15:01:06.247Z`。两轮均实际启动生产 CLI，通过已有只读连接器实时服务它发出的 13 个 GET 请求；未用预录响应回放。首次 Git 使用真实 GitHub fetch，恢复复用经哈希校验的固定材料。两轮退出 0，无检测到的采集缺口，旧轮次和字节保留。

| 字段 | 本次观察 |
|---|---|
| H | `fc54807e943d754777b4b005f8ab3a8fe3ae8349` |
| B / merge-base | `1ba5ae893b49e5856a4e8d682139f70e5c907f5f` |
| 实际 target | `main`；末次重读仍匹配 |
| 普通评论 / reviews / 行内评论 | 1 / 0 / 0；各 1 页，分别明确短页/空页终止 |
| commits / files | 1 / 5，与固定 Git 清单匹配 |
| Issue #2 / #3 评论 | 2 / 1；正文和评论分别读取，末次正文/计数未变 |
| 本地证据 | 2 个观察轮次、28 个返回/固定 Git 材料登记 |
| 私人 manifest SHA-256 | `3a57f3a3c57ac3f15a6f6dc7252fe850c8d9497b50185c1055c8b80b482a67e0` |
| 固定 patch SHA-256 | `c0ee9df767b023724018d321b02e7ec5e21b2c8977fb17b03c9aeb52a0b7cdb8` |

环境 `gh api` 被网络策略拒绝；实际默认 `inspect --repo wlvh/tongxu --pr 12 --format json` 返回 2，`pr_incomplete` / `gh_unavailable_or_network_error`，没有假造数据或自动换认证。显式 relay 使用已有允许的连接器，没有修改代理/网络策略。连接器提供实际 JSON 文本，无法提供原 HTTP headers/线字节；已登记 `connector_json_is_not_http_wire_bytes_headers_unavailable`。GitHub 多对象观察非事务，两轮均保留相应限制。

公开记录只含允许字段与哈希；原包在仓库外私有保存，不提交路径、私人原文或会话。不把 0 当作业务 PASS、本人采用或合并许可。真实数据这次没有多页；多页/故障由上述夹具单独验证。没有运行 SEC_metrics 业务、SEC 获取、模型或生产写操作。

## 验收边界

#3 AC1–AC3、AC5–AC6 的 W1 采集/显示/恢复行为有上述测试与真实接口证据；AC4 由原文字、hash 绑定的可选注释与未解析状态实现，程序不自动判断人的采用、角色真实性、依赖是否满足或业务下一步。完整 T01–T52 场景仍不整体改 PASS；W2 执行与组合、W3 接收写入及后期能力不在本次证明内。

## Review / Fix Record

独立执行者以新上下文导出固定 `be2e0e2`，完整读取 `coding-workflow@1772cd2c` 的正式审核提示、main/候选契约及 #2/#3，独立运行 24/24 测试。判断 `TX-W1-CODE-20261018-be2e0e2-R1 = REWORK_REQUIRED`：

1. P1：空快照的 raw/git 目录在恢复前被换成 symlink 时未被校验；独立实测向模拟 checkout 写出 4 个 JSON。修复：恢复发请求前无条件核两个目录，发布 artifact 前再核父目录；新增 raw/git 两个反例，包外目录保持不变。
2. P1：gh 相对 API 端点继承 GH_HOST，可能混入其他主机材料。独立 shim 及 gh 2.46.0 帮助证明缺少 hostname 参数。修复：显式 `--hostname github.com`，保留既有身份/代理配置；新增带 Enterprise GH_HOST 的参数回归，不向该主机发请求。

原负责人复跑两项原反例确认成立，按用户已有范围内普通修复授权实施；`npm test` 扩至 27 项通过。初次真实 smoke 的 Git/连接器数据和固定候选仍可复用：修改未改变这些端点/数据计算；目录修复补故障回归，gh 主机修复补实际参数验证。新候选再交新的独立执行者复审，结论待追加。

现行 `prompts/verifier_impact.md` / v2.3 §16 要求独立 Claude 影响核实。当前环境无 claude 命令，已发现工具无相应可用执行器；该项未执行，不能声称完整双引擎审核链通过。Codex 的独立技术复审与该待审项分别记录，不自批或合并，不因能力缺口阻止普通修复、独立测试与分支开发。具体模型构建版本不可核验，未编造。没有修改保护/认证或切换计费路径。
