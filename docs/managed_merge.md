继续原 #5/#10 正式受管合入与实际结果核查缺口（G02）。当前前置为 G03 原账本候选 dd5516fb6992b236131901a0924827e15425217f（独立限定修补复验通过，PR33）；新分支 feat/w3-managed-merge，target feat/w3-resource-claims。沿用 PR32 已交付的来源/有限授权与原队列、原资源引用，不新建合并调度或余额。实际 main/PR 合并与治理设置仍不在本轮授权内。

MM01 准备对象必须绑定准确 repo/PR/H/B/真实target、S/r、原接收operation及其独立判断、当前packet/完整subject/T、有限授权intent、原资源认领和唯一目标写责任。技术PASS、材料文件存在或CLI成功均不能替代这些门。过期、不匹配或已有活动/未知写者时不新发。

MM02 发送前读取当前PR head/state/target、直接target ref、适用规则/保护及必要检查来源。PR REST中的历史base.sha与直接目标分支分开，不重复旧base假设；不可得、分页缺失、未知规则语义或权限来源不足保持具体缺项，不以配置true自证通过，不改规则或使用bypass。

MM03 条件发送只针对固定原PR/head，登记原请求在先。最小同步merge协议与异步/stacked/merge-queue明确区分，不能从一个入口悄悄合入额外PR或采用绕过模式。服务端head条件不锁base；报告必须保留这一竞态边界。受管写端不得回退个人gh、credential helper或SSH agent；真实独立写身份不可用时保持该实际动作不可用。

MM04 成功响应之后仍回读原PR合入状态、实际merge commit、parents/tree和准确target；分开未发、拒绝、已发未知、已合入待核、错误目标、准确结果已核。base/树变化时保存原事实，并提供绑定实际版本、真实补验与独立判断的恢复入口；错误target不能用补测试追认。没有自动回滚或未知额度返还。

MM05 失回执或中断先查询同一原操作/原远端对象，不能换plan、目录或ID重发。原作者/执行者已结束且能证明未启动的现场可按既有边界继续；活动或未知现场不抢占。重复入口必须只恢复原请求；明确拒绝的再次尝试仍重核准确授权、候选、资源和规则。

MM06 组合判断不表示可以仅合入其路由锚点PR。单次目标更新必须另有准确集成PR/head/tree与有序成员绑定；缺这种真实绑定时保持待集成。多个PR顺序合入不称原子；A1→B1→A2或最小集成按准确依赖和实际结果推进，不等待整个Issue但也不复制旧PASS。

MM07 用明确本地假服务和真实请求/响应捕获覆盖 head变化、base竞态、错误target、实际树差异、规则/权限不可得、已发未知、重复、晚到回执、补验和原请求恢复。只读真实观察可以复用既有官方入口；本轮不向GitHub发任何合并、Ready、保护设置、提权或部署请求，不创建身份/迁移认证/增加费用，不操作SEC_metrics。实现和独立复核完成后继续G04/G06/G11/G12/G13等前置已满足部分，完整52场景继续保留。

## 当前实现与使用

这是原接收 operation 的后续阶段。先完成原队列的独立接收，再配置已有 Owner 来源、原账本和受管发布程序；空闲时显式升到格式14。其他旧队列保持原模式。旧客户端不能把正在合并的操作重新影子评估、清空结果或删掉占用；来源、资源和写者不齐时不创建另一个操作代替。

```sh
node dist/src/merge-cli.js configure --store /absolute/private/queue --profile /absolute/private/publisher-profile.json
node dist/src/merge-cli.js prepare --store /absolute/private/queue --plan /absolute/private/merge-plan.json
node dist/src/merge-cli.js run --store /absolute/private/queue --operation ORIGINAL_RECEPTION_UUID
node dist/src/merge-cli.js reconcile --store /absolute/private/queue --operation ORIGINAL_RECEPTION_UUID
```

示例路径和 UUID 均须换成已有的准确现场。`prepare` 先冻结 `{binding,resources}` 并取得原队列唯一目标占用，再登记资源请求。`run` 认领或查询原资源，读取当前权限与规则，重读 Owner 来源，最后登记准确请求再启动固定发布程序。重复 `run` 不重复发已登记请求；`reconcile` 只恢复原捕获和查询原 PR，必要时回报原账本。

`binding` 的完整类型见 `src/merge-contract.ts`：准确 repository/repositoryId/pr/H/B/targetRef/T、原 operation/item/packet、接收 judgmentId/bindingHash、Owner intent、原资源请求摘要、S 的 id/version/bodySha256 与 r 的 id/version。当前单 PR 路线要求 operation 等于 receptionOperation。组合 subject 与集成 reference 不能靠文件填写来获得写入权：当前写端明确拒绝组合锚点；真实集成候选的生成/核实继续由 G05 接入，MM06 不冒称全部完成。

`resources` 是原账本的完整固定 ResourceRequest 数组，摘要顺序须等于 binding.resourceRequests，且覆盖本次原授权的资源引用。生产不新建余额；测试里的 SQLite 余额是明确的假原账本，仅用于竞争与失回执反例。

## 发布程序的信任边界

`MergeProfile` 固定已有程序的绝对路径和字节摘要、repositoryId、允许 targetRefs、预期发布者数字 id、executionKind 和超时。发布者 id 须与 Owner 和开发执行者分开。**配置不证明真实身份可用，也不创建它。** 已有受管发布程序及其隔离部署须由部署方核实；当前未装配真实生产发布程序或凭据。

