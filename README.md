# 同序｜人掌控目标，Agent 协作交付

**v2.3 产品范围；开发分支已提供只读采集、隔离验证和本地影子接收 CLI。** 秘书、受管后台与生产界面仍是后续阶段。

你主要对工作秘书说目标、顺序和边界。秘书联络和跟进，不做技术任务；开发者协调实现，独立审核者检查，PR 接收者判断最小安全合入，普通后台核权执行。任务自主联系、后台中转，GitHub保存正式记录，不让秘书成为消息或撤权瓶颈。

## 从哪里开始

- [产品说明：有什么、怎么用](docs/PRODUCT_GUIDE.md)
- [现行完整设计与实施基线](docs/tongxu_v2_plan.md)
- [发给 Codex 的持续开发指令](docs/CODEX_NEXT.md)
- [只读 CLI：安装、采集、缺口与恢复](docs/w1_cli.md)
- [隔离验证：固定树、逐前缀测试与结果对照](docs/w2_verification.md)
- [影子接收：持久材料、控制、前置与原操作恢复](docs/w3_shadow_queue.md)
- [角色 prompt 装配及工具权限](prompts/README.md)

首页是本批目标、组织方式、委托与停止、成果验收、复盘抽查五项控制；秘书对话与原三工作区保留。人的采用、团队技术约定、代理依据委托作出的处置分别可查。可以并行，也可按阶段串行或统一负责人；不以更多Agent作为成功标准。

## 只读 PR 交接

```bash
npm ci --ignore-scripts
npm run build
node dist/src/cli.js collect --repo wlvh/tongxu --pr 12 --output /absolute/private/tongxu-pr12-new
```

请将 `/absolute/private` 换成仓库外、已存在的真实私有父目录，新输出目录必须不存在；macOS `/tmp` 别名不适合作为显式输出。

输出目录须为仓库外的新绝对路径。默认使用已有 Git/gh 身份，只读固定候选和原记录，生成私人交接包与单独摘要；部分失败可 `collect --resume`。退出 0 不表示本人采用、业务 PASS 或可合并。完整命令与显式连接器传输见 [CLI 文档](docs/w1_cli.md)。

`verify` 可选原 Linux/bubblewrap 或 [现有 Docker 的隔离执行器](docs/docker_verification.md)，读取已有包，在断网的新现场运行显式登记的现成测试，并保留基线和每个组合前缀的固定树、实际 HEAD、原输出与缺口。命令和测试计划见 [隔离验证文档](docs/w2_verification.md)。它不写远端，不自动安装依赖，也不执行 SEC_metrics。

`queue` 把配对 W1/W2 材料导入私有 SQLite，跨进程保存精确前置、三类停止控制、同目标占用和可恢复的影子评估。用法见 [影子接收文档](docs/w3_shadow_queue.md)。它只产出本地状态与待核原因，没有生产接收、发布或合并能力。

## 离线 UI

```bash
python3 prototypes/build_product_ui.py
```

打开生成的 `prototypes/product_ui_prototype.html`。只使用虚构任务与固定演练，无模型／GitHub连接。生成器仅维护设计原型，最终W7由真实前后端替代；不要把它变成生产框架。详见 [验证边界](verification/REVISION_V23.md)。

## 开发顺序与 Issues

| Issue | 阶段 | 状态／产物 |
|---|---|---|
| #1 | 材料修订记录 | 不作为逐项Owner审批门，关闭不代表应用完成 |
| #2 | G0 / W0 | 基线、W1 Bridge、#3 草稿已交 Draft PR #12，保留原交付 |
| #3 | G1 / W1 | 独立分支交付真实只读 CLI；自足条款已发布原 Issue |
| #4 | G1 / W2 | `verify`：既有检查、隔离组合、真实结果；独立分支依赖固定 W1 |
| #5 | G1 / W3 | 本地影子接收已实现；完整 G1 的独立接收与生产权限前置仍待核 |
| #6 | G2 / W4 | 两引擎、受限秘书、独立接收者 |
| #7 | G2 / W5 | 审核循环、后果关联、按需整体复盘 |
| #8 | G3 / W6 | 在途协调、并行／串行／统一负责人、共同交付 |
| #9 | G3 / W7 | 人的控制首页、秘书、完整工作台与真实验收 |

阶段交付是检查点，不是停工点；按 [#2 持续开发安排](https://github.com/wlvh/tongxu/issues/2#issuecomment-6251133759) 逐包细化和推进，当前优先 G1。不重做 W0，不同时启动全部工作包。只读试点 SEC_metrics，不授予其写入、额度或生产接管权。分支开发与主干合并分开，未授权不合并。

## 记录与公开边界

`docs/issues/`是受控发布源，原GitHub Issue为实施入口；一个执笔者发布并读回，不两端独立生效。历史材料在archive及review中，不作并行现行规则。T01—T52是未执行的产品验收清单，原型测试不是应用通过。

本次材料整理是用户委托代理完成，不等于本人逐项签署全部技术选择；身份、决定类型与依据须分开。公开文件与提交不新增凭据、私人路径、私人会话链接或原件。未重写历史。
