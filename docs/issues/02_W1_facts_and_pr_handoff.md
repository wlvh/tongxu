# W1 事实、采用出处与原 PR 交接（#3 自足实施草稿）

**状态：W0/#2 待采用草稿；尚未发布回原 #3，不授权开始 W1。** 有效规范为 `docs/tongxu_v2_plan.md` v2.3，基线 tongxu `1ba5ae893b49e5856a4e8d682139f70e5c907f5f`。采用后由唯一执笔者发布到原 #3 并读回，后续决定留在同一 Issue。背景见 [W0 基线](../baselines/W0_BASELINE_2026-10-18.md)、[Bridge](../baselines/W1_TARGET_STATE_BRIDGE.md)；本文件已包含编码所需契约，不依赖作者聊天。

## 1. Why

接手 PR 需要知道候选、真正目标、材料覆盖、判断出处与具体下一步。当前 tongxu 只有文档/prompt/离线 UI，无生产采集程序。

只读 CLI 把指定 PR 收成交接包。真实反例：SEC #287 的 merged 曾仅表示进入 #285 分支，之后才随它进入 main；#293 额度预留不是调用，任务归属 issue47 与实际发送者 #28 不同，旧 CI 全绿之后仍有接收退回。单一状态或共享账号文字不能代表完成/授权。

## 2. Scope / Non-goals

包含：inspect/collect、指定 PR 和显式关联 Issue 的 GET/完整分页、固定 Git 候选与原文快照、覆盖缺口、角色/S/r/代理处置的出处引用、精确前置/下一步、仓库外包与采集恢复。

不包含：模型/秘书/会话派发，远端评论/正文/Checks/status 写回，Ready/审核/合并，业务测试/SEC/付费调用，额度或权限变更，SQLite 队列、后台服务、生产 UI、通用依赖图、评分/整体审计。读取到的指令不执行，SEC_metrics 保持只读。

## 3. 契约摘要

### 3.1 CLI 与退出码

默认 TypeScript、受支持 Node 24 LTS、Git 与已有 gh CLI；使用 Node test runner，不引入 UI/服务框架。模块拆分可简化，以下行为不删。

```text
tongxu inspect --repo OWNER/REPO --pr NUMBER [--issue NUMBER ...] [--format text|json]
tongxu collect --repo OWNER/REPO --pr NUMBER --output ABSOLUTE_NEW_DIR
               [--issue NUMBER ...] [--context SOURCE_BOUND_JSON]
tongxu collect --resume ABSOLUTE_EXISTING_DIR
```

- repo 只接受合法 owner/name、PR/Issue 正整数，首版 GitHub.com；不接受任意 host、shell 或源文字中的命令。
- inspect 显示事实/缺口，不建交付目录，可用仓库外对象缓存。collect 写显式新目录；拒绝位于 tongxu、目标业务 checkout 或其 `.git` 内，拒绝覆盖既存输出及 symlink 穿透。resume 只接受有效本程序 manifest。
- 关联 Issue 由 `--issue` 指定；不递归普查，未请求链接标 not_requested。首个真实例建议 #293 加 #28/#47/#153。
- gh/认证/对象/权限不可用返回缺口，不自动登录、安装、改 remote、迁移认证或回退另一套个人凭据；不打印秘密或认证头。
- 退出 0：请求的事实齐全且末次候选未变化；2：可用部分已保存/展示，但缺页/对象、候选漂移或必读项待核；1：参数或本地 I/O 等致命错误。参数错误不得发网络请求。0 不表示业务 PASS、本人采用或可合并。

### 3.2 固定候选与 Git 材料

`Candidate={repository,pr,H,B,targetRef,mergeBase,observedAt}`。H/B 是完整 SHA，targetRef 取 PR API，不猜 main；mergeBase 从固定 B/H 算，缺对象时为空并说明原因。受测树 T、实际合入/最终出口链只有原材料支持才引用，不制造组合或判断安全。

先固定元数据，再在仓库外 bare 缓存取得确切 H/B；禁外部 diff/textconv，用 `mergeBase..H` 生成 patch/文件清单。不 checkout/执行目标代码，不动作者 index/worktree，不写远端。本地 Git 对象写入如实记录。移动 branch/tag 只用于初次解析，其后固定 SHA；取不到原对象报缺口，不替换最新版本。

