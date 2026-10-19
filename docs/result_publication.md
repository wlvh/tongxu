# 原队列结果的有界发布

接续 #5 的 pending_publish 缺口。固定前置 PR22 `b5214fa1b528c8491cbe021b133400a61edb7714`，新分支 `feat/w3-result-publication` 的真实 target 为 `feat/w3-reception-supplement`。程序已能取得独立接收结果；本项让固定结果由程序发到原 PR 并读回，不增加合并、生产写入、模型调用、认证或费用能力。

RP01 可信操作者明确指定原store/operation、现有gh可执行文件/hash、目标仓库数字ID与预期API账号、仅发布事实的来源。先用原reconcile核完整捕获及原队列绑定，fixture/未完成/错误原件不进入真实发布。发布角色没有接收模型报告内的命令、URL、路径或新权限的接口；原模型工具保持不变。

RP02 公开详情由固定模板生成，只含准确候选H/B/target、原操作/判断ID、S/r摘要、判定枚举、原输入/输出/报告摘要与缺口类别。私人报告原文、提示、输入内容、个人路径、任意来源文本和凭据不发布。账号代表实际API执笔者，不代表本人批准。准备阶段落下可读预览与固定payload，默认不发送。

RP03 check run + 固定详情的完整方向保留。本机现有gh OAuth scopes为repo等，不能写Checks；因此本子范围在计划中**明确选择commit-status**，配一个固定PR评论作为详情。没有自动降级/双写、新App、认证迁移或管理员操作。提交状态不设为required，不改分支保护；ACCEPT且材料摘要一致才映射success，RETURN映射failure，证据不足或历史派生摘要不一致保留pending并写明模型已经结束、证据有保留。发布完成与接收结论、生产权限分开。

RP04 复用原SQLite events/blobs记录唯一发布计划、每一步的发送意图/响应/读回，使用原operation目录内可由操作系统释放的局部互斥；不新建调度账本。相同operation只能有一个固定发布计划和渠道；重复入口查原记录，不换context、改marker或覆盖历史来重发。原receiver结果/原始捕获不改写。

RP05 每次首次外部写入前核真实GitHub账号、仓库ID/可写能力、PR当前H/B/target、实际target ref及本地当前材料/停止/占用。停止新增投入拦新发送，已发生的读取与恢复继续；停止merge不阻止发布已完成的事实。GitHub没有把PR、base与评论/状态锁成原子操作，发送后再读回对象和候选，变化时只认固定旧对象的历史记录，不给新候选放行。

RP06 只允许既定GitHub REST路径：读取账号/仓库/PR/target ref、原评论和该H的statuses；写入只允许原PR评论及该H的status。频道、状态、description、context、target_url都由固定记录生成，模型不能指定。不执行shell、不请求任意URL、不批准或merge。HTTP/工具失败保留原请求、响应与未知状态；不把进程0或POST响应当读回验证。

RP07 评论marker与status context绑定同一固定发布身份。POST前持久化意图；响应丢失/中断后只查原远端对象，唯一且内容/账号/目标一致才补登记。没找到、分页未完整、同marker多份或内容被改时保留unknown/conflict，不按超时重发。只完成评论时可以在核实后继续尚未发过的status；reconcile只读不发送。明确HTTP拒绝与未知分开记录，不自动用另一渠道绕过。原库副本不能假冒原路径执行。

RP08 验收一次真实固定接收结果的程序准备→评论→status→读回→原队列关联，重复入口零新POST、零模型调用。另用明确夹具核候选/base/账号变化、停止、并发、错误结果、内容变化、响应丢失、部分完成、真实进程中断和恢复。原源包/模型捕获不变；历史materialSha表示差异如实公开为保留项，不重新调用模型制造全绿。独立复核绑定准确候选；保持Draft，不把本项当完整G1/G2或生产接收完成。

官方接口依据：
- https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28
- https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28

入口为 `publisher-cli prepare --plan ABS_PLAN`、`publish --plan ABS_PLAN`、`reconcile --plan ABS_PLAN`。计划只选择已有可信入口及本次明确发布范围；人可直接读取准备文件，模型原文不能变成新的发送指令。

计划示例（值须来自原现场及已有GitHub CLI，不填新认证）：

```json
{
  "schemaVersion": 1,
  "kind": "tongxu-reception-publication",
  "store": "/absolute/original/queue",
  "operation": "ORIGINAL_OPERATION_UUID",
  "channel": "commit-status",
  "ghExecutable": "/absolute/canonical/existing/gh",
  "ghSha256": "64_HEX_EXECUTABLE_HASH",
  "repositoryId": 12345,
  "actor": {"id": 12345, "login": "EXPECTED_EXISTING_ACCOUNT"},
  "source": "existing user instruction for fixed record publication only"
}
```

只对完整、明确的HTTP拒绝回执，额外支持 `retry-rejected --plan ABS_PLAN --source REFERENCE`；同一阶段最多三次。它先核原进程已结束、远端没有对应记录、同一计划/账号/候选与停止条件，再继续未完成阶段。无响应或未知绝不使用这个入口。prepare和reconcile不发送，publish继续未发送的下一步；不存在自动渠道切换。

原接收result的历史pending_publish字段不覆写；当前发布状态在同库events和queue status的publications中单独呈现。公开模板不包含模型原文或任意scope/source文本，只包含其摘要；另保留同仓库、格式严格限定的Issue/评论来源链接，注明它是原材料报告的引用，不把链接当授权。账号字段是预期，实际执笔者还要用GitHub响应与读回核对。前检不能锁住外部账号/PR/base；发生漂移只保留已发生的固定对象和冲突，不追认新候选。原生捕获的声明不等于供应商签名认证，实际启动与原件来源由执行层记录和真实验收另核。

准备阶段若尚无任何POST意图，可显式再次prepare纠正计划；旧计划/预览/摘要保留，新预览用新的固定文件名。publish不会静默替换已准备计划。首次POST意图一经登记，渠道/账号/对象/正文立即冻结，包括响应丢失的情况；不能改计划绕过未知。
