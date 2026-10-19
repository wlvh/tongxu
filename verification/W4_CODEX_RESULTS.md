# Codex 原结果适配与本机接续验证

本次增量在原 PR #16、`feat/w4-native-inspection`，真实 B/target 保持 `feat/w1-readonly-cli` @ `6c6640eebbcedcf19d8444c4a39c3843b3304cb2`；main 仍为 `1ba5ae893b49e5856a4e8d682139f70e5c907f5f`。没有把 #14/#15 合入本分支。#6/#7 窄范围自足条款在编码前发布读回（UTC 2026-10-18 18:24:48 / 18:24:50）；真实日志纠正 source 解释后，#6 再次于 18:35:49Z 发布读回。显示日期按北京时间为 2026-10-19，原件保留 UTC。

## 实际能力与证据范围

新增 `codex-result-cli import/append/replay/handoff`，不启动原生执行器。固定原 session/thread/turn、候选和声明来源；从原字节识别有明确 phase 的顶层最终结果，保存完整原文和错误。checkpoint 后派生可恢复；新目录、原前缀和哈希约束阻止覆盖/改写旧材料。handoff 从原件重算并生成下一 `verifier_impact` 的 `input.json`，`delivery=not_sent`；还没有启动下一角色或自动链。

Linux Node24 下作者 `npm run test:native` **29/29**（原 17 + 本轮 12；首轮 28 项后的新增反例见下节），W1 回归 **27/27**，零跳过。覆盖两轮完整结果、子线程/中间/未知 phase、身份/版本/顺序、矛盾终态和晚到错误、等待/失败/配额、UTF-8 截断/上限、改写派生 PASS、原件篡改、严格追加、新候选、私有权限和 CLI 入口。真实杀死**离线解析进程**后在新目录 replay 同 capture 成功；这是进程恢复测试，未杀模型、未运行模型。全套测试原输出随私有补充包保存。

协议来自已有 **codex-cli 0.159.2** 的实际 JSON Schema；[来源索引](../docs/protocol/codex_0.159.2_source_index.json) 给出原文件和 hash，完整来源在私有补充包。正向模型消息均为明确的 `fixture`。首轮真实旧日志负向回放暴露了作者把 source 枚举当传输类型的错误：真实 App Server 根 thread source 是 `vscode`，并非 `appServer`。已按 schema 与实际原件改为明确非子代理来源并拒绝 parent/fork/unknown/custom；初次回放、断言失败、原件和修补后回放均保留，不改造原日志迎合代码。

唯一实际原生材料来自旧 H `8b5122d8d4fe907bd2d0131a701ca846e456b27a` 的真实 Linux 隔离元数据 smoke（报告 SHA-256 `d90034e8d5f956fd2a6861a07c053cfd36275a614d40927237b722a55aea269d`，细节见 [原验证](W4_NATIVE_INSPECTION.md)）。本轮**离线回放**准确观察原 session，但 `turnIds=[]`、role=`protocol_probe`，结果为 `unknown / no_model_turn_registered`，exit 2；handoff 被拒绝，exit 1，未创建输出。没有新增原生 smoke、两轮真实模型或最终模型回答。元数据探针的 input/prompt 摘要分别指向原报告/协议 stdin，明确不是模型提示或 W1 任务消费证明。

## 接收与限制

本次新增代码须对固定新 H 单独独立审核，不能复制旧元数据子版 PASS。审核结果由原 PR 与私有报告固定；作者测试不自批。新本机 Claude 影响核实、实际模型协议/两轮/最终结果、实际角色工具限制、自动投递与综合仍待用户转本机。当前已取得私有附件交付，不再仅给 `/workspace` 路径；Mac 本机命令未执行。

不认证操作者声明，不判读 PASS、不授予合并/生产权限。仅支持明确协议子集；输入上限和未知阶段可阻止合法但不受支持的结果，保留原件交本机核对，不伪造字段。恢复保证限于完整 checkpoint 后的进程中断；不承诺掉电持久性、完整流已经收齐或恶意同权限宿主防护。详细命令和边界见 [适配文档](../docs/codex_result_adapter.md) 与 [本机接续](../docs/local_codex_handoff.md)。

## 独立反例与本轮定向修补

新鲜独立审核固定 H `76495ea31abe6123825ed9e7239aced8e615ffbe`，确认一个 P1：终态 full items 将同一 final.id 改成 schema-valid userMessage/content=[] 或 plan/text 后，原实现只在类型仍是 agentMessage 时核原 item，全 ID 存在性检查却通过，实际 CLI import/handoff 均退出 0 导出旧回答。独立测试 28/28、W1 27/27 不抵销该反例。原失败报告和具体 JSON/CLI 输出留在私有补包。

负责人增加同一终态重定类型的回归，在旧实现先得到真实失败；随后对任何引用已记录 final.id 的终态 item 都核完整原值，不依赖其声明的类型。按独立原 userMessage/plan 两个输入运行最终 CLI，import 均退出 2、handoff 均退出 1，未建立交接目录。新增回归及全部 native/适配现为29/29。

修补后的第一次全套出现旧 bad-JSON 夹具 Node 启动超过150ms，得到 request_timeout 而非预期 invalid_json；完整失败日志保留。仅将非超时反例的夹具等待改为1500ms，让预期故障能在负载下到达；显式 timeout 测试仍150ms，生产代码/预算未改。修补后重新全套通过，W1 公共代码未变，其27项前次实测保留适用范围。新 H 的独立复核判断/哈希以原 PR 和私有报告固定，不自批。
