# 发给 Codex：先审治理补充，再接续已在做的 W0

仓库 wlvh/tongxu。起始 main 观测为 1ba5ae893b49e5856a4e8d682139f70e5c907f5f；以当前远端为准，不回退后续提交。新增治理任务 #10；读取关联本治理 Draft PR 的实际 head、评论和完整差异。本轮不让未采用候选覆盖现行范围。

## 先做的事

1. 核对是否已有 W0 执行者／工作区／未提交内容。已在做就向原任务发送增量，不重新派发，不 reset/clean/强推。
2. 独立复核治理 PR：docs/GOVERNANCE.md、完整产品说明、CODEOWNERS、自身受保护路径、角色公共增补、重要控制预览及 T53—T60。尤其检查不是“用新规则给自己放行”；原独立审核要求保留。提出可复现缺口，有必要修补则独立分支／Draft PR，不能直推 main、合并或替本人批准。
3. 在 #10 做实际治理启用核查：身份、base CODEOWNERS、现有 ruleset／protection、bypass、PR 作者是否能得到独立批准，给出最小设置差异和读回验收。当前连接器 protection 读取 403 不等于本机自动有管理权。管理员精确配置必须由本人或已核验的明确管理委托执行；无此条件给出本人设置入口和缺项，不迁移账号、不自提权、不关闭规则解锁。不得往 main 推故障测试。
4. 治理 PR 尚未采用时，#2/W0 按现行 main 继续独立只读调查；只把增补作为候选约束标注。采用后同步相关 Issue 发布源和原正文并读回，再用新规则细化 #3。W0 不等待模型回放／统计／完整 UI。

## W0 交付不变

读取最新 #2、docs/CODEX_W0.md、现行规范及固定工作流。SEC_metrics 只读。产出一批真实交付与政策／工具／材料基线、W1 Bridge、#3 自足可编码草稿；只在 tongxu 分支写限定文档，Draft PR 后停止，不自动进入 W1。不要新增付费调用、SEC 获取或试点写入。

## 验证

正常克隆中先运行默认构建，再跑保留回归（别将离线断言冒充产品验收）：

```bash
python3 prototypes/build_product_ui.py
node verification/html_probes/current_v21.js
node verification/html_probes/current_v22.js
node verification/html_probes/current_v23.js
node verification/test_governance_v24.js
```

若正在审阅的 PR 没有最后一个文件，先核实际提交而非猜测试已存在。旧材料与版本失配需据实报告，不删除失败断言绕过。新增规范场景 T53—T60 的真实身份／GitHub／模型测试未执行；不得标通过。

最终交付：固定 head，实际读过的来源，命令／结果／限制，治理规则“待提出／待配置／已启用／已验证”分别写清，当前 PR 作者与本人身份限制、#10 的下一步，以及 W0 Draft PR 和 #3 草稿位置。只升级真正缺权限／费用／目标的少量事项。