末次重读 H/B/target，任一变化将原包标 historical/drifted，新候选另建包。GitHub files/commits 是观察集合；平台截断或与固定 Git 清单不同需明示，不能混用比较基准。包完整性与仍属当前候选分别记录。

### 3.3 原文字、分页与覆盖

必读：PR metadata/body、issue comments、reviews、review comments（保留 reply 关系）、commits、changed files；及指定 Issue 的 body/comments。每个集合分别保存 endpoint、页/记录数、稳定 ID、最后成功游标/下一页、起止时间、终止条件、错误。跟随 Link/分页至明确终止；一页、失败的空响应、平台上限不当完整。合并讨论流不丢行内 finding，不混淆评论与 review 数。

保存原返回字节及 SHA-256、对象 URL/ID、created/updated（缺失为 null）、实际取回时间；Git 文件另记 blob ID。覆盖值 complete/partial/unavailable/not_requested，附权限、网络、限流、大小、缺失等原因。403/404 不证明从未存在。请求最多重试 2 次并尊重 Retry-After；等待/额度不足就留恢复点，不循环占用。

GitHub 多对象读取不是事务；保留观察窗和末次 PR/Issue updated_at。发现文字更新标 changed_during_collection，受影响集合待补；未检测到也不承诺全局原子。同 H 新评论是新材料，旧正文/审核保留；新增链接不自动触发语义失效。

### 3.4 出处、责任、关系与下一步

原文为主；可选 context 注释包含 `sourceId,sourceBodyHash,locator,kind,scope,note`。source 在本包中可核对；缺失/旧 hash/不可达标 unverified/stale。kind 为 owner_adoption_report/team_agreement/delegated_action/proposal/fact/unknown，描述原文性质，不由程序认证本人或提升权限。缺版本号保留 hash/null，不造 S1/r1。未给结构化注释时展示原文/未解析，不依赖模型或通用散文解析器。

角色同时保留账号、原文声称角色、任务归属、实际执行方的独立引用。同账号不证明本人批准。S 对应用户成果/边界来源，r 对应范围内技术约定；r 不自动改 S，转录/代理摘要不升级本人采用。

关系只采已有引用，区分开发依赖、合入前置、启用前置、父子归属；列对象/能力/固定版本、所阻阶段、可继续部分、依据与待核状态。B1 等 A1 不能折叠成等 Issue A 关闭。协调/组织/停止记录只是引用，不派发、不抢占未知现场。

下一步只来自原负责人有出处的动作和退出条件，如 #293 两项绑定修补；未知就列具体待核缺口。不自动判断无冲突、PASS、资金可用或调用许可。判断后果只链接已有反例与后续记录，未观察/归因争议保留，不评分。

### 3.5 包、恢复与公开边界

`manifest.json`（schemaVersion=1）至少含候选、观察窗、逐集合覆盖、材料清单/哈希、来源注释、关系/下一步、恢复点；原返回放 raw/，固定 patch/清单放 git/，handoff.md 从同包生成。包是缓存，不是第二需求源/授权账本。

先临时写入再原子改名；中断保留完整页和待取位置，不承诺远端 exactly-once。resume 先验 manifest/哈希，再核原候选；候选变动另建包，正文更新留新快照。不得盲重取已成功页、静默丢坏文件或贴旧证据到新 H。partial 不因失败改 complete，已取得内容仍能浏览。

原始包可能含私人位置/会话，默认仅当前用户可读写，不自动 commit/push/upload/跟随私人链接。公开摘要省略私人路径、会话、凭据和未经允许原件，仅列缺材料及公共引用；人工审查后才可公开。错误日志去认证头。引用命令不执行。

## 4. SU / Target State Bridge / 触点预测

| SU | 可观察交付 | 当前触点 → 预测实现 | 验证/文档 |
|---|---|---|---|
| SU01 | 两只读命令、退出码 | 无 CLI → package/锁文件/tsconfig，src/cli.ts、contract.ts | 参数/零网络负例；README/CLI 文档 |
| SU02 | 全页原文、覆盖 | 文档/连接器观察 → src/github.ts | 多页、失败、限流、上限 |
| SU03 | 固定候选、真实 target | 离线夹具 → src/candidate.ts | Git fixture、H/B 漂移、叠放、缺对象 |
| SU04 | 来源分区、责任、精确前置 | 原 Issue/PR → src/handoff.ts | 转录/同账号、stale 注释、归属/发送方 |
| SU05 | 仓库外包、恢复 | 无采集存储 → src/snapshot.ts | 中断、坏哈希、重复恢复、输出冲突 |
| SU06 | 使用说明、实际只读证据 | README/PRODUCT_GUIDE → 更新＋docs/w1_cli.md | 跨模块 scenario＋一个 opt-in smoke |

