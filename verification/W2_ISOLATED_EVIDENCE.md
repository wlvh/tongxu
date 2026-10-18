# W2 隔离证据验证记录

前置为 W1 Draft PR #13，固定 `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`；本包真实 base/target 是 `feat/w1-readonly-cli`。相对 main 另含 W1 的三个提交，不替代其审阅或合并。原 #4 自足实施条款已发布读回，CLI 文档见 `docs/w2_verification.md`。本记录不表示完整 G1、技术审核批准或合并许可。

## 本轮实测

Node 24.19.0、npm 11.9.0、Git 2.52.0、bubblewrap 0.12.0；`npm test` 41/41 通过（原 W1 27 项 + W2 14 项），包括真实 Git/bwrap/CLI 进程：

- 基线与每个前缀固定 T/HEAD；A1→依赖 A1 的 B1→A2，文本冲突不造树，缺对象保存原错误不换候选。
- 两项各自通过的改动组合后失败；失败中间阶段在最终恢复后仍保留；七类结构化对照及缺失/重复/来源/内容/身份/副作用变化。
- 作者 dirty 文件、HEAD/index 不变；工具改写源码时停止本阶段后续工具；候选预存 JSON 加 no-op 不能冒充本轮结果。
- 真隔离中宿主文件、测试 token 和宿主监听端口不可达；超时及输出上限终止进程组，保留有界输出。
- 真实生产 CLI 在记录运行 PID 后 SIGKILL，原包保留 running/未知状态；重跑同目录被拒绝，旧字节不变。

夹具来源明确为本地生成数据，不冒充真实业务。没有运行 SEC 获取、业务模型、生产会话或远端写回。尚无性能压测、完整 CPU/内存/磁盘配额或系统运行库全量 hash。

## 真实 PR #13 的只读输入与执行

生产 W1 `collect` 通过既有显式 relay 实时执行 7 个 GitHub GET，并从 GitHub 获取固定 Git；包 H 为 `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`，B 为 `1ba5ae893b49e5856a4e8d682139f70e5c907f5f`，真实目标 main。输入 manifest SHA-256：`8929113860addf0d5450fb9ffdaa6828d032a0b915cc7f246dfefef1cc3a9bc9`。连接器不提供 HTTP headers/原 wire bytes、跨对象观察非事务的限制保留。

生产 `verify --snapshot … --objects … --plan … --output …` 的计划明确选择 tongxu 现成 `npm test` 和只读现成 node_modules；没有自动安装或猜测命令。观察窗 `2026-10-18T15:27:40.907Z` 至 `15:27:47.811Z`，run `5ae01583-2e5a-4504-bdcf-c2d77a4f86ae`：

| 阶段 | 实际结果 |
|---|---|
| B/main，T `d4ca50f5138838ad036209938aaf1dc8d41e39dd` | main 无 package.json；npm 退出 254，原错误保存，阶段 partial |
| 固定 PR #13 组合，T `62f3d6e242348960df6c1dce54d90e4acd006ecf` | synthetic HEAD `047b3cb9f8e2964758ed6713acf04bd539c1f2ed`；断网隔离下 npm test 27/27，退出 0 |
| 全包 | 退出 2 / partial，executionComplete=false，comparisonComplete=null，businessCorrectness=unverified |

执行前后作者工作区状态、tracked/untracked 源文件 hash、HEAD/index 均相同。原报告 SHA-256 `74ceb9b60085bcfb46f6ab917489df7164ebeac43061d90d0b3b9483abfc1dc5`；候选 stdout SHA-256 `4632a9955d55765d14bc09d1d66ea22b8efbee33a9f0916469287d381d94167c`。私人包留在仓库外，不发布原路径或输出。本次发生在增加 runner/依赖摘要字段前，作为真实执行证据保留，不冒充后续固定版本已全部复测；固定候选验证另追加。

## 独立审核与验收边界

W2 条款经隔离作者上下文的范围复核，补入“每工具前核固定输入、污染后停后续”和“本轮专属新结果文件”两处条款；代码含相应负例。固定代码候选的独立正式技术审核待执行，不能由作者写 PASS。现行 Claude 影响核实所需执行器不可用，保持待审，不换身份或收费路径。

AC1–AC5 的 W2 局部能力有上述实测；T01–T52 不整体改 PASS。接收、正式授权、远端 check/merge、实际合入回读、用户成果接受均留 W3 或后续。交付是检查点，按 #2 继续细化实际前置允许的 W3 子范围；无生产写责任交接时只做影子/只读部分。
