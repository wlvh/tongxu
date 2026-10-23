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

## Review / Fix Record

独立新上下文对 H `38074bd80569b9694f586218b021c236b210c7a9`、B `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`、target `feat/w1-readonly-cli` 的判断为 `TX-W2-CODEX-20261018-11ff1f8d-8891-41cc-bbbc-6365abbc99bf = REWORK_REQUIRED`。审核者完整读取固定上游及有效政策、原 #2/#4，独立导出后 41/41；额外坏 JSON、symlink 结果、工具失败与空来源负例正确保留不完整。两项 P1 均由负责人复现确认并在既有范围内修复：

1. 工具创建 Git replace refs/对象后，后续工具读到的树已变，旧指纹仍宣称 inputUnchanged。修复为逐工具安全读取整个私有 Git 状态（含 refs、objects、辅助文件），不在污染现场运行宿主 Git；并显式禁用替换对象解释。新增跨工具真实反例，污染后停止后续工具。
2. 从 Node 可执行文件的祖父目录猜运行时，在平铺 `/opt/node` 布局下会挂入整个 `/`。真实双层 bwrap 夹具仅放假宿主文件，负责人在旧实现观察到越界可见。修复只挂实际 Node 文件和确认的 npm 资源目录，命令入口用隔离内链接指向原资源；平铺安装不暴露祖先目录。另补 npm 子脚本入口回归。

修复后 `npm test` 44/44 通过，0 跳过。修复过程的真实复测曾发现 npm 入口缺失（退出 127）；原失败包保留，未以旧 27/27 代替。定位到精确挂载后的命令寻址，已修补并实际重跑：

- 生产 `verify`，同一真实 PR #13 固定输入；观察窗 `2026-10-18T15:50:39.932Z` 至 `15:50:53.037Z`，run `59f8429f-80ee-4d6d-a88e-6368aea09705`。
- 基线仍退出 254（无 package.json）；候选 synthetic HEAD `d33188c2f6ac0dcb0053f97f750d11b136293d29`、T `62f3d6e242348960df6c1dce54d90e4acd006ecf`，原 stdout 明确 27 tests / 27 pass / 0 fail，退出 0。
- 两阶段输入与依赖摘要前后相同，整包保持退出 2 / partial。报告 SHA-256 `83d33129d5a917517a683324a7f312b4ee10c0a7c3c7f625d2478c3e83ea0731`；候选 stdout SHA-256 `7e33308e5ede2d44abe1e98c4bff95a33df88da3e658d4ecca8f7070c69605fb`。

上述是负责人实测；修复候选交新的独立上下文复审，不能自填技术 PASS。Claude 影响核实仍待执行，不声称完整双引擎流程通过。未修改源 W1 包、主干、管理设置、认证或费用路径。

新上下文复审判断 `TX-W2-CODEX-20261018-1e01ee31-9e45-4ede-9485-a47de799374e = PASS（独立 Codex 技术范围）`，绑定 H `792cdfd3dafba7af15bfb058bf5ac75e77e689b1`、上述 B/target。独立导出 44/44，六种 Git 状态污染都停止后续工具；平铺 `/opt/node` 只挂文件，假宿主材料不可见。审核者还独立运行真实 PR #13 包：候选 27/27，基线 254，全包正确 partial；核对作者包原报告、引用 blob 和六个编译 runner hash。原两 P1 关闭，无开放 P0/P1。非阻断 P2 指出 Git 版本范围含糊，随后将报告字段改为 `host_git` 并标明不穷举测试子进程版本；文档区分宿主 2.52.0 和隔离内 2.47.3。Claude 影响核实仍待审。

## W2 PR #14 的完整固定场景

实际生产 collect 为 [PR #14](https://github.com/wlvh/tongxu/pull/14) 执行 7 个实时只读 GET 及 Git fetch，退出 0；H `792cdfd3dafba7af15bfb058bf5ac75e77e689b1`，真实 B `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`，target `feat/w1-readonly-cli`。输入 manifest SHA-256 `0fa4544a1a32224da06e3b058c57695725d6beb63646863809cefb9fda62e43c`，保留 relay 的 headers 不可得限制。

同一生产 verify 与现成 npm test 计划在 `2026-10-18T15:55:07.338Z` 至 `15:55:24.776Z` 实际运行，run `d6469b55-d87c-45f1-b16d-422b409bfb85`：

- W1 基线 T `62f3d6e242348960df6c1dce54d90e4acd006ecf`：27/27，退出 0。
- W2 候选 T `1ceafb5a152bbd27758b0bbd6422c936a45573d2`，synthetic HEAD `8fbd11408067ae31c5faa1dce83b1d8d923eb4c5`：44/44，退出 0；包含真实嵌套隔离回归。
- 全包 complete / 退出 0，executionComplete=true，comparisonComplete=null，businessCorrectness=unverified；两阶段输入和依赖摘要均未变。报告 SHA-256 `000c91ac0b2e6c8cfdcb8e1add6ee7ac00f59835aa92140e9398076e2eaa8bbe`；候选 stdout SHA-256 `1f2a6e80aca76409b85e87b3833850bbdab5a501a62e0f2e94970651e19c5ffb`。

这是固定版本的完整执行证据，不抹掉原 main 基线缺口、不变为业务正确或完整 G1 接收。后续 Git 版本字段命名与记录补充不改变受测测试逻辑；实际代码版本和摘要按本节明确保留。
