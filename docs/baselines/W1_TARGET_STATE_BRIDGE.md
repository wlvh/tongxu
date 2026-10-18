# W1 Target State Bridge（W0 草稿）

基线：tongxu `1ba5ae893b49e5856a4e8d682139f70e5c907f5f`、SEC_metrics `203bf4b0544222657e555212fd15cf92c5b1dce4`。实际调查见 [W0 基线](W0_BASELINE_2026-10-18.md)。本文件是预测和理由；采用后的唯一编码入口应是 [#3 自足草稿](../issues/02_W1_facts_and_pr_handoff.md) 发布到原 Issue 的版本，不各自演进。

## 1. 目标状态、假设与兼容

用户对指定 PR 运行只读 inspect/collect，拿到固定 H/B/merge-base/实际 target 的材料包，以及原文快照、读取覆盖、角色/采用/技术约定出处、精确前置、下一步和恢复点。#287 应显示经过 #285 分支进入 main；#293 应保留 Draft、预留是报告、实际发送方另有来源、仍待绑定修补，不能自动放行。

仍未确认未来主机的 gh/Git 和只读认证、全部 Git 对象可达、私人材料可用、正式 S/r 本人采用入口。各项独立显示 unavailable/unknown；不把 App、Checks 发布、秘书或认证迁移排成前置。

现有离线原型及验收 JSON 保留原含义。W1 在 tongxu 新增一个小 CLI，JSON 快照存业务仓库外；不把原型改生产框架，不修改 SEC CLI/业务/测试运行器，不搬回旧防伪门。没有队列/后台需求，W1 暂不引入通用数据库。

## 2. Repo Impact Forecast（预测不是承诺）

| 确定性 | SU / 当前真实触点 | 最小目标触点（新文件均为预测） | 测试与文档 |
|---|---|---|---|
| Must | SU01，当前无生产 CLI | package/锁文件/tsconfig；`src/cli.ts`、`contract.ts` | 参数/退出码；README、`docs/w1_cli.md` |
| Must | SU02，本轮聚合读取缺页头及部分时间 | `src/github.ts`：GET、逐页记录终止/错误 | `tests/w1/collection.test.ts`：多页/403/限流/截断 |
| Must | SU03，原型候选仅夹具 | `src/candidate.ts`：仓库外 bare 缓存，固定 SHA 的 M..H diff | `tests/w1/candidate.test.ts`：H/B/target 漂移、叠放、缺对象 |
| Must | SU04，#153/#28/#47 已有正式记录 | `src/handoff.ts`：原文引用＋来源注释，不补造 S/r | `tests/w1/handoff.test.ts`：共用账号、归属/发送方、精确前置 |
| Must | SU05，无持久化采集程序 | `src/snapshot.ts`：新目录、manifest、局部恢复 | `tests/w1/snapshot.test.ts`：中断、坏哈希、重入、候选混入 |
| Must | SU06，README/PRODUCT_GUIDE 明确仅离线 | 更新这两文件，加 `docs/w1_cli.md` | CLI 跨模块 scenario＋一个真实 opt-in smoke |
| Likely | 大 diff、二进制、平台上限 | 包内分文件保存材料与限制；按实际调整模块边界 | changed-files 上限/patch 省略等夹具 |
| Maybe | 未来更多查询或动作 | SQLite、后台、W2 工具执行 | 不在 W1；有具体需要再议 |

SEC `compare_d02_preparation.py`、公司 results、现有 selector/原账本是以后复用对象。W1 只保留引用和既有输出，不复制工具，不给通用 shell 插件执行口。

## 3. 最小采集流程

1. 固定 PR 的 repo/number/H/B/target；只允许指定 GitHub 仓库和显式关联 Issue。
2. 分集合读取 issue comments、reviews、review comments、commits/files 及指定 Issue；保存覆盖和原文。固定 Git 对象取材，不以移动 ref 或网页 diff 冒充 H。
3. 末次重读 H/B/target 与文字更新信息。候选变化保留原包为 historical/drifted，不拼新候选；原文采集非事务，保留观察窗。
4. 生成 manifest、raw、固定 patch 和 handoff。语义注释只引用本包固定来源；未知身份/材料不补签，不自动判 PASS。
5. 失败保存已读页、下一页/错误；恢复先核原包哈希与候选。同包补缺材料，候选变化另建包，不覆盖旧证据。

## 4. 用户可见层 Delta

| 上游建议层 | 当前事实 | W1 Delta 与落点 |
|---|---|---|
| capability_contract.json | 不存在；能力边界在规范/README/PRODUCT_GUIDE | **Update needed（能力说明层）**：实际文档说明只读 CLI、固定材料与缺口；不建同名空壳 |
| interact.md | 不存在；行为在 PRODUCT_GUIDE/验收 JSON | **Update needed（交互层）**：`docs/w1_cli.md` 说明命令、输出、退出码/恢复 |
| docs/business_user_guide.md | 不存在；用户说明为 PRODUCT_GUIDE | **Update needed（使用层）**：可问事实与仍待语义/授权判断分开；真实秘书仍未实现 |

拟更新文案：

> 只读 CLI 收集一个 PR 的固定代码、原记录和材料缺口。完整表示所请求事实取得齐全，不表示安全、本人已采用或可以合并。缺页、不可读材料、候选变化给出具体恢复点；已取得内容仍可查看。程序不发布评论、不批准、不运行业务测试或模型。

架构/测试说明先集中在 CLI 文档；不机械新增 AGENTS/architecture/SOP/PR_Checklist/TESTING 空文件。规范和角色权限不因 CLI 出现而扩大。

## 5. Verification Matrix

Stage 仅为验证分层，不新增 gate 或平行验收编号；AC 对应 #3 原 Checklist 子项。

| TS / AC | 预测测试位置 | Stage 与边界 |
|---|---|---|
| T01/T05；AC1、AC3 | `tests/w1/candidate.test.ts` | Git fixture：叠放/错误出口/H、B 变化/缺对象；证明一致性，不证明安全合入 |
| T02/T06；AC2 | `tests/w1/collection.test.ts` | HTTP fixture：多页/失败/上限/空集合；完整性与业务判断分开 |
| T03/T04 读取部分；AC4 | `tests/w1/handoff.test.ts` | 同 H 新材料、正文 hash 变化、原报告保留；不实现写回 |
| T19 采集恢复部分；AC5 | `tests/w1/snapshot.test.ts` | 磁盘/传输故障和重入；不承诺远端操作 exactly-once |
| T36/T39 关系、T45/T50 记录；AC4 | 上述 handoff fixture | 出处、阶段前置、未知身份/后果；不做派发、核权或评分 |
| AC1—AC6 | `tests/w1/cli.test.ts` | collect→第二页失败→resume→读包；另测新 H 不覆盖旧包 |
| AC6 | 显式 opt-in smoke | 一个实际 PR（优先 #293）只读采集，产物仓库外；真实接口与夹具分别报告 |

W1 Done：采用后 #3 Checklist 有匹配候选的证据；接手者可回答版本/目标/材料/判断出处/具体前置/下一步；无远端写或业务调用。W0 只交本文和草稿，不创建预测代码。
