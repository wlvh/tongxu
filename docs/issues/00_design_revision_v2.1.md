## 背景

`docs/tongxu_v2_plan.md` 是当前方案基线。三轮评审（`docs/review/01`–`06`）之后，有十项规则要么在两份 HTML 原型里实现不一致，要么与 coding-workflow 现行规则冲突，要么只有 owner 能定。它们不改完，W1 以后的工作包没有稳定的契约。本 Issue 不写代码，只产出决定。

详细依据见 `docs/review/aligned_decisions.md` 第二节，实测见 `verification/RESULTS.md`。

## 需要确认的事项

| 编号 | 事项 | 现状 | 建议 |
|---|---|---|---|
| D1 | 委托绑定目标与范围 | 产品原型的委托对任何 PR 都放行；v2 演练页绑定 S1 加 main | 按方案 §12.2 字段落地：来源、角色、仓库／目标、允许动作、作用范围、门槛、上限、到期、撤销 |
| D2 | 发出后主干前进 | 产品原型固定显示"受测树与合入树相同"；v2 演练页有待核标记 | 实现 T14：读回真实 merge commit 的树，与受测树不同时显示"已合入，证据待核"并暂停依赖该证据的推进 |
| D3 | 判断的 base 绑定规则 | 三个版本：原型不绑；演练页严格绑；方案写"相关 B" | 定成一句可执行的话：审核绑定 (patch 内容哈希, 采用范围快照)；组合检查绑定 (head, base)；接收时一次性判断 base 增量并记录复用或重查；人工确认与合并 CAS 绑定 head SHA |
| D4 | 机器事实的落点 | 方案 §4.3 让程序维护 PR 正文区块；coding-workflow 第 8 步每轮"覆盖已有 PR" | head、base、受测树、结论作为 check run 或 commit status 挂在 head SHA；正文留给人和 Agent |
| D5 | 逐次确认的载体 | 本地回环页面点击，只存同序数据库 | 逐次确认用 owner 人类账号的 GitHub review approval，机器人合入；分支保护开"新提交后撤销旧批准"；委托记录是 owner 账号写在 Issue 的文字 |
| D6 | 共同验收的位置 | 新增 Issue 段落 | 作为 Issue Agent 第 9 节 Acceptance Checklist 的扩展 |
| D7 | 试点对象 | coding-workflow 没有"接收者"角色 | 方案直说 G1 试点是有接收角色与对照工具的项目；对纯 coding-workflow 项目 G1 坍缩为 PASS 加 CI 后 owner 确认 |
| D8 | 新会话能力开放 | 产品原型握手后一次授予 pause/resume | 按已验证的具体操作开放，握手只给 observe |
| D9 | merge queue | 方案列为优先；官方页面无可用性说明，记忆中要求组织所有的仓库 | 在仓库设置核实后再写进方案 |
| D10 | G1 与 G2 先后 | 方案定 G1 先 | owner 按自己一周机械劳动的分布决定；G1 只读子版足够薄，先后都可 |

## 验收

- 每项在本 Issue 评论里写明结论与理由；D1–D5、D8 的结论写回 `docs/review/aligned_decisions.md` 第二节并在 `docs/tongxu_v2_plan.md` 末尾增加"v2.1 修订"一节，不改写原文其他部分。
- W1–W7 的 Issue 引用本 Issue 的结论，不各自复述。
- D4 与 D5 若采纳，需要在 wlvh/coding-workflow 里改两处：PR 提交短 prompt 第 4 条加一句"保留 check run 与 review approval，不写入正文"，以及把逐次确认写进 PR_Checklist 的 Review Closure；那是另一个仓库的 PR。

## 非目标

不写代码，不建数据库，不接执行器。
