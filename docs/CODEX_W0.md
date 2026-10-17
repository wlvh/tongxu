# 发给 Codex：按 v2.2 继续 tongxu #2 / W0

在 `https://github.com/wlvh/tongxu` 执行 Issue #2。先读取当前 main、#2 正文与新评论、README、`docs/tongxu_v2_plan.md`、`prompts/README.md`。已经在做 W0 时先核对原现场与本修订的增量，继续原任务，不重开、不回退、不覆盖他人修改。

## 已确定，不再重复询问

产品仓库 tongxu；只读试点 SEC_metrics；G1→G2→G3。新增工作秘书只是用户的秘书：默认独立 Codex App Server，总览/联络/跟进，不编码、不测试、不技术验收、不直接合并。独立 PR 接收默认 Claude Code；任务通过工作台直接联系，GitHub 保存正式记录。

新任务需要与相关在途负责人核对共享接口与未提交工作；未回复不算同意。共同交付 X 与本次安全合入集合不同：A1 兼容可先合，B1 只等 A1，A2 等消费者与组合；确不可拆才最小集成。事件触发接收，定期补漏，不到点全合、不等整个 Issue。新 X2 不默认扩大 X1。

这些是产品约束，不要求 W0 立即实施秘书／消息／合并运行器。当前只交付基线、W1 Bridge 和 #3 可编码草稿。

## 实际工作

1. 查本仓库 HEAD、政策、脚本和缺失的应用入口；保留 dirty 工作，在独立分支/worktree 做本任务，不 reset/clean/强推/直推 main。
2. 固定参考 coding-workflow@1772cd2c25bfc42b7a89cf38b35bf19d3dc22000 的 README、Issue Agent 与 PR review，不静默跟随 main。现存项目有效规则按范围核对。
3. 只读查 SEC_metrics #153/#28/#47 与 #264/#287/#293 等代表性真实记录及必要源码。区分当前事实、历史说明、候选实现与本轮实测；少量按相关性补查，不普查全部 PR、不再实现现有工具。
4. 基线说明接收责任、实际目标、局部依赖、材料/工具可得性、原账本与执行能力差别、授权来源待核点、下一步。新增观察任务接入和共同交付如何记录；没有记录就明确，不编造已协调。
5. W1 Bridge 明确 SU→实际触点或新增预测→测试→文档。只读 CLI、完整分页、固定候选、交接包、下一步与最小恢复；角色/协调/共同交付只保留正式引用，不先造完整 G3。发布数据与 W3 具体 check run/status 后端分离。
6. 更新 `docs/issues/02_W1_facts_and_pr_handoff.md` 为自足 #3 草稿：Why、Scope、契约/SU、Bridge、代码/文档/测试预测、Acceptance Checklist、风险与权限。共同验收扩展 Checklist，不建新审批层。
7. 按实际改动运行检查。可运行 `python3 prototypes/build_product_ui.py`、`node verification/html_probes/current_v21.js`、`node verification/html_probes/current_v22.js`；它们只是材料/离线原型回归，不是应用已验收。
8. 本任务只在 tongxu 发布独立分支和引用 #2 的 Draft PR。PR body 在仓库外生成；检查公开内容无 token、私人路径/会话链接、未获允许的原件。SEC_metrics 不做任何写入、不新增来源获取/业务模型/费用、不接管运行会话、不改认证或保护。
9. #2 留一次交接，附基线、Bridge、Draft PR、实际命令和未检查；#3 新正文先留 PR 草稿，采用后由唯一执笔者同步原 Issue 并读回。

## 停止点

停在 W0 的 Draft PR，未合并，不自动开始 W1，不批量启动 W2—W7。W0 不等秘书/CLI/Checks/merge queue/确认载体。访问失败只限制相关调查，不自行扩大来源。

最终报告实际版本、读过的来源、真实检查、#2 验收满足情况、PR 链接及真正剩余的少量取舍。没有执行的产品能力明确未实现，不用 prompt/HTML 演练通过包装。