每次以固定 argv `--tongxu-managed-merge-v1` 启动它，stdin 为一个 MergeCommand，stdout 必须是一个绑定输入摘要的 MergeReply。协议类型及固定 HTTP 路径生成见 `src/merge-provider.ts`。只有 capabilities、有限 read 和固定 head 的同步 merge；不接受任意 URL、shell、目标改写、bypass 或异步 merge queue。程序仅继承固定 PATH/LANG 和私有临时目录；不继承 HOME、个人 gh、SSH agent 或 API token 环境。配置的受管程序通过自己的已核入口取得身份，缺失就失败，不回退个人身份。

能力回答必须来自实际启动和完整捕获，绑定准确仓库、目标、独立 actor 和同步 head 条件。序列化 JSON 或模型报告无法导入为这次能力证明。这里仍以**固定受管程序及其部署**为信任边界：它必须如实报告并实施自己的身份、权限和无绕过行为，字符串 `isolated_publisher` 本身不构成外部身份认证。测试只安装明确 fixture 程序，真正访问本地 HTTP 假服务，未据此宣称实际 GitHub 身份已核。

## 发送前与发送后的判断

发送前分开核 repository/PR、直接目标引用前后两次读取、branch/protection、适用 active rules、完整有界 check/status/review 分页。required check 绑定提供它的 app；计入当前 H 的审批还读取审核者的仓库权限，不能用旁观者 APPROVED 凑数。REST PR 历史 base 仅保留为 prReportedBase，不替代直接目标引用。原事实发布器也采用同一分离原则，仍只发布评论/status，不获得 merge 端点。

当前有限规则实现支持 PR 审批数量、准确 app/context 检查、禁止删除/强推规则。Code Owners、指定团队审核、最后推送者、讨论解决、签名、部署、merge queue、线性历史及其他未知语义会给出具体缺项。保护接口 404 不当作“没有保护”而放行；缺页也不是空集合。不修改设置。GitHub 在请求时的服务端规则执行仍不可省略。

完整 provider 原字节逐份保存为 blob；preflight/readback 索引仅保留摘要、字节数、请求、捕获位置和时间，不把 Buffer 展成逐字节 JSON。原大页不截断、不降低既定页数/单响应上限。实际版本补验材料从准确原引用读取完整 UTF-8 回执，保留来源而不复制数字键表示。

同步 merge 请求仅带固定 H、merge 方法和本操作固定标记。GitHub 的 head 条件不锁 base/target，因此结果必须回读原 PR、实际 merge commit 的两个 parents、tree、合入者和准确目标；目标继续前进时另查祖先关系。原输入、规则读取、授权意图、资源回执、发送过程和实际结果分别保存。进程退出0、接口200、模型判断和代码树核对均是不同事实。

| 状态 | 后续行为 |
|---|---|
| resources_pending | 未发 merge；条件恢复后使用同一计划继续，或确认未发后取消 |
| sent_unknown | 保留原占用，只查询原运行/远端，不换 ID 重发 |
| refused | 原请求明确被拒；显式 retry-refused 重核全部条件，最多三次登记，仍用原资源 |
| merged_pending_verification | 真实版本或证据尚未核全，保持占用，不能复制旧 PASS |
| merged_wrong_target | 记录错误实际出口；补测试不能把它追认成正确目标 |
| exact_merge_result_verified | 实际原 head/base/tree/actor/目标与固定输入相符，读取结果不产生新权限 |
| actual_merge_result_verified | base/tree 竞态后，新的实际版本已取得绑定原回读的新测试与独立判断 |

明确拒绝后不自动再发，也不自动结算成“可退款”。原资源可留待有界重试；显式通过 resource CLI 回报其失败结果后，若原账本已 consumed/released，就不能再用它重试或暗中另认领。最终完成后的结算失败保留原结果待回报，不重跑 merge。

`recover-controller` 检查原控制器/原子进程确已结束。仅原固定输入完整、没有 launch/process/exit 或非空流时，才能记为这次已登记但未启动，沿原操作再试。已启动、活动、未知均不能改成未发。`cancel-unstarted` 还检查原资源状态；取消释放本地目标占用并报告已知事实，是否消费由原账本决定。

base/tree 变化时，用 `validation-input` 取得完整原回读材料，交给独立补验。补验必须是另一个已完成的原接收 operation，具备匹配实际 B/H/T 的 W2 原件、新独立判断、相同 S/r，并实际消费这份材料；`validate --validation-store ... --validation-operation ...` 重新消费其完整捕获后登记实际版本已核。不接受离散 PASS 文件或 CLI 布尔，也不再次 merge。生产补验入口的授权与执行仍遵守相应运行器的边界。

## 验证与未完成部分

`npm run test:merge` 使用明确假 Owner/账本/发布者/模型消息。实际 child、SQLite、HTTP、互斥与强杀恢复会执行；没有 GitHub mutation 或供应商模型请求。测试包括真实两个 CLI 竞争、已作用后丢响应、原控制器强杀后的未启动恢复、范围/规则/来源/证据缺项、实际版本补验消费以及原资源结算。补验的 W2 材料和模型判断仍明确 fixture，不能写成真实生产验证。相关原有 Docker 回归继续使用已有安全配置。

真实独立写身份、Owner 采用/授权、真实原资源接口、治理启用和任何生产合并仍未执行。组合的实际集成写入、完整任务/角色发送与 UI 控制继续按原 Issues 推进。本子范围完成不关闭全部 Issue 或 T01–T52。

接口依据仅用于核对协议：[同步 merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)、[保护读取](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)、[适用规则](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)、[check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)。真实支持范围以本模块实现、测试与明确缺项为准。