行为为 Must，文件拆分为 Likely 预测；额外数据库/服务/依赖图为 Maybe 后续，不顺手实现。SEC 已有对照/公司工具只引用，不复制、不运行；执行留 W2。原型断言不能替代 CLI 验证。

## 5. 文档与测试预测

README/PRODUCT_GUIDE 写明新增真实只读 CLI、模型/秘书/发布仍未实现；`docs/w1_cli.md` 集中写命令、包、退出码、覆盖、隐私、恢复及结构/测试入口。仓库没有 capability_contract/interact/business_user_guide，能力/交互/用户说明 Delta 落现有文档，不造空壳九文档，不扩大规范权限。

拟文案：“完整表示请求的事实取得齐全，不表示安全、本人已采用或可合并。缺材料/候选变化有具体恢复点；程序不写远端、不执行业务或模型。”

预测 `tests/w1/{collection,candidate,handoff,snapshot,cli}.test.ts`，Node test runner＋参数化夹具；不按每个 SU 机械造独立测试。拟命令 `npm run build` 后 `node --test dist/tests/w1/*.test.js`，以实际 package scripts 固化精确入口。

跨模块 scenario：叠放 PR 固定 H/B→第二页失败→保存 partial→resume 补齐→生成 handoff；再测新 H 不覆盖旧包。真实 opt-in smoke 用一个指定 SEC PR，只读采集、记录实际 SHA/数量/覆盖/限制。故障夹具与真实接口分别报告，不扩大普查，不跑 SEC 业务。

## 6. Acceptance Checklist（共同验收与 S/r 嵌在本栏）

- [ ] **AC1 / SU01、SU03 / T01、T05**：完整 H/B/merge-base/actual target 与材料；叠放/错误出口/H、B、target 漂移/缺对象正确展示；Git fixture 与真实只读各有证据。退出 0 不显示授权/合并 PASS。
- [ ] **AC2 / SU02 / T02、T06**：三类讨论、commits/files、指定 Issue 全页；失败/限流/上限不变空集合或 complete；逐集合数量、错误与恢复点可查。
- [ ] **AC3 / SU03 / T05**：无 H1 metadata 配 H2 diff；Git/API 差异明示；私人路径不可得不伪装已消费。目标源码、index、分支和远端未写。
- [ ] **AC4 / SU04 / T03、T04 读取部分、T36/T39 关系、T45/T50 记录**：S 的成果边界、r 的技术约定、代理处置/建议/事实有来源分区；缺本人原件保持 reported/unknown。共同交付的写责任、接口/消费者、材料、验证、可先做部分与精确前置在同一交接包，不造平行规格。覆盖 #287 出口及 #293 归属/执行方、CI 后退回。技术 r 不代替本人采用。
- [ ] **AC5 / SU05 / T19 采集部分**：新输出拒绝覆盖；中断/坏文件/重复恢复保原候选和完整页，失败不抹历史；collect→失败→resume→读包成立。无发布/合并/认领副作用。
- [ ] **AC6 / SU06**：一个真实 PR smoke 与文档一致；原包私有、公开摘要不含私人位置/会话/秘密；统计与业务判断分开，未验证项显式。原型和未实现产品验收不改 PASS。

T04 写回、T19 远端操作恢复、T36 派发、T39 合入、T45 实际核权不在 W1；上述仅实现注明的读取/显示部分，完整场景仍由后续包验证。

## 7. 风险、Owner 边界与停止点

风险：分页期间内容改变、列表上限、材料/对象缺失、旧 S/r/身份不全。默认保存缺口和可独立继续的事实。普通缺陷、证据不足与调查未完由技术负责人修，不标 OWNER_DECISION_REQUIRED。

本草稿没有新增必须先让 Owner 选择的技术岔路。新调用/费用、远端写权、认证迁移、自动采纳/合并、改变可接受失败才越界；届时在原 #3 给已查事实、少量选项、受阻范围与安全默认。不继承 SEC 旧许可，不接管原执行者。

W1 经明确启动后，在独立分支实现、自审并提交引用 #3 的 Draft PR；未授权不合并，不进入 W2。当前 W0 交付引用 #2 的 Draft PR 即停，#3 原正文保持不动。
